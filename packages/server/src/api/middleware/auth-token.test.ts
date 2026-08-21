/**
 * Bearer token middleware integration tests.
 */

import { vi, describe, it, expect } from 'vitest';
import { withTestDb } from '../../../test/helpers/db.js';
import { parseBearerHeader, resolveBearerTokenPrincipal } from './auth-token.js';
import { createToken, revokeToken } from '../../auth/tokens.js';
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

// ---------------------------------------------------------------------------
// parseBearerHeader
// ---------------------------------------------------------------------------

describe('parseBearerHeader', () => {
  it('extracts token from valid Authorization header', () => {
    const token = parseBearerHeader('Bearer prov_abcd1234_xyz789');
    expect(token).toBe('prov_abcd1234_xyz789');
  });

  it('is case-insensitive for "Bearer"', () => {
    const token = parseBearerHeader('bearer prov_abcd1234_xyz789');
    expect(token).toBe('prov_abcd1234_xyz789');
  });

  it('returns null for missing header', () => {
    const token = parseBearerHeader(undefined);
    expect(token).toBeNull();
  });

  it('returns null for malformed header', () => {
    expect(parseBearerHeader('Basic xyz')).toBeNull();
    expect(parseBearerHeader('prov_token')).toBeNull();
  });

  it('returns null for double-space between Bearer and token (exact-one-space rule)', () => {
    // "Bearer  prov_xxx" (two spaces) must be rejected as malformed, not silently
    // extracted with a leading space that downstream code then quietly rejects.
    const result = parseBearerHeader('Bearer  prov_abcd1234_xyz789');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveBearerTokenPrincipal
// ---------------------------------------------------------------------------

describe('resolveBearerTokenPrincipal', () => {
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

  it('resolves a valid token and returns principal with kind=token', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const { secret, token: created } = await createToken(db, {
          userId: user.id,
          label: 'Test Token',
        });

        const ctx = createMockContext(`Bearer ${secret}`);
        const principal = await resolveBearerTokenPrincipal(ctx);

        expect(principal).not.toBeNull();
        expect(principal!.principal_kind).toBe('token');
        expect(principal!.user.id).toBe(user.id);
        expect(principal!.user.email).toBe('test@berkeley.edu');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((principal as any).token.id).toBe(created.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns null for missing Authorization header', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const ctx = createMockContext();
        const principal = await resolveBearerTokenPrincipal(ctx);
        expect(principal).toBeNull();
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns null for token prefix not found in DB', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const ctx = createMockContext('Bearer prov_unknown_secret');
        const principal = await resolveBearerTokenPrincipal(ctx);
        expect(principal).toBeNull();
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns null for token with wrong secret', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const { token: created } = await createToken(db, {
          userId: user.id,
          label: 'Test Token',
        });

        const ctx = createMockContext(`Bearer prov_${created.prefix}_wrongsecret`);
        const principal = await resolveBearerTokenPrincipal(ctx);
        expect(principal).toBeNull();
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns null for revoked token', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const { secret, token: created } = await createToken(db, {
          userId: user.id,
          label: 'Test Token',
        });

        await revokeToken(db, created.id);

        const ctx = createMockContext(`Bearer ${secret}`);
        const principal = await resolveBearerTokenPrincipal(ctx);
        expect(principal).toBeNull();
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns null for expired token', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const pastDate = new Date(Date.now() - 1000);
        const { secret } = await createToken(db, {
          userId: user.id,
          label: 'Expired Token',
          expiresAt: pastDate,
        });

        const ctx = createMockContext(`Bearer ${secret}`);
        const principal = await resolveBearerTokenPrincipal(ctx);
        expect(principal).toBeNull();
      } finally {
        _testDb = null;
      }
    });
  });

  it('updates last_used_at on successful verification', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const { secret, token: created } = await createToken(db, {
          userId: user.id,
          label: 'Test Token',
        });

        expect(created.last_used_at).toBeNull();

        const ctx = createMockContext(`Bearer ${secret}`);
        await resolveBearerTokenPrincipal(ctx);

        // Small delay to allow async update
        await new Promise((r) => setTimeout(r, 100));

        // Fetch the token to verify last_used_at was updated
        const { findTokenByPrefix } = await import('../../auth/tokens.js');
        const updated = await findTokenByPrefix(db, created.prefix);
        expect(updated!.last_used_at).not.toBeNull();
        // Allow 500ms tolerance for async update and DB latency
        expect(updated!.last_used_at!.getTime()).toBeGreaterThan(Date.now() - 500);
      } finally {
        _testDb = null;
      }
    });
  });
});
