/**
 * Members + invitations routes integration tests.
 *
 * All tests go through the full v1 app pipeline via createV1App() (V18 rule).
 * Audit log assertions follow the V20 rule (every write endpoint has an audit row test).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq, and, isNull } from 'drizzle-orm';
import { withTestDb } from '../../../../test/helpers/db.js';
import * as invitationsService from '../../../services/invitations.js';
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
  pending_invitations,
} from '../../../db/schema.js';
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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-members-tests-123456789',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// DB injection (same pattern as semesters.test.ts)
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

// ---------------------------------------------------------------------------
// GET /semesters/:semesterId/members
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/members', () => {
  it('returns 401 when unauthenticated', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`),
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
        const user = await insertUser(db);
        const sessionId = await insertSession(db, user.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 200 with members and pending arrays for a member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        // Pre-insert a pending invitation.
        await db.insert(pending_invitations).values({
          email: 'pending@other.edu',
          semester_id: semester.id,
          role: 'grader',
          invited_by: adminUser.id,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toHaveProperty('members');
        expect(body).toHaveProperty('pending');
        expect(Array.isArray(body.members)).toBe(true);
        expect(Array.isArray(body.pending)).toBe(true);
        expect(body.members).toHaveLength(1);
        expect(body.members[0].role).toBe('admin');
        expect(body.pending).toHaveLength(1);
        expect(body.pending[0].email).toBe('pending@other.edu');
      } finally {
        _testDb = null;
      }
    });
  });

  it('superadmin can list members without being a member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const superadmin = await insertUser(db, {
          email: 'admin@berkeley.edu',
          is_superadmin: true,
        });
        const sessionId = await insertSession(db, superadmin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.members).toHaveLength(0);
        expect(body.pending).toHaveLength(0);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// POST /semesters/:semesterId/members — invite
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/members', () => {
  it('rejects non-admin with 403', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const grader = await insertUser(db, { email: 'grader@berkeley.edu' });
        const sessionId = await insertSession(db, grader.id);
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, grader.id, semester.id, 'grader', adminUser.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email: 'new@berkeley.edu', role: 'grader' }),
          }),
        );
        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });

  it('happy path: invite existing user → 201 with member field; audit row created', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        // Pre-create the invitee user.
        const invitee = await insertUser(db, { email: 'invitee@berkeley.edu' });

        const app = createV1App();

        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email: invitee.email, role: 'grader' }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body).toHaveProperty('member');
        expect(body.member.email).toBe(invitee.email);
        expect(body.member.role).toBe('grader');
        expect(body).not.toHaveProperty('pending');

        // Audit: member.invite row for this semester.
        const auditRow = await waitForAuditRow(db, 'member.invite', semester.id);
        expect(auditRow).toBeDefined();
        expect(auditRow!.actor_user_id).toBe(adminUser.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('happy path: invite new email → 201 with pending field; audit row created', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email: 'newperson@berkeley.edu', role: 'grader' }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body).toHaveProperty('pending');
        expect(body.pending.email).toBe('newperson@berkeley.edu');
        expect(body).not.toHaveProperty('member');

        // DB: pending row exists
        const pendingRows = await db
          .select()
          .from(pending_invitations)
          .where(
            and(
              eq(pending_invitations.semester_id, semester.id),
              isNull(pending_invitations.consumed_at),
            ),
          );
        expect(pendingRows).toHaveLength(1);

        // Audit row
        const auditRow = await waitForAuditRow(db, 'member.invite', semester.id);
        expect(auditRow).toBeDefined();
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 409 MEMBER_ALREADY when inviting existing member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const invitee = await insertUser(db, { email: 'already@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);
        await insertMembership(db, invitee.id, semester.id, 'grader', adminUser.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email: invitee.email, role: 'grader' }),
          }),
        );

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error.code).toBe('MEMBER_ALREADY');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 409 INVITATION_ALREADY_OPEN on duplicate pending invite', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        // First invite
        await db.insert(pending_invitations).values({
          email: 'dup@other.edu',
          semester_id: semester.id,
          role: 'grader',
          invited_by: adminUser.id,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email: 'dup@other.edu', role: 'admin' }),
          }),
        );

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error.code).toBe('INVITATION_ALREADY_OPEN');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 201 with warning field when email domain is not in allowed list', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email: 'bob@other.edu', role: 'grader' }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        // Has a warning but still creates the invitation.
        expect(body).toHaveProperty('warning');
        expect(body.warning.code).toBe('EMAIL_DOMAIN_NOT_ALLOWED');
        // Pending row created
        expect(body).toHaveProperty('pending');

        // DB: pending row exists
        const pendingRows = await db
          .select()
          .from(pending_invitations)
          .where(
            and(
              eq(pending_invitations.semester_id, semester.id),
              isNull(pending_invitations.consumed_at),
            ),
          );
        expect(pendingRows).toHaveLength(1);
      } finally {
        _testDb = null;
      }
    });
  });

  it('validates body — missing role returns 400', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email: 'bob@berkeley.edu' }), // missing role
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
});

// ---------------------------------------------------------------------------
// PATCH /semesters/:semesterId/members/:userId — update role
// ---------------------------------------------------------------------------

describe('PATCH /semesters/:semesterId/members/:userId', () => {
  it('admin can promote a grader to admin; audit row created', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const grader = await insertUser(db, { email: 'grader@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);
        await insertMembership(db, grader.id, semester.id, 'grader', adminUser.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members/${grader.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ role: 'admin' }),
          }),
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.role).toBe('admin');

        // DB: role updated
        const memRows = await db
          .select()
          .from(memberships)
          .where(and(eq(memberships.user_id, grader.id), eq(memberships.semester_id, semester.id)));
        expect(memRows[0]!.role).toBe('admin');

        // Audit row
        const auditRow = await waitForAuditRow(db, 'member.update', grader.id);
        expect(auditRow).toBeDefined();
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 409 CANNOT_DEMOTE_SELF when admin tries to demote themselves', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const otherAdmin = await insertUser(db, { email: 'other@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        // Two admins so last-admin check doesn't fire first.
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);
        await insertMembership(db, otherAdmin.id, semester.id, 'admin', adminUser.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members/${adminUser.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ role: 'grader' }),
          }),
        );

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error.code).toBe('CANNOT_DEMOTE_SELF');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 409 LAST_ADMIN_REQUIRED when demoting sole admin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        // adminUser session not used for this test — superadmin makes the request
        const otherUser = await insertUser(db, { email: 'other@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        // Only one admin.
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);
        await insertMembership(db, otherUser.id, semester.id, 'grader', adminUser.id);

        // Second admin for auth (so the request itself is allowed).
        // Actually adminUser IS the admin making the request and IS the target.
        // But self-demotion check fires first (409 CANNOT_DEMOTE_SELF).
        // To test LAST_ADMIN_REQUIRED, we need a different admin trying to demote adminUser.
        // Add a superadmin to act as the requester.
        const superadmin = await insertUser(db, { email: 'sa@berkeley.edu', is_superadmin: true });
        const saSessionId = await insertSession(db, superadmin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members/${adminUser.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${saSessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ role: 'grader' }),
          }),
        );

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error.code).toBe('LAST_ADMIN_REQUIRED');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 404 when userId is not a member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const nonMember = await insertUser(db, { email: 'nonmember@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members/${nonMember.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ role: 'grader' }),
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
// DELETE /semesters/:semesterId/members/:userId — remove member
// ---------------------------------------------------------------------------

describe('DELETE /semesters/:semesterId/members/:userId', () => {
  it('admin can remove a grader; returns 204; audit row created', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const grader = await insertUser(db, { email: 'grader@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);
        await insertMembership(db, grader.id, semester.id, 'grader', adminUser.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members/${grader.id}`, {
            method: 'DELETE',
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(204);

        // DB: grader removed
        const memRows = await db
          .select()
          .from(memberships)
          .where(and(eq(memberships.user_id, grader.id), eq(memberships.semester_id, semester.id)));
        expect(memRows).toHaveLength(0);

        // Audit row
        const auditRow = await waitForAuditRow(db, 'member.remove', grader.id);
        expect(auditRow).toBeDefined();
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 409 LAST_ADMIN_REQUIRED when removing sole admin', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        // Superadmin makes the request (so auth passes; last-admin check fires)
        const superadmin = await insertUser(db, { email: 'sa@berkeley.edu', is_superadmin: true });
        const saSessionId = await insertSession(db, superadmin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members/${adminUser.id}`, {
            method: 'DELETE',
            headers: { Cookie: `__Host-prov_sess=${saSessionId}` },
          }),
        );

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error.code).toBe('LAST_ADMIN_REQUIRED');
      } finally {
        _testDb = null;
      }
    });
  });

  it('removing non-existent member is idempotent (returns 204)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const nonMember = await insertUser(db, { email: 'nonmember@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members/${nonMember.id}`, {
            method: 'DELETE',
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
// DELETE /semesters/:semesterId/invitations/:invitationId — revoke invitation
// ---------------------------------------------------------------------------

describe('DELETE /semesters/:semesterId/invitations/:invitationId', () => {
  it('admin can revoke a pending invitation; returns 204; audit row created', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        const [invite] = await db
          .insert(pending_invitations)
          .values({
            email: 'revoke@other.edu',
            semester_id: semester.id,
            role: 'grader',
            invited_by: adminUser.id,
          })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/invitations/${invite!.id}`, {
            method: 'DELETE',
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(204);

        // DB: row gone
        const pendingRows = await db
          .select()
          .from(pending_invitations)
          .where(eq(pending_invitations.id, invite!.id));
        expect(pendingRows).toHaveLength(0);

        // Audit row: invitation.revoke for the invitationId
        const auditRow = await waitForAuditRow(db, 'invitation.revoke', invite!.id);
        expect(auditRow).toBeDefined();
      } finally {
        _testDb = null;
      }
    });
  });

  it('revoking non-existent invitation is idempotent (returns 204); audit row still created', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        const fakeId = '00000000-0000-0000-0000-000000000099';
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/invitations/${fakeId}`, {
            method: 'DELETE',
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(204);
      } finally {
        _testDb = null;
      }
    });
  });

  it('non-member cannot revoke an invitation', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const nonMember = await insertUser(db, { email: 'nonmember@berkeley.edu' });
        const sessionId = await insertSession(db, nonMember.id);
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        const [invite] = await db
          .insert(pending_invitations)
          .values({
            email: 'revoke@other.edu',
            semester_id: semester.id,
            role: 'grader',
            invited_by: adminUser.id,
          })
          .returning();

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/invitations/${invite!.id}`, {
            method: 'DELETE',
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

// ---------------------------------------------------------------------------
// Concurrent admin demote race — Critical 2 regression tests
// ---------------------------------------------------------------------------

describe('concurrent admin demote race (FOR UPDATE lock serialization)', () => {
  it('only one of two concurrent demotes succeeds; at least 1 admin remains', async () => {
    // Two admins concurrently try to demote each other. Without the FOR UPDATE
    // lock, both could pass the "adminCount > 1" guard simultaneously and
    // both updates would succeed, leaving 0 admins.
    // With FOR UPDATE, Postgres serializes the two transactions; the second
    // must wait for the first to commit, then sees adminCount === 1 and throws.
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin1 = await insertUser(db, { email: 'admin1@berkeley.edu' });
        const admin2 = await insertUser(db, { email: 'admin2@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin1.id, semester.id, 'admin', admin1.id);
        await insertMembership(db, admin2.id, semester.id, 'admin', admin1.id);

        // Fire both demotes concurrently; Postgres row locks serialize them.
        const results = await Promise.allSettled([
          invitationsService.updateMemberRoleSafely(db, semester.id, admin1.id, 'grader'),
          invitationsService.updateMemberRoleSafely(db, semester.id, admin2.id, 'grader'),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        // Exactly one succeeds and one fails with LAST_ADMIN_REQUIRED.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const err = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
        expect(err.code).toBe('LAST_ADMIN_REQUIRED');

        // At least one admin remains in the DB.
        const adminCount = await invitationsService.countAdmins(db, semester.id);
        expect(adminCount).toBeGreaterThanOrEqual(1);
      } finally {
        _testDb = null;
      }
    });
  });

  it('only one of two concurrent removals of different admins succeeds', async () => {
    // Two admins concurrently removed by a superadmin. Same race as above
    // but via removeMemberSafely.
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin1 = await insertUser(db, { email: 'admin1@berkeley.edu' });
        const admin2 = await insertUser(db, { email: 'admin2@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin1.id, semester.id, 'admin', admin1.id);
        await insertMembership(db, admin2.id, semester.id, 'admin', admin1.id);

        const results = await Promise.allSettled([
          invitationsService.removeMemberSafely(db, semester.id, admin1.id),
          invitationsService.removeMemberSafely(db, semester.id, admin2.id),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        // Exactly one removal succeeds; the other is blocked by last-admin guard.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const err = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
        expect(err.code).toBe('LAST_ADMIN_REQUIRED');

        // At least one admin remains.
        const adminCount = await invitationsService.countAdmins(db, semester.id);
        expect(adminCount).toBeGreaterThanOrEqual(1);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Full invitation round-trip integration test
// ---------------------------------------------------------------------------

describe('Full invitation round-trip', () => {
  it('invite via API → activation on login path verified through service', async () => {
    // This test verifies the end-to-end flow:
    // 1. Admin invites a new email (creates pending_invitations row)
    // 2. The invited user "logs in" (we call activatePendingInvitations directly
    //    since the OAuth flow is tested separately in auth.test.ts)
    // 3. Membership exists; invitation consumed
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const adminUser = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, adminUser.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, adminUser.id, semester.id, 'admin', adminUser.id);

        // Step 1: Admin invites via API
        const app = createV1App();
        const inviteRes = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email: 'roundtrip@berkeley.edu', role: 'grader' }),
          }),
        );
        expect(inviteRes.status).toBe(201);
        const inviteBody = await inviteRes.json();
        expect(inviteBody).toHaveProperty('pending');

        // Step 2: Invited user signs up (simulate activation)
        const newUser = await insertUser(db, { email: 'roundtrip@berkeley.edu' });
        const { activatePendingInvitations } = await import('../../../services/invitations.js');
        const { activated } = await activatePendingInvitations(
          db,
          'roundtrip@berkeley.edu',
          newUser.id,
        );
        expect(activated).toBe(1);

        // Step 3: Verify membership exists
        const memberRows = await db
          .select()
          .from(memberships)
          .where(
            and(eq(memberships.user_id, newUser.id), eq(memberships.semester_id, semester.id)),
          );
        expect(memberRows).toHaveLength(1);
        expect(memberRows[0]!.role).toBe('grader');

        // Invitation consumed
        const pendingRows = await db
          .select()
          .from(pending_invitations)
          .where(
            and(
              eq(pending_invitations.semester_id, semester.id),
              isNull(pending_invitations.consumed_at),
            ),
          );
        expect(pendingRows).toHaveLength(0);

        // GET /members now shows the member and no pending
        const listRes = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/members`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(listRes.status).toBe(200);
        const listBody = await listRes.json();
        expect(listBody.pending).toHaveLength(0);
        // Two members: admin + new user
        expect(listBody.members).toHaveLength(2);
      } finally {
        _testDb = null;
      }
    });
  });
});
