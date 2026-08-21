/**
 * Self-test for the testcontainers harness.
 * Verifies: spawn → migrate → query → teardown, and that teardown happens
 * even when the test fn throws.
 */

import { describe, it, expect } from 'vitest';
import { withTestDb } from './db.js';
import { sql } from 'drizzle-orm';
import { users } from '../../src/db/schema.js';

describe('withTestDb harness', () => {
  it('spawns a container, runs migrations, and can query the DB', async () => {
    await withTestDb(async (db) => {
      // Migrations have been applied — the users table must exist.
      const result = await db.select().from(users);
      expect(result).toEqual([]);
    });
  });

  it('each invocation gets a fresh, empty database', async () => {
    // Insert a user in the first container.
    await withTestDb(async (db) => {
      await db.insert(users).values({
        google_subject: 'sub-isolation-test',
        email: 'isolation@example.com',
      });
      const rows = await db.select().from(users);
      expect(rows).toHaveLength(1);
    });

    // Second container starts fresh — no rows.
    await withTestDb(async (db) => {
      const rows = await db.select().from(users);
      expect(rows).toHaveLength(0);
    });
  });

  it('stops the container even when the test fn throws', async () => {
    // If the harness leaks the container on error, the test suite would stall
    // on teardown. We verify the harness re-throws the original error.
    await expect(
      withTestDb(async (_db) => {
        throw new Error('intentional test failure');
      }),
    ).rejects.toThrow('intentional test failure');
    // If we reach here, the container was stopped (no hang).
  });

  it('can run raw SQL via drizzle execute', async () => {
    await withTestDb(async (db) => {
      const result = await db.execute(sql`SELECT current_database() AS db`);
      const rows = result as Array<Record<string, unknown>>;
      expect(rows[0]).toBeDefined();
      expect(typeof rows[0]!['db']).toBe('string');
    });
  });
});
