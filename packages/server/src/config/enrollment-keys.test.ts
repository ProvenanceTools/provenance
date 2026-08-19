/**
 * Unit tests for the enrollment key-material loader.
 *
 * No database, no HTTP, no container: this module is a pure parser over a
 * config string plus one cached lookup, and it is the seam where the server's
 * single private key is handled. It is tested on its own so that the rules
 * about what may and may not escape it are pinned independently of the route.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  signEnrollmentCert,
  deriveCourseKeypair,
  ENROLLMENT_FORMAT_VERSION,
} from '@provenance/log-core';
import {
  parseEnrollmentKeys,
  enrollmentKeyForSemester,
  _resetEnrollmentKeysForTest,
} from './enrollment-keys.js';
import { _resetConfigForTest, _setConfigForTest } from './index.js';
import { parseEnv } from './env.js';

const SEMESTER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SEMESTER_ID = '22222222-2222-4222-8222-222222222222';

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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-enrollment-keys-1234567890',
};

/** Deterministic key bytes — no Math.random, no crypto.randomBytes. */
function seed(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeCert(overrides: Record<string, unknown> = {}) {
  // deriveCourseKeypair is a deterministic HKDF over fixed bytes, so these keys
  // are the same on every run — no randomness anywhere in the fixture.
  const course = await deriveCourseKeypair(seed(0x11), 'fixture-course');
  const enrollment = await deriveCourseKeypair(seed(0x22), 'fixture-enrollment');

  const unsigned = {
    format_version: ENROLLMENT_FORMAT_VERSION,
    course_id: 'berkeley-cs61b',
    enrollment_pubkey: enrollment.publicKeyHex,
    valid_from: '2026-08-20',
    valid_until: '2027-01-15',
  };
  const cert = { ...unsigned, course_sig: await signEnrollmentCert(unsigned, course.privateKey) };
  return {
    cert: { ...cert, ...overrides },
    enrollmentPrivHex: toHex(enrollment.privateKey),
    coursePubHex: course.publicKeyHex,
  };
}

beforeEach(() => {
  _resetConfigForTest();
  _resetEnrollmentKeysForTest();
});

afterEach(() => {
  _resetConfigForTest();
  _resetEnrollmentKeysForTest();
});

// ---------------------------------------------------------------------------
// parseEnrollmentKeys
// ---------------------------------------------------------------------------

describe('parseEnrollmentKeys', () => {
  it('returns an empty map for an unconfigured deployment', () => {
    const result = parseEnrollmentKeys('{}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.size).toBe(0);
  });

  it('parses one semester entry with a well-formed cert', async () => {
    const { cert, enrollmentPrivHex } = await makeCert();
    const raw = JSON.stringify({
      [SEMESTER_ID]: { private_key_hex: enrollmentPrivHex, cert },
    });

    const result = parseEnrollmentKeys(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const material = result.value.get(SEMESTER_ID);
    expect(material).toBeDefined();
    expect(material?.cert.course_id).toBe('berkeley-cs61b');
    expect(material?.cert.enrollment_pubkey).toBe(cert.enrollment_pubkey);
    expect(material?.private_key_hex).toBe(enrollmentPrivHex);
  });

  it('rejects a private key that is not 64 lowercase hex chars', async () => {
    const { cert } = await makeCert();
    const raw = JSON.stringify({ [SEMESTER_ID]: { private_key_hex: 'nope', cert } });

    const result = parseEnrollmentKeys(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.semester_id).toBe(SEMESTER_ID);
  });

  it('rejects a cert that fails the 2.0 shape check', async () => {
    const { cert, enrollmentPrivHex } = await makeCert();
    const broken = { ...cert, enrollment_pubkey: 'not-hex' };
    const raw = JSON.stringify({
      [SEMESTER_ID]: { private_key_hex: enrollmentPrivHex, cert: broken },
    });

    const result = parseEnrollmentKeys(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain('enrollment_pubkey');
  });

  it('rejects a cert whose format_version is not 2.0', async () => {
    const { cert, enrollmentPrivHex } = await makeCert({ format_version: '3.0' });
    const raw = JSON.stringify({
      [SEMESTER_ID]: { private_key_hex: enrollmentPrivHex, cert },
    });

    const result = parseEnrollmentKeys(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain('2.0');
  });

  it('never echoes the private key in an error message', async () => {
    const { cert } = await makeCert();
    const secret = 'ab'.repeat(32);
    const raw = JSON.stringify({
      [SEMESTER_ID]: { private_key_hex: secret, cert: { ...cert, course_id: '' } },
    });

    const result = parseEnrollmentKeys(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain(secret);
  });

  it('rejects a non-object entry without throwing', () => {
    const result = parseEnrollmentKeys(JSON.stringify({ [SEMESTER_ID]: 'hunter2' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain('hunter2');
  });

  it('rejects a malformed JSON string without echoing it', () => {
    const result = parseEnrollmentKeys('{not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain('not json');
  });
});

// ---------------------------------------------------------------------------
// enrollmentKeyForSemester
// ---------------------------------------------------------------------------

describe('enrollmentKeyForSemester', () => {
  it('returns undefined when the deployment configures no keys', () => {
    _setConfigForTest(parseEnv(BASE_ENV));
    expect(enrollmentKeyForSemester(SEMESTER_ID)).toBeUndefined();
  });

  it('returns material for the configured semester only', async () => {
    const { cert, enrollmentPrivHex } = await makeCert();
    _setConfigForTest(
      parseEnv({
        ...BASE_ENV,
        PROVENANCE_ENROLLMENT_KEYS: JSON.stringify({
          [SEMESTER_ID]: { private_key_hex: enrollmentPrivHex, cert },
        }),
      }),
    );

    expect(enrollmentKeyForSemester(SEMESTER_ID)?.cert.course_id).toBe('berkeley-cs61b');
    expect(enrollmentKeyForSemester(OTHER_SEMESTER_ID)).toBeUndefined();
  });

  it('throws on a malformed configuration rather than silently minting nothing', () => {
    _setConfigForTest(
      parseEnv({
        ...BASE_ENV,
        PROVENANCE_ENROLLMENT_KEYS: JSON.stringify({ [SEMESTER_ID]: { private_key_hex: 'x' } }),
      }),
    );

    expect(() => enrollmentKeyForSemester(SEMESTER_ID)).toThrow(/enrollment key/i);
  });
});
