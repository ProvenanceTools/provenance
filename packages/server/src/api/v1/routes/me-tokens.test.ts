/**
 * API token CRUD endpoint tests.
 *
 * Note: These tests focus on the business logic of the endpoints.
 * Auth middleware (requirePrincipal) is tested separately in auth-resolve.test.ts.
 * We test these endpoints with injected principals via middleware.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createMeTokensRouter } from './me-tokens.js';
import { users } from '../../../db/schema.js';
import { createToken } from '../../../auth/tokens.js';
import type { DrizzleDb } from '../../../db/client.js';
import type { Principal } from '../../middleware/auth-session.js';

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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-tokens-1234567890abcd',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// DB injection via vi.mock
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
// Helpers
// ---------------------------------------------------------------------------

function makeMeTokensApp(principal: Principal | null): Hono {
  const app = new Hono();
  // Middleware: inject the principal
  app.use('*', async (c, next) => {
    c.set('principal', principal);
    await next();
  });
  app.route('/', createMeTokensRouter());
  // Error handler: catch thrown Responses (from requirePrincipal)
  app.onError((err, _c) => {
    if (err instanceof Response) {
      return err;
    }
    throw err;
  });
  return app;
}

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
// GET /me/tokens
// ---------------------------------------------------------------------------

describe('GET /me/tokens', () => {
  it('returns list with single token', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const { token: created } = await createToken(db, {
          userId: user.id,
          label: 'Some Token',
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const principal: Principal = { principal_kind: 'session', user, session: {} as any };
        const app = makeMeTokensApp(principal);
        const res = await app.fetch(new Request('http://localhost/'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.tokens).toBeDefined();
        expect(body.tokens.length).toBe(1);
        expect(body.tokens[0].label).toBe('Some Token');
        expect(body.tokens[0].prefix).toBe(created.prefix);
        expect(body.tokens[0]).not.toHaveProperty('hashed_token');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns list of tokens sorted by created_at DESC (newest first)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);

        await createToken(db, {
          userId: user.id,
          label: 'First Token',
        });
        // Small delay to ensure different timestamps
        await new Promise((r) => setTimeout(r, 50));
        await createToken(db, {
          userId: user.id,
          label: 'Second Token',
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const principal: Principal = { principal_kind: 'session', user, session: {} as any };
        const app = makeMeTokensApp(principal);
        const res = await app.fetch(new Request('http://localhost/'));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.tokens.length).toBe(2);
        // The route sorts by created_at DESC, so newest first
        expect(body.tokens[0].label).toBe('Second Token');
        expect(body.tokens[1].label).toBe('First Token');
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// POST /me/tokens
// ---------------------------------------------------------------------------

describe('POST /me/tokens', () => {
  it('creates a token and returns secret once', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const principal: Principal = { principal_kind: 'session', user, session: {} as any };
        const app = makeMeTokensApp(principal);

        const res = await app.fetch(
          new Request('http://localhost/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              label: 'New Token',
              scopes: {
                read_only: true,
              },
            }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();

        expect(body.token).toBeTruthy();
        expect(body.token.label).toBe('New Token');
        expect(body.token.scopes.read_only).toBe(true);

        expect(body.secret).toBeTruthy();
        expect(body.secret).toMatch(/^prov_/);

        // The secret should not be in the token summary
        expect(body.token).not.toHaveProperty('hashed_token');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 400 for invalid request body', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const principal: Principal = { principal_kind: 'session', user, session: {} as any };
        const app = makeMeTokensApp(principal);

        const res = await app.fetch(
          new Request('http://localhost/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              // missing label
              scopes: { read_only: true },
            }),
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

  it('applies scope defaults', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const principal: Principal = { principal_kind: 'session', user, session: {} as any };
        const app = makeMeTokensApp(principal);

        const res = await app.fetch(
          new Request('http://localhost/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              label: 'Defaults Token',
            }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.token.scopes).toEqual({
          read_only: false,
          semester_ids: null,
          include_blobs: false,
        });
      } finally {
        _testDb = null;
      }
    });
  });

  it('respects expires_at if provided', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const principal: Principal = { principal_kind: 'session', user, session: {} as any };
        const app = makeMeTokensApp(principal);

        const res = await app.fetch(
          new Request('http://localhost/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              label: 'Expiring Token',
              expires_at: futureDate.toISOString(),
            }),
          }),
        );

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.token.expires_at).toBeTruthy();
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /me/tokens/:id
// ---------------------------------------------------------------------------

describe('DELETE /me/tokens/:id', () => {
  it("revokes a user's own token", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const { token: toDelete } = await createToken(db, {
          userId: user.id,
          label: 'Token to Delete',
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const principal: Principal = { principal_kind: 'session', user, session: {} as any };
        const app = makeMeTokensApp(principal);
        const res = await app.fetch(
          new Request(`http://localhost/${toDelete.id}`, {
            method: 'DELETE',
          }),
        );

        expect(res.status).toBe(204);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 404 for token not belonging to user', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user1 = await insertUser(db, { email: 'user1@berkeley.edu' });
        const user2 = await insertUser(db, { email: 'user2@berkeley.edu' });

        const { token: user2Token } = await createToken(db, {
          userId: user2.id,
          label: 'User2 Token',
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const principal: Principal = { principal_kind: 'session', user: user1, session: {} as any };
        const app = makeMeTokensApp(principal);

        // User1 tries to delete User2's token
        const res = await app.fetch(
          new Request(`http://localhost/${user2Token.id}`, {
            method: 'DELETE',
          }),
        );

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error.code).toBe('NOT_FOUND');
      } finally {
        _testDb = null;
      }
    });
  });

  it('is idempotent — revoking an already-revoked token returns 204', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const { token: toDelete } = await createToken(db, {
          userId: user.id,
          label: 'Token to Delete',
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const principal: Principal = { principal_kind: 'session', user, session: {} as any };
        const app = makeMeTokensApp(principal);

        // Delete once
        const res1 = await app.fetch(
          new Request(`http://localhost/${toDelete.id}`, {
            method: 'DELETE',
          }),
        );
        expect(res1.status).toBe(204);

        // Delete again (should still return 204, idempotent)
        const res2 = await app.fetch(
          new Request(`http://localhost/${toDelete.id}`, {
            method: 'DELETE',
          }),
        );
        expect(res2.status).toBe(204);
      } finally {
        _testDb = null;
      }
    });
  });
});
