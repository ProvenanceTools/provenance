/**
 * Local-path ingest: ingest a Gradescope export ZIP that already lives on the
 * server's own disk, reading it via a random-access streaming reader so a
 * multi-GB (10 GB+) export is processed with bounded memory.
 *
 * This is the disk-side counterpart to the HTTP `:gradescope` route. The route
 * buffers the whole upload in memory (and trips a ~2 GiB FormData ceiling);
 * this path never holds more than one rebuilt bundle at a time. It otherwise
 * reuses the exact same downstream pipeline — roster upsert → stage blob →
 * `ingest_files` row → enqueue one `ingest_file` job per (assignment scope ×
 * submitter) — so the worker processes locally-ingested submissions identically
 * to uploaded ones.
 *
 * A submission folder can hold more than one assignment scope: CS 61B/61C
 * students push a git repo and Gradescope clones the WHOLE repository, so one
 * folder can carry `proj2/.provenance/` and `lab5/.provenance/` side by side.
 * `repo-scopes.ts` fans that out into one flat bundle per scope before staging;
 * a classic flat folder has exactly one scope and is unaffected.
 *
 * Deliberately does NOT enforce INGEST_MAX_BATCH_BYTES (the total-size cap that
 * exists to bound the in-memory HTTP path); processing arbitrarily large local
 * exports is the entire point. The per-bundle cap (INGEST_MAX_BUNDLE_BYTES) and
 * the file-count cap (INGEST_MAX_BATCH_FILES) still apply.
 */

import type { DrizzleDb } from '../../db/client.js';
import { ingest_files } from '../../db/schema.js';
import {
  enqueueIngestJob,
  failIngestJob,
  markStagingStarted,
  markStagingComplete,
  maybeEnqueueFinalize,
} from './job-control.js';
import { stageBlob } from './stage-blob.js';
import { createBoundedRunner } from './bounded-runner.js';
import { recordPhase } from '../../jobs/ingest-profile.js';
import { upsertRosterFromSubmitters } from './gradescope/upsert-roster.js';
import { openLocalExport, type StreamedSkipReason } from './gradescope/stream-export.js';
import { loadIngestScopeConfigs, scopeConfigResolver } from './gradescope/scope-config.js';
import type { IngestScopeConfig } from './gradescope/repo-scopes.js';
import { zipBundleEntries, type BundleEntry } from './gradescope/build-bundle-zip.js';
import { createRebuildPool, type RebuildPool } from './gradescope/rebuild-pool.js';
import { getBoss, JOB_KINDS } from '../../jobs/pg-boss.js';
import type { StorageClient } from '../storage/client.js';

export interface IngestLocalPathDeps {
  db: DrizzleDb;
  storageClient: StorageClient;
}

/**
 * Estimate the byte size of the STORE (uncompressed) bundle ZIP for `entries`
 * without serializing it: each entry contributes its data plus a local file
 * header (30 B + name) and a central-directory record (46 B + name), and the
 * archive has a 22 B end-of-central-directory record. Exact enough for the
 * per-bundle size cap (which guards against pathologically large bundles).
 */
function estimateStoreZipSize(entries: BundleEntry[]): number {
  let total = 22; // end of central directory record
  for (const e of entries) {
    const nameLen = Buffer.byteLength(e.name, 'utf8');
    total += 30 + nameLen + e.data.length + (46 + nameLen);
  }
  return total;
}

export interface IngestLocalPathArgs {
  semesterId: string;
  /** User id recorded as `ingest_jobs.uploaded_by`. */
  userId: string;
  /** Absolute (or process-cwd-relative) path to the export ZIP on disk. */
  archivePath: string;
  maxBundleBytes: number;
  maxBatchFiles: number;
  /**
   * Optional pre-created ingest job to stage into. When set, the function does
   * NOT lazily create its own job — even a roster-only export returns this id
   * (with `submissionsQueued: 0`) so the caller can settle the job. Used by the
   * async resumable `ingest_stage_upload` path; omit it for the synchronous
   * single-request / CLI local-path callers (which keep lazy creation).
   */
  jobId?: string;
  /**
   * Max bundles staged concurrently (blob write + `ingest_files` insert +
   * enqueue). Default 1 → strictly serial, identical to the original behavior.
   * Submissions are independent, so higher values overlap the per-bundle blob
   * writes (the win on network/NFS-backed storage) while the generator builds
   * the next bundle. Keep `stageConcurrency + INGEST_CONCURRENCY` within
   * `DATABASE_POOL_MAX` headroom, since each in-flight stage briefly holds a
   * connection for its row insert.
   */
  stageConcurrency?: number;
  /**
   * Per-request declared-submission-type override (§6).
   *
   * When present it REPLACES the per-assignment `assignments.ingest_scope`
   * default for every scope in this batch, which is how a one-off re-ingest or
   * a fixup declares a different shape without mutating the assignment row. It
   * beats the default by the simplest possible mechanism: the resolver handed
   * downstream ignores its assignment-id key and returns this config for every
   * scope, so nothing below here knows or cares which of the two it got.
   *
   * Omitted ⇒ the DB-backed per-assignment resolver, i.e. the behaviour that
   * existed before overrides.
   */
  ingestScopeOverride?: IngestScopeConfig;
}

export interface IngestLocalPathSkipped {
  folderKey: string;
  /**
   * The assignment scope within the folder that was skipped: `''` for the
   * folder root, else a directory prefix such as `proj2/`. Non-empty only for
   * git-repo submissions carrying several scopes.
   */
  scopePath: string;
  reason: StreamedSkipReason | 'bundle_too_large';
}

export type IngestLocalPathResult =
  | {
      ok: true;
      /** Null when the export had no stageable submissions (roster-only). */
      jobId: string | null;
      roster: { added: number; updated: number };
      /** Bundles staged — one per ACCEPTED SCOPE, not per submission folder. */
      bundlesProcessed: number;
      /** `ingest_files` rows staged — one per (accepted scope × submitter). */
      submissionsQueued: number;
      skipped: IngestLocalPathSkipped[];
    }
  | {
      ok: false;
      error: 'not_a_zip' | 'missing_metadata' | 'invalid_metadata' | 'too_many_files';
      detail: string;
    };

/**
 * Ingest a Gradescope export from a local filesystem path.
 *
 * The ingest job is created lazily on the first stageable bundle, so a
 * roster-only export (or one whose folders are all skipped) upserts the roster
 * and returns `jobId: null` without creating an empty job — matching the HTTP
 * route's behavior.
 */
export async function ingestLocalPath(
  deps: IngestLocalPathDeps,
  args: IngestLocalPathArgs,
): Promise<IngestLocalPathResult> {
  const { db, storageClient } = deps;
  const { semesterId, userId, archivePath, maxBundleBytes, maxBatchFiles } = args;
  const existingJobId = args.jobId ?? null;

  // A per-request override applies to the WHOLE batch, so it short-circuits the
  // DB read entirely — there is nothing per-assignment left to look up. Without
  // one, scope-resolution config is per assignment and keyed by the id each
  // scope declares, so the whole semester's map is read once up front (a handful
  // of rows) rather than per discovered scope.
  const override = args.ingestScopeOverride;
  const scopeConfigFor =
    override !== undefined
      ? () => override
      : scopeConfigResolver(await loadIngestScopeConfigs(db, semesterId));

  const opened = await openLocalExport(archivePath, { scopeConfigFor });
  if (!opened.ok) {
    return { ok: false, error: opened.error, detail: opened.detail };
  }

  // Hoisted so the `finally` can dispose it; assigned once staging concurrency
  // is known below.
  let rebuildPool: RebuildPool | null = null;

  try {
    // Populate/upsert the roster from the metadata up front (add/update only).
    const roster = await upsertRosterFromSubmitters(db, semesterId, opened.rosterSubmitters);

    const skipped: IngestLocalPathSkipped[] = [];
    let bundlesProcessed = 0;
    let submissionsQueued = 0;
    let jobId: string | null = existingJobId;

    const boss = await getBoss();

    // A pre-created job (resumable /complete path) exists with the default
    // staging_complete=true; flip it false before we enqueue anything so a fast
    // worker cannot finalize mid-stream. Lazily-created jobs are flipped at
    // creation time below.
    if (jobId !== null) {
      await markStagingStarted(db, jobId);
    }

    // Stage bundles with bounded concurrency (default 1 = serial). The ordered
    // bookkeeping — job creation, the file-count cap, and the counters — stays
    // on this serial producer path; only the independent per-bundle work (zip
    // rebuild + blob write + row insert + enqueue) runs concurrently.
    const stageConcurrency = args.stageConcurrency ?? 1;
    const runner = createBoundedRunner(stageConcurrency);

    // The expensive per-bundle step is the JSZip serialization. When staging
    // concurrently (>1), offload it to a worker pool so rebuilds run across
    // cores instead of serially on this thread; otherwise (serial / CLI / tests)
    // do it in-process to avoid spawning worker threads. Both produce identical
    // bytes, so the staged blob's sha256 (the dedup key) is unchanged.
    rebuildPool = stageConcurrency > 1 ? createRebuildPool(stageConcurrency) : null;
    const rebuild = (entries: BundleEntry[]): Promise<Uint8Array> =>
      rebuildPool !== null
        ? rebuildPool.zip(entries)
        : zipBundleEntries(entries).then((ab) => new Uint8Array(ab));

    try {
      // Drive the generator by hand so we can time the SERIAL producer step
      // (`stage:generate` = per-bundle yauzl-inflate + JSZip rebuild) apart from
      // the concurrent per-bundle work in the runner. When INGEST_PROFILE is off
      // every recordPhase is a no-op, so this loop is behaviorally identical to a
      // plain `for await`. The generate span is the true single-thread staging
      // wall; blob-write/db-enqueue overlap in the runner and thus over-count
      // (see ingest-profile.ts) — read them as relative shape only.
      const iterator = opened.submissions();
      for (;;) {
        const genStart = performance.now();
        const next = await iterator.next();
        recordPhase('stage:generate', performance.now() - genStart);
        if (next.done === true) break;
        const sub = next.value;

        if (sub.kind === 'skipped') {
          skipped.push({
            folderKey: sub.folderKey,
            scopePath: sub.scopePath,
            reason: sub.reason,
          });
          continue;
        }

        // The rebuilt STORE zip is ~the sum of entry bytes plus small per-entry
        // headers; estimate it here (cheap) to preserve the pre-count size cap
        // without doing the actual (now-offloaded) serialization first.
        if (estimateStoreZipSize(sub.entries) > maxBundleBytes) {
          skipped.push({
            folderKey: sub.folderKey,
            scopePath: sub.scopePath,
            reason: 'bundle_too_large',
          });
          continue;
        }

        // Enforce the file-count cap as we stream (one file per submitter).
        if (submissionsQueued + sub.submitters.length > maxBatchFiles) {
          await runner.settle(); // let in-flight stages finish before failing
          if (jobId !== null) {
            await failIngestJob(db, jobId, `exceeded INGEST_MAX_BATCH_FILES (${maxBatchFiles})`);
          }
          return {
            ok: false,
            error: 'too_many_files',
            detail: `export exceeds the limit of ${maxBatchFiles} submission files`,
          };
        }

        // Lazily create the job on the first real bundle. Capture a non-null id
        // for the stage tasks (the closures cannot narrow the outer `jobId`).
        let activeJobId: string;
        if (jobId === null) {
          activeJobId = (await enqueueIngestJob(db, semesterId, userId)).jobId;
          jobId = activeJobId;
          await markStagingStarted(db, jobId);
        } else {
          activeJobId = jobId;
        }

        bundlesProcessed++;
        const { entries, folderKey } = sub;
        // One ingest_files row per (scope x submitter). The root scope keeps the
        // historical `<folder>.zip` name so the flat Gradescope path is
        // byte-for-byte unchanged; a fanned-out scope names its directory so the
        // unmatched tray shows which part of the repo it came from.
        const sourceName =
          sub.scopePath === ''
            ? `${folderKey}.zip`
            : `${folderKey}/${sub.scopePath.slice(0, -1)}.zip`;
        // Rebuild the bundle ZIP once per bundle (offloaded to the pool), shared
        // across its co-submitters. Kicked off here so it proceeds while we
        // stream the next folders; the runner's backpressure bounds how far the
        // producer runs ahead, so at most ~stageConcurrency rebuilds are pending.
        const bundleZipPromise = rebuild(entries);
        for (const submitter of sub.submitters) {
          const fileId = crypto.randomUUID();
          const matchSid = submitter.sid;
          submissionsQueued++;
          // Stage blob + insert row + enqueue, immediately so the worker starts
          // on this bundle while we stream the next ones. Safe because the job's
          // staging_complete stays false until markStagingComplete below, so
          // maybeEnqueueFinalize will not settle the job early. `submit` applies
          // backpressure once `stageConcurrency` stages are in flight.
          await runner.submit(async () => {
            const bundleZip = await bundleZipPromise;
            const blobStart = performance.now();
            const { blobSha256, sizeBytes } = await stageBlob(
              { storageClient },
              { jobId: activeJobId, ingestFileId: fileId, body: bundleZip },
            );
            recordPhase('stage:blob_write', performance.now() - blobStart);

            const enqueueStart = performance.now();
            await db.insert(ingest_files).values({
              id: fileId,
              ingest_job_id: activeJobId,
              original_filename: sourceName,
              size_bytes: sizeBytes,
              blob_sha256: blobSha256,
              status: 'pending',
              match_sid: matchSid,
            });
            await boss.send(
              JOB_KINDS.INGEST_FILE,
              { ingestFileId: fileId, ingestJobId: activeJobId },
              // Exponential backoff so a transient-error retry (e.g. connection
              // exhaustion during a big import) lands after the pressure clears
              // instead of hammering immediately. See isTransientDbError in worker.ts.
              { retryLimit: 3, retryDelay: 10, retryBackoff: true },
            );
            recordPhase('stage:db_enqueue', performance.now() - enqueueStart);
          });
        }
      }
      await runner.drain();
    } catch (stagingErr) {
      await runner.settle(); // wait out in-flight stages before failing the job
      if (jobId !== null) {
        const detail = stagingErr instanceof Error ? stagingErr.message : String(stagingErr);
        await failIngestJob(db, jobId, detail);
      }
      throw stagingErr;
    }

    // Staging finished cleanly. Mark the job fully staged so finalize is now
    // permitted, then trigger one check in case every enqueued file already
    // drained before we got here (no worker would otherwise re-trigger it).
    if (jobId !== null) {
      await markStagingComplete(db, jobId);
      await maybeEnqueueFinalize(boss, db, jobId);
    }

    return {
      ok: true,
      jobId,
      roster: { added: roster.added, updated: roster.updated },
      bundlesProcessed,
      submissionsQueued,
      skipped,
    };
  } finally {
    if (rebuildPool !== null) await rebuildPool.dispose();
    await opened.close();
  }
}
