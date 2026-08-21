/**
 * The post-0029 end state of a Gradescope export holding one SOLO folder and
 * one PAIR folder — asserted identically by every upload mechanism that feeds
 * that export through the worker.
 *
 * ## Why this is a shared helper
 *
 * Four e2e tests (`local-path`, `resumable-upload`, `stage-upload-job`, and the
 * HTTP `:gradescope` route) exist to prove that *different transports reach the
 * same end state*. Before D9 they each spelled that end state out inline, and
 * they drifted: each asserted a slightly different, and separately weakened,
 * subset of it. Sharing one function makes "the same end state" a property of
 * the code rather than a claim in a comment, and means a mutation that any one
 * of them can catch is caught by all of them.
 *
 * ## The contract being pinned (D9, migration 0029)
 *
 * The Gradescope export uploads a group submission ONCE PER CO-SUBMITTER with
 * byte-identical bytes. Before 0029 that fanned out into N `submissions` rows
 * with N copies of one blob. It no longer does:
 *
 *  - the pair's two `ingest_files` rows carry the same `blob_sha256`, so
 *    exactly ONE of them creates the submission (`status='matched'`) and the
 *    other resolves as `status='duplicate'`. WHICH of the two wins is a race —
 *    `INGEST_CONCURRENCY` drains the batch with `Promise.all` — so nothing here
 *    may assume an order;
 *  - the `'duplicate'` row still names its OWN student in `matched_student_id`
 *    and points at the shared submission. **This is the load-bearing part.**
 *    The regression this file exists to catch is losing the second co-submitter
 *    entirely: a duplicate that resolves with a null student, or a contributor
 *    that never gets attached, erases a human being from the system silently
 *    (census scenario S20) while every status column still looks healthy;
 *  - there are TWO submissions, not three — the solo, and ONE shared by the
 *    pair — and the pair's carries TWO `submission_contributors` rows.
 *
 * Nothing here asserts `.every(...)` over a status column. The multiset is
 * pinned exactly, because `every(s => s === 'matched' || s === 'duplicate')`
 * passes just as happily when the fan-out comes back (three `'matched'`) as
 * when it has not.
 */

import { expect } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ingest_files,
  roster_entries,
  submissions,
  submission_contributors,
} from '../../src/db/schema.js';
import type { DrizzleDb } from '../../src/db/client.js';

/** The sids in the shared `submission_metadata.yml`: one solo, one pair. */
export const SOLO_SID = '111';
export const PAIR_SIDS = ['222', '333'] as const;

/**
 * Assert the full solo+pair end state for one finished ingest job.
 *
 * @param db          drizzle handle bound to the test's Postgres container
 * @param semesterId  the semester the export was ingested into
 * @param jobId       the finished `ingest_jobs` row
 */
export async function expectSoloPlusPairEndState(
  db: DrizzleDb,
  semesterId: string,
  jobId: string,
): Promise<void> {
  const rosterRows = await db
    .select({ id: roster_entries.id, sid: roster_entries.sid })
    .from(roster_entries)
    .where(eq(roster_entries.semester_id, semesterId));
  const rosterIdBySid = new Map(rosterRows.map((r) => [r.sid, r.id]));
  for (const sid of [SOLO_SID, ...PAIR_SIDS]) {
    expect(rosterIdBySid.get(sid), `roster entry for sid ${sid}`).toBeTruthy();
  }

  // -------------------------------------------------------------------------
  // ingest_files: three rows, one per SUBMITTER, and the exact status multiset
  // -------------------------------------------------------------------------
  const fileRows = await db
    .select({
      status: ingest_files.status,
      match_sid: ingest_files.match_sid,
      submission_id: ingest_files.submission_id,
      matched_student_id: ingest_files.matched_student_id,
    })
    .from(ingest_files)
    .where(eq(ingest_files.ingest_job_id, jobId));
  expect(fileRows).toHaveLength(3);

  // One row per submitter, still keyed by the hint the export supplied.
  expect(new Set(fileRows.map((f) => f.match_sid))).toEqual(
    new Set([SOLO_SID, ...PAIR_SIDS] as string[]),
  );

  // The EXACT multiset. Two matched (the solo, and whichever co-submitter won
  // the race to create the shared submission) and exactly one duplicate.
  // Three `'matched'` here is the fan-out returning; three `'duplicate'`, or a
  // `'failed'`, is the opposite failure. Both are excluded.
  expect([...fileRows.map((f) => f.status)].sort()).toEqual(['duplicate', 'matched', 'matched']);

  // EVERY row — the duplicate above all — still names its OWN student and a
  // submission. Not `every(x => x !== null)`: each row must carry the roster id
  // belonging to the sid it was hinted with, so a duplicate that resolves under
  // the wrong person's name is caught as well as one that resolves under none.
  for (const row of fileRows) {
    expect(row.matched_student_id, `matched_student_id for sid ${row.match_sid}`).toBe(
      rosterIdBySid.get(row.match_sid!),
    );
    expect(row.submission_id, `submission_id for sid ${row.match_sid}`).not.toBeNull();
  }

  const duplicateRow = fileRows.find((f) => f.status === 'duplicate')!;
  // The duplicate is one of the PAIR, never the solo: the solo's bytes are
  // unique to it, so a solo resolving as a duplicate would mean dedup had
  // started collapsing distinct artifacts.
  expect(PAIR_SIDS as readonly string[]).toContain(duplicateRow.match_sid);

  // -------------------------------------------------------------------------
  // submissions: TWO, not three
  // -------------------------------------------------------------------------
  const subs = await db
    .select({
      id: submissions.id,
      student_id: submissions.student_id,
      blob_sha256: submissions.blob_sha256,
    })
    .from(submissions)
    .where(eq(submissions.semester_id, semesterId));
  expect(subs).toHaveLength(2);

  // The pair's two ingest_files rows point at the SAME submission, and that is
  // the submission the duplicate was attached to.
  const pairFileRows = fileRows.filter((f) =>
    (PAIR_SIDS as readonly string[]).includes(f.match_sid!),
  );
  expect(pairFileRows).toHaveLength(2);
  const pairSubmissionId = pairFileRows[0]!.submission_id!;
  expect(pairFileRows[1]!.submission_id).toBe(pairSubmissionId);

  const soloFileRow = fileRows.find((f) => f.match_sid === SOLO_SID)!;
  expect(soloFileRow.status).toBe('matched');
  const soloSubmissionId = soloFileRow.submission_id!;
  expect(soloSubmissionId).not.toBe(pairSubmissionId);

  const subById = new Map(subs.map((s) => [s.id, s]));
  const pairSub = subById.get(pairSubmissionId);
  const soloSub = subById.get(soloSubmissionId);
  expect(pairSub, 'the pair submission the ingest_files rows point at').toBeTruthy();
  expect(soloSub, 'the solo submission').toBeTruthy();

  // Distinct artifacts keep distinct blobs; the pair's ONE blob is stored once.
  expect(pairSub!.blob_sha256).not.toBe(soloSub!.blob_sha256);

  // The pair's submitter of record is the LOWER of their two sids, whichever
  // side of the race won.
  //
  // This used to assert `pairSub.student_id === the row that created it`, which
  // pinned a race rather than a requirement: whoever won `Promise.all` became
  // "the student", so re-ingesting the same export could name the other
  // partner. It is inverted rather than weakened — the expected value now comes
  // from `roster_entries.sid`, which the institution assigns and no ingest
  // ordering can move, so BOTH arrival orders must produce it.
  const canonicalPairSid = [...PAIR_SIDS].sort()[0]!;
  expect(pairSub!.student_id).toBe(rosterIdBySid.get(canonicalPairSid));
  expect(soloSub!.student_id).toBe(rosterIdBySid.get(SOLO_SID));

  // -------------------------------------------------------------------------
  // submission_contributors: the pair is TWO people on ONE submission
  // -------------------------------------------------------------------------
  const contribRows = await db
    .select({
      submission_id: submission_contributors.submission_id,
      roster_entry_id: submission_contributors.roster_entry_id,
      kind: submission_contributors.kind,
      is_submitter: submission_contributors.is_submitter,
    })
    .from(submission_contributors)
    .where(eq(submission_contributors.semester_id, semesterId));

  const pairContribs = contribRows.filter((c) => c.submission_id === pairSubmissionId);
  // Exactly two rows — one per human. Not `>= 2`: two rows for ONE person
  // would split their score across two apparent contributors, which is the
  // failure the partial unique index on (submission_id, roster_entry_id) and
  // the untargeted ON CONFLICT in `attachCoSubmitter` exist to prevent.
  expect(pairContribs).toHaveLength(2);
  expect(new Set(pairContribs.map((c) => c.roster_entry_id))).toEqual(
    new Set(PAIR_SIDS.map((sid) => rosterIdBySid.get(sid)!)),
  );
  for (const contrib of pairContribs) {
    expect(contrib.kind).toBe('roster');
    expect(contrib.is_submitter).toBe(true);
  }

  const soloContribs = contribRows.filter((c) => c.submission_id === soloSubmissionId);
  expect(soloContribs).toHaveLength(1);
  expect(soloContribs[0]!.roster_entry_id).toBe(rosterIdBySid.get(SOLO_SID));

  // Nothing else got a contributor row anywhere in the semester.
  expect(contribRows).toHaveLength(3);
}
