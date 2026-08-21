/**
 * Integration test for the db client factory.
 * Requires Docker (testcontainers).
 *
 * Integration tests that spawn containers can take a while.
 */

import { describe, it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db.js';
import { withTransaction } from './client.js';
import { courses } from './schema.js';

// testcontainers needs a long startup budget
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('createDb / withTestDb', () => {
  it('connects and executes SELECT 1', async () => {
    await withTestDb(async (db) => {
      const result = await db.execute(sql`SELECT 1 AS val`);
      // postgres.js returns an array of row objects.
      const rows = result as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBeDefined();
      expect(rows[0]!['val']).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// withTransaction tests
// ---------------------------------------------------------------------------

describe('withTransaction', () => {
  it('commits and makes inserted row visible after transaction returns', async () => {
    await withTestDb(async (db) => {
      const courseName = `Committed Course ${crypto.randomUUID()}`;
      const courseSlug = `course-${crypto.randomUUID()}`;

      // Insert inside transaction
      await withTransaction(db, async (tx) => {
        await tx.insert(courses).values({
          name: courseName,
          slug: courseSlug,
        });
      });

      // Row should be visible after transaction returns
      const inserted = await db
        .select()
        .from(courses)
        .where(sql`name = ${courseName}`);

      expect(inserted).toHaveLength(1);
      expect(inserted[0]!.name).toBe(courseName);
    });
  });

  it('rolls back on error and propagates thrown exception', async () => {
    await withTestDb(async (db) => {
      const courseName = `Rolled Back Course ${crypto.randomUUID()}`;
      const courseSlug = `course-${crypto.randomUUID()}`;

      // Transaction should throw and roll back
      const testError = new Error('Intentional test error');
      await expect(
        withTransaction(db, async (tx) => {
          await tx.insert(courses).values({
            name: courseName,
            slug: courseSlug,
          });
          throw testError;
        }),
      ).rejects.toThrow('Intentional test error');

      // Row should not exist (rolled back)
      const notInserted = await db
        .select()
        .from(courses)
        .where(sql`name = ${courseName}`);

      expect(notInserted).toHaveLength(0);
    });
  });

  it('transaction-scoped handle participates in transaction rollback on error', async () => {
    await withTestDb(async (db) => {
      const courseName = `Scoped Handle Test ${crypto.randomUUID()}`;
      const courseSlug = `course-${crypto.randomUUID()}`;

      // Write through the tx handle (not db) and verify it rolls back
      await expect(
        withTransaction(db, async (tx) => {
          // This write goes through the tx handle
          const [inserted] = await tx
            .insert(courses)
            .values({
              name: courseName,
              slug: courseSlug,
            })
            .returning();

          // Verify it exists within the transaction
          expect(inserted).toBeDefined();
          expect(inserted!.name).toBe(courseName);

          // Now throw to trigger rollback
          throw new Error('Rolling back tx-scoped writes');
        }),
      ).rejects.toThrow('Rolling back tx-scoped writes');

      // Verify the write was rolled back globally
      const afterRollback = await db
        .select()
        .from(courses)
        .where(sql`name = ${courseName}`);

      expect(afterRollback).toHaveLength(0);
    });
  });
});
