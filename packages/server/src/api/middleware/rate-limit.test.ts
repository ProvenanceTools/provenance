/**
 * Rate limit middleware tests — in-memory backend.
 *
 * Uses clock injection for deterministic refill behavior.
 * Tests isolate by resetting the in-memory store between runs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { rateLimit, _resetMemoryStore, _setBackendForTest } from './rate-limit.js';
import { authSessionMiddleware } from './auth-session.js';
import { _resetConfigForTest, _setConfigForTest } from '../../config/index.js';
import { _resetLoggerForTest } from '../../logging.js';
import { parseEnv } from '../../config/env.js';

// ---------------------------------------------------------------------------
// Test env
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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-rate-limit-tests-abcdef',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
  _resetMemoryStore();
  _setBackendForTest('memory');
});

// ---------------------------------------------------------------------------
// Test app helper
// ---------------------------------------------------------------------------

let _fakeNow = Date.now();

function makeApp(): Hono {
  const app = new Hono();
  // authSessionMiddleware sets c.var.principal; since there's no session/token
  // in these requests, it will be null (anon). The rate limiter uses anon:<ip>.
  app.use('*', authSessionMiddleware);
  app.get(
    '/protected',
    rateLimit('auth', () => _fakeNow),
    (c) => {
      return c.json({ ok: true });
    },
  );
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rateLimit (in-memory backend)', () => {
  it('allows the first N requests up to bucket size', async () => {
    const app = makeApp();

    // 'auth' bucket size is 30
    for (let i = 0; i < 30; i++) {
      const res = await app.fetch(new Request('http://localhost/protected'));
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 on the (bucket_size + 1)th request', async () => {
    const app = makeApp();

    for (let i = 0; i < 30; i++) {
      await app.fetch(new Request('http://localhost/protected'));
    }

    const res = await app.fetch(new Request('http://localhost/protected'));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('429 response includes Retry-After header', async () => {
    const app = makeApp();

    for (let i = 0; i < 30; i++) {
      await app.fetch(new Request('http://localhost/protected'));
    }

    const res = await app.fetch(new Request('http://localhost/protected'));
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('Retry-After');
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('includes X-RateLimit-Remaining header on success', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://localhost/protected'));
    expect(res.status).toBe(200);
    const remaining = res.headers.get('X-RateLimit-Remaining');
    expect(remaining).toBeTruthy();
    expect(Number(remaining)).toBe(29); // started at 30, consumed 1
  });

  it('includes X-RateLimit-Reset header on every response', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://localhost/protected'));
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  it('bucket refills proportionally after time passes', async () => {
    const app = makeApp();

    // Exhaust the bucket
    for (let i = 0; i < 30; i++) {
      await app.fetch(new Request('http://localhost/protected'));
    }

    // Verify exhausted
    const deniedRes = await app.fetch(new Request('http://localhost/protected'));
    expect(deniedRes.status).toBe(429);

    // Advance time by 5 minutes (full refill window for 'auth' class)
    _fakeNow += 5 * 60 * 1000;

    // Should be allowed again
    const refilled = await app.fetch(new Request('http://localhost/protected'));
    expect(refilled.status).toBe(200);
  });

  it('partial refill allows partial requests', async () => {
    const app = makeApp();

    // Exhaust the bucket (30 tokens)
    for (let i = 0; i < 30; i++) {
      await app.fetch(new Request('http://localhost/protected'));
    }

    // Advance time by 2.5 minutes (half the 5-min window → ~15 tokens refilled)
    _fakeNow += 2.5 * 60 * 1000;

    // Should allow ~15 requests
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const res = await app.fetch(new Request('http://localhost/protected'));
      if (res.status === 200) allowed++;
      else break;
    }
    // Should allow at least 10 and at most 16 (accounting for floating-point)
    expect(allowed).toBeGreaterThanOrEqual(10);
    expect(allowed).toBeLessThanOrEqual(16);
  });

  it('different principals (IPs) have independent buckets', async () => {
    const app = makeApp();

    // Exhaust for IP 1.1.1.1
    for (let i = 0; i < 30; i++) {
      await app.fetch(
        new Request('http://localhost/protected', {
          headers: { 'x-forwarded-for': '1.1.1.1' },
        }),
      );
    }

    // IP 1.1.1.1 is exhausted
    const denied = await app.fetch(
      new Request('http://localhost/protected', {
        headers: { 'x-forwarded-for': '1.1.1.1' },
      }),
    );
    expect(denied.status).toBe(429);

    // IP 2.2.2.2 should still be allowed (independent bucket)
    const allowed = await app.fetch(
      new Request('http://localhost/protected', {
        headers: { 'x-forwarded-for': '2.2.2.2' },
      }),
    );
    expect(allowed.status).toBe(200);
  });
});
