/**
 * attachUnmatchedFile — Phase 15 admin-attach service.
 *
 * Re-runs the per-submission tail of ingest (createSubmission + stats +
 * validation + heuristics) for a file that was previously left in
 * status='unmatched'. There is no event-materialization step — events are not
 * persisted; the stored bundle blob is the event stream. This is the
 * server-side implementation of the unmatched tray PATCH endpoint.
 *
 * ## Concurrent-attach protection
 *
 * The entire operation runs inside a single `withTransaction` block. Step 1
 * acquires a `SELECT ... FOR UPDATE` lock on the ingest_files row inside that
 * transaction. Two concurrent PATCH requests for the same file will serialize
 * at the DB lock: the second request blocks until the first transaction commits,
 * then re-reads status='matched' (or 'discarded') and throws
 * INGEST_FILE_NOT_UNMATCHED (409).
 *
 * `createSubmission` calls `db.transaction()` internally. When called inside
 * an outer `withTransaction`, Drizzle uses a savepoint (nested transaction) so
 * the inner transaction is part of the outer one — if the outer rolls back,
 * the savepoint is also rolled back.
 *
 * ## Blob handling
 *
 * The staged blob is still at `ingest-staging/{ingestJobId}/{ingestFileId}`
 * (unmatched files never had their staging blob moved). createSubmission reads
 * that key and moves it to the final location. Blob operations are not
 * transactional; if the outer transaction rolls back after the blob is moved,
 * the blob becomes an orphan for the retention sweep — the same best-effort
 * arrangement as the ingest worker.
 *
 * ## Warning behavior
 *
 * If the bundle manifest's assignment_id disagrees with the admin-supplied
 * assignmentIdStr, a non-blocking warning is emitted. The admin must confirm
 * in the UI before calling this endpoint; the API records the disagreement but
 * does NOT abort the operation.
 *
 * ## Cross-flag recompute
 *
 * After the transaction commits, enqueues a recompute_cross_flags job for the
 * semester (same as ingest_finalize does). Phase 14 only hooks
 * ingest_finalize + recompute_finalize, not manual attach, so this must be
 * triggered explicitly here.
 */

import { eq, and, sql } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { ingest_files, ingest_jobs, roster_entries } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { withTransaction } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { ingestStagingKey } from '../storage/keys.js';
import { parseBundlePhase } from './parse-bundle-phase.js';
import { createSubmission } from './create-submission.js';
import { computeAndStoreStats } from './stats.js';
import { runAndStoreValidation } from './validation.js';
import { configuredValidationOptions } from '../../config/root-key.js';
import { runAndStoreHeuristics } from '../heuristics/run-per-submission.js';
import { enqueueCrossFlagsJob } from '../../jobs/recompute-cross-flags.js';
import { Errors } from '../../api/v1/errors.js';
import { getLogger } from '../../logging.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttachDeps {
  db: DrizzleDb;
  storageClient: StorageClient;
  boss: PgBoss;
}

export interface AttachArgs {
  ingestFileId: string;
  semesterId: string;
  /** Admin-supplied roster_entries.id UUID for the target student. */
  studentId: string;
  /** Admin-supplied assignment string identifier. */
  assignmentIdStr: string;
}

export type AttachWarning = {
  code: 'ASSIGNMENT_ID_MISMATCH_BUNDLE';
  detail: string;
};

export interface AttachResult {
  submissionId: string;
  versionIndex: number;
  assignmentId: string;
  warnings: AttachWarning[];
}

// ---------------------------------------------------------------------------
// attachUnmatchedFile
// ---------------------------------------------------------------------------

/**
 * Manually attach a previously-unmatched file to a (student, assignment).
 *
 * Re-runs phases 5–9 of the ingest pipeline using the admin-supplied student
 * and assignment. Returns the new submission's id + version_index along with
 * any non-blocking warnings.
 *
 * Throws:
 *   - INGEST_FILE_NOT_UNMATCHED (409) — file is not in 'unmatched' state.
 *   - ROSTER_ENTRY_NOT_FOUND (404)    — studentId not in this semester's roster.
 *   - VALIDATION (400)                — bundle parse failed.
 *   - INTERNAL (500)                  — unexpected pipeline failure.
 */
export async function attachUnmatchedFile(
  deps: AttachDeps,
  args: AttachArgs,
): Promise<AttachResult> {
  const { db, storageClient, boss } = deps;
  const { ingestFileId, semesterId, studentId, assignmentIdStr } = args;

  const warnings: AttachWarning[] = [];

  // All steps run inside a single transaction so the FOR UPDATE lock in step 1
  // is held until the final ingest_files UPDATE sets status='matched'.
  // createSubmission calls db.transaction() internally — Drizzle uses a
  // savepoint for the nested call, keeping it within the outer transaction.
  const result = await withTransaction(db, async (tx) => {
    // -------------------------------------------------------------------------
    // Step 1: Lock the ingest_files row FOR UPDATE and check status.
    //
    // The FOR UPDATE lock serializes concurrent attach attempts. Two simultaneous
    // PATCH requests both enter this transaction; the second one blocks on the
    // lock, then re-reads status='matched' after the first commits and throws.
    // -------------------------------------------------------------------------
    const fileRows = await tx.execute(sql`
      SELECT
        f.id,
        f.ingest_job_id,
        f.original_filename,
        f.size_bytes,
        f.blob_sha256,
        f.status
      FROM ingest_files f
      WHERE f.id = ${ingestFileId}
      FOR UPDATE
    `);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: postgres.js raw result
    const rows = fileRows as any as Array<{
      id: string;
      ingest_job_id: string;
      original_filename: string;
      size_bytes: number;
      blob_sha256: string;
      status: string;
    }>;

    if (rows.length === 0) {
      throw Errors.notFound();
    }

    const fileRow = rows[0]!;

    if (fileRow.status !== 'unmatched') {
      throw Errors.ingestFileNotUnmatched(ingestFileId);
    }

    // -------------------------------------------------------------------------
    // Step 2: Validate studentId — must exist in roster_entries for this semester.
    // -------------------------------------------------------------------------
    const rosterRows = await tx
      .select({ id: roster_entries.id })
      .from(roster_entries)
      .where(and(eq(roster_entries.semester_id, semesterId), eq(roster_entries.id, studentId)))
      .limit(1);

    if (rosterRows.length === 0) {
      throw Errors.rosterEntryNotFound(studentId);
    }

    // -------------------------------------------------------------------------
    // Step 3: Read and parse the bundle from the staging blob.
    //
    // parseBundlePhase reads from object storage (not transactional). If parsing
    // fails we update the file to 'failed' and throw so the transaction rolls back
    // the ingest_files update as well — BUT we first need to re-acquire db (not
    // tx) for the 'failed' update since the tx is about to be rolled back.
    // Simpler: mark as 'failed' using tx, then throw — the tx rollback will undo
    // the 'failed' update. Instead, we throw here and handle the 'failed' update
    // in a non-transactional fallback outside.
    // -------------------------------------------------------------------------
    const stagingKey = ingestStagingKey(fileRow.ingest_job_id, ingestFileId);
    const parsedResult = await parseBundlePhase(
      storageClient,
      stagingKey,
      fileRow.original_filename,
    );

    if (!parsedResult.ok) {
      // Mark as failed and throw. The tx rolls back (no-op since nothing was
      // written), and we then mark 'failed' below in the outer catch block.
      // Carry parse error info through the exception.
      throw Object.assign(
        Errors.validation([{ field: 'bundle', issue: `Parse failed: ${parsedResult.cause}` }]),
        {
          parseError: {
            phase: parsedResult.phase,
            cause: parsedResult.cause,
            detail: parsedResult.detail,
          },
        },
      );
    }

    const { bundle } = parsedResult;

    // -------------------------------------------------------------------------
    // Step 4: Check for assignment_id mismatch.
    // Non-blocking warning — do NOT abort.
    // -------------------------------------------------------------------------
    const manifestAssignmentId = bundle.manifest.assignment_id;
    if (manifestAssignmentId !== assignmentIdStr) {
      warnings.push({
        code: 'ASSIGNMENT_ID_MISMATCH_BUNDLE',
        detail: `Admin supplied '${assignmentIdStr}'; bundle manifest has '${manifestAssignmentId}'`,
      });
    }

    // -------------------------------------------------------------------------
    // Step 5 + 6: createSubmission — upserts assignment, moves blob, inserts
    //             submission row. Runs as a nested transaction (savepoint) inside
    //             the outer withTransaction.
    // -------------------------------------------------------------------------
    const submissionResult = await createSubmission(
      { db: tx, storageClient },
      {
        semesterId,
        assignmentIdStr,
        studentId,
        blobSha256: fileRow.blob_sha256,
        stagingKey,
        originalFilename: fileRow.original_filename,
        ingestJobId: fileRow.ingest_job_id,
        recorderVersion: '',
        formatVersion: bundle.manifest.format_version,
      },
    );

    // -------------------------------------------------------------------------
    // Step 7: Handle superseded ingest_files rows (best-effort).
    //
    // Matches the worker.ts rationale — see V26. We keep this inside the
    // outer transaction here (unlike the worker which puts it outside) because
    // the worker has retryability via pg-boss. The attach endpoint does not.
    // If this fails the whole tx rolls back and the caller sees an error.
    // -------------------------------------------------------------------------
    if (submissionResult.supersededIds.length > 0) {
      for (const oldSubId of submissionResult.supersededIds) {
        await tx
          .update(ingest_files)
          .set({ status: 'superseded' })
          .where(eq(ingest_files.submission_id, oldSubId));
      }
    }

    // -------------------------------------------------------------------------
    // Step 8: Compute stats, run validation + heuristics, then update the
    //         ingest_files row to 'matched'. (Events are not persisted; the
    //         stored bundle blob is the event source for later reads.)
    // -------------------------------------------------------------------------
    try {
      await computeAndStoreStats(tx, submissionResult.submissionId, bundle);
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      throw Object.assign(new Error(cause), { phase: 'compute_stats' as const });
    }

    let validationReport;
    try {
      validationReport = await runAndStoreValidation(
        tx,
        submissionResult.submissionId,
        bundle,
        configuredValidationOptions(),
      );
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      throw Object.assign(new Error(cause), { phase: 'run_validation' as const });
    }

    try {
      await runAndStoreHeuristics(
        tx,
        submissionResult.submissionId,
        semesterId,
        bundle,
        validationReport,
      );
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      throw Object.assign(new Error(cause), { phase: 'run_heuristics' as const });
    }

    // Update the ingest_files row to 'matched'. This is the final write that
    // releases the FOR UPDATE lock when the transaction commits.
    await tx
      .update(ingest_files)
      .set({
        status: 'matched',
        matched_student_id: studentId,
        matched_assignment_id: submissionResult.assignmentId,
        submission_id: submissionResult.submissionId,
        resolved_at: sql`now()`,
      })
      .where(eq(ingest_files.id, ingestFileId));

    return submissionResult;
  }).catch(async (err: unknown) => {
    // If the parse step failed, mark the file as 'failed' outside the (rolled
    // back) transaction. Use the non-transactional db handle.
    const parseError = (err as Record<string, unknown>)['parseError'] as
      | { phase: string; cause: string; detail?: string }
      | undefined;
    if (parseError !== undefined) {
      await db
        .update(ingest_files)
        .set({
          status: 'failed',
          error: {
            phase: parseError.phase,
            cause: parseError.cause,
            ...(parseError.detail !== undefined && { detail: parseError.detail }),
          },
          resolved_at: sql`now()`,
        })
        .where(eq(ingest_files.id, ingestFileId))
        .catch(() => {
          /* best-effort */
        });
    }
    throw err;
  });

  // -------------------------------------------------------------------------
  // Step 9: After transaction commits — enqueue cross-flag recompute.
  // -------------------------------------------------------------------------
  await enqueueCrossFlagsJob(boss, semesterId).catch((err) => {
    // Non-fatal — cross-flag recompute is best-effort.
    getLogger().warn(
      { err, semesterId, submissionId: result.submissionId },
      'attachUnmatchedFile: cross-flags enqueue failed (non-fatal)',
    );
  });

  return {
    submissionId: result.submissionId,
    versionIndex: result.versionIndex,
    assignmentId: result.assignmentId,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the semester_id from an ingest_files row's parent ingest_job.
 *
 * Used by the route handler to verify the file belongs to the requested semester.
 */
export async function getIngestFileSemesterId(
  db: DrizzleDb,
  ingestFileId: string,
): Promise<string | null> {
  const rows = await db
    .select({ semester_id: ingest_jobs.semester_id })
    .from(ingest_files)
    .innerJoin(ingest_jobs, eq(ingest_files.ingest_job_id, ingest_jobs.id))
    .where(eq(ingest_files.id, ingestFileId))
    .limit(1);
  return rows[0]?.semester_id ?? null;
}
