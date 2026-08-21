/**
 * Integration tests for cross-flag participant masking — Phase 5 protected-mode.
 *
 * Tests that:
 * - Participant student identity is masked when protectedMode=true
 * - Real identity appears when protectedMode=false
 *
 * Plus the S20 exclusion register (`listCrossScopeExclusions`): what was NOT
 * compared, and why. Same masking contract, because it names the same people;
 * and the same D9 contract, because a member with no owning roster entry must
 * still be listed rather than dropped.
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
  cross_flags,
  cross_flag_exclusions,
  cross_flag_participants,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { listCrossFlags, listCrossScopeExclusions } from './list.js';

// ---------------------------------------------------------------------------
// Seed helpers
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

async function seedAssignment(db: DrizzleDb, semesterId: string) {
  const [a] = await db
    .insert(assignments)
    .values({
      semester_id: semesterId,
      assignment_id_str: `hw-${crypto.randomUUID().slice(0, 6)}`,
      label: 'HW1',
    })
    .returning();
  return a!;
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
      score_total: 0,
      score_max_severity: 'info',
      validation_status: 'pass',
      recorder_version: '1.0.0',
    })
    .returning();
  return sub!;
}

async function seedCrossFlag(db: DrizzleDb, semesterId: string, submissionIds: string[]) {
  const [flag] = await db
    .insert(cross_flags)
    .values({
      semester_id: semesterId,
      heuristic_id: 'paste-similarity',
      severity: 'high',
      confidence: 0.95,
      heuristic_config_version: 1,
    })
    .returning();

  for (const subId of submissionIds) {
    await db.insert(cross_flag_participants).values({
      cross_flag_id: flag!.id,
      submission_id: subId,
    });
  }

  return flag!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listCrossFlags — protected mode participant masking', () => {
  it('masks participant student identity when protectedMode=true', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const alice = await seedStudent(db, semester.id, 'stu-alice', 'Alice Zhao', 3);
      const bob = await seedStudent(db, semester.id, 'stu-bob', 'Bob Smith', 7);

      const subAlice = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: alice.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      const subBob = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: bob.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      await seedCrossFlag(db, semester.id, [subAlice.id, subBob.id]);

      const result = await listCrossFlags(db, semester.id, {}, null, 50, true);
      expect(result.items).toHaveLength(1);

      const participants = result.items[0]!.participants;
      expect(participants).toHaveLength(2);

      const names = participants.map((p) => p.student!.display_name);
      const sids = participants.map((p) => p.student!.sid);

      // Real names must NOT appear
      expect(names).not.toContain('Alice Zhao');
      expect(names).not.toContain('Bob Smith');
      expect(sids).not.toContain('stu-alice');
      expect(sids).not.toContain('stu-bob');

      // Names must match placeholder pattern
      expect(names.every((n) => /^Student \d+$/.test(n))).toBe(true);
      // SIDs must start with S
      expect(sids.every((s) => /^S\d+$/.test(s))).toBe(true);

      // Protected indices should correspond (alice=3, bob=7)
      expect(names).toContain('Student 3');
      expect(names).toContain('Student 7');
      expect(sids).toContain('S3');
      expect(sids).toContain('S7');
    });
  });

  it('returns real participant identity when protectedMode=false', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const alice = await seedStudent(db, semester.id, 'stu-alice', 'Alice Zhao', 3);
      const subAlice = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: alice.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      await seedCrossFlag(db, semester.id, [subAlice.id]);

      const result = await listCrossFlags(db, semester.id, {}, null, 50, false);
      expect(result.items).toHaveLength(1);

      const participants = result.items[0]!.participants;
      expect(participants).toHaveLength(1);
      expect(participants[0]!.student!.display_name).toBe('Alice Zhao');
      expect(participants[0]!.student!.sid).toBe('stu-alice');
    });
  });
});

// ---------------------------------------------------------------------------
// The exclusion register (spec S20 / §6 Rule 3)
// ---------------------------------------------------------------------------

const COMMIT_KEY = `repository:assumed-single ${'a1'.repeat(20)}`;

async function seedExclusion(db: DrizzleDb, semesterId: string, submissionIds: string[]) {
  const [row] = await db
    .insert(cross_flag_exclusions)
    .values({
      semester_id: semesterId,
      reason: 'same_repository_lineage',
      submission_ids: [...submissionIds].sort(),
      shared_commits: [COMMIT_KEY],
      excluded_pair_count: (submissionIds.length * (submissionIds.length - 1)) / 2,
    })
    .returning();
  return row!;
}

describe('listCrossScopeExclusions', () => {
  it('returns the register with each member resolved to a name and a filename', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const alice = await seedStudent(db, semester.id, 'stu-alice', 'Alice Zhao', 3);
      const bob = await seedStudent(db, semester.id, 'stu-bob', 'Bob Smith', 7);
      const subAlice = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: alice.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      const subBob = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: bob.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      await seedExclusion(db, semester.id, [subAlice.id, subBob.id]);

      const rows = await listCrossScopeExclusions(db, semester.id, {}, false);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toBe('same_repository_lineage');
      expect(rows[0]!.excluded_pair_count).toBe(1);
      expect(rows[0]!.shared_commits).toEqual([COMMIT_KEY]);
      expect(rows[0]!.members.map((m) => m.submission_id).sort()).toEqual(
        [subAlice.id, subBob.id].sort(),
      );
      expect(rows[0]!.members.map((m) => m.student!.display_name).sort()).toEqual([
        'Alice Zhao',
        'Bob Smith',
      ]);
      expect(rows[0]!.members.every((m) => m.source_filename === 'test.zip')).toBe(true);
      expect(rows[0]!.members.every((m) => m.assignment.id === assignment.id)).toBe(true);
    });
  });

  it('masks member identity when protectedMode=true', async () => {
    // The register names the same people the findings do. A view that protects
    // identities in one and not the other protects neither.
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const alice = await seedStudent(db, semester.id, 'stu-alice', 'Alice Zhao', 3);
      const bob = await seedStudent(db, semester.id, 'stu-bob', 'Bob Smith', 7);
      const subAlice = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: alice.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      const subBob = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: bob.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      await seedExclusion(db, semester.id, [subAlice.id, subBob.id]);

      const rows = await listCrossScopeExclusions(db, semester.id, {}, true);
      const names = rows[0]!.members.map((m) => m.student!.display_name);
      const sids = rows[0]!.members.map((m) => m.student!.sid);

      expect(names).not.toContain('Alice Zhao');
      expect(names).not.toContain('Bob Smith');
      expect(sids).not.toContain('stu-alice');
      expect(sids).not.toContain('stu-bob');
    });
  });

  it('lists a member with no owning roster entry rather than dropping it (D9)', async () => {
    // The group-submission case: `submissions.student_id` is null, so there is
    // no name to show. Dropping the member would render a two-party exclusion as
    // one-party — evidence of a withheld comparison disappearing with no error,
    // the exact defect the LEFT join in `fetchParticipants` exists to prevent.
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const alice = await seedStudent(db, semester.id, 'stu-alice', 'Alice Zhao', 3);
      const subAlice = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: alice.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      const groupSubId = crypto.randomUUID();
      await db.insert(submissions).values({
        id: groupSubId,
        semester_id: semester.id,
        assignment_id: assignment.id,
        student_id: null,
        group_key: `grp-${groupSubId}`,
        blob_object_key: `semesters/${semester.id}/submissions/${groupSubId}/bundle.zip`,
        blob_sha256: `sha256-${groupSubId}`,
        source_filename: 'partners_proj1.zip',
        ingest_job_id: job.id,
        version_index: 1,
        score_total: 0,
        score_max_severity: 'info',
        validation_status: 'pass',
        recorder_version: '1.0.0',
      });

      await seedExclusion(db, semester.id, [subAlice.id, groupSubId]);

      const rows = await listCrossScopeExclusions(db, semester.id, {}, false);

      expect(rows[0]!.members).toHaveLength(2);
      const unnamed = rows[0]!.members.find((m) => m.submission_id === groupSubId)!;
      expect(unnamed.student).toBeNull();
      expect(unnamed.source_filename).toBe('partners_proj1.zip');
    });
  });

  it('filters by submission_id, and returns nothing for an uninvolved submission', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const alice = await seedStudent(db, semester.id, 'stu-alice', 'Alice Zhao', 3);
      const bob = await seedStudent(db, semester.id, 'stu-bob', 'Bob Smith', 7);
      const carol = await seedStudent(db, semester.id, 'stu-carol', 'Carol Lin', 9);
      const subAlice = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: alice.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      const subBob = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: bob.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });
      const subCarol = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: carol.id,
        ingestJobId: job.id,
        versionIndex: 3,
      });

      await seedExclusion(db, semester.id, [subAlice.id, subBob.id]);

      expect(
        await listCrossScopeExclusions(db, semester.id, { submissionId: subAlice.id }, false),
      ).toHaveLength(1);
      expect(
        await listCrossScopeExclusions(db, semester.id, { submissionId: subCarol.id }, false),
      ).toHaveLength(0);
    });
  });

  it('ignores the heuristic_id filter — one exclusion covers every cross-heuristic', async () => {
    // Both `paste_shared_across_students` and `editing_pattern_clone` consume
    // the SAME partition, so narrowing the findings to one of them does not
    // narrow what was withheld. Hiding the register behind a heuristic filter
    // would let a grader filter their way into an unexplained silence.
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      const user = await seedUser(db);
      const job = await seedIngestJob(db, semester.id, user.id);
      const assignment = await seedAssignment(db, semester.id);

      const alice = await seedStudent(db, semester.id, 'stu-alice', 'Alice Zhao', 3);
      const bob = await seedStudent(db, semester.id, 'stu-bob', 'Bob Smith', 7);
      const subAlice = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: alice.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      const subBob = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: bob.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      await seedExclusion(db, semester.id, [subAlice.id, subBob.id]);

      expect(
        await listCrossScopeExclusions(
          db,
          semester.id,
          { heuristicId: 'editing_pattern_clone', severityMin: 'high' },
          false,
        ),
      ).toHaveLength(1);
    });
  });

  it('is empty for a semester whose register holds nothing', async () => {
    await withTestDb(async (db) => {
      const { semester } = await seedCourseAndSemester(db);
      expect(await listCrossScopeExclusions(db, semester.id, {}, false)).toEqual([]);
    });
  });
});
