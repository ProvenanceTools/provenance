/**
 * Cookie helpers unit tests.
 *
 * Tests signing/verification and set/read/clear helpers using Hono's
 * app.fetch() in-process so we can inspect response headers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { _resetConfigForTest, _setConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { parseEnv } from '../config/env.js';
import {
  setOAuthStateCookie,
  getOAuthStateCookie,
  clearOAuthStateCookie,
  setSessionCookie,
  getSessionCookie,
  clearSessionCookie,
  OAUTH_COOKIE_NAME,
  OAUTH_COOKIE_MAX_AGE,
} from './cookies.js';

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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-unit-tests-1234567890ab',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// OAuth state cookie: set + read round trip
// ---------------------------------------------------------------------------

describe('OAuth state cookie — set/read round trip', () => {
  it('setOAuthStateCookie + getOAuthStateCookie returns the original payload', async () => {
    const payload = { state: 'abc123', codeVerifier: 'verifier-xyz', returnTo: '/dashboard' };

    // Use a Hono app to capture what was set.
    const app = new Hono();
    app.post('/set', (c) => {
      setOAuthStateCookie(c, payload);
      return c.text('ok');
    });
    app.get('/get', (c) => {
      const result = getOAuthStateCookie(c);
      return c.json(result);
    });

    // Set the cookie.
    const setRes = await app.fetch(new Request('http://localhost/set', { method: 'POST' }));
    expect(setRes.status).toBe(200);
    const setCookieHeader = setRes.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain(OAUTH_COOKIE_NAME);
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('Secure');
    expect(setCookieHeader).toContain('SameSite=Lax');
    expect(setCookieHeader).toContain(`Max-Age=${OAUTH_COOKIE_MAX_AGE}`);

    // Extract cookie value from set-cookie header.
    const cookieValue = extractCookieValue(setCookieHeader, OAUTH_COOKIE_NAME);
    expect(cookieValue).toBeTruthy();

    // Read the cookie back.
    const getRes = await app.fetch(
      new Request('http://localhost/get', {
        headers: { Cookie: `${OAUTH_COOKIE_NAME}=${cookieValue}` },
      }),
    );
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body).toEqual(payload);
  });

  it('getOAuthStateCookie returns null when cookie is absent', async () => {
    const app = new Hono();
    app.get('/', (c) => c.json(getOAuthStateCookie(c)));
    const res = await app.fetch(new Request('http://localhost/'));
    expect(await res.json()).toBeNull();
  });

  it('getOAuthStateCookie returns null when cookie is tampered', async () => {
    const app = new Hono();
    app.get('/', (c) => c.json(getOAuthStateCookie(c)));
    const res = await app.fetch(
      new Request('http://localhost/', {
        headers: { Cookie: `${OAUTH_COOKIE_NAME}=tampered.invalidsignature` },
      }),
    );
    expect(await res.json()).toBeNull();
  });

  it('getOAuthStateCookie returns null when cookie has wrong structure', async () => {
    const app = new Hono();
    app.get('/', (c) => c.json(getOAuthStateCookie(c)));
    // Base64url encode a valid-looking JSON but missing required fields.
    const bad = Buffer.from(JSON.stringify({ x: 1 })).toString('base64url');
    const res = await app.fetch(
      new Request('http://localhost/', {
        headers: { Cookie: `${OAUTH_COOKIE_NAME}=${bad}.invalidsig` },
      }),
    );
    expect(await res.json()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth state cookie: clear
// ---------------------------------------------------------------------------

describe('clearOAuthStateCookie', () => {
  it('sets Max-Age=0', async () => {
    const app = new Hono();
    app.delete('/', (c) => {
      clearOAuthStateCookie(c);
      return c.text('cleared');
    });
    const res = await app.fetch(new Request('http://localhost/', { method: 'DELETE' }));
    const setCookieHeader = res.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain('Max-Age=0');
  });
});

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

describe('session cookie — set/read/clear', () => {
  it('setSessionCookie produces correct attributes', async () => {
    const app = new Hono();
    app.post('/', (c) => {
      setSessionCookie(c, 'session-id-abc', 1209600);
      return c.text('ok');
    });
    const res = await app.fetch(new Request('http://localhost/', { method: 'POST' }));
    const setCookieHeader = res.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain('__Host-prov_sess=session-id-abc');
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('Secure');
    expect(setCookieHeader).toContain('SameSite=Lax');
    expect(setCookieHeader).toContain('Max-Age=1209600');
  });

  it('getSessionCookie reads the session id', async () => {
    const app = new Hono();
    app.get('/', (c) => {
      const id = getSessionCookie(c);
      return c.text(id ?? 'null');
    });
    const res = await app.fetch(
      new Request('http://localhost/', {
        headers: { Cookie: '__Host-prov_sess=my-session-id' },
      }),
    );
    expect(await res.text()).toBe('my-session-id');
  });

  it('getSessionCookie returns undefined when absent', async () => {
    const app = new Hono();
    app.get('/', (c) => {
      const id = getSessionCookie(c);
      return c.text(id ?? 'null');
    });
    const res = await app.fetch(new Request('http://localhost/'));
    expect(await res.text()).toBe('null');
  });

  it('clearSessionCookie sets Max-Age=0', async () => {
    const app = new Hono();
    app.delete('/', (c) => {
      clearSessionCookie(c);
      return c.text('cleared');
    });
    const res = await app.fetch(new Request('http://localhost/', { method: 'DELETE' }));
    const setCookieHeader = res.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain('Max-Age=0');
  });
});

// ---------------------------------------------------------------------------
// __Host- prefix enforcement
// ---------------------------------------------------------------------------

describe('__Host- prefix enforcement', () => {
  it('session cookie name from env is used in Set-Cookie header', async () => {
    // In test mode the default name is __Host-prov_sess.
    const app = new Hono();
    app.post('/', (c) => {
      setSessionCookie(c, 'sid', 300);
      return c.text('ok');
    });
    const res = await app.fetch(new Request('http://localhost/', { method: 'POST' }));
    const setCookieHeader = res.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain('__Host-prov_sess=sid');
  });

  it('parseEnv rejects SESSION_COOKIE_NAME without __Host- prefix in production', () => {
    expect(() =>
      parseEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        SESSION_COOKIE_NAME: 'prov_sess',
      }),
    ).toThrow(/SESSION_COOKIE_NAME/);
  });

  it('parseEnv rejects missing AUTH_COOKIE_SIGNING_SECRET in production', () => {
    expect(() =>
      parseEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        AUTH_COOKIE_SIGNING_SECRET: undefined,
        AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
      }),
    ).toThrow(/AUTH_COOKIE_SIGNING_SECRET/);
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function extractCookieValue(setCookieHeader: string, name: string): string {
  for (const part of setCookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(name.length + 1);
    }
  }
  return '';
}
