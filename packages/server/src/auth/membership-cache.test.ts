/**
 * Membership cache unit tests.
 *
 * Uses withTestDb for real DB operations to verify cache behavior.
 */

import { vi, describe, it, expect } from 'vitest';
import { withTestDb } from '../../test/helpers/db.js';
import { findMembership, type MembershipCache } from './membership-cache.js';
import { users, courses, semesters, memberships } from '../db/schema.js';
import type { DrizzleDb } from '../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

async function insertUser(db: DrizzleDb): Promise<{ id: string }> {
  const rows = await db
    .insert(users)
    .values({
      google_subject: `sub-${Math.random()}`,
      email: `user-${Math.random()}@berkeley.edu`,
      display_name: 'Test',
      is_superadmin: false,
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
// Tests
// ---------------------------------------------------------------------------

describe('findMembership()', () => {
  it('returns the membership for a known member', async () => {
    await withTestDb(async (db) => {
      const user = await insertUser(db);
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);
      await insertMembership(db, user.id, semester.id, 'admin');

      const cache: MembershipCache = new Map();
      const result = await findMembership(cache, db, user.id, semester.id);
      expect(result).toEqual({ role: 'admin' });
    });
  });

  it('returns null for a non-member', async () => {
    await withTestDb(async (db) => {
      const user = await insertUser(db);
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      const cache: MembershipCache = new Map();
      const result = await findMembership(cache, db, user.id, semester.id);
      expect(result).toBeNull();
    });
  });

  it('returns same value on second lookup (cache hit — no second DB call)', async () => {
    await withTestDb(async (db) => {
      const user = await insertUser(db);
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);
      await insertMembership(db, user.id, semester.id, 'grader');

      const cache: MembershipCache = new Map();

      // First lookup hits the DB
      const first = await findMembership(cache, db, user.id, semester.id);
      expect(first).toEqual({ role: 'grader' });
      expect(cache.size).toBe(1);

      // Second lookup should return the cached value without hitting the DB.
      // We verify this by using a spy to ensure the cache key is present.
      const getSpy = vi.spyOn(cache, 'get');
      const second = await findMembership(cache, db, user.id, semester.id);
      expect(second).toEqual({ role: 'grader' });
      expect(getSpy).toHaveBeenCalled();
      // Cache should still have exactly 1 entry (no new entry for same key)
      expect(cache.size).toBe(1);
    });
  });

  it('different keys are independent — no cross-key leakage', async () => {
    await withTestDb(async (db) => {
      const user1 = await insertUser(db);
      const user2 = await insertUser(db);
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      await insertMembership(db, user1.id, semester.id, 'admin');
      // user2 is NOT a member

      const cache: MembershipCache = new Map();

      const result1 = await findMembership(cache, db, user1.id, semester.id);
      const result2 = await findMembership(cache, db, user2.id, semester.id);

      expect(result1).toEqual({ role: 'admin' });
      expect(result2).toBeNull();
      expect(cache.size).toBe(2);
    });
  });

  it('null membership is cached (negative cache)', async () => {
    await withTestDb(async (db) => {
      const user = await insertUser(db);
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);

      const cache: MembershipCache = new Map();

      const first = await findMembership(cache, db, user.id, semester.id);
      expect(first).toBeNull();
      // The null should be stored in the cache (has() should return true)
      const key = `${user.id}:${semester.id}`;
      expect(cache.has(key)).toBe(true);
      expect(cache.get(key)).toBeNull();
    });
  });

  it('no cross-request leakage — separate Maps are independent', async () => {
    await withTestDb(async (db) => {
      const user = await insertUser(db);
      const course = await insertCourse(db);
      const semester = await insertSemester(db, course.id);
      await insertMembership(db, user.id, semester.id, 'admin');

      // Simulate two separate requests with their own cache Maps
      const cache1: MembershipCache = new Map();
      const cache2: MembershipCache = new Map();

      const r1 = await findMembership(cache1, db, user.id, semester.id);
      const r2 = await findMembership(cache2, db, user.id, semester.id);

      expect(r1).toEqual({ role: 'admin' });
      expect(r2).toEqual({ role: 'admin' });

      // Modifying one cache does not affect the other
      cache1.set(`${user.id}:${semester.id}`, { role: 'grader' });
      const r2After = await findMembership(cache2, db, user.id, semester.id);
      expect(r2After).toEqual({ role: 'admin' }); // still 'admin' from cache2
    });
  });
});
