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
import { seedContributor } from '../../../test/helpers/seed-contributor.js';
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

/**
 * Seed a submission AND the contributor row every real submission has (0029
 * backfill + `finalizeContributors` on all three write paths). The facet `q`
 * predicate goes through `submission_contributors` now, so a fixture without
 * one would be describing a state production cannot reach.
 *
 * `extraContributorIds` are co-submitters who are NOT the submitter of record.
 */
async function seedSubmission(
  db: Parameters<typeof buildFacets>[0],
  semesterId: string,
  assignmentId: string,
  studentId: string,
  ingestJobId: string,
  extraContributorIds: string[] = [],
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

  await seedContributor(db, sub!.id, semesterId, studentId);
  for (const extra of extraContributorIds) {
    await seedContributor(db, sub!.id, semesterId, extra);
  }

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

  /**
   * The facets render beside the cohort list. If the facet `q` still matched
   * only the submitter of record while the list matched any contributor, a
   * grader searching a partner's name would see one row in the list under a
   * facet that counted zero — the count contradicting the rows beneath it.
   */
  it('counts a group submission when the search matches a NON-submitter partner', async () => {
    await withTestDb(async (db) => {
      const { semester, assignment, ingestJob } = await seedBase(db);

      const ada = await seedStudent(db, semester.id, '100001', 'Ada Lovelace', 1);
      const grace = await seedStudent(db, semester.id, '100002', 'Grace Hopper', 2);
      const bob = await seedStudent(db, semester.id, '100003', 'Bob Smith', 3);

      // Ada submits; Grace is the partner who never appears in student_id.
      await seedSubmission(db, semester.id, assignment.id, ada.id, ingestJob.id, [grace.id]);
      // An unrelated solo submission that must NOT be counted.
      await seedSubmission(db, semester.id, assignment.id, bob.id, ingestJob.id);

      const facets = await buildFacets(db, semester.id, { q: 'Grace' }, false);

      const assignmentFacet = facets.by_assignment.find((a) => a.id === assignment.id);
      expect(assignmentFacet).toBeDefined();
      expect(assignmentFacet!.count).toBe(1);
      // Counted exactly once despite two contributor rows on the submission —
      // the EXISTS semi-join does not fan COUNT(*) out.
      expect(facets.by_validation.pass).toBe(1);
      expect(facets.by_severity.info).toBe(1);
    });
  });

  it('does not count anything for a roster student who contributed to nothing', async () => {
    await withTestDb(async (db) => {
      const { semester, assignment, ingestJob } = await seedBase(db);

      const ada = await seedStudent(db, semester.id, '100001', 'Ada Lovelace', 1);
      const grace = await seedStudent(db, semester.id, '100002', 'Grace Hopper', 2);
      await seedStudent(db, semester.id, '100003', 'Mallory Quinn', 3);

      await seedSubmission(db, semester.id, assignment.id, ada.id, ingestJob.id, [grace.id]);

      const facets = await buildFacets(db, semester.id, { q: 'Mallory' }, false);

      expect(facets.by_assignment).toHaveLength(0);
      expect(facets.by_validation.pass).toBe(0);
    });
  });
});
