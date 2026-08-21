/**
 * buildFacets unit tests — protected mode q-oracle guard.
 *
 * Verifies that when protectedMode=true, the `q` filter is NOT applied as an
 * ILIKE on display_name/sid (that would be a name-to-label oracle attack).
 *
 * Seeding: two students in the same semester. One has display_name 'Zara'.
 * buildFacets({ q: 'Zara' }, protectedMode=true) should include BOTH students
 * in the facet counts (q is ignored).
 * buildFacets({ q: 'Zara' }, protectedMode=false) should include only 'Zara'.
 */

import { vi, describe, it, expect } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { withTestDb } from '../../../test/helpers/db.js';
import {
  users,
  courses,
  semesters,
  memberships,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
} from '../../db/schema.js';
import { buildFacets } from './facets.js';

async function seedBase(db: Parameters<typeof buildFacets>[0]) {
  const uid = crypto.randomUUID().slice(0, 8);
  const [user] = await db
    .insert(users)
    .values({
      google_subject: `sub-${uid}`,
      email: `user-${uid}@berkeley.edu`,
      display_name: 'Test User',
    })
    .returning();

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
      filename_convention: '(?<sid>[a-z0-9]+)_hw',
    })
    .returning();

  await db.insert(memberships).values({
    user_id: user!.id,
    semester_id: semester!.id,
    role: 'admin',
    granted_by: user!.id,
  });

  const [assignment] = await db
    .insert(assignments)
    .values({
      semester_id: semester!.id,
      assignment_id_str: 'hw1',
      label: 'HW1',
    })
    .returning();

  const [ingestJob] = await db
    .insert(ingest_jobs)
    .values({
      semester_id: semester!.id,
      uploaded_by: user!.id,
      status: 'succeeded',
    })
    .returning();

  return { semester: semester!, assignment: assignment!, ingestJob: ingestJob! };
}

async function seedStudent(
  db: Parameters<typeof buildFacets>[0],
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
      protected_index: protectedIndex ?? null,
    })
    .returning();
  return entry!;
}

async function seedSubmission(
  db: Parameters<typeof buildFacets>[0],
  semesterId: string,
  assignmentId: string,
  studentId: string,
  ingestJobId: string,
) {
  const id = crypto.randomUUID();
  const [sub] = await db
    .insert(submissions)
    .values({
      id,
      semester_id: semesterId,
      assignment_id: assignmentId,
      student_id: studentId,
      blob_object_key: `blobs/${id}`,
      blob_sha256: `sha-${id}`,
      source_filename: 'test.zip',
      ingest_job_id: ingestJobId,
      version_index: 1,
      score_total: 0,
      score_max_severity: 'info',
      validation_status: 'pass',
    })
    .returning();
  return sub!;
}

describe('buildFacets — protected mode q-oracle guard', () => {
  it('protected: q filter is ignored → facets include all submissions', async () => {
    await withTestDb(async (db) => {
      const { semester, assignment, ingestJob } = await seedBase(db);

      const zaraStudent = await seedStudent(db, semester.id, 'stu001', 'Zara Ahmed', 1);
      const bobStudent = await seedStudent(db, semester.id, 'stu002', 'Bob Smith', 2);

      await seedSubmission(db, semester.id, assignment.id, zaraStudent.id, ingestJob.id);
      await seedSubmission(db, semester.id, assignment.id, bobStudent.id, ingestJob.id);

      // With protectedMode=true, q='Zara' must NOT filter → both submissions appear
      // in the by_assignment facet for this assignment.
      const facets = await buildFacets(db, semester.id, { q: 'Zara' }, true);

      const assignmentFacet = facets.by_assignment.find((a) => a.id === assignment.id);
      expect(assignmentFacet).toBeDefined();
      // Both submissions must appear (q was ignored).
      expect(assignmentFacet!.count).toBe(2);
    });
  });

  it('non-protected: q filter applied → facets show only matching submissions', async () => {
    await withTestDb(async (db) => {
      const { semester, assignment, ingestJob } = await seedBase(db);

      const zaraStudent = await seedStudent(db, semester.id, 'stu003', 'Zara Ahmed', 3);
      const bobStudent = await seedStudent(db, semester.id, 'stu004', 'Bob Smith', 4);

      await seedSubmission(db, semester.id, assignment.id, zaraStudent.id, ingestJob.id);
      await seedSubmission(db, semester.id, assignment.id, bobStudent.id, ingestJob.id);

      // With protectedMode=false, q='Zara' DOES filter → only Zara's submission.
      const facets = await buildFacets(db, semester.id, { q: 'Zara' }, false);

      const assignmentFacet = facets.by_assignment.find((a) => a.id === assignment.id);
      expect(assignmentFacet).toBeDefined();
      // Only Zara's submission.
      expect(assignmentFacet!.count).toBe(1);
    });
  });
});
