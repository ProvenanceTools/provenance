/**
 * Ingest job lifecycle control (PRD §9.1).
 *
 * Status transitions:
 *   ingest_jobs: queued -> running -> { succeeded | partial | failed | cancelled }
 *
 * This module owns inserts and updates to `ingest_jobs`. The per-file pipeline
 * updates `ingest_files` rows directly; `finalizeIngestJob` (Phase 9b) reads
 * them to compute the terminal job status.
 *
 * Phase 9a scope:
 *   - enqueueIngestJob: creates the job row with status='queued'.
 *   - finalizeIngestJob: stub — full logic (counting file statuses, computing
 *     'succeeded'/'partial'/'failed') lands in Phase 9b.
 *   - cancelIngestJob: sets status='cancelled'.
 */

import type { DrizzleDb } from '../../db/client.js';
import { ingest_jobs, ingest_files } from '../../db/schema.js';
import { eq, and, ne, count } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { JOB_KINDS } from '../../jobs/pg-boss.js';
import { getLogger } from '../../logging.js';
import { Errors } from '../../api/v1/errors.js';

// ---------------------------------------------------------------------------
// failIngestJob
// ---------------------------------------------------------------------------

/**
 * Marks an ingest job as failed with an optional error detail string.
 *
 * Called as a compensation path when staging fails mid-batch. Any blobs
 * already staged to MinIO are left as orphans — the retention sweep (Phase 9c)
 * will clean them up.
 *
 * Silently no-ops if the job doesn't exist (worker idempotency).
 *
 * Does NOT name `skipped` — see `recordIngestJobSkipped`. A staging run that
 * aborts part-way leaves it `null` (unknown), which is the truth: the reason
 * list it had computed so far is incomplete and must not be published as if it
 * were the whole story.
 */
export async function failIngestJob(
  db: DrizzleDb,
  jobId: string,
  errorDetail?: string,
): Promise<void> {
  await db
    .update(ingest_jobs)
    .set({
      status: 'failed',
      completed_at: new Date(),
      summary: errorDetail !== undefined ? { error: errorDetail } : {},
    })
    .where(eq(ingest_jobs.id, jobId));
}

// ---------------------------------------------------------------------------
// recordIngestJobSkipped
// ---------------------------------------------------------------------------

/**
 * One scope-resolution skip, in the WIRE shape the API serves.
 *
 * Stored exactly as it is returned so the read path is a pass-through and the
 * single-shot and chunked upload routes cannot drift into different shapes.
 * Structurally `GradescopeSkippedEntry` from `@provenance/shared`; declared
 * locally so `job-control` (a DB module) does not take an HTTP-schema import
 * just to name a jsonb payload. The two are pinned together by the only call
 * site, `recordIngestJobSkipped(db, jobId, toSkippedWire(...))` in
 * `local-path.ts`: `toSkippedWire` returns `GradescopeSkippedEntry[]`, so if the
 * shared schema and this interface ever diverge, that line stops compiling.
 */
export interface IngestJobSkippedEntry {
  folder_key: string;
  /**
   * Optional to stay assignable from `GradescopeSkippedEntry`, whose own
   * optionality exists so a response predating scope fan-out still parses.
   * `toSkippedWire` always emits it, so nothing this codebase writes omits it.
   * Spelled `| undefined` because the server compiles with
   * `exactOptionalPropertyTypes`.
   */
  scope_path?: string | undefined;
  reason: string;
}

/**
 * Persists the COMPLETE scope-resolution skip list for a job (migration 0028).
 *
 * Call this only once resolution has finished for the whole export, and always
 * before `markStagingComplete` — after that point a worker may finalize the job
 * at any moment, and a poller that sees a terminal status must not still be
 * looking at `null`.
 *
 * Two properties are deliberate:
 *
 *  - **Replacement, not append.** The caller passes the whole list; this
 *    overwrites. That is what makes the ingest pipeline's idempotency
 *    requirement hold for free — re-running staging recomputes an identical
 *    list and writes it over the old one, so a retry cannot duplicate reasons.
 *  - **`[]` is meaningful.** Writing an empty array is not a no-op: it is the
 *    positive statement "resolution ran and skipped nothing", as distinct from
 *    the column's `null` (unknown). Never skip the write to save a round trip.
 *
 * Silently no-ops if the job doesn't exist (worker idempotency).
 */
export async function recordIngestJobSkipped(
  db: DrizzleDb,
  jobId: string,
  skipped: readonly IngestJobSkippedEntry[],
): Promise<void> {
  await db
    .update(ingest_jobs)
    // Spread to a plain array: the column holds a JSON document, and a
    // readonly view of the caller's live array is not one.
    .set({ skipped: [...skipped] })
    .where(eq(ingest_jobs.id, jobId));
}

// ---------------------------------------------------------------------------
// markIngestJobRunning
// ---------------------------------------------------------------------------

/**
 * Transitions an ingest job from 'queued' to 'running'.
 *
 * Called when the first `ingest_file` worker picks up a file for this job.
 * Idempotent: if the job is already 'running' (another worker beat us to it),
 * the update is a no-op.
 *
 * Does not update 'cancelled', 'failed', or other terminal states.
 */
export async function markIngestJobRunning(db: DrizzleDb, jobId: string): Promise<void> {
  await db
    .update(ingest_jobs)
    .set({ status: 'running', started_at: new Date() })
    .where(and(eq(ingest_jobs.id, jobId), eq(ingest_jobs.status, 'queued')));
}

// ---------------------------------------------------------------------------
// enqueueIngestJob
// ---------------------------------------------------------------------------

export interface EnqueueIngestJobResult {
  jobId: string;
}

/**
 * Creates an ingest_jobs row with status='queued'.
 *
 * Does NOT enqueue a pg-boss job — the caller (route handler) does that
 * after creating the ingest_files rows. This keeps the DB insert and the
 * queue send in the same logical unit as close as possible.
 */
export async function enqueueIngestJob(
  db: DrizzleDb,
  semesterId: string,
  userId: string,
): Promise<EnqueueIngestJobResult> {
  const rows = await db
    .insert(ingest_jobs)
    .values({
      semester_id: semesterId,
      uploaded_by: userId,
      status: 'queued',
      summary: {},
    })
    .returning({ id: ingest_jobs.id });

  const row = rows[0];
  if (!row) {
    throw Errors.internal(undefined, 'enqueueIngestJob: insert returned no rows');
  }

  return { jobId: row.id };
}

// ---------------------------------------------------------------------------
// finalizeIngestJob  (Phase 9b)
// ---------------------------------------------------------------------------

/**
 * Summary counts computed from ingest_files rows.
 */
export interface IngestJobSummary {
  total: number;
  matched: number;
  unmatched: number;
  duplicate: number;
  failed: number;
  superseded: number;
  discarded: number;
}

/**
 * Finalizes an ingest job after all files have been processed.
 *
 * Reads all `ingest_files` for the job, counts statuses, computes the
 * terminal job status, and updates `ingest_jobs`.
 *
 * Terminal status rules (PRD §9.3):
 *   - 'succeeded'  — every file is in {matched, duplicate, superseded}.
 *   - 'partial'    — at least one file is in {failed, unmatched, discarded}
 *                    but the run otherwise completed.
 *   - 'failed'     — the caller explicitly requests failure (e.g. unrecoverable
 *                    worker error). Use `failIngestJob` for that path instead.
 *
 * Idempotent: silently no-ops if the job is already in an immutable terminal
 * state (succeeded/partial/failed). For a cancelled job it preserves the
 * 'cancelled' status and completed_at but refreshes the summary, so the
 * matched/discarded counts from a cooperative cancel are reflected.
 *
 * ## `skipped` is not summary, and must not be rebuilt here
 *
 * This function derives EVERYTHING from `ingest_files` row statuses. A scope
 * that was skipped during resolution has no `ingest_files` row at all — that is
 * what being skipped means — so it is structurally invisible from here and no
 * amount of counting will recover it. `ingest_jobs.skipped` is written
 * separately by `recordIngestJobSkipped` before staging completes.
 *
 * Both UPDATE statements below therefore set `status` / `completed_at` /
 * `summary` and nothing else. Adding `skipped` to either `.set()` — including
 * "helpfully" resetting it to `[]` — would clobber the only record that those
 * scopes ever existed, on the exact path (finalize, and the cancelled-job
 * summary refresh) that runs after every ingest.
 */
export async function finalizeIngestJob(db: DrizzleDb, jobId: string): Promise<void> {
  const rows = await db
    .select({ status: ingest_jobs.status })
    .from(ingest_jobs)
    .where(eq(ingest_jobs.id, jobId));

  if (rows.length === 0) {
    // Silently return if the job doesn't exist — worker idempotency.
    return;
  }

  const job = rows[0]!;
  // Immutable terminal states — never recompute (idempotent).
  if (job.status === 'succeeded' || job.status === 'partial' || job.status === 'failed') {
    return;
  }

  // Count file statuses.
  const fileRows = await db
    .select({ status: ingest_files.status })
    .from(ingest_files)
    .where(eq(ingest_files.ingest_job_id, jobId));

  const summary: IngestJobSummary = {
    total: fileRows.length,
    matched: 0,
    unmatched: 0,
    duplicate: 0,
    failed: 0,
    superseded: 0,
    discarded: 0,
  };

  for (const f of fileRows) {
    switch (f.status) {
      case 'matched':
        summary.matched++;
        break;
      case 'unmatched':
        summary.unmatched++;
        break;
      case 'duplicate':
        summary.duplicate++;
        break;
      case 'failed':
        summary.failed++;
        break;
      case 'superseded':
        summary.superseded++;
        break;
      case 'discarded':
        summary.discarded++;
        break;
      // 'pending' and any unrecognized status: ignored (not counted in named fields).
    }
  }

  // A cancelled job keeps its terminal status and completed_at; we only refresh
  // the summary so the matched/discarded counts from a cooperative cancel are
  // visible to staff. Cancel never becomes succeeded/partial.
  // (`skipped` is intentionally absent from this .set() — see the doc comment.)
  if (job.status === 'cancelled') {
    await db
      .update(ingest_jobs)
      .set({ summary: summary as unknown as Record<string, unknown> })
      .where(eq(ingest_jobs.id, jobId));
    return;
  }

  // Determine terminal job status.
  const hasProblems = summary.failed > 0 || summary.unmatched > 0 || summary.discarded > 0;

  const terminalStatus = hasProblems ? 'partial' : 'succeeded';

  await db
    .update(ingest_jobs)
    .set({
      status: terminalStatus,
      completed_at: new Date(),
      summary: summary as unknown as Record<string, unknown>,
    })
    .where(eq(ingest_jobs.id, jobId));
}

// ---------------------------------------------------------------------------
// cancelIngestJob
// ---------------------------------------------------------------------------

export interface CancelIngestJobResult {
  /** Whether this call actually transitioned the job to cancelled. */
  cancelled: boolean;
  /** The status the job was in before this call. */
  previous_status: string;
}

/**
 * Cancels an ingest job if it is still in a cancellable state (queued/running).
 *
 * Returns `{ cancelled, previous_status }`:
 *   - `cancelled: true`  — job was queued/running and is now cancelled.
 *   - `cancelled: false` — job was already cancelled (idempotent, no-op).
 *
 * Throws NOT_FOUND if the job doesn't exist in the given semester.
 * Throws INGEST_JOB_NOT_CANCELLABLE (409) if the job is in a terminal state
 * other than 'cancelled' (i.e. succeeded / partial / failed).
 */
export async function cancelIngestJob(
  db: DrizzleDb,
  jobId: string,
  semesterId: string,
): Promise<CancelIngestJobResult> {
  // First, fetch the current status so we can give precise feedback.
  const existing = await db
    .select({ id: ingest_jobs.id, status: ingest_jobs.status })
    .from(ingest_jobs)
    .where(and(eq(ingest_jobs.id, jobId), eq(ingest_jobs.semester_id, semesterId)));

  if (existing.length === 0) {
    throw Errors.notFound();
  }

  const currentStatus = existing[0]!.status;

  // Already cancelled — idempotent no-op.
  if (currentStatus === 'cancelled') {
    return { cancelled: false, previous_status: currentStatus };
  }

  // Terminal (non-cancellable) states.
  if (currentStatus === 'succeeded' || currentStatus === 'partial' || currentStatus === 'failed') {
    throw Errors.ingestJobNotCancellable(currentStatus);
  }

  // Cancel it (queued or running). Sets status + completed_at only: a cancel
  // must not erase `skipped`, and a cancel that lands BEFORE the stager records
  // it must not block the later write either — the reasons a cancelled run did
  // resolve are still audit material.
  await db
    .update(ingest_jobs)
    .set({ status: 'cancelled', completed_at: new Date() })
    .where(
      and(
        eq(ingest_jobs.id, jobId),
        eq(ingest_jobs.semester_id, semesterId),
        ne(ingest_jobs.status, 'succeeded'),
        ne(ingest_jobs.status, 'partial'),
        ne(ingest_jobs.status, 'failed'),
        ne(ingest_jobs.status, 'cancelled'),
      ),
    );

  return { cancelled: true, previous_status: currentStatus };
}

// ---------------------------------------------------------------------------
// Staging-completion flags + gated finalize trigger
// ---------------------------------------------------------------------------

/** pg-boss payload for an `ingest_finalize` job. */
export interface IngestFinalizePayload {
  ingestJobId: string;
}

/**
 * Marks a job as still staging (`staging_complete=false`). Called by the
 * streaming local-path stager before it enqueues any per-file jobs, so a worker
 * that drains the queue during a staging lull cannot finalize the job early.
 */
export async function markStagingStarted(db: DrizzleDb, jobId: string): Promise<void> {
  await db.update(ingest_jobs).set({ staging_complete: false }).where(eq(ingest_jobs.id, jobId));
}

/**
 * Marks a job as fully staged (`staging_complete=true`). Called by the stager
 * once its loop completes; after this, maybeEnqueueFinalize is allowed to settle
 * the job.
 */
export async function markStagingComplete(db: DrizzleDb, jobId: string): Promise<void> {
  await db.update(ingest_jobs).set({ staging_complete: true }).where(eq(ingest_jobs.id, jobId));
}

/**
 * After a file transitions to a terminal status, settle the job if (a) staging
 * is complete and (b) no files remain pending. Enqueues one `ingest_finalize`
 * job with `singletonKey = ingestJobId` so pg-boss deduplicates concurrent
 * sends and only one finalize runs per job.
 *
 * The `staging_complete` gate is what makes interleaved staging safe: while the
 * streaming stager is still adding rows, a momentarily-empty pending count must
 * NOT finalize the job.
 *
 * Signature is (boss, db, jobId) to match the worker's existing call sites.
 */
export async function maybeEnqueueFinalize(
  boss: PgBoss,
  db: DrizzleDb,
  ingestJobId: string,
): Promise<void> {
  const jobRows = await db
    .select({ stagingComplete: ingest_jobs.staging_complete })
    .from(ingest_jobs)
    .where(eq(ingest_jobs.id, ingestJobId));
  const job = jobRows[0];
  if (!job || !job.stagingComplete) {
    // Job gone, or staging still in flight — don't finalize yet.
    return;
  }

  const pendingCount = await db
    .select({ cnt: count() })
    .from(ingest_files)
    .where(and(eq(ingest_files.ingest_job_id, ingestJobId), eq(ingest_files.status, 'pending')));

  const remaining = pendingCount[0]?.cnt ?? 0;
  if (remaining === 0) {
    // PRD §12.3: finalize jobs retry up to 5 times.
    await boss.send(JOB_KINDS.INGEST_FINALIZE, { ingestJobId } satisfies IngestFinalizePayload, {
      singletonKey: ingestJobId,
      retryLimit: 5,
    });
    getLogger().info({ ingestJobId }, 'ingest_finalize: enqueued');
  }
}
