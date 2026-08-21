/**
 * Invitations service integration tests.
 *
 * Uses withTestDb (testcontainers) for full DB isolation.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq, and, isNull } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { parseEnv } from '../config/env.js';
import { users, courses, semesters, memberships, pending_invitations } from '../db/schema.js';
import type { DrizzleDb } from '../db/client.js';
import { inviteMember, activatePendingInvitations, revokeInvitation } from './invitations.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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
  AUTH_SUPERADMIN_EMAILS: '[]',
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-invitations-tests-12345678',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
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

// ---------------------------------------------------------------------------
// inviteMember — existing user path
// ---------------------------------------------------------------------------

describe('inviteMember — existing user', () => {
  it('creates a membership directly when user exists; no pending row', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu', display_name: 'Admin' });
      const invitee = await insertUser(db, { email: 'invitee@berkeley.edu' });
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      const result = await inviteMember(db, semester.id, invitee.email, 'grader', admin.id);

      expect(result.kind).toBe('member');
      if (result.kind !== 'member') return;
      expect(result.member.email).toBe(invitee.email);
      expect(result.member.role).toBe('grader');
      expect(result.member.granted_by_email).toBe(admin.email);

      // DB: membership row exists
      const memberRows = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.user_id, invitee.id), eq(memberships.semester_id, semester.id)));
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.role).toBe('grader');

      // No pending_invitations row
      const pendingRows = await db
        .select()
        .from(pending_invitations)
        .where(eq(pending_invitations.semester_id, semester.id));
      expect(pendingRows).toHaveLength(0);
    });
  });

  it('case-insensitive lookup: inviting UPPER email matches existing lower-case user', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      // Create the user with a lower-case email; the invite uses upper-case.
      await insertUser(db, { email: 'mixedcase@berkeley.edu' });
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      const result = await inviteMember(
        db,
        semester.id,
        'MIXEDCASE@berkeley.edu',
        'admin',
        admin.id,
      );
      expect(result.kind).toBe('member');
    });
  });

  it('throws MEMBER_ALREADY when user is already a member', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const invitee = await insertUser(db, { email: 'already@berkeley.edu' });
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      // Pre-insert membership
      await db.insert(memberships).values({
        user_id: invitee.id,
        semester_id: semester.id,
        role: 'grader',
        granted_by: admin.id,
      });

      await expect(
        inviteMember(db, semester.id, invitee.email, 'grader', admin.id),
      ).rejects.toMatchObject({ code: 'MEMBER_ALREADY' });
    });
  });
});

// ---------------------------------------------------------------------------
// inviteMember — new email path
// ---------------------------------------------------------------------------

describe('inviteMember — new email', () => {
  it('inserts a pending_invitations row; calls sendEmail once', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      const sendEmail = vi.fn().mockResolvedValue(undefined);

      const result = await inviteMember(db, semester.id, 'newuser@other.edu', 'grader', admin.id, {
        sendEmail,
      });

      expect(result.kind).toBe('pending');
      if (result.kind !== 'pending') return;
      expect(result.pending.email).toBe('newuser@other.edu');
      expect(result.pending.role).toBe('grader');
      expect(result.pending.invited_by_email).toBe(admin.email);

      // DB: pending row
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
      expect(pendingRows[0]!.role).toBe('grader');

      // Email called once (zero-arg closure — content is baked into the closure
      // by the caller, not passed as args here).
      // The sendEmail call is fire-and-forget; give it a tick to settle.
      await new Promise((r) => setTimeout(r, 10));
      expect(sendEmail).toHaveBeenCalledOnce();
      // sendEmail is now a () => Promise<void>; no args to assert on.
      expect(sendEmail.mock.calls[0]).toHaveLength(0);
    });
  });

  it('normalizes email to lower-case when storing', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      const result = await inviteMember(db, semester.id, 'NewUser@Other.EDU', 'grader', admin.id);

      expect(result.kind).toBe('pending');
      if (result.kind !== 'pending') return;
      expect(result.pending.email).toBe('newuser@other.edu');
    });
  });

  it('throws INVITATION_ALREADY_OPEN on duplicate open invite', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      // First invite succeeds
      await inviteMember(db, semester.id, 'dup@other.edu', 'grader', admin.id);

      // Second invite for same email+semester throws
      await expect(
        inviteMember(db, semester.id, 'dup@other.edu', 'admin', admin.id),
      ).rejects.toMatchObject({ code: 'INVITATION_ALREADY_OPEN' });
    });
  });

  it('succeeds with warning potential: invite from non-allowed domain still creates pending row', async () => {
    // The service itself does NOT check domains — that's the route's responsibility.
    // This test confirms the service accepts any email and creates the row.
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      const result = await inviteMember(db, semester.id, 'bob@other.edu', 'grader', admin.id);
      expect(result.kind).toBe('pending');
    });
  });
});

// ---------------------------------------------------------------------------
// activatePendingInvitations
// ---------------------------------------------------------------------------

describe('activatePendingInvitations', () => {
  it('activates all open rows for a matching email; sets consumed_at; returns count', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const sem1 = await insertSemester(db, course.id);
      const sem2 = await insertSemester(db, course.id);
      const invitee = await insertUser(db, { email: 'invited@berkeley.edu' });

      // Insert two pending rows (different semesters, same email)
      const [inv1] = await db
        .insert(pending_invitations)
        .values({
          email: 'invited@berkeley.edu',
          semester_id: sem1.id,
          role: 'grader',
          invited_by: admin.id,
        })
        .returning();
      const [inv2] = await db
        .insert(pending_invitations)
        .values({
          email: 'invited@berkeley.edu',
          semester_id: sem2.id,
          role: 'admin',
          invited_by: admin.id,
        })
        .returning();

      const { activated } = await activatePendingInvitations(
        db,
        'invited@berkeley.edu',
        invitee.id,
      );

      expect(activated).toBe(2);

      // Both rows consumed
      const inv1Row = await db
        .select()
        .from(pending_invitations)
        .where(eq(pending_invitations.id, inv1!.id));
      expect(inv1Row[0]!.consumed_at).not.toBeNull();

      const inv2Row = await db
        .select()
        .from(pending_invitations)
        .where(eq(pending_invitations.id, inv2!.id));
      expect(inv2Row[0]!.consumed_at).not.toBeNull();

      // Both memberships created
      const mem1 = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.user_id, invitee.id), eq(memberships.semester_id, sem1.id)));
      expect(mem1).toHaveLength(1);
      expect(mem1[0]!.role).toBe('grader');

      const mem2 = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.user_id, invitee.id), eq(memberships.semester_id, sem2.id)));
      expect(mem2).toHaveLength(1);
      expect(mem2[0]!.role).toBe('admin');
    });
  });

  it('ignores already-consumed rows; returns 0', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);
      const invitee = await insertUser(db, { email: 'consumed@berkeley.edu' });

      // Insert an already-consumed row
      await db.insert(pending_invitations).values({
        email: 'consumed@berkeley.edu',
        semester_id: semester.id,
        role: 'grader',
        invited_by: admin.id,
        consumed_at: new Date(),
      });

      const { activated } = await activatePendingInvitations(
        db,
        'consumed@berkeley.edu',
        invitee.id,
      );
      expect(activated).toBe(0);
    });
  });

  it('returns 0 when no matching rows exist', async () => {
    await withTestDb(async (db) => {
      const invitee = await insertUser(db, { email: 'nobody@berkeley.edu' });
      const { activated } = await activatePendingInvitations(db, 'nobody@berkeley.edu', invitee.id);
      expect(activated).toBe(0);
    });
  });

  it('is idempotent — calling twice does not create duplicate memberships', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);
      const invitee = await insertUser(db, { email: 'idempotent@berkeley.edu' });

      await db.insert(pending_invitations).values({
        email: 'idempotent@berkeley.edu',
        semester_id: semester.id,
        role: 'grader',
        invited_by: admin.id,
      });

      await activatePendingInvitations(db, 'idempotent@berkeley.edu', invitee.id);
      // Second call: invitation is consumed; 0 activated.
      const { activated } = await activatePendingInvitations(
        db,
        'idempotent@berkeley.edu',
        invitee.id,
      );
      expect(activated).toBe(0);

      // Only one membership row
      const memRows = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.user_id, invitee.id), eq(memberships.semester_id, semester.id)));
      expect(memRows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // CTE atomicity regression tests (Critical 1 fix)
  // ---------------------------------------------------------------------------

  it('CTE: activates multiple semesters in one call; all consumed_at set', async () => {
    // Verifies the CTE replaces the for-loop: all open rows across different
    // semesters are consumed atomically in a single round-trip.
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const sem1 = await insertSemester(db, course.id);
      const sem2 = await insertSemester(db, course.id);
      const sem3 = await insertSemester(db, course.id);
      const invitee = await insertUser(db, { email: 'multi@berkeley.edu' });

      await db.insert(pending_invitations).values([
        { email: 'multi@berkeley.edu', semester_id: sem1.id, role: 'grader', invited_by: admin.id },
        { email: 'multi@berkeley.edu', semester_id: sem2.id, role: 'admin', invited_by: admin.id },
        { email: 'multi@berkeley.edu', semester_id: sem3.id, role: 'grader', invited_by: admin.id },
      ]);

      const { activated } = await activatePendingInvitations(db, 'multi@berkeley.edu', invitee.id);

      expect(activated).toBe(3);

      // All three memberships created
      for (const sem of [sem1, sem2, sem3]) {
        const mem = await db
          .select()
          .from(memberships)
          .where(and(eq(memberships.user_id, invitee.id), eq(memberships.semester_id, sem.id)));
        expect(mem).toHaveLength(1);
      }

      // All three invitations consumed
      const remaining = await db
        .select()
        .from(pending_invitations)
        .where(isNull(pending_invitations.consumed_at));
      expect(remaining).toHaveLength(0);
    });
  });

  it('CTE: already-consumed rows are untouched by subsequent calls', async () => {
    // A row with consumed_at IS NOT NULL must remain unchanged — the CTE's
    // WHERE consumed_at IS NULL clause guarantees this.
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const sem1 = await insertSemester(db, course.id);
      const sem2 = await insertSemester(db, course.id);
      const invitee = await insertUser(db, { email: 'partial@berkeley.edu' });

      const consumedDate = new Date('2024-01-01T00:00:00Z');

      // sem1: already consumed
      await db.insert(pending_invitations).values({
        email: 'partial@berkeley.edu',
        semester_id: sem1.id,
        role: 'grader',
        invited_by: admin.id,
        consumed_at: consumedDate,
      });
      // sem2: open
      await db.insert(pending_invitations).values({
        email: 'partial@berkeley.edu',
        semester_id: sem2.id,
        role: 'admin',
        invited_by: admin.id,
      });

      const { activated } = await activatePendingInvitations(
        db,
        'partial@berkeley.edu',
        invitee.id,
      );
      // Only sem2 was open
      expect(activated).toBe(1);

      // sem1 consumed_at unchanged
      const sem1Rows = await db
        .select()
        .from(pending_invitations)
        .where(and(eq(pending_invitations.semester_id, sem1.id)));
      expect(sem1Rows[0]!.consumed_at!.getTime()).toBe(consumedDate.getTime());

      // sem2 now consumed
      const sem2Rows = await db
        .select()
        .from(pending_invitations)
        .where(and(eq(pending_invitations.semester_id, sem2.id)));
      expect(sem2Rows[0]!.consumed_at).not.toBeNull();
    });
  });

  it('CTE: second call after first is a no-op (returns 0 activated)', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);
      const invitee = await insertUser(db, { email: 'noop@berkeley.edu' });

      await db.insert(pending_invitations).values({
        email: 'noop@berkeley.edu',
        semester_id: semester.id,
        role: 'grader',
        invited_by: admin.id,
      });

      const first = await activatePendingInvitations(db, 'noop@berkeley.edu', invitee.id);
      expect(first.activated).toBe(1);

      const second = await activatePendingInvitations(db, 'noop@berkeley.edu', invitee.id);
      expect(second.activated).toBe(0);
    });
  });

  it('CTE: user already a member in one semester is silently skipped; others still activated', async () => {
    // ON CONFLICT DO NOTHING in the INSERT means pre-existing membership rows do
    // not appear in RETURNING, so the consumed_at UPDATE for that invitation does
    // not fire. The other semesters proceed normally.
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const sem1 = await insertSemester(db, course.id);
      const sem2 = await insertSemester(db, course.id);
      const invitee = await insertUser(db, { email: 'conflict@berkeley.edu' });

      // Pre-existing membership for sem1
      await db.insert(memberships).values({
        user_id: invitee.id,
        semester_id: sem1.id,
        role: 'grader',
        granted_by: admin.id,
      });

      // Pending invitations for both semesters
      await db.insert(pending_invitations).values([
        {
          email: 'conflict@berkeley.edu',
          semester_id: sem1.id,
          role: 'admin',
          invited_by: admin.id,
        },
        {
          email: 'conflict@berkeley.edu',
          semester_id: sem2.id,
          role: 'grader',
          invited_by: admin.id,
        },
      ]);

      const { activated } = await activatePendingInvitations(
        db,
        'conflict@berkeley.edu',
        invitee.id,
      );

      // sem2 activated; sem1 skipped (conflict) → 1 activated
      expect(activated).toBe(1);

      // sem1: still grader (existing), not overwritten
      const sem1Mem = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.user_id, invitee.id), eq(memberships.semester_id, sem1.id)));
      expect(sem1Mem).toHaveLength(1);
      expect(sem1Mem[0]!.role).toBe('grader');

      // sem2: new membership created
      const sem2Mem = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.user_id, invitee.id), eq(memberships.semester_id, sem2.id)));
      expect(sem2Mem).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// revokeInvitation
// ---------------------------------------------------------------------------

describe('revokeInvitation', () => {
  it('hard-deletes a pending row', async () => {
    await withTestDb(async (db) => {
      const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      const [inv] = await db
        .insert(pending_invitations)
        .values({
          email: 'revoke@other.edu',
          semester_id: semester.id,
          role: 'grader',
          invited_by: admin.id,
        })
        .returning();

      await revokeInvitation(db, inv!.id);

      const rows = await db
        .select()
        .from(pending_invitations)
        .where(eq(pending_invitations.id, inv!.id));
      expect(rows).toHaveLength(0);
    });
  });

  it('is idempotent: revoking a non-existent row does not throw', async () => {
    await withTestDb(async (db) => {
      const fakeId = '00000000-0000-0000-0000-000000000001';
      await expect(revokeInvitation(db, fakeId)).resolves.toBeUndefined();
    });
  });
});
