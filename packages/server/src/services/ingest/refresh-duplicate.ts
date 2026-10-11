/**
 * Refresh a submission's derived results when a re-upload of the SAME artifact
 * hits dedup — the way staff restore full check-8 verification for rows
 * ingested before submitted shas were persisted.
 *
 * WHY. Check 8 needs the sha256 of each submitted file's bytes, and the stored
 * bundle is source-stripped. Since submitted shas are persisted at ingest
 * (submitted-shas.ts) every re-run reproduces the ingest verdict; rows ingested
 * before that carry none, so a re-run on their stripped copy can only say
 * `unknown` wherever the copy cannot establish what was submitted. The original
 * export still has the bytes. Re-uploading it used to be a pure no-op — dedup
 * marked the file `duplicate` and returned before loading a byte.
 *
 * WHAT. On a duplicate hit (phase-2 dedup, or the late duplicate inside
 * createSubmission), and ONLY when the existing submission has no stored shas:
 *
 *   1. PROVE it is the same artifact. The upload's provenance entries (seal,
 *      signatures, .slog, .slog.meta — exactly what stripping keeps; see
 *      `readProvenanceEntries`) must be byte-identical, by name and
 *      decompressed content, to the stored blob's. Zip bytes are NOT compared:
 *      the export path rebuilds archives, and entry timestamps make them
 *      differ for the same artifact. Anything else — different entries, an
 *      unreadable upload, a stored blob already swept by retention — leaves
 *      today's duplicate behaviour untouched.
 *   2. Compute `computeSubmittedShas` from the upload (bytes present).
 *   3. In ONE transaction: re-run validation + heuristics + scoring for that
 *      submission through `recomputeSubmission` — the same entry point a
 *      config recompute uses, under the semester's active config with the same
 *      fallback ingest uses — handing it the new shas, which it persists; then
 *      write an audit row and settle the ingest file as `duplicate`.
 *
 * Rows that already have stored shas take the cheap path: one indexed read,
 * then exactly the old duplicate behaviour.
 *
 * RETRY / CONCURRENCY. Everything the refresh writes, the audit row, and the
 * ingest file's terminal status commit together, so a pg-boss retry either
 * finds the file still `pending` and redoes the whole thing, or finds it
 * settled and skips. A Gradescope group is fanned out into several identical
 * rows that all hit dedup at once: a transaction-scoped advisory lock per
 * submission serialises them, and the stored-shas check is repeated under it,
 * so exactly one does the recompute and the rest settle as plain duplicates.
 */

import { eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import { computeSubmittedShas } from '@provenance/analysis-core/validation/verify-submitted-code.js';
import { audit_log, submissions, validation_results } from '../../db/schema.js';
import { withTransaction, type DrizzleDb } from '../../db/client.js';
import { isTransientDbError } from '../../db/transient-error.js';
import { getBlob } from '../storage/blobs.js';
import type { StorageClient } from '../storage/client.js';
import { getActiveConfig, DEFAULT_SERVER_CONFIG } from '../heuristics/config.js';
import { HEURISTIC_CONFIG_VERSION_V0 } from '../heuristics/default-config.js';
import { recomputeSubmission } from '../scoring/recompute-submission.js';
import { readProvenanceEntries } from './strip-bundle.js';
import { loadStoredSubmittedShas, type SubmittedShas } from './submitted-shas.js';

/** The audit action recorded when a re-upload refreshed a submission. */
export const DUPLICATE_REFRESH_AUDIT_ACTION = 'ingest.duplicate.refresh';

// ---------------------------------------------------------------------------
// Plan (reads only)
// ---------------------------------------------------------------------------

export type DuplicateRefreshSkipReason =
  /** The existing submission already has stored shas: nothing to restore. */
  | 'already_has_shas'
  /** The existing submission row is gone (e.g. deleted between dedup and here). */
  | 'no_submission'
  /** The stored blob cannot be read — typically swept by retention. */
  | 'stored_blob_unavailable'
  /** The upload cannot be read or parsed. */
  | 'upload_unreadable'
  /** The upload's provenance entries differ from the stored blob's. */
  | 'artifact_mismatch';

export type DuplicateRefreshPlan =
  | { kind: 'skip'; reason: DuplicateRefreshSkipReason; detail?: string }
  | { kind: 'refresh'; submittedShas: SubmittedShas };

export type DuplicateRefreshArgs = {
  existingSubmissionId: string;
  semesterId: string;
  /** Staging key of THIS upload. Both duplicate paths leave the staging blob in place. */
  stagingKey: string;
  ingestJobId: string;
  ingestFileId: string;
  /** The upload, already parsed WITH its source — the late-duplicate path has it. */
  uploadedBundle?: Bundle;
};

/**
 * Decide whether this duplicate can restore the existing submission's
 * submitted shas, and compute them if so. Makes no writes.
 */
export async function planDuplicateRefresh(
  db: DrizzleDb,
  storage: StorageClient,
  args: Pick<DuplicateRefreshArgs, 'existingSubmissionId' | 'stagingKey' | 'uploadedBundle'>,
): Promise<DuplicateRefreshPlan> {
  if ((await loadStoredSubmittedShas(db, args.existingSubmissionId)) !== undefined) {
    return { kind: 'skip', reason: 'already_has_shas' };
  }

  const rows = await db
    .select({ key: submissions.blob_object_key })
    .from(submissions)
    .where(eq(submissions.id, args.existingSubmissionId))
    .limit(1);
  if (rows.length === 0) return { kind: 'skip', reason: 'no_submission' };

  let stored: Uint8Array;
  try {
    stored = await readAll(await getBlob(storage, rows[0]!.key));
  } catch (err) {
    return { kind: 'skip', reason: 'stored_blob_unavailable', detail: message(err) };
  }

  let upload: Uint8Array;
  try {
    upload = await readAll(await getBlob(storage, args.stagingKey));
  } catch (err) {
    return { kind: 'skip', reason: 'upload_unreadable', detail: message(err) };
  }

  const same = await sameProvenanceEntries(upload, stored);
  if (!same.ok) return { kind: 'skip', reason: same.reason, detail: same.detail };

  let bundle = args.uploadedBundle;
  if (bundle === undefined) {
    const parsed = await loadBundle(
      upload.buffer.slice(upload.byteOffset, upload.byteOffset + upload.byteLength) as ArrayBuffer,
      'upload.zip',
    );
    if (!parsed.ok) {
      return { kind: 'skip', reason: 'upload_unreadable', detail: parsed.error.kind };
    }
    bundle = parsed.value;
  }

  return { kind: 'refresh', submittedShas: computeSubmittedShas(bundle) };
}

/**
 * Are the provenance entries of the two archives identical — same names, same
 * decompressed bytes? This is what proves an upload is the stored artifact.
 */
export async function sameProvenanceEntries(
  uploadZip: Uint8Array,
  storedZip: Uint8Array,
): Promise<
  { ok: true } | { ok: false; reason: 'upload_unreadable' | 'artifact_mismatch'; detail: string }
> {
  let up: Awaited<ReturnType<typeof readProvenanceEntries>>;
  try {
    up = await readProvenanceEntries(uploadZip);
  } catch (err) {
    return { ok: false, reason: 'upload_unreadable', detail: message(err) };
  }
  let st: Awaited<ReturnType<typeof readProvenanceEntries>>;
  try {
    st = await readProvenanceEntries(storedZip);
  } catch (err) {
    // The stored blob is ours and was written by the strip; failing to read it
    // back is not evidence about the upload. Refuse rather than guess.
    return { ok: false, reason: 'artifact_mismatch', detail: `stored blob: ${message(err)}` };
  }

  const upNames = up.map((e) => e.name);
  const stNames = st.map((e) => e.name);
  if (upNames.length === 0 || upNames.join('\n') !== stNames.join('\n')) {
    return {
      ok: false,
      reason: 'artifact_mismatch',
      detail: `provenance entry names differ (upload ${upNames.length}, stored ${stNames.length})`,
    };
  }
  for (let i = 0; i < up.length; i++) {
    if (!bytesEqual(up[i]!.data, st[i]!.data)) {
      return { ok: false, reason: 'artifact_mismatch', detail: `${up[i]!.name} differs` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Apply (inside the caller's transaction)
// ---------------------------------------------------------------------------

export type DuplicateRefreshApplied =
  | { refreshed: false }
  | { refreshed: true; check8Before: string | null; check8After: string | null };

/**
 * Persist `submittedShas` and re-run validation + heuristics + scoring for the
 * existing submission, then record an audit row. Must run inside a
 * transaction (the advisory lock is transaction-scoped). A no-op when a
 * concurrent duplicate of the same artifact already did it.
 */
export async function applyDuplicateRefresh(
  tx: DrizzleDb,
  storage: StorageClient,
  args: Omit<DuplicateRefreshArgs, 'stagingKey' | 'uploadedBundle'> & {
    submittedShas: SubmittedShas;
  },
): Promise<DuplicateRefreshApplied> {
  const { existingSubmissionId: submissionId, semesterId } = args;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`submitted-shas-refresh:${submissionId}`}, 0))`,
  );
  // Re-check under the lock: a sibling duplicate may have refreshed it while
  // this one was planning.
  if ((await loadStoredSubmittedShas(tx, submissionId)) !== undefined) {
    return { refreshed: false };
  }

  const check8Before = await storedCheck8(tx, submissionId);

  // Same config resolution ingest uses (run-per-submission.ts): the active
  // config, or the defaults at version 0 when the semester has none yet.
  const active = await getActiveConfig(tx, semesterId);
  await recomputeSubmission(
    tx,
    storage,
    submissionId,
    semesterId,
    active?.config ?? DEFAULT_SERVER_CONFIG,
    active?.version ?? HEURISTIC_CONFIG_VERSION_V0,
    { submittedShas: args.submittedShas },
  );

  const check8After = await storedCheck8(tx, submissionId);

  await tx.insert(audit_log).values({
    actor_user_id: null,
    actor_token_id: null,
    semester_id: semesterId,
    action: DUPLICATE_REFRESH_AUDIT_ACTION,
    target_type: 'submission',
    target_id: submissionId,
    detail: {
      ingest_job_id: args.ingestJobId,
      ingest_file_id: args.ingestFileId,
      reason: 'submitted_shas_restored',
      submitted_files: Object.keys(args.submittedShas).length,
      check_8_before: check8Before,
      check_8_after: check8After,
    },
  });

  return { refreshed: true, check8Before, check8After };
}

// ---------------------------------------------------------------------------
// The duplicate path's single entry point
// ---------------------------------------------------------------------------

/**
 * Settle a duplicate ingest file, refreshing the existing submission first when
 * the re-upload can restore its submitted shas.
 *
 * `markDuplicate` writes the ingest file's terminal `duplicate` status; it is
 * called with the refresh's transaction when there is one, so the two commit
 * together, and with `db` otherwise. A transient DB error propagates (the file
 * is still `pending`, so pg-boss retries); any other refresh failure is logged
 * and the file is settled as a plain duplicate — exactly today's behaviour.
 */
export async function settleDuplicateWithRefresh(
  deps: { db: DrizzleDb; storage: StorageClient; logger: Pick<Logger, 'info' | 'error'> },
  args: DuplicateRefreshArgs,
  markDuplicate: (handle: DrizzleDb) => Promise<void>,
): Promise<'refreshed' | 'not_refreshed'> {
  const { db, storage, logger } = deps;
  const log = {
    ingestFileId: args.ingestFileId,
    submissionId: args.existingSubmissionId,
  };

  const plan = await planDuplicateRefresh(db, storage, args);
  if (plan.kind === 'skip') {
    if (plan.reason !== 'already_has_shas') {
      logger.info(
        { ...log, reason: plan.reason, detail: plan.detail },
        'ingest_file: duplicate not used to refresh the existing submission',
      );
    }
    await markDuplicate(db);
    return 'not_refreshed';
  }

  try {
    const applied = await withTransaction(db, async (tx) => {
      const r = await applyDuplicateRefresh(tx, storage, { ...args, ...plan });
      await markDuplicate(tx);
      return r;
    });
    if (applied.refreshed) {
      logger.info(
        { ...log, check8Before: applied.check8Before, check8After: applied.check8After },
        'ingest_file: duplicate restored submitted shas and refreshed the existing submission',
      );
      return 'refreshed';
    }
    return 'not_refreshed';
  } catch (err) {
    if (isTransientDbError(err)) throw err;
    logger.error({ ...log, err }, 'ingest_file: duplicate refresh failed; settling as duplicate');
  }
  await markDuplicate(db);
  return 'not_refreshed';
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function storedCheck8(db: DrizzleDb, submissionId: string): Promise<string | null> {
  const rows = await db
    .select({ s: validation_results.check_8_status })
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId))
    .limit(1);
  return rows[0]?.s ?? null;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
