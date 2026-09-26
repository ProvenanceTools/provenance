/**
 * RealGoogleOAuthClient.exchangeCodeAndVerify integration test.
 *
 * This file uses vi.mock('arctic') so it lives separately from google.test.ts
 * to prevent the module-level mock from contaminating the URL-construction tests.
 *
 * Purpose: verify that verifyIdToken is correctly wired into the real code-exchange
 * path. Without this test, verifyIdToken could be silently disconnected and all
 * other tests (which use FakeGoogleOAuthClient) would still pass.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { _resetConfigForTest, _setConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { parseEnv } from '../config/env.js';
import { RealGoogleOAuthClient } from './google.js';
import {
  generateTestKeyPair,
  mintJwt,
  validPayload,
  jwksFromPair,
} from '../../test/helpers/mint-jwt.js';
import * as nodeCrypto from 'node:crypto';
import type { JwkSet } from './jwks.js';

// ---------------------------------------------------------------------------
// arctic mock — scoped to this file only
// ---------------------------------------------------------------------------

// A module-level variable that tests set before each call so the mock can
// return the right JWT. vi.mock is hoisted; `_mockIdToken` stays writable.
let _mockIdToken: string | undefined;

vi.mock('arctic', async (importOriginal) => {
  const original = await importOriginal<typeof import('arctic')>();
  return {
    ...original,
    // Replace Google with a stub. validateAuthorizationCode returns a tokens
    // object whose idToken() returns whatever the test put in _mockIdToken.
    Google: class MockGoogle {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(..._args: any[]) {}
      createAuthorizationURL(state: string, _cv: string, scopes: string[]) {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('state', state);
        url.searchParams.set('scope', scopes.join(' '));
        return url;
      }
      async validateAuthorizationCode(_code: string, _cv: string) {
        return {
          idToken() {
            if (_mockIdToken === undefined) throw new Error('_mockIdToken not set by test');
            return _mockIdToken;
          },
        };
      }
    },
  };
});

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
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
  _mockIdToken = undefined;
});

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

describe('RealGoogleOAuthClient.exchangeCodeAndVerify — real verifyIdToken path', () => {
  // Generate a key pair once for the describe block. All tests in this block
  // share the same key pair and fake JWKs fetcher.
  const pair = generateTestKeyPair('integration-kid');
  const fakeJwks = jwksFromPair(pair) as JwkSet;
  const fetchJwks = async (): Promise<JwkSet> => fakeJwks;

  it('returns verified claims when JWT is valid and JWKs match', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = validPayload('test-client-id', {
      sub: 'real-sub-123',
      email: 'real@berkeley.edu',
      email_verified: true,
      hd: 'berkeley.edu',
      name: 'Real User',
      iat: nowSec,
      exp: nowSec + 3600,
    });
    _mockIdToken = mintJwt(pair, payload);

    const client = new RealGoogleOAuthClient({ fetchJwks });
    const claims = await client.exchangeCodeAndVerify({
      code: 'fake-code',
      codeVerifier: 'fake-cv',
      redirectUri: 'http://localhost/cb',
    });

    expect(claims.sub).toBe('real-sub-123');
    expect(claims.email).toBe('real@berkeley.edu');
    expect(claims.email_verified).toBe(true);
    expect(claims.hd).toBe('berkeley.edu');
    expect(claims.name).toBe('Real User');
  });

  it('throws when JWT signature does not verify against JWKs (wrong key)', async () => {
    // Mint a JWT signed with a DIFFERENT private key than what the JWKs fetcher exposes.
    const { privateKey: otherKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = validPayload('test-client-id', { iat: nowSec, exp: nowSec + 3600 });
    _mockIdToken = mintJwt(pair, payload, { signWithKey: otherKey });

    const client = new RealGoogleOAuthClient({ fetchJwks });
    await expect(
      client.exchangeCodeAndVerify({
        code: 'fake-code',
        codeVerifier: 'fake-cv',
        redirectUri: 'http://localhost/cb',
      }),
    ).rejects.toThrow(/signature/i);
  });
});
