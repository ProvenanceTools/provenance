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

import { eq, and, inArray, sql } from 'drizzle-orm';
import { roster_entries, submissions, submission_contributors } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { withTransaction } from '../../db/client.js';
import { rosterContributorKey } from '../contributors/store-contributors.js';
import { versionOwnerKey } from './version-owner-key.js';

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
    .where(and(eq(submissions.semester_id, semesterId), eq(submissions.blob_sha256, blobSha256)))
    .limit(1);

  if (rows.length > 0) {
    return { isDuplicate: true, existingSubmissionId: rows[0]!.id };
  }

  return { isDuplicate: false };
}

/**
 * Is there already a submission for this DECLARED group?
 *
 * The other half of removing the fan-out, and the half that does not depend on
 * a coincidence. `dedupFile` collapses two co-submitters of one Gradescope
 * submission only when their rebuilt archives are byte-identical — which they
 * are today solely because `local-path.ts` awaits ONE shared `rebuild` promise
 * for all of a folder's submitters. That is an implementation detail of one
 * function, not a property of the system: any change to scope resolution, entry
 * ordering or the zip writer that moves a byte splits the pair into two
 * submissions with one contributor each, silently, and the cross-submission
 * heuristics then compare two views of one repository against each other and
 * fire `paste_shared_across_students` at high severity on two people the course
 * assigned to work together (S20).
 *
 * `source_group_key` makes it an invariant instead. It is the upstream
 * `(folderKey, scopePath)` — the identity of one archive submitted by one set
 * of people — persisted at staging (migration 0033), so the collapse is keyed
 * on the DECLARATION rather than on what the rebuild happened to produce.
 *
 * Checked BEFORE the blob check by the caller: when both would fire they name
 * the same submission, and when only one does it is this one, because bytes can
 * diverge while the declaration cannot.
 */
export async function dedupByGroup(
  db: DrizzleDb,
  semesterId: string,
  sourceGroupKey: string,
): Promise<DedupResult> {
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.semester_id, semesterId),
        eq(submissions.source_group_key, sourceGroupKey),
      ),
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
 *
 * ## It also settles WHICH co-submitter is the submitter of record
 *
 * See {@link reconcileSubmitterOfRecord}. Both halves run in ONE transaction so
 * a co-submitter can never be recorded without the submitter-of-record having
 * been reconsidered in the light of them.
 *
 * @returns the ids of submissions this one now supersedes as a result of moving
 *   lineage. Empty in every case except a group RESUBMISSION whose canonical
 *   partner lost the race. The caller marks their `ingest_files` rows
 *   `'superseded'`, exactly as it does for `createSubmission`'s `supersededIds`
 *   — and for the same reason it does it OUTSIDE this transaction: those rows
 *   can belong to other ingest jobs.
 */
export async function attachCoSubmitter(
  db: DrizzleDb,
  submissionId: string,
  semesterId: string,
  rosterEntryId: string,
): Promise<string[]> {
  return withTransaction(db, async (tx) => {
    await tx
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

    return reconcileSubmitterOfRecord(tx, semesterId, submissionId, rosterEntryId);
  });
}

// ---------------------------------------------------------------------------
// The submitter of record, made deterministic
// ---------------------------------------------------------------------------

/**
 * Settle `submissions.student_id` on the LOWEST `roster_entries.sid` among the
 * submission's co-submitters.
 *
 * ## The defect this closes
 *
 * A group export is uploaded once per co-submitter with byte-identical bundles,
 * and the worker drains its pg-boss batch with `Promise.all`. Whichever file
 * wins the advisory lock in `create-submission.ts` inserts the row with ITS OWN
 * `studentId`; the loser is attached here. Nothing ordered the two, so the same
 * export re-ingested could name the other partner — and every surface that
 * renders `student_id` as "the student" then named an arbitrary one of two
 * people. Naming the wrong student is the failure mode this programme is judged
 * against, so "an arbitrary one of two" is not an acceptable answer even when
 * both are genuinely co-submitters.
 *
 * ## Why `roster_entries.sid`, and not the other three candidates
 *
 * The tie-break has to be stable across re-ingest, or it just relocates the
 * nondeterminism:
 *
 *  - **`sid`** — the institution's identifier for the person, `UNIQUE
 *    (semester_id, sid)`. It is assigned OUTSIDE this system, it is what the
 *    filename convention and the Gradescope `match_sid` both carry, and it
 *    survives a roster re-import unchanged. Nothing about ingest order, upload
 *    order or row-allocation order can move it. This is the one we use.
 *  - `roster_entry_id` — a `gen_random_uuid()` allocated when the roster row was
 *    created. Stable while the roster row lives, but re-importing a roster mints
 *    NEW uuids for the same humans, which would silently re-elect a different
 *    partner on the next ingest. It is an allocation artifact, not an identity.
 *  - `student_ref` — genuinely stable and genuinely an identity, but only
 *    `attributed` contributors have one. A co-submitter who did not record has
 *    no ref at all, so the ordering would be undefined for exactly the case
 *    this exists to settle.
 *  - `contributor_key` — `roster:<roster_entry_id>` on this path, so it inherits
 *    the uuid's instability with extra steps.
 *
 * ## Moving lineage, and why the version sequence has to move with it
 *
 * `submissions.version_owner_key` is GENERATED from `student_id`, and
 * `submissions_version_key` is `UNIQUE (semester_id, assignment_id,
 * version_owner_key, version_index)`. So changing `student_id` MOVES the row
 * between lineages, and a bare `UPDATE ... SET student_id` would raise a unique
 * violation on any group RESUBMISSION whose canonical partner lost the race:
 * the new row is allocated `version_index` 1 in the loser's (empty) lineage,
 * then lands on top of the previous version already sitting at 1 in the
 * winner's. That is roughly half of all group resubmissions, so the move has to
 * re-allocate the version index and re-point the supersede chain — which is
 * `create-submission.ts` steps 2 and 6, replayed under the same `FOR UPDATE`
 * lock on the target lineage.
 *
 * As a side effect this is the first time a group's repeated submissions form a
 * supersede chain at all: before, the lineage key flipped with the race winner,
 * so each version started a fresh sequence at 1 and none superseded any other.
 *
 * ## Where it deliberately declines to act
 *
 * The move is only well-defined when this submission becomes the HEAD of the
 * target lineage. It is skipped when:
 *
 *  - the submission has no `student_id` (a `group_key` lineage — not ours to
 *    move, and no live caller produces one);
 *  - the current submitter of record already sorts lowest, or IS the candidate;
 *  - the submission is already superseded — a historical row, whose submitter of
 *    record drives no live surface, and which must not be promoted to head of
 *    another lineage;
 *  - the target lineage already holds a NEWER submission. Slotting an older row
 *    into the middle of an existing version chain means renumbering rows a
 *    grader has already seen, which is a product decision and not one this
 *    change was asked to make.
 *
 * None of those skips reintroduces the defect: they all require DB state that a
 * concurrent batch cannot produce, so for the case that actually races — two
 * co-submitters of one fresh export — the outcome is identical in both arrival
 * orders. The remaining surfaces no longer render `student_id` as "the student"
 * in any case; they render the contributor list.
 */
async function reconcileSubmitterOfRecord(
  tx: DrizzleDb,
  semesterId: string,
  submissionId: string,
  candidateRosterEntryId: string,
): Promise<string[]> {
  // Lock the submission and read its lineage inputs in one shot. `FOR UPDATE OF
  // s` locks only the submission — the roster row is read, not claimed.
  const lockedRaw = await tx.execute(sql`
    SELECT s.assignment_id,
           s.student_id,
           s.version_index,
           s.created_at,
           s.superseded_by_submission_id,
           r.sid AS submitter_sid
    FROM submissions s
    LEFT JOIN roster_entries r ON r.id = s.student_id
    WHERE s.id = ${submissionId}
    FOR UPDATE OF s
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: postgres.js raw result
  const locked = lockedRaw as any as Array<{
    assignment_id: string;
    student_id: string | null;
    version_index: number;
    created_at: Date | string;
    superseded_by_submission_id: string | null;
    submitter_sid: string | null;
  }>;
  const submission = locked[0];

  if (submission === undefined) return [];
  // A `group:` lineage, or a row already superseded — see the header.
  if (submission.student_id === null || submission.submitter_sid === null) return [];
  if (submission.superseded_by_submission_id !== null) return [];
  if (submission.student_id === candidateRosterEntryId) return [];

  const candidateRows = await tx
    .select({ sid: roster_entries.sid })
    .from(roster_entries)
    .where(eq(roster_entries.id, candidateRosterEntryId))
    .limit(1);
  const candidateSid = candidateRows[0]?.sid;
  if (candidateSid === undefined) return [];

  // The incumbent already sorts lowest. Note `>=` rather than `>`: sid is
  // UNIQUE per semester, so equality here would mean two roster rows for one
  // sid, and doing nothing is the right answer to that too.
  if (candidateSid >= submission.submitter_sid) return [];

  // Lock the target lineage exactly as create-submission locks the one it is
  // allocating into, so a concurrent creator for the same lineage serialises
  // against this move instead of racing it to the same version_index.
  const targetOwnerKey = versionOwnerKey({ studentId: candidateRosterEntryId });
  const targetRaw = await tx.execute(sql`
    SELECT id, version_index, created_at
    FROM submissions
    WHERE semester_id = ${semesterId}
      AND assignment_id = ${submission.assignment_id}
      AND version_owner_key = ${targetOwnerKey}
      AND id <> ${submissionId}
    FOR UPDATE
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: postgres.js raw result
  const targetRows = targetRaw as any as Array<{
    id: string;
    version_index: number;
    created_at: Date | string;
  }>;

  const createdAt = new Date(submission.created_at).getTime();
  const hasNewer = targetRows.some((r) => new Date(r.created_at).getTime() > createdAt);
  if (hasNewer) return [];

  const maxVersion = targetRows.reduce((m, r) => Math.max(m, r.version_index), 0);

  // ONE statement: `student_id` and `version_index` move together, so the
  // generated `version_owner_key` and the version sequence are never
  // momentarily inconsistent with each other.
  await tx
    .update(submissions)
    .set({ student_id: candidateRosterEntryId, version_index: maxVersion + 1 })
    .where(eq(submissions.id, submissionId));

  const supersededIds = targetRows.map((r) => r.id);
  if (supersededIds.length > 0) {
    await tx
      .update(submissions)
      .set({ superseded_by_submission_id: submissionId })
      .where(inArray(submissions.id, supersededIds));
  }

  return supersededIds;
}
