/**
 * GET /me route integration tests.
 *
 * Uses withTestDb and vi.mock to inject a test DB into the route.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createMeRouter } from './me.js';
import { users, sessions, courses, semesters, memberships } from '../../../db/schema.js';
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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-me-tests-1234567890abcd',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// DB injection via vi.mock
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

function makeMeApp(): Hono {
  const app = new Hono();
  app.route('/', createMeRouter());
  return app;
}

/** Inserts a user and returns it. */
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
  const row = rows[0];
  if (row === undefined) throw new Error('User insert returned no rows');
  return row;
}

/** Inserts a session and returns its id. */
async function insertSession(
  db: DrizzleDb,
  userId: string,
  expiresAt: Date = new Date(Date.now() + 14 * 86400_000),
): Promise<string> {
  const id = 'a'.repeat(43); // deterministic for ease; not from generateSessionId to avoid entropy
  // Use a unique id to avoid conflicts between tests.
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

// ---------------------------------------------------------------------------
// Unauthenticated
// ---------------------------------------------------------------------------

describe('GET /me — unauthenticated', () => {
  it('returns 401 AUTH_REQUIRED with login_url in details', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const app = makeMeApp();
        const res = await app.fetch(new Request('http://localhost/'));
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Cookie');

        const body = await res.json();
        expect(body.error.code).toBe('AUTH_REQUIRED');
        expect(body.error.details?.login_url).toBeTruthy();
        expect(body.error.details?.login_url).toContain('/api/v1/auth/google/start');
        expect(body.error.details?.login_url).toContain('return_to=');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 401 when session cookie is present but session does not exist in DB', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const app = makeMeApp();
        const res = await app.fetch(
          new Request('http://localhost/', {
            headers: { Cookie: '__Host-prov_sess=' + 'x'.repeat(43) },
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
// Authenticated
// ---------------------------------------------------------------------------

describe('GET /me — authenticated', () => {
  it('returns user, empty memberships, principal_kind=session', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, {
          email: 'me@berkeley.edu',
          display_name: 'Me User',
          is_superadmin: false,
          last_login_at: new Date('2026-01-01T00:00:00.000Z'),
        });
        const sessionId = await insertSession(db, user.id);

        const app = makeMeApp();
        const res = await app.fetch(
          new Request('http://localhost/', {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.user.id).toBe(user.id);
        expect(body.user.email).toBe('me@berkeley.edu');
        expect(body.user.display_name).toBe('Me User');
        expect(body.user.is_superadmin).toBe(false);
        expect(body.user.created_at).toBeTruthy();
        expect(body.user.last_login_at).toBe('2026-01-01T00:00:00.000Z');

        expect(body.memberships).toEqual([]);
        expect(body.principal_kind).toBe('session');

        // Phase 2: no 'token' field.
        expect(body.token).toBeUndefined();
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns null last_login_at when user has never logged in', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { last_login_at: undefined });
        const sessionId = await insertSession(db, user.id);

        const app = makeMeApp();
        const res = await app.fetch(
          new Request('http://localhost/', {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.user.last_login_at).toBeNull();
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 401 when session is expired', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const pastDate = new Date(Date.now() - 1000);
        const sessionId = await insertSession(db, user.id, pastDate);

        const app = makeMeApp();
        const res = await app.fetch(
          new Request('http://localhost/', {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns principal_kind=token with token field when authenticated via bearer', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, {
          email: 'bearer@berkeley.edu',
          display_name: 'Bearer User',
        });

        const { createToken } = await import('../../../auth/tokens.js');
        const { secret, token: created } = await createToken(db, {
          userId: user.id,
          label: 'Test Bearer Token',
          scopes: {
            read_only: true,
            semester_ids: null,
            include_blobs: false,
          },
        });

        const app = makeMeApp();
        const res = await app.fetch(
          new Request('http://localhost/', {
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.user.id).toBe(user.id);
        expect(body.user.email).toBe('bearer@berkeley.edu');
        expect(body.principal_kind).toBe('token');

        // Token field should be present when using bearer auth
        expect(body.token).toBeTruthy();
        expect(body.token.id).toBe(created.id);
        expect(body.token.label).toBe('Test Bearer Token');
        expect(body.token.scopes).toEqual({
          read_only: true,
          semester_ids: null,
          include_blobs: false,
        });
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns memberships when user is part of semesters', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const admin = await insertUser(db, { is_superadmin: true });
        const sessionId = await insertSession(db, user.id);

        // Create course and semester
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

        // Add user as grader to the semester
        await db.insert(memberships).values({
          user_id: user.id,
          semester_id: semester!.id,
          role: 'grader',
          granted_by: admin.id,
        });

        const app = makeMeApp();
        const res = await app.fetch(
          new Request('http://localhost/', {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.memberships).toBeTruthy();
        expect(Array.isArray(body.memberships)).toBe(true);
        expect(body.memberships.length).toBe(1);

        const mem = body.memberships[0];
        expect(mem.semester_id).toBe(semester!.id);
        expect(mem.semester_slug).toBe('fa2024');
        expect(mem.semester_display_name).toBe('Fall 2024');
        expect(mem.course_slug).toBe('cs61a');
        expect(mem.course_name).toBe('CS 61A');
        expect(mem.role).toBe('grader');
        expect(mem.granted_at).toBeTruthy();
      } finally {
        _testDb = null;
      }
    });
  });

  it('superadmin with no explicit memberships sees all semesters as admin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        // Superadmin who is NOT a member of any semester.
        const admin = await insertUser(db, {
          email: 'admin@berkeley.edu',
          is_superadmin: true,
        });
        const sessionId = await insertSession(db, admin.id);

        // Two semesters across two courses; the superadmin has no membership rows.
        const [courseA] = await db
          .insert(courses)
          .values({ name: 'CS 61A', slug: 'cs61a' })
          .returning();
        const [courseB] = await db
          .insert(courses)
          .values({ name: 'CS 61B', slug: 'cs61b' })
          .returning();
        await db.insert(semesters).values({
          course_id: courseA!.id,
          term: 'fa',
          year: 2024,
          slug: 'fa2024',
          display_name: 'Fall 2024',
          filename_convention: '(?<sid>[a-z0-9]+)_hw',
        });
        await db.insert(semesters).values({
          course_id: courseB!.id,
          term: 'sp',
          year: 2025,
          slug: 'sp2025',
          display_name: 'Spring 2025',
          filename_convention: '(?<sid>[a-z0-9]+)_hw',
        });

        const app = makeMeApp();
        const res = await app.fetch(
          new Request('http://localhost/', {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.user.is_superadmin).toBe(true);

        // All semesters surface, each as an admin membership.
        expect(body.memberships.length).toBe(2);
        for (const mem of body.memberships) {
          expect(mem.role).toBe('admin');
          expect(mem.granted_at).toBeTruthy();
        }
        const slugs = body.memberships.map((m: { semester_slug: string }) => m.semester_slug);
        expect(slugs).toContain('fa2024');
        expect(slugs).toContain('sp2025');
      } finally {
        _testDb = null;
      }
    });
  });

  it('non-superadmin with no memberships sees no semesters', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db, { is_superadmin: false });
        const sessionId = await insertSession(db, user.id);

        // A semester exists, but the user is not a member of it.
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

        const app = makeMeApp();
        const res = await app.fetch(
          new Request('http://localhost/', {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.memberships).toEqual([]);
      } finally {
        _testDb = null;
      }
    });
  });
});
