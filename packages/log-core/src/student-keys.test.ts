import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  deriveCourseKeySeed,
  deriveCourseKeypair,
  deriveStudentKeySeed,
  deriveStudentKeypair,
  generateStudentMasterSecret,
  STUDENT_KEY_HKDF_INFO_PREFIX,
  STUDENT_KEY_HKDF_INFO,
  STUDENT_KEY_HKDF_SALT,
  STUDENT_KEY_SEED_BYTES,
  STUDENT_MASTER_SECRET_BYTES,
} from './student-keys.js';

// Fixed master secrets — deterministic, never random, so every assertion below
// pins exact bytes. The same fills the conformance vectors use.
const master = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const MASTER_A = master(0x2a);
const MASTER_B = master(0x2b);

describe('HKDF parameter constants', () => {
  it('pins the info prefix exactly', () => {
    // Three ports derive against this literal. A change here is a silent
    // cross-repo divergence, not a refactor.
    expect(STUDENT_KEY_HKDF_INFO_PREFIX).toBe('provenance-student-key-v1:');
  });

  it('pins a NON-EMPTY salt, so no port has to reason about HKDF zero-salt defaults', () => {
    expect(new TextDecoder().decode(STUDENT_KEY_HKDF_SALT)).toBe('provenance-student-key-v1');
    expect(STUDENT_KEY_HKDF_SALT.length).toBeGreaterThan(0);
  });

  it('pins the master secret length at 32 bytes', () => {
    expect(STUDENT_MASTER_SECRET_BYTES).toBe(32);
  });
});

describe('deriveCourseKeySeed', () => {
  it('equals HKDF-SHA256(ikm=master, salt=SALT, info=PREFIX+course_id, L=32) computed independently', () => {
    // Recomputed from the primitives rather than from the implementation, so
    // this fails if the parameters drift in any way.
    const courseId = 'berkeley-cs61b';
    const expected = hkdf(
      sha256,
      MASTER_A,
      STUDENT_KEY_HKDF_SALT,
      new TextEncoder().encode('provenance-student-key-v1:' + courseId),
      32,
    );
    expect(bytesToHex(deriveCourseKeySeed(MASTER_A, courseId))).toBe(bytesToHex(expected));
  });

  it('is deterministic — same master + same course always yields the same seed', () => {
    const a = deriveCourseKeySeed(MASTER_A, 'berkeley-cs61b');
    const b = deriveCourseKeySeed(MASTER_A, 'berkeley-cs61b');
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('returns exactly 32 bytes', () => {
    expect(deriveCourseKeySeed(MASTER_A, 'berkeley-cs61b').length).toBe(32);
  });

  it('yields UNLINKABLE keys across courses — different course_id, different seed', () => {
    // The whole privacy claim: each course sees a public key that cannot be
    // correlated with the same student's key in another course.
    const b = deriveCourseKeySeed(MASTER_A, 'berkeley-cs61b');
    const c = deriveCourseKeySeed(MASTER_A, 'berkeley-cs61c');
    expect(bytesToHex(b)).not.toBe(bytesToHex(c));
  });

  it('yields different keys for different students in the same course', () => {
    const a = deriveCourseKeySeed(MASTER_A, 'berkeley-cs61b');
    const b = deriveCourseKeySeed(MASTER_B, 'berkeley-cs61b');
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('does not confuse a course id prefix with a longer one', () => {
    // 'cs61b' vs 'cs61b-extra': the separator is inside the fixed prefix, so
    // ensure no accidental concatenation collision.
    const a = deriveCourseKeySeed(MASTER_A, 'cs61b');
    const b = deriveCourseKeySeed(MASTER_A, 'cs61b-extra');
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('UTF-8 encodes a non-ASCII course id (course_id is a VALUE, never an object key)', () => {
    const courseId = 'berkeley-café';
    const expected = hkdf(
      sha256,
      MASTER_A,
      STUDENT_KEY_HKDF_SALT,
      new TextEncoder().encode('provenance-student-key-v1:' + courseId),
      32,
    );
    expect(bytesToHex(deriveCourseKeySeed(MASTER_A, courseId))).toBe(bytesToHex(expected));
  });

  it('throws on an empty course id', () => {
    expect(() => deriveCourseKeySeed(MASTER_A, '')).toThrow();
  });

  it('throws on a master secret that is not 32 bytes', () => {
    expect(() => deriveCourseKeySeed(new Uint8Array(16).fill(1), 'berkeley-cs61b')).toThrow();
  });
});

describe('deriveCourseKeypair', () => {
  it('returns the derived seed as the private key and its matching ed25519 public key', async () => {
    const kp = await deriveCourseKeypair(MASTER_A, 'berkeley-cs61b');
    const expectedSeed = deriveCourseKeySeed(MASTER_A, 'berkeley-cs61b');
    expect(bytesToHex(kp.privateKey)).toBe(bytesToHex(expectedSeed));
    expect(kp.publicKeyHex).toBe(bytesToHex(await ed.getPublicKeyAsync(expectedSeed)));
  });

  it('produces a key that actually signs and verifies', async () => {
    const kp = await deriveCourseKeypair(MASTER_A, 'berkeley-cs61b');
    const msg = new TextEncoder().encode('attribution');
    const sig = await ed.signAsync(msg, kp.privateKey);
    expect(await ed.verifyAsync(sig, msg, hexToBytes(kp.publicKeyHex))).toBe(true);
  });

  it('is deterministic across calls', async () => {
    const a = await deriveCourseKeypair(MASTER_A, 'berkeley-cs61b');
    const b = await deriveCourseKeypair(MASTER_A, 'berkeley-cs61b');
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
  });
});

// ---------------------------------------------------------------------------
// The CURRENT derivation: one global student key, fixed info
// ---------------------------------------------------------------------------

describe('deriveStudentKeySeed', () => {
  it('pins the fixed info string exactly', () => {
    // Three ports derive against this literal. A change here is a silent
    // cross-repo divergence, not a refactor.
    expect(STUDENT_KEY_HKDF_INFO).toBe('provenance-student-key-v2');
  });

  it('carries NO user-derived component, so the UTF-8 encoding hazard cannot arise', () => {
    // The v1 prefix concatenates a course_id, and a port encoding that as
    // US_ASCII rather than UTF-8 silently derives a different key with no error
    // — it bit provjet once. Nothing is concatenated onto v2, and the constant is
    // pure ASCII, so there is nothing left to get wrong.
    expect(STUDENT_KEY_HKDF_INFO.endsWith(':')).toBe(false);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(STUDENT_KEY_HKDF_INFO)).toBe(true);
  });

  it('equals HKDF-SHA256(ikm=master, salt=SALT, info=INFO, L=32) computed independently', () => {
    // Recomputed from the primitives rather than from the implementation, so
    // this fails if any parameter drifts.
    const expected = hkdf(
      sha256,
      MASTER_A,
      STUDENT_KEY_HKDF_SALT,
      new TextEncoder().encode(STUDENT_KEY_HKDF_INFO),
      STUDENT_KEY_SEED_BYTES,
    );
    expect(bytesToHex(deriveStudentKeySeed(MASTER_A))).toBe(bytesToHex(expected));
  });

  it('is deterministic', () => {
    expect(bytesToHex(deriveStudentKeySeed(MASTER_A))).toBe(
      bytesToHex(deriveStudentKeySeed(MASTER_A)),
    );
  });

  it('returns 32 bytes, used directly as the ed25519 seed', () => {
    expect(deriveStudentKeySeed(MASTER_A).length).toBe(STUDENT_KEY_SEED_BYTES);
  });

  it('gives different students different keys', () => {
    expect(bytesToHex(deriveStudentKeySeed(MASTER_A))).not.toBe(
      bytesToHex(deriveStudentKeySeed(MASTER_B)),
    );
  });

  it('is UNRELATED to the legacy per-course derivation from the same master', () => {
    // Different info, so a student's existing course keys are untouched and an
    // archived bundle keeps verifying against the pubkey its token names.
    const global = bytesToHex(deriveStudentKeySeed(MASTER_A));
    for (const courseId of ['berkeley-cs61b', 'berkeley-cs61c', '']) {
      if (courseId === '') continue;
      expect(global).not.toBe(bytesToHex(deriveCourseKeySeed(MASTER_A, courseId)));
    }
  });

  it('rejects a master secret of the wrong length', () => {
    expect(() => deriveStudentKeySeed(new Uint8Array(31))).toThrow(TypeError);
    expect(() => deriveStudentKeySeed(new Uint8Array(33))).toThrow(TypeError);
  });
});

describe('deriveStudentKeypair', () => {
  it('returns the seed verbatim as the private key, with its ed25519 public key', async () => {
    const kp = await deriveStudentKeypair(MASTER_A);
    const seed = deriveStudentKeySeed(MASTER_A);
    expect(bytesToHex(kp.privateKey)).toBe(bytesToHex(seed));
    expect(kp.publicKeyHex).toBe(bytesToHex(await ed.getPublicKeyAsync(seed)));
  });

  it('gives a student ONE key across every course', async () => {
    // The whole point of the change: no course_id enters the derivation, so
    // there is nothing to vary and nothing to obtain a second time.
    const a = await deriveStudentKeypair(MASTER_A);
    const b = await deriveStudentKeypair(MASTER_A);
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
  });
});

describe('generateStudentMasterSecret', () => {
  it('returns 32 bytes', () => {
    expect(generateStudentMasterSecret().length).toBe(STUDENT_MASTER_SECRET_BYTES);
  });

  it('returns a different value each call', () => {
    // Not a determinism assertion — this is the one thing that must NOT be
    // deterministic. Two 32-byte random draws colliding is impossible in practice.
    expect(bytesToHex(generateStudentMasterSecret())).not.toBe(
      bytesToHex(generateStudentMasterSecret()),
    );
  });
});
