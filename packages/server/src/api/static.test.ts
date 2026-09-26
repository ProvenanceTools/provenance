import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { mountStatic } from './static.js';
import { createApp } from './start.js';
import { _resetConfigForTest, _setConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { parseEnv } from '../config/env.js';

// ---------------------------------------------------------------------------
// Same-origin SPA serving (mountStatic, wired into createApp()).
//
// Builds a temp publicDir with an index.html (containing a marker string)
// and a nested asset, points PUBLIC_DIR at it via the config test seam, and
// exercises createApp() end-to-end via app.fetch(). Confirms the SPA
// fallback serves index.html for unknown client routes, real assets are
// served as-is, and /api/v1, /healthz, /metrics are never shadowed by the
// SPA fallback.
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

let publicDir: string;

beforeEach(() => {
  // Build a temp publicDir (absolute path — serveStatic's `root` resolution
  // depends on process.cwd() for relative roots; using an absolute path
  // here keeps the test independent of the vitest working directory).
  publicDir = mkdtempSync(join(tmpdir(), 'prov-static-test-'));
  writeFileSync(join(publicDir, 'index.html'), '<html>SPA_ROOT</html>');
  mkdirSync(join(publicDir, 'assets'));
  writeFileSync(join(publicDir, 'assets', 'app.js'), 'console.log("app");');

  _resetConfigForTest();
  _resetLoggerForTest();
  const config = parseEnv({ ...TEST_ENV, PUBLIC_DIR: publicDir });
  _setConfigForTest(config);
});

afterEach(() => {
  rmSync(publicDir, { recursive: true, force: true });
});

describe('same-origin SPA serving', () => {
  it('GET / serves index.html', async () => {
    const app = createApp();
    const res = await app.fetch(new Request('http://x/'));

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('SPA_ROOT');
  });

  it('GET /assets/app.js serves the real asset', async () => {
    const app = createApp();
    const res = await app.fetch(new Request('http://x/assets/app.js'));

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('console.log("app");');
  });

  it('GET /some/client/route falls back to index.html (SPA routing)', async () => {
    const app = createApp();
    const res = await app.fetch(new Request('http://x/some/client/route'));

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('SPA_ROOT');
  });

  it('GET /api/v1/does-not-exist is NOT shadowed by the SPA fallback', async () => {
    const app = createApp();
    const res = await app.fetch(new Request('http://x/api/v1/does-not-exist'));

    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('SPA_ROOT');
  });

  it('GET /healthz still returns the health JSON, not the SPA', async () => {
    const app = createApp();
    const res = await app.fetch(new Request('http://x/healthz'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('registers nothing (clean 404, no console.error) when publicDir is absent', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = new Hono();
      const missingDir = join(publicDir, 'does-not-exist');
      mountStatic(app, { publicDir: missingDir });

      const res = await app.fetch(new Request('http://x/anything'));

      // No static/SPA middleware registered → framework 404, not an error.
      expect(res.status).toBe(404);
      // serveStatic was never mounted, so it never console.error'd about a
      // missing root path.
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
