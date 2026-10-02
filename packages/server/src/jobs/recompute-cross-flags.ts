/**
 * recompute_cross_flags pg-boss handler — Phase 14.
 *
 * Registered in worker.ts alongside the ingest and recompute handlers.
 *
 * ## Payload
 *
 *   { semesterId: string }
 *
 * ## Retry policy (PRD §12.3)
 *
 *   retryLimit: 5 (same class as recompute_finalize — cheap, must complete)
 *   Sent with singletonKey: semesterId so concurrent enqueues (from multiple
 *   ingest jobs finishing in the same semester) collapse to one pending job.
 *   Sent with an explicit expiry (CROSS_FLAGS_EXPIRE_IN_SECONDS) — see there
 *   for why pg-boss's 15-minute default turned one slow pass into many.
 *
 * ## Advisory lock strategy (V32 — fixed review I1)
 *
 * pg_advisory_xact_lock is acquired INSIDE the transaction in
 * runAndStoreCrossHeuristics. Transaction-scoped locks are held on the
 * transaction's connection for the lifetime of the tx and auto-released at
 * COMMIT/ROLLBACK — no pool-connection mismatch risk.
 *
 * ## Error handling
 *
 *   On error: log + re-throw so pg-boss retries (up to retryLimit: 5).
 */

import type PgBoss from 'pg-boss';
import { getDb } from '../db/client.js';
import { getLogger } from '../logging.js';
import { JOB_KINDS } from './pg-boss.js';
import { runAndStoreCrossHeuristics } from '../services/heuristics/run-cross.js';
import { getStorageClient } from '../services/storage/default-client.js';
import { withFailureNotification } from '../notify/job-failure.js';
import { getNotifier } from '../notify/notifier.js';

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

export interface RecomputeCrossFlagsPayload {
  semesterId: string;
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * How long one attempt may run before pg-boss reclaims it.
 *
 * pg-boss's default is 15 minutes, and expiry does NOT stop the running
 * handler — it marks the attempt failed and hands the job to another worker
 * while the first is still going. On a ~7.7k-submission semester (2026-09) the
 * pass ran past 15 minutes, so every expiry started a second full copy
 * alongside the first, both near the heap limit, and the workers crash-looped.
 *
 * The limit must therefore sit comfortably ABOVE the pass's real runtime.
 * Loading every bundle in a semester serially, plus the paste-sharing
 * comparison (quadratic in paste count), is not yet measured at that scale —
 * the per-group log line in run-cross.ts exists to measure it. Four hours is
 * deliberately generous: an attempt that genuinely hangs is reclaimed late,
 * which costs only time, whereas a limit that is too short duplicates the work.
 * pg-boss rejects anything at or above 24 hours.
 */
export const CROSS_FLAGS_EXPIRE_IN_SECONDS = 4 * 60 * 60;

// ---------------------------------------------------------------------------
// Public: enqueue helper
// ---------------------------------------------------------------------------

/**
 * Enqueue a recompute_cross_flags job for a semester.
 *
 * Uses singletonKey=semesterId so multiple concurrent enqueues collapse to one.
 * Safe to call from both ingest_finalize and recompute_finalize handlers.
 *
 * @param boss       - The pg-boss instance.
 * @param semesterId - UUID of the semester to enqueue for.
 */
export async function enqueueCrossFlagsJob(boss: PgBoss, semesterId: string): Promise<void> {
  await boss.send(
    JOB_KINDS.RECOMPUTE_CROSS_FLAGS,
    { semesterId } satisfies RecomputeCrossFlagsPayload,
    {
      singletonKey: semesterId,
      retryLimit: 5, // PRD §12.3 — same class as recompute_finalize
      expireInSeconds: CROSS_FLAGS_EXPIRE_IN_SECONDS,
    },
  );
  getLogger().info({ semesterId }, 'recompute_cross_flags: enqueued');
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register the recompute_cross_flags handler on the given pg-boss instance.
 *
 * Called from startWorker() in worker.ts after the other handlers are registered.
 */
export async function registerCrossFlagsHandler(boss: PgBoss): Promise<void> {
  const logger = getLogger();

  // policy: 'short' enforces singletonKey at insert time (unique index on
  // (name, singleton_key) while state = 'created'), so duplicate enqueues
  // for the same semester collapse to one pending job.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg-boss Queue type requires `name` but createQueue takes it as first arg; passing policy-only options is valid per the JS implementation.
  await boss.createQueue(JOB_KINDS.RECOMPUTE_CROSS_FLAGS, { policy: 'short' } as any);
  logger.info('worker: recompute_cross_flags queue ensured');

  await boss.work<RecomputeCrossFlagsPayload>(
    JOB_KINDS.RECOMPUTE_CROSS_FLAGS,
    { batchSize: 1, includeMetadata: true },
    async (jobs) => {
      await withFailureNotification(
        { kind: 'job.dead_letter', severity: 'warn', notifier: getNotifier() },
        async (job: PgBoss.JobWithMetadata<RecomputeCrossFlagsPayload>): Promise<void> => {
          const { semesterId } = job.data;
          const db = getDb();
          logger.info({ semesterId }, 'recompute_cross_flags: started');

          try {
            // Advisory lock is acquired inside runAndStoreCrossHeuristics as
            // pg_advisory_xact_lock (transaction-scoped). No explicit lock/unlock here.
            const storage = getStorageClient();
            const result = await runAndStoreCrossHeuristics(db, storage, semesterId, (progress) =>
              logger.info(
                { semesterId, ...progress },
                'recompute_cross_flags: assignment group done',
              ),
            );

            logger.info(
              {
                semesterId,
                flag_count: result.flag_count,
                participant_count: result.participant_count,
              },
              'recompute_cross_flags: completed',
            );
          } catch (err) {
            logger.error({ semesterId, err }, 'recompute_cross_flags: error');
            throw err; // Let pg-boss retry (retryLimit: 5).
          }
        },
      )(jobs[0]!);
    },
  );

  logger.info('worker: recompute_cross_flags handler registered');
}
