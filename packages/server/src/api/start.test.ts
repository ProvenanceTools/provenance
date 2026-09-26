import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from './start.js';
import { _resetConfigForTest, _setConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { parseEnv } from '../config/env.js';

// ---------------------------------------------------------------------------
// Provide minimal valid env before each test so the config singleton resolves
// without hitting process.env.
// ---------------------------------------------------------------------------

const TEST_ENV: Record<string, string> = {
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
};

beforeEach(() => {
  // Reset singletons and inject a known env without mutating process.env
  _resetConfigForTest();
  _resetLoggerForTest();
  const config = parseEnv(TEST_ENV);
  _setConfigForTest(config);
});

// ---------------------------------------------------------------------------
// /healthz
// ---------------------------------------------------------------------------

describe('GET /healthz', () => {
  it('returns 200 with { status: "ok" }', async () => {
    const app = createApp();
    const req = new Request('http://localhost/healthz');
    const res = await app.fetch(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('returns JSON content-type', async () => {
    const app = createApp();
    const req = new Request('http://localhost/healthz');
    const res = await app.fetch(req);

    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

// ---------------------------------------------------------------------------
// Unknown routes
// ---------------------------------------------------------------------------

describe('unknown routes', () => {
  it('returns 404 for an unregistered path', async () => {
    const app = createApp();
    const req = new Request('http://localhost/unknown-route');
    const res = await app.fetch(req);

    expect(res.status).toBe(404);
  });
});
