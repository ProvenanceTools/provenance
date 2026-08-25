/**
 * Cohort + cross-flags routes integration tests (Phase 16).
 *
 * Tests all new endpoints through createV1App() per V18 rule.
 * Cohort reads are NOT logged per PRD §13 (no audit assertions here).
 *
 * Test groups:
 *   1. GET /submissions — happy path, filters, pagination, facets, sort stability
 *   2. GET /students — happy path, pagination
 *   3. GET /assignments — happy path
 *   4. GET /cross-flags — happy path, filters, pagination
 *   5. GET /cross-flags/:id — detail endpoint
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
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
  cross_flags,
  cross_flag_exclusions,
  cross_flag_participants,
} from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';
import { sql } from 'drizzle-orm';
import { seedContributor } from '../../../../test/helpers/seed-contributor.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function makeTestEnv() {
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
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-cohort-tests-12345678901234',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
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

async function seedStudent(db: DrizzleDb, semesterId: string, sid?: string, displayName?: string) {
  const [entry] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid: sid ?? `stu-${crypto.randomUUID().slice(0, 8)}`,
      display_name: displayName ?? 'Alice',
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
    recorderVersion?: string;
    supersededById?: string;
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
      score_max_severity: opts.scoreSeverity ?? 'info',
      validation_status: opts.validationStatus ?? 'pass',
      recorder_version: opts.recorderVersion ?? '1.0.0',
      ...(opts.supersededById !== undefined && {
        superseded_by_submission_id: opts.supersededById,
      }),
    })
    .returning();

  // Every real submission has a contributor row: migration 0029 backfilled one
  // for every row that predated it, and `finalizeContributors` writes one
  // inside the same transaction on every write path since. The students rollup
  // and the cohort list's student filter go through that table, so a fixture
  // without one is describing a state production cannot reach — and they
  // correctly return nothing for it.
  await seedContributor(db, sub!.id, opts.semesterId, opts.studentId, {
    score: { total: opts.scoreTotal ?? 0, maxSeverity: opts.scoreSeverity ?? 'info' },
  });

  return sub!;
}

async function seedFlag(
  db: DrizzleDb,
  opts: {
    submissionId: string;
    semesterId: string;
    heuristicId?: string;
    severity?: string;
    confidence?: number;
  },
) {
  const [f] = await db
    .insert(flags)
    .values({
      submission_id: opts.submissionId,
      semester_id: opts.semesterId,
      heuristic_id: opts.heuristicId ?? 'large_paste',
      severity: opts.severity ?? 'high',
      confidence: opts.confidence ?? 0.9,
      weight_at_compute: 1.0,
      score_contribution: 8.0,
      heuristic_config_version: 1,
    })
    .returning();

  // P1-1a: the cohort list reads flag_counts/top_flags from denormalized
  // jsonb columns. The production write path (run-per-submission /
  // recompute-submission) keeps these in sync; tests that bypass that path
  // by inserting straight into `flags` must refresh them too. Recomputing
  // from the current `flags` rows for this submission is the simplest fit.
  await db.execute(sql`
    WITH agg AS (
      SELECT
        submission_id,
        jsonb_build_object(
          'info',   COUNT(*) FILTER (WHERE severity = 'info'),
          'low',    COUNT(*) FILTER (WHERE severity = 'low'),
          'medium', COUNT(*) FILTER (WHERE severity = 'medium'),
          'high',   COUNT(*) FILTER (WHERE severity = 'high')
        ) AS counts
      FROM flags
      WHERE submission_id = ${opts.submissionId}
      GROUP BY submission_id
    ),
    top AS (
      SELECT jsonb_agg(
        jsonb_build_object('heuristic_id', heuristic_id, 'severity', severity)
        ORDER BY rn
      ) FILTER (WHERE rn <= 3) AS top
      FROM (
        SELECT
          heuristic_id,
          severity,
          ROW_NUMBER() OVER (
            ORDER BY
              CASE severity
                WHEN 'high'   THEN 3
                WHEN 'medium' THEN 2
                WHEN 'low'    THEN 1
                ELSE               0
              END DESC,
              confidence DESC
          ) AS rn
        FROM flags
        WHERE submission_id = ${opts.submissionId}
      ) ranked
    )
    UPDATE submissions
    SET
      flag_counts = COALESCE((SELECT counts FROM agg),
                             '{"info":0,"low":0,"medium":0,"high":0}'::jsonb),
      top_flags   = COALESCE((SELECT top   FROM top), '[]'::jsonb)
    WHERE id = ${opts.submissionId}
  `);

  return f!;
}

// ---------------------------------------------------------------------------
// §1. GET /semesters/:semesterId/submissions
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/submissions', () => {
  it('returns empty list for semester with no submissions', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/submissions`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: unknown[];
        next_cursor: string | null;
        total_count: number;
        facets: unknown;
      };
      expect(body.items).toHaveLength(0);
      expect(body.total_count).toBe(0);
      expect(body.next_cursor).toBeNull();
    });
  });

  it('returns submissions with SubmissionRow shape', async () => {
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
        scoreTotal: 10,
        scoreSeverity: 'high',
        validationStatus: 'warn',
      });

      await seedFlag(db, {
        submissionId: sub.id,
        semesterId: semester.id,
        heuristicId: 'large_paste',
        severity: 'high',
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/submissions`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Record<string, unknown>[];
        total_count: number;
        facets: {
          by_severity: Record<string, number>;
          by_validation: Record<string, number>;
          by_assignment: { id: string; label: string; count: number }[];
        };
      };
      expect(body.items).toHaveLength(1);
      expect(body.total_count).toBe(1);

      const item = body.items[0]!;
      expect(item['id']).toBe(sub.id);
      expect(item['score_total']).toBe(10);
      expect(item['score_max_severity']).toBe('high');
      expect(item['validation_status']).toBe('warn');
      expect(item['superseded']).toBe(false);
      expect((item['assignment'] as Record<string, unknown>)['id']).toBe(assignment.id);
      expect((item['student'] as Record<string, unknown>)['id']).toBe(student.id);

      // Check flag_counts and top_flags
      const flagCounts = item['flag_counts'] as Record<string, number>;
      expect(flagCounts['high']).toBe(1);

      const topFlags = item['top_flags'] as { heuristic_id: string; severity: string }[];
      expect(topFlags).toHaveLength(1);
      expect(topFlags[0]!.heuristic_id).toBe('large_paste');

      // Facets
      expect(body.facets.by_severity['high']).toBe(1);
      expect(body.facets.by_validation['warn']).toBe(1);
      expect(body.facets.by_assignment).toHaveLength(1);
      expect(body.facets.by_assignment[0]!.count).toBe(1);
    });
  });

  it('filters by assignment_id', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const student = await seedStudent(db, semester.id);
      const a1 = await seedAssignment(db, semester.id, 'HW1');
      const a2 = await seedAssignment(db, semester.id, 'HW2');
      const job = await seedIngestJob(db, semester.id, user.id);
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a1.id,
        studentId: student.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a2.id,
        studentId: student.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/submissions?assignment_id=${a1.id}`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { id: string }[]; total_count: number };
      expect(body.items).toHaveLength(1);
      expect(body.total_count).toBe(1);
    });
  });

  it('filters by validation_status', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const s2 = await seedStudent(db, semester.id, 'stu002');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        validationStatus: 'pass',
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s2.id,
        ingestJobId: job.id,
        validationStatus: 'fail',
        versionIndex: 1,
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/submissions?validation_status=fail`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { id: string }[] };
      expect(body.items).toHaveLength(1);
    });
  });

  it('filters by severity_min', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const s2 = await seedStudent(db, semester.id, 'stu002');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // info severity submission
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        scoreSeverity: 'info',
        versionIndex: 1,
      });
      // high severity submission
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s2.id,
        ingestJobId: job.id,
        scoreSeverity: 'high',
        versionIndex: 1,
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/submissions?severity_min=medium`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { score_max_severity: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.score_max_severity).toBe('high');
    });
  });

  it('filters by score_min and score_max', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const s2 = await seedStudent(db, semester.id, 'stu002');
      const s3 = await seedStudent(db, semester.id, 'stu003');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        scoreTotal: 5,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s2.id,
        ingestJobId: job.id,
        scoreTotal: 10,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s3.id,
        ingestJobId: job.id,
        scoreTotal: 20,
        versionIndex: 1,
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/submissions?score_min=8&score_max=15`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { score_total: number }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.score_total).toBe(10);
    });
  });

  it('filters include_superseded=false (default) excludes superseded', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const student = await seedStudent(db, semester.id);
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // Seed v2 (active) then v1 (superseded by v2)
      const sub2 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: student.id,
        ingestJobId: job.id,
        versionIndex: 2,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: student.id,
        ingestJobId: job.id,
        versionIndex: 1,
        supersededById: sub2.id,
      });

      const app = createV1App();

      // Default: include_superseded=false
      const res1 = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/submissions`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        items: { superseded: boolean }[];
        total_count: number;
      };
      expect(body1.items).toHaveLength(1);
      expect(body1.items[0]!.superseded).toBe(false);
      expect(body1.total_count).toBe(1);

      // include_superseded=true shows both
      const res2 = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/submissions?include_superseded=true`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { items: unknown[]; total_count: number };
      expect(body2.items).toHaveLength(2);
      expect(body2.total_count).toBe(2);
    });
  });

  it('filters by q (free-text on display_name)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const alice = await seedStudent(db, semester.id, 'stu001', 'Alice Smith');
      const bob = await seedStudent(db, semester.id, 'stu002', 'Bob Jones');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: alice.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: bob.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/submissions?q=alice`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { student: { display_name: string } }[];
      };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.student.display_name).toBe('Alice Smith');
    });
  });

  it('filters by flag_id (heuristic filter)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const s2 = await seedStudent(db, semester.id, 'stu002');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      const sub1 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s2.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      // Only sub1 has a large_paste flag
      await seedFlag(db, {
        submissionId: sub1.id,
        semesterId: semester.id,
        heuristicId: 'large_paste',
        severity: 'high',
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/submissions?flag_id=large_paste`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { id: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.id).toBe(sub1.id);
    });
  });

  it('sort stability: equal scores order by id desc', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const s2 = await seedStudent(db, semester.id, 'stu002');
      const s3 = await seedStudent(db, semester.id, 'stu003');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // All 3 have score_total=5 → sort by id DESC
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        scoreTotal: 5,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s2.id,
        ingestJobId: job.id,
        scoreTotal: 5,
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s3.id,
        ingestJobId: job.id,
        scoreTotal: 5,
        versionIndex: 1,
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/submissions?sort=score_desc`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { id: string }[] };
      expect(body.items).toHaveLength(3);

      // All IDs sorted descending
      const ids = body.items.map((i) => i.id);
      const sorted = [...ids].sort().reverse();
      expect(ids).toEqual(sorted);
    });
  });

  it('cursor pagination round-trip (page1 + page2 = full list)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // Seed 5 submissions with distinct scores
      const studentIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const s = await seedStudent(db, semester.id, `stu00${i}`);
        studentIds.push(s.id);
        await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: a.id,
          studentId: s.id,
          ingestJobId: job.id,
          scoreTotal: (5 - i) * 10,
          versionIndex: 1,
        });
      }

      const app = createV1App();
      const base = `http://localhost/semesters/${semester.id}/submissions`;

      // Page 1: limit=2
      const res1 = await app.fetch(
        new Request(`${base}?limit=2&sort=score_desc`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        items: { id: string }[];
        next_cursor: string | null;
      };
      expect(body1.items).toHaveLength(2);
      expect(body1.next_cursor).not.toBeNull();

      // Page 2: limit=2 with cursor
      const res2 = await app.fetch(
        new Request(`${base}?limit=2&sort=score_desc&cursor=${body1.next_cursor!}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as {
        items: { id: string }[];
        next_cursor: string | null;
      };
      expect(body2.items).toHaveLength(2);

      // Page 3: remaining
      const res3 = await app.fetch(
        new Request(`${base}?limit=2&sort=score_desc&cursor=${body2.next_cursor!}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res3.status).toBe(200);
      const body3 = (await res3.json()) as {
        items: { id: string }[];
        next_cursor: string | null;
      };
      expect(body3.items).toHaveLength(1);
      expect(body3.next_cursor).toBeNull();

      // All 5 unique IDs with no duplicates
      const allIds = [
        ...body1.items.map((i) => i.id),
        ...body2.items.map((i) => i.id),
        ...body3.items.map((i) => i.id),
      ];
      expect(new Set(allIds).size).toBe(5);
    });
  });

  it('sort=ingested_desc cursor round-trip', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // Seed 5 submissions with distinct ingested_at timestamps
      const submissionIds: string[] = [];
      const baseTime = new Date('2025-01-15T10:00:00Z').getTime();
      for (let i = 0; i < 5; i++) {
        const s = await seedStudent(db, semester.id, `stu00${i}`);
        const id = crypto.randomUUID();
        submissionIds.push(id);
        // Insert directly with distinct ingested_at times (descending)
        await db.insert(submissions).values({
          id,
          semester_id: semester.id,
          assignment_id: a.id,
          student_id: s.id,
          blob_object_key: `semesters/${semester.id}/submissions/${id}/bundle.zip`,
          blob_sha256: `sha256-${id}`,
          source_filename: 'test.zip',
          ingest_job_id: job.id,
          version_index: 1,
          ingested_at: new Date(baseTime + (4 - i) * 5000), // 20s, 15s, 10s, 5s, 0s
          score_total: 0,
          score_max_severity: 'info',
          validation_status: 'pass',
          recorder_version: '1.0.0',
        });
      }

      const app = createV1App();
      const base = `http://localhost/semesters/${semester.id}/submissions`;

      // Page 1: limit=2, sort=ingested_desc
      const res1 = await app.fetch(
        new Request(`${base}?limit=2&sort=ingested_desc`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        items: { id: string }[];
        next_cursor: string | null;
      };
      expect(body1.items).toHaveLength(2);
      expect(body1.next_cursor).not.toBeNull();

      // Page 2: limit=2 with cursor
      const res2 = await app.fetch(
        new Request(`${base}?limit=2&sort=ingested_desc&cursor=${body1.next_cursor!}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as {
        items: { id: string }[];
        next_cursor: string | null;
      };
      expect(body2.items).toHaveLength(2);

      // Page 3: remaining
      const res3 = await app.fetch(
        new Request(`${base}?limit=2&sort=ingested_desc&cursor=${body2.next_cursor!}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res3.status).toBe(200);
      const body3 = (await res3.json()) as {
        items: { id: string }[];
        next_cursor: string | null;
      };
      expect(body3.items).toHaveLength(1);
      expect(body3.next_cursor).toBeNull();

      // All 5 unique IDs with no duplicates
      const allIds = [
        ...body1.items.map((i) => i.id),
        ...body2.items.map((i) => i.id),
        ...body3.items.map((i) => i.id),
      ];
      expect(new Set(allIds).size).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Keyset pagination across a shared millisecond, `sort=ingested_desc`.
  //
  // Postgres stores `timestamptz` at MICROSECOND precision; a JS `Date` — which
  // is what Drizzle's default `mode: 'date'` hands back — carries only
  // MILLISECONDS. The cursor used to be minted from that Date, so it could not
  // express the true position of the last row on the page, and every same-ms
  // row had to be decided by the uuid tiebreak instead. `id` is a random
  // `gen_random_uuid()`, so that tiebreak contradicts the true microsecond
  // ordering the query ORDERs BY: rows fall through both branches and vanish,
  // with `next_cursor` still reporting success.
  //
  // Batch ingest writes many submissions in one go, so sharing a millisecond
  // is the normal case here, not an edge case — and this is the hot path a
  // grader browses.
  //
  // Note this defect is INDEPENDENT of the bucket-coverage one: the branches
  // below already covered `[floor, floor+1ms)` with no gap. Only the
  // timestamp's lost precision drops these rows.
  // -------------------------------------------------------------------------
  it('sort=ingested_desc does not drop submissions sharing a millisecond with the cursor row', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // Five submissions inside ONE millisecond, each with a distinct non-zero
      // microsecond remainder. A `Date` cannot express microseconds, so the
      // value is written as a literal string.
      const SHARED_MS = '2026-08-20T12:00:00.500';
      const MICROS = ['123', '456', '789', '012', '345'];
      for (let i = 0; i < MICROS.length; i++) {
        const s = await seedStudent(db, semester.id, `stu00${i}`);
        const id = crypto.randomUUID();
        await db.insert(submissions).values({
          id,
          semester_id: semester.id,
          assignment_id: a.id,
          student_id: s.id,
          blob_object_key: `semesters/${semester.id}/submissions/${id}/bundle.zip`,
          blob_sha256: `sha256-${id}`,
          source_filename: 'test.zip',
          ingest_job_id: job.id,
          version_index: 1,
          ingested_at: sql`${`${SHARED_MS}${MICROS[i]}+00`}::timestamptz`,
          score_total: 0,
          score_max_severity: 'info',
          validation_status: 'pass',
          recorder_version: '1.0.0',
        });
      }

      const app = createV1App();
      const base = `http://localhost/semesters/${semester.id}/submissions`;

      // Walk every page to exhaustion, exactly as a client would.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const url: string =
          cursor === null
            ? `${base}?limit=2&sort=ingested_desc`
            : `${base}?limit=2&sort=ingested_desc&cursor=${cursor}`;
        const res = await app.fetch(
          new Request(url, { headers: { Cookie: `__Host-prov_sess=${sessionId}` } }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: { id: string }[];
          next_cursor: string | null;
        };
        seen.push(...body.items.map((i) => i.id));
        cursor = body.next_cursor;
        if (cursor === null) break;
      }

      // Every submission is reachable, exactly once. `Set` size guards the
      // opposite failure: a cursor that re-serves rows is not a fix either.
      expect(seen).toHaveLength(MICROS.length);
      expect(new Set(seen).size).toBe(MICROS.length);
    });
  });

  // -------------------------------------------------------------------------
  // The DESC bucket predicate did not only DROP rows — it also RE-SERVED them,
  // and that is a genuinely separate failure mode from the one above.
  //
  // Same cause, opposite direction. Against a cursor that can only express its
  // millisecond FLOOR, a same-bucket row whose true microsecond is LATER than
  // the cursor row's (so it was already returned on an earlier page) still
  // satisfies `ingested_at >= floor AND < floor+1ms AND id < cursor.id`
  // whenever its random uuid happens to sort below the cursor's. It comes back
  // a second time.
  //
  // Pinned separately because a future refactor could reintroduce one without
  // the other, and because the assertion order matters: the duplicate check
  // runs FIRST and names the repeated ids, so a re-serve regression reports as
  // a re-serve rather than being masked by a length mismatch.
  // -------------------------------------------------------------------------
  it('sort=ingested_desc never re-serves a submission sharing a millisecond', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // Eight rows in ONE millisecond. More rows than the drop test, and more
      // pages, so there are more chances for a re-serve to occur — with random
      // uuids the effect is probabilistic per row, and 8 rows at limit=2 makes
      // a surviving bug overwhelmingly likely to show.
      const SHARED_MS = '2026-08-20T12:00:00.500';
      const MICROS = ['111', '222', '333', '444', '555', '666', '777', '888'];
      for (let i = 0; i < MICROS.length; i++) {
        const s = await seedStudent(db, semester.id, `stu10${i}`);
        const id = crypto.randomUUID();
        await db.insert(submissions).values({
          id,
          semester_id: semester.id,
          assignment_id: a.id,
          student_id: s.id,
          blob_object_key: `semesters/${semester.id}/submissions/${id}/bundle.zip`,
          blob_sha256: `sha256-${id}`,
          source_filename: 'test.zip',
          ingest_job_id: job.id,
          version_index: 1,
          ingested_at: sql`${`${SHARED_MS}${MICROS[i]}+00`}::timestamptz`,
          score_total: 0,
          score_max_severity: 'info',
          validation_status: 'pass',
          recorder_version: '1.0.0',
        });
      }

      const app = createV1App();
      const base = `http://localhost/semesters/${semester.id}/submissions`;

      const seen: string[] = [];
      let cursor: string | null = null;
      // A re-serving cursor can fail to terminate, so the page cap is well
      // above the 4 pages a correct implementation needs.
      for (let page = 0; page < 20; page++) {
        const url: string =
          cursor === null
            ? `${base}?limit=2&sort=ingested_desc`
            : `${base}?limit=2&sort=ingested_desc&cursor=${cursor}`;
        const res = await app.fetch(
          new Request(url, { headers: { Cookie: `__Host-prov_sess=${sessionId}` } }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: { id: string }[];
          next_cursor: string | null;
        };
        seen.push(...body.items.map((i) => i.id));
        cursor = body.next_cursor;
        if (cursor === null) break;
      }

      // FIRST: nothing came back twice. This is the assertion this test exists
      // for, and it fails independently of whether anything was also dropped.
      const counts = new Map<string, number>();
      for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
      const repeated = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
      expect(repeated).toEqual([]);

      // THEN: and nothing was dropped either.
      expect(seen).toHaveLength(MICROS.length);
    });
  });

  // A cursor minted before the microsecond fix carries a millisecond-precision
  // timestamp under `kind: 'wall'`. Honouring it would silently drop the rest
  // of its millisecond bucket, so it is rejected and the client restarts.
  it('sort=ingested_desc rejects a legacy millisecond-precision cursor with 400', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      // Exactly the shape `encodeCursor` produced before this change.
      const legacy = Buffer.from(
        JSON.stringify({ kind: 'wall', wall: '2026-08-20T12:00:00.500Z', id: crypto.randomUUID() }),
      ).toString('base64url');

      const app = createV1App();
      const res = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/submissions?limit=2&sort=ingested_desc&cursor=${legacy}`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );
      expect(res.status).toBe(400);
    });
  });

  it('facets respect filter-minus-dimension semantics', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const s2 = await seedStudent(db, semester.id, 'stu002');
      const a1 = await seedAssignment(db, semester.id, 'HW1');
      const a2 = await seedAssignment(db, semester.id, 'HW2');
      const job = await seedIngestJob(db, semester.id, user.id);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a1.id,
        studentId: s1.id,
        ingestJobId: job.id,
        scoreSeverity: 'high',
        validationStatus: 'fail',
        versionIndex: 1,
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a2.id,
        studentId: s2.id,
        ingestJobId: job.id,
        scoreSeverity: 'low',
        validationStatus: 'pass',
        versionIndex: 1,
      });

      const app = createV1App();

      // Filter by assignment_id=a1: by_assignment facet should still show both
      const res = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/submissions?assignment_id=${a1.id}`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: unknown[];
        facets: {
          by_severity: Record<string, number>;
          by_validation: Record<string, number>;
          by_assignment: { id: string; count: number }[];
        };
      };

      // Items filtered to 1 (a1 only)
      expect(body.items).toHaveLength(1);

      // by_assignment facet ignores assignmentId filter → shows both assignments
      expect(body.facets.by_assignment).toHaveLength(2);

      // by_severity facet applies current filters (with a1 filter)
      expect(body.facets.by_severity['high']).toBe(1);
      expect(body.facets.by_severity['low'] ?? 0).toBe(0);
    });
  });

  it('returns 401 without auth', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const { semester } = await seedCourseAndSemester(db);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/submissions`),
      );
      expect(res.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// §2. GET /semesters/:semesterId/students
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/students', () => {
  it('returns per-student aggregations', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001', 'Alice');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        scoreTotal: 15,
        versionIndex: 1,
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/students`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: {
          student: { id: string; display_name: string };
          submission_count: number;
          score_sum: number;
          score_max: number;
          worst_submission: { id: string };
        }[];
        total_count: number;
      };
      expect(body.items).toHaveLength(1);
      expect(body.total_count).toBe(1);

      const item = body.items[0]!;
      expect(item.student.display_name).toBe('Alice');
      expect(item.submission_count).toBe(1);
      expect(item.score_sum).toBe(15);
      expect(item.score_max).toBe(15);
      expect(item.worst_submission).toBeDefined();
    });
  });

  it('cursor pagination round-trip for students', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // 4 students, each with 1 submission
      for (let i = 0; i < 4; i++) {
        const s = await seedStudent(db, semester.id, `stu00${i}`, `Student ${i}`);
        await seedSubmission(db, {
          semesterId: semester.id,
          assignmentId: a.id,
          studentId: s.id,
          ingestJobId: job.id,
          scoreTotal: (4 - i) * 10,
          versionIndex: 1,
        });
      }

      const app = createV1App();
      const base = `http://localhost/semesters/${semester.id}/students`;

      const res1 = await app.fetch(
        new Request(`${base}?limit=2&sort=score_sum_desc`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        items: { student: { id: string } }[];
        next_cursor: string | null;
      };
      expect(body1.items).toHaveLength(2);
      expect(body1.next_cursor).not.toBeNull();

      const res2 = await app.fetch(
        new Request(`${base}?limit=2&sort=score_sum_desc&cursor=${body1.next_cursor!}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as {
        items: { student: { id: string } }[];
        next_cursor: string | null;
      };
      expect(body2.items).toHaveLength(2);
      expect(body2.next_cursor).toBeNull();

      // No duplicates
      const allIds = [
        ...body1.items.map((i) => i.student.id),
        ...body2.items.map((i) => i.student.id),
      ];
      expect(new Set(allIds).size).toBe(4);
    });
  });
});

// ---------------------------------------------------------------------------
// §3. GET /semesters/:semesterId/assignments
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/assignments', () => {
  it('returns assignment summaries with stats', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const s2 = await seedStudent(db, semester.id, 'stu002');
      const a1 = await seedAssignment(db, semester.id, 'HW1');
      const a2 = await seedAssignment(db, semester.id, 'HW2');
      const job = await seedIngestJob(db, semester.id, user.id);

      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a1.id,
        studentId: s1.id,
        ingestJobId: job.id,
        scoreTotal: 10,
        versionIndex: 1,
        validationStatus: 'pass',
      });
      await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a1.id,
        studentId: s2.id,
        ingestJobId: job.id,
        scoreTotal: 20,
        versionIndex: 1,
        validationStatus: 'fail',
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/assignments`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: {
          id: string;
          label: string;
          submission_count: number;
          distinct_students: number;
          mean_score: number;
          fail_count: number;
        }[];
      };
      expect(body.items).toHaveLength(2);

      const hw1 = body.items.find((a) => a.id === a1.id)!;
      expect(hw1.submission_count).toBe(2);
      expect(hw1.distinct_students).toBe(2);
      expect(hw1.mean_score).toBeCloseTo(15);
      expect(hw1.fail_count).toBe(1);

      const hw2 = body.items.find((a) => a.id === a2.id)!;
      expect(hw2.submission_count).toBe(0);
    });
  });

  it('returns empty list when no assignments exist', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/assignments`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// §4. GET /semesters/:semesterId/cross-flags
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/cross-flags — the exclusion register', () => {
  it('returns the register beside the findings, on the first page only', async () => {
    // Spec S20 / §6 Rule 3. The register is a sibling array, NOT an item: an
    // exclusion is a fact about the recording, never a finding about a person,
    // and folding it into `items` would give it a severity by association.
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu101');
      const s2 = await seedStudent(db, semester.id, 'stu102');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub1 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      const sub2 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s2.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      const commitKey = `repository:assumed-single ${'a1'.repeat(20)}`;
      await db.insert(cross_flag_exclusions).values({
        semester_id: semester.id,
        reason: 'same_repository_lineage',
        submission_ids: [sub1.id, sub2.id].sort(),
        shared_commits: [commitKey],
        excluded_pair_count: 1,
      });

      // Two flags so there is a second page to ask for.
      for (const heuristicId of ['paste_shared_across_students', 'editing_pattern_clone']) {
        const [cf] = await db
          .insert(cross_flags)
          .values({
            semester_id: semester.id,
            heuristic_id: heuristicId,
            severity: 'high',
            confidence: 0.95,
            heuristic_config_version: 1,
          })
          .returning();
        await db.insert(cross_flag_participants).values([
          { cross_flag_id: cf!.id, submission_id: sub1.id, supporting_seqs: [1] },
          { cross_flag_id: cf!.id, submission_id: sub2.id, supporting_seqs: [2] },
        ]);
      }

      const app = createV1App();
      const base = `http://localhost/semesters/${semester.id}/cross-flags`;
      const headers = { Cookie: `__Host-prov_sess=${sessionId}` };

      type Body = {
        items: { id: string }[];
        next_cursor: string | null;
        exclusions: {
          id: string;
          reason: string;
          members: { submission_id: string; source_filename: string; student: unknown }[];
          shared_commits: string[];
          excluded_pair_count: number;
        }[];
      };

      const page1 = await app.fetch(new Request(`${base}?limit=1`, { headers }));
      expect(page1.status).toBe(200);
      const body1 = (await page1.json()) as Body;

      expect(body1.exclusions).toHaveLength(1);
      expect(body1.exclusions[0]!.reason).toBe('same_repository_lineage');
      expect(body1.exclusions[0]!.excluded_pair_count).toBe(1);
      expect(body1.exclusions[0]!.shared_commits).toEqual([commitKey]);
      expect(body1.exclusions[0]!.members.map((m) => m.submission_id).sort()).toEqual(
        [sub1.id, sub2.id].sort(),
      );
      // No exclusion leaked into the findings list.
      expect(body1.items).toHaveLength(1);

      // The register is not paginated: it belongs to the whole list, and
      // repeating it on every page would be payload for nothing.
      expect(body1.next_cursor).not.toBeNull();
      const page2 = await app.fetch(
        new Request(`${base}?limit=1&cursor=${body1.next_cursor!}`, { headers }),
      );
      const body2 = (await page2.json()) as Body;
      expect(body2.exclusions).toEqual([]);
    });
  });

  it('returns an empty register for a semester that excluded nothing', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/cross-flags`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { exclusions: unknown[] };
      expect(body.exclusions).toEqual([]);
    });
  });
});

describe('GET /semesters/:semesterId/cross-flags', () => {
  it('returns cross-flags with participants', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const s2 = await seedStudent(db, semester.id, 'stu002');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub1 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      const sub2 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s2.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      // Insert cross_flag + participants
      const [cf] = await db
        .insert(cross_flags)
        .values({
          semester_id: semester.id,
          heuristic_id: 'paste_shared_across_students',
          severity: 'high',
          confidence: 0.95,
          heuristic_config_version: 1,
        })
        .returning();

      await db.insert(cross_flag_participants).values([
        { cross_flag_id: cf!.id, submission_id: sub1.id, supporting_seqs: [1, 2] },
        { cross_flag_id: cf!.id, submission_id: sub2.id, supporting_seqs: [3, 4] },
      ]);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/cross-flags`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: {
          id: string;
          heuristic_id: string;
          severity: string;
          participants: {
            submission_id: string;
            student: { id: string };
            assignment: { id: string };
            supporting_seqs: number[];
          }[];
        }[];
        next_cursor: string | null;
      };
      expect(body.items).toHaveLength(1);
      expect(body.next_cursor).toBeNull();

      const item = body.items[0]!;
      expect(item.heuristic_id).toBe('paste_shared_across_students');
      expect(item.severity).toBe('high');
      expect(item.participants).toHaveLength(2);

      // Both participants have student + assignment nested objects
      const p1 = item.participants.find((p) => p.submission_id === sub1.id);
      expect(p1).toBeDefined();
      expect(p1!.student.id).toBe(s1.id);
      expect(p1!.assignment.id).toBe(a.id);
      expect(p1!.supporting_seqs).toEqual([1, 2]);
    });
  });

  it('filters by heuristic_id', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub1 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      // Two cross-flags with different heuristic_ids
      const [cf1] = await db
        .insert(cross_flags)
        .values({
          semester_id: semester.id,
          heuristic_id: 'paste_shared_across_students',
          severity: 'high',
          confidence: 0.9,
          heuristic_config_version: 1,
        })
        .returning();
      const [cf2] = await db
        .insert(cross_flags)
        .values({
          semester_id: semester.id,
          heuristic_id: 'editing_pattern_clone',
          severity: 'medium',
          confidence: 0.7,
          heuristic_config_version: 1,
        })
        .returning();

      await db.insert(cross_flag_participants).values([
        { cross_flag_id: cf1!.id, submission_id: sub1.id },
        { cross_flag_id: cf2!.id, submission_id: sub1.id },
      ]);

      const app = createV1App();
      const res = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/cross-flags?heuristic_id=paste_shared_across_students`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { heuristic_id: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.heuristic_id).toBe('paste_shared_across_students');
    });
  });

  it('filters by severity_min', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub1 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      const [cfLow] = await db
        .insert(cross_flags)
        .values({
          semester_id: semester.id,
          heuristic_id: 'editing_pattern_clone',
          severity: 'low',
          confidence: 0.5,
          heuristic_config_version: 1,
        })
        .returning();
      const [cfHigh] = await db
        .insert(cross_flags)
        .values({
          semester_id: semester.id,
          heuristic_id: 'paste_shared_across_students',
          severity: 'high',
          confidence: 0.9,
          heuristic_config_version: 1,
        })
        .returning();

      await db.insert(cross_flag_participants).values([
        { cross_flag_id: cfLow!.id, submission_id: sub1.id },
        { cross_flag_id: cfHigh!.id, submission_id: sub1.id },
      ]);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/cross-flags?severity_min=medium`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { severity: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.severity).toBe('high');
    });
  });

  it('filters by submission_id', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const s2 = await seedStudent(db, semester.id, 'stu002');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub1 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      const sub2 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s2.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      const [cf1] = await db
        .insert(cross_flags)
        .values({
          semester_id: semester.id,
          heuristic_id: 'paste_shared_across_students',
          severity: 'high',
          confidence: 0.9,
          heuristic_config_version: 1,
        })
        .returning();
      const [cf2] = await db
        .insert(cross_flags)
        .values({
          semester_id: semester.id,
          heuristic_id: 'editing_pattern_clone',
          severity: 'medium',
          confidence: 0.7,
          heuristic_config_version: 1,
        })
        .returning();

      // cf1 involves both sub1 and sub2; cf2 only sub2
      await db.insert(cross_flag_participants).values([
        { cross_flag_id: cf1!.id, submission_id: sub1.id },
        { cross_flag_id: cf1!.id, submission_id: sub2.id },
        { cross_flag_id: cf2!.id, submission_id: sub2.id },
      ]);

      // Filter by sub1 → only cf1
      const app = createV1App();
      const res = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/cross-flags?submission_id=${sub1.id}`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { id: string }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.id).toBe(cf1!.id);
    });
  });

  it('cursor pagination round-trip for cross-flags', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub1 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      // Seed 3 cross_flags
      for (let i = 0; i < 3; i++) {
        const [cf] = await db
          .insert(cross_flags)
          .values({
            semester_id: semester.id,
            heuristic_id: `heuristic_${i}`,
            severity: 'medium',
            confidence: 0.7,
            heuristic_config_version: 1,
          })
          .returning();
        await db
          .insert(cross_flag_participants)
          .values([{ cross_flag_id: cf!.id, submission_id: sub1.id }]);
      }

      const app = createV1App();
      const base = `http://localhost/semesters/${semester.id}/cross-flags`;

      const res1 = await app.fetch(
        new Request(`${base}?limit=2`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        items: { id: string }[];
        next_cursor: string | null;
      };
      expect(body1.items).toHaveLength(2);
      expect(body1.next_cursor).not.toBeNull();

      const res2 = await app.fetch(
        new Request(`${base}?limit=2&cursor=${body1.next_cursor!}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as {
        items: { id: string }[];
        next_cursor: string | null;
      };
      expect(body2.items).toHaveLength(1);
      expect(body2.next_cursor).toBeNull();

      const allIds = [...body1.items.map((i) => i.id), ...body2.items.map((i) => i.id)];
      expect(new Set(allIds).size).toBe(3);
    });
  });

  // Regression: the cursor carries a MILLISECOND-precision timestamp while
  // Postgres stores `timestamptz` at MICROSECOND precision, so every keyset
  // comparison has to be written against the cursor's millisecond BUCKET.
  // The original predicate was not, and it dropped rows in two ways at once:
  // it bounded the same-ms branch above by `<= floor` (excluding every row
  // whose microsecond remainder is non-zero) and used `floor - 1ms` as the
  // lower bound (pulling the previous millisecond's rows into an id tiebreak
  // they should never have faced).
  //
  // This matters in production, not just here: `recompute_cross_flags` writes
  // a whole batch at once, so cross flags sharing a millisecond is the NORMAL
  // case. Every dropped row is a collusion finding a grader never sees, and
  // nothing anywhere reports that the page was short.
  //
  // The timestamps are fixed rather than defaulted so this test is
  // deterministic; the pre-existing sibling above seeds whatever `now()`
  // returns, which is why the defect read as a flake for weeks.
  it('does not drop cross-flags that share a millisecond with the cursor row', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub1 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      // Five flags inside ONE millisecond, each with a distinct non-zero
      // microsecond remainder. A `Date` cannot express microseconds, so the
      // value is written as a literal string.
      const SHARED_MS = '2026-08-20T12:00:00.500';
      const MICROS = ['123', '456', '789', '012', '345'];
      for (let i = 0; i < MICROS.length; i++) {
        const [cf] = await db
          .insert(cross_flags)
          .values({
            semester_id: semester.id,
            heuristic_id: `same_ms_${i}`,
            severity: 'medium',
            confidence: 0.7,
            heuristic_config_version: 1,
            created_at: sql`${`${SHARED_MS}${MICROS[i]}+00`}::timestamptz`,
          })
          .returning();
        await db
          .insert(cross_flag_participants)
          .values([{ cross_flag_id: cf!.id, submission_id: sub1.id }]);
      }

      const app = createV1App();
      const base = `http://localhost/semesters/${semester.id}/cross-flags`;

      // Walk every page to exhaustion, exactly as a client would.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const url: string =
          cursor === null ? `${base}?limit=2` : `${base}?limit=2&cursor=${cursor}`;
        const res = await app.fetch(
          new Request(url, { headers: { Cookie: `__Host-prov_sess=${sessionId}` } }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: { id: string }[];
          next_cursor: string | null;
        };
        seen.push(...body.items.map((i) => i.id));
        cursor = body.next_cursor;
        if (cursor === null) break;
      }

      // Every flag is reachable, exactly once. Before the fix this returned 2
      // of 5 — page 1, and then nothing, with `next_cursor` reporting success.
      expect(seen).toHaveLength(MICROS.length);
      expect(new Set(seen).size).toBe(MICROS.length);
    });
  });

  // Proving the negative: the keyset rewrite must not have made the trivial
  // cases wrong. An empty result returns no items and a NULL cursor — never a
  // cursor pointing at nothing, which would make a client page forever.
  it('returns an empty page and a null cursor when a semester has no cross-flags', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/cross-flags?limit=2`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: unknown[];
        next_cursor: string | null;
      };
      expect(body.items).toHaveLength(0);
      expect(body.next_cursor).toBeNull();
    });
  });

  // A cursor minted before the microsecond fix carries a millisecond-precision
  // timestamp. Honouring it would silently drop the rest of its millisecond
  // bucket, so it is rejected and the client restarts pagination.
  it('rejects a legacy millisecond-precision cross-flag cursor with 400', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      // Exactly the shape `encodeCrossFlagCursor` produced before this change.
      const legacy = Buffer.from(
        JSON.stringify({ created_at: '2026-08-20T12:00:00.500Z', id: crypto.randomUUID() }),
      ).toString('base64url');

      const app = createV1App();
      const res = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/cross-flags?limit=2&cursor=${legacy}`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );
      expect(res.status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// §5. GET /cross-flags/:crossFlagId (detail — top-level)
// ---------------------------------------------------------------------------

describe('GET /cross-flags/:crossFlagId', () => {
  it('returns cross-flag detail with full participants', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const s2 = await seedStudent(db, semester.id, 'stu002');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub1 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      const sub2 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s2.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      const [cf] = await db
        .insert(cross_flags)
        .values({
          semester_id: semester.id,
          heuristic_id: 'paste_shared_across_students',
          severity: 'high',
          confidence: 0.95,
          heuristic_config_version: 1,
        })
        .returning();

      await db.insert(cross_flag_participants).values([
        { cross_flag_id: cf!.id, submission_id: sub1.id, supporting_seqs: [10, 11] },
        { cross_flag_id: cf!.id, submission_id: sub2.id, supporting_seqs: [20] },
      ]);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/cross-flags/${cf!.id}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        item: {
          id: string;
          heuristic_id: string;
          severity: string;
          participants: {
            submission_id: string;
            student: { id: string };
            assignment: { id: string };
            supporting_seqs: number[];
          }[];
        };
      };
      const item = body.item;

      expect(item.id).toBe(cf!.id);
      expect(item.heuristic_id).toBe('paste_shared_across_students');
      expect(item.participants).toHaveLength(2);

      const p1 = item.participants.find((p) => p.submission_id === sub1.id);
      expect(p1).toBeDefined();
      expect(p1!.supporting_seqs).toEqual([10, 11]);
    });
  });

  it('returns 404 for unknown crossFlagId', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/cross-flags/${crypto.randomUUID()}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  it('returns 404 when user is not a member of the cross-flag semester', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const owner = await seedUser(db);
      const outsider = await seedUser(db);
      const outsiderSession = await seedSession(db, outsider.id);

      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, owner.id, semester.id, 'admin');

      const s1 = await seedStudent(db, semester.id, 'stu001');
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, owner.id);
      const sub1 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });

      const [cf] = await db
        .insert(cross_flags)
        .values({
          semester_id: semester.id,
          heuristic_id: 'paste_shared_across_students',
          severity: 'high',
          confidence: 0.9,
          heuristic_config_version: 1,
        })
        .returning();
      await db
        .insert(cross_flag_participants)
        .values([{ cross_flag_id: cf!.id, submission_id: sub1.id }]);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/cross-flags/${cf!.id}`, {
          headers: { Cookie: `__Host-prov_sess=${outsiderSession}` },
        }),
      );
      // Returns 404 (not 403) to avoid leaking cross_flag existence
      expect(res.status).toBe(404);
    });
  });

  it('returns 401 without auth', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const { semester } = await seedCourseAndSemester(db);
      const s1 = await seedStudent(db, semester.id, 'stu001');
      const user = await seedUser(db);
      const a = await seedAssignment(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);
      const sub1 = await seedSubmission(db, {
        semesterId: semester.id,
        assignmentId: a.id,
        studentId: s1.id,
        ingestJobId: job.id,
        versionIndex: 1,
      });
      const [cf] = await db
        .insert(cross_flags)
        .values({
          semester_id: semester.id,
          heuristic_id: 'paste_shared_across_students',
          severity: 'high',
          confidence: 0.9,
          heuristic_config_version: 1,
        })
        .returning();
      await db
        .insert(cross_flag_participants)
        .values([{ cross_flag_id: cf!.id, submission_id: sub1.id }]);

      const app = createV1App();
      const res = await app.fetch(new Request(`http://localhost/cross-flags/${cf!.id}`));
      expect(res.status).toBe(401);
    });
  });
});
