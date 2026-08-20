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
