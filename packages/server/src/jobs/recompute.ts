/**
 * Recompute pg-boss job handlers — Phase 13b.
 *
 * Three handlers, registered alongside the ingest handlers in worker.ts:
 *
 *   recompute_semester   — reads the recompute_jobs row, enumerates non-superseded
 *                          submissions, marks them 'stale', enqueues one
 *                          recompute_submission job per submission.
 *
 *   recompute_submission — calls recomputeSubmission() to re-run heuristics and
 *                          update flags + score. On completion increments
 *                          progress_done (or progress_failed). When all done,
 *                          enqueues recompute_finalize.
 *
 *   recompute_finalize   — marks the recompute_jobs row terminal based on
 *                          progress_done / progress_failed.
 *
 * ## Retry policy (PRD §12.3)
 *
 *   recompute_submission — retryLimit: 3 (per-submission failures are recoverable)
 *   recompute_finalize   — retryLimit: 5 (cheap and must complete)
 *   recompute_semester   — retryLimit: 5 (enumeration; cheap)
 *
 * Retry limits are set at send time (V26 / V25 patterns), not at work() time.
 *
 * ## Finalize dispatch
 *
 * Same "last-worker-enqueues-finalize" pattern as ingest (see worker.ts JSDoc):
 * after each recompute_submission completes (success OR failure), check if
 * progress_done + progress_failed == progress_total. If so, send one
 * recompute_finalize with singletonKey = recomputeJobId.
 *
 * ## Phase 14 hook
 *
 * // Phase 14 hooks recompute_finalize to enqueue recompute_cross_flags (see lines ~388-397).
 *
 * ## recompute_submission concurrency (RECOMPUTE_MAX_PARALLEL)
 *
 * `recompute_submission` is registered with `batchSize: RECOMPUTE_MAX_PARALLEL`
 * (default 4), so pg-boss hands the handler up to that many jobs per poll. Two
 * things follow from that which a single-job handler didn't have to worry about:
 *
 *  1. **A batch fails or succeeds together unless told otherwise.** pg-boss
 *     tracks completion per FETCH, not per job (see `manager.js`'s `onFetch`):
 *     if the handler's returned promise rejects, EVERY job it was given —
 *     not just the one that errored — gets marked failed. The per-job `try`/
 *     `catch` below therefore never rethrows; on failure it calls
 *     `boss.fail(...)` for THAT job's id alone. That composes safely with the
 *     implicit whole-batch `complete()` pg-boss runs when the handler
 *     resolves, because `completeJobs`/`failJobsById` both guard on the job
 *     still being in the `active` state — a job already explicitly failed is
 *     simply skipped. Same reasoning `ingest_file`'s batched handler already
 *     relies on (worker.ts, `processIngestFile`).
 *
 *  2. **Different submissions must not interfere with each other**, and
 *     verifiably don't: `recomputeSubmission`'s writes (flags, per_file_stats,
 *     submission_contributors, the submissions row) are all scoped to a single
 *     `submission_id`, and `loadSubmissionIndex`'s LRU cache is keyed by
 *     `${submissionId}:${blob_sha256}` with synchronous (non-interleaving)
 *     get/set, so two different submissions loading concurrently never touch
 *     the same cache entry. Cross-flags are semester-scoped but are enqueued
 *     exactly once at `recompute_finalize`, never written per-submission here.
 *
 *     What is NOT safe, and what raising concurrency newly makes reachable, is
 *     two jobs for the SAME submission id running truly in parallel — e.g. a
 *     heuristic-config commit auto-enqueues a recompute, and someone's
 *     explicit `POST /recompute` enqueues a second one, for the same
 *     submission, close enough together to land in one fetched batch. Both
 *     would pass the idempotency check before either writes, then both
 *     DELETE-then-INSERT `flags` for that submission inside their own
 *     transaction — which does not deadlock (Postgres just blocks the second
 *     DELETE on the first transaction's row locks), but DOES leave duplicate
 *     flag rows once the second transaction's unconditional INSERT runs
 *     against rows the first transaction already committed. The batch handler
 *     below groups jobs by `submissionId` and runs jobs within one group
 *     sequentially, so distinct submissions still recompute fully in
 *     parallel (up to `RECOMPUTE_MAX_PARALLEL`) while same-submission
 *     duplicates never overlap in time.
 */

import { eq, sql, and } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { getDb } from '../db/client.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging.js';
import { recompute_jobs, submissions } from '../db/schema.js';
import { JOB_KINDS } from './pg-boss.js';
import { DEFAULT_SERVER_CONFIG, normalizeStoredConfig } from '../services/heuristics/config.js';
import {
  recomputeSubmission,
  getNonSupersededSubmissionIds,
  markSubmissionsStale,
  markSubmissionRecomputeError,
} from '../services/scoring/recompute-submission.js';
import { enqueueCrossFlagsJob } from './recompute-cross-flags.js';
import { recordRecomputeJobTerminal } from '../api/middleware/metrics.js';
import { getStorageClient } from '../services/storage/default-client.js';

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface RecomputeSemesterPayload {
  recomputeJobId: string;
  semesterId: string;
  targetConfigId: string;
}

export interface RecomputeSubmissionPayload {
  recomputeJobId: string;
  semesterId: string;
  submissionId: string;
  targetConfigId: string;
  configVersion: number;
}

export interface RecomputeFinalizePayload {
  recomputeJobId: string;
}

// ---------------------------------------------------------------------------
// registerRecomputeHandlers
// ---------------------------------------------------------------------------

/**
 * Register all three recompute job handlers on the pg-boss instance.
 *
 * Called from startWorker() after the ingest handlers are registered.
 */
export async function registerRecomputeHandlers(boss: PgBoss): Promise<void> {
  const logger = getLogger();

  // Ensure queues exist (idempotent).
  await boss.createQueue(JOB_KINDS.RECOMPUTE_SEMESTER);
  await boss.createQueue(JOB_KINDS.RECOMPUTE_SUBMISSION);
  await boss.createQueue(JOB_KINDS.RECOMPUTE_FINALIZE);
  logger.info('worker: recompute queues ensured');

  // -------------------------------------------------------------------------
  // recompute_semester handler
  //
  // 1. Read the recompute_jobs row.
  // 2. Mark it 'running'.
  // 3. Enumerate non-superseded submissions.
  // 4. Mark them all 'stale'.
  // 5. Enqueue one recompute_submission job per submission (retryLimit:3).
  // 6. Update recompute_jobs.progress_total with the final count.
  // -------------------------------------------------------------------------
  await boss.work<RecomputeSemesterPayload>(
    JOB_KINDS.RECOMPUTE_SEMESTER,
    { batchSize: 1 },
    async (jobs) => {
      const job = jobs[0]!;
      const { recomputeJobId, semesterId, targetConfigId } = job.data;
      const db = getDb();
      logger.info({ recomputeJobId, semesterId }, 'recompute_semester: started');

      try {
        // Mark the job as running.
        // The WHERE clause filters on status='queued' so this is a no-op on
        // pg-boss retry (status is already 'running' from the prior attempt).
        await db
          .update(recompute_jobs)
          .set({ status: 'running', started_at: new Date() })
          .where(and(eq(recompute_jobs.id, recomputeJobId), eq(recompute_jobs.status, 'queued')));

        // Get config version from heuristic_configs table.
        const hcRows = await db.execute(sql`
          SELECT version
          FROM heuristic_configs
          WHERE id = ${targetConfigId}
          LIMIT 1
        `);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: postgres.js raw result
        const hcRowsArr = hcRows as any as Array<{ version: number }>;
        if (hcRowsArr.length === 0) {
          // target_config_id references a config that no longer exists — DATA ERROR.
          // Throw so pg-boss marks this job failed and surfaces it in monitoring.
          throw new Error(
            `recompute_semester: target_config_id ${targetConfigId} not found in heuristic_configs`,
          );
        }
        const configVersion = hcRowsArr[0]!.version;

        // Enumerate non-superseded submissions.
        const submissionIds = await getNonSupersededSubmissionIds(db, semesterId);

        // Mark them all stale.
        await markSubmissionsStale(db, submissionIds);

        // Update progress_total in the job row.
        await db
          .update(recompute_jobs)
          .set({ progress_total: submissionIds.length })
          .where(eq(recompute_jobs.id, recomputeJobId));

        // Enqueue one recompute_submission job per submission.
        for (const submissionId of submissionIds) {
          await boss.send(
            JOB_KINDS.RECOMPUTE_SUBMISSION,
            {
              recomputeJobId,
              semesterId,
              submissionId,
              targetConfigId,
              configVersion,
            } satisfies RecomputeSubmissionPayload,
            {
              retryLimit: 3, // PRD §12.3
            },
          );
        }

        // If no submissions, enqueue finalize immediately.
        if (submissionIds.length === 0) {
          await boss.send(
            JOB_KINDS.RECOMPUTE_FINALIZE,
            { recomputeJobId } satisfies RecomputeFinalizePayload,
            {
              singletonKey: recomputeJobId,
              retryLimit: 5,
            },
          );
        }

        logger.info(
          { recomputeJobId, submissionCount: submissionIds.length },
          'recompute_semester: enqueued all submissions',
        );
      } catch (err) {
        logger.error({ recomputeJobId, err }, 'recompute_semester: error');

        const cause = err instanceof Error ? err.message : String(err);
        await db
          .update(recompute_jobs)
          .set({
            status: 'failed',
            completed_at: new Date(),
            summary: { error: cause },
          })
          .where(eq(recompute_jobs.id, recomputeJobId))
          .catch(() => {
            /* best-effort */
          });

        throw err; // Let pg-boss retry.
      }
    },
  );

  // -------------------------------------------------------------------------
  // recompute_submission handler (includeMetadata: true for retryCount access)
  //
  // batchSize is RECOMPUTE_MAX_PARALLEL: pg-boss hands the handler up to that
  // many jobs per poll, grouped below by submissionId and drained with
  // Promise.all — distinct submissions run fully concurrently; jobs that
  // share a submissionId (duplicate enqueues) run one after another. See the
  // module docstring "recompute_submission concurrency" for why both the
  // grouping and the per-job boss.fail() (instead of a rethrow) are required
  // once batchSize > 1.
  //
  // Per job:
  //   1. Idempotency check: if submission already recomputed for this configVersion,
  //      skip all work. Still counts toward progress_done UNLESS this is a retry of
  //      this same job (which already counted) — see the branch for why.
  //   2. Read the target config.
  //   3. Call recomputeSubmission (writes flags + score).
  //   4. Increment progress_done.
  //   5. On error: boss.fail() this job alone so pg-boss can retry it
  //      (I-Spec-3 PRD §12.3 retryLimit:3) without touching its batch-mates.
  //      Only on final retry (retryCount >= retryLimit): mark terminal failure +
  //      increment progress_failed, then check if finalize should be enqueued.
  // -------------------------------------------------------------------------
  async function processRecomputeSubmissionJob(
    job: PgBoss.JobWithMetadata<RecomputeSubmissionPayload>,
  ): Promise<void> {
    const { recomputeJobId, semesterId, submissionId, targetConfigId, configVersion } = job.data;
    const db = getDb();
    const isLastAttempt = job.retryCount >= job.retryLimit;
    logger.info(
      { recomputeJobId, submissionId, retryCount: job.retryCount, retryLimit: job.retryLimit },
      'recompute_submission: started',
    );

    // -----------------------------------------------------------------------
    // Idempotency guard (I-Quality-1):
    //
    // If this submission has already been successfully recomputed for the target
    // config version, skip all work and return. This handles the case where a
    // prior attempt succeeded (wrote flags + set recompute_status='fresh') but
    // pg-boss retried the job before the ack propagated.
    // -----------------------------------------------------------------------
    const [subCheck] = await db
      .select({
        recompute_status: submissions.recompute_status,
        heuristic_config_version: submissions.heuristic_config_version,
      })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .limit(1);

    if (
      subCheck?.recompute_status === 'fresh' &&
      subCheck?.heuristic_config_version === configVersion
    ) {
      logger.info(
        { recomputeJobId, submissionId, configVersion, retryCount: job.retryCount },
        'recompute_submission: already fresh for this config version — skipping (idempotent)',
      );

      // Two different situations reach this branch, and they need opposite
      // handling (I-Quality-1 originally covered only the first):
      //
      //  a) retryCount > 0 — pg-boss retried THIS job after an attempt that
      //     already succeeded and already incremented progress_done. Counting
      //     again would overshoot progress_total. Return without incrementing.
      //
      //  b) retryCount === 0 — a DIFFERENT recompute run already made this
      //     submission fresh (e.g. committing a heuristic config auto-enqueues
      //     a recompute, and an explicit POST .../recompute then enqueues a
      //     second one). There is no work to do, but this job's unit of work
      //     IS complete. Returning without incrementing left progress_done at
      //     0 forever, so recompute_finalize was never dispatched and the job
      //     sat in 'running' permanently despite every child having finished.
      if (job.retryCount === 0) {
        await db.execute(sql`
          UPDATE recompute_jobs
          SET progress_done = progress_done + 1
          WHERE id = ${recomputeJobId}
        `);
        await maybeEnqueueRecomputeFinalize(boss, db, recomputeJobId);
      }
      return;
    }

    try {
      // Look up the config object.
      const hcRows = await db.execute(sql`
        SELECT config
        FROM heuristic_configs
        WHERE id = ${targetConfigId}
        LIMIT 1
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: postgres.js raw result
      const hcRowsArr = hcRows as any as Array<{ config: unknown }>;
      // This is a raw read by target_config_id, so it bypasses
      // getActiveConfig's normalization — a recompute can target a historical
      // (is_active=false) row, which is exactly the kind of row most likely to
      // predate a flag id. Normalize here too so the worker sees a complete
      // per_flag map regardless of which row it was pointed at.
      const config = normalizeStoredConfig(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb cast
        (hcRowsArr[0]?.config as any) ?? DEFAULT_SERVER_CONFIG,
      );

      // Run the per-submission recompute. Reads the stored bundle blob.
      const storage = getStorageClient();
      await recomputeSubmission(db, storage, submissionId, semesterId, config, configVersion);

      logger.info({ recomputeJobId, submissionId }, 'recompute_submission: succeeded');
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      logger.error(
        { recomputeJobId, submissionId, retryCount: job.retryCount, err },
        'recompute_submission: failed',
      );

      if (isLastAttempt) {
        // Final attempt exhausted: mark terminal failure in our tracking tables.
        // This runs before boss.fail() so the DB state is consistent even if
        // the handler is killed mid-flight (pg-boss will still move the job to
        // 'failed').
        await markSubmissionRecomputeError(db, submissionId).catch(() => {
          /* best-effort */
        });

        // Record error in the job's summary JSONB (append-style via SQL jsonb concat).
        await db.execute(sql`
          UPDATE recompute_jobs
          SET
            progress_failed = progress_failed + 1,
            summary = summary || ${sql`jsonb_build_object(${submissionId}, ${cause})`}
          WHERE id = ${recomputeJobId}
        `);

        // Check if all work is complete now (including this terminal failure).
        await maybeEnqueueRecomputeFinalize(boss, db, recomputeJobId);
      }

      // Fail THIS job only — never rethrow here. With batchSize > 1, throwing
      // out of the batch handler fails every job pg-boss fetched into this
      // invocation, not just this one (see the module docstring). boss.fail()
      // lets pg-boss's own retryLimit machinery still apply per-submission.
      await boss
        .fail(JOB_KINDS.RECOMPUTE_SUBMISSION, job.id, { message: cause })
        .catch((failErr) => {
          logger.error(
            { recomputeJobId, submissionId, failErr },
            'recompute_submission: boss.fail() itself failed (best-effort)',
          );
        });
      return;
    }

    // Increment progress_done on success.
    await db.execute(sql`
      UPDATE recompute_jobs
      SET progress_done = progress_done + 1
      WHERE id = ${recomputeJobId}
    `);

    // Check if all work is complete.
    await maybeEnqueueRecomputeFinalize(boss, db, recomputeJobId);
  }

  const recomputeConcurrency = Math.max(1, getConfig().RECOMPUTE_MAX_PARALLEL);

  await boss.work<RecomputeSubmissionPayload>(
    JOB_KINDS.RECOMPUTE_SUBMISSION,
    { batchSize: recomputeConcurrency, includeMetadata: true },
    async (jobs) => {
      // Group by submissionId (see module docstring): distinct submissions
      // drain concurrently; jobs sharing a submissionId run sequentially
      // within their group so their transactions never overlap.
      const bySubmission = new Map<string, PgBoss.JobWithMetadata<RecomputeSubmissionPayload>[]>();
      for (const job of jobs) {
        const group = bySubmission.get(job.data.submissionId);
        if (group) group.push(job);
        else bySubmission.set(job.data.submissionId, [job]);
      }

      await Promise.all(
        Array.from(bySubmission.values()).map(async (group) => {
          for (const job of group) {
            await processRecomputeSubmissionJob(job);
          }
        }),
      );
    },
  );

  // -------------------------------------------------------------------------
  // recompute_finalize handler
  //
  // Computes terminal status:
  //   'succeeded' if progress_failed == 0
  //   'partial'   if 0 < progress_failed < progress_total
  //   'failed'    if progress_failed == progress_total (all failed)
  //
  // Updates recompute_jobs.status + completed_at.
  //
  // After setting terminal status, enqueues recompute_cross_flags for the
  // semester (Phase 14). singletonKey=semesterId collapses duplicate enqueues.
  // -------------------------------------------------------------------------
  await boss.work<RecomputeFinalizePayload>(
    JOB_KINDS.RECOMPUTE_FINALIZE,
    { batchSize: 1 },
    async (jobs) => {
      const job = jobs[0]!;
      const { recomputeJobId } = job.data;
      const db = getDb();
      logger.info({ recomputeJobId }, 'recompute_finalize: started');

      try {
        const jobRows = await db
          .select({
            semester_id: recompute_jobs.semester_id,
            progress_total: recompute_jobs.progress_total,
            progress_done: recompute_jobs.progress_done,
            progress_failed: recompute_jobs.progress_failed,
          })
          .from(recompute_jobs)
          .where(eq(recompute_jobs.id, recomputeJobId))
          .limit(1);

        const jobRow = jobRows[0];
        if (!jobRow) {
          logger.warn({ recomputeJobId }, 'recompute_finalize: job row not found');
          return;
        }

        const { semester_id: semesterId, progress_total, progress_done, progress_failed } = jobRow;

        let terminalStatus: 'succeeded' | 'partial' | 'failed';
        if (progress_failed === 0) {
          terminalStatus = 'succeeded';
        } else if (progress_failed > 0 && progress_done > 0) {
          terminalStatus = 'partial';
        } else {
          // All failed (progress_done === 0) or total was 0 (no submissions).
          terminalStatus = progress_total === 0 ? 'succeeded' : 'failed';
        }

        await db
          .update(recompute_jobs)
          .set({
            status: terminalStatus,
            completed_at: new Date(),
          })
          .where(eq(recompute_jobs.id, recomputeJobId));

        // Record the terminal status to metrics.
        recordRecomputeJobTerminal(terminalStatus);

        logger.info(
          { recomputeJobId, terminalStatus, progress_done, progress_failed },
          'recompute_finalize: completed',
        );

        // Enqueue cross-flag recompute for the semester (Phase 14).
        // singletonKey=semesterId collapses concurrent enqueues to one pending job.
        // Fire-and-forget: cross-flag failure doesn't affect the recompute job's
        // terminal status (they are independent concerns).
        await enqueueCrossFlagsJob(boss, semesterId).catch((err: unknown) => {
          logger.warn(
            { recomputeJobId, semesterId, err },
            'recompute_finalize: failed to enqueue recompute_cross_flags (non-fatal)',
          );
        });
      } catch (err) {
        logger.error({ recomputeJobId, err }, 'recompute_finalize: error');
        throw err; // Let pg-boss retry (retryLimit: 5).
      }
    },
  );

  logger.info('worker: recompute handlers registered');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * After a recompute_submission job completes (success or failure), check
 * whether progress_done + progress_failed == progress_total.
 *
 * If so, enqueue one recompute_finalize with singletonKey = recomputeJobId.
 * pg-boss deduplicates concurrent sends (same pattern as maybeEnqueueFinalize
 * for ingest).
 */
async function maybeEnqueueRecomputeFinalize(
  boss: PgBoss,
  db: ReturnType<typeof getDb>,
  recomputeJobId: string,
): Promise<void> {
  const jobRows = await db
    .select({
      progress_total: recompute_jobs.progress_total,
      progress_done: recompute_jobs.progress_done,
      progress_failed: recompute_jobs.progress_failed,
    })
    .from(recompute_jobs)
    .where(eq(recompute_jobs.id, recomputeJobId))
    .limit(1);

  const jobRow = jobRows[0];
  if (!jobRow) return;

  const { progress_total, progress_done, progress_failed } = jobRow;

  if (progress_done + progress_failed >= progress_total && progress_total > 0) {
    await boss.send(
      JOB_KINDS.RECOMPUTE_FINALIZE,
      { recomputeJobId } satisfies RecomputeFinalizePayload,
      {
        singletonKey: recomputeJobId,
        retryLimit: 5, // PRD §12.3
      },
    );
    getLogger().info({ recomputeJobId }, 'recompute_finalize: enqueued');
  }
}
