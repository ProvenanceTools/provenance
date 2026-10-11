/**
 * retention-sweep — daily cron job.
 *
 * PRD §16: After a semester is archived, blob objects for its submissions are
 * retained for `blob_retention_days`. Once that window has elapsed, the blobs
 * are deleted from object storage.
 *
 * Contract:
 *   - ONLY deletes blobs from object storage (RustFS / S3).
 *   - NEVER deletes DB rows. The submissions table retains its rows forever
 *     for audit/re-analysis purposes; only the raw zip blobs are purged.
 *   - Idempotent: re-running on an already-purged submission is a no-op
 *     (deleteBlob returns a 204/404 which is treated as success).
 *   - Runs as a pg-boss scheduled job at 2am UTC daily.
 *
 * Schedule: '0 2 * * *' (2:00 UTC daily) — registered in worker.ts.
 */

import { and, isNotNull, lt, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../db/client.js';
import { submissions, semesters } from '../db/schema.js';
import { deleteBlob } from '../services/storage/blobs.js';
import type { StorageClient } from '../services/storage/client.js';
import { getLogger } from '../logging.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface RetentionSweepResult {
  purged: number;
  bytesFreed: number;
  errors: number;
}

/**
 * Run the retention sweep.
 *
 * Selects all submissions whose parent semester has been archived AND whose
 * blob retention window has elapsed, then deletes their blobs from object
 * storage.
 *
 * @param db      - Drizzle DB instance
 * @param storage - Object storage client (RustFS / S3)
 * @returns       Summary with counts of purged blobs, bytes freed, and errors.
 */
export async function runRetentionSweep(
  db: DrizzleDb,
  storage: StorageClient,
): Promise<RetentionSweepResult> {
  const logger = getLogger();

  // Find submissions whose semester's retention window has elapsed.
  //
  // Condition:
  //   semester.archived_at IS NOT NULL
  //   AND NOW() >= semester.archived_at + blob_retention_days * INTERVAL '1 day'
  //
  // Drizzle does not have a built-in "add interval" helper, so we use sql``
  // for the interval arithmetic. This is safe — all values are typed columns,
  // no user input.
  const rows = await db
    .select({
      submissionId: submissions.id,
      blobObjectKey: submissions.blob_object_key,
    })
    .from(submissions)
    .innerJoin(semesters, sql`${semesters.id} = ${submissions.semester_id}`)
    .where(
      and(
        isNotNull(semesters.archived_at),
        lt(
          sql`${semesters.archived_at} + (${semesters.blob_retention_days} * INTERVAL '1 day')`,
          sql`now()`,
        ),
      ),
    );

  logger.info({ count: rows.length }, 'retention-sweep: submissions eligible for blob purge');

  let purged = 0;
  const bytesFreed = 0; // blob size not stored in submissions table; always 0 for now
  let errors = 0;

  for (const row of rows) {
    try {
      await deleteBlob(storage, row.blobObjectKey);
      purged++;
      // deleteBlob does not return blob size; bytesFreed is approximate/0 here.
      // A future enhancement could record blob_size in the submissions table.
      logger.debug(
        { submissionId: row.submissionId, key: row.blobObjectKey },
        'retention-sweep: blob deleted',
      );
    } catch (err) {
      // Log and continue — do not abort the sweep on a single delete failure.
      // pg-boss will retry the whole job on the next schedule if we throw.
      // Individual errors are non-fatal; we log them and keep going.
      errors++;
      logger.warn(
        { submissionId: row.submissionId, key: row.blobObjectKey, err },
        'retention-sweep: failed to delete blob (non-fatal)',
      );
    }
  }

  logger.info(
    { purged, bytesFreed, errors, total: rows.length },
    'retention-sweep: sweep complete',
  );

  return { purged, bytesFreed, errors };
}

// ---------------------------------------------------------------------------
// pg-boss handler factory
// ---------------------------------------------------------------------------

/**
 * Create the pg-boss handler for the `retention_sweep` job.
 *
 * Usage:
 *   await boss.work('retention_sweep', { batchSize: 1 }, createRetentionSweepHandler(db, storage));
 */
export function createRetentionSweepHandler(
  db: DrizzleDb,
  storage: StorageClient,
): () => Promise<void> {
  return async () => {
    await runRetentionSweep(db, storage);
  };
}
