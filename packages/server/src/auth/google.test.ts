/**
 * GoogleOAuthClient unit tests.
 *
 * Tests the seam and URL construction. No network access.
 * FakeGoogleOAuthClient lives in test/helpers/fake-google-client.ts
 * and is imported there (and in auth.test.ts) to avoid cross-test-file imports.
 *
 * Integration tests for RealGoogleOAuthClient.exchangeCodeAndVerify (which
 * require mocking arctic) live in google-integration.test.ts so the
 * vi.mock('arctic') there doesn't pollute these URL-construction tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { _resetConfigForTest, _setConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { parseEnv } from '../config/env.js';
import { RealGoogleOAuthClient, narrowClaims } from './google.js';
import { FakeGoogleOAuthClient } from '../../test/helpers/fake-google-client.js';

// ---------------------------------------------------------------------------
// Test env
// ---------------------------------------------------------------------------

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'rustfsadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'rustfsadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// RealGoogleOAuthClient.generatePkceParams
// ---------------------------------------------------------------------------

describe('RealGoogleOAuthClient.generatePkceParams', () => {
  it('returns unique state + codeVerifier each call', () => {
    const client = new RealGoogleOAuthClient();
    const p1 = client.generatePkceParams();
    const p2 = client.generatePkceParams();
    expect(p1.state).not.toBe(p2.state);
    expect(p1.codeVerifier).not.toBe(p2.codeVerifier);
  });

  it('returns a state that is non-empty base64url', () => {
    const client = new RealGoogleOAuthClient();
    const { state } = client.generatePkceParams();
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state.length).toBeGreaterThan(10);
  });

  it('returns a codeVerifier at least 43 chars (RFC 7636 min)', () => {
    const client = new RealGoogleOAuthClient();
    const { codeVerifier } = client.generatePkceParams();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
});

// ---------------------------------------------------------------------------
// RealGoogleOAuthClient.createAuthorizeUrl
// ---------------------------------------------------------------------------

describe('RealGoogleOAuthClient.createAuthorizeUrl', () => {
  it('includes all required query params', () => {
    const client = new RealGoogleOAuthClient();
    const { state, codeVerifier } = client.generatePkceParams();
    const urlStr = client.createAuthorizeUrl({
      state,
      codeVerifier,
      redirectUri: 'http://localhost:3000/api/v1/auth/google/callback',
    });
    const url = new URL(urlStr);

    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/v1/auth/google/callback',
    );
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('scope')).toContain('email');
    expect(url.searchParams.get('scope')).toContain('profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('hd')).toBe('berkeley.edu');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('uses hd from AUTH_ALLOWED_HOSTED_DOMAINS[0]', () => {
    _resetConfigForTest();
    _setConfigForTest(
      parseEnv({ ...BASE_ENV, AUTH_ALLOWED_HOSTED_DOMAINS: '["other.edu","second.edu"]' }),
    );
    const client = new RealGoogleOAuthClient();
    const { state, codeVerifier } = client.generatePkceParams();
    const urlStr = client.createAuthorizeUrl({
      state,
      codeVerifier,
      redirectUri: 'http://localhost:3000/api/v1/auth/google/callback',
    });
    const url = new URL(urlStr);
    expect(url.searchParams.get('hd')).toBe('other.edu');
  });
});

// ---------------------------------------------------------------------------
// narrowClaims
// ---------------------------------------------------------------------------

describe('narrowClaims', () => {
  it('narrows valid claims', () => {
    const raw = {
      sub: 'sub123',
      email: 'user@berkeley.edu',
      email_verified: true,
      hd: 'berkeley.edu',
      name: 'User',
    };
    const claims = narrowClaims(raw);
    expect(claims.sub).toBe('sub123');
    expect(claims.email).toBe('user@berkeley.edu');
    expect(claims.email_verified).toBe(true);
    expect(claims.hd).toBe('berkeley.edu');
    expect(claims.name).toBe('User');
  });

  it('allows hd to be absent', () => {
    const raw = { sub: 'sub', email: 'a@b.com', email_verified: false };
    const claims = narrowClaims(raw);
    expect(claims.hd).toBeUndefined();
  });

  it('throws when sub is missing', () => {
    expect(() => narrowClaims({ email: 'a@b.com', email_verified: true })).toThrow(/sub/);
  });

  it('throws when email is missing', () => {
    expect(() => narrowClaims({ sub: 's', email_verified: true })).toThrow(/email/);
  });

  it('throws when email_verified is missing', () => {
    expect(() => narrowClaims({ sub: 's', email: 'a@b.com' })).toThrow(/email_verified/);
  });
});

// ---------------------------------------------------------------------------
// FakeGoogleOAuthClient seam (validates the interface)
// ---------------------------------------------------------------------------

describe('FakeGoogleOAuthClient', () => {
  it('returns deterministic params', () => {
    const fake = new FakeGoogleOAuthClient({ state: 'st', codeVerifier: 'cv' });
    expect(fake.generatePkceParams()).toEqual({ state: 'st', codeVerifier: 'cv' });
  });

  it('returns pre-baked claims', async () => {
    const fake = new FakeGoogleOAuthClient();
    const claims = await fake.exchangeCodeAndVerify({
      code: 'any',
      codeVerifier: 'any',
      redirectUri: 'http://localhost/cb',
    });
    expect(claims.email).toBe('student@berkeley.edu');
  });

  it('throws when configured to throw', async () => {
    const fake = new FakeGoogleOAuthClient({ shouldThrow: true });
    await expect(
      fake.exchangeCodeAndVerify({ code: 'c', codeVerifier: 'v', redirectUri: 'http://x/cb' }),
    ).rejects.toThrow();
  });
});
