/**
 * Courses CRUD routes integration tests.
 *
 * Tests all endpoints through the full v1 app pipeline (auth + rate + audit).
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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-courses-tests-1234567890ab',
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

describe('POST /api/v1/courses', () => {
  it('creates a course as superadmin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/courses', {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'CS 61A', slug: 'cs61a' }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.course.name).toBe('CS 61A');
        expect(body.course.slug).toBe('cs61a');
        expect(body.course.archived).toBe(false);
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

        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/courses', {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'CS 61A', slug: 'cs61a' }),
          }),
        );

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error.code).toBe('INSUFFICIENT_ROLE');
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects unauthenticated request', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/courses', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'CS 61A', slug: 'cs61a' }),
          }),
        );

        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects duplicate slug', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        // Create first course
        await db.insert(courses).values({ name: 'CS 61A', slug: 'cs61a' });

        // Try to create duplicate
        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/courses', {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'Another', slug: 'cs61a' }),
          }),
        );

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error.code).toBe('COURSE_SLUG_TAKEN');
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('GET /api/v1/courses', () => {
  it('lists courses for authenticated user', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, user.id);

        // Insert a course
        await db.insert(courses).values({ name: 'CS 61A', slug: 'cs61a' });

        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/courses', {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.courses)).toBe(true);
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects unauthenticated request', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const app = createV1App();
        const res = await app.fetch(new Request('http://localhost/courses'));

        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('GET /api/v1/courses/:id', () => {
  it('gets a course', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, user.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.course.id).toBe(course!.id);
        expect(body.course.slug).toBe('cs61a');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 404 for nonexistent course', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, user.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/00000000-0000-0000-0000-000000000000`, {
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

describe('PATCH /api/v1/courses/:id', () => {
  it('updates course name as superadmin', async () => {
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
          new Request(`http://localhost/courses/${course!.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'Computer Science 61A' }),
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.course.name).toBe('Computer Science 61A');
      } finally {
        _testDb = null;
      }
    });
  });
});

describe('POST /api/v1/courses/:id/archive', () => {
  it('archives a course as superadmin', async () => {
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
          new Request(`http://localhost/courses/${course!.id}/archive`, {
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

  it('cascades the archive to the course’s semesters', async () => {
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
            year: 2026,
            slug: 'fa26',
            display_name: 'Fall 2026',
            filename_convention: '(?<sid>[a-z0-9]+)_hw',
          })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/archive`, {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(204);

        const [row] = await db
          .select({ archived_at: semesters.archived_at })
          .from(semesters)
          .where(eq(semesters.id, semester!.id));
        expect(row?.archived_at).toBeTruthy();
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Important 3: non-superadmin GET /courses/:id
// ---------------------------------------------------------------------------

describe('GET /api/v1/courses/:id (non-superadmin access)', () => {
  it('allows a grader member to fetch a course they belong to', async () => {
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
          new Request(`http://localhost/courses/${course!.id}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.course.id).toBe(course!.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 401 for unauthenticated request to GET /courses/:id', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(new Request(`http://localhost/courses/${course!.id}`));

        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Important 7: audit log rows for course write endpoints
// ---------------------------------------------------------------------------

describe('audit log — course write endpoints', () => {
  it('course.create: audit row has target_id = created course UUID', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request('http://localhost/courses', {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'CS 61A', slug: 'cs61a-audit' }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        const courseId: string = body.course.id;

        const row = await waitForAuditRow(db, 'course.create', courseId);
        expect(row).toBeDefined();
        expect(row?.action).toBe('course.create');
        expect(row?.target_type).toBe('course');
        expect(row?.target_id).toBe(courseId);
        expect(row?.actor_user_id).toBe(admin.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('course.update: audit row has correct action and target_id', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a-upd' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ name: 'Updated 61A' }),
          }),
        );

        expect(res.status).toBe(200);

        const row = await waitForAuditRow(db, 'course.update', course!.id);
        expect(row).toBeDefined();
        expect(row?.action).toBe('course.update');
        expect(row?.target_type).toBe('course');
        expect(row?.target_id).toBe(course!.id);
        expect(row?.actor_user_id).toBe(admin.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('course.archive: audit row has correct action and target_id', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, admin.id);

        const [course] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a-arch' })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/courses/${course!.id}/archive`, {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(204);

        const row = await waitForAuditRow(db, 'course.archive', course!.id);
        expect(row).toBeDefined();
        expect(row?.action).toBe('course.archive');
        expect(row?.target_type).toBe('course');
        expect(row?.target_id).toBe(course!.id);
        expect(row?.actor_user_id).toBe(admin.id);
      } finally {
        _testDb = null;
      }
    });
  });
});
