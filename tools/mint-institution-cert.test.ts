import { describe, it, expect } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as ed from '@noble/ed25519';
import { verifyInstitutionCert, INSTITUTION_IDENTITY_FORMAT_VERSION } from '@provenance/log-core';
import {
  parseMintInstitutionArgs,
  mintInstitutionCert,
  DEFAULT_ROOT_KEYPAIR_PATH,
} from './mint-institution-cert.js';

// Fixed, deterministic ed25519 seeds — NOT the real dev root, NOT the
// conformance-vector root (seed 0x0a in export-conformance-vectors.ts).
// Just distinct fixed bytes for this test file's own use.
function seed(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function testRootKeypair() {
  const priv = seed(0xe1);
  const pub = await ed.getPublicKeyAsync(priv);
  return {
    public_key_hex: bytesToHex(pub),
    private_key_hex: bytesToHex(priv),
  };
}

describe('parseMintInstitutionArgs', () => {
  const base = [
    '--institution-id',
    'berkeley',
    '--institution-pubkey',
    'a'.repeat(64),
    '--valid-from',
    '2026-08-20',
    '--valid-until',
    '2027-08-19',
  ];

  it('parses a full valid argv with defaults for --root-keypair and --out', () => {
    const result = parseMintInstitutionArgs(base, '/default/root-keypair.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      institutionId: 'berkeley',
      institutionPubkeyHex: 'a'.repeat(64),
      validFrom: '2026-08-20',
      validUntil: '2027-08-19',
      rootKeypairPath: '/default/root-keypair.json',
      outPath: null,
    });
  });

  it('honours DEFAULT_ROOT_KEYPAIR_PATH when no default is passed explicitly', () => {
    const result = parseMintInstitutionArgs(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rootKeypairPath).toBe(DEFAULT_ROOT_KEYPAIR_PATH);
  });

  it('respects --root-keypair and --out overrides', () => {
    const result = parseMintInstitutionArgs([
      ...base,
      '--root-keypair',
      '/secure/root.json',
      '--out',
      '/tmp/berkeley-institution-cert.json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rootKeypairPath).toBe('/secure/root.json');
    expect(result.value.outPath).toBe('/tmp/berkeley-institution-cert.json');
  });

  it('rejects a missing --institution-id', () => {
    const result = parseMintInstitutionArgs(base.slice(2));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('--institution-id');
  });

  it('rejects an unknown flag', () => {
    const result = parseMintInstitutionArgs([...base, '--bogus', 'x']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Unknown argument');
  });

  it('rejects a course-cert flag borrowed from the sibling tool', () => {
    const result = parseMintInstitutionArgs([...base, '--course-id', 'berkeley-cs61b']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Unknown argument');
  });

  it('rejects a flag with no following value', () => {
    const result = parseMintInstitutionArgs([...base, '--out']);
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed --institution-pubkey (wrong length)', () => {
    const result = parseMintInstitutionArgs([
      '--institution-id',
      'berkeley',
      '--institution-pubkey',
      'ab',
      '--valid-from',
      '2026-08-20',
      '--valid-until',
      '2027-08-19',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('--institution-pubkey');
  });

  it('rejects an uppercase --institution-pubkey', () => {
    const result = parseMintInstitutionArgs([
      '--institution-id',
      'berkeley',
      '--institution-pubkey',
      'A'.repeat(64),
      '--valid-from',
      '2026-08-20',
      '--valid-until',
      '2027-08-19',
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects an unparseable --valid-from', () => {
    const result = parseMintInstitutionArgs([
      '--institution-id',
      'berkeley',
      '--institution-pubkey',
      'a'.repeat(64),
      '--valid-from',
      'not-a-date',
      '--valid-until',
      '2027-08-19',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('--valid-from');
  });

  it('rejects --valid-until earlier than --valid-from', () => {
    const result = parseMintInstitutionArgs([
      '--institution-id',
      'berkeley',
      '--institution-pubkey',
      'a'.repeat(64),
      '--valid-from',
      '2027-08-19',
      '--valid-until',
      '2026-08-20',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('--valid-until must not be earlier');
  });
});

describe('mintInstitutionCert', () => {
  it('signs a cert that self-verifies against the root public key', async () => {
    const rootKeypair = await testRootKeypair();
    const result = await mintInstitutionCert(
      {
        institutionId: 'berkeley',
        institutionPubkeyHex: 'b'.repeat(64),
        validFrom: '2026-08-20',
        validUntil: '2027-08-19',
      },
      rootKeypair,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.institution_id).toBe('berkeley');
    expect(result.value.institution_pubkey).toBe('b'.repeat(64));
    expect(result.value.root_sig).toMatch(/^[0-9a-f]{128}$/);

    // Independent re-verification (not just the tool's internal self-check).
    const reverified = await verifyInstitutionCert(result.value, rootKeypair.public_key_hex);
    expect(reverified.ok).toBe(true);
  });

  it('stamps the 2.1 format_version rather than taking one from the caller', async () => {
    const rootKeypair = await testRootKeypair();
    const result = await mintInstitutionCert(
      {
        institutionId: 'berkeley',
        institutionPubkeyHex: 'b'.repeat(64),
        validFrom: '2026-08-20',
        validUntil: '2027-08-19',
      },
      rootKeypair,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.format_version).toBe(INSTITUTION_IDENTITY_FORMAT_VERSION);
    expect(result.value.format_version).toBe('2.1');
  });

  it('produces a signature that fails against a DIFFERENT root public key', async () => {
    const rootKeypair = await testRootKeypair();
    const otherRootPub = bytesToHex(await ed.getPublicKeyAsync(seed(0xe2)));

    const result = await mintInstitutionCert(
      {
        institutionId: 'stanford',
        institutionPubkeyHex: 'c'.repeat(64),
        validFrom: '2026-08-20',
        validUntil: '2027-08-19',
      },
      rootKeypair,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reverified = await verifyInstitutionCert(result.value, otherRootPub);
    expect(reverified.ok).toBe(false);
  });

  it('binds institution_id — a tampered id no longer verifies', async () => {
    const rootKeypair = await testRootKeypair();
    const result = await mintInstitutionCert(
      {
        institutionId: 'berkeley',
        institutionPubkeyHex: 'b'.repeat(64),
        validFrom: '2026-08-20',
        validUntil: '2027-08-19',
      },
      rootKeypair,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tampered = { ...result.value, institution_id: 'stanford' };
    const reverified = await verifyInstitutionCert(tampered, rootKeypair.public_key_hex);
    expect(reverified.ok).toBe(false);
  });

  it('rejects a malformed root keypair public key before signing anything', async () => {
    const result = await mintInstitutionCert(
      {
        institutionId: 'berkeley',
        institutionPubkeyHex: 'b'.repeat(64),
        validFrom: '2026-08-20',
        validUntil: '2027-08-19',
      },
      { public_key_hex: 'too-short', private_key_hex: bytesToHex(seed(0xe1)) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects a malformed root keypair private key', async () => {
    const rootPub = bytesToHex(await ed.getPublicKeyAsync(seed(0xe1)));
    const result = await mintInstitutionCert(
      {
        institutionId: 'berkeley',
        institutionPubkeyHex: 'b'.repeat(64),
        validFrom: '2026-08-20',
        validUntil: '2027-08-19',
      },
      { public_key_hex: rootPub, private_key_hex: 'zz' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('detects a root keypair whose halves do not pair, via self-verification', async () => {
    const mismatchedPub = bytesToHex(await ed.getPublicKeyAsync(seed(0xe2)));
    const result = await mintInstitutionCert(
      {
        institutionId: 'berkeley',
        institutionPubkeyHex: 'b'.repeat(64),
        validFrom: '2026-08-20',
        validUntil: '2027-08-19',
      },
      { public_key_hex: mismatchedPub, private_key_hex: bytesToHex(seed(0xe1)) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('self_verification_failed');
  });
});
