/**
 * Auth resolution middleware tests — precedence handling.
 *
 * Tests the ResolveResult sum type:
 *   - { kind: 'ok', principal }   — authenticated.
 *   - { kind: 'none' }            — no credentials offered.
 *   - { kind: 'invalid_bearer' }  — Bearer was offered but malformed or invalid.
 */

import { vi, describe, it, expect } from 'vitest';
import { withTestDb } from '../../../test/helpers/db.js';
import { resolvePrincipal } from './auth-resolve.js';
import { createToken } from '../../auth/tokens.js';
import { createSession, sessionExpiresAt } from '../../auth/sessions.js';
import { users } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Mock DB setup
// ---------------------------------------------------------------------------

let _testDb: DrizzleDb | null = null;

vi.mock('../../db/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../db/client.js')>();
  return {
    ...original,
    getDb: () => {
      if (_testDb !== null) return _testDb;
      return original.getDb();
    },
  };
});

// ---------------------------------------------------------------------------
// Mock cookies helper
// ---------------------------------------------------------------------------

let _mockSessionCookie: string | undefined;

vi.mock('../../auth/cookies.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../auth/cookies.js')>();

  return {
    ...original,
    // Mock implementation of getSessionCookie: ignores the context parameter
    // and returns the test-injected session cookie value
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSessionCookie: (_c: any) => _mockSessionCookie,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertUser(db: DrizzleDb, overrides?: Partial<typeof users.$inferInsert>) {
  const rows = await db
    .insert(users)
    .values({
      google_subject: `sub-${Math.random()}`,
      email: 'test@berkeley.edu',
      display_name: 'Test User',
      is_superadmin: false,
      ...overrides,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('User insert returned no rows');
  return row;
}

function createMockContext(authHeader?: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: any = {
    req: {
      header: (name: string) => {
        if (name === 'authorization') return authHeader;
        return undefined;
      },
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolvePrincipal — precedence', () => {
  it('uses bearer token when Authorization header is present and valid', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const { secret } = await createToken(db, {
          userId: user.id,
          label: 'Test Token',
        });

        const ctx = createMockContext(`Bearer ${secret}`);
        const result = await resolvePrincipal(ctx);

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') throw new Error('Expected ok');
        expect(result.principal.principal_kind).toBe('token');
        expect(result.principal.user.id).toBe(user.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns invalid_bearer for malformed Authorization header (no fallback to session)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const sessionId = await createSession(db, {
          userId: user.id,
          expiresAt: sessionExpiresAt(14),
        });

        // Malformed header (not "Bearer <token>")
        const ctx = createMockContext('Invalid xyz');

        // Set the mock session cookie — must NOT be used when bearer header is present
        _mockSessionCookie = sessionId;

        const result = await resolvePrincipal(ctx);

        // Bearer header was present but malformed → invalid_bearer, no session fallback.
        expect(result.kind).toBe('invalid_bearer');
      } finally {
        _testDb = null;
        _mockSessionCookie = undefined;
      }
    });
  });

  it('returns invalid_bearer for invalid bearer token (no fallback to session)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const sessionId = await createSession(db, {
          userId: user.id,
          expiresAt: sessionExpiresAt(14),
        });

        const ctx = createMockContext('Bearer prov_badprefix_wrongsecret');

        // Set the mock session cookie — must NOT be used when bearer header is present
        _mockSessionCookie = sessionId;

        const result = await resolvePrincipal(ctx);

        // Header was well-formed but token invalid → invalid_bearer, no session fallback.
        expect(result.kind).toBe('invalid_bearer');
      } finally {
        _testDb = null;
        _mockSessionCookie = undefined;
      }
    });
  });

  it('uses session cookie when Authorization header is absent', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const sessionId = await createSession(db, {
          userId: user.id,
          expiresAt: sessionExpiresAt(14),
        });

        const ctx = createMockContext(); // No Authorization header

        // Set the mock session cookie
        _mockSessionCookie = sessionId;

        const result = await resolvePrincipal(ctx);

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') throw new Error('Expected ok');
        expect(result.principal.principal_kind).toBe('session');
        expect(result.principal.user.id).toBe(user.id);
      } finally {
        _testDb = null;
        _mockSessionCookie = undefined;
      }
    });
  });

  it('returns none when neither bearer nor session is present', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const ctx = createMockContext(); // No Authorization header

        // No session cookie
        _mockSessionCookie = undefined;

        const result = await resolvePrincipal(ctx);

        expect(result.kind).toBe('none');
      } finally {
        _testDb = null;
        _mockSessionCookie = undefined;
      }
    });
  });

  it('bearer token takes precedence over session cookie when both present', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user1 = await insertUser(db, { email: 'user1@berkeley.edu' });
        const user2 = await insertUser(db, { email: 'user2@berkeley.edu' });

        // Create a token for user1
        const { secret: token1 } = await createToken(db, {
          userId: user1.id,
          label: 'Token for User1',
        });

        // Create a session for user2
        const sessionId = await createSession(db, {
          userId: user2.id,
          expiresAt: sessionExpiresAt(14),
        });

        const ctx = createMockContext(`Bearer ${token1}`);

        // Set the mock session cookie
        _mockSessionCookie = sessionId;

        const result = await resolvePrincipal(ctx);

        // Should use the bearer token (user1), not the session (user2)
        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') throw new Error('Expected ok');
        expect(result.principal.principal_kind).toBe('token');
        expect(result.principal.user.id).toBe(user1.id);
        expect(result.principal.user.email).toBe('user1@berkeley.edu');
      } finally {
        _testDb = null;
        _mockSessionCookie = undefined;
      }
    });
  });
});
