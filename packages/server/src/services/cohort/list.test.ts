/**
 * Integration tests for listCohortSubmissions — Phase 2 protected-mode masking.
 *
 * Tests that:
 * - Real student identity never appears in items or cursors when protectedMode=true
 * - q name-search is suppressed when protectedMode=true (oracle closure)
 * - student_asc sort uses protected_index (not display_name) when protectedMode=true
 * - Non-protected mode is byte-for-byte unchanged
 */

import { describe, it, expect } from 'vitest';
import { withTestDb } from '../../../test/helpers/db.js';
import { seedContributor } from '../../../test/helpers/seed-contributor.js';
import {
  courses,
  semesters,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
  users,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { listCohortSubmissions } from './list.js';

// ---------------------------------------------------------------------------
// Seed helpers (adapted from cohort.test.ts)
// ---------------------------------------------------------------------------

async function seedCourseAndSemester(db: DrizzleDb) {
  const uid = crypto.randomUUID().slice(0, 8);
  const [course] = await db
    .insert(courses)
    .values({ name: 'CS 61A', slug: `cs61a-${uid}` })
    .returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2024,
      slug: `fa2024-${uid}`,
      display_name: 'Fall 2024',
      filename_convention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
    })
    .returning();
  return { course: course!, semester: semester! };
}

async function seedStudent(
  db: DrizzleDb,
  semesterId: string,
  sid: string,
  displayName: string,
  protectedIndex?: number,
) {
  const [entry] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid,
      display_name: displayName,
      ...(protectedIndex !== undefined && { protected_index: protectedIndex }),
    })
    .returning();
  return entry!;
}

async function seedAssignment(db: DrizzleDb, semesterId: string, label?: string) {
  const [a] = await db
    .insert(assignments)
    .values({
      semester_id: semesterId,
      assignment_id_str: `hw-${crypto.randomUUID().slice(0, 6)}`,
      label: label ?? 'HW1',
    })
    .returning();
  return a!;
}

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

async function seedIngestJob(db: DrizzleDb, semesterId: string, userId: string) {
  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semesterId, uploaded_by: userId, status: 'succeeded' })
    .returning();
  return job!;
}

/**
 * Seed a submission AND the contributor row every real submission has.
 *
 * Migration 0029 backfilled one for every pre-existing row and
 * `finalizeContributors` writes one inside the same transaction on all three
 * write paths, so a `submissions` row with no `submission_contributors` row is
 * a state production cannot reach. The free-text search goes through that table
 * now (as the `studentId` filter already did), so a fixture without one would
 * be asserting on an impossible database rather than on the search.
 *
 * `extraContributorIds` are the co-submitters who are NOT the submitter of
 * record — the people the old search could never find.
 */
async function seedSubmission(
  db: DrizzleDb,
  opts: {
    semesterId: string;
    assignmentId: string;
    studentId: string;
    ingestJobId: string;
    scoreTotal?: number;
    versionIndex?: number;
    extraContributorIds?: string[];
  },
) {
  const id = crypto.randomUUID();
  const [sub] = await db
    .insert(submissions)
    .values({
      id,
      semester_id: opts.semesterId,
      assignment_id: opts.assignmentId,
      student_id: opts.studentId,
      blob_object_key: `semesters/${opts.semesterId}/submissions/${id}/bundle.zip`,
      blob_sha256: `sha256-${id}`,
      source_filename: 'test.zip',
      ingest_job_id: opts.ingestJobId,
      version_index: opts.versionIndex ?? 1,
      score_total: opts.scoreTotal ?? 0,
      score_max_severity: 'info',
      validation_status: 'pass',
      recorder_version: '1.0.0',
    })
    .returning();

  await seedContributor(db, sub!.id, opts.semesterId, opts.studentId, {
    score: { total: opts.scoreTotal ?? 0, maxSeverity: 'info' },
  });
  for (const extra of opts.extraContributorIds ?? []) {
    await seedContributor(db, sub!.id, opts.semesterId, extra, { isSubmitter: true });
  }

  return sub!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listCohortSubmissions — protected mode', () => {
  it('masks student identity and never emits real name/sid when protected', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      // Zara gets protected_index=2, Aaron gets protected_index=1
      // student_asc in protected mode should order by protected_index: Aaron(1) first, Zara(2) second
      const zara = await seedStudent(db, semester.id, 'stu-zara', 'Zara', 2);
      const aaron = await seedStudent(db, semester.id, 'stu-aaron', 'Aaron', 1);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: zara.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: aaron.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      const res = await listCohortSubmissions(db, semester.id, {}, 'student_asc', null, 50, true);
      const names = res.items.map((i) => i.student!.display_name);
      const sids = res.items.map((i) => i.student!.sid);

      // No real names should appear
      expect(names).not.toContain('Zara');
      expect(names).not.toContain('Aaron');
      expect(sids).not.toContain('stu-zara');
      expect(sids).not.toContain('stu-aaron');

      // All names should match the placeholder pattern
      expect(names.every((n) => /^Student \d+$/.test(n))).toBe(true);
      expect(sids.every((s) => /^S\d+$/.test(s))).toBe(true);

      // student_asc in protected mode orders by protected_index, not name:
      // Aaron(index=1) comes before Zara(index=2)
      expect(res.items[0]!.student!.display_name).toBe('Student 1');
      expect(res.items[1]!.student!.display_name).toBe('Student 2');
    });
  });

  it('protected cursor carries no real name', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      // Seed 2 students so we need pagination (limit=1 → nextCursor)
      const zara = await seedStudent(db, semester.id, 'stu-zara', 'Zara', 2);
      const aaron = await seedStudent(db, semester.id, 'stu-aaron', 'Aaron', 1);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: zara.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: aaron.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      const res = await listCohortSubmissions(db, semester.id, {}, 'student_asc', null, 1, true);
      expect(res.nextCursor).not.toBeNull();

      const decoded = JSON.parse(Buffer.from(res.nextCursor!, 'base64url').toString('utf8'));
      expect(decoded.kind).toBe('protected_index');
      expect(JSON.stringify(decoded)).not.toMatch(/Zara|Aaron|stu-zara|stu-aaron/);
    });
  });

  it('ignores q name-search when protected', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      // Seed TWO students: one whose name matches the query, one who does not.
      const zara = await seedStudent(db, semester.id, 'stu-zara', 'Zara', 1);
      const bob = await seedStudent(db, semester.id, 'stu-bob', 'Bob', 2);
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: zara.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: bob.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      // q='Zara' in protected mode must NOT filter to just matching students.
      // Both submissions must be returned (ILIKE suppressed), not just Zara's.
      const res = await listCohortSubmissions(
        db,
        semester.id,
        { q: 'Zara' },
        'score_desc',
        null,
        50,
        true,
      );
      expect(res.totalCount).toBe(2);
    });
  });

  it('non-protected q search still filters correctly', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      // Two students: Zara matches query, Bob does not.
      const zara = await seedStudent(db, semester.id, 'stu-zara', 'Zara', 1);
      const bob = await seedStudent(db, semester.id, 'stu-bob', 'Bob', 2);
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: zara.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: bob.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      // In non-protected mode q='Zara' should filter to exactly 1 result.
      const res = await listCohortSubmissions(
        db,
        semester.id,
        { q: 'Zara' },
        'score_desc',
        null,
        50,
        false,
      );
      expect(res.totalCount).toBe(1);
      expect(res.items[0]!.student!.display_name).toBe('Zara');
    });
  });

  it('returns real identity when not protected', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const zara = await seedStudent(db, semester.id, 'stu-zara', 'Zara', 1);
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: zara.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      const res = await listCohortSubmissions(db, semester.id, {}, 'score_desc', null, 50, false);
      expect(res.items.map((i) => i.student!.display_name)).toContain('Zara');
      // Pre-0021 / not-yet-computed rows stay null until ingest or recompute.
      expect(res.items[0]!.total_active_ms).toBeNull();
      expect(res.items[0]!.total_idle_ms).toBeNull();
    });
  });

  it('non-protected q search still works', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const zara = await seedStudent(db, semester.id, 'stu-zara', 'Zara', 1);
      const aaron = await seedStudent(db, semester.id, 'stu-aaron', 'Aaron', 2);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: zara.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: aaron.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      const res = await listCohortSubmissions(
        db,
        semester.id,
        { q: 'Zara' },
        'score_desc',
        null,
        50,
        false,
      );
      // Only Zara matched
      expect(res.totalCount).toBe(1);
      expect(res.items[0]!.student!.display_name).toBe('Zara');
    });
  });

  it('protected cursor pagination round-trip for student_asc', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      // 3 students with explicit protected_indices
      for (let i = 1; i <= 3; i++) {
        const s = await seedStudent(db, semester.id, `stu-${i}`, `Name${i}`, i);
        await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: s.id,
          ingestJobId: job.id,
          versionIndex: i,
        });
      }

      // Page 1: limit=1
      const res1 = await listCohortSubmissions(db, semester.id, {}, 'student_asc', null, 1, true);
      expect(res1.items).toHaveLength(1);
      expect(res1.nextCursor).not.toBeNull();

      // Decode cursor and verify it's protected_index kind
      const decoded1 = JSON.parse(Buffer.from(res1.nextCursor!, 'base64url').toString('utf8'));
      expect(decoded1.kind).toBe('protected_index');

      // Page 2: using the cursor
      const { decodeCursor } = await import('./list.js');
      const cursor = decodeCursor(res1.nextCursor!);
      expect(cursor).not.toBeNull();

      const res2 = await listCohortSubmissions(db, semester.id, {}, 'student_asc', cursor, 1, true);
      expect(res2.items).toHaveLength(1);
      expect(res2.nextCursor).not.toBeNull();

      // Page 3:
      const cursor2 = decodeCursor(res2.nextCursor!);
      const res3 = await listCohortSubmissions(
        db,
        semester.id,
        {},
        'student_asc',
        cursor2,
        1,
        true,
      );
      expect(res3.items).toHaveLength(1);
      expect(res3.nextCursor).toBeNull();

      // All 3 items, no duplicates, ordered by protected_index
      const allItems = [...res1.items, ...res2.items, ...res3.items];
      expect(new Set(allItems.map((i) => i.id)).size).toBe(3);
      const indices = allItems.map((i) =>
        parseInt(i.student!.display_name.replace('Student ', '')),
      );
      expect(indices).toEqual([1, 2, 3]);
    });
  });
});

// ---------------------------------------------------------------------------
// Free-text search over CONTRIBUTORS, not just the submitter of record
// ---------------------------------------------------------------------------

/**
 * Regression suite for the defect where a grader could not find a student's
 * GROUP submission by typing that student's name.
 *
 * A group submission has one `submission_contributors` row per person but only
 * ONE `submissions.student_id` — the submitter of record. The search used to be
 * an ILIKE against the roster row reached through that scalar column, so it
 * only ever matched the submitter. And since `student_id` is settled
 * deterministically on the lowest co-submitter SID (`ingest/dedup.ts`), the
 * same partner was unfindable on every search rather than on a random half of
 * them: the grader got a consistent "that student has no submission" for work
 * that was sitting in the system under someone else's name.
 */
describe('listCohortSubmissions — free-text search spans contributors', () => {
  it('finds a group submission by a partner who is NOT the submitter of record', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      // Ada sorts lower on sid, so she is the submitter of record; Grace is the
      // partner the old predicate could never reach.
      const ada = await seedStudent(db, semester.id, '100001', 'Ada Lovelace', 1);
      const grace = await seedStudent(db, semester.id, '100002', 'Grace Hopper', 2);

      const group = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: ada.id,
        ingestJobId: job.id,
        extraContributorIds: [grace.id],
      });

      const res = await listCohortSubmissions(
        db,
        semester.id,
        { q: 'Grace' },
        'score_desc',
        null,
        50,
        false,
      );

      expect(res.items.map((i) => i.id)).toEqual([group.id]);
      // The count must agree with the page, or the pager reports a total it can
      // never reach.
      expect(res.totalCount).toBe(1);
      // The row is still rendered under its submitter of record — the search
      // widened, the projection did not.
      expect(res.items[0]!.student!.display_name).toBe('Ada Lovelace');
      expect(res.items[0]!.contributors.map((c) => c.student!.display_name).sort()).toEqual([
        'Ada Lovelace',
        'Grace Hopper',
      ]);
    });
  });

  it("finds a group submission by a partner's SID", async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const ada = await seedStudent(db, semester.id, '100001', 'Ada Lovelace', 1);
      const grace = await seedStudent(db, semester.id, '200002', 'Grace Hopper', 2);

      const group = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: ada.id,
        ingestJobId: job.id,
        extraContributorIds: [grace.id],
      });

      const res = await listCohortSubmissions(
        db,
        semester.id,
        { q: '200002' },
        'score_desc',
        null,
        50,
        false,
      );

      expect(res.items.map((i) => i.id)).toEqual([group.id]);
      expect(res.totalCount).toBe(1);
    });
  });

  it('still finds a solo submission by its submitter of record', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const ada = await seedStudent(db, semester.id, '100001', 'Ada Lovelace', 1);
      const bob = await seedStudent(db, semester.id, '100002', 'Bob Smith', 2);

      const adaSub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: ada.id,
        ingestJobId: job.id,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: bob.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      const res = await listCohortSubmissions(
        db,
        semester.id,
        { q: 'Ada' },
        'score_desc',
        null,
        50,
        false,
      );

      expect(res.items.map((i) => i.id)).toEqual([adaSub.id]);
      expect(res.totalCount).toBe(1);
    });
  });

  it('does not match a roster student who contributed to nothing', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const ada = await seedStudent(db, semester.id, '100001', 'Ada Lovelace', 1);
      const grace = await seedStudent(db, semester.id, '100002', 'Grace Hopper', 2);
      // On the roster, contributor to nothing. Widening the search must not
      // turn "enrolled" into "has a submission".
      await seedStudent(db, semester.id, '100003', 'Mallory Quinn', 3);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: ada.id,
        ingestJobId: job.id,
        extraContributorIds: [grace.id],
      });

      const res = await listCohortSubmissions(
        db,
        semester.id,
        { q: 'Mallory' },
        'score_desc',
        null,
        50,
        false,
      );

      expect(res.items).toHaveLength(0);
      expect(res.totalCount).toBe(0);
    });
  });

  it('a submission is returned ONCE even when several contributors match', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      // Both surnames contain 'Hopper', so BOTH contributor rows match the
      // pattern. An EXISTS semi-join collapses that to one row; a plain join
      // would have emitted two and inflated the page and the count.
      const one = await seedStudent(db, semester.id, '100001', 'Grace Hopper', 1);
      const two = await seedStudent(db, semester.id, '100002', 'Dennis Hopper', 2);

      const group = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: one.id,
        ingestJobId: job.id,
        extraContributorIds: [two.id],
      });

      const res = await listCohortSubmissions(
        db,
        semester.id,
        { q: 'Hopper' },
        'score_desc',
        null,
        50,
        false,
      );

      expect(res.items.map((i) => i.id)).toEqual([group.id]);
      expect(res.totalCount).toBe(1);
    });
  });

  it('pages a contributor-matched result set exactly once per row', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const grace = await seedStudent(db, semester.id, '900001', 'Grace Hopper', 99);

      // Five group submissions, each with a DIFFERENT submitter of record and
      // Grace as the non-canonical partner. Identical scores on purpose: the
      // keyset tiebreak on `id` is then the only thing separating them, which
      // is the shape that both dropped AND re-served rows before the
      // microsecond-cursor fix.
      const expectedIds = new Set<string>();
      for (let i = 1; i <= 5; i++) {
        const partner = await seedStudent(db, semester.id, `10000${i}`, `Partner ${i}`, i);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: partner.id,
          ingestJobId: job.id,
          scoreTotal: 7,
          versionIndex: i,
          extraContributorIds: [grace.id],
        });
        expectedIds.add(sub.id);
      }

      const { decodeCursor } = await import('./list.js');

      for (const sort of ['score_desc', 'ingested_desc', 'student_asc'] as const) {
        const seen: string[] = [];
        let cursor = null as ReturnType<typeof decodeCursor>;
        // limit=2 over 5 rows: three pages, the last one short.
        for (let page = 0; page < 10; page++) {
          const res = await listCohortSubmissions(
            db,
            semester.id,
            { q: 'Grace' },
            sort,
            cursor,
            2,
            false,
          );
          expect(res.totalCount).toBe(5);
          seen.push(...res.items.map((i) => i.id));
          if (res.nextCursor === null) break;
          cursor = decodeCursor(res.nextCursor);
          expect(cursor).not.toBeNull();
        }

        // Every row exactly once — no drops, no duplicates.
        expect(seen).toHaveLength(5);
        expect(new Set(seen)).toEqual(expectedIds);
      }
    });
  });

  it('protected mode still refuses to narrow on a PARTNER name (oracle closure)', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const ada = await seedStudent(db, semester.id, '100001', 'Ada Lovelace', 1);
      const grace = await seedStudent(db, semester.id, '100002', 'Grace Hopper', 2);
      const bob = await seedStudent(db, semester.id, '100003', 'Bob Smith', 3);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: ada.id,
        ingestJobId: job.id,
        extraContributorIds: [grace.id],
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: bob.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      // Widening the search to contributors must not widen the oracle: a
      // protected principal typing a real partner name must learn nothing from
      // which rows come back, so the predicate stays suppressed entirely.
      const res = await listCohortSubmissions(
        db,
        semester.id,
        { q: 'Grace' },
        'score_desc',
        null,
        50,
        true,
      );
      expect(res.totalCount).toBe(2);
      expect(res.items).toHaveLength(2);
      expect(JSON.stringify(res.items)).not.toMatch(/Grace|Ada|Bob|Lovelace|Hopper|Smith/);
    });
  });
});
