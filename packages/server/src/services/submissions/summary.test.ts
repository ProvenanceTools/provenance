/**
 * Integration tests for getSubmissionSummary — Phase 4 protected-mode masking.
 *
 * Tests that:
 * - student.display_name and student.sid are masked when protectedMode=true
 * - source_filename does not contain the real uploaded filename when protectedMode=true
 * - files[].path (workspace file paths inside the submission) are NOT masked
 * - Non-protected mode returns real values unchanged
 *
 * Events are no longer persisted in Postgres — session_ids now come from the
 * stored bundle blob's manifest (via loadSubmissionIndex), so every test here
 * seeds a bundle blob in a test MinIO alongside the submission row.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// Testcontainers spin up Postgres + MinIO per file; the repo convention is to
// raise the 10s unit-test default here rather than let container startup under
// a loaded full-suite run look like a product failure.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { withTestDb } from '../../../test/helpers/db.js';
import { withTestMinio } from '../../../test/helpers/minio.js';
import { putSubmissionBundle } from '../../../test/helpers/seed-bundle.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import {
  buildTrustChainKeys,
  buildManifest2,
  sessionStart2,
} from '@provenance/analysis-core/test-support/build-manifest-2.js';
import {
  courses,
  semesters,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
  submission_contributors,
  users,
  per_file_stats,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { CoverageFactsSchema } from '@provenance/shared/api-schemas';
import { getSubmissionSummary } from './summary.js';
import { _resetBundleIndexCacheForTest } from '../bundle/load-index.js';

beforeEach(() => {
  _resetBundleIndexCacheForTest();
});

// ---------------------------------------------------------------------------
// Seed helpers (mirrored from cohort/list.test.ts pattern)
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
  opts: { sid: string; displayName: string; protectedIndex?: number },
) {
  const [entry] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid: opts.sid,
      display_name: opts.displayName,
      ...(opts.protectedIndex !== undefined && { protected_index: opts.protectedIndex }),
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
    /** Null exercises the D9 "no single owning student" shape. */
    studentId: string | null;
    groupKey?: string;
    ingestJobId: string;
    sourceFilename?: string;
    /**
     * Defaults to 1. A test seeding a SECOND submission for the same student and
     * assignment must bump this: `submissions_version_key` is
     * `(semester_id, assignment_id, version_owner_key, version_index)` and
     * `version_owner_key` is GENERATED as `'student:' || student_id`, so two
     * version-1 rows for one student collide exactly as migration 0029 intends.
     */
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
      group_key: opts.studentId === null ? (opts.groupKey ?? `grp-${id}`) : null,
      blob_object_key: `semesters/${opts.semesterId}/submissions/${id}/bundle.zip`,
      blob_sha256: `sha256-${id}`,
      source_filename: opts.sourceFilename ?? 'test.zip',
      ingest_job_id: opts.ingestJobId,
      version_index: opts.versionIndex ?? 1,
      score_total: 0,
      score_max_severity: 'info',
      validation_status: 'pass',
    })
    .returning();
  return sub!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Build + store a single-session bundle blob for `submissionId`; returns its sessionId. */
async function seedBundleForSubmission(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  const { zipBuffer } = await buildTestBundle({ sessions: [{ sessionId, eventCount: 2 }] });
  await putSubmissionBundle(db, storage, submissionId, new Uint8Array(zipBuffer));
  return sessionId;
}

describe('getSubmissionSummary — protected mode masking', () => {
  it('masks student identity and source_filename when protectedMode=true', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const user = await seedUser(db);
        const { semester } = await seedCourseAndSemester(db);
        const student = await seedStudent(db, semester.id, {
          sid: 'smith123',
          displayName: 'John Smith',
          protectedIndex: 7,
        });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
          sourceFilename: 'smith_john_hw01.zip',
        });
        const sessionId = await seedBundleForSubmission(db, client, sub.id);

        // Seed a per_file_stat to verify files[].path is NOT masked
        await db.insert(per_file_stats).values({
          submission_id: sub.id,
          file_path: 'lab01/q1.py',
          saves: 3,
          chars_typed: 100,
          chars_pasted: 0,
          chars_external_change_delta: 0,
          final_length: 100,
          start_length: 0,
        });

        const summary = await getSubmissionSummary(db, client, sub.id, true);
        expect(summary).not.toBeNull();

        // student.display_name must match /^Student \d+$/
        expect(summary!.student!.display_name).toMatch(/^Student \d+$/);
        // student.sid must start with S
        expect(summary!.student!.sid).toMatch(/^S/);
        // source_filename must NOT contain 'smith' or 'john'
        expect(summary!.source_filename.toLowerCase()).not.toContain('smith');
        expect(summary!.source_filename.toLowerCase()).not.toContain('john');
        // The label should be Student 7 — submission (using the protected_index)
        expect(summary!.source_filename).toBe('Student 7 — submission');
        // files[].path must NOT be masked (out of scope per spec)
        expect(summary!.files[0]!.path).toBe('lab01/q1.py');
        // session_ids now come from the stored bundle's manifest (in manifest order).
        expect(summary!.session_ids).toEqual([sessionId]);
      });
    });
  });

  it('returns real values when protectedMode=false', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const user = await seedUser(db);
        const { semester } = await seedCourseAndSemester(db);
        const student = await seedStudent(db, semester.id, {
          sid: 'smith123',
          displayName: 'John Smith',
          protectedIndex: 7,
        });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
          sourceFilename: 'smith_john_hw01.zip',
        });
        await seedBundleForSubmission(db, client, sub.id);

        const summary = await getSubmissionSummary(db, client, sub.id, false);
        expect(summary).not.toBeNull();

        // Real display name and sid must be present
        expect(summary!.student!.display_name).toBe('John Smith');
        expect(summary!.student!.sid).toBe('smith123');
        // Real source_filename must be present
        expect(summary!.source_filename).toBe('smith_john_hw01.zip');
      });
    });
  });

  it('falls back to UUID-derived label when protected_index is null', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const user = await seedUser(db);
        const { semester } = await seedCourseAndSemester(db);
        // No protectedIndex set — it will be null in the DB
        const student = await seedStudent(db, semester.id, {
          sid: 'jones456',
          displayName: 'Alice Jones',
        });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
          sourceFilename: 'jones_alice_hw01.zip',
        });
        await seedBundleForSubmission(db, client, sub.id);

        const summary = await getSubmissionSummary(db, client, sub.id, true);
        expect(summary).not.toBeNull();

        // Fallback: display_name uses UUID stub (still matches /^Student /)
        expect(summary!.student!.display_name).toMatch(/^Student /);
        // source_filename must not contain 'jones' or 'alice'
        expect(summary!.source_filename.toLowerCase()).not.toContain('jones');
        expect(summary!.source_filename.toLowerCase()).not.toContain('alice');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// sessions[] — per-session metadata
// ---------------------------------------------------------------------------

describe('getSubmissionSummary — sessions[]', () => {
  it('reports one entry per session, in bundle order, with start time and event count', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const user = await seedUser(db);
        const { semester } = await seedCourseAndSemester(db);
        const student = await seedStudent(db, semester.id, {
          sid: 'multi001',
          displayName: 'Multi Session',
        });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
          sourceFilename: 'multi_hw01.zip',
        });

        const sessionA = crypto.randomUUID();
        const sessionB = crypto.randomUUID();
        const { zipBuffer } = await buildTestBundle({
          sessions: [
            { sessionId: sessionA, eventCount: 3 },
            { sessionId: sessionB, eventCount: 5 },
          ],
        });
        await putSubmissionBundle(db, client, sub.id, new Uint8Array(zipBuffer));

        const summary = await getSubmissionSummary(db, client, sub.id, false);
        expect(summary).not.toBeNull();

        // Bundle order is chronological (loader sorts oldest → newest), and
        // sessions[] must line up index-for-index with session_ids.
        expect(summary!.sessions.map((s) => s.session_id)).toEqual(summary!.session_ids);
        expect(summary!.sessions).toHaveLength(2);

        // Counts come from the index, so they reflect every event in the
        // session — not just the ones any single view happens to render.
        // buildTestBundle's eventCount is events AFTER session.start, so the
        // indexed totals are one higher.
        const byId = new Map(summary!.sessions.map((s) => [s.session_id, s]));
        expect(byId.get(sessionA)!.event_count).toBe(4);
        expect(byId.get(sessionB)!.event_count).toBe(6);

        // started_at is the first event's wall clock, as a parseable ISO string.
        for (const s of summary!.sessions) {
          expect(s.started_at).not.toBeNull();
          expect(Number.isNaN(Date.parse(s.started_at!))).toBe(false);
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// assignment_manifest (Manifest 2.0, program spec §3/§4)
// ---------------------------------------------------------------------------

describe('getSubmissionSummary — assignment_manifest', () => {
  it('reports the legacy shape for a 1.x bundle, with no disabled signals', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const user = await seedUser(db);
        const { semester } = await seedCourseAndSemester(db);
        const student = await seedStudent(db, semester.id, { sid: 's1', displayName: 'S One' });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
          sourceFilename: 'hw01.zip',
        });
        await seedBundleForSubmission(db, client, sub.id);

        const keys = await buildTrustChainKeys();
        // Even with a root key configured, a 1.x bundle has no chain to walk.
        const summary = await getSubmissionSummary(db, client, sub.id, false, keys.rootPubkeyHex);

        expect(summary!.assignment_manifest).toMatchObject({
          format_version: '1.x',
          course_id: null,
          collaboration: null,
          disabled_signals: [],
          heartbeat_interval_ms: 30_000,
          cert: null,
          trust_chain: 'legacy',
        });
      });
    });
  });

  it('surfaces course id, capability flags, cert and disabled signals for a 2.0 bundle', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const user = await seedUser(db);
        const { semester } = await seedCourseAndSemester(db);
        const student = await seedStudent(db, semester.id, { sid: 's1', displayName: 'S One' });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
          sourceFilename: 'hw01.zip',
        });

        const keys = await buildTrustChainKeys();
        const manifest = await buildManifest2({
          keys,
          collaboration: 'group',
          submission: 'git',
          scope: 'repo',
          policy: { capture: { terminal: false } },
        });
        const { zipBuffer } = await buildTestBundle({
          sessions: [{ sessionId: crypto.randomUUID(), sessionStart: sessionStart2(manifest) }],
        });
        await putSubmissionBundle(db, client, sub.id, new Uint8Array(zipBuffer));

        const summary = await getSubmissionSummary(db, client, sub.id, false, keys.rootPubkeyHex);

        expect(summary!.assignment_manifest).toMatchObject({
          format_version: '2.0',
          course_id: 'berkeley-cs61b',
          collaboration: 'group',
          submission: 'git',
          scope: 'repo',
          disabled_signals: ['terminal'],
          trust_chain: 'verified',
          trust_chain_detail: null,
        });
        expect(summary!.assignment_manifest.cert).toMatchObject({
          course_id: 'berkeley-cs61b',
          course_pubkey: keys.coursePubkeyHex,
          in_window: true,
        });
      });
    });
  });

  it('reports trust_chain "unconfigured" for a 2.0 bundle when no root key is set', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const user = await seedUser(db);
        const { semester } = await seedCourseAndSemester(db);
        const student = await seedStudent(db, semester.id, { sid: 's1', displayName: 'S One' });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
          sourceFilename: 'hw01.zip',
        });

        const keys = await buildTrustChainKeys();
        const manifest = await buildManifest2({ keys });
        const { zipBuffer } = await buildTestBundle({
          sessions: [{ sessionId: crypto.randomUUID(), sessionStart: sessionStart2(manifest) }],
        });
        await putSubmissionBundle(db, client, sub.id, new Uint8Array(zipBuffer));

        const summary = await getSubmissionSummary(db, client, sub.id, false);
        expect(summary!.assignment_manifest.trust_chain).toBe('unconfigured');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// D9: a submission with no single owning student must not 404 the detail shell
// ---------------------------------------------------------------------------

describe('getSubmissionSummary — a submission with no single owning student', () => {
  it('returns the summary with student: null and the contributors named', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { semester } = await seedCourseAndSemester(db);
        const user = await seedUser(db);
        const student = await seedStudent(db, semester.id, { sid: 'stu-1', displayName: 'Alice' });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: null,
          groupKey: 'pair-alice-bob',
          ingestJobId: job.id,
        });
        await seedBundleForSubmission(db, client, sub.id);

        // The contributor is named even though no ONE student owns the row.
        await db.insert(submission_contributors).values({
          submission_id: sub.id,
          semester_id: semester.id,
          contributor_key: `roster:${student.id}`,
          kind: 'roster',
          roster_entry_id: student.id,
          is_submitter: true,
        });

        const summary = await getSubmissionSummary(db, client, sub.id, false);

        // Before D9 the roster join was INNER, so this query returned zero rows,
        // the service returned null, and the ROUTE turned that null into a 404 —
        // taking down the entire submission detail shell (overview, timeline,
        // replay, validation, source) for a submission that exists and analyses
        // perfectly. `null` now means only "no such submission".
        expect(summary).not.toBeNull();
        expect(summary!.student).toBeNull();
        expect(summary!.contributors).toHaveLength(1);
        expect(summary!.contributors[0]!.student?.display_name).toBe('Alice');

        // The protected-mode filename label still has a non-PII handle to use
        // even with no student to derive one from.
        const masked = await getSubmissionSummary(db, client, sub.id, true);
        expect(masked!.source_filename).not.toContain('test.zip');
      });
    });
  });

  it('still returns null — and therefore 404 — for a submission that does not exist', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        // The distinction the LEFT join preserves: "no one student" and "no such
        // submission" must not share a response.
        expect(await getSubmissionSummary(db, client, crypto.randomUUID(), false)).toBeNull();
      });
    });
  });

  it('a solo submission still reports exactly one contributor, the same student', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const { semester } = await seedCourseAndSemester(db);
        const user = await seedUser(db);
        const student = await seedStudent(db, semester.id, { sid: 'stu-1', displayName: 'Alice' });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
        });
        await seedBundleForSubmission(db, client, sub.id);
        await db.insert(submission_contributors).values({
          submission_id: sub.id,
          semester_id: semester.id,
          contributor_key: `roster:${student.id}`,
          kind: 'roster',
          roster_entry_id: student.id,
          is_submitter: true,
        });

        const summary = await getSubmissionSummary(db, client, sub.id, false);
        // toMatchObject, not toEqual: the service returns `projectStudent`'s
        // full shape (including `id`), which is a superset of what
        // SubmissionSummarySchema declares. Pre-existing, and not this change's
        // to alter.
        expect(summary!.student).toMatchObject({ sid: 'stu-1', display_name: 'Alice' });
        expect(summary!.contributors).toHaveLength(1);
        expect(summary!.contributors[0]!.student).toEqual({
          id: student.id,
          sid: 'stu-1',
          display_name: 'Alice',
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Coverage facts on the wire (§6 Rule 3, server parity)
// ---------------------------------------------------------------------------

/**
 * The summary route now serves the coverage stage's output, so the server-backed
 * panel shows the same facts `/local` does instead of "not available".
 *
 * Two things are worth testing here and nowhere else, because both are invisible
 * to the type system:
 *
 *  1. **The `ReadonlyMap` hazard.** `BundleContributors.bySession` is a
 *     `ReadonlyMap`, and `JSON.stringify` renders a Map as `{}`. A wire shape
 *     carrying one would report "no contributors" for every submission in the
 *     deployment, silently, with every type green. The wire shape must be the
 *     `CoverageFacts` AGGREGATE, and the only way to prove it is to serialize.
 *
 *  2. **Present-and-real, never zeroed.** The panel's three states are three
 *     different claims: absent means "the server did not send them", and a
 *     zeroed-but-present object would collapse that into "we checked and there
 *     is nothing" — stronger, and false. So these assert the values are the
 *     bundle's actual facts, not a placeholder that happens to parse.
 */
describe('getSubmissionSummary — coverage facts', () => {
  it('serializes real facts that survive JSON and the shared schema', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const user = await seedUser(db);
        const { semester } = await seedCourseAndSemester(db);
        const student = await seedStudent(db, semester.id, {
          sid: 'cov-1',
          displayName: 'Cov One',
        });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
        });
        await seedBundleForSubmission(db, client, sub.id);

        const summary = await getSubmissionSummary(db, client, sub.id, false);
        expect(summary).not.toBeNull();
        const coverage = summary!.coverage;
        expect(coverage).toBeDefined();

        // Real, not a placeholder: contributor resolution RAN on this bundle
        // (that is what `resolved` means), and the one seeded session carries no
        // identity block, which is `unattributed` — the ordinary, blameless
        // state, and deterministically 1 here whatever the deployment's root key
        // is set to.
        expect(coverage.identity.resolved).toBe(true);
        expect(coverage.identity.unattributed).toBe(1);
        expect(coverage.identity.unverifiable).toBe(0);

        // The `ReadonlyMap` hazard, caught the only way it can be: serialize.
        const overTheWire: unknown = JSON.parse(JSON.stringify(coverage));
        const parsed = CoverageFactsSchema.parse(overTheWire);
        expect(parsed).toEqual(coverage);

        // Belt and braces — nothing anywhere in the payload is a Map or a Set,
        // both of which JSON.stringify quietly renders as `{}`.
        const walk = (v: unknown, path: string): void => {
          expect(v instanceof Map, `${path} is a Map`).toBe(false);
          expect(v instanceof Set, `${path} is a Set`).toBe(false);
          if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
          else if (v !== null && typeof v === 'object') {
            for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
          }
        };
        walk(coverage, 'coverage');
      });
    });
  });

  /**
   * A submission with no commits must NOT report the single-repository caveat,
   * and one whose commits name no repository MUST — the D12 predicate reaching a
   * grader through the wire rather than only through `/local`.
   */
  it('reports the single-repository caveat off the stored bundle, not a default', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const user = await seedUser(db);
        const { semester } = await seedCourseAndSemester(db);
        const student = await seedStudent(db, semester.id, {
          sid: 'cov-2',
          displayName: 'Cov Two',
        });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        // A bundle with no commit observation at all: no graph, so no caveat.
        const quiet = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
        });
        await seedBundleForSubmission(db, client, quiet.id);
        const quietSummary = await getSubmissionSummary(db, client, quiet.id, false);
        expect(quietSummary!.coverage.dagCoverage.commits).toBe(0);
        expect(quietSummary!.coverage.repositoryAssumedSingle).toBe(false);

        // A bundle whose commit names no repository — every recorder before
        // 2026-08-20, and every shallow clone. Folded into the sentinel, so the
        // caveat is stated.
        // A resubmission by the same student for the same assignment, so it needs
        // version 2 — version 1 is taken by `quiet` above.
        const withCommit = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
          versionIndex: 2,
        });
        const { zipBuffer } = await buildTestBundle({
          sessions: [
            {
              sessionId: crypto.randomUUID(),
              events: [
                {
                  kind: 'git.event',
                  data: { operation: 'commit', sha: 'a'.repeat(40), parents: [] },
                },
              ],
            },
          ],
        });
        await putSubmissionBundle(db, client, withCommit.id, new Uint8Array(zipBuffer));
        const commitSummary = await getSubmissionSummary(db, client, withCommit.id, false);
        expect(commitSummary!.coverage.dagCoverage.commits).toBe(1);
        expect(commitSummary!.coverage.repositoryAssumedSingle).toBe(true);
        // And it stays a fact about the RECORDING: no defect, nothing dropped.
        expect(commitSummary!.coverage.dagDefects).toEqual([]);
        expect(commitSummary!.coverage.droppedArtifacts).toEqual([]);
      });
    });
  });

  /**
   * §5.6 — the git-capture report crossing the wire, RECOMPUTED from the stored
   * bundle rather than read from a column.
   *
   * The reason there is no column: the inputs live inside the signed chains,
   * which are exactly what survives source stripping, so the stored bundle can
   * always answer. A persisted copy could only go stale against a fixed reader,
   * and the ingest that wrote it can never be re-run for an archived
   * submission. This test is what proves the read path actually re-derives it.
   */
  it('recomputes the §5.6 capability report off the stored bundle', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const user = await seedUser(db);
        const { semester } = await seedCourseAndSemester(db);
        const student = await seedStudent(db, semester.id, {
          sid: 'cov-3',
          displayName: 'Cov Three',
        });
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        // A bundle whose recorder predates §5.6 — every submission in the
        // archive. It must read UNKNOWN, never `impossible` and never a defect.
        const legacy = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
        });
        await seedBundleForSubmission(db, client, legacy.id);
        const legacySummary = await getSubmissionSummary(db, client, legacy.id, false);
        expect(legacySummary!.coverage.gitObservation.availability).toBe('unknown');
        expect(legacySummary!.coverage.gitObservation.impossibleReason).toBeNull();
        expect(legacySummary!.coverage.gitObservation.silentAndUnreported).toBe(1);
        expect(legacySummary!.coverage.witnessing.capability).toBe('unknown');
        expect(legacySummary!.coverage.witnessing.unwitnessedSessions).toBe(1);
        expect(legacySummary!.coverage.witnessing.discrepancies).toEqual([]);

        // A bundle that DOES report, and reports the case a grader acts on
        // differently: git worked, the assignment sat outside any repository.
        const reporting = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
          versionIndex: 2,
        });
        const { zipBuffer } = await buildTestBundle({
          sessions: [
            {
              sessionId: crypto.randomUUID(),
              eventCount: 2,
              sessionStart: { git_capture: 'not_owned', witness_capture: 'unavailable' },
            },
          ],
        });
        await putSubmissionBundle(db, client, reporting.id, new Uint8Array(zipBuffer));
        const summary = await getSubmissionSummary(db, client, reporting.id, false);

        expect(summary!.coverage.gitObservation.availability).toBe('impossible');
        // NOT collapsed onto `unavailable` — that is the whole point of §5.6
        // item 2, and the two lead a grader to different actions.
        expect(summary!.coverage.gitObservation.impossibleReason).toBe('not_owned');
        expect(summary!.coverage.gitObservation.silentAndIncapable).toBe(1);
        expect(summary!.coverage.witnessing.capability).toBe('impossible');

        // And the whole thing still survives JSON and the shared schema.
        const parsed = CoverageFactsSchema.parse(JSON.parse(JSON.stringify(summary!.coverage)));
        expect(parsed).toEqual(summary!.coverage);
      });
    });
  });
});
