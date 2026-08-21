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
import { rosterContributorKey, storeContributors } from './store-contributors.js';
import { attributeFlags, SCOPE_LEVEL } from './attribute-flags.js';
import { attachCoSubmitter } from '../ingest/dedup.js';
import { runAndStoreHeuristics } from '../heuristics/run-per-submission.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import { runValidation } from '@provenance/analysis-core/validation/run-validation.js';
import {
  buildCollabScope,
  collabDocOpen,
  collabDocSave,
  collabPartnerSession,
  COLLAB_ALICE,
  COLLAB_BOB,
} from '@provenance/analysis-core/test-support/build-collab-scope.js';

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
  expect(
    caught,
    `expected a ${constraintName} violation, but the statement succeeded`,
  ).toBeDefined();
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
      expect(list.items[0]!.contributors.map((c) => c.student?.display_name).sort()).toEqual([
        'Alice',
        'Bob',
      ]);

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
// 2a. Where the per-partner scores above actually COME FROM
// ---------------------------------------------------------------------------

/**
 * The cases above hand `applyContributorScores` a `flags.contributor_key` that
 * the fixture wrote by hand. This block closes the loop: it runs the REAL
 * heuristics over a REAL two-partner bundle, lets `runAndStoreHeuristics`
 * derive `flags.session_id` and `attributeFlags` resolve it, and asserts the
 * finding lands on the partner who did the thing.
 *
 * ## Why these particular heuristics
 *
 * Eight of the eighteen per-submission heuristics are already effectively
 * per-contributor: their evidence never leaves one session, so `session_id` is
 * populated and `contributorKeyForSession` can name a person. The rest must run
 * whole-scope — see
 * `analysis-core/src/heuristics/contributor-scope-boundary.test.ts`, which is
 * the other half of this argument.
 *
 * The three below are one per distinct evidence shape rather than one per
 * heuristic, because eight near-identical cases would test the fixture builder
 * eight times and this rule once:
 *
 *  - `large_paste` — one flag per paste EVENT, `supportingSeqs` a single seq.
 *  - `ai_extension_active` — one flag per (session, extension) from a scan of
 *    `index.bySessionId`, so the session is the unit rather than the event.
 *  - `shell_integration_disabled` — the same session-scoped shape reached
 *    through terminal evidence rather than the extension host, which is the
 *    other capture-policy signal and the other `isSignalCaptured` gate.
 *
 * The fourth case is the rule's negative half, and it is the one that protects
 * a student: an identical finding by a partner who never enrolled is charged to
 * NOBODY. It is still visible on the submission at full severity — §6 Rule 2
 * withholds the name, not the finding.
 */

/** A `paste` event large enough to trip `large_paste` (≥ 200 chars). */
function bigPaste(path: string): { kind: string; data: Record<string, unknown> } {
  const content = 'x'.repeat(260);
  return {
    kind: 'paste',
    data: {
      path,
      content,
      length: content.length,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    },
  };
}

const aiSnapshot = {
  kind: 'ext.snapshot',
  data: { extensions: [{ id: 'GitHub.copilot', version: '1.2.3', enabled: true }] },
};

const terminalWithoutShellIntegration = {
  kind: 'terminal.open',
  data: { terminal_id: 't-1', shell: '/bin/zsh', shell_integration: false },
};

/**
 * Bob writes the implementation; Alice does one extra thing in her own session.
 * Run the real pipeline over it and return the persisted flags plus each
 * partner's resolved contributor key.
 */
async function attributeRealFlags(
  db: DrizzleDb,
  aliceExtra: ReadonlyArray<{ kind: string; data: Record<string, unknown> }>,
  opts: {
    aliceEnrolled?: boolean;
    bobExtra?: ReadonlyArray<{ kind: string; data: Record<string, unknown> }>;
  } = {},
) {
  const { semester, job, assignment } = await seedWorld(db);
  const work = 'def solve(values):\n    return sum(values)\n';

  const bundle = (
    await buildCollabScope([
      {
        who: { studentRef: COLLAB_BOB },
        events: [...collabPartnerSession(work), ...(opts.bobExtra ?? [])],
      },
      {
        who: opts.aliceEnrolled === false ? 'anonymous' : { studentRef: COLLAB_ALICE },
        events: [collabDocOpen(work), ...aliceExtra, collabDocSave(work)],
      },
    ])
  ).bundle;

  const sub = await seedSubmission(db, {
    semesterId: semester.id,
    assignmentId: assignment.id,
    ingestJobId: job.id,
    studentId: null,
  });

  const report = await runValidation(bundle);
  await runAndStoreHeuristics(db, sub.id, semester.id, bundle, report);
  await attributeFlags(db, sub.id, bundle);

  const rows = await db
    .select({ heuristic_id: flags.heuristic_id, contributor_key: flags.contributor_key })
    .from(flags)
    .where(eq(flags.submission_id, sub.id));

  // Sessions are ordered oldest-first, so Bob (built first) is 0 and Alice is 1.
  const keyOf = (i: number): string => {
    const verdict = bundle.contributors!.bySession.get(bundle.sessions[i]!.sessionId)!;
    return verdict.contributorKey;
  };

  return { rows, bobKey: keyOf(0), aliceKey: keyOf(1) };
}

describe('the already-scoped heuristics charge their acting contributor', () => {
  it('large_paste — an event-shaped finding names whoever pasted', async () => {
    await withTestDb(async (db) => {
      const { rows, bobKey, aliceKey } = await attributeRealFlags(db, [bigPaste('hw1.py')]);

      const paste = rows.filter((r) => r.heuristic_id === 'large_paste');
      expect(paste, 'the fixture must actually fire large_paste').toHaveLength(1);
      expect(
        paste[0]!.contributor_key,
        `large_paste is charged to ${paste[0]!.contributor_key || 'NOBODY (scope level)'} — ` +
          `it must name Alice, whose session carries the paste. Scope-level here would ` +
          `mean her partner shares a finding he had no part in.`,
      ).toBe(aliceKey);
      expect(paste[0]!.contributor_key).not.toBe(bobKey);
    });
  });

  it('ai_extension_active — a session-shaped finding names whoever ran the tool', async () => {
    await withTestDb(async (db) => {
      const { rows, bobKey, aliceKey } = await attributeRealFlags(db, [aiSnapshot]);

      const ai = rows.filter((r) => r.heuristic_id === 'ai_extension_active');
      expect(ai, 'the fixture must actually fire ai_extension_active').toHaveLength(1);
      expect(ai[0]!.contributor_key).toBe(aliceKey);
      expect(
        ai[0]!.contributor_key,
        `Bob's extension host is not Alice's. A session-scoped environment finding that ` +
          `landed scope-level would put "was running Copilot" on a partner whose own ` +
          `ext.snapshot says otherwise.`,
      ).not.toBe(bobKey);
    });
  });

  it('shell_integration_disabled — terminal evidence names whose terminal it was', async () => {
    await withTestDb(async (db) => {
      const { rows, bobKey, aliceKey } = await attributeRealFlags(db, [
        terminalWithoutShellIntegration,
      ]);

      const shell = rows.filter((r) => r.heuristic_id === 'shell_integration_disabled');
      expect(shell, 'the fixture must actually fire shell_integration_disabled').toHaveLength(1);
      expect(shell[0]!.contributor_key).toBe(aliceKey);
      expect(shell[0]!.contributor_key).not.toBe(bobKey);
    });
  });

  it('charges NOBODY when the acting partner never enrolled — the finding stays, the name does not', async () => {
    await withTestDb(async (db) => {
      // BOTH partners paste, and only Bob is enrolled. Two flags of the same
      // heuristic, in the same bundle, resolving differently is what makes this
      // a real assertion: `contributor_key` defaults to the empty string, so a
      // case where nothing is attributed would pass even if attributeFlags
      // never ran.
      const { rows, bobKey } = await attributeRealFlags(db, [bigPaste('hw1.py')], {
        aliceEnrolled: false,
        bobExtra: [bigPaste('hw1.py')],
      });

      const paste = rows.filter((r) => r.heuristic_id === 'large_paste');
      // Neither finding is dropped. Under-attribution costs the pair nothing —
      // the flag is still on the submission, at full severity, in the scope
      // roll-up a grader reads.
      expect(paste, 'both findings must survive; only the name is withheld').toHaveLength(2);
      expect(
        paste.map((r) => r.contributor_key).sort(),
        `Bob's paste must name Bob and the unenrolled partner's must name nobody. An ` +
          `unenrolled partner has no verified chain, so nothing establishes WHO pasted; ` +
          `charging it to the only contributor the bundle CAN name would move a finding ` +
          `onto the partner who did not do it — §6 Rule 2 exists to stop exactly that.`,
      ).toEqual([SCOPE_LEVEL, bobKey].sort());
    });
  });
});

// ---------------------------------------------------------------------------
// 2b. The concurrency hazard: two co-submitters ingested at the same time
// ---------------------------------------------------------------------------

/**
 * A Bundle that is ALREADY stamped with an empty contributor verdict.
 *
 * Pre-stamped on purpose: `storeContributors` only calls
 * `establishBundleContributors` when the stamp is absent, and these tests are
 * about the PRUNE rule, not about identity resolution. An unstamped stub would
 * drag the real chain walk in and fail on the bundle fields it needs.
 */
function alreadyStampedEmptyBundle(): Bundle {
  return {
    sessions: [],
    contributors: {
      bySession: new Map(),
      contributors: [],
      rootKeyConfigured: false,
      counts: { attributed: 0, unverifiable: 0, unattributed: 0 },
    },
  } as unknown as Bundle;
}

describe('a co-submitter attached concurrently', () => {
  it("survives the creator's contributor stage instead of being pruned as stale", async () => {
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

      // Bob's ingest file lost the race for these bytes, so it attached him to
      // Alice's submission as a co-submitter.
      await attachCoSubmitter(db, sub.id, semester.id, bob.id);

      // Now Alice's own pipeline reaches its contributor stage. It knows only
      // about Alice — Bob is not in its submitter list and the bundle names
      // nobody. It must NOT delete him.
      //
      // A "delete anything not in my set" prune removed exactly this partner:
      // silently, and only under concurrency, so every serial test stayed
      // green while the real Gradescope path lost a student.
      const bundle = alreadyStampedEmptyBundle();
      await storeContributors(db, sub.id, semester.id, bundle, [alice.id]);

      const rows = await db
        .select({ roster_entry_id: submission_contributors.roster_entry_id })
        .from(submission_contributors)
        .where(eq(submission_contributors.submission_id, sub.id));

      expect(rows.map((r) => r.roster_entry_id).sort()).toEqual([alice.id, bob.id].sort());
    });
  });

  it('still retracts a stale ATTRIBUTED contributor, which this function does own', async () => {
    await withTestDb(async (db) => {
      const { semester, job, assignment } = await seedWorld(db);
      const alice = await seedStudent(db, semester.id, '111111', 'Alice');
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        ingestJobId: job.id,
        studentId: alice.id,
      });

      // A bundle-derived contributor from an earlier run whose identity no
      // longer verifies. Nothing else asserts this person, so a re-run must be
      // able to take the attribution back.
      await db.insert(submission_contributors).values({
        submission_id: sub.id,
        semester_id: semester.id,
        contributor_key: 'attributed:2.1:institution:berkeley:ghost-ref',
        kind: 'attributed',
        student_ref: 'ghost-ref',
        is_submitter: false,
      });

      const bundle = alreadyStampedEmptyBundle();
      await storeContributors(db, sub.id, semester.id, bundle, [alice.id]);

      const rows = await db
        .select({ contributor_key: submission_contributors.contributor_key })
        .from(submission_contributors)
        .where(eq(submission_contributors.submission_id, sub.id));

      expect(rows.map((r) => r.contributor_key)).toEqual([rosterContributorKey(alice.id)]);
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
        const res: Awaited<ReturnType<typeof listCohortSubmissions>> = await listCohortSubmissions(
          db,
          semester.id,
          {},
          'student_asc',
          cursor,
          1,
          false,
        );
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
