/**
 * Tests for runAndStoreCrossHeuristics (Phase 14).
 *
 * Strategy: boundary tests for the wrapper over v2 cross-heuristics.
 *   1. Synthetic two-bundle paste-shared case: two bundles with a shared paste
 *      content → one cross_flags row + 2 cross_flag_participants.
 *   2. Empty semester (1 submission): returns {flag_count:0, participant_count:0},
 *      no cross_flags rows.
 *   3. Idempotency (DELETE-then-INSERT contract): run twice → same final DB state.
 *   4. Stale flag flush: insert a synthetic cross_flag row, then run cross →
 *      stale row is replaced by the fresh result.
 *
 * Events are no longer persisted in Postgres — runAndStoreCrossHeuristics now
 * reads each submission's event stream by re-parsing its stored bundle blob
 * (via loadSubmissionIndex). To trigger paste_shared_across_students, we build
 * and store real bundle blobs (in a test MinIO) whose sessions carry a 'paste'
 * event with matching sha256/content, instead of inserting into the (removed)
 * events table.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, count } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { withTestMinio } from '../../../test/helpers/minio.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { putSubmissionBundle } from '../../../test/helpers/seed-bundle.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import {
  runAndStoreCrossHeuristics,
  translateCrossFlagsToRows,
  translateExclusionsToRows,
} from './run-cross.js';
import { translateFlagsToRows } from '../scoring/recompute-submission.js';
import { ALL_FLAG_IDS } from '@provenance/analysis-core/heuristics/known-flag-ids.js';
import type { CrossFlag } from '@provenance/analysis-core/heuristics/cross/types.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import { _resetBundleIndexCacheForTest } from '../bundle/load-index.js';
import {
  cross_flags,
  cross_flag_exclusions,
  cross_flag_participants,
  submissions,
  roster_entries,
  assignments,
  heuristic_configs,
  users,
} from '../../db/schema.js';
import { DEFAULT_SERVER_CONFIG } from './config.js';
import type { PerFlagEntry, ServerHeuristicConfig } from './config.js';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';

beforeEach(() => {
  _resetBundleIndexCacheForTest();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed a minimal submission row + return everything a second submission in the
 * SAME assignment needs to be seeded against it.
 *
 * `assignmentId` is returned because the cross-heuristic candidate pool is
 * scoped per assignment (2026-08). Two submissions on two different assignments
 * are never compared, so a test that means to compare them has to put them on
 * one assignment and say so.
 */
async function seedSubmissionWithSemester(db: DrizzleDb): Promise<{
  submissionId: string;
  semesterId: string;
  assignmentId: string;
  ingestJobId: string;
}> {
  const submissionId = await seedSubmission(db);
  const [row] = await db
    .select({
      semester_id: submissions.semester_id,
      assignment_id: submissions.assignment_id,
      ingest_job_id: submissions.ingest_job_id,
    })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  return {
    submissionId,
    semesterId: row!.semester_id,
    assignmentId: row!.assignment_id,
    ingestJobId: row!.ingest_job_id,
  };
}

/**
 * Insert another submission into an already-seeded semester, reusing the first
 * submission's ingest_job_id.
 *
 * `assignmentId` is REQUIRED and is a uuid, not a string id. It used to mint a
 * fresh `assignments` row from an `assignmentIdStr`, which meant every
 * "two submissions that should be compared" fixture in this file put the two
 * submissions on DIFFERENT assignments — hw1 vs hw2, hw1 vs hw3, hw1 vs hw9 —
 * and the tests passed only because the candidate pool was semester-wide with no
 * assignment filter at all. They asserted the defect as the requirement. Making
 * the caller name the assignment is what stops that shape from being spelled
 * again by accident.
 *
 * `seedNewAssignment` is the deliberate opposite: pass it to put the submission
 * on a SEPARATE assignment, which is a claim a test has to make on purpose.
 */
async function seedSecondSubmissionInSemester(
  db: DrizzleDb,
  opts: {
    semesterId: string;
    sidPrefix: string;
    displayName: string;
    /** Existing assignment uuid to share, or `undefined` with `seedNewAssignment`. */
    assignmentId?: string;
    /** Mint a separate assignment instead of sharing one. */
    seedNewAssignment?: { assignmentIdStr: string; label: string };
    sourceFilename: string;
    ingestJobId: string;
  },
): Promise<string> {
  const [student] = await db
    .insert(roster_entries)
    .values({
      semester_id: opts.semesterId,
      sid: `${opts.sidPrefix}-${crypto.randomUUID().slice(0, 6)}`,
      display_name: opts.displayName,
    })
    .returning();

  let assignmentId = opts.assignmentId;
  if (assignmentId === undefined) {
    if (opts.seedNewAssignment === undefined) {
      throw new Error('seedSecondSubmissionInSemester: pass assignmentId or seedNewAssignment');
    }
    const [assignment] = await db
      .insert(assignments)
      .values({
        semester_id: opts.semesterId,
        assignment_id_str: opts.seedNewAssignment.assignmentIdStr,
        label: opts.seedNewAssignment.label,
      })
      .returning();
    assignmentId = assignment!.id;
  }

  const subId = crypto.randomUUID();
  await db.insert(submissions).values({
    id: subId,
    semester_id: opts.semesterId,
    assignment_id: assignmentId,
    student_id: student!.id,
    blob_object_key: `semesters/${opts.semesterId}/submissions/${subId}/bundle.zip`,
    blob_sha256: `sha256-${subId}`,
    source_filename: opts.sourceFilename,
    ingest_job_id: opts.ingestJobId,
    version_index: 1,
  });

  return subId;
}

/**
 * Build a single-session bundle whose only post-session.start event is a
 * 'paste' with the given sha256/content, and store it as the submission's blob.
 * length must be >= 100 to satisfy the paste_shared_across_students minLength
 * threshold.
 */
async function putPasteBundle(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
  opts: { sha256: string; content: string },
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const { zipBuffer } = await buildTestBundle({
    sessions: [
      {
        sessionId,
        events: [
          {
            kind: 'paste',
            data: {
              path: 'main.py',
              sha256: opts.sha256,
              content: opts.content,
              length: opts.content.length,
            },
          },
        ],
      },
    ],
  });
  await putSubmissionBundle(db, storage, submissionId, new Uint8Array(zipBuffer));
}

/**
 * Like {@link putPasteBundle}, but the session also records a `git.event`
 * observed AT `commitSha` — the S20 key. Two submissions built with the same
 * `commitSha` are two views of ONE repository and must not be compared.
 *
 * `rootCommitSha`, when given, is the D12 repository discriminator. Passing it
 * on one side and omitting it on the other is a staged recorder rollout: the
 * same commit then carries two different node keys, which is the mixed-scope
 * case `analysis-core/coverage/cross-scope.ts` bridges.
 */
async function putPartnerBundle(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
  opts: { sha256: string; content: string; commitSha: string; rootCommitSha?: string },
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const { zipBuffer } = await buildTestBundle({
    sessions: [
      {
        sessionId,
        events: [
          {
            kind: 'paste',
            data: {
              path: 'main.py',
              sha256: opts.sha256,
              content: opts.content,
              length: opts.content.length,
            },
          },
          {
            kind: 'git.event',
            data: {
              operation: 'commit',
              sha: opts.commitSha,
              commit_sha: opts.commitSha,
              parents: [],
              branch: 'main',
              ...(opts.rootCommitSha === undefined ? {} : { root_commit_sha: opts.rootCommitSha }),
            },
          },
        ],
      },
    ],
  });
  await putSubmissionBundle(db, storage, submissionId, new Uint8Array(zipBuffer));
}

/** Build + store a bundle with just a session.start (no shared-paste signal). */
async function putEmptyBundle(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
): Promise<void> {
  const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
  await putSubmissionBundle(db, storage, submissionId, new Uint8Array(zipBuffer));
}

// A paste content long enough (>= 100 chars) for the heuristic to trigger.
const SHARED_PASTE_CONTENT = 'x'.repeat(120);
const SHARED_PASTE_SHA256 = 'abc123deadbeef';

/**
 * Seed two submissions in one fresh semester, both carrying the same paste, so
 * paste_shared_across_students fires. Returns the ids needed to assert on.
 */
async function seedSharedPastePair(
  db: DrizzleDb,
  storage: StorageClient,
  sha256: string,
): Promise<{ semesterId: string; sub1: string; sub2: string }> {
  const {
    submissionId: sub1,
    semesterId,
    assignmentId,
    ingestJobId,
  } = await seedSubmissionWithSemester(db);

  // Same assignment as sub1 — comparing two students is only meaningful inside
  // one assignment, and the candidate pool is scoped that way.
  const sub2 = await seedSecondSubmissionInSemester(db, {
    semesterId,
    sidPrefix: 'cfg',
    displayName: 'Dana',
    assignmentId,
    sourceFilename: 'hw1-dana.zip',
    ingestJobId,
  });

  await putPasteBundle(db, storage, sub1, { sha256, content: SHARED_PASTE_CONTENT });
  await putPasteBundle(db, storage, sub2, { sha256, content: SHARED_PASTE_CONTENT });

  return { semesterId, sub1, sub2 };
}

/**
 * Make `overrides` the semester's ACTIVE heuristic config, on top of
 * DEFAULT_SERVER_CONFIG (which enables every id at weight 1.0).
 *
 * Deactivates any prior active row first so the partial unique index
 * heuristic_configs_active_idx (WHERE is_active) is not violated — the same
 * flip commitNewVersion performs.
 */
async function setActiveConfig(
  db: DrizzleDb,
  semesterId: string,
  overrides: Record<string, PerFlagEntry>,
): Promise<void> {
  const uid = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      google_subject: `cfg-${uid}`,
      email: `cfg-${uid}@test.com`,
      display_name: 'Staff',
    })
    .returning();

  const existing = await db
    .select({ version: heuristic_configs.version })
    .from(heuristic_configs)
    .where(eq(heuristic_configs.semester_id, semesterId));
  const nextVersion = existing.reduce((max, r) => Math.max(max, r.version), 0) + 1;

  await db
    .update(heuristic_configs)
    .set({ is_active: false })
    .where(eq(heuristic_configs.semester_id, semesterId));

  await db.insert(heuristic_configs).values({
    semester_id: semesterId,
    version: nextVersion,
    config: {
      ...DEFAULT_SERVER_CONFIG,
      per_flag: { ...DEFAULT_SERVER_CONFIG.per_flag, ...overrides },
    } as unknown as Record<string, unknown>,
    set_by: user!.id,
    is_active: true,
    note: 'test',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAndStoreCrossHeuristics', () => {
  it('produces one cross_flags row + 2 participants for two bundles with shared paste', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        // Seed two submissions on the SAME assignment in the same semester.
        const {
          submissionId: sub1,
          semesterId,
          assignmentId,
          ingestJobId,
        } = await seedSubmissionWithSemester(db);

        const sub2Id = await seedSecondSubmissionInSemester(db, {
          semesterId,
          sidPrefix: 's2',
          displayName: 'Bob',
          assignmentId,
          sourceFilename: 'hw1-student2.zip',
          ingestJobId,
        });

        // Store bundle blobs for both submissions with a shared paste sha256.
        await putPasteBundle(db, client, sub1, {
          sha256: SHARED_PASTE_SHA256,
          content: SHARED_PASTE_CONTENT,
        });
        await putPasteBundle(db, client, sub2Id, {
          sha256: SHARED_PASTE_SHA256,
          content: SHARED_PASTE_CONTENT,
        });

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count, 'should have 1 cross flag').toBe(1);
        expect(result.participant_count, 'should have 2 participants').toBe(2);

        // Verify DB rows.
        const flagRows = await db
          .select()
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(flagRows).toHaveLength(1);
        expect(flagRows[0]!.heuristic_id).toBe('paste_shared_across_students');

        const participantRows = await db
          .select()
          .from(cross_flag_participants)
          .where(eq(cross_flag_participants.cross_flag_id, flagRows[0]!.id));
        expect(participantRows).toHaveLength(2);

        const participantSubIds = participantRows.map((p) => p.submission_id).sort();
        expect(participantSubIds).toContain(sub1);
        expect(participantSubIds).toContain(sub2Id);
      });
    });
  });

  it('returns zero flags for semester with only one submission', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { submissionId, semesterId } = await seedSubmissionWithSemester(db);

        // Seed a bundle so reconstruction would work if it were ever invoked
        // (it isn't — the <2-submission path short-circuits before feature
        // extraction — but this keeps the submission row realistic).
        await putPasteBundle(db, client, submissionId, {
          sha256: SHARED_PASTE_SHA256,
          content: SHARED_PASTE_CONTENT,
        });

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count).toBe(0);
        expect(result.participant_count).toBe(0);

        // No cross_flags rows in DB.
        const cntRows = await db
          .select({ cnt: count() })
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(cntRows[0]?.cnt ?? 0).toBe(0);
      });
    });
  });

  it('is idempotent: running twice produces the same final DB state', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const {
          submissionId: sub1,
          semesterId,
          assignmentId,
          ingestJobId,
        } = await seedSubmissionWithSemester(db);

        const sub2Id = await seedSecondSubmissionInSemester(db, {
          semesterId,
          sidPrefix: 's3',
          displayName: 'Charlie',
          assignmentId,
          sourceFilename: 'hw1-charlie.zip',
          ingestJobId,
        });

        await putPasteBundle(db, client, sub1, {
          sha256: 'idem-sha',
          content: SHARED_PASTE_CONTENT,
        });
        await putPasteBundle(db, client, sub2Id, {
          sha256: 'idem-sha',
          content: SHARED_PASTE_CONTENT,
        });

        // Run twice.
        const result1 = await runAndStoreCrossHeuristics(db, client, semesterId);
        const result2 = await runAndStoreCrossHeuristics(db, client, semesterId);

        // Both runs should produce the same counts.
        expect(result2.flag_count).toBe(result1.flag_count);
        expect(result2.participant_count).toBe(result1.participant_count);

        // DB should have exactly result1.flag_count rows (not doubled).
        const dbCntRows = await db
          .select({ cnt: count() })
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(dbCntRows[0]?.cnt ?? 0).toBe(result1.flag_count);
      });
    });
  });

  it('flushes obsolete cross_flags from prior runs', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { submissionId, semesterId } = await seedSubmissionWithSemester(db);

        // Insert a stale cross_flag row directly (simulating a prior run).
        const staleFlagId = crypto.randomUUID();
        await db.insert(cross_flags).values({
          id: staleFlagId,
          semester_id: semesterId,
          heuristic_id: 'paste_shared_across_students',
          severity: 'high',
          confidence: 0.95,
          detail: {} as unknown as Record<string, unknown>,
          heuristic_config_version: 0,
        });

        // Verify the stale flag exists.
        const beforeRows = await db
          .select({ cnt: count() })
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(beforeRows[0]?.cnt ?? 0).toBe(1);

        // Seed just one submission (no cross-submission match possible).
        await putEmptyBundle(db, client, submissionId);

        // Run cross-heuristics with only 1 submission → should DELETE the stale flag.
        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count).toBe(0);

        // Stale flag should be gone.
        const afterRows = await db
          .select({ cnt: count() })
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(afterRows[0]?.cnt ?? 0).toBe(0);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// The candidate pool is scoped per ASSIGNMENT (2026-08)
//
// The pool was `semester_id` + `isNull(superseded_by)` and NOTHING else, so a
// student's own hw1 and hw2 were compared against each other, as was every pair
// of unrelated assignments in the semester. "Did two students share this?" only
// has meaning inside one assignment.
//
// NOTE: these tests are the reason the fixtures above had to change. Every
// positive fixture in this file used to seed its second submission on a
// different assignment (hw1 vs hw2 / hw3 / hw9) and passed only because no
// assignment filter existed — the tests asserted the defect as the requirement.
// ---------------------------------------------------------------------------

describe('runAndStoreCrossHeuristics — assignment scoping', () => {
  it("does not compare one student's own two assignments", async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { submissionId: hw1, semesterId, ingestJobId } = await seedSubmissionWithSemester(db);

        // The SAME student, submitting their next assignment, carrying the same
        // helper function forward. Deliberately a separate assignment.
        const hw2 = await seedSecondSubmissionInSemester(db, {
          semesterId,
          sidPrefix: 'self',
          displayName: 'Same Student, Next Assignment',
          seedNewAssignment: { assignmentIdStr: 'hw2', label: 'HW2' },
          sourceFilename: 'hw2-samestudent.zip',
          ingestJobId,
        });

        await putPasteBundle(db, client, hw1, {
          sha256: 'carried-forward-sha',
          content: SHARED_PASTE_CONTENT,
        });
        await putPasteBundle(db, client, hw2, {
          sha256: 'carried-forward-sha',
          content: SHARED_PASTE_CONTENT,
        });

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(
          result.flag_count,
          'two different assignments are not a comparison anyone asked for',
        ).toBe(0);
        expect(result.participant_count).toBe(0);

        const rows = await db
          .select()
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(rows).toHaveLength(0);
      });
    });
  });

  it('still compares two students WITHIN one assignment when another assignment exists', async () => {
    // The negative control for the scoping change: adding an unrelated
    // assignment to the semester must not suppress the real finding inside the
    // assignment that has two submissions.
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const {
          submissionId: sub1,
          semesterId,
          assignmentId,
          ingestJobId,
        } = await seedSubmissionWithSemester(db);

        const sub2 = await seedSecondSubmissionInSemester(db, {
          semesterId,
          sidPrefix: 'peer',
          displayName: 'Peer',
          assignmentId,
          sourceFilename: 'hw1-peer.zip',
          ingestJobId,
        });

        // A third submission on a DIFFERENT assignment, carrying the identical
        // paste. It must not join the finding, and must not suppress it.
        const other = await seedSecondSubmissionInSemester(db, {
          semesterId,
          sidPrefix: 'other',
          displayName: 'Other Assignment',
          seedNewAssignment: { assignmentIdStr: 'hw7', label: 'HW7' },
          sourceFilename: 'hw7-other.zip',
          ingestJobId,
        });

        for (const id of [sub1, sub2, other]) {
          await putPasteBundle(db, client, id, {
            sha256: 'within-assignment-sha',
            content: SHARED_PASTE_CONTENT,
          });
        }

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count, 'the within-assignment pair is still found').toBe(1);
        expect(result.participant_count, 'and names exactly two participants').toBe(2);

        const [flagRow] = await db
          .select()
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        const participants = await db
          .select()
          .from(cross_flag_participants)
          .where(eq(cross_flag_participants.cross_flag_id, flagRow!.id));
        const ids = participants.map((p) => p.submission_id).sort();
        expect(ids).toEqual([sub1, sub2].sort());
        expect(ids, 'the other assignment is not a participant').not.toContain(other);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// per_flag config is honoured (2026-08 regression)
//
// run-cross.ts loaded the active config but read only `.version` off it, so the
// analyzer's on/off toggle for editing_pattern_clone and
// paste_shared_across_students did nothing: staff could disable a cross
// heuristic and watch it keep writing rows on the next pass.
// ---------------------------------------------------------------------------

describe('runAndStoreCrossHeuristics — per_flag config', () => {
  it('does not emit a cross flag whose heuristic is disabled in the active config', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { semesterId } = await seedSharedPastePair(db, client, 'disabled-sha');

        await setActiveConfig(db, semesterId, {
          paste_shared_across_students: { enabled: false, weight: 1.0 },
        });

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count, 'a disabled cross heuristic must emit nothing').toBe(0);
        expect(result.participant_count).toBe(0);

        const rows = await db
          .select()
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(rows).toHaveLength(0);
      });
    });
  });

  it('still emits when the active config leaves the heuristic enabled', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { semesterId } = await seedSharedPastePair(db, client, 'enabled-sha');

        // Explicitly enabled, and the OTHER cross heuristic disabled — proves
        // the gate is per-id and not an all-or-nothing switch.
        await setActiveConfig(db, semesterId, {
          paste_shared_across_students: { enabled: true, weight: 1.0 },
          editing_pattern_clone: { enabled: false, weight: 1.0 },
        });

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count).toBe(1);
        const rows = await db
          .select()
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(rows[0]!.heuristic_id).toBe('paste_shared_across_students');
        // Stamped with the config version that was actually consulted.
        expect(rows[0]!.heuristic_config_version).toBe(1);
      });
    });
  });

  it('deletes previously-written rows when the heuristic is later disabled', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { semesterId } = await seedSharedPastePair(db, client, 'later-disabled-sha');

        // Pass 1: enabled by default (no active config) → row written.
        const first = await runAndStoreCrossHeuristics(db, client, semesterId);
        expect(first.flag_count).toBe(1);

        // Staff disable it, which enqueues a recompute whose finalize step
        // re-runs the cross pass (jobs/recompute.ts).
        await setActiveConfig(db, semesterId, {
          paste_shared_across_students: { enabled: false, weight: 1.0 },
        });

        const second = await runAndStoreCrossHeuristics(db, client, semesterId);
        expect(second.flag_count).toBe(0);

        // The DELETE-then-INSERT contract removes the row written by pass 1 —
        // same outcome as the per-submission path, which DELETEs a submission's
        // flags and re-INSERTs only the ones the config keeps.
        const rows = await db
          .select({ cnt: count() })
          .from(cross_flags)
          .where(eq(cross_flags.semester_id, semesterId));
        expect(rows[0]?.cnt ?? 0).toBe(0);

        // Participants went with it (FK ON DELETE CASCADE).
        const participants = await db.select({ cnt: count() }).from(cross_flag_participants);
        expect(participants[0]?.cnt ?? 0).toBe(0);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// translateCrossFlagsToRows — pure unit tests (no container)
// ---------------------------------------------------------------------------

const SEMESTER_ID = '33333333-3333-4333-8333-333333333333';
const SUBMISSION_A = '44444444-4444-4444-8444-444444444444';
const SUBMISSION_B = '55555555-5555-4555-8555-555555555555';
const CONFIG_VERSION = 9;

/** A stored config with every known id enabled at weight 1.0. */
function fullConfig(): ServerHeuristicConfig {
  return {
    per_flag: Object.fromEntries(ALL_FLAG_IDS.map((id) => [id, { enabled: true, weight: 1.0 }])),
    severity_weights: { info: 0, low: 1, medium: 3, high: 8 },
    config_format_version: 1,
  };
}

/**
 * A stored config that predates the cross heuristics entirely: neither cross id
 * has a per_flag entry. This is the shape a semester configured before Phase 14
 * would carry, and the case `resolvePerFlag` exists to answer.
 */
function configWithoutCrossIds(): ServerHeuristicConfig {
  const config = fullConfig();
  delete config.per_flag['paste_shared_across_students'];
  delete config.per_flag['editing_pattern_clone'];
  return config;
}

function makeCrossFlag(heuristic: string, overrides: Partial<CrossFlag> = {}): CrossFlag {
  return {
    id: `${heuristic}-bundle-a|bundle-b-0`,
    heuristic,
    title: `${heuristic} title`,
    severity: 'high',
    confidence: 0.5,
    bundleIds: ['bundle-a', 'bundle-b'],
    eventsPerBundle: { 'bundle-a': ['sess-a:1'], 'bundle-b': ['sess-b:1'] },
    description: `${heuristic} description`,
    detail: {},
    ...overrides,
  };
}

const BUNDLE_TO_SUBMISSION = new Map([
  ['bundle-a', SUBMISSION_A],
  ['bundle-b', SUBMISSION_B],
]);

const GLOBAL_IDX_BY_BUNDLE = new Map([
  ['bundle-a', new Map([['sess-a:1', 11]])],
  ['bundle-b', new Map([['sess-b:1', 22]])],
]);

function translateCross(crossFlags: CrossFlag[], config: ServerHeuristicConfig) {
  return translateCrossFlagsToRows(
    crossFlags,
    SEMESTER_ID,
    BUNDLE_TO_SUBMISSION,
    GLOBAL_IDX_BY_BUNDLE,
    config,
    CONFIG_VERSION,
  );
}

describe('translateCrossFlagsToRows', () => {
  it('drops a cross flag the config explicitly disables', () => {
    const config = fullConfig();
    config.per_flag['editing_pattern_clone'] = { enabled: false, weight: 1.0 };

    const rows = translateCross(
      [makeCrossFlag('editing_pattern_clone'), makeCrossFlag('paste_shared_across_students')],
      config,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.flagRow.heuristic_id).toBe('paste_shared_across_students');
  });

  it('drops both cross flags when both are disabled', () => {
    const config = fullConfig();
    config.per_flag['editing_pattern_clone'] = { enabled: false, weight: 1.0 };
    config.per_flag['paste_shared_across_students'] = { enabled: false, weight: 2.0 };

    const rows = translateCross(
      [makeCrossFlag('editing_pattern_clone'), makeCrossFlag('paste_shared_across_students')],
      config,
    );

    expect(rows).toEqual([]);
  });

  it('keeps a cross flag whose per_flag entry is missing (enabled at 1.0)', () => {
    // A missing entry means the stored config predates the flag id, not that
    // staff suppressed it. Same rule as the per-submission path.
    const config = configWithoutCrossIds();
    expect(config.per_flag['paste_shared_across_students']).toBeUndefined();

    const rows = translateCross([makeCrossFlag('paste_shared_across_students')], config);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.flagRow.heuristic_id).toBe('paste_shared_across_students');
  });

  it('keeps a flag whose weight is 0 but which is still enabled', () => {
    // Mirrors the per-submission path: weight 0 zeroes the contribution, it
    // does not suppress the row. Only `enabled: false` suppresses.
    const config = fullConfig();
    config.per_flag['editing_pattern_clone'] = { enabled: true, weight: 0 };

    const rows = translateCross([makeCrossFlag('editing_pattern_clone')], config);
    expect(rows).toHaveLength(1);
  });

  it('stamps the config version and builds participants with translated seqs', () => {
    const rows = translateCross([makeCrossFlag('paste_shared_across_students')], fullConfig());

    expect(rows[0]!.flagRow.heuristic_config_version).toBe(CONFIG_VERSION);
    expect(rows[0]!.flagRow.semester_id).toBe(SEMESTER_ID);
    expect(rows[0]!.participants).toHaveLength(2);
    const bySubmission = new Map(
      rows[0]!.participants.map((p) => [p.submission_id, p.supporting_seqs]),
    );
    expect(bySubmission.get(SUBMISSION_A)).toEqual([11]);
    expect(bySubmission.get(SUBMISSION_B)).toEqual([22]);
  });
});

// ---------------------------------------------------------------------------
// Parity: the cross path and the per-submission path must read one config the
// same way. The whole bug class here was the two paths disagreeing.
// ---------------------------------------------------------------------------

describe('cross / per-submission config parity', () => {
  function makeFlag(heuristic: string): Flag {
    return {
      id: `${heuristic}-0`,
      heuristic,
      severity: 'high',
      confidence: 0.5,
      title: `${heuristic} title`,
      description: `${heuristic} description`,
      supportingSeqs: [],
      detail: {},
    } as Flag;
  }

  function translatePerSubmission(heuristic: string, config: ServerHeuristicConfig) {
    return translateFlagsToRows(
      [makeFlag(heuristic)],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the one field the function reads
      { bySeq: new Map() } as any,
      SUBMISSION_A,
      SEMESTER_ID,
      config,
      CONFIG_VERSION,
    ).flagRows;
  }

  it('both paths drop an explicitly disabled heuristic', () => {
    const config = fullConfig();
    config.per_flag['large_paste'] = { enabled: false, weight: 1.0 };
    config.per_flag['editing_pattern_clone'] = { enabled: false, weight: 1.0 };

    expect(translatePerSubmission('large_paste', config)).toHaveLength(0);
    expect(translateCross([makeCrossFlag('editing_pattern_clone')], config)).toHaveLength(0);
  });

  it('both paths keep a heuristic with no per_flag entry', () => {
    const config = configWithoutCrossIds();
    delete config.per_flag['large_paste'];

    expect(translatePerSubmission('large_paste', config)).toHaveLength(1);
    expect(translateCross([makeCrossFlag('editing_pattern_clone')], config)).toHaveLength(1);
  });

  it('both paths keep an enabled heuristic at weight 0', () => {
    const config = fullConfig();
    config.per_flag['large_paste'] = { enabled: true, weight: 0 };
    config.per_flag['editing_pattern_clone'] = { enabled: true, weight: 0 };

    const perSubmissionRows = translatePerSubmission('large_paste', config);
    expect(perSubmissionRows).toHaveLength(1);
    // Per-submission rows carry the weight; cross rows have no column for it
    // (cross flags contribute to no score), which is why weight is resolved
    // but not persisted on the cross path.
    expect(perSubmissionRows[0]!.score_contribution).toBe(0);
    expect(translateCross([makeCrossFlag('editing_pattern_clone')], config)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The exclusion register (spec S20 / §6 Rule 3, migration 0031)
//
// The findings say what was found. The register says what was NOT compared, and
// why. Before this table the server wrote only the first half, so the
// server-backed cross-flags view showed the suppression with no explanation —
// an absence indistinguishable from a clean result.
// ---------------------------------------------------------------------------

const SHARED_COMMIT = 'e5'.repeat(20);
const ROOT_ONE = 'f1'.repeat(20);
const ROOT_TWO = 'f2'.repeat(20);

/** Seed two submissions in ONE assignment; caller stores their bundles. */
async function seedPairInOneAssignment(
  db: DrizzleDb,
  sidPrefix: string,
): Promise<{ semesterId: string; sub1: string; sub2: string }> {
  const {
    submissionId: sub1,
    semesterId,
    assignmentId,
    ingestJobId,
  } = await seedSubmissionWithSemester(db);

  const sub2 = await seedSecondSubmissionInSemester(db, {
    semesterId,
    sidPrefix,
    displayName: 'Partner',
    assignmentId,
    sourceFilename: `hw1-${sidPrefix}.zip`,
    ingestJobId,
  });

  return { semesterId, sub1, sub2 };
}

describe('runAndStoreCrossHeuristics — the exclusion register', () => {
  it('writes a register row for a partner pair, and no finding against them', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { semesterId, sub1, sub2 } = await seedPairInOneAssignment(db, 'ex1');

        // Both observe the same commit AND share a paste. Without the exclusion
        // this is a high-severity paste_shared_across_students against the two
        // people the course assigned to collaborate.
        for (const id of [sub1, sub2]) {
          await putPartnerBundle(db, client, id, {
            sha256: 'reg-sha',
            content: SHARED_PASTE_CONTENT,
            commitSha: SHARED_COMMIT,
          });
        }

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count, 'the partner pair must not be accused').toBe(0);
        expect(result.exclusion_count).toBe(1);

        const rows = await db
          .select()
          .from(cross_flag_exclusions)
          .where(eq(cross_flag_exclusions.semester_id, semesterId));

        expect(rows).toHaveLength(1);
        expect(rows[0]!.reason).toBe('same_repository_lineage');
        expect(rows[0]!.excluded_pair_count).toBe(1);
        // Stored SORTED, not in the partition's synthetic-bundle-id order.
        expect(rows[0]!.submission_ids).toEqual([sub1, sub2].sort());
        expect(rows[0]!.shared_commits.join(' ')).toContain(SHARED_COMMIT);
      });
    });
  });

  it('writes a register row for a MIXED-scope pair (one D12 build, one older)', async () => {
    // The same fix Task A made in `coverage/cross-scope.ts`, proven on the
    // SERVER path — the two feature producers must not disagree about which
    // pairs are one repository.
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { semesterId, sub1, sub2 } = await seedPairInOneAssignment(db, 'ex2');

        await putPartnerBundle(db, client, sub1, {
          sha256: 'mix-sha',
          content: SHARED_PASTE_CONTENT,
          commitSha: SHARED_COMMIT,
          rootCommitSha: ROOT_ONE,
        });
        await putPartnerBundle(db, client, sub2, {
          sha256: 'mix-sha',
          content: SHARED_PASTE_CONTENT,
          commitSha: SHARED_COMMIT,
        });

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count).toBe(0);
        expect(result.exclusion_count).toBe(1);

        const rows = await db
          .select()
          .from(cross_flag_exclusions)
          .where(eq(cross_flag_exclusions.semester_id, semesterId));
        // Both keys the commit was seen under, because neither was observed by
        // both sides.
        expect(rows[0]!.shared_commits.sort()).toEqual(
          [
            `repository:${ROOT_ONE} ${SHARED_COMMIT}`,
            `repository:assumed-single ${SHARED_COMMIT}`,
          ].sort(),
        );
      });
    });
  });

  it('writes NO register row for two DIFFERENT real repositories sharing a sha', async () => {
    // The D12 guarantee. A false exclusion switches a detector silently off, so
    // the flag must still fire and the register must stay empty.
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { semesterId, sub1, sub2 } = await seedPairInOneAssignment(db, 'ex3');

        await putPartnerBundle(db, client, sub1, {
          sha256: 'd12-sha',
          content: SHARED_PASTE_CONTENT,
          commitSha: SHARED_COMMIT,
          rootCommitSha: ROOT_ONE,
        });
        await putPartnerBundle(db, client, sub2, {
          sha256: 'd12-sha',
          content: SHARED_PASTE_CONTENT,
          commitSha: SHARED_COMMIT,
          rootCommitSha: ROOT_TWO,
        });

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.flag_count).toBe(1);
        expect(result.exclusion_count).toBe(0);

        const rows = await db
          .select()
          .from(cross_flag_exclusions)
          .where(eq(cross_flag_exclusions.semester_id, semesterId));
        expect(rows).toHaveLength(0);
      });
    });
  });

  it('is idempotent: two runs leave exactly one register row with the same content', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { semesterId, sub1, sub2 } = await seedPairInOneAssignment(db, 'ex4');

        for (const id of [sub1, sub2]) {
          await putPartnerBundle(db, client, id, {
            sha256: 'idem-reg-sha',
            content: SHARED_PASTE_CONTENT,
            commitSha: SHARED_COMMIT,
          });
        }

        const first = await runAndStoreCrossHeuristics(db, client, semesterId);
        const rowsAfterFirst = await db
          .select()
          .from(cross_flag_exclusions)
          .where(eq(cross_flag_exclusions.semester_id, semesterId));

        const second = await runAndStoreCrossHeuristics(db, client, semesterId);
        const rowsAfterSecond = await db
          .select()
          .from(cross_flag_exclusions)
          .where(eq(cross_flag_exclusions.semester_id, semesterId));

        expect(second.exclusion_count).toBe(first.exclusion_count);
        expect(rowsAfterSecond).toHaveLength(1);
        // The row id is regenerated by the replace; everything a reader sees
        // must be byte-identical, or a retry would look like a changed answer.
        expect(rowsAfterSecond[0]!.submission_ids).toEqual(rowsAfterFirst[0]!.submission_ids);
        expect(rowsAfterSecond[0]!.shared_commits).toEqual(rowsAfterFirst[0]!.shared_commits);
        expect(rowsAfterSecond[0]!.excluded_pair_count).toBe(
          rowsAfterFirst[0]!.excluded_pair_count,
        );
      });
    });
  });

  it('flushes a stale register row from a prior run', async () => {
    // The register is on the same DELETE-then-INSERT contract as the flags. A
    // stale row claims a comparison was withheld when this run made it.
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { semesterId, sub1, sub2 } = await seedPairInOneAssignment(db, 'ex5');

        // Not partners this time: different commits, but a shared paste.
        await putPartnerBundle(db, client, sub1, {
          sha256: 'stale-sha',
          content: SHARED_PASTE_CONTENT,
          commitSha: 'aa'.repeat(20),
        });
        await putPartnerBundle(db, client, sub2, {
          sha256: 'stale-sha',
          content: SHARED_PASTE_CONTENT,
          commitSha: 'bb'.repeat(20),
        });

        await db.insert(cross_flag_exclusions).values({
          semester_id: semesterId,
          reason: 'same_repository_lineage',
          submission_ids: [sub1, sub2].sort(),
          shared_commits: ['repository:assumed-single ' + 'cc'.repeat(20)],
          excluded_pair_count: 1,
        });

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.exclusion_count).toBe(0);
        // And the finding they genuinely earn is reported.
        expect(result.flag_count).toBe(1);

        const rows = await db
          .select()
          .from(cross_flag_exclusions)
          .where(eq(cross_flag_exclusions.semester_id, semesterId));
        expect(rows).toHaveLength(0);
      });
    });
  });

  it('clears the register when a semester drops below two comparable submissions', async () => {
    // The early-return branch: no assignment has two submissions, so nothing is
    // loaded at all. It must still replace the register, or last run's panel
    // outlives the comparison it described.
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { submissionId, semesterId } = await seedSubmissionWithSemester(db);
        await putEmptyBundle(db, client, submissionId);

        await db.insert(cross_flag_exclusions).values({
          semester_id: semesterId,
          reason: 'same_repository_lineage',
          submission_ids: [submissionId, crypto.randomUUID()].sort(),
          shared_commits: ['repository:assumed-single ' + 'dd'.repeat(20)],
          excluded_pair_count: 1,
        });

        const result = await runAndStoreCrossHeuristics(db, client, semesterId);

        expect(result.exclusion_count).toBe(0);
        const rows = await db
          .select()
          .from(cross_flag_exclusions)
          .where(eq(cross_flag_exclusions.semester_id, semesterId));
        expect(rows).toHaveLength(0);
      });
    });
  });
});

// ---------------------------------------------------------------------------

describe('translateExclusionsToRows', () => {
  const bundleMap = new Map([
    ['bundle-b', '00000000-0000-0000-0000-0000000000b0'],
    ['bundle-a', '00000000-0000-0000-0000-0000000000a0'],
  ]);

  const exclusion = {
    reason: 'same_repository_lineage' as const,
    bundleIds: ['bundle-b', 'bundle-a'],
    sourceFilenames: ['b.zip', 'a.zip'],
    sharedCommits: ['repository:assumed-single ' + 'a1'.repeat(20)],
    excludedPairCount: 1,
  };

  it('sorts submission ids rather than persisting the partition order', () => {
    // The partition orders by `sourceFilename`, which on the server is the
    // synthetic `reconstruct-stub-<uuid>` stub tie-broken by a random bundle id.
    // Persisting that order would make two identical recompute runs differ.
    const rows = translateExclusionsToRows([exclusion], 'sem-1', bundleMap);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.submission_ids).toEqual([
      '00000000-0000-0000-0000-0000000000a0',
      '00000000-0000-0000-0000-0000000000b0',
    ]);
  });

  it('drops an exclusion left with fewer than two resolvable members', () => {
    // An unmapped bundle id is not guessed at, and a one-member lineage excludes
    // nothing — the table's CHECK rejects it, and a register row claiming a
    // suppression that never happened is worse than no row.
    const rows = translateExclusionsToRows(
      [exclusion],
      'sem-1',
      new Map([['bundle-a', '00000000-0000-0000-0000-0000000000a0']]),
    );

    expect(rows).toEqual([]);
  });

  it('recomputes excluded_pair_count from the members that survived', () => {
    const three = {
      ...exclusion,
      bundleIds: ['bundle-a', 'bundle-b', 'bundle-c'],
      sourceFilenames: ['a.zip', 'b.zip', 'c.zip'],
      excludedPairCount: 3,
    };
    const rows = translateExclusionsToRows([three], 'sem-1', bundleMap);

    // Only two of the three resolved, so the count is 1 — a count that
    // disagrees with the list beside it is worse than no count.
    expect(rows[0]!.submission_ids).toHaveLength(2);
    expect(rows[0]!.excluded_pair_count).toBe(1);
  });
});
