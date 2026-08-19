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

import { describe, it, expect, beforeEach } from 'vitest';
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
  users,
  per_file_stats,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
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
    studentId: string;
    ingestJobId: string;
    sourceFilename?: string;
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
      source_filename: opts.sourceFilename ?? 'test.zip',
      ingest_job_id: opts.ingestJobId,
      version_index: 1,
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
        expect(summary!.student.display_name).toMatch(/^Student \d+$/);
        // student.sid must start with S
        expect(summary!.student.sid).toMatch(/^S/);
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
        expect(summary!.student.display_name).toBe('John Smith');
        expect(summary!.student.sid).toBe('smith123');
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
        expect(summary!.student.display_name).toMatch(/^Student /);
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
