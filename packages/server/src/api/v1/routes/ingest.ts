/**
 * Ingest routes (PRD §8.6).
 *
 * POST   /semesters/:semesterId/ingest                 — multipart upload, 202
 * POST   /semesters/:semesterId/ingest:gradescope       — Gradescope export upload, 202
 * GET    /semesters/:semesterId/ingest/jobs             — paginated job list
 * POST   /semesters/:semesterId/ingest/jobs/:jobId/cancel — cancel a job
 *
 * The ingest:gradescope route is the primary upload path: it accepts the ZIP
 * Gradescope produces from "Download Submissions" (a submission_metadata.yml
 * plus one already-unzipped folder per submission), upserts the roster from the
 * metadata (so no pre-existing roster is required), rebuilds a sealed bundle ZIP
 * per submission, and stages one file per submitter with a match_sid hint so the
 * worker matches by metadata rather than the filename convention.
 *
 * Phase 9a scope:
 *   - Stage each file to MinIO, create ingest_files rows with status='pending'.
 *   - Do NOT parse or match — that is Phase 9b.
 *   - zip-of-zips: expand the outer archive; stage each inner .zip.
 *   - Enforce INGEST_MAX_BUNDLE_BYTES, INGEST_MAX_BATCH_BYTES,
 *     INGEST_MAX_BATCH_FILES, ROSTER_REQUIRED.
 *
 * Auth:
 *   POST /ingest    — semester admin (write)
 *   GET  /jobs      — semester member (read)
 *   POST /jobs/cancel — semester admin (write)
 *
 * Audit:
 *   ingest.start   — on POST /ingest success
 *   ingest.cancel  — on POST /jobs/:jobId/cancel success
 */

import { Hono } from 'hono';
import JSZip from 'jszip';
import { eq, and, desc, lt, sql, count } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { getConfig } from '../../../config/index.js';
import { requireAuth } from '../../middleware/authorize.js';
import { requirePrincipal } from '../../middleware/auth-session.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../../middleware/audit.js';
import { Errors, ApiError } from '../errors.js';
import { ingest_jobs, ingest_files, roster_entries, assignments } from '../../../db/schema.js';
import {
  enqueueIngestJob,
  cancelIngestJob,
  failIngestJob,
} from '../../../services/ingest/job-control.js';
import { stageBlob } from '../../../services/ingest/stage-blob.js';
import { chunk } from '../../../services/ingest/chunk.js';
import { createStorageClient, storageConfigFromEnv } from '../../../services/storage/client.js';
import { getBoss, JOB_KINDS } from '../../../jobs/pg-boss.js';
import { recordPhase } from '../../../jobs/ingest-profile.js';
import { streamUploadToTempFile } from '../../../services/ingest/stream-upload.js';
import { ingestLocalPath } from '../../../services/ingest/local-path.js';
import {
  createResumableUpload,
  putResumablePart,
  listResumablePartNumbers,
  abortResumableUpload,
  resolveChunkBytes,
} from '../../../services/ingest/resumable-upload.js';
import type { IngestStageUploadPayload } from '../../../services/ingest/stage-upload-job.js';
import { CreateUploadRequestSchema } from '@provenance/shared/api-schemas';
import { projectStudent, maskFilename, protectedLabel } from '../../../services/protect.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Discriminated result from tryExpandZipBundle.
 *
 * - kind='not-zip': the bytes were not a valid zip at all (use `rawBuffer` for staging).
 * - kind='single-zip': valid zip but not a zip-of-zips (use `rawBuffer` for staging).
 * - kind='zip-of-zips': expanded inner entries are in `entries`.
 */
type ExpandResult =
  | { kind: 'not-zip'; rawBuffer: ArrayBuffer }
  | { kind: 'single-zip'; rawBuffer: ArrayBuffer }
  | { kind: 'zip-of-zips'; entries: Array<{ filename: string; data: ArrayBuffer }> };

/**
 * Detect zip-of-zips: a single File named *.zip whose contents are all .zip entries.
 *
 * Accepts a pre-read `rawBuffer` so the caller can pass it to `stageBlob` on
 * the non-zip-of-zips path without a second `arrayBuffer()` call (Important 3).
 *
 * Zip-bomb guard (Critical 2): tracks `totalUncompressed` across all inner
 * entries serially. If the running total exceeds `maxBatchBytes`, throws
 * `Errors.ingestBatchTooLarge` immediately. Only one entry's worth of bytes
 * is held in memory beyond what has already been committed to `entries`.
 */
async function tryExpandZipBundle(
  filename: string,
  rawBuffer: ArrayBuffer,
  maxBundleBytes: number,
  maxBatchBytes: number,
): Promise<ExpandResult> {
  if (!filename.endsWith('.zip')) return { kind: 'not-zip', rawBuffer };

  let outer: JSZip;
  try {
    outer = await JSZip.loadAsync(rawBuffer);
  } catch {
    // Not a valid zip — treat as a regular file.
    return { kind: 'not-zip', rawBuffer };
  }

  const entries = Object.values(outer.files).filter((f) => !f.dir);
  if (entries.length === 0) return { kind: 'single-zip', rawBuffer };

  // Check if ALL entries are .zip files (zip-of-zips convention).
  const allZips = entries.every((e) => e.name.endsWith('.zip'));
  if (!allZips) return { kind: 'single-zip', rawBuffer };

  // Extract each inner zip serially, tracking running uncompressed total.
  // At any point only ONE entry's data is held in memory beyond what's
  // already pushed to `result` — per the zip-bomb guard requirement.
  const result: Array<{ filename: string; data: ArrayBuffer }> = [];
  let totalUncompressed = 0;

  for (const entry of entries) {
    const data = await entry.async('arraybuffer');

    // Per-entry size check (kept from original).
    if (data.byteLength > maxBundleBytes) {
      throw Errors.ingestFileTooLarge(maxBundleBytes);
    }

    totalUncompressed += data.byteLength;

    // Running total cap — zip-bomb guard.
    if (totalUncompressed > maxBatchBytes) {
      throw Errors.ingestBatchTooLarge(maxBatchBytes);
    }

    // Use only the filename part, not path components inside the outer archive.
    const entryFilename = entry.name.split('/').at(-1) ?? entry.name;
    result.push({ filename: entryFilename, data });
  }

  return { kind: 'zip-of-zips', entries: result };
}

/**
 * Shape used internally for files to stage.
 */
interface FileToStage {
  filename: string;
  body: ArrayBuffer;
}

/**
 * Detect the "body too large to buffer in memory" failure mode.
 *
 * `c.req.parseBody()` defers to Node's FormData/undici multipart parser, which
 * concatenates the entire request body into a single contiguous buffer before
 * parsing. On 64-bit V8 that allocation trips a ~2 GiB-class ceiling (well
 * below INGEST_MAX_BATCH_BYTES), throwing a RangeError. Without this detection
 * the route's catch reports a misleading 400 "Request validation failed"; with
 * it we can return an actionable 413 pointing at local-path ingest.
 *
 * Matches on the V8/undici allocation-failure messages rather than the error
 * type alone, since the stack can surface these as RangeError or a plain Error.
 */
/**
 * Max ingest_files rows per bulk `INSERT ... VALUES` statement. Each row binds
 * ~6 params, so this stays well under Postgres's 65535 bind-param ceiling even
 * if an admin raises INGEST_MAX_BATCH_FILES above the single-statement limit.
 */
const INGEST_FILE_INSERT_CHUNK = 1000;

export function isUnbufferableBodyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes('Array buffer allocation failed') ||
    m.includes('Invalid typed array length') ||
    m.includes('Cannot create a string longer than') ||
    m.includes('Invalid string length') ||
    m.includes('out of memory')
  );
}

// ---------------------------------------------------------------------------
// IngestFileSummary formatter (PRD §8.6)
// ---------------------------------------------------------------------------

interface RawFileRow {
  id: string;
  original_filename: string;
  size_bytes: number;
  blob_sha256: string;
  status: string;
  matched_student_id: string | null;
  matched_student_sid: string | null;
  matched_student_display_name: string | null;
  matched_student_protected_index: number | null;
  matched_assignment_id: string | null;
  matched_assignment_id_str: string | null;
  matched_assignment_label: string | null;
  submission_id: string | null;
  filename_capture: unknown;
  error: unknown;
  created_at: Date | null;
}

/**
 * Map a raw ingest_files row (with joined roster/assignment columns) to the
 * IngestFileSummary shape from PRD §8.6.
 *
 * matched_student and matched_assignment are nested objects when the file was
 * successfully matched, per PRD §8.6.
 */
/**
 * Normalize an `ingest_jobs.summary` jsonb value to the full IngestJobSummary
 * shape required by the analyzer's Zod schema. Jobs that haven't computed
 * stats yet have `summary='{}'` in the DB (column default); the API contract
 * is to always send the 7 fields with 0 defaults so consumers don't have to
 * special-case the partial shape.
 */
function normalizeJobSummary(raw: unknown): {
  total: number;
  matched: number;
  unmatched: number;
  duplicate: number;
  failed: number;
  superseded: number;
  discarded: number;
} {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (k: string): number => (typeof s[k] === 'number' ? (s[k] as number) : 0);
  return {
    total: num('total'),
    matched: num('matched'),
    unmatched: num('unmatched'),
    duplicate: num('duplicate'),
    failed: num('failed'),
    superseded: num('superseded'),
    discarded: num('discarded'),
  };
}

function formatFileSummary(row: RawFileRow, protectedMode: boolean): Record<string, unknown> {
  const idxLabel =
    row.matched_student_id !== null
      ? protectedLabel(row.matched_student_protected_index, row.matched_student_id)
      : null;
  const out: Record<string, unknown> = {
    id: row.id,
    original_filename: maskFilename(
      row.original_filename,
      protectedMode,
      idxLabel !== null ? `${idxLabel} — file` : `(unmatched file ${row.id.slice(0, 8)})`,
    ),
    size_bytes: row.size_bytes,
    blob_sha256: row.blob_sha256,
    status: row.status,
  };

  if (row.matched_student_id !== null) {
    out['matched_student'] = projectStudent(
      {
        id: row.matched_student_id,
        sid: row.matched_student_sid ?? '',
        display_name: row.matched_student_display_name ?? '',
        protected_index: row.matched_student_protected_index,
      },
      protectedMode,
    );
  }
  if (row.matched_assignment_id !== null) {
    out['matched_assignment'] = {
      id: row.matched_assignment_id,
      assignment_id_str: row.matched_assignment_id_str,
      label: row.matched_assignment_label,
    };
  }
  if (row.submission_id !== null) {
    out['submission_id'] = row.submission_id;
  }
  if (!protectedMode && row.filename_capture !== null && row.filename_capture !== undefined) {
    out['filename_capture'] = row.filename_capture;
  }
  if (row.error !== null && row.error !== undefined) {
    out['error'] = row.error;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createIngestRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/ingest
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/ingest',
    rateLimit('write.ingest'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('ingest.start', 'ingest_job', (c) => (c.get('auditDetail')?.['job_id'] as string) ?? ''),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const cfg = getConfig();
      const db = getDb();
      const principal = c.var.principal!;

      // -----------------------------------------------------------------------
      // Content-Length pre-check (V20 lesson: reject before buffering).
      // -----------------------------------------------------------------------
      const contentLengthHeader = c.req.header('content-length');
      if (contentLengthHeader !== undefined) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > cfg.INGEST_MAX_BATCH_BYTES) {
          return c.json(Errors.ingestBatchTooLarge(cfg.INGEST_MAX_BATCH_BYTES).toBody(), 413);
        }
      }

      // -----------------------------------------------------------------------
      // ROSTER_REQUIRED: reject if semester has no roster entries yet.
      // -----------------------------------------------------------------------
      const rosterCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(roster_entries)
        .where(eq(roster_entries.semester_id, semesterId));

      if ((rosterCount[0]?.count ?? 0) === 0) {
        return c.json(Errors.rosterRequired().toBody(), 422);
      }

      // -----------------------------------------------------------------------
      // Parse multipart body.
      // -----------------------------------------------------------------------
      let formData: Record<string, unknown>;
      try {
        formData = await c.req.parseBody({ all: true });
      } catch (err) {
        if (isUnbufferableBodyError(err)) {
          return c.json(Errors.ingestArchiveUnbufferable().toBody(), 413);
        }
        return c.json(
          Errors.validation([
            {
              field: 'multipart',
              issue: `Failed to parse multipart body: ${err instanceof Error ? err.message : String(err)}`,
            },
          ]).toBody(),
          400,
        );
      }

      // Collect files: either `files[]` (array) or a single `archive`.
      const rawFiles: File[] = [];

      const archive = formData['archive'];
      const filesField = formData['files[]'];

      if (archive instanceof File) {
        rawFiles.push(archive);
      } else if (Array.isArray(filesField)) {
        for (const f of filesField) {
          if (f instanceof File) rawFiles.push(f);
        }
      } else if (filesField instanceof File) {
        rawFiles.push(filesField);
      }

      if (rawFiles.length === 0) {
        return c.json(
          Errors.validation([
            { field: 'files', issue: 'No files provided. Use `archive` or `files[]` field.' },
          ]).toBody(),
          400,
        );
      }

      // -----------------------------------------------------------------------
      // Expand zip-of-zips OR collect individual files.
      // Pre-read each File's buffer exactly once (Important 3: no double-buffer).
      // tryExpandZipBundle receives the already-read buffer and returns it on
      // non-zip-of-zips paths so we reuse it for stageBlob.
      // -----------------------------------------------------------------------
      const filesToStage: FileToStage[] = [];

      for (const raw of rawFiles) {
        // Per-file size check (before reading, to fail fast on obvious over-size).
        if (raw.size > cfg.INGEST_MAX_BUNDLE_BYTES) {
          return c.json(Errors.ingestFileTooLarge(cfg.INGEST_MAX_BUNDLE_BYTES).toBody(), 413);
        }

        // Read the buffer exactly once.
        const rawBuffer = await raw.arrayBuffer();

        // Try to expand as zip-of-zips.
        // tryExpandZipBundle enforces per-entry and running-total caps internally
        // (Critical 2 zip-bomb guard). May throw ApiError on violation.
        let expandResult: Awaited<ReturnType<typeof tryExpandZipBundle>>;
        try {
          expandResult = await tryExpandZipBundle(
            raw.name,
            rawBuffer,
            cfg.INGEST_MAX_BUNDLE_BYTES,
            cfg.INGEST_MAX_BATCH_BYTES,
          );
        } catch (err) {
          if (err instanceof ApiError) {
            return c.json(err.toBody(), err.status as 413 | 400);
          }
          throw err;
        }

        if (expandResult.kind === 'zip-of-zips') {
          for (const inner of expandResult.entries) {
            filesToStage.push({ filename: inner.filename, body: inner.data });
          }
        } else {
          // 'not-zip' or 'single-zip': reuse the already-read buffer.
          filesToStage.push({ filename: raw.name, body: expandResult.rawBuffer });
        }
      }

      // File count check (after expansion).
      if (filesToStage.length > cfg.INGEST_MAX_BATCH_FILES) {
        return c.json(
          Errors.ingestTooManyFiles(filesToStage.length, cfg.INGEST_MAX_BATCH_FILES).toBody(),
          400,
        );
      }

      // Batch size check (after expansion, summing sizes).
      const totalBytes = filesToStage.reduce((acc, f) => acc + f.body.byteLength, 0);
      if (totalBytes > cfg.INGEST_MAX_BATCH_BYTES) {
        return c.json(Errors.ingestBatchTooLarge(cfg.INGEST_MAX_BATCH_BYTES).toBody(), 413);
      }

      // -----------------------------------------------------------------------
      // Create the ingest_jobs row.
      // -----------------------------------------------------------------------
      const { jobId } = await enqueueIngestJob(db, semesterId, principal.user.id);

      // -----------------------------------------------------------------------
      // Stage each file, then bulk-insert the ingest_files rows and bulk-enqueue
      // the per-file jobs.
      //
      // Staging (the S3 PUT) is inherently per-file, but the row inserts and the
      // job enqueues are batched: a chunked `INSERT ... VALUES` for the rows and
      // a single `boss.insert` for the jobs, instead of one round-trip per file.
      // This path stages everything BEFORE enqueueing anything (the worker can't
      // start until the enqueue at the end regardless), so batching costs no
      // interleaving — unlike the Gradescope/local-path stream, which sends per
      // file on purpose so the worker starts mid-stream.
      //
      // Compensation: the whole block (staging, bulk insert, getBoss, bulk
      // enqueue) is wrapped so ANY failure marks the job 'failed' rather than
      // leaving it permanently 'queued'. Because rows are written only after all
      // staging succeeds, a mid-staging failure leaves zero ingest_files rows
      // (and orphan staging blobs the retention sweep reclaims) — not a partial
      // set. This also closes a prior gap where a getBoss()/enqueue failure after
      // staging left the job orphaned as 'queued'.
      // -----------------------------------------------------------------------
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));

      try {
        const fileRows: (typeof ingest_files.$inferInsert)[] = [];
        for (const file of filesToStage) {
          // Pre-allocate a UUID so we can build the staging key before the insert.
          const fileId = crypto.randomUUID();
          const { blobSha256, sizeBytes } = await stageBlob(
            { storageClient },
            { jobId, ingestFileId: fileId, body: file.body },
          );
          fileRows.push({
            id: fileId,
            ingest_job_id: jobId,
            original_filename: file.filename,
            size_bytes: sizeBytes,
            blob_sha256: blobSha256,
            status: 'pending',
          });
        }

        // Bulk-insert rows in chunks (see INGEST_FILE_INSERT_CHUNK for why).
        for (const rows of chunk(fileRows, INGEST_FILE_INSERT_CHUNK)) {
          await db.insert(ingest_files).values(rows);
        }

        // Enqueue all jobs in one call. pg-boss `insert` binds the whole job
        // array as a single JSON parameter, so it does NOT hit the bind-param
        // ceiling and needs no chunking. PRD §12.3: ingest_file retries up to 3
        // times on transient failure.
        const boss = await getBoss();
        await boss.insert(
          fileRows.map((r) => ({
            name: JOB_KINDS.INGEST_FILE,
            data: { ingestFileId: r.id, ingestJobId: jobId },
            // Exponential backoff so a transient-error retry (connection
            // exhaustion, brief PG restart) lands after the pressure clears.
            retryLimit: 3,
            retryDelay: 10,
            retryBackoff: true,
          })),
        );
      } catch (stagingErr) {
        // Compensation: mark the job failed so it is not permanently 'queued'.
        const detail = stagingErr instanceof Error ? stagingErr.message : String(stagingErr);
        await failIngestJob(db, jobId, detail);
        throw stagingErr;
      }

      // Set auditDetail so the audit middleware can log job_id as target_id.
      c.set('auditDetail', { job_id: jobId, file_count: filesToStage.length });

      return c.json({ job_id: jobId }, 202);
    },
  );

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/ingest:gradescope
  //
  // Primary upload path. Accepts the ZIP that Gradescope produces from
  // "Download Submissions": a single archive with a submission_metadata.yml and
  // one (already-unzipped) folder per submission. Unlike POST /ingest this does
  // NOT require a pre-existing roster — it populates/upserts the roster from the
  // metadata, then rebuilds and stages one bundle per submitter (group projects
  // → one submission per co-submitter via the match_sid hint).
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/ingest:gradescope',
    rateLimit('write.ingest'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('ingest.start', 'ingest_job', (c) => (c.get('auditDetail')?.['job_id'] as string) ?? ''),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const cfg = getConfig();
      const db = getDb();
      const principal = c.var.principal!;

      // Content-Length pre-check: reject obviously-oversize uploads up front.
      // The body is streamed to a temp file (not buffered), so the ceiling is
      // disk-bound (INGEST_MAX_UPLOAD_BYTES), not the ~2 GiB in-memory limit.
      const contentLengthHeader = c.req.header('content-length');
      if (contentLengthHeader !== undefined) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > cfg.INGEST_MAX_UPLOAD_BYTES) {
          return c.json(Errors.ingestBatchTooLarge(cfg.INGEST_MAX_UPLOAD_BYTES).toBody(), 413);
        }
      }

      // Stream the `archive` field straight to a temp file — never buffer the
      // whole body in memory — then hand the on-disk path to the same streaming
      // (yauzl) ingest the local-path CLI uses. This lifts the multipart/FormData
      // ~2 GiB ceiling so multi-GB / 10 GB+ exports ingest via this endpoint.
      const rawBody = c.req.raw.body;
      if (rawBody === null) {
        return c.json(
          Errors.validation([{ field: 'archive', issue: 'Empty request body.' }]).toBody(),
          400,
        );
      }

      const uploadStart = performance.now();
      const uploaded = await streamUploadToTempFile({
        fieldName: 'archive',
        maxBytes: cfg.INGEST_MAX_UPLOAD_BYTES,
        headers: c.req.raw.headers,
        body: rawBody,
      });
      recordPhase('upload:stream_to_disk', performance.now() - uploadStart);

      if (!uploaded.ok) {
        if (uploaded.error === 'too_large') {
          return c.json(Errors.ingestBatchTooLarge(cfg.INGEST_MAX_UPLOAD_BYTES).toBody(), 413);
        }
        const issue =
          uploaded.error === 'missing_file'
            ? 'Missing Gradescope export ZIP in `archive` field.'
            : `Failed to read multipart upload: ${uploaded.detail}`;
        return c.json(Errors.validation([{ field: 'archive', issue }]).toBody(), 400);
      }

      try {
        const storageClient = createStorageClient(storageConfigFromEnv(cfg));
        const ingestStart = performance.now();
        const result = await ingestLocalPath(
          { db, storageClient },
          {
            semesterId,
            userId: principal.user.id,
            archivePath: uploaded.path,
            maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
            maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
          },
        );
        recordPhase('upload:ingest', performance.now() - ingestStart);

        if (!result.ok) {
          if (result.error === 'too_many_files') {
            return c.json(
              Errors.ingestTooManyFiles(
                cfg.INGEST_MAX_BATCH_FILES + 1,
                cfg.INGEST_MAX_BATCH_FILES,
              ).toBody(),
              400,
            );
          }
          // not_a_zip | missing_metadata | invalid_metadata
          return c.json(
            Errors.validation([
              {
                field: 'archive',
                issue: `Invalid Gradescope export (${result.error}): ${result.detail}`,
              },
            ]).toBody(),
            400,
          );
        }

        const skippedSummary = result.skipped.map((s) => ({
          folder_key: s.folderKey,
          scope_path: s.scopePath,
          reason: s.reason,
        }));

        // No bundles to process (roster-only, or all folders skipped): the roster
        // is upserted but there is no ingest job. Return 200, not 202.
        if (result.jobId === null) {
          c.set('auditDetail', {
            roster_added: result.roster.added,
            roster_updated: result.roster.updated,
          });
          return c.json(
            {
              job_id: null,
              roster: result.roster,
              bundles_processed: result.bundlesProcessed,
              submissions_queued: result.submissionsQueued,
              skipped: skippedSummary,
            },
            200,
          );
        }

        c.set('auditDetail', { job_id: result.jobId, file_count: result.submissionsQueued });
        return c.json(
          {
            job_id: result.jobId,
            roster: result.roster,
            bundles_processed: result.bundlesProcessed,
            submissions_queued: result.submissionsQueued,
            skipped: skippedSummary,
          },
          202,
        );
      } finally {
        await uploaded.cleanup();
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/ingest/jobs
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/ingest/jobs',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const rawLimit = parseInt(c.req.query('limit') ?? '20', 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 || rawLimit > 100 ? 20 : rawLimit;

      const statusFilter = c.req.query('status');
      const cursorStr = c.req.query('cursor');

      // Decode cursor: ISO timestamp for keyset pagination on created_at DESC.
      let cursorDate: Date | null = null;
      if (cursorStr !== undefined) {
        const parsed = new Date(cursorStr);
        if (!isNaN(parsed.getTime())) {
          cursorDate = parsed;
        }
      }

      // Build query with keyset pagination.
      const rows = await db
        .select({
          id: ingest_jobs.id,
          semester_id: ingest_jobs.semester_id,
          status: ingest_jobs.status,
          summary: ingest_jobs.summary,
          created_at: ingest_jobs.created_at,
          started_at: ingest_jobs.started_at,
          completed_at: ingest_jobs.completed_at,
          uploaded_by: ingest_jobs.uploaded_by,
        })
        .from(ingest_jobs)
        .where(
          and(
            eq(ingest_jobs.semester_id, semesterId),
            statusFilter !== undefined ? eq(ingest_jobs.status, statusFilter) : undefined,
            cursorDate !== null ? lt(ingest_jobs.created_at, cursorDate) : undefined,
          ),
        )
        .orderBy(desc(ingest_jobs.created_at))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? (items.at(-1)?.created_at?.toISOString() ?? null) : null;

      return c.json({
        items: items.map((r) => ({
          id: r.id,
          semester_id: r.semester_id,
          status: r.status,
          summary: normalizeJobSummary(r.summary),
          created_at: r.created_at?.toISOString() ?? null,
          started_at: r.started_at?.toISOString() ?? null,
          completed_at: r.completed_at?.toISOString() ?? null,
        })),
        next_cursor: nextCursor,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/ingest/jobs/:jobId
  // -------------------------------------------------------------------------
  // PRD §8.6: returns job detail with summary counts + first 200 files inline.

  router.get(
    '/semesters/:semesterId/ingest/jobs/:jobId',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const jobId = c.req.param('jobId')!;
      const db = getDb();

      const jobRows = await db
        .select()
        .from(ingest_jobs)
        .where(and(eq(ingest_jobs.id, jobId), eq(ingest_jobs.semester_id, semesterId)));

      if (jobRows.length === 0) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const job = jobRows[0]!;

      // Compute summary counts from ingest_files.
      const fileStatusCounts = await db
        .select({ status: ingest_files.status, cnt: count() })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, jobId))
        .groupBy(ingest_files.status);

      const summary: {
        total: number;
        matched: number;
        unmatched: number;
        duplicate: number;
        failed: number;
        superseded: number;
        discarded: number;
      } = {
        total: 0,
        matched: 0,
        unmatched: 0,
        duplicate: 0,
        failed: 0,
        superseded: 0,
        discarded: 0,
      };

      for (const row of fileStatusCounts) {
        const s = row.status as keyof typeof summary;
        if (s in summary && s !== 'total') {
          (summary as Record<string, number>)[s] = row.cnt;
        }
        summary.total += row.cnt;
      }

      // Fetch first 200 files inline, joining roster_entries and assignments for
      // the nested matched_student / matched_assignment objects (PRD §8.6).
      const fileRows = await db
        .select({
          id: ingest_files.id,
          original_filename: ingest_files.original_filename,
          size_bytes: ingest_files.size_bytes,
          blob_sha256: ingest_files.blob_sha256,
          status: ingest_files.status,
          matched_student_id: ingest_files.matched_student_id,
          matched_student_sid: roster_entries.sid,
          matched_student_display_name: roster_entries.display_name,
          matched_student_protected_index: roster_entries.protected_index,
          matched_assignment_id: ingest_files.matched_assignment_id,
          matched_assignment_id_str: assignments.assignment_id_str,
          matched_assignment_label: assignments.label,
          submission_id: ingest_files.submission_id,
          filename_capture: ingest_files.filename_capture,
          error: ingest_files.error,
          created_at: ingest_files.created_at,
        })
        .from(ingest_files)
        .leftJoin(roster_entries, eq(ingest_files.matched_student_id, roster_entries.id))
        .leftJoin(assignments, eq(ingest_files.matched_assignment_id, assignments.id))
        .where(eq(ingest_files.ingest_job_id, jobId))
        .orderBy(ingest_files.created_at)
        .limit(200);

      const jobDetailProtectedMode = requirePrincipal(c).user.protected;
      return c.json({
        id: job.id,
        semester_id: job.semester_id,
        status: job.status,
        created_at: job.created_at?.toISOString() ?? null,
        started_at: job.started_at?.toISOString() ?? null,
        completed_at: job.completed_at?.toISOString() ?? null,
        summary,
        files: fileRows.map((row) => formatFileSummary(row, jobDetailProtectedMode)),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/ingest/jobs/:jobId/files
  // -------------------------------------------------------------------------
  // PRD §8.6: paginated full file list.

  router.get(
    '/semesters/:semesterId/ingest/jobs/:jobId/files',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const jobId = c.req.param('jobId')!;
      const db = getDb();

      // Verify job exists in this semester.
      const jobRows = await db
        .select({ id: ingest_jobs.id })
        .from(ingest_jobs)
        .where(and(eq(ingest_jobs.id, jobId), eq(ingest_jobs.semester_id, semesterId)));

      if (jobRows.length === 0) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 || rawLimit > 200 ? 50 : rawLimit;

      const cursorStr = c.req.query('cursor');
      let cursorDate: Date | null = null;
      if (cursorStr !== undefined) {
        const parsed = new Date(cursorStr);
        if (!isNaN(parsed.getTime())) {
          cursorDate = parsed;
        }
      }

      const fileRows = await db
        .select({
          id: ingest_files.id,
          original_filename: ingest_files.original_filename,
          size_bytes: ingest_files.size_bytes,
          blob_sha256: ingest_files.blob_sha256,
          status: ingest_files.status,
          matched_student_id: ingest_files.matched_student_id,
          matched_student_sid: roster_entries.sid,
          matched_student_display_name: roster_entries.display_name,
          matched_student_protected_index: roster_entries.protected_index,
          matched_assignment_id: ingest_files.matched_assignment_id,
          matched_assignment_id_str: assignments.assignment_id_str,
          matched_assignment_label: assignments.label,
          submission_id: ingest_files.submission_id,
          filename_capture: ingest_files.filename_capture,
          error: ingest_files.error,
          created_at: ingest_files.created_at,
        })
        .from(ingest_files)
        .leftJoin(roster_entries, eq(ingest_files.matched_student_id, roster_entries.id))
        .leftJoin(assignments, eq(ingest_files.matched_assignment_id, assignments.id))
        .where(
          and(
            eq(ingest_files.ingest_job_id, jobId),
            cursorDate !== null ? lt(ingest_files.created_at, cursorDate) : undefined,
          ),
        )
        .orderBy(ingest_files.created_at)
        .limit(limit + 1);

      const hasMore = fileRows.length > limit;
      const items = hasMore ? fileRows.slice(0, limit) : fileRows;
      const nextCursor = hasMore ? (items.at(-1)?.created_at?.toISOString() ?? null) : null;

      const filesListProtectedMode = requirePrincipal(c).user.protected;
      return c.json({
        items: items.map((row) => formatFileSummary(row, filesListProtectedMode)),
        next_cursor: nextCursor,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/ingest/jobs/:jobId/cancel
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/ingest/jobs/:jobId/cancel',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('ingest.cancel', 'ingest_job', (c) => c.req.param('jobId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const jobId = c.req.param('jobId')!;
      const db = getDb();

      const result = await cancelIngestJob(db, jobId, semesterId);

      // Return 202 for both real cancellations and idempotent no-ops (already
      // cancelled). Include the discriminated fields so callers can tell them
      // apart without a follow-up GET.
      return c.json(
        {
          ok: true,
          cancelled: result.cancelled,
          previous_status: result.previous_status,
        },
        202,
      );
    },
  );

  // -------------------------------------------------------------------------
  // Resumable (chunked) upload — for very large exports over HTTP.
  //
  // Backed by an S3/MinIO multipart upload so an interrupted transfer resumes by
  // re-sending only missing parts (durable across processes/restarts). The
  // (semesterId, uploadId) pair derives the storage key; the S3 upload id
  // returned at create is the capability secret echoed on every request.
  // -------------------------------------------------------------------------

  // POST /semesters/:semesterId/ingest/uploads — begin a resumable upload.
  router.post(
    '/semesters/:semesterId/ingest/uploads',
    rateLimit('write.ingest'),
    requireAuth({ action: 'write', target: (c) => ({ semesterId: c.req.param('semesterId')! }) }),
    async (c) => {
      const cfg = getConfig();
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }
      const parsed = CreateUploadRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(Errors.validation(parsed.error.issues).toBody(), 400);
      }
      if (parsed.data.total_bytes > cfg.INGEST_MAX_UPLOAD_BYTES) {
        return c.json(Errors.ingestBatchTooLarge(cfg.INGEST_MAX_UPLOAD_BYTES).toBody(), 413);
      }

      const semesterId = c.req.param('semesterId')!;
      const uploadId = crypto.randomUUID();
      const chunkBytes = resolveChunkBytes(parsed.data.chunk_size);
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      const { s3UploadId, totalParts } = await createResumableUpload(
        { storageClient },
        { semesterId, uploadId, totalBytes: parsed.data.total_bytes, chunkBytes },
      );

      return c.json(
        {
          upload_id: uploadId,
          s3_upload_id: s3UploadId,
          chunk_size: chunkBytes,
          total_parts: totalParts,
        },
        201,
      );
    },
  );

  // PUT /semesters/:semesterId/ingest/uploads/:uploadId/parts/:partNumber
  router.put(
    '/semesters/:semesterId/ingest/uploads/:uploadId/parts/:partNumber',
    rateLimit('write.ingest_part'),
    requireAuth({ action: 'write', target: (c) => ({ semesterId: c.req.param('semesterId')! }) }),
    async (c) => {
      const cfg = getConfig();
      const semesterId = c.req.param('semesterId')!;
      const uploadId = c.req.param('uploadId')!;
      const partNumber = parseInt(c.req.param('partNumber')!, 10);
      const s3UploadId = c.req.query('s3_upload_id');

      if (s3UploadId === undefined || s3UploadId === '') {
        return c.json(
          Errors.validation([
            { field: 's3_upload_id', issue: 'Missing s3_upload_id query param.' },
          ]).toBody(),
          400,
        );
      }
      if (isNaN(partNumber) || partNumber < 1) {
        return c.json(
          Errors.validation([
            { field: 'partNumber', issue: 'partNumber must be a positive integer.' },
          ]).toBody(),
          400,
        );
      }
      // Bound per-part memory: the part is buffered to compute its SigV4 hash.
      const clHeader = c.req.header('content-length');
      if (clHeader !== undefined) {
        const cl = parseInt(clHeader, 10);
        if (!isNaN(cl) && cl > 512 * 1024 * 1024 + 4096) {
          return c.json(Errors.ingestBatchTooLarge(512 * 1024 * 1024).toBody(), 413);
        }
      }

      const partBody = await c.req.arrayBuffer();
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      try {
        await putResumablePart(
          { storageClient },
          { semesterId, uploadId, s3UploadId, partNumber, body: partBody },
        );
      } catch (err) {
        return c.json(
          Errors.validation([
            {
              field: 'part',
              issue: `Failed to store part: ${err instanceof Error ? err.message : String(err)}`,
            },
          ]).toBody(),
          400,
        );
      }

      return c.json({ part_number: partNumber, received: true }, 200);
    },
  );

  // GET /semesters/:semesterId/ingest/uploads/:uploadId/parts — resume status.
  router.get(
    '/semesters/:semesterId/ingest/uploads/:uploadId/parts',
    rateLimit('write.ingest_part'),
    requireAuth({ action: 'write', target: (c) => ({ semesterId: c.req.param('semesterId')! }) }),
    async (c) => {
      const cfg = getConfig();
      const semesterId = c.req.param('semesterId')!;
      const uploadId = c.req.param('uploadId')!;
      const s3UploadId = c.req.query('s3_upload_id');
      if (s3UploadId === undefined || s3UploadId === '') {
        return c.json(
          Errors.validation([
            { field: 's3_upload_id', issue: 'Missing s3_upload_id query param.' },
          ]).toBody(),
          400,
        );
      }
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      try {
        const received = await listResumablePartNumbers(
          { storageClient },
          { semesterId, uploadId, s3UploadId },
        );
        return c.json({ received_parts: received }, 200);
      } catch {
        // An unknown/aborted upload id has no parts to list.
        return c.json(Errors.notFound().toBody(), 404);
      }
    },
  );

  // POST /semesters/:semesterId/ingest/uploads/:uploadId/complete — finalize + ingest.
  router.post(
    '/semesters/:semesterId/ingest/uploads/:uploadId/complete',
    rateLimit('write.ingest'),
    requireAuth({ action: 'write', target: (c) => ({ semesterId: c.req.param('semesterId')! }) }),
    audit('ingest.start', 'ingest_job', (c) => (c.get('auditDetail')?.['job_id'] as string) ?? ''),
    async (c) => {
      const db = getDb();
      const principal = c.var.principal!;
      const semesterId = c.req.param('semesterId')!;
      const uploadId = c.req.param('uploadId')!;

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }
      const s3UploadId = (body as { s3_upload_id?: unknown })?.s3_upload_id;
      if (typeof s3UploadId !== 'string' || s3UploadId === '') {
        return c.json(
          Errors.validation([{ field: 's3_upload_id', issue: 'Missing s3_upload_id.' }]).toBody(),
          400,
        );
      }

      // Create the ingest job row up front so the client gets a job_id to poll
      // immediately, then hand the heavy assemble→download→stage work to a
      // background `ingest_stage_upload` job. This keeps the request fast: a
      // multi-GB export no longer blocks /complete for minutes (which left the
      // UI stuck at "Uploading… 100%").
      const { jobId } = await enqueueIngestJob(db, semesterId, principal.user.id);

      const boss = await getBoss();
      await boss.send(
        JOB_KINDS.INGEST_STAGE_UPLOAD,
        {
          ingestJobId: jobId,
          semesterId,
          userId: principal.user.id,
          uploadId,
          s3UploadId,
        } satisfies IngestStageUploadPayload,
        // Not retryable: S3 multipart completion is non-idempotent. On failure
        // the worker marks the job failed so the UI surfaces it.
        { singletonKey: jobId, retryLimit: 0 },
      );

      c.set('auditDetail', { job_id: jobId });

      // The roster/counts/skipped are reported via GET /ingest/jobs/:jobId as the
      // background job runs; the immediate response carries placeholders so the
      // wire shape (and the analyzer's GradescopeIngestResponse parse) is stable.
      return c.json(
        {
          job_id: jobId,
          roster: { added: 0, updated: 0 },
          bundles_processed: 0,
          submissions_queued: 0,
          skipped: [],
        },
        202,
      );
    },
  );

  // DELETE /semesters/:semesterId/ingest/uploads/:uploadId — abort.
  router.delete(
    '/semesters/:semesterId/ingest/uploads/:uploadId',
    rateLimit('write.misc'),
    requireAuth({ action: 'write', target: (c) => ({ semesterId: c.req.param('semesterId')! }) }),
    async (c) => {
      const cfg = getConfig();
      const semesterId = c.req.param('semesterId')!;
      const uploadId = c.req.param('uploadId')!;
      const s3UploadId = c.req.query('s3_upload_id');
      if (s3UploadId === undefined || s3UploadId === '') {
        return c.json(
          Errors.validation([
            { field: 's3_upload_id', issue: 'Missing s3_upload_id query param.' },
          ]).toBody(),
          400,
        );
      }
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      await abortResumableUpload({ storageClient }, { semesterId, uploadId, s3UploadId });
      return c.body(null, 204);
    },
  );

  return router;
}
