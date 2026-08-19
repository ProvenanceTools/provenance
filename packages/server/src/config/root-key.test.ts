import { describe, it, expect, afterEach } from 'vitest';
import { parseEnv } from './env.js';
import { _setConfigForTest, _resetConfigForTest } from './index.js';
import { rootPublicKeyHex, configuredValidationOptions } from './root-key.js';

const BASE_ENV = {
  PUBLIC_BASE_URL: 'https://example.test',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  BLOB_STORAGE_BACKEND: 'fs',
  BLOB_STORAGE_FS_ROOT: '/tmp/blobs',
  BLOB_URL_SIGNING_SECRET: 'x'.repeat(32),
};

function withEnv(extra: Record<string, string>) {
  _setConfigForTest(parseEnv({ ...BASE_ENV, ...extra }));
}

afterEach(() => {
  _resetConfigForTest();
});

describe('root public key config', () => {
  it('is optional — an unset key means the trust chain cannot be verified', () => {
    withEnv({});
    expect(rootPublicKeyHex()).toBeUndefined();
    expect(configuredValidationOptions()).toEqual({});
  });

  it('is threaded into the validation options when set', () => {
    const key = 'a'.repeat(64);
    withEnv({ PROVENANCE_ROOT_PUBLIC_KEY_HEX: key });
    expect(rootPublicKeyHex()).toBe(key);
    expect(configuredValidationOptions()).toEqual({ rootPubkeyHex: key });
  });

  it('rejects a malformed key at boot rather than at verification time', () => {
    expect(() => parseEnv({ ...BASE_ENV, PROVENANCE_ROOT_PUBLIC_KEY_HEX: 'not-hex' })).toThrow();
    // Uppercase hex is rejected too: the whole chain is specified in lowercase
    // hex, and silently accepting both would put the three recorder ports'
    // string comparisons out of sync.
    expect(() =>
      parseEnv({ ...BASE_ENV, PROVENANCE_ROOT_PUBLIC_KEY_HEX: 'A'.repeat(64) }),
    ).toThrow();
  });
});
