/**
 * Phase 5 of the per-file ingest pipeline: create submission (PRD §9.3).
 *
 * Responsibilities:
 *   1. Upsert the `assignments` row for (semester, assignment_id_str).
 *   2. Allocate `version_index` = max existing + 1 for this (semester,
 *      assignment, version_owner_key) LINEAGE, using a row lock (`FOR UPDATE`)
 *      to prevent races when multiple workers process concurrent uploads for
 *      the same lineage-assignment.
 *   3. Move the blob from `ingest-staging/{jobId}/{fileId}` to
 *      `semesters/{semesterId}/submissions/{submissionId}/bundle.zip`.
 *   4. Insert the `submissions` row.
 *   5. Update `superseded_by_submission_id` on all older versions for this
 *      (semester, assignment, version_owner_key) lineage to point to the new row.
 *
 * The blob move is: putBlob(final key) then deleteBlob(staging key).
 * If deleteBlob fails, the staging key becomes an orphan for the retention
 * sweep — the submission row already exists so the pipeline is not broken.
 *
 * PRD §9.4: version_index allocation uses `FOR UPDATE` on existing rows
 * for this (semester_id, assignment_id, version_owner_key) cohort to prevent
 * concurrent allocation of the same index. It was keyed on `student_id` until
 * migration 0029 — see `version-owner-key.ts` for why a nullable column cannot
 * carry a version sequence.
 */

import { sql, and, eq, inArray } from 'drizzle-orm';
import { assignments, submissions } from '../../db/schema.js';
import { versionOwnerKey } from './version-owner-key.js';
import type { DrizzleDb } from '../../db/client.js';
import { putBlob, deleteBlob, getBlob } from '../storage/blobs.js';
import { bundleKey } from '../storage/keys.js';
import { stripBundleSourceFiles } from './strip-bundle.js';
import type { StorageClient } from '../storage/client.js';
import { Errors } from '../../api/v1/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateSubmissionDeps {
  db: DrizzleDb;
  storageClient: StorageClient;
}

export interface CreateSubmissionArgs {
  semesterId: string;
  assignmentIdStr: string;
  /**
   * The SUBMITTER of record, or `null` for a submission with no single owning
   * roster entry. Nullable since migration 0029 (D9) — but note it is NOT what
   * the version sequence is keyed on. See {@link versionOwnerKey}.
   */
  studentId: string | null;
  /**
   * Stable lineage identifier for a group with no submitter. Required exactly
   * when `studentId` is null; ignored otherwise.
   */
  groupKey?: string | null;
  blobSha256: string;
  stagingKey: string;
  originalFilename: string;
  ingestJobId: string;
  /** Metadata parsed from the bundle manifest (recorder + format version). */
  recorderVersion?: string;
  formatVersion?: string;
}

export interface CreateSubmissionResult {
  submissionId: string;
  /** UUID of the assignments row (for writing matched_assignment_id on ingest_files). */
  assignmentId: string;
  versionIndex: number;
  finalBlobKey: string;
  /** IDs of submissions that were superseded by this one. */
  supersededIds: string[];
}

/**
 * What phase 5 did.
 *
 * `'duplicate'` exists because dedup (phase 2) and this function are NOT in one
 * transaction, and the ingest worker drains its pg-boss batch with
 * `Promise.all` — so up to INGEST_CONCURRENCY files run CONCURRENTLY. Two
 * co-submitters of one group export carry byte-identical bundles, so both can
 * clear phase 2 before either commits its row, and the phase-2 check alone
 * would let both create one. That produced exactly the fan-out D9 removed,
 * silently, and only under concurrency — the serial case looked correct.
 *
 * The re-check below runs INSIDE this transaction, under an advisory lock on
 * the same (semester, blob) key, so the second writer blocks, then sees the
 * first writer's row and reports it instead of duplicating the artifact.
 */
export type CreateSubmissionOutcome =
  | ({ kind: 'created' } & CreateSubmissionResult)
  | {
      kind: 'duplicate';
      /** The submission whose bytes these are. Attach the submitter to it. */
      existingSubmissionId: string;
    };

// ---------------------------------------------------------------------------
// createSubmission
// ---------------------------------------------------------------------------

/**
 * Runs phase 5 of the ingest pipeline for a single file.
 *
 * Must be called inside a database transaction for correctness: the
 * version_index lock (`FOR UPDATE`) and the submissions insert must be atomic.
 *
 * Blob operations (getBlob, putBlob, deleteBlob) happen between the lock
 * acquisition and the insert. If a blob op fails, the transaction is rolled
 * back (no DB row created) and the staging blob is left as an orphan.
 */
export async function createSubmission(
  deps: CreateSubmissionDeps,
  args: CreateSubmissionArgs,
): Promise<CreateSubmissionOutcome> {
  const { db, storageClient } = deps;
  const {
    semesterId,
    assignmentIdStr,
    studentId,
    groupKey = null,
    blobSha256,
    stagingKey,
    originalFilename,
    ingestJobId,
    recorderVersion = '',
    formatVersion = '',
  } = args;

  return db.transaction(async (tx) => {
    // -----------------------------------------------------------------------
    // Step 0: Serialise every writer of THESE BYTES, then re-check dedup.
    //
    // `pg_advisory_xact_lock` is held until this transaction commits or rolls
    // back, and it is keyed on (semester, blob) — the same key dedup uses — so
    // it serialises only the writers that genuinely collide on one artifact and
    // leaves the rest of a batch fully parallel, exactly as the version lock
    // does for a lineage.
    //
    // Why this is needed at all: phase 2's dedup and this function are separate
    // transactions, and the worker runs up to INGEST_CONCURRENCY files
    // CONCURRENTLY (`Promise.all` over the pg-boss batch). Two co-submitters of
    // one group export carry byte-identical bundles, so both cleared phase 2
    // before either inserted, and both created a submission — reinstating the
    // very fan-out D9 removed, with no error, and only under concurrency.
    //
    // `hashtextextended` gives the bigint the lock API wants. A hash collision
    // between two unrelated blobs is harmless: it costs one needless wait, and
    // the re-check below is keyed on the real values, so it can never merge two
    // different artifacts.
    // -----------------------------------------------------------------------
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${semesterId}:${blobSha256}`}, 0))`,
    );

    const existingForBlob = await tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(eq(submissions.semester_id, semesterId), eq(submissions.blob_sha256, blobSha256)))
      .limit(1);

    if (existingForBlob.length > 0) {
      // Someone else committed these exact bytes while we were waiting. The
      // artifact is theirs; the caller attaches this submitter to it. Note the
      // staging blob is deliberately left alone here — we have not moved it,
      // and the retention sweep collects it.
      return { kind: 'duplicate' as const, existingSubmissionId: existingForBlob[0]!.id };
    }

    // -----------------------------------------------------------------------
    // Step 1: Upsert assignment row.
    //
    // Plan §Phase 9: INSERT … ON CONFLICT DO NOTHING RETURNING id.
    // DO NOTHING avoids an unnecessary write-lock on the conflicting row
    // under concurrent load. If RETURNING is empty (conflict), fall back
    // to a SELECT to fetch the existing id.
    // -----------------------------------------------------------------------
    const insertedAssignment = await tx
      .insert(assignments)
      .values({
        semester_id: semesterId,
        assignment_id_str: assignmentIdStr,
        label: assignmentIdStr,
      })
      .onConflictDoNothing({
        target: [assignments.semester_id, assignments.assignment_id_str],
      })
      .returning({ id: assignments.id });

    let assignmentId: string;
    if (insertedAssignment.length > 0) {
      assignmentId = insertedAssignment[0]!.id;
    } else {
      // Conflict — row already exists; fetch it.
      const existingAssignment = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(
          and(
            eq(assignments.semester_id, semesterId),
            eq(assignments.assignment_id_str, assignmentIdStr),
          ),
        )
        .limit(1);

      if (existingAssignment.length === 0) {
        throw Errors.internal(undefined, 'createSubmission: assignment row missing after conflict');
      }
      assignmentId = existingAssignment[0]!.id;
    }

    // -----------------------------------------------------------------------
    // Step 2: Lock this LINEAGE's existing submissions and compute max version.
    //
    // PRD §9.4: use FOR UPDATE on the existing rows to prevent concurrent
    // workers from allocating the same version_index.
    //
    // Migration 0029: scoped by `version_owner_key`, NOT `student_id`. Since
    // D9 made `student_id` nullable, `AND student_id = ${studentId}` would bind
    // to `= NULL` for a group submission — never true — so this SELECT would
    // return ZERO rows, silently. maxVersion would stay 0, every resubmission
    // of that group would be allocated version_index 1 forever, and
    // `supersededIds` would always be empty, so the supersede chain would never
    // form. `version_owner_key` is NOT NULL, so the predicate is total.
    //
    // Drizzle does not have a typed .forUpdate() on select, so we use
    // db.execute(sql`...`) to issue the raw FOR UPDATE query.
    // -----------------------------------------------------------------------
    const ownerKey = versionOwnerKey({ studentId, groupKey });

    const lockResult = await tx.execute(sql`
      SELECT id, version_index
      FROM submissions
      WHERE semester_id = ${semesterId}
        AND assignment_id = ${assignmentId}
        AND version_owner_key = ${ownerKey}
      FOR UPDATE
    `);

    // `lockResult` is an array of rows (postgres.js returns Row[]).
    // Extract max version_index; default to 0 so first submission gets index 1.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: postgres.js raw result
    const existingRows = lockResult as any as Array<{ id: string; version_index: number }>;
    const maxVersion = existingRows.reduce((m, r) => Math.max(m, r.version_index), 0);
    const versionIndex = maxVersion + 1;

    // -----------------------------------------------------------------------
    // Step 3: Allocate the new submission id so we can build the final blob key.
    // -----------------------------------------------------------------------
    const submissionId = crypto.randomUUID();
    const finalBlobKey = bundleKey(semesterId, submissionId);

    // -----------------------------------------------------------------------
    // Step 4: Move blob — read from staging, write to final key.
    //
    // We do this inside the transaction so if it fails the DB row is never
    // inserted. The staging blob is left as an orphan for the retention sweep
    // if deleteBlob fails (non-fatal).
    // -----------------------------------------------------------------------
    let blobStream: ReadableStream<Uint8Array>;
    try {
      blobStream = await getBlob(storageClient, stagingKey);
    } catch (err) {
      throw Errors.internal(
        undefined,
        `createSubmission: getBlob(stagingKey) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Buffer the stream before the PUT so we don't hold a streaming connection
    // open during the DB insert.
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = blobStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.byteLength;
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // Strip the student's source files before storing — the final blob is
    // provenance-only (manifest + signature + .slog logs). All source-dependent
    // computation (validation check 8 in particular) has already run against the
    // in-memory full bundle in earlier phases; the stored blob is only ever
    // re-parsed for its event stream. The signed manifest is copied verbatim, so
    // the stored bundle stays signature/chain verifiable.
    let strippedBytes: Uint8Array;
    try {
      strippedBytes = await stripBundleSourceFiles(combined);
    } catch (err) {
      throw Errors.internal(
        undefined,
        `createSubmission: stripBundleSourceFiles failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await putBlob(storageClient, finalBlobKey, strippedBytes);
    } catch (err) {
      throw Errors.internal(
        undefined,
        `createSubmission: putBlob(finalKey) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // -----------------------------------------------------------------------
    // Step 5: Insert the submissions row.
    // -----------------------------------------------------------------------
    await tx.insert(submissions).values({
      id: submissionId,
      semester_id: semesterId,
      assignment_id: assignmentId,
      student_id: studentId,
      // `version_owner_key` is GENERATED — Postgres derives it from
      // (student_id, group_key) and REFUSES an explicit value. We write only
      // the input.
      group_key: studentId === null ? groupKey : null,
      blob_object_key: finalBlobKey,
      // sha256 of the ORIGINAL (full, pre-strip) bundle. This is the dedup key
      // (dedup.ts matches on semester_id + blob_sha256) and the stable identity
      // of what the student submitted — NOT the sha of the stored (stripped)
      // object at finalBlobKey. loadSubmissionIndex only uses it as a cache key.
      blob_sha256: blobSha256,
      recorder_version: recorderVersion,
      format_version: formatVersion,
      source_filename: originalFilename,
      ingest_job_id: ingestJobId,
      version_index: versionIndex,
    });

    // -----------------------------------------------------------------------
    // Step 6: Update superseded_by_submission_id on all prior versions.
    //
    // Drizzle's schema omits the self-referential FK for superseded_by, so we
    // use raw SQL here (per CLAUDE.md: use db.execute(sql`...`) for omitted FKs).
    // -----------------------------------------------------------------------
    const supersededIds: string[] = existingRows.map((r) => r.id);

    if (supersededIds.length > 0) {
      // Use Drizzle's typed update + inArray() for full parameterization.
      // submissions.superseded_by_submission_id is omitted from the Drizzle
      // schema (self-referential FK not expressible at declaration time), so we
      // use sql`` only for the SET clause value while letting Drizzle build the
      // WHERE clause via inArray — which emits a safe parameterized IN list.
      await tx
        .update(submissions)
        .set({ superseded_by_submission_id: submissionId })
        .where(inArray(submissions.id, supersededIds));
    }

    // -----------------------------------------------------------------------
    // Step 7: Delete the staging blob (best-effort; non-fatal on failure).
    // -----------------------------------------------------------------------
    try {
      await deleteBlob(storageClient, stagingKey);
    } catch {
      // Non-fatal — the submission row is already committed (or will be on
      // transaction commit). The staging blob becomes an orphan for the
      // retention sweep. Logging intentionally omitted here so this function
      // remains dependency-free from the logging singleton (which requires
      // config). The worker layer logs this if needed.
    }

    return {
      kind: 'created' as const,
      submissionId,
      assignmentId,
      versionIndex,
      finalBlobKey,
      supersededIds,
    };
  });
}
