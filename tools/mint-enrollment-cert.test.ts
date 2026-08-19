import { describe, it, expect } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as ed from '@noble/ed25519';
import { verifyEnrollmentCert, parseEnrollmentCert } from '@provenance/log-core';
import {
  parseMintEnrollmentArgs,
  mintEnrollmentCert,
  DEFAULT_COURSE_KEYPAIR_PATH,
} from './mint-enrollment-cert.js';

// Fixed, deterministic ed25519 seeds — NOT the real dev course key, NOT the
// conformance-vector course key (seed 0x0b in export-conformance-vectors.ts).
// Just distinct fixed bytes for this test file's own use.
function seed(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function testCourseKeypair() {
  const priv = seed(0xf3);
  const pub = await ed.getPublicKeyAsync(priv);
  return { public_key_hex: bytesToHex(pub), private_key_hex: bytesToHex(priv) };
}

const ENROLLMENT_PUBKEY = bytesToHex(new Uint8Array(32).fill(0xab));

describe('parseMintEnrollmentArgs', () => {
  const base = [
    '--course-id',
    'berkeley-cs61b',
    '--enrollment-pubkey',
    ENROLLMENT_PUBKEY,
    '--valid-from',
    '2026-08-20',
    '--valid-until',
    '2027-01-15',
  ];

  it('parses the four required flags', () => {
    const r = parseMintEnrollmentArgs(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.courseId).toBe('berkeley-cs61b');
      expect(r.value.enrollmentPubkeyHex).toBe(ENROLLMENT_PUBKEY);
      expect(r.value.validFrom).toBe('2026-08-20');
      expect(r.value.validUntil).toBe('2027-01-15');
    }
  });

  it('defaults the course keypair path and leaves --out null', () => {
    const r = parseMintEnrollmentArgs(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.courseKeypairPath).toBe(DEFAULT_COURSE_KEYPAIR_PATH);
      expect(r.value.outPath).toBeNull();
    }
  });

  it('honours an explicit --course-keypair and --out', () => {
    const r = parseMintEnrollmentArgs([
      ...base,
      '--course-keypair',
      '/secure/course.json',
      '--out',
      '/tmp/cert.json',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.courseKeypairPath).toBe('/secure/course.json');
      expect(r.value.outPath).toBe('/tmp/cert.json');
    }
  });

  it.each(['--course-id', '--enrollment-pubkey', '--valid-from', '--valid-until'])(
    'rejects a missing %s',
    (flag) => {
      const idx = base.indexOf(flag);
      const without = [...base.slice(0, idx), ...base.slice(idx + 2)];
      const r = parseMintEnrollmentArgs(without);
      expect(r.ok).toBe(false);
    },
  );

  it('rejects an unknown argument', () => {
    expect(parseMintEnrollmentArgs([...base, '--nope', 'x']).ok).toBe(false);
  });

  it('rejects a flag with no value', () => {
    expect(parseMintEnrollmentArgs(['--course-id']).ok).toBe(false);
  });

  it('rejects a non-hex enrollment pubkey', () => {
    const r = parseMintEnrollmentArgs([
      '--course-id',
      'x',
      '--enrollment-pubkey',
      'not-hex',
      '--valid-from',
      '2026-08-20',
      '--valid-until',
      '2027-01-15',
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects an unparseable validity bound', () => {
    const r = parseMintEnrollmentArgs([
      ...base.slice(0, 4),
      '--valid-from',
      'next term',
      '--valid-until',
      '2027-01-15',
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects valid_until earlier than valid_from', () => {
    const r = parseMintEnrollmentArgs([
      ...base.slice(0, 4),
      '--valid-from',
      '2027-01-15',
      '--valid-until',
      '2026-08-20',
    ]);
    expect(r.ok).toBe(false);
  });
});

describe('mintEnrollmentCert', () => {
  const unsigned = {
    courseId: 'berkeley-cs61b',
    enrollmentPubkeyHex: ENROLLMENT_PUBKEY,
    validFrom: '2026-08-20',
    validUntil: '2027-01-15',
  };

  it('mints a cert that verifies against the course public key', async () => {
    const kp = await testCourseKeypair();
    const r = await mintEnrollmentCert(unsigned, kp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((await verifyEnrollmentCert(r.value, kp.public_key_hex)).ok).toBe(true);
    }
  });

  it('stamps format_version 2.0 into the signed payload', async () => {
    const r = await mintEnrollmentCert(unsigned, await testCourseKeypair());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.format_version).toBe('2.0');
  });

  it('produces a cert that passes shape validation', async () => {
    const r = await mintEnrollmentCert(unsigned, await testCourseKeypair());
    expect(r.ok).toBe(true);
    if (r.ok) expect(parseEnrollmentCert(r.value).ok).toBe(true);
  });

  it('is deterministic — ed25519 signatures are, so the same inputs give the same cert', async () => {
    const kp = await testCourseKeypair();
    const a = await mintEnrollmentCert(unsigned, kp);
    const b = await mintEnrollmentCert(unsigned, kp);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.course_sig).toBe(b.value.course_sig);
  });

  it('does NOT verify against an unrelated course key', async () => {
    const kp = await testCourseKeypair();
    const other = bytesToHex(await ed.getPublicKeyAsync(seed(0xf4)));
    const r = await mintEnrollmentCert(unsigned, kp);
    expect(r.ok).toBe(true);
    if (r.ok) expect((await verifyEnrollmentCert(r.value, other)).ok).toBe(false);
  });

  it('rejects a malformed course public key', async () => {
    const r = await mintEnrollmentCert(unsigned, {
      public_key_hex: 'short',
      private_key_hex: bytesToHex(seed(0xf3)),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects a malformed course private key', async () => {
    const r = await mintEnrollmentCert(unsigned, {
      public_key_hex: bytesToHex(seed(0xf3)),
      private_key_hex: 'nope',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('fails self-verification when the keypair halves do not match', async () => {
    // public_key_hex is well-formed but is NOT the public half of private_key_hex,
    // so the signature cannot verify against it. The tool must catch its own bad
    // output rather than emitting a cert nobody can use.
    const r = await mintEnrollmentCert(unsigned, {
      public_key_hex: bytesToHex(await ed.getPublicKeyAsync(seed(0xf4))),
      private_key_hex: bytesToHex(seed(0xf3)),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('self_verification_failed');
  });
});
