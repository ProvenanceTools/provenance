/**
 * Unit tests for the institution key-material loader (identity 2.1).
 *
 * No database, no HTTP, no container: this module is a pure parser over a
 * config string plus one cached lookup, and it is the seam where the server's
 * single private key is handled. It is tested on its own so that the rules
 * about what may and may not escape it are pinned independently of the route.
 *
 * The properties pinned here, in order of what it would cost to get them wrong:
 *
 *  1. no error value ever contains the private key or any configured value —
 *     a config error is printed to stderr on a failed boot and gets pasted into
 *     chat windows;
 *  2. a malformed configuration THROWS rather than reading as "no key", because
 *     the latter turns an operator typo into a silent "enrollment is closed";
 *  3. the version gate runs before the shape check, so a future 3.0 cert is
 *     refused outright rather than read under 2.1 rules.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  signInstitutionCert,
  deriveCourseKeypair,
  INSTITUTION_IDENTITY_FORMAT_VERSION,
} from '@provenance/log-core';
import {
  parseInstitutionKey,
  institutionKey,
  _resetInstitutionKeyForTest,
} from './institution-keys.js';
import { _resetConfigForTest, _setConfigForTest } from './index.js';
import { parseEnv } from './env.js';

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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-institution-keys-1234567890',
};

/** Deterministic key bytes — no Math.random, no crypto.randomBytes. */
function seed(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const INSTITUTION_ID = 'berkeley';

async function makeMaterial(certOverrides: Record<string, unknown> = {}) {
  // deriveCourseKeypair is a deterministic HKDF over fixed bytes, so these keys
  // are the same on every run — no randomness anywhere in the fixture.
  const root = await deriveCourseKeypair(seed(0x31), 'fixture-root');
  const institution = await deriveCourseKeypair(seed(0x32), 'fixture-institution');

  const unsigned = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: INSTITUTION_ID,
    institution_pubkey: institution.publicKeyHex,
    valid_from: '2026-08-20',
    valid_until: '2027-01-15',
    ...certOverrides,
  };
  const cert = {
    ...unsigned,
    root_sig: await signInstitutionCert(
      unsigned as Parameters<typeof signInstitutionCert>[0],
      root.privateKey,
    ),
  };

  return {
    cert,
    privateKeyHex: toHex(institution.privateKey),
    institutionPubkeyHex: institution.publicKeyHex,
    rootPubkeyHex: root.publicKeyHex,
  };
}

beforeEach(() => {
  _resetConfigForTest();
  _resetInstitutionKeyForTest();
});

afterEach(() => {
  _resetConfigForTest();
  _resetInstitutionKeyForTest();
});

// ---------------------------------------------------------------------------
// parseInstitutionKey
// ---------------------------------------------------------------------------

describe('parseInstitutionKey', () => {
  it('parses a well-formed entry and reads institution_id off the signed cert', async () => {
    const { cert, privateKeyHex } = await makeMaterial();

    const result = parseInstitutionKey(JSON.stringify({ private_key_hex: privateKeyHex, cert }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeDefined();
    // institution_id comes from the ROOT-SIGNED certificate, never from a
    // separate config field, so it cannot name an institution root did not
    // authorize this key for.
    expect(result.value!.institution_id).toBe(INSTITUTION_ID);
    expect(result.value!.cert.institution_id).toBe(INSTITUTION_ID);
    expect(result.value!.private_key_hex).toBe(privateKeyHex);
  });

  it('treats an empty object as "no institution key configured", not an error', () => {
    // The env schema defaults the variable to `{}` when unset, and a deployment
    // that has not adopted 2.1 identity is a legitimate state.
    const result = parseInstitutionKey('{}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  it('rejects a non-JSON value without echoing it', () => {
    const result = parseInstitutionKey('not json at all');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not valid JSON');
    expect(JSON.stringify(result.error)).not.toContain('not json at all');
  });

  it('rejects a JSON array and a JSON scalar', () => {
    for (const raw of ['[]', '"a string"', '42', 'null']) {
      const result = parseInstitutionKey(raw);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.reason).toBe('must be a JSON object');
    }
  });

  it('names the private_key_hex FIELD and never leaks the offending value', async () => {
    const { cert } = await makeMaterial();
    const badSecret = 'THIS-IS-THE-SECRET-THAT-MUST-NOT-APPEAR';

    const result = parseInstitutionKey(
      JSON.stringify({ private_key_hex: badSecret, cert }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('private_key_hex must be 64 lowercase hex characters');
    // The load-bearing assertion: a boot failure gets pasted into chat.
    expect(JSON.stringify(result.error)).not.toContain(badSecret);
  });

  it('rejects an UPPERCASE private key — the hex contract is lowercase', async () => {
    const { cert, privateKeyHex } = await makeMaterial();
    const result = parseInstitutionKey(
      JSON.stringify({ private_key_hex: privateKeyHex.toUpperCase(), cert }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain('private_key_hex');
    expect(JSON.stringify(result.error)).not.toContain(privateKeyHex.toUpperCase());
  });

  it('gates on cert.format_version BEFORE shape, so a future 3.0 cert is refused outright', async () => {
    const { cert, privateKeyHex } = await makeMaterial();

    const result = parseInstitutionKey(
      JSON.stringify({
        private_key_hex: privateKeyHex,
        // A structurally perfect cert that merely declares a newer version.
        cert: { ...cert, format_version: '3.0' },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe(
      `cert.format_version must be "${INSTITUTION_IDENTITY_FORMAT_VERSION}"`,
    );
  });

  it('refuses a 2.0 enrollment-era cert supplied in the 2.1 slot', async () => {
    const { privateKeyHex } = await makeMaterial();
    const result = parseInstitutionKey(
      JSON.stringify({
        private_key_hex: privateKeyHex,
        cert: { format_version: '2.0', course_id: 'berkeley-cs61b' },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain('format_version');
  });

  it('names the offending CERT FIELD when the cert is malformed', async () => {
    const { cert, privateKeyHex } = await makeMaterial();

    const result = parseInstitutionKey(
      JSON.stringify({
        private_key_hex: privateKeyHex,
        cert: { ...cert, institution_pubkey: 'nope' },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('cert.institution_pubkey is invalid');
    expect(JSON.stringify(result.error)).not.toContain(privateKeyHex);
  });

  it('rejects a cert whose window is inverted', async () => {
    const { cert, privateKeyHex } = await makeMaterial({
      valid_from: '2027-01-15',
      valid_until: '2026-08-20',
    });

    const result = parseInstitutionKey(JSON.stringify({ private_key_hex: privateKeyHex, cert }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('cert.valid_until is invalid');
  });

  it('never puts the private key in ANY error value', async () => {
    const { cert, privateKeyHex } = await makeMaterial();

    const malformed = [
      JSON.stringify({ private_key_hex: privateKeyHex, cert: 'not-an-object' }),
      JSON.stringify({ private_key_hex: privateKeyHex, cert: { format_version: '9.9' } }),
      JSON.stringify({ private_key_hex: privateKeyHex, cert: { ...cert, root_sig: 'short' } }),
      JSON.stringify({ private_key_hex: privateKeyHex, cert: { ...cert, institution_id: '' } }),
    ];

    for (const raw of malformed) {
      const result = parseInstitutionKey(raw);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(JSON.stringify(result.error)).not.toContain(privateKeyHex);
    }
  });
});

// ---------------------------------------------------------------------------
// institutionKey — the cached lookup
// ---------------------------------------------------------------------------

describe('institutionKey', () => {
  it('returns undefined when nothing is configured', () => {
    _setConfigForTest(parseEnv(BASE_ENV));
    expect(institutionKey()).toBeUndefined();
  });

  it('returns the parsed material when configured', async () => {
    const { cert, privateKeyHex } = await makeMaterial();
    _setConfigForTest(
      parseEnv({
        ...BASE_ENV,
        PROVENANCE_INSTITUTION_KEY: JSON.stringify({ private_key_hex: privateKeyHex, cert }),
      }),
    );

    const material = institutionKey();
    expect(material).toBeDefined();
    expect(material!.institution_id).toBe(INSTITUTION_ID);
  });

  it('THROWS on a malformed configuration rather than reading as "no key"', async () => {
    // Behaving as if no key were configured would turn an operator typo into
    // "credential issuance is closed", which a course would not notice until
    // students complained.
    _setConfigForTest(
      parseEnv({
        ...BASE_ENV,
        PROVENANCE_INSTITUTION_KEY: JSON.stringify({ private_key_hex: 'bad', cert: {} }),
      }),
    );

    expect(() => institutionKey()).toThrow(/PROVENANCE_INSTITUTION_KEY/);
  });

  it('does not put the private key into the thrown message', async () => {
    const privateKeyHex = 'a'.repeat(64);
    _setConfigForTest(
      parseEnv({
        ...BASE_ENV,
        PROVENANCE_INSTITUTION_KEY: JSON.stringify({
          private_key_hex: privateKeyHex,
          cert: { format_version: '9.9' },
        }),
      }),
    );

    let message = '';
    try {
      institutionKey();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('PROVENANCE_INSTITUTION_KEY');
    expect(message).not.toContain(privateKeyHex);
  });

  it('re-parses when the configured value changes', async () => {
    const first = await makeMaterial();
    _setConfigForTest(
      parseEnv({
        ...BASE_ENV,
        PROVENANCE_INSTITUTION_KEY: JSON.stringify({
          private_key_hex: first.privateKeyHex,
          cert: first.cert,
        }),
      }),
    );
    expect(institutionKey()!.institution_id).toBe(INSTITUTION_ID);

    const second = await makeMaterial({ institution_id: 'stanford' });
    _setConfigForTest(
      parseEnv({
        ...BASE_ENV,
        PROVENANCE_INSTITUTION_KEY: JSON.stringify({
          private_key_hex: second.privateKeyHex,
          cert: second.cert,
        }),
      }),
    );
    expect(institutionKey()!.institution_id).toBe('stanford');
  });
});
