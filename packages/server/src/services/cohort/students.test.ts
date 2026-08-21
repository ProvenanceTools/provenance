/**
 * Integration tests for listStudents — Phase 3 protected-mode masking.
 *
 * Tests that:
 * - Real student identity never appears in items or cursors when protectedMode=true
 * - q name-search is suppressed when protectedMode=true (oracle closure)
 * - student_asc sort uses protected_index (not display_name) when protectedMode=true
 * - email is null when protectedMode=true
 * - Non-protected mode is unchanged (real identity, real email)
 */

import { describe, it, expect } from 'vitest';
import { withTestDb } from '../../../test/helpers/db.js';
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
import { listStudents, decodeStudentCursor } from './students.js';
import { seedContributor } from '../../../test/helpers/seed-contributor.js';

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
  email?: string,
) {
  const [entry] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid,
      display_name: displayName,
      email: email ?? null,
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

async function seedSubmission(
  db: DrizzleDb,
  opts: {
    semesterId: string;
    assignmentId: string;
    studentId: string;
    ingestJobId: string;
    scoreTotal?: number;
    versionIndex?: number;
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

  // Every real submission has a contributor row (migration 0029's backfill for
  // pre-existing rows, `finalizeContributors` for every write path since), and
  // the rollup this file tests reads that table. A fixture without one is
  // describing a state production cannot reach.
  //
  // The contributor carries the submission's OWN score, which is what both the
  // backfill and `scoreContributors` produce for a SOLE contributor: with one
  // contributor there is no partner to protect, so they own the whole scope
  // score. Leaving it at zero here would make every score_sum assertion read 0.
  await seedContributor(db, sub!.id, opts.semesterId, opts.studentId, {
    score: { total: opts.scoreTotal ?? 0, maxSeverity: 'info' },
  });

  return sub!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listStudents — protected mode', () => {
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

      const res = await listStudents(db, semester.id, {}, 'student_asc', null, 50, true);
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

      // student_asc in protected mode orders by protected_index, not display_name:
      // Aaron(index=1) comes before Zara(index=2)
      expect(res.items[0]!.student!.display_name).toBe('Student 1');
      expect(res.items[1]!.student!.display_name).toBe('Student 2');
    });
  });

  it('email is null when protected', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const zara = await seedStudent(db, semester.id, 'stu-zara', 'Zara', 1, 'zara@berkeley.edu');

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: zara.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      const res = await listStudents(db, semester.id, {}, 'student_asc', null, 50, true);
      expect(res.items).toHaveLength(1);
      expect(res.items[0]!.student.email).toBeNull();
    });
  });

  it('protected cursor carries no real name', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      // Seed 2 students so pagination (limit=1 → nextCursor) triggers
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

      const res = await listStudents(db, semester.id, {}, 'student_asc', null, 1, true);
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
      // Both students must be returned (ILIKE suppressed), not just Zara's.
      const res = await listStudents(
        db,
        semester.id,
        { q: 'Zara' },
        'score_sum_desc',
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

      // In non-protected mode q='Zara' should filter to exactly 1 student.
      const res = await listStudents(
        db,
        semester.id,
        { q: 'Zara' },
        'score_sum_desc',
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

      const zara = await seedStudent(db, semester.id, 'stu-zara', 'Zara', 1, 'zara@berkeley.edu');
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: zara.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      const res = await listStudents(db, semester.id, {}, 'score_sum_desc', null, 50, false);
      expect(res.items.map((i) => i.student!.display_name)).toContain('Zara');
      expect(res.items.map((i) => i.student!.sid)).toContain('stu-zara');
      expect(res.items[0]!.student.email).toBe('zara@berkeley.edu');
    });
  });

  it('worst_submission is also masked when protected', async () => {
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
        scoreTotal: 10,
      });

      const res = await listStudents(db, semester.id, {}, 'score_sum_desc', null, 50, true);
      expect(res.items).toHaveLength(1);
      const worstSub = res.items[0]!.worst_submission;
      expect(worstSub.student!.display_name).not.toBe('Zara');
      expect(worstSub.student!.display_name).toMatch(/^Student \d+$/);
    });
  });

  it('cursor round-trip delivers correct page 2 and sid is masked in protected mode', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      // Seed 3 students with explicit protected_indices 1, 2, 3.
      for (let i = 1; i <= 3; i++) {
        const s = await seedStudent(db, semester.id, `stu-real-${i}`, `RealName${i}`, i);
        await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: s.id,
          ingestJobId: job.id,
          versionIndex: i,
        });
      }

      // Page 1: limit=1 with student_asc in protected mode.
      const res1 = await listStudents(db, semester.id, {}, 'student_asc', null, 1, true);
      expect(res1.items).toHaveLength(1);
      expect(res1.items[0]!.student!.display_name).toBe('Student 1');
      // sid must be masked (starts with 'S', not the raw 'stu-real-1')
      expect(res1.items[0]!.student!.sid).toMatch(/^S/);
      expect(res1.items[0]!.student!.sid).not.toBe('stu-real-1');
      // worst_submission.student!.sid is also masked
      expect(res1.items[0]!.worst_submission.student!.sid).toMatch(/^S/);
      expect(res1.nextCursor).not.toBeNull();

      // Feed cursor into page 2 — should start at Student 2.
      const cursor1 = decodeStudentCursor(res1.nextCursor!);
      expect(cursor1).not.toBeNull();
      expect(cursor1!.kind).toBe('protected_index');

      const res2 = await listStudents(db, semester.id, {}, 'student_asc', cursor1, 1, true);
      expect(res2.items).toHaveLength(1);
      expect(res2.items[0]!.student!.display_name).toBe('Student 2');
      expect(res2.items[0]!.student!.sid).toMatch(/^S/);

      // No overlap between pages.
      expect(res1.items[0]!.student!.sid).not.toBe(res2.items[0]!.student!.sid);
    });
  });

  it('protected student_asc sorts numerically: Student 2 before Student 10', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      // Seed two students with protected_index 10 and 2 (inserted in that order to
      // confirm the sort is not insertion-order).
      const s10 = await seedStudent(db, semester.id, 'stu-ten', 'Ten', 10);
      const s2 = await seedStudent(db, semester.id, 'stu-two', 'Two', 2);
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: s10.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: s2.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      const res = await listStudents(db, semester.id, {}, 'student_asc', null, 50, true);
      expect(res.items).toHaveLength(2);
      // Zero-padded numeric sort: 2 comes before 10 (not lexicographic "10" < "2").
      expect(res.items[0]!.student!.display_name).toBe('Student 2');
      expect(res.items[1]!.student!.display_name).toBe('Student 10');
    });
  });
});
