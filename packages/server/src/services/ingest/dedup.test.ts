/**
 * Integration tests for the dedup phase (PRD §9.3 phase 2).
 *
 * Uses withTestDb — requires Docker.
 */

import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

import { withTestDb } from '../../../test/helpers/db.js';
import { dedupFile, attachCoSubmitter } from './dedup.js';
import {
  users,
  courses,
  semesters,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
  submission_contributors,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(db: DrizzleDb) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      google_subject: `sub-${id}`,
      email: `user-${id}@berkeley.edu`,
      display_name: 'Test User',
    })
    .returning();
  return user!;
}

async function seedSemester(db: DrizzleDb, _userId: string) {
  const slug = `cs61a-${crypto.randomUUID().slice(0, 8)}`;
  const [course] = await db.insert(courses).values({ name: 'CS 61A', slug }).returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2024,
      slug: `fa2024-${crypto.randomUUID().slice(0, 8)}`,
      display_name: 'Fall 2024',
      filename_convention: '(?<sid>\\d+)',
    })
    .returning();
  return semester!;
}

async function seedRosterEntry(db: DrizzleDb, semesterId: string, sid = '123456') {
  const [entry] = await db
    .insert(roster_entries)
    .values({ semester_id: semesterId, sid, display_name: 'Test Student' })
    .returning();
  return entry!;
}

async function seedAssignment(db: DrizzleDb, semesterId: string, assignmentIdStr = 'hw01') {
  const [assignment] = await db
    .insert(assignments)
    .values({ semester_id: semesterId, assignment_id_str: assignmentIdStr })
    .returning();
  return assignment!;
}

async function seedIngestJob(db: DrizzleDb, semesterId: string, userId: string) {
  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semesterId, uploaded_by: userId, status: 'running', summary: {} })
    .returning();
  return job!;
}

async function seedSubmission(
  db: DrizzleDb,
  semesterId: string,
  assignmentId: string,
  studentId: string,
  ingestJobId: string,
  blobSha256: string,
  versionIndex = 1,
  extra: { createdAt?: Date; supersededBy?: string } = {},
) {
  const [sub] = await db
    .insert(submissions)
    .values({
      semester_id: semesterId,
      assignment_id: assignmentId,
      student_id: studentId,
      blob_object_key: `semesters/${semesterId}/submissions/${crypto.randomUUID()}/bundle.zip`,
      blob_sha256: blobSha256,
      source_filename: 'hw01-123456.zip',
      ingest_job_id: ingestJobId,
      version_index: versionIndex,
      ...(extra.createdAt === undefined ? {} : { created_at: extra.createdAt }),
      ...(extra.supersededBy === undefined
        ? {}
        : { superseded_by_submission_id: extra.supersededBy }),
    })
    .returning();
  return sub!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dedupFile', () => {
  it('returns isDuplicate:false when no matching submission exists', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);

      const result = await dedupFile(db, semester.id, 'a'.repeat(64));
      expect(result.isDuplicate).toBe(false);
    });
  });

  it('returns isDuplicate:true with existingSubmissionId when sha256 matches', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const student = await seedRosterEntry(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sha256 = 'b'.repeat(64);
      const sub = await seedSubmission(db, semester.id, assignment.id, student.id, job.id, sha256);

      const result = await dedupFile(db, semester.id, sha256);
      expect(result.isDuplicate).toBe(true);
      if (!result.isDuplicate) return;
      expect(result.existingSubmissionId).toBe(sub.id);
    });
  });

  it('does not match a sha256 from a different semester', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester1 = await seedSemester(db, user.id);
      const semester2 = await seedSemester(db, user.id);
      const student = await seedRosterEntry(db, semester1.id);
      const assignment = await seedAssignment(db, semester1.id);
      const job = await seedIngestJob(db, semester1.id, user.id);

      const sha256 = 'c'.repeat(64);
      await seedSubmission(db, semester1.id, assignment.id, student.id, job.id, sha256);

      // Same sha256 but queried against semester2 — should not match.
      const result = await dedupFile(db, semester2.id, sha256);
      expect(result.isDuplicate).toBe(false);
    });
  });

  it('returns isDuplicate:true even for superseded submissions (same sha256)', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const student = await seedRosterEntry(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sha256 = 'd'.repeat(64);
      // Seed as version 1; it will be "superseded" by a later upload in real code,
      // but the blob sha256 is still unique.
      const sub = await seedSubmission(db, semester.id, assignment.id, student.id, job.id, sha256);

      const result = await dedupFile(db, semester.id, sha256);
      expect(result.isDuplicate).toBe(true);
      if (!result.isDuplicate) return;
      expect(result.existingSubmissionId).toBe(sub.id);
    });
  });

  it('does not match a sha256 that differs by even one character', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const student = await seedRosterEntry(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sha256Stored = 'e'.repeat(64);
      await seedSubmission(db, semester.id, assignment.id, student.id, job.id, sha256Stored);

      const sha256Query = 'f'.repeat(64); // differs from stored
      const result = await dedupFile(db, semester.id, sha256Query);
      expect(result.isDuplicate).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Group submissions (D9) — the co-submitter is ATTACHED, not fanned out
  // -------------------------------------------------------------------------
  //
  // These two tests replace a pair that pinned the OLD student-scoped dedup:
  // "with studentId: matches only the same student (co-submitter blob is NOT a
  // duplicate)". That behaviour existed to stop blob-only dedup ERASING the
  // second co-submitter of a group export (census scenario S20), and the
  // requirement underneath it — the second co-submitter must survive — is
  // unchanged and is what these tests assert. What changed is the
  // representation: they survive as a CONTRIBUTOR of the one submission rather
  // than as a second submission row with a duplicated blob.
  //
  // The old assertions are not weakened, they are re-pinned: `isDuplicate` is
  // now TRUE for the co-submitter (identical bytes really are the same
  // artifact), and the thing that must not be lost is checked directly.

  it('a co-submitter of the same blob is a duplicate, and is ATTACHED as a contributor', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const studentA = await seedRosterEntry(db, semester.id, '111111');
      const studentB = await seedRosterEntry(db, semester.id, '222222');
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // One group bundle: identical blob bytes, first ingested for student A.
      const sha256 = 'a1'.repeat(32);
      const sub = await seedSubmission(db, semester.id, assignment.id, studentA.id, job.id, sha256);

      // Student B (co-submitter, same bytes) IS a duplicate of the artifact...
      const forB = await dedupFile(db, semester.id, sha256);
      expect(forB.isDuplicate).toBe(true);
      if (!forB.isDuplicate) return;
      expect(forB.existingSubmissionId).toBe(sub.id);

      // ...but must NOT be erased. This is what the old student-scoped dedup
      // was protecting, and it is now protected directly.
      // (A is attached by the ingest path's contributor stage; seedSubmission
      // writes only the submissions row, so attach both here explicitly.)
      await attachCoSubmitter(db, sub.id, semester.id, studentA.id);
      await attachCoSubmitter(db, sub.id, semester.id, studentB.id);

      const contributors = await db
        .select({ roster_entry_id: submission_contributors.roster_entry_id })
        .from(submission_contributors)
        .where(eq(submission_contributors.submission_id, sub.id));

      expect(contributors.map((c) => c.roster_entry_id).sort()).toEqual(
        [studentA.id, studentB.id].sort(),
      );

      // And there is exactly ONE submission — no fan-out, no duplicated blob.
      const subs = await db
        .select({ id: submissions.id })
        .from(submissions)
        .where(eq(submissions.blob_sha256, sha256));
      expect(subs).toHaveLength(1);
    });
  });

  it('attaching the same co-submitter twice is a no-op (ingest stays idempotent)', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const studentA = await seedRosterEntry(db, semester.id, '111111');
      const studentB = await seedRosterEntry(db, semester.id, '222222');
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sha256 = 'b2'.repeat(32);
      const sub = await seedSubmission(db, semester.id, assignment.id, studentA.id, job.id, sha256);

      await attachCoSubmitter(db, sub.id, semester.id, studentB.id);
      await attachCoSubmitter(db, sub.id, semester.id, studentB.id);
      // The submitter who already has a backfilled/ingest-written row too.
      await attachCoSubmitter(db, sub.id, semester.id, studentA.id);

      const contributors = await db
        .select({ id: submission_contributors.id })
        .from(submission_contributors)
        .where(eq(submission_contributors.submission_id, sub.id));

      expect(contributors).toHaveLength(2);
    });
  });

  it('attaching someone already present under an ATTRIBUTED key is a no-op, not an error', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const studentA = await seedRosterEntry(db, semester.id, '111111');
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sha256 = 'd4'.repeat(32);
      const sub = await seedSubmission(db, semester.id, assignment.id, studentA.id, job.id, sha256);

      // The BUNDLE side named this person first: they recorded, their chain
      // verified, so their row carries an `attributed:` key — NOT `roster:`.
      await db.insert(submission_contributors).values({
        submission_id: sub.id,
        semester_id: semester.id,
        contributor_key: 'attributed:2.1:institution:berkeley:a-ref',
        kind: 'attributed',
        roster_entry_id: studentA.id,
        student_ref: 'a-ref',
        is_submitter: false,
      });

      // Now the Gradescope path attaches the same human as a co-submitter. The
      // keys DIFFER, so a conflict target of (submission_id, contributor_key)
      // does not match — but the partial unique index on
      // (submission_id, roster_entry_id) does, and a targeted ON CONFLICT would
      // RAISE, failing the ingest of an ordinary group upload. The attach must
      // be an untargeted DO NOTHING.
      // Resolving at all is the assertion; the value is the (here empty) list of
      // submissions the attach superseded.
      await expect(attachCoSubmitter(db, sub.id, semester.id, studentA.id)).resolves.toEqual([]);

      // Still ONE row for the person, and it is the RICHER one — the attributed
      // key, ref and kind survive. Overwriting them with this path's
      // roster-only knowledge would downgrade a verified contributor.
      const rows = await db
        .select({
          contributor_key: submission_contributors.contributor_key,
          kind: submission_contributors.kind,
          student_ref: submission_contributors.student_ref,
        })
        .from(submission_contributors)
        .where(eq(submission_contributors.submission_id, sub.id));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe('attributed');
      expect(rows[0]!.student_ref).toBe('a-ref');
    });
  });

  it('blob-only dedup still sees an existing submission as a duplicate', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const studentA = await seedRosterEntry(db, semester.id, '111111');
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sha256 = 'c3'.repeat(32);
      const sub = await seedSubmission(db, semester.id, assignment.id, studentA.id, job.id, sha256);

      const result = await dedupFile(db, semester.id, sha256);
      expect(result.isDuplicate).toBe(true);
      if (!result.isDuplicate) return;
      expect(result.existingSubmissionId).toBe(sub.id);
    });
  });
});

// ---------------------------------------------------------------------------
// The submitter of record is deterministic
// ---------------------------------------------------------------------------
//
// Two co-submitters of one group export are separate ingest files processed
// CONCURRENTLY, and whichever wins the advisory lock in `createSubmission`
// writes `submissions.student_id` with its own student. Nothing ordered the
// two, so the same export re-ingested could name the other partner — and every
// surface that shows "the student" then showed an arbitrary one of two people.
//
// `seedSubmission` + `attachCoSubmitter` is exactly that race's outcome: the
// row as the winner wrote it, then the loser attaching. Running it BOTH ways
// round is the whole point — an assertion against one order alone would pass on
// the defect.

describe('the submitter of record', () => {
  it('is the same student whichever co-submitter wins the race', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      // Two humans, and the sid ordering is the only thing that may decide.
      const lowSid = await seedRosterEntry(db, semester.id, '111111');
      const highSid = await seedRosterEntry(db, semester.id, '222222');
      const job = await seedIngestJob(db, semester.id, user.id);

      // Separate assignments so the two orders are two independent lineages and
      // can both land at version 1 without colliding on submissions_version_key.
      const hw01 = await seedAssignment(db, semester.id, 'hw01');
      const hw02 = await seedAssignment(db, semester.id, 'hw02');

      // Order 1: the HIGH sid won the race and wrote the row.
      const first = await seedSubmission(
        db,
        semester.id,
        hw01.id,
        highSid.id,
        job.id,
        'e1'.repeat(32),
      );
      await attachCoSubmitter(db, first.id, semester.id, lowSid.id);

      // Order 2: the LOW sid won the race and wrote the row.
      const second = await seedSubmission(
        db,
        semester.id,
        hw02.id,
        lowSid.id,
        job.id,
        'e2'.repeat(32),
      );
      await attachCoSubmitter(db, second.id, semester.id, highSid.id);

      const rows = await db
        .select({ id: submissions.id, student_id: submissions.student_id })
        .from(submissions)
        .where(eq(submissions.semester_id, semester.id));

      const byId = new Map(rows.map((r) => [r.id, r.student_id]));
      expect(byId.get(first.id)).toBe(lowSid.id);
      expect(byId.get(second.id)).toBe(lowSid.id);
      // Said once more as the property itself, so a future edit that makes both
      // orders agree on the WRONG student still fails.
      expect(byId.get(first.id)).toBe(byId.get(second.id));
    });
  });

  it('keeps BOTH co-submitters as contributors while settling on one of them', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const lowSid = await seedRosterEntry(db, semester.id, '111111');
      const highSid = await seedRosterEntry(db, semester.id, '222222');
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sub = await seedSubmission(
        db,
        semester.id,
        assignment.id,
        highSid.id,
        job.id,
        'e3'.repeat(32),
      );
      await attachCoSubmitter(db, sub.id, semester.id, highSid.id);
      await attachCoSubmitter(db, sub.id, semester.id, lowSid.id);

      const contributors = await db
        .select({ roster_entry_id: submission_contributors.roster_entry_id })
        .from(submission_contributors)
        .where(eq(submission_contributors.submission_id, sub.id));

      // Settling on one submitter of record must not demote the other person
      // out of the attribution table — that is the erasure D9 exists to stop.
      expect(contributors.map((c) => c.roster_entry_id).sort()).toEqual(
        [lowSid.id, highSid.id].sort(),
      );
    });
  });

  it('is stable under a repeated attach (ingest stays idempotent)', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const lowSid = await seedRosterEntry(db, semester.id, '111111');
      const highSid = await seedRosterEntry(db, semester.id, '222222');
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sub = await seedSubmission(
        db,
        semester.id,
        assignment.id,
        highSid.id,
        job.id,
        'e4'.repeat(32),
      );

      await attachCoSubmitter(db, sub.id, semester.id, lowSid.id);
      // A pg-boss retry, or the same export uploaded again.
      await attachCoSubmitter(db, sub.id, semester.id, lowSid.id);
      await attachCoSubmitter(db, sub.id, semester.id, highSid.id);

      const [row] = await db
        .select({ student_id: submissions.student_id, version_index: submissions.version_index })
        .from(submissions)
        .where(eq(submissions.id, sub.id));

      expect(row!.student_id).toBe(lowSid.id);
      expect(row!.version_index).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // The lineage hazard the reconcile has to carry
  // -------------------------------------------------------------------------
  //
  // `version_owner_key` is GENERATED from `student_id`, and
  // `submissions_version_key` is UNIQUE (semester, assignment,
  // version_owner_key, version_index). So re-electing the submitter of record
  // MOVES the row between lineages, and a bare `SET student_id` raises a unique
  // violation on any group resubmission whose canonical partner lost the race —
  // roughly half of them.

  it('re-allocates the version index when the move lands in an occupied lineage', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const lowSid = await seedRosterEntry(db, semester.id, '111111');
      const highSid = await seedRosterEntry(db, semester.id, '222222');
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // Version 1 of the pair's work, already settled on the canonical partner.
      const v1 = await seedSubmission(
        db,
        semester.id,
        assignment.id,
        lowSid.id,
        job.id,
        'f1'.repeat(32),
        1,
        { createdAt: new Date(Date.now() - 60_000) },
      );

      // The resubmission: the OTHER partner won this race, so createSubmission
      // allocated version 1 in their own (empty) lineage.
      const v2 = await seedSubmission(
        db,
        semester.id,
        assignment.id,
        highSid.id,
        job.id,
        'f2'.repeat(32),
        1,
      );

      const superseded = await attachCoSubmitter(db, v2.id, semester.id, lowSid.id);

      const rows = await db
        .select({
          id: submissions.id,
          student_id: submissions.student_id,
          version_index: submissions.version_index,
          superseded_by: submissions.superseded_by_submission_id,
        })
        .from(submissions)
        .where(eq(submissions.assignment_id, assignment.id));

      const byId = new Map(rows.map((r) => [r.id, r]));
      // The move happened...
      expect(byId.get(v2.id)!.student_id).toBe(lowSid.id);
      // ...and took the version sequence with it, rather than colliding at 1.
      expect(byId.get(v2.id)!.version_index).toBe(2);
      // ...and the chain formed, which it never did while the lineage key
      // flipped with the race winner.
      expect(byId.get(v1.id)!.superseded_by).toBe(v2.id);
      expect(byId.get(v2.id)!.superseded_by).toBeNull();
      expect(superseded).toEqual([v1.id]);
    });
  });

  it('leaves an already-superseded submission where it is', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const lowSid = await seedRosterEntry(db, semester.id, '111111');
      const highSid = await seedRosterEntry(db, semester.id, '222222');
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const head = await seedSubmission(
        db,
        semester.id,
        assignment.id,
        highSid.id,
        job.id,
        'f3'.repeat(32),
        2,
      );
      const old = await seedSubmission(
        db,
        semester.id,
        assignment.id,
        highSid.id,
        job.id,
        'f4'.repeat(32),
        1,
        { supersededBy: head.id },
      );

      const superseded = await attachCoSubmitter(db, old.id, semester.id, lowSid.id);

      const [row] = await db
        .select({ student_id: submissions.student_id, version_index: submissions.version_index })
        .from(submissions)
        .where(eq(submissions.id, old.id));

      // A historical row must not be promoted to the head of another lineage.
      expect(row!.student_id).toBe(highSid.id);
      expect(row!.version_index).toBe(1);
      expect(superseded).toEqual([]);

      // The person is still recorded, which is the part that must never be lost.
      const contributors = await db
        .select({ roster_entry_id: submission_contributors.roster_entry_id })
        .from(submission_contributors)
        .where(eq(submission_contributors.submission_id, old.id));
      expect(contributors.map((c) => c.roster_entry_id)).toEqual([lowSid.id]);
    });
  });

  it('declines to slot itself under a NEWER submission in the target lineage', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const lowSid = await seedRosterEntry(db, semester.id, '111111');
      const highSid = await seedRosterEntry(db, semester.id, '222222');
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // The canonical partner already has a newer submission of their own.
      await seedSubmission(db, semester.id, assignment.id, lowSid.id, job.id, 'f5'.repeat(32), 1);

      const older = await seedSubmission(
        db,
        semester.id,
        assignment.id,
        highSid.id,
        job.id,
        'f6'.repeat(32),
        1,
        { createdAt: new Date(Date.now() - 60_000) },
      );

      const superseded = await attachCoSubmitter(db, older.id, semester.id, lowSid.id);

      const [row] = await db
        .select({ student_id: submissions.student_id, version_index: submissions.version_index })
        .from(submissions)
        .where(eq(submissions.id, older.id));

      // Renumbering a version chain a grader has already seen is a product
      // decision, so the move is declined rather than half-made.
      expect(row!.student_id).toBe(highSid.id);
      expect(row!.version_index).toBe(1);
      expect(superseded).toEqual([]);
    });
  });
});
