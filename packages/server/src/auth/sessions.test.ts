/**
 * Session storage integration tests.
 *
 * Uses withTestDb (testcontainers) for fully isolated DB per test.
 */

import { vi, describe, it, expect } from 'vitest';
import { withTestDb } from '../../test/helpers/db.js';
import {
  generateSessionId,
  createSession,
  findSession,
  deleteSession,
  extendSession,
  sessionExpiresAt,
} from './sessions.js';
import { users } from '../db/schema.js';

// Integration tests need extended timeout for testcontainers.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a test user and returns its id. */
async function insertTestUser(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
): Promise<string> {
  const inserted = await db
    .insert(users)
    .values({
      google_subject: `sub-${Math.random()}`,
      email: 'test@berkeley.edu',
      display_name: 'Test User',
    })
    .returning({ id: users.id });
  const row = inserted[0];
  if (row === undefined) throw new Error('User insert returned no rows');
  return row.id;
}

// ---------------------------------------------------------------------------
// generateSessionId
// ---------------------------------------------------------------------------

describe('generateSessionId', () => {
  it('returns a 43-character base64url string', () => {
    const id = generateSessionId();
    expect(id).toHaveLength(43);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique values each call', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateSessionId()));
    expect(ids.size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// sessionExpiresAt
// ---------------------------------------------------------------------------

describe('sessionExpiresAt', () => {
  it('returns a date approximately N days in the future', () => {
    const before = Date.now();
    const d = sessionExpiresAt(14);
    const after = Date.now();
    const diffMs = d.getTime() - before;
    const expectedMs = 14 * 24 * 60 * 60 * 1000;
    expect(diffMs).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(diffMs).toBeLessThanOrEqual(expectedMs + (after - before) + 1000);
  });
});

// ---------------------------------------------------------------------------
// createSession + findSession round trip
// ---------------------------------------------------------------------------

describe('createSession / findSession', () => {
  it('creates a session and finds it by id', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const expiresAt = sessionExpiresAt(14);

      const sessionId = await createSession(db, {
        userId,
        expiresAt,
        ip: '127.0.0.1',
        userAgent: 'vitest/1.0',
      });

      expect(sessionId).toHaveLength(43);

      const found = await findSession(db, sessionId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(sessionId);
      expect(found!.user_id).toBe(userId);
      expect(found!.ip).toBe('127.0.0.1');
      expect(found!.user_agent).toBe('vitest/1.0');
    });
  });

  it('returns null for an unknown session id', async () => {
    await withTestDb(async (db) => {
      const found = await findSession(db, generateSessionId());
      expect(found).toBeNull();
    });
  });

  it('accepts null ip and userAgent', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const sessionId = await createSession(db, {
        userId,
        expiresAt: sessionExpiresAt(14),
        ip: null,
        userAgent: null,
      });
      const found = await findSession(db, sessionId);
      expect(found!.ip).toBeNull();
      expect(found!.user_agent).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Expired session not returned
// ---------------------------------------------------------------------------

describe('findSession — expired session', () => {
  it('does not return an expired session', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      // expires 1 second in the past
      const pastDate = new Date(Date.now() - 1000);

      const sessionId = await createSession(db, {
        userId,
        expiresAt: pastDate,
      });

      const found = await findSession(db, sessionId);
      expect(found).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe('deleteSession', () => {
  it('removes the session row', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const sessionId = await createSession(db, {
        userId,
        expiresAt: sessionExpiresAt(14),
      });

      await deleteSession(db, sessionId);

      const found = await findSession(db, sessionId);
      expect(found).toBeNull();
    });
  });

  it('no-ops for a non-existent session id', async () => {
    await withTestDb(async (db) => {
      // Should not throw.
      await expect(deleteSession(db, generateSessionId())).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// extendSession
// ---------------------------------------------------------------------------

describe('extendSession', () => {
  it('bumps expires_at and last_seen_at', async () => {
    await withTestDb(async (db) => {
      const userId = await insertTestUser(db);
      const originalExpiry = sessionExpiresAt(7);

      const sessionId = await createSession(db, {
        userId,
        expiresAt: originalExpiry,
      });

      // Small sleep to ensure last_seen_at changes.
      await new Promise((r) => setTimeout(r, 50));

      const newExpiry = sessionExpiresAt(14);
      await extendSession(db, sessionId, newExpiry);

      const found = await findSession(db, sessionId);
      expect(found).not.toBeNull();
      // expires_at should now be ~14 days out, not ~7.
      expect(found!.expires_at.getTime()).toBeGreaterThan(originalExpiry.getTime());
      // last_seen_at should be recent.
      const ageMsLastSeen = Date.now() - found!.last_seen_at.getTime();
      expect(ageMsLastSeen).toBeLessThan(5000);
    });
  });
});
