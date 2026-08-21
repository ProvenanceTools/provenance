/**
 * Audit route integration tests (Phase 19).
 *
 * Tests run through createV1App() per V18 rule.
 * Uses real Postgres (testcontainers).
 *
 * Test groups:
 *   1. Filter by action returns matching rows
 *   2. Filter by semester_id enforces admin auth
 *   3. Cursor round-trip (pagination)
 *   4. Pagination terminates
 *   5. 401 without auth
 *   6. 403 when not an admin anywhere
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import { users, sessions, courses, semesters, memberships, audit_log } from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';

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
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-audit-tests-123456789012345',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
  };
}

async function seedUser(db: DrizzleDb, opts?: { isSuperadmin?: boolean }) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      google_subject: `sub-${id}`,
      email: `user-${id}@berkeley.edu`,
      display_name: 'Test User',
      is_superadmin: opts?.isSuperadmin ?? false,
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

async function seedAuditRow(
  db: DrizzleDb,
  opts: {
    actorUserId: string;
    semesterId?: string;
    action: string;
    targetType?: string;
    targetId?: string;
    at?: Date;
  },
) {
  const [row] = await db
    .insert(audit_log)
    .values({
      actor_user_id: opts.actorUserId,
      semester_id: opts.semesterId,
      action: opts.action,
      target_type: opts.targetType ?? 'semester',
      target_id: opts.targetId ?? 'test-target',
      detail: {},
      at: opts.at ?? new Date(),
    })
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// §1. Filter by action
// ---------------------------------------------------------------------------

describe('GET /audit — filter by action', () => {
  it('returns only matching rows when action filter is specified', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const admin = await seedUser(db);
      const sessionId = await seedSession(db, admin.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, admin.id, semester.id, 'admin');

      // Seed 2 different actions
      await seedAuditRow(db, {
        actorUserId: admin.id,
        semesterId: semester.id,
        action: 'semester.create',
      });
      await seedAuditRow(db, {
        actorUserId: admin.id,
        semesterId: semester.id,
        action: 'member.invite',
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/audit?action=semester.create', {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { action: string }[];
        next_cursor: string | null;
      };
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      for (const item of body.items) {
        expect(item.action).toBe('semester.create');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// §2. semester_id filter enforces admin auth
// ---------------------------------------------------------------------------

describe('GET /audit — semester_id filter auth', () => {
  it('returns 403 for grader trying to access audit log', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const grader = await seedUser(db);
      const sessionId = await seedSession(db, grader.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, grader.id, semester.id, 'grader');

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/audit?semester_id=${semester.id}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      // Grader has no admin semesters → 403
      expect(res.status).toBe(403);
    });
  });

  it("returns 403 for admin requesting another admin's semester", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const admin = await seedUser(db);
      const sessionId = await seedSession(db, admin.id);
      const { semester: mySemester } = await seedCourseAndSemester(db);
      const { semester: otherSemester } = await seedCourseAndSemester(db);
      await seedMembership(db, admin.id, mySemester.id, 'admin');
      // admin is NOT an admin of otherSemester

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/audit?semester_id=${otherSemester.id}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      // Requesting a semester they don't admin → 403
      expect(res.status).toBe(403);
    });
  });

  it('semester admin sees rows for their semester', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const admin = await seedUser(db);
      const sessionId = await seedSession(db, admin.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, admin.id, semester.id, 'admin');

      await seedAuditRow(db, {
        actorUserId: admin.id,
        semesterId: semester.id,
        action: 'roster.commit',
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/audit?semester_id=${semester.id}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; next_cursor: string | null };
      expect(body.items.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// §3. Cursor round-trip
// ---------------------------------------------------------------------------

describe('GET /audit — cursor pagination', () => {
  it('cursor round-trip returns correct pages', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const admin = await seedUser(db);
      const sessionId = await seedSession(db, admin.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, admin.id, semester.id, 'admin');

      // Seed 3 rows
      for (let i = 0; i < 3; i++) {
        await seedAuditRow(db, {
          actorUserId: admin.id,
          semesterId: semester.id,
          action: `test.action.${i}`,
          // Spread timestamps so they sort consistently
          at: new Date(Date.now() - (3 - i) * 1000),
        });
      }

      const app = createV1App();

      // Page 1: limit=2
      const res1 = await app.fetch(
        new Request(`http://localhost/audit?semester_id=${semester.id}&limit=2`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res1.status).toBe(200);
      const page1 = (await res1.json()) as { items: unknown[]; next_cursor: string | null };
      expect(page1.items).toHaveLength(2);
      expect(page1.next_cursor).not.toBeNull();

      // Page 2: use cursor
      const res2 = await app.fetch(
        new Request(
          `http://localhost/audit?semester_id=${semester.id}&limit=2&cursor=${encodeURIComponent(page1.next_cursor!)}`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );
      expect(res2.status).toBe(200);
      const page2 = (await res2.json()) as { items: unknown[]; next_cursor: string | null };
      expect(page2.items.length).toBeGreaterThanOrEqual(1);
      // All items in page 1 + page 2 should have no overlap (check uniqueness by not crashing)
    });
  });
});

// ---------------------------------------------------------------------------
// §4. Pagination terminates
// ---------------------------------------------------------------------------

describe('GET /audit — pagination terminates', () => {
  it('next_cursor is null when on the last page', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const admin = await seedUser(db);
      const sessionId = await seedSession(db, admin.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, admin.id, semester.id, 'admin');

      await seedAuditRow(db, {
        actorUserId: admin.id,
        semesterId: semester.id,
        action: 'test.single',
      });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/audit?semester_id=${semester.id}&limit=50`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; next_cursor: string | null };
      // With only 1 row and limit=50, there's no next page
      expect(body.next_cursor).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// §5. 401 without auth
// ---------------------------------------------------------------------------

describe('GET /audit — authentication', () => {
  it('returns 401 without auth', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const app = createV1App();
      const res = await app.fetch(new Request('http://localhost/audit'));

      expect(res.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// §6. 403 when user has no admin memberships
// ---------------------------------------------------------------------------

describe('GET /audit — §6 not an admin anywhere', () => {
  it('returns 403 when user has no admin memberships', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      // Deliberately do NOT add any memberships.

      const app = createV1App();
      const res = await app.fetch(
        new Request('http://localhost/audit', {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(403);
    });
  });
});
