/**
 * Integration smoke — GET /api/v1/me/tokens reachable through createV1App().
 *
 * This test exists to catch the class of bug where the sub-router is implemented
 * and unit-tested in isolation but never actually mounted in the v1 app. It
 * constructs the full v1 app (createV1App) wrapped with authSessionMiddleware,
 * then exercises the /me/tokens endpoint end-to-end with a real bearer token and
 * a real (testcontainers) Postgres database.
 *
 * Without this test, a missing app.route('/me/tokens', ...) call is invisible to
 * unit tests of the sub-router.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { withTestDb } from '../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../config/index.js';
import { _resetLoggerForTest } from '../../logging.js';
import { parseEnv } from '../../config/env.js';
import { createV1App } from './index.js';
import { authSessionMiddleware } from '../middleware/auth-session.js';
import { users } from '../../db/schema.js';
import { createToken } from '../../auth/tokens.js';
import type { DrizzleDb } from '../../db/client.js';

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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-me-tokens-integration-abcd',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// DB injection
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

/**
 * Builds the full v1 app with authSessionMiddleware mounted ahead of all routes.
 * This is the production-like wiring: middleware runs before routes, sets
 * c.var.principal, and routes call requirePrincipal(c) to enforce auth.
 *
 * The onError handler converts thrown Response objects (from requirePrincipal)
 * into actual HTTP responses that app.fetch() resolves with rather than rejects.
 */
function makeFullV1App(): Hono {
  const app = new Hono();
  // authSessionMiddleware resolves bearer/session principal and sets c.var.principal.
  app.use('*', authSessionMiddleware);
  app.route('/', createV1App());
  // requirePrincipal throws a Response when auth is missing.
  // Hono's onError must return it so app.fetch() resolves (not rejects).
  app.onError((err, _c) => {
    if (err instanceof Response) return err;
    throw err;
  });
  return app;
}

async function insertUser(db: DrizzleDb) {
  const rows = await db
    .insert(users)
    .values({
      google_subject: `sub-${Math.random()}`,
      email: 'integration-test@berkeley.edu',
      display_name: 'Integration Test User',
      is_superadmin: false,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('User insert returned no rows');
  return row;
}

// ---------------------------------------------------------------------------
// Integration smoke
// ---------------------------------------------------------------------------

describe('GET /me/tokens — integration smoke through createV1App()', () => {
  it('returns 200 + token list when authenticated via bearer token', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);

        // Create a token for this user (will show up in the list)
        const { secret, token: created } = await createToken(db, {
          userId: user.id,
          label: 'Smoke Test Token',
        });

        const app = makeFullV1App();

        // Hit the full v1 route via createV1App(); this would return 404 if
        // /me/tokens were not mounted.
        const res = await app.fetch(
          new Request('http://localhost/me/tokens', {
            headers: { Authorization: `Bearer ${secret}` },
          }),
        );

        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.tokens).toBeDefined();
        expect(Array.isArray(body.tokens)).toBe(true);
        expect(body.tokens.length).toBe(1);
        expect(body.tokens[0].id).toBe(created.id);
        expect(body.tokens[0].label).toBe('Smoke Test Token');
        // Secret must never appear in the list response.
        expect(body.tokens[0]).not.toHaveProperty('hashed_token');
        expect(JSON.stringify(body)).not.toContain(secret);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 401 AUTH_REQUIRED when unauthenticated', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const app = makeFullV1App();
        // requirePrincipal throws a Response when no principal is set.
        // In Hono, a thrown Response from a nested sub-router's handler rejects
        // the fetch() promise rather than resolving it. We catch it here and
        // assert its status to confirm the auth guard is in place.
        let res: Response;
        try {
          res = await app.fetch(new Request('http://localhost/me/tokens'));
        } catch (err) {
          if (err instanceof Response) {
            res = err;
          } else {
            throw err;
          }
        }
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error.code).toBe('AUTH_REQUIRED');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 401 with WWW-Authenticate: Bearer on malformed bearer header', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const app = makeFullV1App();
        const res = await app.fetch(
          new Request('http://localhost/me/tokens', {
            headers: { Authorization: 'Invalid notabearer' },
          }),
        );
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
      } finally {
        _testDb = null;
      }
    });
  });
});
