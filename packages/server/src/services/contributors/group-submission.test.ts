/**
 * A GROUP submission through every read path — and a SOLO one beside it,
 * unchanged.
 *
 * D9 made `submission_contributors` the live path. This file drives one
 * database containing both shapes through the cohort list, the submission
 * summary, the facets, the students rollup and the assignment stats, and
 * asserts the two properties the cut-over stands on:
 *
 *  1. **Solo is unaffected.** Every rewritten read path returns, for a solo
 *     submission, exactly what it returned before — one named student, the same
 *     counts, the same score. The 0029 backfill gives each existing submission
 *     exactly one contributor, so every new join is 1:1 for them.
 *  2. **A group appears ONCE with N contributors**, not N times, and each
 *     partner is scored from their OWN findings.
 *
 * Plus the two hazards the old schema hid:
 *
 *  - a submission with NO single owning student must not 404 the summary and
 *    must not vanish from the cohort list;
 *  - the version sequence and the supersede chain must still be correct for
 *    both shapes.
 */

import { vi, describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import {
  courses,
  semesters,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
  submission_contributors,
  flags,
  users,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { listCohortSubmissions, decodeCursor, type CohortCursor } from '../cohort/list.js';
import { listStudents } from '../cohort/students.js';
import { buildFacets } from '../cohort/facets.js';
import { listAssignments } from '../cohort/assignments.js';
import { applyContributorScores } from './contributor-scores.js';
import { rosterContributorKey } from './store-contributors.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Assert a promise rejects with a specific Postgres constraint violation.
 *
 * Drizzle wraps the driver error, so the constraint name is on the CAUSE, not
 * in `error.message` — matching the message would pass on ANY failed insert and
 * prove nothing about which invariant fired.
 */
async function expectConstraintViolation(
  run: () => Promise<unknown>,
  constraintName: string,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected a ${constraintName} violation, but the statement succeeded`).toBeDefined();
  const cause = (caught as { cause?: { constraint_name?: string } }).cause;
  const name = cause?.constraint_name ?? (caught as { constraint_name?: string }).constraint_name;
  expect(name).toBe(constraintName);
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedWorld(db: DrizzleDb) {
  const uid = crypto.randomUUID().slice(0, 8);
  const [course] = await db
    .insert(courses)
    .values({ name: 'CS 61B', slug: `cs61b-${uid}` })
    .returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2026,
      slug: `fa2026-${uid}`,
      display_name: 'Fall 2026',
      filename_convention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
    })
    .returning();
  const [user] = await db
    .insert(users)
    .values({
      google_subject: `sub-${uid}`,
      email: `staff-${uid}@berkeley.edu`,
      display_name: 'Staff',
    })
    .returning();
  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semester!.id, uploaded_by: user!.id, status: 'succeeded' })
    .returning();
  const [assignment] = await db
    .insert(assignments)
    .values({ semester_id: semester!.id, assignment_id_str: `proj-${uid}`, label: 'Project 1' })
    .returning();

  return { semester: semester!, job: job!, assignment: assignment! };
}

async function seedStudent(db: DrizzleDb, semesterId: string, sid: string, name: string) {
  const [entry] = await db
    .insert(roster_entries)
    .values({ semester_id: semesterId, sid, display_name: name })
    .returning();
  return entry!;
}

async function seedSubmission(
  db: DrizzleDb,
  opts: {
    semesterId: string;
    assignmentId: string;
    ingestJobId: string;
    studentId: string | null;
    groupKey?: string | null;
    versionIndex?: number;
    scoreTotal?: number;
    maxSeverity?: string;
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
      // `groupKey: null` EXPLICITLY means "no lineage at all" — distinct from
      // omitting it, which gets a generated one. The distinction is the point of
      // the no-lineage test.
      group_key:
        opts.studentId === null
          ? opts.groupKey === undefined
            ? `grp-${id}`
            : opts.groupKey
          : null,
      blob_object_key: `semesters/${opts.semesterId}/submissions/${id}/bundle.zip`,
      blob_sha256: `sha256-${id}`,
      source_filename: 'test.zip',
      ingest_job_id: opts.ingestJobId,
      version_index: opts.versionIndex ?? 1,
      score_total: opts.scoreTotal ?? 0,
      score_max_severity: opts.maxSeverity ?? 'info',
      validation_status: 'pass',
      recorder_version: '1.0.0',
    })
    .returning();
  return sub!;
}

/** A roster-side contributor, as the 0029 backfill and the ingest path write. */
async function addContributor(
  db: DrizzleDb,
  submissionId: string,
  semesterId: string,
  rosterEntryId: string,
  score?: { total: number; maxSeverity: string },
) {
  await db.insert(submission_contributors).values({
    submission_id: submissionId,
    semester_id: semesterId,
    contributor_key: rosterContributorKey(rosterEntryId),
    kind: 'roster',
    roster_entry_id: rosterEntryId,
    is_submitter: true,
    score_total: score?.total ?? 0,
    score_max_severity: score?.maxSeverity ?? 'info',
  });
}

async function addFlag(
  db: DrizzleDb,
  submissionId: string,
  semesterId: string,
  contributorKey: string,
  severity: string,
  contribution: number,
) {
  await db.insert(flags).values({
    submission_id: submissionId,
    semester_id: semesterId,
    heuristic_id: `h-${severity}-${contribution}`,
    severity,
    confidence: 1,
    weight_at_compute: 1,
    score_contribution: contribution,
    contributor_key: contributorKey,
    heuristic_config_version: 1,
  });
}

// ---------------------------------------------------------------------------
// 1. Solo is unaffected
// ---------------------------------------------------------------------------

describe('solo submissions after the contributor cut-over', () => {
  it('reads identically through every rewritten read path', async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);
      const alice = await seedStudent(db, semester.id, '111111', 'Alice');
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: alice.id,
        scoreTotal: 8,
        maxSeverity: 'high',
      });
      // The 0029 backfill shape: a single contributor owning the whole score.
      await addContributor(db, sub.id, semester.id, alice.id, {
        total: 8,
        maxSeverity: 'high',
      });

      // Cohort list: one row, named student, and exactly ONE contributor who is
      // the same person. This is the shape every pre-existing row has.
      const list = await listCohortSubmissions(db, semester.id, {}, 'score_desc', null, 50, false);
      expect(list.items).toHaveLength(1);
      expect(list.totalCount).toBe(1);
      expect(list.items[0]!.student).toEqual({
        id: alice.id,
        sid: '111111',
        display_name: 'Alice',
      });
      expect(list.items[0]!.contributors).toHaveLength(1);
      expect(list.items[0]!.contributors[0]!.student).toEqual({
        id: alice.id,
        sid: '111111',
        display_name: 'Alice',
      });

      // The studentId filter still finds it.
      const filtered = await listCohortSubmissions(
        db,
        semester.id,
        { studentId: alice.id },
        'score_desc',
        null,
        50,
        false,
      );
      expect(filtered.items).toHaveLength(1);
      expect(filtered.totalCount).toBe(1);

      // Facets still count it.
      const facets = await buildFacets(db, semester.id, {}, false);
      expect(facets.by_severity.high).toBe(1);
      expect(facets.by_validation.pass).toBe(1);

      // Students rollup: one student, one submission, their own score.
      const rollup = await listStudents(db, semester.id, {}, 'score_sum_desc', null, 50, false);
      expect(rollup.items).toHaveLength(1);
      expect(rollup.items[0]!.student.id).toBe(alice.id);
      expect(rollup.items[0]!.submission_count).toBe(1);
      expect(rollup.items[0]!.score_sum).toBe(8);

      // Assignment stats: one submission, one distinct student.
      const asgs = await listAssignments(db, semester.id);
      const stats = asgs.find((a) => a.id === assignment.id)!;
      expect(stats.submission_count).toBe(1);
      expect(stats.distinct_students).toBe(1);
    });
  });

  it('charges a sole contributor the whole scope score, including scope-level flags', async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);
      const alice = await seedStudent(db, semester.id, '111111', 'Alice');
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: alice.id,
        scoreTotal: 9,
        maxSeverity: 'high',
      });
      await addContributor(db, sub.id, semester.id, alice.id);

      // A scope-level flag and one that names the contributor.
      await addFlag(db, sub.id, semester.id, '', 'high', 8);
      await addFlag(db, sub.id, semester.id, rosterContributorKey(alice.id), 'low', 1);

      await applyContributorScores(db, sub.id);

      const [row] = await db
        .select({ score_total: submission_contributors.score_total })
        .from(submission_contributors)
        .where(eq(submission_contributors.submission_id, sub.id));

      // 9, not 1. If scope-level flags were excluded from a sole contributor,
      // every solo student's rollup score would silently drop.
      expect(row!.score_total).toBe(9);

      const rollup = await listStudents(db, semester.id, {}, 'score_sum_desc', null, 50, false);
      expect(rollup.items[0]!.score_sum).toBe(9);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. A group appears once, with N contributors, scored separately
// ---------------------------------------------------------------------------

describe('group submissions', () => {
  it('appears ONCE in the cohort list with N contributors, and under EVERY partner in the rollup', async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);
      const alice = await seedStudent(db, semester.id, '111111', 'Alice');
      const bob = await seedStudent(db, semester.id, '222222', 'Bob');

      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: alice.id, // the submitter of record
        scoreTotal: 9,
        maxSeverity: 'high',
      });
      await addContributor(db, sub.id, semester.id, alice.id, { total: 8, maxSeverity: 'high' });
      await addContributor(db, sub.id, semester.id, bob.id, { total: 1, maxSeverity: 'low' });

      // ONE row, not two. The old fan-out produced one per co-submitter.
      const list = await listCohortSubmissions(db, semester.id, {}, 'score_desc', null, 50, false);
      expect(list.items).toHaveLength(1);
      expect(list.totalCount).toBe(1);
      expect(list.items[0]!.contributors).toHaveLength(2);
      expect(
        list.items[0]!.contributors.map((c) => c.student?.display_name).sort(),
      ).toEqual(['Alice', 'Bob']);

      // BOB — who did not submit it — finds it under his own filter. Under the
      // old `submissions.student_id` filter his own work was invisible to him.
      const bobFiltered = await listCohortSubmissions(
        db,
        semester.id,
        { studentId: bob.id },
        'score_desc',
        null,
        50,
        false,
      );
      expect(bobFiltered.items).toHaveLength(1);
      expect(bobFiltered.items[0]!.id).toBe(sub.id);

      // The rollup lists BOTH partners, each with the submission counted once.
      const rollup = await listStudents(db, semester.id, {}, 'score_sum_desc', null, 50, false);
      expect(rollup.items.map((i) => i.student.display_name).sort()).toEqual(['Alice', 'Bob']);
      for (const item of rollup.items) {
        expect(item.submission_count).toBe(1);
      }

      // One submission, two distinct students.
      const asgs = await listAssignments(db, semester.id);
      const stats = asgs.find((a) => a.id === assignment.id)!;
      expect(stats.submission_count).toBe(1);
      expect(stats.distinct_students).toBe(2);

      // Facets count the submission once, not once per partner.
      const facets = await buildFacets(db, semester.id, {}, false);
      expect(facets.by_severity.high).toBe(1);
    });
  });

  it("scores each partner from their OWN findings and never from the other's", async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);
      const alice = await seedStudent(db, semester.id, '111111', 'Alice');
      const bob = await seedStudent(db, semester.id, '222222', 'Bob');

      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: alice.id,
        scoreTotal: 12,
        maxSeverity: 'high',
      });
      await addContributor(db, sub.id, semester.id, alice.id);
      await addContributor(db, sub.id, semester.id, bob.id);

      // Alice earns a high-severity finding. Bob earns a low one. A scope-level
      // finding names neither.
      await addFlag(db, sub.id, semester.id, rosterContributorKey(alice.id), 'high', 8);
      await addFlag(db, sub.id, semester.id, rosterContributorKey(bob.id), 'low', 1);
      await addFlag(db, sub.id, semester.id, '', 'medium', 3);

      await applyContributorScores(db, sub.id);

      const rows = await db
        .select({
          roster_entry_id: submission_contributors.roster_entry_id,
          score_total: submission_contributors.score_total,
          score_max_severity: submission_contributors.score_max_severity,
        })
        .from(submission_contributors)
        .where(eq(submission_contributors.submission_id, sub.id));

      const aliceScore = rows.find((r) => r.roster_entry_id === alice.id)!;
      const bobScore = rows.find((r) => r.roster_entry_id === bob.id)!;

      expect(aliceScore.score_total).toBe(8);
      expect(aliceScore.score_max_severity).toBe('high');

      // THE assertion this whole change exists for: Bob is charged 1, not 9 and
      // not 12, and his worst severity is 'low', not 'high'. Alice's
      // high-severity finding must never appear against Bob.
      expect(bobScore.score_total).toBe(1);
      expect(bobScore.score_max_severity).toBe('low');

      // And the rollup reflects it — a grader can act on Alice alone.
      const rollup = await listStudents(db, semester.id, {}, 'score_sum_desc', null, 50, false);
      const aliceRow = rollup.items.find((i) => i.student.id === alice.id)!;
      const bobRow = rollup.items.find((i) => i.student.id === bob.id)!;
      expect(aliceRow.score_sum).toBe(8);
      expect(bobRow.score_sum).toBe(1);

      // The scope roll-up on the submission itself is untouched.
      const [scope] = await db
        .select({ score_total: submissions.score_total })
        .from(submissions)
        .where(eq(submissions.id, sub.id));
      expect(scope!.score_total).toBe(12);
    });
  });

  it('is idempotent — re-running the scoring writes the same values', async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);
      const alice = await seedStudent(db, semester.id, '111111', 'Alice');
      const bob = await seedStudent(db, semester.id, '222222', 'Bob');
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: alice.id,
      });
      await addContributor(db, sub.id, semester.id, alice.id);
      await addContributor(db, sub.id, semester.id, bob.id);
      await addFlag(db, sub.id, semester.id, rosterContributorKey(alice.id), 'high', 8);

      const first = await applyContributorScores(db, sub.id);
      const second = await applyContributorScores(db, sub.id);
      expect(second).toEqual(first);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. A submission with no single owning student
// ---------------------------------------------------------------------------

describe('a submission with no single owning student', () => {
  it('stays in the cohort list and in the counts instead of vanishing', async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);
      const alice = await seedStudent(db, semester.id, '111111', 'Alice');

      const solo = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: alice.id,
        maxSeverity: 'low',
      });
      await addContributor(db, solo.id, semester.id, alice.id);

      const group = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: null,
        groupKey: 'pair-alice-bob',
        maxSeverity: 'low',
      });
      await addContributor(db, group.id, semester.id, alice.id);

      // Under the old INNER join this row produced no output at all: absent
      // from the page AND from total_count, with no error anywhere.
      const list = await listCohortSubmissions(db, semester.id, {}, 'score_desc', null, 50, false);
      expect(list.items.map((i) => i.id).sort()).toEqual([solo.id, group.id].sort());
      expect(list.totalCount).toBe(2);

      const groupRow = list.items.find((i) => i.id === group.id)!;
      expect(groupRow.student).toBeNull();
      // The absence is in `student` only — the contributor is still named.
      expect(groupRow.contributors).toHaveLength(1);
      expect(groupRow.contributors[0]!.student?.display_name).toBe('Alice');

      const facets = await buildFacets(db, semester.id, {}, false);
      expect(facets.by_severity.low).toBe(2);
    });
  });

  it('is reachable when sorting by student name (the keyset predicate does not skip it)', async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);
      const alice = await seedStudent(db, semester.id, '111111', 'Alice');

      const solo = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: alice.id,
      });
      await addContributor(db, solo.id, semester.id, alice.id);
      const group = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: null,
        groupKey: 'pair-x',
      });
      await addContributor(db, group.id, semester.id, alice.id);

      // Page through one at a time. A `display_name > $cursor` predicate over a
      // NULL name is never true, so without the COALESCE the null-student row
      // would be unreachable on page 2 and the pager would disagree with
      // total_count for ever.
      const seen: string[] = [];
      let cursor: CohortCursor | null = null;
      for (let page = 0; page < 5; page += 1) {
        const res: Awaited<ReturnType<typeof listCohortSubmissions>> =
          await listCohortSubmissions(db, semester.id, {}, 'student_asc', cursor, 1, false);
        seen.push(...res.items.map((i) => i.id));
        if (res.nextCursor === null) break;
        cursor = decodeCursor(res.nextCursor);
      }
      expect(seen.sort()).toEqual([solo.id, group.id].sort());
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Version and supersede, both shapes
// ---------------------------------------------------------------------------

describe('version uniqueness and the supersede chain', () => {
  it('keeps solo lineages separate and still rejects a duplicate version', async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);
      const alice = await seedStudent(db, semester.id, '111111', 'Alice');
      const bob = await seedStudent(db, semester.id, '222222', 'Bob');

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: alice.id,
        versionIndex: 1,
      });
      // A different student at the same version is a different lineage.
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: bob.id,
        versionIndex: 1,
      });

      // The same student at the same version still collides — the pre-0029
      // guarantee, expressed through the generated lineage key.
      await expectConstraintViolation(
        () =>
          seedSubmission(db, {
            semesterId: semester.id,
            assignmentId: assignment.id,
            ingestJobId: job.id,
            studentId: alice.id,
            versionIndex: 1,
          }),
        'submissions_version_key',
      );
    });
  });

  it('gives two different groups separate lineages and rejects a duplicate within one', async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: null,
        groupKey: 'pair-a',
        versionIndex: 1,
      });
      // A DIFFERENT group at the same version index must be allowed.
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: null,
        groupKey: 'pair-b',
        versionIndex: 1,
      });

      // The SAME group twice at version 1 must not be. With a plain nullable
      // `student_id` in the unique key, Postgres's NULL-distinctness would have
      // allowed this silently and the supersede chain would never form.
      await expectConstraintViolation(
        () =>
          seedSubmission(db, {
            semesterId: semester.id,
            assignmentId: assignment.id,
            ingestJobId: job.id,
            studentId: null,
            groupKey: 'pair-a',
            versionIndex: 1,
          }),
        'submissions_version_key',
      );
    });
  });

  it('refuses a submission with no lineage at all', async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);
      // No student and no group key => the generated lineage is NULL => the
      // NOT NULL rejects it. A submission with no lineage is unrepresentable.
      await expect(
        seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          ingestJobId: job.id,
          studentId: null,
          groupKey: null,
        }),
      ).rejects.toThrow();
    });
  });

  it('records one contributor row per human however many sources name them', async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);
      const alice = await seedStudent(db, semester.id, '111111', 'Alice');
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: alice.id,
      });
      await addContributor(db, sub.id, semester.id, alice.id);

      // The bundle side names the same human under an ATTRIBUTED key. Two rows
      // for one person would split their score across two apparent people.
      await expectConstraintViolation(
        () =>
          db.insert(submission_contributors).values({
            submission_id: sub.id,
            semester_id: semester.id,
            contributor_key: 'attributed:2.1:institution:berkeley:alice-ref',
            kind: 'attributed',
            roster_entry_id: alice.id,
            student_ref: 'alice-ref',
          }),
        'submission_contributors_person_key',
      );

      const rows = await db
        .select({ id: submission_contributors.id })
        .from(submission_contributors)
        .where(
          and(
            eq(submission_contributors.submission_id, sub.id),
            eq(submission_contributors.roster_entry_id, alice.id),
          ),
        );
      expect(rows).toHaveLength(1);
    });
  });
});
