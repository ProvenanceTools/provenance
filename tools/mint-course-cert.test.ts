import { describe, it, expect } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as ed from '@noble/ed25519';
import { verifyCourseCert } from '@provenance/log-core';
import { parseMintArgs, mintCourseCert, DEFAULT_ROOT_KEYPAIR_PATH } from './mint-course-cert.js';

// Fixed, deterministic ed25519 seeds — NOT the real dev root, NOT the
// conformance-vector root (seed 0x0a in export-conformance-vectors.ts).
// Just distinct fixed bytes for this test file's own use.
function seed(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function testRootKeypair() {
  const priv = seed(0xf1);
  const pub = await ed.getPublicKeyAsync(priv);
  return {
    public_key_hex: bytesToHex(pub),
    private_key_hex: bytesToHex(priv),
  };
}

describe('parseMintArgs', () => {
  const base = [
    '--course-id',
    'berkeley-cs61b',
    '--course-pubkey',
    'a'.repeat(64),
    '--valid-from',
    '2026-08-20',
    '--valid-until',
    '2027-01-15',
  ];

  it('parses a full valid argv with defaults for --root-keypair and --out', () => {
    const result = parseMintArgs(base, '/default/root-keypair.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      courseId: 'berkeley-cs61b',
      coursePubkeyHex: 'a'.repeat(64),
      validFrom: '2026-08-20',
      validUntil: '2027-01-15',
      rootKeypairPath: '/default/root-keypair.json',
      outPath: null,
    });
  });

  it('honours DEFAULT_ROOT_KEYPAIR_PATH when no default is passed explicitly', () => {
    const result = parseMintArgs(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rootKeypairPath).toBe(DEFAULT_ROOT_KEYPAIR_PATH);
  });

  it('respects --root-keypair and --out overrides', () => {
    const result = parseMintArgs([
      ...base,
      '--root-keypair',
      '/secure/root.json',
      '--out',
      '/tmp/cs61b-cert.json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rootKeypairPath).toBe('/secure/root.json');
    expect(result.value.outPath).toBe('/tmp/cs61b-cert.json');
  });

  it('rejects a missing --course-id', () => {
    const result = parseMintArgs(base.filter((_, i) => i < 0 || i >= 2));
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown flag', () => {
    const result = parseMintArgs([...base, '--bogus', 'x']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Unknown argument');
  });

  it('rejects a flag with no following value', () => {
    const result = parseMintArgs([...base, '--out']);
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed --course-pubkey (wrong length)', () => {
    const args = [
      '--course-id',
      'x',
      '--course-pubkey',
      'ab',
      '--valid-from',
      '2026-08-20',
      '--valid-until',
      '2027-01-15',
    ];
    const result = parseMintArgs(args);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('--course-pubkey');
  });

  it('rejects an unparseable --valid-from', () => {
    const args = [
      '--course-id',
      'x',
      '--course-pubkey',
      'a'.repeat(64),
      '--valid-from',
      'not-a-date',
      '--valid-until',
      '2027-01-15',
    ];
    const result = parseMintArgs(args);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('--valid-from');
  });

  it('rejects --valid-until earlier than --valid-from', () => {
    const args = [
      '--course-id',
      'x',
      '--course-pubkey',
      'a'.repeat(64),
      '--valid-from',
      '2027-01-15',
      '--valid-until',
      '2026-08-20',
    ];
    const result = parseMintArgs(args);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('--valid-until must not be earlier');
  });
});

describe('mintCourseCert', () => {
  it('signs a cert that self-verifies against the root public key', async () => {
    const rootKeypair = await testRootKeypair();
    const result = await mintCourseCert(
      {
        courseId: 'berkeley-cs61b',
        coursePubkeyHex: 'b'.repeat(64),
        validFrom: '2026-08-20',
        validUntil: '2027-01-15',
      },
      rootKeypair,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.course_id).toBe('berkeley-cs61b');
    expect(result.value.course_pubkey).toBe('b'.repeat(64));

    // Independent re-verification (not just the tool's internal self-check).
    const reverified = await verifyCourseCert(result.value, rootKeypair.public_key_hex);
    expect(reverified.ok).toBe(true);
  });

  it('produces a signature that fails against a DIFFERENT root public key', async () => {
    const rootKeypair = await testRootKeypair();
    const otherRootPub = bytesToHex(await ed.getPublicKeyAsync(seed(0xf2)));

    const result = await mintCourseCert(
      {
        courseId: 'berkeley-cs61c',
        coursePubkeyHex: 'c'.repeat(64),
        validFrom: '2026-08-20',
        validUntil: '2027-01-15',
      },
      rootKeypair,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reverified = await verifyCourseCert(result.value, otherRootPub);
    expect(reverified.ok).toBe(false);
  });

  it('rejects a malformed root keypair public key before signing anything', async () => {
    const result = await mintCourseCert(
      {
        courseId: 'berkeley-cs61b',
        coursePubkeyHex: 'b'.repeat(64),
        validFrom: '2026-08-20',
        validUntil: '2027-01-15',
      },
      { public_key_hex: 'too-short', private_key_hex: bytesToHex(seed(0xf1)) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects a malformed root keypair private key', async () => {
    const rootPub = bytesToHex(await ed.getPublicKeyAsync(seed(0xf1)));
    const result = await mintCourseCert(
      {
        courseId: 'berkeley-cs61b',
        coursePubkeyHex: 'b'.repeat(64),
        validFrom: '2026-08-20',
        validUntil: '2027-01-15',
      },
      { public_key_hex: rootPub, private_key_hex: 'zz' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });
});
