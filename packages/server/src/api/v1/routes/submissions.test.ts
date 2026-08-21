/**
 * Per-submission endpoints integration tests (Phase 17).
 *
 * Tests all 5 submission endpoints through createV1App() per V18 rule.
 * Submission reads are NOT audit-logged per PRD §13.
 *
 * Test groups:
 *   1. GET /submissions/:id         — summary endpoint
 *   2. GET /submissions/:id/flags   — flags endpoint
 *   3. GET /submissions/:id/stats   — stats endpoint
 *   4. GET /submissions/:id/validation — validation endpoint
 *   5. GET /submissions/:id/files   — files endpoint
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../../test/helpers/db.js';
import { withTestMinio } from '../../../../test/helpers/minio.js';
import { putSubmissionBundle } from '../../../../test/helpers/seed-bundle.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import { _resetBundleIndexCacheForTest } from '../../../services/bundle/load-index.js';
import {
  users,
  sessions,
  courses,
  semesters,
  memberships,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
  flags,
  per_file_stats,
  validation_results,
} from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// DB injection
// ---------------------------------------------------------------------------

let _testDb: DrizzleDb | null = null;

vi.mock('../../../db/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../db/client.js')>();
  return {
    ...original,
    getDb: () => {
      if (_testDb !== null) return _testDb;
      return original.getDb();
    },
  };
});

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _resetBundleIndexCacheForTest();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function makeTestEnv(extra?: Record<string, string>) {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
    OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
    OBJECT_STORAGE_BUCKET: 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-submission-tests-1234567890',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
    ...extra,
  };
}

async function seedUser(db: DrizzleDb, opts?: { email?: string }) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      google_subject: `sub-${id}`,
      email: opts?.email ?? `user-${id}@berkeley.edu`,
      display_name: 'Test User',
    })
    .returning();
  return user!;
}

async function seedSession(db: DrizzleDb, userId: string): Promise<string> {
  const id = `sess-${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 43);
  await db.insert(sessions).values({
    id,
    user_id: userId,
    expires_at: new Date(Date.now() + 14 * 86400_000),
  });
  return id;
}

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

async function seedMembership(
  db: DrizzleDb,
  userId: string,
  semesterId: string,
  role: 'admin' | 'grader',
) {
  await db.insert(memberships).values({
    user_id: userId,
    semester_id: semesterId,
    role,
    granted_by: userId,
  });
}

async function seedStudent(db: DrizzleDb, semesterId: string, sid?: string) {
  const [entry] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid: sid ?? `stu-${crypto.randomUUID().slice(0, 8)}`,
      display_name: 'Alice',
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
    scoreSeverity?: string;
    validationStatus?: string;
    supersededById?: string;
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
      version_index: 1,
      score_total: opts.scoreTotal ?? 0,
      score_max_severity: opts.scoreSeverity ?? 'info',
      validation_status: opts.validationStatus ?? 'pass',
      ...(opts.supersededById !== undefined && {
        superseded_by_submission_id: opts.supersededById,
      }),
    })
    .returning();
  return sub!;
}

// ---------------------------------------------------------------------------
// §1. GET /submissions/:id
// ---------------------------------------------------------------------------

describe('GET /submissions/:id', () => {
  it('returns full summary for a seeded submission', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(
            makeTestEnv({ OBJECT_STORAGE_ENDPOINT: endpoint, OBJECT_STORAGE_BUCKET: bucketName }),
          ),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');

        const student = await seedStudent(db, semester.id);
        const assignment = await seedAssignment(db, semester.id, 'HW1');
        const job = await seedIngestJob(db, semester.id, user.id);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
          scoreTotal: 5.0,
          scoreSeverity: 'medium',
          validationStatus: 'warn',
        });

        // The summary derives session_ids from the stored bundle.
        const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
        await putSubmissionBundle(db, client, sub.id, new Uint8Array(zipBuffer));

        // Seed a flag
        await db.insert(flags).values({
          submission_id: sub.id,
          semester_id: semester.id,
          heuristic_id: 'large_paste',
          severity: 'high',
          confidence: 0.9,
          weight_at_compute: 1.0,
          score_contribution: 8.0,
          heuristic_config_version: 1,
        });

        // Seed a per_file_stat
        await db.insert(per_file_stats).values({
          submission_id: sub.id,
          file_path: 'main.py',
          saves: 3,
          chars_typed: 100,
          chars_pasted: 50,
          chars_external_change_delta: 0,
          final_length: 150,
          start_length: 0,
        });

        // Seed validation_results for synthesis
        await db.insert(validation_results).values({
          submission_id: sub.id,
          check_1_status: 'pass',
          check_2_status: 'pass',
          check_3_status: 'fail',
          check_4_status: 'pass',
          check_5_status: 'pass',
          check_6_status: 'pass',
          check_7_status: 'pass',
          check_8_status: 'skipped',
          overall: 'fail',
          detail: [
            { id: 'manifest_sig', status: 'pass', label: 'Manifest signature' },
            { id: 'session_binding', status: 'pass', label: 'Session binding' },
            {
              id: 'chain_integrity',
              status: 'fail',
              label: 'Chain integrity',
              detail: 'hash mismatch at seq 5',
            },
            { id: 'seq_gaps', status: 'pass', label: 'Seq gaps' },
            { id: 'monotonic_t', status: 'pass', label: 'Monotonic t' },
            { id: 'monotonic_wall', status: 'pass', label: 'Monotonic wall' },
            { id: 'doc_save_hashes', status: 'pass', label: 'Doc save hashes' },
            { id: 'submitted_code_match', status: 'skipped', label: 'Submitted code match' },
          ] as unknown,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/summary`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body['id']).toBe(sub.id);
        expect(body['semester_id']).toBe(semester.id);
        expect(body['score_total']).toBe(5.0);
        expect(body['score_max_severity']).toBe('medium');
        expect(body['validation_status']).toBe('warn');
        expect(body['superseded']).toBe(false);
        expect(body['superseded_by_submission_id']).toBeNull();
        const flagCounts = body['flag_counts'] as Record<string, number>;
        expect(flagCounts['high']).toBe(1);
        expect(flagCounts['info']).toBe(0);
        const files = body['files'] as { path: string; final_length: number; saves: number }[];
        expect(files).toHaveLength(1);
        expect(files[0]!.path).toBe('main.py');
        expect(files[0]!.saves).toBe(3);
        // validation_overall_detail: chain_integrity=fail + submitted_code_match=skipped
        expect(typeof body['validation_overall_detail']).toBe('string');
        expect(body['validation_overall_detail'] as string).toContain('chain_integrity=fail');
        const asgn = body['assignment'] as Record<string, unknown>;
        expect(asgn['label']).toBe('HW1');
      });
    });
  });

  it('returns 404 for unknown submission id', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/summary`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for non-member (no 403 leak)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      // Owner who creates submission
      const owner = await seedUser(db);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, owner.id, semester.id, 'admin');
      const student = await seedStudent(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, owner.id);
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: student.id,
        ingestJobId: job.id,
      });

      // Non-member user
      const outsider = await seedUser(db);
      const outsiderSession = await seedSession(db, outsider.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/summary`, {
          headers: { Cookie: `__Host-prov_sess=${outsiderSession}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 401 for unauthenticated request', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/summary`),
      );

      expect(res.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// §2. GET /submissions/:id/flags
// ---------------------------------------------------------------------------

describe('GET /submissions/:id/flags', () => {
  it('returns flags ordered by severity desc, confidence desc', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const student = await seedStudent(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: student.id,
        ingestJobId: job.id,
      });

      await db.insert(flags).values([
        {
          submission_id: sub.id,
          semester_id: semester.id,
          heuristic_id: 'large_paste',
          severity: 'high',
          confidence: 0.9,
          weight_at_compute: 1.0,
          score_contribution: 8.0,
          heuristic_config_version: 1,
        },
        {
          submission_id: sub.id,
          semester_id: semester.id,
          heuristic_id: 'external_edits',
          severity: 'medium',
          confidence: 0.7,
          weight_at_compute: 1.0,
          score_contribution: 3.0,
          heuristic_config_version: 1,
        },
      ]);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/flags`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { flags: { heuristic_id: string; severity: string }[] };
      expect(body.flags).toHaveLength(2);
      // First flag should be the higher severity
      expect(body.flags[0]!.severity).toBe('high');
      expect(body.flags[1]!.severity).toBe('medium');
    });
  });

  it('returns 404 for unknown submission', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/flags`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for non-member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const owner = await seedUser(db);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, owner.id, semester.id, 'admin');
      const student = await seedStudent(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, owner.id);
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: student.id,
        ingestJobId: job.id,
      });

      const outsider = await seedUser(db);
      const outsiderSession = await seedSession(db, outsider.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/flags`, {
          headers: { Cookie: `__Host-prov_sess=${outsiderSession}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// §3. GET /submissions/:id/stats
// ---------------------------------------------------------------------------

describe('GET /submissions/:id/stats', () => {
  it('returns per_file and aggregate stats', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(
            makeTestEnv({ OBJECT_STORAGE_ENDPOINT: endpoint, OBJECT_STORAGE_BUCKET: bucketName }),
          ),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const student = await seedStudent(db, semester.id);
        const assignment = await seedAssignment(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);
        const sub = await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: assignment.id,
          studentId: student.id,
          ingestJobId: job.id,
        });

        // The stats aggregate derives event/session totals from the stored bundle.
        const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
        await putSubmissionBundle(db, client, sub.id, new Uint8Array(zipBuffer));

        await db.insert(per_file_stats).values([
          {
            submission_id: sub.id,
            file_path: 'main.py',
            chars_typed: 100,
            chars_pasted: 50,
            chars_external_change_delta: 10,
            saves: 3,
            final_length: 160,
            start_length: 0,
            reconstruction_tainted: false,
          },
          {
            submission_id: sub.id,
            file_path: 'utils.py',
            chars_typed: 200,
            chars_pasted: 0,
            chars_external_change_delta: 0,
            saves: 5,
            final_length: 200,
            start_length: 0,
            reconstruction_tainted: false,
          },
        ]);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/stats`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          per_file: { path: string; chars_typed: number; saves: number }[];
          aggregate: { chars_typed: number; chars_pasted: number; files: number; saves: number };
        };
        expect(body.per_file).toHaveLength(2);
        expect(body.aggregate.chars_typed).toBe(300);
        expect(body.aggregate.chars_pasted).toBe(50);
        expect(body.aggregate.files).toBe(2);
        expect(body.aggregate.saves).toBe(8);
      });
    });
  });

  it('returns 404 for unknown submission', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/stats`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for non-member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const owner = await seedUser(db);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, owner.id, semester.id, 'admin');
      const student = await seedStudent(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, owner.id);
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: student.id,
        ingestJobId: job.id,
      });

      const outsider = await seedUser(db);
      const outsiderSession = await seedSession(db, outsider.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/stats`, {
          headers: { Cookie: `__Host-prov_sess=${outsiderSession}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// §4. GET /submissions/:id/validation
// ---------------------------------------------------------------------------

describe('GET /submissions/:id/validation', () => {
  it('returns validation results', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const student = await seedStudent(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: student.id,
        ingestJobId: job.id,
        validationStatus: 'warn',
      });

      await db.insert(validation_results).values({
        submission_id: sub.id,
        check_1_status: 'pass',
        check_2_status: 'pass',
        check_3_status: 'pass',
        check_4_status: 'pass',
        check_5_status: 'pass',
        check_6_status: 'pass',
        check_7_status: 'pass',
        check_8_status: 'skipped',
        overall: 'warn',
        detail: [
          { id: 'manifest_sig', label: 'Bundle manifest signature', status: 'pass' },
          { id: 'session_binding', label: 'Session binding', status: 'pass' },
          { id: 'chain_integrity', label: 'Hash chain integrity', status: 'pass' },
          { id: 'seq_gaps', label: 'No seq gaps', status: 'pass' },
          { id: 'monotonic_t', label: 'Monotonic t', status: 'pass' },
          { id: 'monotonic_wall', label: 'Monotonic wall', status: 'pass' },
          { id: 'doc_save_hashes', label: 'Doc save hashes', status: 'pass' },
          {
            id: 'submitted_code_match',
            label: 'Submitted code matches final saved hashes',
            status: 'skipped',
            detail: 'Requires course-staff cross-check input.',
          },
        ] as unknown,
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/validation`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['overall']).toBe('warn');
      expect(Array.isArray(body['checks'])).toBe(true);
      const checks = body['checks'] as Array<Record<string, unknown>>;
      expect(checks).toHaveLength(8);
      expect(checks[0]?.['id']).toBe('manifest_sig');
      expect(checks[7]?.['id']).toBe('submitted_code_match');
      expect(checks[7]?.['status']).toBe('skipped');
      expect(body['validated_at']).toBeDefined();
      // The raw DB columns must not leak through the API.
      expect(body['submission_id']).toBeUndefined();
      expect(body['check_1_status']).toBeUndefined();
      expect(body['check_8_status']).toBeUndefined();
    });
  });

  it('returns 404 if no validation result yet', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const student = await seedStudent(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: student.id,
        ingestJobId: job.id,
      });

      // No validation_results row seeded

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/validation`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for unknown submission', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/validation`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// §5. GET /submissions/:id/files
// ---------------------------------------------------------------------------

describe('GET /submissions/:id/files', () => {
  it('returns file list with path, final_length, saves', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const student = await seedStudent(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: student.id,
        ingestJobId: job.id,
      });

      await db.insert(per_file_stats).values([
        {
          submission_id: sub.id,
          file_path: 'main.py',
          chars_typed: 0,
          chars_pasted: 0,
          chars_external_change_delta: 0,
          saves: 2,
          final_length: 100,
          start_length: 0,
        },
        {
          submission_id: sub.id,
          file_path: 'test.py',
          chars_typed: 0,
          chars_pasted: 0,
          chars_external_change_delta: 0,
          saves: 1,
          final_length: 50,
          start_length: 0,
        },
      ]);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/files`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        files: { path: string; final_length: number; saves: number }[];
      };
      expect(body.files).toHaveLength(2);
      const paths = body.files.map((f) => f.path).sort();
      expect(paths).toEqual(['main.py', 'test.py']);
    });
  });

  it('returns 404 for unknown submission', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/files`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for non-member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const owner = await seedUser(db);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, owner.id, semester.id, 'admin');
      const student = await seedStudent(db, semester.id);
      const assignment = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, owner.id);
      const sub = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: assignment.id,
        studentId: student.id,
        ingestJobId: job.id,
      });

      const outsider = await seedUser(db);
      const outsiderSession = await seedSession(db, outsider.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/files`, {
          headers: { Cookie: `__Host-prov_sess=${outsiderSession}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });
});
