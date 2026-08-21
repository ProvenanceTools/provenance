/**
 * Semesters CRUD routes integration tests.
 *
 * Tests all endpoints through the full v1 app pipeline.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import { users, sessions, courses, semesters, memberships, audit_log } from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';

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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-semesters-tests-12345678901',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertUser(db: DrizzleDb, overrides?: Partial<typeof users.$inferInsert>) {
  const randomId = Math.random().toString(36).slice(2);
  const rows = await db
    .insert(users)
    .values({
      google_subject: `sub-${randomId}`,
      email: `test-${randomId}@berkeley.edu`,
      display_name: 'Test User',
      is_superadmin: false,
      ...overrides,
    })
    .returning();
  return rows[0]!;
}

async function insertSession(
  db: DrizzleDb,
  userId: string,
  expiresAt: Date = new Date(Date.now() + 14 * 86400_000),
): Promise<string> {
  const id = 'a'.repeat(43);
  const uniqueId = `${id.slice(0, 10)}${Math.random().toString(36).slice(2)}`
    .padEnd(43, 'x')
    .slice(0, 43);
  await db.insert(sessions).values({
    id: uniqueId,
    user_id: userId,
    expires_at: expiresAt,
  });
  return uniqueId;
}

/**
 * Polls audit_log until a matching row appears (up to ~150ms with 3 retries).
 * The audit middleware is fire-and-forget: the insert promise is detached from
 * the response, so we must wait for it to settle before asserting DB state.
 */
async function waitForAuditRow(
  db: DrizzleDb,
  action: string,
  targetId: string,
  retries = 3,
): Promise<typeof audit_log.$inferSelect | undefined> {
  for (let i = 0; i <= retries; i++) {
    const rows = await db
      .select()
      .from(audit_log)
      .where(and(eq(audit_log.action, action), eq(audit_log.target_id, targetId)));
    if (rows.length > 0) return rows[0];
    if (i < retries) await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/v1/courses/:courseId/semesters', () => {
  it('creates a semester as superadmin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/semesters`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              term: 'fa',
              year: 2024,
              slug: 'fa2024',
              display_name: 'Fall 2024',
              filename_convention: '(?<sid>[a-z0-9]+)_hw',
            }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.semester.slug).toBe('fa2024');
        expect(body.semester.term).toBe('fa');
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects non-superadmin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, user.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/semesters`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              term: 'fa',
              year: 2024,
              slug: 'fa2024',
              display_name: 'Fall 2024',
              filename_convention: '(?<sid>[a-z0-9]+)_hw',
            }),
          }),
        );

        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects invalid filename_convention', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/semesters`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              term: 'fa',
              year: 2024,
              slug: 'fa2024',
              display_name: 'Fall 2024',
              filename_convention: '(?<other>[a-z0-9]+)_hw', // missing (?<sid>...)
            }),
          }),
        );

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe('VALIDATION_REGEX');
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('GET /api/v1/courses/:courseId/semesters', () => {
  it('lists semesters in a course', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, user.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        await db.insert(semesters).values({
          course_id: course!.id,
          term: 'fa',
          year: 2024,
          slug: 'fa2024',
          display_name: 'Fall 2024',
          filename_convention: '(?<sid>[a-z0-9]+)_hw',
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/semesters`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.semesters)).toBe(true);
        expect(body.semesters.length).toBe(1);
        expect(body.semesters[0].slug).toBe('fa2024');
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('GET /api/v1/semesters/:semesterId', () => {
  it('gets semester detail for member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const user = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, user.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const [semester] = await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        // Add user as member
        await db.insert(memberships).values({
          user_id: user.id,
          semester_id: semester!.id,
          role: 'grader',
          granted_by: admin.id,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.semester.id).toBe(semester!.id);
        expect(body.semester.my_role).toBe('grader');
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects non-member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, user.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const [semester] = await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('PATCH /api/v1/semesters/:semesterId', () => {
  it('updates semester as admin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const [semester] = await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        // Add user as admin
        const adminUser = await insertUser(db, { is_superadmin: true });
        await db.insert(memberships).values({
          user_id: admin.id,
          semester_id: semester!.id,
          role: 'admin',
          granted_by: adminUser.id,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ display_name: 'Fall 2024 (Updated)' }),
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.semester.display_name).toBe('Fall 2024 (Updated)');
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('POST /api/v1/semesters/:semesterId/archive', () => {
  it('archives a semester as superadmin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const [semester] = await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}/archive`, {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(204);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Important 4: non-superadmin GET /courses/:courseId/semesters
// ---------------------------------------------------------------------------

describe('GET /api/v1/courses/:courseId/semesters (non-superadmin access)', () => {
  it('allows a grader member to list semesters for a course they belong to', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const granter = await insertUser(db, { is_superadmin: true });
        const grader = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, grader.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const [semester] = await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        await db.insert(memberships).values({
          user_id: grader.id,
          semester_id: semester!.id,
          role: 'grader',
          granted_by: granter.id,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/semesters`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.semesters)).toBe(true);
        expect(body.semesters.length).toBe(1);
        expect(body.semesters[0].id).toBe(semester!.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 401 for unauthenticated request to GET /courses/:courseId/semesters', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/semesters`),
        );

        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Important 7: audit log rows for semester write endpoints
// ---------------------------------------------------------------------------

describe('audit log — semester write endpoints', () => {
  it('semester.create: audit row has target_id = created semester UUID', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/semesters`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              term: 'fa',
              year: 2024,
              slug: 'fa2024-audit',
              display_name: 'Fall 2024',
              filename_convention: '(?<sid>[a-z0-9]+)_hw',
            }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        const semesterId: string = body.semester.id;

        const row = await waitForAuditRow(db, 'semester.create', semesterId);
        expect(row).toBeDefined();
        expect(row?.action).toBe('semester.create');
        expect(row?.target_type).toBe('semester');
        expect(row?.target_id).toBe(semesterId);
        expect(row?.actor_user_id).toBe(admin.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('semester.update: audit row has correct action and target_id', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const granter = await insertUser(db, { is_superadmin: true });
        const semAdmin = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, semAdmin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const [semester] = await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        await db.insert(memberships).values({
          user_id: semAdmin.id,
          semester_id: semester!.id,
          role: 'admin',
          granted_by: granter.id,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ display_name: 'Fall 2024 Updated' }),
          }),
        );

        expect(res.status).toBe(200);

        const row = await waitForAuditRow(db, 'semester.update', semester!.id);
        expect(row).toBeDefined();
        expect(row?.action).toBe('semester.update');
        expect(row?.target_type).toBe('semester');
        expect(row?.target_id).toBe(semester!.id);
        expect(row?.actor_user_id).toBe(semAdmin.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('semester.archive: audit row has correct action and target_id', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const [semester] = await db
          .insert(semesters)
          .values({
            course_id: course!.id,
            term: 'fa',
            year: 2024,
            slug: 'fa2024',
            display_name: 'Fall 2024',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}/archive`, {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(204);

        const row = await waitForAuditRow(db, 'semester.archive', semester!.id);
        expect(row).toBeDefined();
        expect(row?.action).toBe('semester.archive');
        expect(row?.target_type).toBe('semester');
        expect(row?.target_id).toBe(semester!.id);
        expect(row?.actor_user_id).toBe(admin.id);
      } finally {
        _testDb = null;
      }
    });
  });
});
