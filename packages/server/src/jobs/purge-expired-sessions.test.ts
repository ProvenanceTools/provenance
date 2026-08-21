/**
 * Integration tests for the purge-expired-sessions cron job (Phase 25).
 *
 * Tests:
 *   1. Happy path: expired sessions are deleted; non-expired sessions survive.
 *   2. Already-clean table: no rows deleted when all sessions are still valid.
 *   3. All-expired: all sessions deleted.
 *   4. Returned count matches the number of deleted rows.
 *
 * Uses withTestDb (testcontainers) for real Postgres.
 */

import { vi, describe, it, expect } from 'vitest';

// Mock the logging module so tests don't require a fully-configured env singleton.
vi.mock('../logging.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

import { withTestDb } from '../../test/helpers/db.js';
import { runPurgeExpiredSessions } from './purge-expired-sessions.js';
import { users, sessions } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(db: Parameters<Parameters<typeof withTestDb>[0]>[0]): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      google_subject: `sub-${Math.random()}`,
      email: `u${Math.random()}@b.edu`,
      display_name: 'U',
    })
    .returning({ id: users.id });
  return rows[0]!.id;
}

/**
 * Insert a session with a configurable expires_at offset from now.
 *
 * @param offsetMs  Positive = future (not expired), negative = past (expired).
 */
async function seedSession(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  userId: string,
  offsetMs: number,
): Promise<string> {
  const expiresAt = new Date(Date.now() + offsetMs);
  const rows = await db
    .insert(sessions)
    .values({ id: `sess-${Math.random()}`, user_id: userId, expires_at: expiresAt })
    .returning({ id: sessions.id });
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPurgeExpiredSessions', () => {
  it('deletes expired sessions and preserves non-expired sessions', async () => {
    await withTestDb(async (db) => {
      const userId = await seedUser(db);

      // Expired: 1 hour ago.
      const expiredId1 = await seedSession(db, userId, -60 * 60 * 1000);
      // Expired: 2 days ago.
      const expiredId2 = await seedSession(db, userId, -2 * 24 * 60 * 60 * 1000);
      // Not expired: 1 hour in the future.
      const validId = await seedSession(db, userId, 60 * 60 * 1000);

      const result = await runPurgeExpiredSessions(db);

      expect(result.purged).toBe(2);

      // Expired sessions must be gone.
      const expiredRows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(sql`${sessions.id} IN (${expiredId1}, ${expiredId2})`);
      expect(expiredRows).toHaveLength(0);

      // Non-expired session must survive.
      const validRows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, validId));
      expect(validRows).toHaveLength(1);
    });
  });

  it('purges 0 when all sessions are still valid', async () => {
    await withTestDb(async (db) => {
      const userId = await seedUser(db);
      await seedSession(db, userId, 24 * 60 * 60 * 1000);
      await seedSession(db, userId, 7 * 24 * 60 * 60 * 1000);

      const result = await runPurgeExpiredSessions(db);
      expect(result.purged).toBe(0);
    });
  });

  it('purges all sessions when all are expired', async () => {
    await withTestDb(async (db) => {
      const userId = await seedUser(db);
      await seedSession(db, userId, -1 * 60 * 1000);
      await seedSession(db, userId, -2 * 60 * 1000);
      await seedSession(db, userId, -3 * 60 * 1000);

      const result = await runPurgeExpiredSessions(db);
      expect(result.purged).toBe(3);

      const remaining = await db.select({ id: sessions.id }).from(sessions);
      expect(remaining).toHaveLength(0);
    });
  });

  it('is idempotent — second run returns 0 purged', async () => {
    await withTestDb(async (db) => {
      const userId = await seedUser(db);
      await seedSession(db, userId, -60 * 1000);

      const first = await runPurgeExpiredSessions(db);
      expect(first.purged).toBe(1);

      const second = await runPurgeExpiredSessions(db);
      expect(second.purged).toBe(0);
    });
  });
});
