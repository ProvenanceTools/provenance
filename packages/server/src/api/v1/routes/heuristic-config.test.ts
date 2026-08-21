/**
 * Heuristic config route integration tests — Phase 13a.
 *
 * All tests go through the full v1 app pipeline via createV1App() (V18 rule).
 * Tests are DB-backed via testcontainers (withTestDb).
 *
 * Coverage:
 *   - GET /heuristic-config: returns active config / default when none
 *   - GET /heuristic-configs: returns history array
 *   - PUT?dryRun=true: returns DryRunDiff shape; no DB writes
 *   - PUT?dryRun=true with invalid candidate: 422
 *   - PUT (no dryRun): 501
 *   - PUT with If-Match mismatch: 409
 *   - PUT without If-Match: 428
 *   - computeDryRunDiff unit cases: empty semester, all-same scores, real diff
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../../../test/helpers/db.js';
import { withTestMinio } from '../../../../test/helpers/minio.js';
import { waitForAuditRow } from '../../../../test/helpers/audit.js';
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
  heuristic_configs,
  recompute_jobs,
  roster_entries,
  assignments,
  submissions,
  flags,
} from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';
import { DEFAULT_SERVER_CONFIG } from '../../../services/heuristics/config.js';
import { computeDryRunDiff } from '../../../services/scoring/dry-run.js';
import { putSubmissionBundle } from '../../../../test/helpers/seed-bundle.js';
import { seedSubmission } from '../../../../test/helpers/seed-submission.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Mock pg-boss so commit path doesn't require a real pg-boss connection.
// The commit route calls getBoss() then boss.send() to enqueue recompute jobs.
// ---------------------------------------------------------------------------
vi.mock('../../../jobs/pg-boss.js', () => ({
  getBoss: vi.fn().mockResolvedValue({
    send: vi.fn().mockResolvedValue('mock-pg-boss-job-id'),
  }),
  JOB_KINDS: {
    INGEST_FILE: 'ingest_file',
    INGEST_FINALIZE: 'ingest_finalize',
    RECOMPUTE_SEMESTER: 'recompute_semester',
    RECOMPUTE_SUBMISSION: 'recompute_submission',
    RECOMPUTE_FINALIZE: 'recompute_finalize',
    RECOMPUTE_CROSS_FLAGS: 'recompute_cross_flags',
    PURGE_EXPIRED_EXPORTS: 'purge_expired_exports',
    PURGE_EXPIRED_SESSIONS: 'purge_expired_sessions',
    RETENTION_SWEEP: 'retention_sweep',
  },
  _resetBossForTest: vi.fn(),
}));

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Test env
// ---------------------------------------------------------------------------

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-heuristic-tests-12345678',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

/**
 * BASE_ENV with OBJECT_STORAGE_* overridden to point at an ephemeral MinIO
 * instance from withTestMinio. computeDryRunDiff re-parses each submission's
 * stored bundle blob on demand (via getStorageClient() / loadSubmissionIndex,
 * events are no longer persisted in Postgres), so any test that exercises a
 * non-empty semester must both store a bundle blob AND point config at the
 * same MinIO the blob was written to.
 */
function minioEnv(endpoint: string, bucketName: string): Record<string, string> {
  return { ...BASE_ENV, OBJECT_STORAGE_ENDPOINT: endpoint, OBJECT_STORAGE_BUCKET: bucketName };
}

// ---------------------------------------------------------------------------
// DB injection (V18 pattern)
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

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function insertUser(db: DrizzleDb, overrides?: Partial<typeof users.$inferInsert>) {
  const randomId = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(users)
    .values({
      google_subject: `sub-${randomId}`,
      email: `user-${randomId}@berkeley.edu`,
      display_name: 'Test User',
      is_superadmin: false,
      ...overrides,
    })
    .returning();
  return user!;
}

async function insertSession(
  db: DrizzleDb,
  userId: string,
  expiresAt: Date = new Date(Date.now() + 14 * 86400_000),
): Promise<string> {
  const uniqueId = `sess-${Math.random().toString(36).slice(2)}`.padEnd(43, 'x').slice(0, 43);
  await db.insert(sessions).values({ id: uniqueId, user_id: userId, expires_at: expiresAt });
  return uniqueId;
}

async function insertCourse(db: DrizzleDb) {
  const randomId = Math.random().toString(36).slice(2);
  const [course] = await db
    .insert(courses)
    .values({ name: 'CS 61A', slug: `cs61a-${randomId}` })
    .returning();
  return course!;
}

async function insertSemester(db: DrizzleDb, courseId: string) {
  const randomId = Math.random().toString(36).slice(2);
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: courseId,
      term: 'fa',
      year: 2024,
      slug: `fa2024-${randomId}`,
      display_name: 'Fall 2024',
      filename_convention: '(?<sid>[a-z0-9]+)_hw',
    })
    .returning();
  return semester!;
}

async function insertMembership(
  db: DrizzleDb,
  userId: string,
  semesterId: string,
  role: 'admin' | 'grader',
  grantedBy: string,
) {
  await db
    .insert(memberships)
    .values({ user_id: userId, semester_id: semesterId, role, granted_by: grantedBy });
}

/**
 * Insert a heuristic_config row for a semester.
 * Used to create a pre-existing config for If-Match tests.
 */
async function insertHeuristicConfig(
  db: DrizzleDb,
  semesterId: string,
  userId: string,
  version: number,
  isActive: boolean,
) {
  const [row] = await db
    .insert(heuristic_configs)
    .values({
      semester_id: semesterId,
      version,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb
      config: DEFAULT_SERVER_CONFIG as any,
      set_by: userId,
      is_active: isActive,
      note: 'test config',
    })
    .returning();
  return row!;
}

/** Build a valid PUT body from DEFAULT_SERVER_CONFIG. */
function validCandidateBody(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_SERVER_CONFIG)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GET /semesters/:semesterId/heuristic-config
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/heuristic-config', () => {
  it('returns 401 when unauthenticated', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config`),
        );
        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 403 for non-member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        // admin is NOT a member of the semester
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns default (version=0) when no config exists', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        // No heuristic_config row inserted (migration backfill skipped for new semesters
        // created after migration; they start with no config).
        // To test "no config" scenario: the semester was created but no INSERT happened.
        // Since insertSemester doesn't trigger backfill (that only runs at migration time),
        // this simulates a newly-created semester post-migration.
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { version: number; config: unknown };
        expect(body.version).toBe(0);
        expect(body.config).toBeDefined();
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns active config when one exists', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { version: number; is_active: boolean; id: string };
        expect(body.version).toBe(1);
        expect(body.is_active).toBe(true);
        expect(body.id).toBeTruthy();
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// GET /semesters/:semesterId/heuristic-configs (history)
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/heuristic-configs', () => {
  it('returns 401 when unauthenticated', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-configs`),
        );
        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns empty array when no configs exist', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-configs`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { configs: unknown[] };
        expect(Array.isArray(body.configs)).toBe(true);
        expect(body.configs).toHaveLength(0);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns history array with version and is_active fields', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        // Insert v1 (inactive) and v2 (active)
        await insertHeuristicConfig(db, semester.id, admin.id, 1, false);
        await insertHeuristicConfig(db, semester.id, admin.id, 2, true);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-configs`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          configs: Array<{ version: number; is_active: boolean }>;
        };
        expect(body.configs).toHaveLength(2);
        // Ordered newest first (by version DESC)
        expect(body.configs[0]!.version).toBe(2);
        expect(body.configs[0]!.is_active).toBe(true);
        expect(body.configs[1]!.version).toBe(1);
        expect(body.configs[1]!.is_active).toBe(false);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /semesters/:semesterId/heuristic-config (no dryRun) → 501
// ---------------------------------------------------------------------------
// PUT /semesters/:semesterId/heuristic-config?dryRun=false — commit path
// ---------------------------------------------------------------------------

describe('PUT /semesters/:semesterId/heuristic-config (commit path)', () => {
  it('commits new version: inserts new active row, deactivates prior, returns new config', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=false`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              'If-Match': '1',
            },
            body: JSON.stringify(validCandidateBody()),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          new_config: {
            id: string;
            version: number;
            set_at: string;
            note: string;
            is_active: boolean;
          };
          recompute_job: { id: string; status: string };
        };
        expect(body.new_config.version).toBe(2);
        expect(body.new_config.id).toBeTruthy();
        expect(body.new_config.is_active).toBe(true);
        expect(body.recompute_job.id).toBeTruthy();
        expect(body.recompute_job.status).toBe('queued');

        // Verify the old row is now inactive and new row is active in DB.
        const allConfigs = await db
          .select({ version: heuristic_configs.version, is_active: heuristic_configs.is_active })
          .from(heuristic_configs)
          .where(eq(heuristic_configs.semester_id, semester.id));

        const v1Row = allConfigs.find((r) => r.version === 1);
        const v2Row = allConfigs.find((r) => r.version === 2);
        expect(v1Row?.is_active).toBe(false);
        expect(v2Row?.is_active).toBe(true);

        // V20 rule: assert audit row was written for the commit action.
        const auditRow = await waitForAuditRow(db, 'heuristic_config.commit', semester.id, 50);
        expect(auditRow).toBeDefined();
      } finally {
        _testDb = null;
      }
    });
  });

  it('commit from no-config state creates version 1', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        // No prior config.

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=false`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              'If-Match': '0', // current version is 0 (no config)
            },
            body: JSON.stringify(validCandidateBody()),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { new_config: { version: number } };
        expect(body.new_config.version).toBe(1);
      } finally {
        _testDb = null;
      }
    });
  });

  it('commit creates a recompute_jobs row', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=false`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              'If-Match': '1',
            },
            body: JSON.stringify(validCandidateBody()),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { recompute_job: { id: string; status: string } };
        const recomputeJobId = body.recompute_job.id;

        // Verify a recompute_jobs row was created.
        const jobRows = await db
          .select({ id: recompute_jobs.id, status: recompute_jobs.status })
          .from(recompute_jobs)
          .where(eq(recompute_jobs.id, recomputeJobId));

        expect(jobRows).toHaveLength(1);
        expect(jobRows[0]?.status).toBe('queued');
      } finally {
        _testDb = null;
      }
    });
  });

  it('commit with stale If-Match returns 409', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=false`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              'If-Match': '99', // stale
            },
            body: JSON.stringify(validCandidateBody()),
          }),
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('CONFIG_VERSION_CONFLICT');
      } finally {
        _testDb = null;
      }
    });
  });

  it('commit (dryRun param absent) commits version', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const app = createV1App();
        // No ?dryRun param — defaults to commit
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              'If-Match': '1',
            },
            body: JSON.stringify(validCandidateBody()),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { new_config: { version: number } };
        expect(body.new_config.version).toBe(2);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// PUT (commit) — concurrent If-Match regression test (V21 check-then-mutate pattern)
//
// Two concurrent PUTs with the same If-Match value. Exactly one must succeed
// (200) and the other must be rejected (409 CONFIG_VERSION_CONFLICT). After the
// race, exactly one active row must exist in heuristic_configs for the semester.
// ---------------------------------------------------------------------------

describe('PUT (commit) — concurrent If-Match regression (C-Quality-1)', () => {
  it('concurrent commits with same If-Match: exactly one succeeds', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const app = createV1App();
        const body = JSON.stringify(validCandidateBody());
        const headers = {
          Cookie: `__Host-prov_sess=${sessionId}`,
          'Content-Type': 'application/json',
          'If-Match': '1', // Both requests race with the same If-Match
        };

        const [resA, resB] = await Promise.allSettled([
          app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=false`, {
              method: 'PUT',
              headers,
              body,
            }),
          ),
          app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=false`, {
              method: 'PUT',
              headers,
              body,
            }),
          ),
        ]);

        // Both settled (not rejected at the Promise level).
        expect(resA.status).toBe('fulfilled');
        expect(resB.status).toBe('fulfilled');

        const statusA = resA.status === 'fulfilled' ? resA.value.status : 0;
        const statusB = resB.status === 'fulfilled' ? resB.value.status : 0;
        const statuses = [statusA, statusB].sort((a, b) => a - b);

        // One 200 (winner) and one 409 (loser) — or potentially one 500 if a
        // unique-constraint violation surfaces before the version-check catches it.
        // Either outcome is acceptable as long as data is consistent.
        expect(statuses[0]).toBe(200);
        expect([409, 500]).toContain(statuses[1]);

        // Assert: exactly one active row in heuristic_configs for the semester.
        const activeCount = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(heuristic_configs)
          .where(
            sql`${heuristic_configs.semester_id} = ${semester.id} AND ${heuristic_configs.is_active} = true`,
          );
        expect(activeCount[0]!.count).toBe(1);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /semesters/:semesterId/heuristic-config?dryRun=true — If-Match enforcement
// ---------------------------------------------------------------------------

describe('PUT ?dryRun=true — If-Match enforcement', () => {
  it('returns 428 when If-Match header is absent', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=true`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              // No If-Match header
            },
            body: JSON.stringify(validCandidateBody()),
          }),
        );
        expect(res.status).toBe(428);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('PRECONDITION_REQUIRED');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 409 when If-Match does not match current version', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=true`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              'If-Match': '99', // wrong version; current is 1
            },
            body: JSON.stringify(validCandidateBody()),
          }),
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string; details: unknown } };
        expect(body.error.code).toBe('CONFIG_VERSION_CONFLICT');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 409 when If-Match is 0 but active config is version 1', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=true`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              'If-Match': '0', // stale — actual is 1
            },
            body: JSON.stringify(validCandidateBody()),
          }),
        );
        expect(res.status).toBe(409);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// PUT ?dryRun=true — invalid config body → 422
// ---------------------------------------------------------------------------

describe('PUT ?dryRun=true — invalid config body', () => {
  it('returns 422 when per_flag is missing a known ID', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const badConfig = validCandidateBody();
        delete (badConfig['per_flag'] as Record<string, unknown>)['large_paste'];

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=true`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              'If-Match': '1',
            },
            body: JSON.stringify(badConfig),
          }),
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('HEURISTIC_CONFIG_INVALID');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 422 when weight is out of range', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const badConfig = validCandidateBody();
        (
          (badConfig['per_flag'] as Record<string, unknown>)['chain_broken'] as Record<
            string,
            unknown
          >
        )['weight'] = 200;

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=true`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              'If-Match': '1',
            },
            body: JSON.stringify(badConfig),
          }),
        );
        expect(res.status).toBe(422);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// PUT ?dryRun=true — happy path returns DryRunDiff shape
// ---------------------------------------------------------------------------

describe('PUT ?dryRun=true — happy path', () => {
  it('returns DryRunDiff shape with empty semester (no submissions)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=true`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              'If-Match': '1',
            },
            body: JSON.stringify(validCandidateBody()),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          candidate_version: number;
          diff: {
            submissions_with_tier_change: number;
            top_movers: unknown[];
            score_histogram_old: number[];
            score_histogram_new: number[];
          };
        };
        expect(body.candidate_version).toBe(2);
        expect(body.diff.submissions_with_tier_change).toBe(0);
        expect(body.diff.top_movers).toHaveLength(0);
        expect(body.diff.score_histogram_old).toHaveLength(10);
        expect(body.diff.score_histogram_new).toHaveLength(10);
      } finally {
        _testDb = null;
      }
    });
  });

  it('does NOT write any rows to heuristic_configs during dry-run', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        // Count rows before
        const before = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(heuristic_configs)
          .where(eq(heuristic_configs.semester_id, semester.id));

        const app = createV1App();
        await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=true`, {
            method: 'PUT',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
              'If-Match': '1',
            },
            body: JSON.stringify(validCandidateBody()),
          }),
        );

        // Count rows after — must be the same
        const after = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(heuristic_configs)
          .where(eq(heuristic_configs.semester_id, semester.id));

        expect(after[0]!.count).toBe(before[0]!.count);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// computeDryRunDiff unit cases (direct service call, no HTTP)
// ---------------------------------------------------------------------------

describe('computeDryRunDiff', () => {
  it('returns empty diff for semester with no submissions', async () => {
    await withTestDb(async (db) => {
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      const result = await computeDryRunDiff(db, semester.id, DEFAULT_SERVER_CONFIG, 2);

      expect(result.candidate_version).toBe(2);
      expect(result.diff.submissions_with_tier_change).toBe(0);
      expect(result.diff.top_movers).toHaveLength(0);
      expect(result.diff.score_histogram_old).toHaveLength(10);
      expect(result.diff.score_histogram_new).toHaveLength(10);
      // All buckets zero
      expect(result.diff.score_histogram_old.every((v) => v === 0)).toBe(true);
    });
  });

  it('returns zero tier_change when all weights match existing scores', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _setConfigForTest(parseEnv(minioEnv(endpoint, bucketName)));

        const adminUser = await insertUser(db);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        // Insert an ingest_job (submissions require it)
        const [ingestJob] = await db
          .insert((await import('../../../db/schema.js')).ingest_jobs)
          .values({
            semester_id: semester.id,
            uploaded_by: adminUser.id,
            status: 'succeeded',
          })
          .returning();

        const [assignment] = await db
          .insert(assignments)
          .values({
            semester_id: semester.id,
            assignment_id_str: 'hw1',
            label: 'Homework 1',
          })
          .returning();

        const [student] = await db
          .insert(roster_entries)
          .values({
            semester_id: semester.id,
            sid: 'stu001',
            display_name: 'Alice',
          })
          .returning();

        // Insert a submission with score 0 (no flags)
        const [submission] = await db
          .insert(submissions)
          .values({
            semester_id: semester.id,
            assignment_id: assignment!.id,
            student_id: student!.id,
            blob_object_key: 'test/blob',
            blob_sha256: 'abc123',
            source_filename: 'hw1_stu001.zip',
            ingest_job_id: ingestJob!.id,
            version_index: 1,
            score_total: 0,
            score_max_severity: 'info',
          })
          .returning();

        // computeDryRunDiff now re-runs heuristics against the real stored
        // bundle (events are no longer in Postgres). Store a trivial bundle
        // (session.start only, no file activity) so nothing but
        // extension_hash_mismatch could possibly fire — and disable that one
        // heuristic in the candidate so the recomputed score is genuinely 0,
        // matching the submission's stored score of 0 (same pattern as the
        // V46 regression test below: extension_hash_mismatch always fires on
        // these synthetic test bundles since their extension_hash is never in
        // the known-good allowlist).
        const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
        await putSubmissionBundle(db, client, submission!.id, new Uint8Array(zipBuffer));

        const candidateConfig = JSON.parse(
          JSON.stringify(DEFAULT_SERVER_CONFIG),
        ) as typeof DEFAULT_SERVER_CONFIG;
        candidateConfig.per_flag['extension_hash_mismatch']!.enabled = false;

        // Same config → all scores identical → no tier change
        const result = await computeDryRunDiff(db, semester.id, candidateConfig, 2);
        expect(result.diff.submissions_with_tier_change).toBe(0);
        expect(result.diff.top_movers[0]?.old_score).toBe(0);
        expect(result.diff.top_movers[0]?.new_score).toBe(0);

        void submission;
      });
    });
  });

  it('detects tier change when a weight change shifts score_max_severity', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _setConfigForTest(parseEnv(minioEnv(endpoint, bucketName)));

        const adminUser = await insertUser(db);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        const [ingestJob] = await db
          .insert((await import('../../../db/schema.js')).ingest_jobs)
          .values({
            semester_id: semester.id,
            uploaded_by: adminUser.id,
            status: 'succeeded',
          })
          .returning();

        const [assignment] = await db
          .insert(assignments)
          .values({
            semester_id: semester.id,
            assignment_id_str: 'hw2',
            label: 'Homework 2',
          })
          .returning();

        const [student] = await db
          .insert(roster_entries)
          .values({
            semester_id: semester.id,
            sid: 'stu002',
            display_name: 'Bob',
          })
          .returning();

        // Submission with score_max_severity='medium' (has a medium flag)
        const [submission] = await db
          .insert(submissions)
          .values({
            semester_id: semester.id,
            assignment_id: assignment!.id,
            student_id: student!.id,
            blob_object_key: 'test/blob2',
            blob_sha256: 'def456',
            source_filename: 'hw2_stu002.zip',
            ingest_job_id: ingestJob!.id,
            version_index: 1,
            score_total: 3, // severity_weight.medium = 3, confidence=1.0, weight=1.0
            score_max_severity: 'medium',
          })
          .returning();

        // Insert a medium flag for the submission
        await db.insert(flags).values({
          submission_id: submission!.id,
          semester_id: semester.id,
          heuristic_id: 'large_paste',
          severity: 'medium',
          confidence: 1.0,
          weight_at_compute: 1.0,
          score_contribution: 3,
          heuristic_config_version: 1,
        });

        // Store a trivial bundle so recomputeSubmission can re-parse it.
        const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
        await putSubmissionBundle(db, client, submission!.id, new Uint8Array(zipBuffer));

        // Now use a candidate that disables large_paste — score drops to 0, tier drops to 'info'.
        // extension_hash_mismatch is also disabled: it always fires on these
        // synthetic test bundles (extension_hash never matches the known-good
        // allowlist) and would otherwise pollute new_score away from 0.
        const candidateConfig = JSON.parse(
          JSON.stringify(DEFAULT_SERVER_CONFIG),
        ) as typeof DEFAULT_SERVER_CONFIG;
        candidateConfig.per_flag['large_paste']!.enabled = false;
        candidateConfig.per_flag['extension_hash_mismatch']!.enabled = false;

        const result = await computeDryRunDiff(db, semester.id, candidateConfig, 2);

        expect(result.diff.submissions_with_tier_change).toBe(1);
        expect(result.diff.top_movers).toHaveLength(1);
        expect(result.diff.top_movers[0]!.old_tier).toBe('medium');
        expect(result.diff.top_movers[0]!.new_tier).toBe('info');
        expect(result.diff.top_movers[0]!.old_score).toBe(3);
        expect(result.diff.top_movers[0]!.new_score).toBe(0);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// V46 regression: thresholds in candidate config must affect dry-run scoring.
//
// Before V46, recompute-submission.ts passed `undefined` to v2's runHeuristics,
// so per_flag[id].thresholds was silently dropped — making the backlog's P0-3
// concern real. This test seeds a submission with a 250-char paste, then runs
// dry-run twice: once with default thresholds (large_paste fires at medium)
// and once with thresholds.minChars=300 (heuristic must NOT fire).
//
// Under the pre-V46 bug, both runs produce the same non-zero new_score because
// the candidate's thresholds are ignored. Under the V46 fix, the raised
// threshold suppresses the flag and new_score collapses to 0.
// ---------------------------------------------------------------------------

describe('computeDryRunDiff — threshold forwarding (V46 regression)', () => {
  it('raising largePaste.minChars above paste size suppresses the flag in dry-run', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _setConfigForTest(parseEnv(minioEnv(endpoint, bucketName)));

        const submissionId = await seedSubmission(db);
        const [subRow] = await db
          .select({ semester_id: submissions.semester_id })
          .from(submissions)
          .where(eq(submissions.id, submissionId));
        const semesterId = subRow!.semester_id;

        // 250-char paste fires large_paste at medium severity by default
        // (minChars=200, highSeverityChars=500).
        const pasteContent = 'x'.repeat(250);
        const { zipBuffer } = await buildTestBundle({
          sessions: [
            {
              events: [
                {
                  kind: 'paste',
                  data: {
                    path: '/hw1.py',
                    content: pasteContent,
                    length: pasteContent.length,
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  },
                },
              ],
            },
          ],
        });
        // Events are no longer persisted in Postgres — store the bundle blob
        // itself so computeDryRunDiff's recompute can re-parse it on demand.
        await putSubmissionBundle(db, client, submissionId, new Uint8Array(zipBuffer));

        // Build a config where ONLY large_paste contributes (disable everything
        // else so other heuristics that fire on the test bundle — e.g.
        // extension_hash_mismatch — don't pollute new_score).
        function isolateLargePaste(): typeof DEFAULT_SERVER_CONFIG {
          const cfg = JSON.parse(
            JSON.stringify(DEFAULT_SERVER_CONFIG),
          ) as typeof DEFAULT_SERVER_CONFIG;
          for (const id of Object.keys(cfg.per_flag)) {
            if (id !== 'large_paste') cfg.per_flag[id]!.enabled = false;
          }
          return cfg;
        }

        // Run 1: default thresholds → large_paste fires.
        const baseline = isolateLargePaste();
        const baselineResult = await computeDryRunDiff(db, semesterId, baseline, 2);
        const baselineMover = baselineResult.diff.top_movers.find(
          (m) => m.submission_id === submissionId,
        );
        expect(baselineMover, 'baseline run should include the seeded submission').toBeDefined();
        expect(baselineMover!.new_score).toBeGreaterThan(0);
        expect(baselineMover!.new_tier).not.toBe('info');

        // Run 2: raise minChars above paste size → large_paste must NOT fire.
        const raised = isolateLargePaste();
        raised.per_flag['large_paste']!.thresholds = { minChars: 300 };
        const raisedResult = await computeDryRunDiff(db, semesterId, raised, 2);
        const raisedMover = raisedResult.diff.top_movers.find(
          (m) => m.submission_id === submissionId,
        );
        expect(
          raisedMover,
          'raised-threshold run should include the seeded submission',
        ).toBeDefined();
        expect(raisedMover!.new_score).toBe(0);
        expect(raisedMover!.new_tier).toBe('info');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrent PUT If-Match regression test (V21 pattern)
//
// Two simultaneous dryRun=true PUTs: one with the correct If-Match version,
// one with a stale version. Since both are dryRun=true there are no DB writes,
// but the version-conflict check must still reject the stale one with 409.
// This establishes the V21 concurrency-test pattern that Phase 13b's commit
// handler will inherit for actual DB-write conflict detection.
// ---------------------------------------------------------------------------

describe('PUT ?dryRun=true — concurrent If-Match regression', () => {
  it('rejects stale If-Match version with 409 when both requests race', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const app = createV1App();
        const body = JSON.stringify(validCandidateBody());
        const headers = {
          Cookie: `__Host-prov_sess=${sessionId}`,
          'Content-Type': 'application/json',
        };

        const [okRes, staleRes] = await Promise.all([
          // Correct If-Match — current active version is 1
          app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=true`, {
              method: 'PUT',
              headers: { ...headers, 'If-Match': '1' },
              body,
            }),
          ),
          // Stale If-Match — version 0 is outdated (current is 1)
          app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=true`, {
              method: 'PUT',
              headers: { ...headers, 'If-Match': '0' },
              body,
            }),
          ),
        ]);

        expect(okRes.status).toBe(200);
        expect(staleRes.status).toBe(409);
        const staleBody = (await staleRes.json()) as { error: { code: string } };
        expect(staleBody.error.code).toBe('CONFIG_VERSION_CONFLICT');
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// POST /semesters/:semesterId/heuristic-config/recompute
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/recompute', () => {
  it('enqueues a recompute job and returns recompute_job shape (PRD §8.11)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/recompute`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ note: 'triggered from test' }),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          recompute_job: {
            id: string;
            semester_id: string;
            target_config_id: string;
            triggered_by: string;
            status: string;
            progress_total: number;
            progress_done: number;
            progress_failed: number;
            created_at: string;
            started_at: string | null;
            completed_at: string | null;
            summary: unknown;
          };
        };
        expect(body.recompute_job.id).toBeTruthy();
        expect(body.recompute_job.semester_id).toBe(semester.id);
        expect(body.recompute_job.status).toBe('queued');

        // Verify the recompute_jobs row exists in DB.
        const jobRows = await db
          .select({ id: recompute_jobs.id, status: recompute_jobs.status })
          .from(recompute_jobs)
          .where(eq(recompute_jobs.id, body.recompute_job.id));
        expect(jobRows).toHaveLength(1);
        expect(jobRows[0]?.status).toBe('queued');

        // V20 rule: assert audit row was written for the recompute trigger action.
        const auditRow = await waitForAuditRow(db, 'heuristic_config.recompute', semester.id, 50);
        expect(auditRow).toBeDefined();
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 404 when no active config exists', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        // No config row inserted.

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/recompute`, {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(404);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 401 when unauthenticated', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/recompute`, {
            method: 'POST',
          }),
        );
        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// GET /semesters/:semesterId/recompute/:jobId
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/recompute/:jobId', () => {
  it('returns the recompute job row', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        const configRow = await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

        // Insert a recompute_jobs row directly.
        const [jobRow] = await db
          .insert(recompute_jobs)
          .values({
            semester_id: semester.id,
            target_config_id: configRow.id,
            triggered_by: admin.id,
            status: 'queued',
            progress_total: 0,
          })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/recompute/${jobRow!.id}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          id: string;
          status: string;
          progress_total: number;
        };
        expect(body.id).toBe(jobRow!.id);
        expect(body.status).toBe('queued');
        expect(body.progress_total).toBe(0);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 404 for unknown job id', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(
            `http://localhost/semesters/${semester.id}/recompute/00000000-0000-0000-0000-000000000000`,
            {
              headers: { Cookie: `__Host-prov_sess=${sessionId}` },
            },
          ),
        );
        expect(res.status).toBe(404);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 404 when job belongs to a different semester', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db);
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester1 = await insertSemester(db, course.id);
        const semester2 = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester1.id, 'admin', admin.id);
        await insertMembership(db, admin.id, semester2.id, 'admin', admin.id);
        const configRow = await insertHeuristicConfig(db, semester2.id, admin.id, 1, true);

        // Job belongs to semester2.
        const [jobRow] = await db
          .insert(recompute_jobs)
          .values({
            semester_id: semester2.id,
            target_config_id: configRow.id,
            triggered_by: admin.id,
            status: 'queued',
            progress_total: 0,
          })
          .returning();

        // Request with semester1 in URL — should be 404 (scope mismatch).
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester1.id}/recompute/${jobRow!.id}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(404);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Protected mode — dry-run top_movers masking
// ---------------------------------------------------------------------------

describe('computeDryRunDiff — protected mode masks top_movers student identity', () => {
  it('masked: top_movers.student has Student N / SN (never real name/sid)', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _setConfigForTest(parseEnv(minioEnv(endpoint, bucketName)));
        const adminUser = await insertUser(db);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        const [ingestJob] = await db
          .insert((await import('../../../db/schema.js')).ingest_jobs)
          .values({
            semester_id: semester.id,
            uploaded_by: adminUser.id,
            status: 'succeeded',
          })
          .returning();

        const [assignment] = await db
          .insert(assignments)
          .values({
            semester_id: semester.id,
            assignment_id_str: 'hw_pm',
            label: 'Homework PM',
          })
          .returning();

        // Insert a student with a known protected_index so we can assert on label.
        const [student] = await db
          .insert(roster_entries)
          .values({
            semester_id: semester.id,
            sid: 'real_sid_001',
            display_name: 'Real Student Name',
            protected_index: 7,
          })
          .returning();

        // Submission with a medium flag so it shows up in top_movers.
        const [submission] = await db
          .insert(submissions)
          .values({
            semester_id: semester.id,
            assignment_id: assignment!.id,
            student_id: student!.id,
            blob_object_key: 'test/pm_blob',
            blob_sha256: 'pm_hash_abc',
            source_filename: 'hw_pm_real_sid_001.zip',
            ingest_job_id: ingestJob!.id,
            version_index: 1,
            score_total: 3,
            score_max_severity: 'medium',
          })
          .returning();

        await db.insert(flags).values({
          submission_id: submission!.id,
          semester_id: semester.id,
          heuristic_id: 'large_paste',
          severity: 'medium',
          confidence: 1.0,
          weight_at_compute: 1.0,
          score_contribution: 3,
          heuristic_config_version: 1,
        });

        // computeDryRunDiff re-runs heuristics against the real stored bundle
        // (events are no longer in Postgres) — store a trivial one so the
        // recompute succeeds. The assertions here only check student-identity
        // masking, not exact scores, so a minimal bundle is sufficient.
        const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
        await putSubmissionBundle(db, client, submission!.id, new Uint8Array(zipBuffer));

        // Candidate that disables large_paste so score drops → tier change → top_mover.
        const candidateConfig = JSON.parse(
          JSON.stringify(DEFAULT_SERVER_CONFIG),
        ) as typeof DEFAULT_SERVER_CONFIG;
        candidateConfig.per_flag['large_paste']!.enabled = false;

        // Protected mode = true: student identity must be masked.
        const protectedResult = await computeDryRunDiff(
          db,
          semester.id,
          candidateConfig,
          2,
          true, // protectedMode
        );

        expect(protectedResult.diff.top_movers).toHaveLength(1);
        const mover = protectedResult.diff.top_movers[0]!;
        // Must match Student N pattern (protected_index = 7).
        expect(mover.student!.display_name).toBe('Student 7');
        expect(mover.student!.sid).toBe('S7');
        // Real values must NOT appear.
        expect(mover.student!.display_name).not.toBe('Real Student Name');
        expect(mover.student!.sid).not.toBe('real_sid_001');

        // Non-protected mode: real values must appear.
        const realResult = await computeDryRunDiff(
          db,
          semester.id,
          candidateConfig,
          2,
          false, // protectedMode
        );

        expect(realResult.diff.top_movers).toHaveLength(1);
        const realMover = realResult.diff.top_movers[0]!;
        expect(realMover.student!.display_name).toBe('Real Student Name');
        expect(realMover.student!.sid).toBe('real_sid_001');

        void submission;
      });
    });
  });

  it('protected dry-run via HTTP: top_movers.student masked', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(parseEnv(minioEnv(endpoint, bucketName)));
        try {
          // Protected principal.
          const admin = await insertUser(db, { protected: true });
          const sessionId = await insertSession(db, admin.id);
          const course = await insertCourse(db);
          const semester = await insertSemester(db, course.id);
          await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
          await insertHeuristicConfig(db, semester.id, admin.id, 1, true);

          const [ingestJob] = await db
            .insert((await import('../../../db/schema.js')).ingest_jobs)
            .values({
              semester_id: semester.id,
              uploaded_by: admin.id,
              status: 'succeeded',
            })
            .returning();

          const [assignment] = await db
            .insert(assignments)
            .values({
              semester_id: semester.id,
              assignment_id_str: 'hw_http_pm',
              label: 'HW HTTP PM',
            })
            .returning();

          const [student] = await db
            .insert(roster_entries)
            .values({
              semester_id: semester.id,
              sid: 'http_real_sid',
              display_name: 'HTTP Real Name',
              protected_index: 3,
            })
            .returning();

          const [submission] = await db
            .insert(submissions)
            .values({
              semester_id: semester.id,
              assignment_id: assignment!.id,
              student_id: student!.id,
              blob_object_key: 'test/http_pm_blob',
              blob_sha256: 'http_pm_hash',
              source_filename: 'hw_http_pm_http_real_sid.zip',
              ingest_job_id: ingestJob!.id,
              version_index: 1,
              score_total: 3,
              score_max_severity: 'medium',
            })
            .returning();

          await db.insert(flags).values({
            submission_id: submission!.id,
            semester_id: semester.id,
            heuristic_id: 'large_paste',
            severity: 'medium',
            confidence: 1.0,
            weight_at_compute: 1.0,
            score_contribution: 3,
            heuristic_config_version: 1,
          });

          // computeDryRunDiff re-runs heuristics against the real stored bundle
          // (events are no longer in Postgres) — store a trivial one so the
          // recompute succeeds. The assertions here only check student-identity
          // masking, not exact scores, so a minimal bundle is sufficient.
          const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
          await putSubmissionBundle(db, client, submission!.id, new Uint8Array(zipBuffer));

          const candidateConfig = JSON.parse(
            JSON.stringify(DEFAULT_SERVER_CONFIG),
          ) as typeof DEFAULT_SERVER_CONFIG;
          candidateConfig.per_flag['large_paste']!.enabled = false;

          const app = createV1App();
          const res = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/heuristic-config?dryRun=true`, {
              method: 'PUT',
              headers: {
                Cookie: `__Host-prov_sess=${sessionId}`,
                'Content-Type': 'application/json',
                'If-Match': '1',
              },
              body: JSON.stringify(candidateConfig),
            }),
          );

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            diff: { top_movers: { student: { display_name: string; sid: string } }[] };
          };
          expect(body.diff.top_movers).toHaveLength(1);
          expect(body.diff.top_movers[0]!.student!.display_name).toMatch(/^Student \d+$/);
          expect(body.diff.top_movers[0]!.student!.sid).toMatch(/^S/);
          expect(body.diff.top_movers[0]!.student!.display_name).not.toBe('HTTP Real Name');
          expect(body.diff.top_movers[0]!.student!.sid).not.toBe('http_real_sid');

          void submission;
        } finally {
          _testDb = null;
        }
      });
    });
  });
});
