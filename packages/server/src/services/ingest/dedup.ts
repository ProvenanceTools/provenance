/**
 * Phase 2 of the per-file ingest pipeline: deduplication (PRD §9.3).
 *
 * A file is a duplicate when an existing `submissions` row for the same
 * (semester_id, blob_sha256) already exists. If found the caller should
 * mark `ingest_files.status='duplicate'`, link `submission_id`, and skip
 * the remaining pipeline phases.
 *
 * This function is a pure DB read — no side effects, no blob I/O.
 */

import { eq, and } from 'drizzle-orm';
import { submissions, submission_contributors } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { rosterContributorKey } from '../contributors/store-contributors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DedupResult =
  | {
      /** File is a duplicate of an existing submission. */
      isDuplicate: true;
      /** UUID of the existing submission row. */
      existingSubmissionId: string;
    }
  | {
      /** No match found — proceed with the pipeline. */
      isDuplicate: false;
    };

// ---------------------------------------------------------------------------
// dedupFile
// ---------------------------------------------------------------------------

/**
 * Check whether a blob with the given `sha256` has already been ingested into
 * the given semester.
 *
 * Looks up `submissions` by `(semester_id, blob_sha256)`.  If a match exists,
 * returns `{ isDuplicate: true, existingSubmissionId }`. Otherwise returns
 * `{ isDuplicate: false }`.
 *
 * The query uses `submissions_blob_sha_idx` (defined on `(semester_id, blob_sha256)`
 * in migration 0006) for O(log n) lookup — no sequential scan.
 *
 * Superseded submissions are still detected as duplicates: re-uploading an
 * exact same blob as a student's earlier version should not produce a new
 * submission — it is a true duplicate regardless of whether that prior version
 * was later superseded.
 *
 * ## The fan-out this used to implement, and what replaced it (D9)
 *
 * Until migration 0029 this function took a `studentId` and narrowed the dedup
 * to `(semester_id, student_id, blob_sha256)`. That existed for the Gradescope
 * export path: a group submission is uploaded once per co-submitter with
 * IDENTICAL bytes, and blob-only dedup would have collapsed the second
 * submitter into a "duplicate" — silently erasing them from the system, which
 * is scenario S20 in the collaboration census.
 *
 * The workaround's cost was the fan-out itself: N `submissions` rows for one
 * artifact, N duplicated blobs, and — the reason it had to go — no shared
 * identity to hang a per-contributor score on, so a finding either scored
 * against every partner or against none.
 *
 * `submission_contributors` removes the need for it. Dedup is blob-scoped
 * again, as it originally was, and the second co-submitter is ATTACHED to the
 * existing submission as a contributor instead of creating a second row. The
 * student is preserved — which is what the scoping was protecting — without
 * duplicating the artifact.
 *
 * Identical bytes really do mean the same artifact: a `.provenance` bundle
 * carries per-session uuids, per-session keys and wall-clock timestamps, so two
 * different people cannot produce one by coincidence. The narrow dedup was
 * never distinguishing two artifacts; it was distinguishing two SUBMITTERS of
 * one artifact, and that is now representable directly.
 *
 * Re-uploading the same bytes for a student who is ALREADY a contributor is a
 * no-op: the attach is an upsert on (submission_id, contributor_key). Ingest
 * stays idempotent.
 */
export async function dedupFile(
  db: DrizzleDb,
  semesterId: string,
  blobSha256: string,
): Promise<DedupResult> {
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(eq(submissions.semester_id, semesterId), eq(submissions.blob_sha256, blobSha256)),
    )
    .limit(1);

  if (rows.length > 0) {
    return { isDuplicate: true, existingSubmissionId: rows[0]!.id };
  }

  return { isDuplicate: false };
}

/**
 * Attach a co-submitter to a submission that already exists (D9).
 *
 * This is the other half of removing the fan-out. When the Gradescope path
 * uploads a group bundle once per member, the first upload creates the
 * submission and every subsequent one lands here: the bytes are a duplicate,
 * but the PERSON is not, and losing them is the erasure the old student-scoped
 * dedup existed to prevent.
 *
 * Idempotent by construction — a pg-boss retry, or the same export uploaded
 * twice, adds nothing the second time.
 *
 * ## The conflict target is deliberately UNTARGETED
 *
 * A bare `ON CONFLICT DO NOTHING`, covering EVERY constraint, because this row
 * can collide two different ways and both mean "this person is already a
 * contributor":
 *
 *  - `submission_contributors_key_unique` on (submission_id, contributor_key) —
 *    the same co-submitter attached twice;
 *  - `submission_contributors_person_key`, the partial unique index on
 *    (submission_id, roster_entry_id) — the person is already present under an
 *    ATTRIBUTED key, because they also recorded and the bundle side named them
 *    first. Their key is `attributed:…`, not `roster:…`, so a target of
 *    (submission_id, contributor_key) would NOT match and the insert would
 *    RAISE, failing the ingest of a perfectly ordinary group upload.
 *
 * DO NOTHING rather than DO UPDATE in either case: an existing row may carry a
 * verified `student_ref`, a session count and a score from the bundle-side
 * path. Overwriting it with this path's roster-only knowledge would DOWNGRADE a
 * verified contributor to a bare submitter and zero their score.
 *
 * The score columns are left at their defaults for a newly attached
 * contributor; `applyContributorScores` owns them and runs over the whole
 * submission.
 */
export async function attachCoSubmitter(
  db: DrizzleDb,
  submissionId: string,
  semesterId: string,
  rosterEntryId: string,
): Promise<void> {
  await db
    .insert(submission_contributors)
    .values({
      submission_id: submissionId,
      semester_id: semesterId,
      contributor_key: rosterContributorKey(rosterEntryId),
      kind: 'roster',
      roster_entry_id: rosterEntryId,
      is_submitter: true,
    })
    .onConflictDoNothing();
}
