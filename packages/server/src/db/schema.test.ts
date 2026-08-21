/**
 * Integration tests for the database schema.
 * Verifies FK constraints, CHECK constraints, and partial unique indexes.
 * Requires Docker (testcontainers).
 */

import { describe, it, expect, vi } from 'vitest';
import { withTestDb } from '../../test/helpers/db.js';
import { users, courses, semesters, memberships, pending_invitations } from './schema.js';
import { sql } from 'drizzle-orm';

// testcontainers needs a long startup budget
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<typeof users.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  return {
    google_subject: `sub-${id}`,
    email: `user-${id}@example.com`,
    ...overrides,
  };
}

function makeCourse(overrides: Partial<typeof courses.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  return {
    name: `Course ${id}`,
    slug: `course-${id}`,
    ...overrides,
  };
}

function makeSemester(courseId: string, overrides: Partial<typeof semesters.$inferInsert> = {}) {
  return {
    course_id: courseId,
    term: 'fa' as const,
    year: 2026,
    slug: 'fa26',
    display_name: 'Fall 2026',
    filename_convention: 'hw{n}.zip',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy-path: insert chain (course → semester → user → membership)
// ---------------------------------------------------------------------------

describe('happy-path insertions', () => {
  it('inserts course, semester, user, membership in sequence', async () => {
    await withTestDb(async (db) => {
      // Course
      const [course] = await db.insert(courses).values(makeCourse()).returning();
      expect(course).toBeDefined();
      expect(course!.id).toBeTruthy();

      // Semester
      const [semester] = await db.insert(semesters).values(makeSemester(course!.id)).returning();
      expect(semester).toBeDefined();
      expect(semester!.id).toBeTruthy();

      // User
      const [user] = await db.insert(users).values(makeUser()).returning();
      expect(user).toBeDefined();
      expect(user!.id).toBeTruthy();

      // Granter (another user who granted the membership)
      const [granter] = await db.insert(users).values(makeUser()).returning();

      // Membership
      const [membership] = await db
        .insert(memberships)
        .values({
          user_id: user!.id,
          semester_id: semester!.id,
          role: 'grader',
          granted_by: granter!.id,
        })
        .returning();
      expect(membership).toBeDefined();
      expect(membership!.role).toBe('grader');
    });
  });
});

// ---------------------------------------------------------------------------
// FK constraint: membership with non-existent user_id must throw
// ---------------------------------------------------------------------------

describe('FK constraints', () => {
  it('rejects membership with non-existent user_id', async () => {
    await withTestDb(async (db) => {
      const [course] = await db.insert(courses).values(makeCourse()).returning();
      const [semester] = await db.insert(semesters).values(makeSemester(course!.id)).returning();
      const [granter] = await db.insert(users).values(makeUser()).returning();

      await expect(
        db.insert(memberships).values({
          user_id: crypto.randomUUID(), // does not exist
          semester_id: semester!.id,
          role: 'grader',
          granted_by: granter!.id,
        }),
      ).rejects.toThrow();
    });
  });

  it('rejects membership with non-existent semester_id', async () => {
    await withTestDb(async (db) => {
      const [user] = await db.insert(users).values(makeUser()).returning();
      const [granter] = await db.insert(users).values(makeUser()).returning();

      await expect(
        db.insert(memberships).values({
          user_id: user!.id,
          semester_id: crypto.randomUUID(), // does not exist
          role: 'admin',
          granted_by: granter!.id,
        }),
      ).rejects.toThrow();
    });
  });

  it('rejects semester with non-existent course_id', async () => {
    await withTestDb(async (db) => {
      await expect(
        db.insert(semesters).values(makeSemester(crypto.randomUUID())), // course doesn't exist
      ).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// CHECK constraints
// ---------------------------------------------------------------------------

describe('CHECK constraints — semesters', () => {
  it('rejects invalid term value', async () => {
    await withTestDb(async (db) => {
      const [course] = await db.insert(courses).values(makeCourse()).returning();
      await expect(
        db.insert(semesters).values(makeSemester(course!.id, { term: 'xx' })),
      ).rejects.toThrow();
    });
  });

  it('rejects year outside 2000–2100', async () => {
    await withTestDb(async (db) => {
      const [course] = await db.insert(courses).values(makeCourse()).returning();
      await expect(
        db.insert(semesters).values(makeSemester(course!.id, { year: 1999 })),
      ).rejects.toThrow();
      await expect(
        db.insert(semesters).values(makeSemester(course!.id, { year: 2101 })),
      ).rejects.toThrow();
    });
  });

  it('rejects blob_retention_days < 30', async () => {
    await withTestDb(async (db) => {
      const [course] = await db.insert(courses).values(makeCourse()).returning();
      await expect(
        db.insert(semesters).values(makeSemester(course!.id, { blob_retention_days: 29 })),
      ).rejects.toThrow();
    });
  });

  it('rejects derived_retention_days < blob_retention_days', async () => {
    await withTestDb(async (db) => {
      const [course] = await db.insert(courses).values(makeCourse()).returning();
      await expect(
        db.insert(semesters).values(
          makeSemester(course!.id, {
            blob_retention_days: 100,
            derived_retention_days: 50, // 50 < 100, should fail
          }),
        ),
      ).rejects.toThrow();
    });
  });
});

describe('CHECK constraints — memberships', () => {
  it('rejects invalid role', async () => {
    await withTestDb(async (db) => {
      const [course] = await db.insert(courses).values(makeCourse()).returning();
      const [semester] = await db.insert(semesters).values(makeSemester(course!.id)).returning();
      const [user] = await db.insert(users).values(makeUser()).returning();
      const [granter] = await db.insert(users).values(makeUser()).returning();

      await expect(
        db.insert(memberships).values({
          user_id: user!.id,
          semester_id: semester!.id,
          role: 'superuser', // invalid
          granted_by: granter!.id,
        }),
      ).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// pending_invitations partial unique index
// ---------------------------------------------------------------------------

describe('pending_invitations_unique_open partial unique index', () => {
  it('prevents two open invitations for the same email+semester', async () => {
    await withTestDb(async (db) => {
      const [course] = await db.insert(courses).values(makeCourse()).returning();
      const [semester] = await db.insert(semesters).values(makeSemester(course!.id)).returning();
      const [inviter] = await db.insert(users).values(makeUser()).returning();

      const invitation = {
        email: 'student@example.com',
        semester_id: semester!.id,
        role: 'grader' as const,
        invited_by: inviter!.id,
      };

      await db.insert(pending_invitations).values(invitation);

      // Second open invitation for the same email+semester should fail.
      await expect(db.insert(pending_invitations).values(invitation)).rejects.toThrow();
    });
  });

  it('allows a second invitation once the first is consumed (consumed_at set)', async () => {
    await withTestDb(async (db) => {
      const [course] = await db.insert(courses).values(makeCourse()).returning();
      const [semester] = await db.insert(semesters).values(makeSemester(course!.id)).returning();
      const [inviter] = await db.insert(users).values(makeUser()).returning();

      const invitationData = {
        email: 'student2@example.com',
        semester_id: semester!.id,
        role: 'grader' as const,
        invited_by: inviter!.id,
      };

      // Insert first invitation and mark it consumed.
      const [first] = await db.insert(pending_invitations).values(invitationData).returning();
      await db
        .update(pending_invitations)
        .set({ consumed_at: sql`now()` })
        .where(sql`id = ${first!.id}`);

      // Now a second open invitation for the same email+semester is allowed.
      await expect(db.insert(pending_invitations).values(invitationData)).resolves.not.toThrow();
    });
  });

  it('partial index is case-insensitive on email', async () => {
    await withTestDb(async (db) => {
      const [course] = await db.insert(courses).values(makeCourse()).returning();
      const [semester] = await db.insert(semesters).values(makeSemester(course!.id)).returning();
      const [inviter] = await db.insert(users).values(makeUser()).returning();

      await db.insert(pending_invitations).values({
        email: 'Student@Example.COM',
        semester_id: semester!.id,
        role: 'grader',
        invited_by: inviter!.id,
      });

      // Different case but same LOWER(email) — must conflict.
      await expect(
        db.insert(pending_invitations).values({
          email: 'student@example.com',
          semester_id: semester!.id,
          role: 'admin',
          invited_by: inviter!.id,
        }),
      ).rejects.toThrow();
    });
  });
});
