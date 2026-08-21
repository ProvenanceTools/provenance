/**
 * requireAuth middleware integration tests.
 *
 * Uses withTestDb and app.fetch to verify the full auth decision pipeline.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { withTestDb } from '../../../test/helpers/db.js';
import { requireAuth } from './authorize.js';
import { authSessionMiddleware } from './auth-session.js';
import { initMembershipCache } from '../../auth/membership-cache.js';
import { _resetConfigForTest, _setConfigForTest } from '../../config/index.js';
import { _resetLoggerForTest } from '../../logging.js';
import { parseEnv } from '../../config/env.js';
import { users, courses, semesters, memberships } from '../../db/schema.js';
import { createToken } from '../../auth/tokens.js';
import type { DrizzleDb } from '../../db/client.js';

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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-authorize-tests-1234567',
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

vi.mock('../../db/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../db/client.js')>();
  return {
    ...original,
    getDb: () => {
      if (_testDb !== null) return _testDb;
      return original.getDb();
    },
  };
});

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

async function insertUser(
  db: DrizzleDb,
  overrides?: Partial<{ is_superadmin: boolean }>,
): Promise<{ id: string }> {
  const rows = await db
    .insert(users)
    .values({
      google_subject: `sub-${Math.random()}`,
      email: `auth-test-${Math.random()}@berkeley.edu`,
      display_name: 'Test User',
      is_superadmin: overrides?.is_superadmin ?? false,
    })
    .returning({ id: users.id });
  const row = rows[0];
  if (!row) throw new Error('No user inserted');
  return row;
}

async function insertCourse(db: DrizzleDb): Promise<{ id: string }> {
  const rows = await db
    .insert(courses)
    .values({ name: 'CS 61A', slug: `cs61a-${Math.random()}` })
    .returning({ id: courses.id });
  const row = rows[0];
  if (!row) throw new Error('No course inserted');
  return row;
}

async function insertSemester(db: DrizzleDb, courseId: string): Promise<{ id: string }> {
  const rows = await db
    .insert(semesters)
    .values({
      course_id: courseId,
      term: 'fa',
      year: 2026,
      slug: `fa26-${Math.random()}`,
      display_name: 'Fall 2026',
      filename_convention: '^hw\\d+\\.py$',
    })
    .returning({ id: semesters.id });
  const row = rows[0];
  if (!row) throw new Error('No semester inserted');
  return row;
}

async function insertMembership(
  db: DrizzleDb,
  userId: string,
  semesterId: string,
  role: 'admin' | 'grader',
): Promise<void> {
  await db.insert(memberships).values({
    user_id: userId,
    semester_id: semesterId,
    role,
    granted_by: userId,
  });
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(_semesterId: string): Hono {
  const app = new Hono();
  app.use('*', authSessionMiddleware);
  app.use('*', initMembershipCache);

  // Protected write route scoped to a semester
  app.post(
    '/semesters/:id/config',
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('id') as string }),
    }),
    (c) => c.json({ ok: true }),
  );

  // Protected read route
  app.get(
    '/semesters/:id/cohort',
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('id') as string }),
    }),
    (c) => c.json({ submissions: [] }),
  );

  // Global (superadmin-only) route
  app.post('/admin/courses', requireAuth({ action: 'admin', target: 'global' }), (c) =>
    c.json({ created: true }),
  );

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('requireAuth middleware', () => {
  it('unauthenticated → 401 AUTH_REQUIRED', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = makeApp(semester.id);

        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/config`, { method: 'POST' }),
        );
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error.code).toBe('AUTH_REQUIRED');
      } finally {
        _testDb = null;
      }
    });
  });

  it('authenticated non-member → 403 NOT_A_MEMBER', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        // User is NOT a member of this semester

        const { secret } = await createToken(db, {
          userId: user.id,
          label: 'Test',
        });

        const app = makeApp(semester.id);
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/config`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error.code).toBe('NOT_A_MEMBER');
      } finally {
        _testDb = null;
      }
    });
  });

  it('grader trying write → 403 INSUFFICIENT_ROLE', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, user.id, semester.id, 'grader');

        const { secret } = await createToken(db, {
          userId: user.id,
          label: 'Test',
        });

        const app = makeApp(semester.id);
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/config`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
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

  it('admin write → 200', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, user.id, semester.id, 'admin');

        const { secret } = await createToken(db, {
          userId: user.id,
          label: 'Test',
        });

        const app = makeApp(semester.id);
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/config`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );
        expect(res.status).toBe(200);
      } finally {
        _testDb = null;
      }
    });
  });

  it('grader read → 200', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, user.id, semester.id, 'grader');

        const { secret } = await createToken(db, {
          userId: user.id,
          label: 'Test',
        });

        const app = makeApp(semester.id);
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/cohort`, {
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );
        expect(res.status).toBe(200);
      } finally {
        _testDb = null;
      }
    });
  });

  it('superadmin → always allowed (even without membership)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const superadmin = await insertUser(db, { is_superadmin: true });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        // Superadmin is NOT a member of the semester

        const { secret } = await createToken(db, {
          userId: superadmin.id,
          label: 'Superadmin Token',
        });

        const app = makeApp(semester.id);
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/config`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );
        expect(res.status).toBe(200);
      } finally {
        _testDb = null;
      }
    });
  });

  it('superadmin global route → 200', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const superadmin = await insertUser(db, { is_superadmin: true });
        const { secret } = await createToken(db, {
          userId: superadmin.id,
          label: 'Superadmin Token',
        });

        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = makeApp(semester.id);

        const res = await app.fetch(
          new Request('http://localhost/admin/courses', {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );
        expect(res.status).toBe(200);
      } finally {
        _testDb = null;
      }
    });
  });

  it('non-superadmin global route → 403', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const { secret } = await createToken(db, {
          userId: user.id,
          label: 'User Token',
        });

        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = makeApp(semester.id);

        const res = await app.fetch(
          new Request('http://localhost/admin/courses', {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );
        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Critical 1: token scope checks on global routes
  //
  // PRD §4.5 requires token scope checks PRECEDE the superadmin check.
  // A superadmin token with read_only=true must be denied on global write routes.
  // A token with semester_ids !== null must be denied from all global routes.
  // -------------------------------------------------------------------------

  it('superadmin token with read_only=true on global write route → 403 TOKEN_READ_ONLY', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const superadmin = await insertUser(db, { is_superadmin: true });
        const { secret } = await createToken(db, {
          userId: superadmin.id,
          label: 'Read-only Superadmin Token',
          scopes: { read_only: true },
        });

        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = makeApp(semester.id);

        // /admin/courses is a write (action: 'admin') global route
        const res = await app.fetch(
          new Request('http://localhost/admin/courses', {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error.code).toBe('TOKEN_READ_ONLY');
      } finally {
        _testDb = null;
      }
    });
  });

  it('superadmin token with semester_ids scoped on global route → 403 TOKEN_SCOPE_OUT_OF_BAND', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const superadmin = await insertUser(db, { is_superadmin: true });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);

        const { secret } = await createToken(db, {
          userId: superadmin.id,
          label: 'Semester-scoped Superadmin Token',
          scopes: { semester_ids: [semester.id] },
        });

        const app = makeApp(semester.id);

        // Any global route — the token is scoped to specific semesters, not global
        const res = await app.fetch(
          new Request('http://localhost/admin/courses', {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error.code).toBe('TOKEN_SCOPE_OUT_OF_BAND');
      } finally {
        _testDb = null;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Important 5: target factory throws → 400 VALIDATION (not 500 INTERNAL)
  // -------------------------------------------------------------------------

  it('target factory that throws → 400 VALIDATION (not 500)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const { secret } = await createToken(db, {
          userId: user.id,
          label: 'Test Token',
        });

        // App with a route whose target factory always throws
        const app = new Hono();
        app.use('*', authSessionMiddleware);
        app.use('*', initMembershipCache);
        app.post(
          '/broken/:id',
          requireAuth({
            action: 'read',
            target: () => {
              throw new Error('boom — malformed path param');
            },
          }),
          (c) => c.json({ ok: true }),
        );

        const res = await app.fetch(
          new Request('http://localhost/broken/bad-id', {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe('VALIDATION');
      } finally {
        _testDb = null;
      }
    });
  });

  it('token read_only attempting write → 403 TOKEN_READ_ONLY', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, user.id, semester.id, 'admin');

        const { secret } = await createToken(db, {
          userId: user.id,
          label: 'Read-only Token',
          scopes: { read_only: true },
        });

        const app = makeApp(semester.id);
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/config`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error.code).toBe('TOKEN_READ_ONLY');
      } finally {
        _testDb = null;
      }
    });
  });

  it('sets c.var.target for downstream middleware on success', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, user.id, semester.id, 'admin');

        const { secret } = await createToken(db, {
          userId: user.id,
          label: 'Admin Token',
        });

        // App that reads c.var.target to verify it was set
        const app = new Hono();
        app.use('*', authSessionMiddleware);
        app.use('*', initMembershipCache);
        app.post(
          '/semesters/:id/config',
          requireAuth({
            action: 'write',
            target: (c) => ({ semesterId: c.req.param('id') as string }),
          }),
          (c) => {
            const target = c.var.target;
            return c.json({ target });
          },
        );

        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/config`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.target).toEqual({ semesterId: semester.id });
      } finally {
        _testDb = null;
      }
    });
  });
});
