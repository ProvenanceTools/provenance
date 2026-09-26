/**
 * Error formatter middleware tests.
 *
 * Uses a minimal Hono app to test the error handler in realistic conditions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError } from '../v1/errors.js';
import { errorFormatter } from './error.js';
import { requestId } from './request-id.js';
import { _resetConfigForTest, _setConfigForTest } from '../../config/index.js';
import { _resetLoggerForTest } from '../../logging.js';
import { parseEnv } from '../../config/env.js';

// ---------------------------------------------------------------------------
// Test env (needed for logger/config initialization)
// ---------------------------------------------------------------------------

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'rustsfadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'rustsfadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-error-tests-1234567890abc',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// Test app helper
// ---------------------------------------------------------------------------

function makeApp(throwFn: () => never): Hono {
  const app = new Hono();
  app.use('*', requestId);
  app.onError(errorFormatter);
  app.get('/test', () => {
    throwFn();
  });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('errorFormatter', () => {
  it('serializes ApiError with correct code and status', async () => {
    const app = makeApp(() => {
      throw new ApiError('NOT_FOUND', 404, 'Custom not found message');
    });
    const res = await app.fetch(new Request('http://localhost/test'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Custom not found message');
  });

  it('serializes ApiError details when present', async () => {
    const app = makeApp(() => {
      throw new ApiError('VALIDATION', 400, 'Bad input', { issues: [{ path: 'x', msg: 'bad' }] });
    });
    const res = await app.fetch(new Request('http://localhost/test'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.details).toBeDefined();
    expect(body.error.details.issues).toHaveLength(1);
  });

  it('omits details when ApiError has no details', async () => {
    const app = makeApp(() => {
      throw new ApiError('NOT_FOUND', 404, 'Not found');
    });
    const res = await app.fetch(new Request('http://localhost/test'));
    const body = await res.json();
    expect(body.error.details).toBeUndefined();
  });

  it('converts ZodError to 400 VALIDATION with details.issues', async () => {
    const schema = z.object({ name: z.string() });
    const app = makeApp(() => {
      schema.parse({ name: 123 }); // throws ZodError
      throw new Error('should not reach');
    });
    const res = await app.fetch(new Request('http://localhost/test'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.details).toBeDefined();
    expect(Array.isArray(body.error.details.issues)).toBe(true);
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });

  it('returns 500 INTERNAL for generic Error', async () => {
    const app = makeApp(() => {
      throw new Error('Something went wrong internally');
    });
    const res = await app.fetch(new Request('http://localhost/test'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL');
  });

  it('includes stack in 500 details in non-production mode (NODE_ENV=test)', async () => {
    const app = makeApp(() => {
      throw new Error('An error with a stack');
    });
    const res = await app.fetch(new Request('http://localhost/test'));
    const body = await res.json();
    // In test mode (not production), stack should be present
    expect(body.error.details?.stack).toBeDefined();
    expect(typeof body.error.details?.stack).toBe('string');
  });

  it('does NOT include stack in production mode', async () => {
    _resetConfigForTest();
    _resetLoggerForTest();
    _setConfigForTest(
      parseEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
      }),
    );

    const app = makeApp(() => {
      throw new Error('An error in production');
    });
    const res = await app.fetch(new Request('http://localhost/test'));
    const body = await res.json();
    expect(body.error.details?.stack).toBeUndefined();
  });

  it('sets X-Request-Id on every response (from requestId middleware)', async () => {
    const app = makeApp(() => {
      throw new ApiError('NOT_FOUND', 404, 'Not found');
    });
    const res = await app.fetch(new Request('http://localhost/test'));
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('echoes client-provided X-Request-Id', async () => {
    const clientId = 'my-custom-request-id-12345';
    const app = makeApp(() => {
      throw new ApiError('NOT_FOUND', 404, 'Not found');
    });
    const res = await app.fetch(
      new Request('http://localhost/test', { headers: { 'X-Request-Id': clientId } }),
    );
    expect(res.headers.get('X-Request-Id')).toBe(clientId);
  });
});
