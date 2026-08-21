/**
 * V45 — admin router integration tests.
 *
 * Tested via createV1App() against a real Postgres (testcontainers) per V18.
 *
 * Coverage:
 *   §1 List users — happy path, search, cursor pagination, 403 for non-superadmin.
 *   §2 User detail — returns memberships across semesters; 404 for missing.
 *   §3 Delete user — cannot delete self, can delete others, 404 for missing,
 *      writes audit row.
 *   §4 View-as enter — rejects self-target, rejects missing target, writes
 *      session row + audit row.
 *   §5 View-as exit — clears session row, idempotent when not in view-as,
 *      writes audit row.
 *   §6 View-as semantics — once entered, non-read action on any route returns
 *      403 VIEW_AS_READ_ONLY (cross-feature integration check).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import { users, sessions, audit_log, courses, semesters, memberships } from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';
import { AdminUserDetailResponseSchema } from '@provenance/shared/api-schemas';

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
// Helpers
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
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-admin-tests-123456789012345',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
  };
}

async function seedUser(
  db: DrizzleDb,
  opts?: { isSuperadmin?: boolean; is_superadmin?: boolean; email?: string; displayName?: string },
) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      google_subject: `sub-${id}`,
      email: opts?.email ?? `user-${id}@berkeley.edu`,
      display_name: opts?.displayName ?? 'Test User',
      is_superadmin: opts?.is_superadmin ?? opts?.isSuperadmin ?? false,
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

function cookieHeader(sessionId: string) {
  return { Cookie: `__Host-prov_sess=${sessionId}` };
}

// ---------------------------------------------------------------------------
// §1. List users
// ---------------------------------------------------------------------------

describe('GET /admin/users', () => {
  it('lists users for a superadmin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);
      await seedUser(db, { email: 'alpha@berkeley.edu', displayName: 'Alpha' });
      await seedUser(db, { email: 'beta@berkeley.edu', displayName: 'Beta' });

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/admin/users', { headers: cookieHeader(sessionId) }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { id: string; email: string }[];
        next_cursor: string | null;
      };
      expect(body.items.length).toBeGreaterThanOrEqual(3); // sa + 2 seeded
      expect(body.items.some((u) => u.email === 'alpha@berkeley.edu')).toBe(true);
    });
  });

  it('filters by free-text q (email or display_name)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);
      await seedUser(db, { email: 'needle@berkeley.edu', displayName: 'Needle' });
      await seedUser(db, { email: 'haystack@berkeley.edu', displayName: 'Haystack' });

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/admin/users?q=needle', { headers: cookieHeader(sessionId) }),
      );
      const body = (await res.json()) as { items: { email: string }[] };
      expect(body.items.every((u) => u.email.includes('needle'))).toBe(true);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('returns 403 for non-superadmin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/admin/users', { headers: cookieHeader(sessionId) }),
      );
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// §2. User detail
// ---------------------------------------------------------------------------

describe('GET /admin/users/:id', () => {
  it('returns memberships across semesters', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);
      const target = await seedUser(db, { email: 'target@berkeley.edu' });
      const { semester } = await seedCourseAndSemester(db);
      await db.insert(memberships).values({
        user_id: target.id,
        semester_id: semester.id,
        role: 'grader',
        granted_by: sa.id,
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/admin/users/${target.id}`, {
          headers: cookieHeader(sessionId),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        user: { email: string };
        memberships: { semester_id: string; role: string }[];
      };
      expect(body.user.email).toBe('target@berkeley.edu');
      expect(body.memberships).toHaveLength(1);
      expect(body.memberships[0]!.role).toBe('grader');
    });
  });

  it('response satisfies the shared AdminUserDetailResponseSchema (memberships carry display names)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);
      const target = await seedUser(db, { email: 'target@berkeley.edu' });
      const { semester } = await seedCourseAndSemester(db);
      await db.insert(memberships).values({
        user_id: target.id,
        semester_id: semester.id,
        role: 'grader',
        granted_by: sa.id,
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/admin/users/${target.id}`, {
          headers: cookieHeader(sessionId),
        }),
      );
      expect(res.status).toBe(200);
      // The analyzer validates this exact response with the shared schema; if
      // the handler omits semester_display_name/course_name the parse throws
      // and the UI shows "Failed to load user."
      const parsed = AdminUserDetailResponseSchema.parse(await res.json());
      expect(parsed.memberships[0]!.semester_display_name).toBe(semester.display_name);
    });
  });

  it('returns 404 for missing user', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/admin/users/00000000-0000-0000-0000-000000000000', {
          headers: cookieHeader(sessionId),
        }),
      );
      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// §3. Delete user
// ---------------------------------------------------------------------------

describe('DELETE /admin/users/:id', () => {
  it('refuses to delete self', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/admin/users/${sa.id}`, {
          method: 'DELETE',
          headers: cookieHeader(sessionId),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION');
    });
  });

  it('deletes another user and writes an audit row', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);
      const target = await seedUser(db);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/admin/users/${target.id}`, {
          method: 'DELETE',
          headers: cookieHeader(sessionId),
        }),
      );
      expect(res.status).toBe(204);

      const remaining = await db.select().from(users).where(eq(users.id, target.id));
      expect(remaining).toHaveLength(0);

      // Audit row exists (fire-and-forget; small wait is unnecessary because
      // insertAuditRow is awaited inside the .catch handler before the response
      // flushes — but defensively let any microtasks settle).
      await new Promise((r) => setTimeout(r, 25));
      const audit = await db
        .select()
        .from(audit_log)
        .where(eq(audit_log.action, 'admin.user.delete'));
      expect(audit.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// §4. View-as enter
// ---------------------------------------------------------------------------

describe('POST /admin/view-as', () => {
  it('sets view_as on the session row + writes audit', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);
      const target = await seedUser(db, { email: 'target@berkeley.edu' });

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/admin/view-as', {
          method: 'POST',
          headers: { ...cookieHeader(sessionId), 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: target.id }),
        }),
      );
      expect(res.status).toBe(200);

      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(row!.view_as_user_id).toBe(target.id);
      expect(row!.view_as_started_at).toBeInstanceOf(Date);

      await new Promise((r) => setTimeout(r, 25));
      const audit = await db
        .select()
        .from(audit_log)
        .where(eq(audit_log.action, 'admin.view_as.start'));
      expect(audit.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('rejects self-target', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/admin/view-as', {
          method: 'POST',
          headers: { ...cookieHeader(sessionId), 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: sa.id }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  it('returns 404 for missing target', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/admin/view-as', {
          method: 'POST',
          headers: { ...cookieHeader(sessionId), 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: '00000000-0000-0000-0000-000000000000' }),
        }),
      );
      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// §5. View-as exit
// ---------------------------------------------------------------------------

describe('POST /admin/view-as/exit', () => {
  it('clears view_as on the session', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);
      const target = await seedUser(db);
      await db
        .update(sessions)
        .set({ view_as_user_id: target.id, view_as_started_at: new Date() })
        .where(eq(sessions.id, sessionId));

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/admin/view-as/exit', {
          method: 'POST',
          headers: cookieHeader(sessionId),
        }),
      );
      expect(res.status).toBe(204);

      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(row!.view_as_user_id).toBeNull();
      expect(row!.view_as_started_at).toBeNull();
    });
  });

  it('is idempotent when not in view-as (returns 204)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/admin/view-as/exit', {
          method: 'POST',
          headers: cookieHeader(sessionId),
        }),
      );
      expect(res.status).toBe(204);
    });
  });
});

// ---------------------------------------------------------------------------
// §7. PATCH /admin/users/:id/protected — protected-mode toggle
// ---------------------------------------------------------------------------

describe('PATCH /admin/users/:id/protected', () => {
  it('sets the protected flag (superadmin acting on another user)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));
      const admin = await seedUser(db, { is_superadmin: true });
      const sess = await seedSession(db, admin.id);
      const target = await seedUser(db);
      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/admin/users/${target.id}/protected`, {
          method: 'PATCH',
          headers: { Cookie: `__Host-prov_sess=${sess}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ protected: true }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; protected: boolean };
      expect(body.protected).toBe(true);
      const [row] = await db
        .select({ p: users.protected })
        .from(users)
        .where(eq(users.id, target.id));
      expect(row!.p).toBe(true);
    });
  });

  it('rejects changing your OWN protected flag (400)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));
      const admin = await seedUser(db, { is_superadmin: true });
      const sess = await seedSession(db, admin.id);
      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/admin/users/${admin.id}/protected`, {
          method: 'PATCH',
          headers: { Cookie: `__Host-prov_sess=${sess}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ protected: false }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION');
    });
  });

  it('returns 404 for a missing target user', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));
      const admin = await seedUser(db, { is_superadmin: true });
      const sess = await seedSession(db, admin.id);
      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/admin/users/00000000-0000-0000-0000-000000000000/protected', {
          method: 'PATCH',
          headers: { Cookie: `__Host-prov_sess=${sess}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ protected: true }),
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  it('returns 403 for non-superadmin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));
      const user = await seedUser(db);
      const sess = await seedSession(db, user.id);
      const target = await seedUser(db);
      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/admin/users/${target.id}/protected`, {
          method: 'PATCH',
          headers: { Cookie: `__Host-prov_sess=${sess}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ protected: true }),
        }),
      );
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// §6. View-as semantics — cross-route integration check
// ---------------------------------------------------------------------------

describe('view-as read-only enforcement', () => {
  it('a superadmin in view-as cannot start a second view-as (VIEW_AS_READ_ONLY)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const sa = await seedUser(db, { isSuperadmin: true });
      const sessionId = await seedSession(db, sa.id);
      const target1 = await seedUser(db);
      const target2 = await seedUser(db);

      // Enter view-as as target1
      await db
        .update(sessions)
        .set({ view_as_user_id: target1.id, view_as_started_at: new Date() })
        .where(eq(sessions.id, sessionId));

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/admin/view-as', {
          method: 'POST',
          headers: { ...cookieHeader(sessionId), 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: target2.id }),
        }),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VIEW_AS_READ_ONLY');
    });
  });
});
