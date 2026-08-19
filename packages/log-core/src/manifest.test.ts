import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  parseManifest,
  verifyManifest,
  signManifest,
  verifyManifestChain,
  manifestFormatVersion,
} from './manifest.js';
import type { Manifest } from './manifest.js';
import { signCourseCert, verifyCourseCert } from './course-cert.js';
import type { CourseCert } from './course-cert.js';
import { canonicalize } from './canonical.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the signed payload bytes for a manifest (mirrors buildSignedPayload in manifest.ts).
 * The sig field is excluded.
 */
function buildPayload(fields: {
  assignment_id: string;
  semester: string;
  issued_at: string;
  files_under_review: readonly string[];
}): Uint8Array {
  const canonical = canonicalize({
    assignment_id: fields.assignment_id,
    semester: fields.semester,
    issued_at: fields.issued_at,
    files_under_review: fields.files_under_review,
  });
  return new TextEncoder().encode(canonical);
}

/**
 * Generate an ed25519 keypair, sign a manifest payload, and return the manifest JSON text
 * along with the public key hex.
 */
async function makeSignedManifest(overrideFields?: {
  assignment_id?: string;
  semester?: string;
  issued_at?: string;
  files_under_review?: string[];
}): Promise<{ text: string; pubkeyHex: string; secretKey: Uint8Array }> {
  const fields = {
    assignment_id: overrideFields?.assignment_id ?? 'hw03',
    semester: overrideFields?.semester ?? 'fa26',
    issued_at: overrideFields?.issued_at ?? '2026-09-15T00:00:00Z',
    files_under_review: overrideFields?.files_under_review ?? ['hw03.py'],
  };

  const secretKey = ed.utils.randomSecretKey();
  const pubkeyBytes = await ed.getPublicKeyAsync(secretKey);
  const pubkeyHex = bytesToHex(pubkeyBytes);

  const payload = buildPayload(fields);
  const sigBytes = await ed.signAsync(payload, secretKey);
  const sigHex = bytesToHex(sigBytes);

  const manifest = { ...fields, sig: sigHex };
  return { text: JSON.stringify(manifest), pubkeyHex, secretKey };
}

// ---------------------------------------------------------------------------
// parseManifest tests
// ---------------------------------------------------------------------------

describe('parseManifest', () => {
  it('parses a valid manifest JSON string', async () => {
    const { text } = await makeSignedManifest();
    const result = parseManifest(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assignment_id).toBe('hw03');
    expect(result.value.semester).toBe('fa26');
    expect(result.value.issued_at).toBe('2026-09-15T00:00:00Z');
    expect(result.value.files_under_review).toEqual(['hw03.py']);
    expect(result.value.sig).toHaveLength(128);
  });

  it('rejects garbage JSON', () => {
    const result = parseManifest('this is not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_json');
    }
  });

  it('rejects valid JSON that is not an object', () => {
    const result = parseManifest('"just a string"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_shape');
    }
  });

  it('rejects missing assignment_id', () => {
    const obj = {
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
      sig: 'a'.repeat(128),
    };
    const result = parseManifest(JSON.stringify(obj));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_shape');
    }
  });

  it('rejects missing files_under_review', () => {
    const obj = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      sig: 'a'.repeat(128),
    };
    const result = parseManifest(JSON.stringify(obj));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_shape');
    }
  });

  it('rejects a sig that is not 128 hex chars', () => {
    const obj = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
      sig: 'tooshort',
    };
    const result = parseManifest(JSON.stringify(obj));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_shape');
      if (result.error.kind === 'invalid_shape') {
        expect(result.error.field).toBe('sig');
        expect(result.error.reason).toBe('must be a 128-char hex string');
      }
    }
  });

  it('rejects missing sig field', () => {
    const obj = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const result = parseManifest(JSON.stringify(obj));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_shape');
      if (result.error.kind === 'invalid_shape') {
        expect(result.error.field).toBe('sig');
        expect(result.error.reason).toBe('missing');
      }
    }
  });

  it('rejects files_under_review containing non-string elements', () => {
    const obj = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: [42],
      sig: 'a'.repeat(128),
    };
    const result = parseManifest(JSON.stringify(obj));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_shape');
    }
  });
});

// ---------------------------------------------------------------------------
// verifyManifest tests
// ---------------------------------------------------------------------------

describe('verifyManifest', () => {
  it('happy path: parse + verify a freshly signed manifest', async () => {
    const { text, pubkeyHex } = await makeSignedManifest();
    const parseResult = parseManifest(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const verifyResult = await verifyManifest(parseResult.value, pubkeyHex);
    expect(verifyResult.ok).toBe(true);
    if (!verifyResult.ok) return;
    expect(verifyResult.value).toBe(true);
  });

  it('rejects when sig is over different content (tampered manifest)', async () => {
    const { text, pubkeyHex } = await makeSignedManifest();
    const parseResult = parseManifest(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    // Tamper: change assignment_id AFTER signature was produced
    const tampered = { ...parseResult.value, assignment_id: 'hw99' };
    const verifyResult = await verifyManifest(tampered, pubkeyHex);
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.error.kind).toBe('invalid_signature');
    }
  });

  it('rejects when the wrong public key is supplied', async () => {
    const { text } = await makeSignedManifest();
    const parseResult = parseManifest(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    // Generate a DIFFERENT keypair — its pubkey won't match the signature
    const wrongSecretKey = ed.utils.randomSecretKey();
    const wrongPubkeyBytes = await ed.getPublicKeyAsync(wrongSecretKey);
    const wrongPubkeyHex = bytesToHex(wrongPubkeyBytes);

    const verifyResult = await verifyManifest(parseResult.value, wrongPubkeyHex);
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.error.kind).toBe('invalid_signature');
    }
  });

  it('rejects when pubkey is not 64 hex chars', async () => {
    const { text } = await makeSignedManifest();
    const parseResult = parseManifest(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const verifyResult = await verifyManifest(parseResult.value, 'tooshort');
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.error.kind).toBe('invalid_signature');
    }
  });

  it('signed payload excludes the sig field — signing same payload verifies', async () => {
    // Directly construct a manifest, sign the payload bytes, verify via verifyManifest
    const fields = {
      assignment_id: 'proj01',
      semester: 'sp27',
      issued_at: '2027-01-15T00:00:00Z',
      files_under_review: ['proj01.py', 'utils.py'],
    };

    const secretKey = ed.utils.randomSecretKey();
    const pubkeyBytes = await ed.getPublicKeyAsync(secretKey);
    const pubkeyHex = bytesToHex(pubkeyBytes);

    const payloadBytes = buildPayload(fields);
    const sigBytes = await ed.signAsync(payloadBytes, secretKey);

    // Build a manifest object with the sig and parse it
    const manifestJson = JSON.stringify({ ...fields, sig: bytesToHex(sigBytes) });
    const parseResult = parseManifest(manifestJson);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const verifyResult = await verifyManifest(parseResult.value, pubkeyHex);
    expect(verifyResult.ok).toBe(true);
  });

  it('rejects when sig bytes are over different content (manual byte-level test)', async () => {
    // Sign one payload, try to verify against a manifest with different fields
    const secretKey = ed.utils.randomSecretKey();
    const pubkeyBytes = await ed.getPublicKeyAsync(secretKey);
    const pubkeyHex = bytesToHex(pubkeyBytes);

    // Sign payload for hw03
    const payload = buildPayload({
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    });
    const sigBytes = await ed.signAsync(payload, secretKey);
    const sigHex = bytesToHex(sigBytes);

    // But use sig in a manifest with a different assignment_id
    const tampered = {
      assignment_id: 'hw04', // different!
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
      sig: sigHex,
    };
    const parseResult = parseManifest(JSON.stringify(tampered));
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const verifyResult = await verifyManifest(parseResult.value, pubkeyHex);
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.error.kind).toBe('invalid_signature');
    }
  });

  it('verifyManifest handles a pubkey that is valid hex length but not an actual ed25519 key', async () => {
    const { text } = await makeSignedManifest();
    const parseResult = parseManifest(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    // All-zeros is a syntactically valid 64-hex-char string but not a valid pubkey for this sig
    const zeroPubkey = '0'.repeat(64);
    const verifyResult = await verifyManifest(parseResult.value, zeroPubkey);
    // Should either return invalid_signature or (if the library throws) also invalid_signature
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.error.kind).toBe('invalid_signature');
    }
  });

  it('hexToBytes and bytesToHex round-trip for a known public key', async () => {
    // Sanity check that the hex helpers we use in the implementation work correctly
    const secretKey = ed.utils.randomSecretKey();
    const pubkeyBytes = await ed.getPublicKeyAsync(secretKey);
    const hex = bytesToHex(pubkeyBytes);
    const roundTripped = hexToBytes(hex);
    expect(roundTripped).toEqual(pubkeyBytes);
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });
});

// ---------------------------------------------------------------------------
// signManifest tests
// ---------------------------------------------------------------------------

describe('signManifest', () => {
  it('produces a 128-hex sig that verifyManifest accepts (round-trip)', async () => {
    const secretKey = ed.utils.randomSecretKey();
    const pubkeyHex = bytesToHex(await ed.getPublicKeyAsync(secretKey));
    const fields = {
      assignment_id: 'hw07',
      semester: 'fa26',
      issued_at: '2026-10-01T00:00:00Z',
      files_under_review: ['hw07.py', 'helpers.py'] as readonly string[],
    };

    const sig = await signManifest(fields, secretKey);
    expect(sig).toHaveLength(128);
    expect(sig).toMatch(/^[0-9a-f]+$/);

    const verified = await verifyManifest({ ...fields, sig }, pubkeyHex);
    expect(verified.ok).toBe(true);
  });

  it('signs the same payload verifyManifest checks (excludes sig field)', async () => {
    const secretKey = ed.utils.randomSecretKey();
    const fields = {
      assignment_id: 'proj01',
      semester: 'sp26',
      issued_at: '2026-02-01T00:00:00Z',
      files_under_review: ['a.py'] as readonly string[],
    };
    const sig = await signManifest(fields, secretKey);
    // The sig must match a hand-rolled signature over the canonical payload bytes.
    const payload = buildPayload(fields);
    const expected = bytesToHex(await ed.signAsync(payload, secretKey));
    expect(sig).toBe(expected);
  });

  it('a tampered field fails verification', async () => {
    const secretKey = ed.utils.randomSecretKey();
    const pubkeyHex = bytesToHex(await ed.getPublicKeyAsync(secretKey));
    const fields = {
      assignment_id: 'hw08',
      semester: 'fa26',
      issued_at: '2026-10-08T00:00:00Z',
      files_under_review: ['hw08.py'] as readonly string[],
    };
    const sig = await signManifest(fields, secretKey);
    const tampered = await verifyManifest({ ...fields, assignment_id: 'hw09', sig }, pubkeyHex);
    expect(tampered.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Manifest 2.0 — program spec §3
// docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md
// ---------------------------------------------------------------------------

const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);

/** Fixed seeds, shared with tools/export-conformance-vectors.ts. */
const ROOT_PRIV = seed(0x0a);
const COURSE_PRIV = seed(0x0b);
const WRONG_ROOT_PRIV = seed(0x0c);
const OTHER_COURSE_PRIV = seed(0x0d);

const V2_POLICY = {
  capture: {
    selection_change: true,
    focus_change: true,
    terminal: true,
    doc_open_close: true,
    inline_content: true,
    heartbeat_interval_ms: 30000,
  },
};

async function pub(priv: Uint8Array): Promise<string> {
  return bytesToHex(await ed.getPublicKeyAsync(priv));
}

/**
 * Build a complete, internally consistent 2.0 manifest.
 *
 * `certOverrides` mutates the cert BEFORE the root signs it, so the cert stays
 * genuinely root-signed — that is what makes the course_id-mismatch case a real
 * forgery test rather than a broken-signature test.
 */
async function makeV2Manifest(opts?: {
  certOverrides?: Partial<Omit<CourseCert, 'root_sig'>>;
  manifestOverrides?: Partial<Manifest>;
  rootPriv?: Uint8Array;
  coursePriv?: Uint8Array;
}): Promise<{ manifest: Manifest; rootPubkeyHex: string }> {
  const rootPriv = opts?.rootPriv ?? ROOT_PRIV;
  const coursePriv = opts?.coursePriv ?? COURSE_PRIV;

  const unsignedCert = {
    course_id: 'berkeley-cs61b',
    course_pubkey: await pub(coursePriv),
    valid_from: '2026-08-20',
    valid_until: '2027-01-15',
    ...opts?.certOverrides,
  };
  const course_cert: CourseCert = {
    ...unsignedCert,
    root_sig: await signCourseCert(unsignedCert, rootPriv),
  };

  const unsigned: Omit<Manifest, 'sig'> = {
    format_version: '2.0',
    course_id: 'berkeley-cs61b',
    assignment_id: 'proj2',
    semester: 'fa26',
    issued_at: '2026-09-08T00:00:00Z',
    files_under_review: ['src/Main.java'],
    collaboration: 'solo',
    submission: 'bundle',
    scope: 'directory',
    policy: V2_POLICY,
    course_cert,
    ...opts?.manifestOverrides,
  };

  return {
    manifest: { ...unsigned, sig: await signManifest(unsigned, coursePriv) },
    rootPubkeyHex: await pub(rootPriv),
  };
}

// ---------------------------------------------------------------------------
// The 1.0 default — non-negotiable
// ---------------------------------------------------------------------------

describe('format_version defaulting', () => {
  it('defaults a MISSING format_version to "1.0" and parses successfully', async () => {
    const { text } = await makeSignedManifest();
    expect(JSON.parse(text)).not.toHaveProperty('format_version');

    const result = parseManifest(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.format_version).toBe('1.0');
    expect(manifestFormatVersion(result.value)).toBe('1.0');
  });

  it('manifestFormatVersion reports 1.0 for a hand-built manifest with no field', () => {
    expect(manifestFormatVersion({})).toBe('1.0');
    expect(manifestFormatVersion({ format_version: '2.0' })).toBe('2.0');
  });

  it('accepts an explicit "1.0" and other 1.x versions', () => {
    for (const version of ['1.0', '1.1', '1.9']) {
      const result = parseManifest(
        JSON.stringify({
          format_version: version,
          assignment_id: 'hw03',
          semester: 'fa26',
          issued_at: '2026-09-15T00:00:00Z',
          files_under_review: ['hw03.py'],
          sig: 'a'.repeat(128),
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.format_version).toBe(version);
    }
  });

  it('rejects an unsupported format_version rather than guessing which rules to canonicalize under', () => {
    const result = parseManifest(
      JSON.stringify({
        format_version: '3.0',
        assignment_id: 'hw03',
        semester: 'fa26',
        issued_at: '2026-09-15T00:00:00Z',
        files_under_review: ['hw03.py'],
        sig: 'a'.repeat(128),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_shape');
    if (result.error.kind !== 'invalid_shape') return;
    expect(result.error.field).toBe('format_version');
  });

  it('rejects a non-string format_version', () => {
    const result = parseManifest(
      JSON.stringify({
        format_version: 2,
        assignment_id: 'hw03',
        semester: 'fa26',
        issued_at: '2026-09-15T00:00:00Z',
        files_under_review: ['hw03.py'],
        sig: 'a'.repeat(128),
      }),
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The 1.0 signed payload MUST NOT MOVE
// ---------------------------------------------------------------------------

describe('1.x signed payload is byte-identical to the pre-2.0 bytes', () => {
  // The exact fields tools/export-conformance-vectors.ts pins as the
  // `manifest.json` vector, with the course key seeded 0x09.
  const PINNED_FIELDS = {
    assignment_id: 'hw3',
    semester: 'fa25',
    issued_at: '2026-07-14T00:00:00Z',
    files_under_review: ['src/main.py', 'src/util.py'] as readonly string[],
  };
  // Produced by the PRE-Manifest-2.0 implementation and committed in both
  // sibling recorder repos (provjet core/src/test/resources/conformance/manifest.json,
  // provnvim tests/conformance/fixtures/manifest.json). If a 2.0 change ever
  // perturbs the 1.x payload, this hex moves and the sibling repos break.
  const PINNED_SIG =
    'c8e897fd64389b0bb86cc804181312a05749e83a4d977088655a8ff6d2d7cb0f' +
    'f0cbe98c9c04b7c833daa8d22fbc911f0cdaf2a5fcc907f19572410ded9ffa0e';
  const PINNED_COURSE_PUBKEY = 'fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618';

  it('reproduces the signature committed in the sibling recorder repos', async () => {
    expect(await signManifest(PINNED_FIELDS, seed(9))).toBe(PINNED_SIG);
  });

  it('still verifies that pinned signature', async () => {
    const verified = await verifyManifest(
      { ...PINNED_FIELDS, sig: PINNED_SIG },
      PINNED_COURSE_PUBKEY,
    );
    expect(verified.ok).toBe(true);
  });

  it('canonicalizes exactly the four legacy fields, in JCS key order, with no format_version', () => {
    expect(canonicalize(PINNED_FIELDS)).toBe(
      '{"assignment_id":"hw3","files_under_review":["src/main.py","src/util.py"],' +
        '"issued_at":"2026-07-14T00:00:00Z","semester":"fa25"}',
    );
  });

  it('produces the same signature whether format_version is absent or an explicit "1.0"', async () => {
    expect(await signManifest({ ...PINNED_FIELDS, format_version: '1.0' }, seed(9))).toBe(
      PINNED_SIG,
    );
  });

  it('ignores stray 2.0 fields on a 1.x manifest — they are not in the 1.x key set', async () => {
    const withStrays: Omit<Manifest, 'sig'> = {
      ...PINNED_FIELDS,
      course_id: 'berkeley-cs61b',
      collaboration: 'group',
      submission: 'git',
      scope: 'repo',
      policy: V2_POLICY,
    };
    expect(await signManifest(withStrays, seed(9))).toBe(PINNED_SIG);
  });

  it('round-trips a parsed 1.x manifest back to the same signature', async () => {
    const parsed = parseManifest(JSON.stringify({ ...PINNED_FIELDS, sig: PINNED_SIG }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // parseManifest stamped format_version: '1.0'; that must not change the bytes.
    expect(parsed.value.format_version).toBe('1.0');
    expect(await signManifest(parsed.value, seed(9))).toBe(PINNED_SIG);
    expect((await verifyManifest(parsed.value, PINNED_COURSE_PUBKEY)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2.0 parsing
// ---------------------------------------------------------------------------

describe('parseManifest 2.0', () => {
  it('parses a complete 2.0 manifest including the inline course_cert', async () => {
    const { manifest } = await makeV2Manifest();
    const result = parseManifest(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.format_version).toBe('2.0');
    expect(result.value.course_id).toBe('berkeley-cs61b');
    expect(result.value.collaboration).toBe('solo');
    expect(result.value.submission).toBe('bundle');
    expect(result.value.scope).toBe('directory');
    expect(result.value.policy).toEqual(V2_POLICY);
    expect(result.value.course_cert?.course_id).toBe('berkeley-cs61b');
  });

  it('ignores unknown top-level keys, which therefore cannot change the signed bytes', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest();
    const result = parseManifest(
      JSON.stringify({ ...manifest, some_future_field: 'ignored', another: [1, 2] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The signature still verifies: the unknown keys were never canonicalized.
    expect((await verifyManifestChain(result.value, rootPubkeyHex)).ok).toBe(true);
  });

  it.each(['course_id', 'collaboration', 'submission', 'scope', 'policy', 'course_cert'])(
    'requires %s at 2.0',
    async (field) => {
      const { manifest } = await makeV2Manifest();
      const partial = { ...manifest } as Record<string, unknown>;
      delete partial[field];
      const result = parseManifest(JSON.stringify(partial));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('invalid_shape');
      if (result.error.kind !== 'invalid_shape') return;
      expect(result.error.field).toBe(field);
    },
  );

  it.each([
    ['collaboration', 'pair'],
    ['submission', 'zip'],
    ['scope', 'workspace'],
  ])('rejects an out-of-enum %s', async (field, value) => {
    const { manifest } = await makeV2Manifest();
    const result = parseManifest(JSON.stringify({ ...manifest, [field]: value }));
    expect(result.ok).toBe(false);
  });

  it('accepts collaboration=group / submission=git / scope=repo (the 61B shape)', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest({
      manifestOverrides: { collaboration: 'group', submission: 'git', scope: 'repo' },
    });
    const result = parseManifest(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await verifyManifestChain(result.value, rootPubkeyHex)).ok).toBe(true);
  });

  it('surfaces a malformed course_cert field with a namespaced path', async () => {
    const { manifest } = await makeV2Manifest();
    const result = parseManifest(
      JSON.stringify({
        ...manifest,
        course_cert: { ...manifest.course_cert, course_pubkey: 'nope' },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.kind !== 'invalid_shape') throw new Error('expected invalid_shape');
    expect(result.error.field).toBe('course_cert.course_pubkey');
  });
});

// ---------------------------------------------------------------------------
// 2.0 signed payload
// ---------------------------------------------------------------------------

describe('2.0 signed payload', () => {
  it('excludes BOTH sig and course_cert — the course does not sign its own cert', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest();

    // Swapping in a DIFFERENT but still root-signed cert for the same course
    // leaves the course signature intact: course_cert is outside the payload.
    const otherCertUnsigned = {
      course_id: 'berkeley-cs61b',
      course_pubkey: await pub(COURSE_PRIV),
      valid_from: '2026-01-01',
      valid_until: '2026-12-31',
    };
    const swapped: Manifest = {
      ...manifest,
      course_cert: {
        ...otherCertUnsigned,
        root_sig: await signCourseCert(otherCertUnsigned, ROOT_PRIV),
      },
    };
    expect((await verifyManifest(swapped, await pub(COURSE_PRIV))).ok).toBe(true);
    expect((await verifyManifestChain(swapped, rootPubkeyHex)).ok).toBe(true);
  });

  it('covers every other named field: tampering with any of them breaks the sig', async () => {
    const { manifest } = await makeV2Manifest();
    const coursePubkey = await pub(COURSE_PRIV);
    const tampers: Array<Partial<Manifest>> = [
      { course_id: 'berkeley-cs61c' },
      { assignment_id: 'proj3' },
      { semester: 'sp27' },
      { issued_at: '2026-10-01T00:00:00Z' },
      { files_under_review: ['src/Other.java'] },
      { collaboration: 'group' },
      { submission: 'git' },
      { scope: 'repo' },
      { policy: { capture: { selection_change: false } } },
    ];
    for (const tamper of tampers) {
      const result = await verifyManifest({ ...manifest, ...tamper }, coursePubkey);
      expect(result.ok, `tampering with ${Object.keys(tamper)[0]} should break the sig`).toBe(
        false,
      );
    }
  });

  it('includes format_version, so a 1.x-shaped payload cannot be replayed as 2.0', async () => {
    const { manifest } = await makeV2Manifest();
    const asLegacy: Manifest = { ...manifest, format_version: '1.0' };
    expect((await verifyManifest(asLegacy, await pub(COURSE_PRIV))).ok).toBe(false);
  });

  it('signs the policy block verbatim, unknown keys included', async () => {
    const policy = { capture: { selection_change: false }, future_knob: { nested: 1 } };
    const { manifest, rootPubkeyHex } = await makeV2Manifest({ manifestOverrides: { policy } });
    const parsed = parseManifest(JSON.stringify(manifest));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.policy).toEqual(policy);
    expect((await verifyManifestChain(parsed.value, rootPubkeyHex)).ok).toBe(true);
  });

  it('every key in the 2.0 signed payload is ASCII (Lua bytewise-sort parity)', async () => {
    const { manifest } = await makeV2Manifest();
    const walk = (value: unknown): void => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        expect(key, `non-ASCII key ${key}`).toMatch(/^[\x20-\x7e]+$/);
        walk(child);
      }
    };
    walk({ ...manifest, sig: undefined, course_cert: undefined });
  });
});

// ---------------------------------------------------------------------------
// verifyManifestChain — the four steps, in order
// ---------------------------------------------------------------------------

describe('verifyManifestChain', () => {
  it('walks root -> cert -> manifest and reports the course it is proven to belong to', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest();
    const result = await verifyManifestChain(manifest, rootPubkeyHex);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.course_id).toBe('berkeley-cs61b');
    expect(result.value.course_pubkey).toBe(await pub(COURSE_PRIV));
    expect(result.value.window).toEqual({ in_window: true });
  });

  it('step 0: reports a missing course_cert', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest();
    const without = { ...manifest };
    delete without.course_cert;
    const result = await verifyManifestChain(without, rootPubkeyHex);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing_course_cert');
  });

  it('step 0: reports a malformed course_cert without attempting a signature check', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest();
    const broken: Manifest = {
      ...manifest,
      course_cert: { ...(manifest.course_cert as CourseCert), root_sig: 'short' },
    };
    const result = await verifyManifestChain(broken, rootPubkeyHex);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_cert_shape');
  });

  it('step 1: rejects a cert not signed by the root key (bad root sig)', async () => {
    const { manifest } = await makeV2Manifest({ rootPriv: WRONG_ROOT_PRIV });
    const result = await verifyManifestChain(manifest, await pub(ROOT_PRIV));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_root_signature');
  });

  it('step 1 runs BEFORE step 2: a bad root sig is reported even when the course sig is also bad', async () => {
    const { manifest } = await makeV2Manifest({ rootPriv: WRONG_ROOT_PRIV });
    const alsoBadPayload: Manifest = { ...manifest, assignment_id: 'tampered' };
    const result = await verifyManifestChain(alsoBadPayload, await pub(ROOT_PRIV));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_root_signature');
  });

  it('step 2: rejects a payload not signed by the key the cert authorizes', async () => {
    // The cert vouches for COURSE_PRIV's pubkey, but OTHER_COURSE_PRIV signed.
    const { manifest, rootPubkeyHex } = await makeV2Manifest();
    const unsigned: Omit<Manifest, 'sig'> = { ...manifest };
    const forged: Manifest = {
      ...manifest,
      sig: await signManifest(unsigned, OTHER_COURSE_PRIV),
    };
    const result = await verifyManifestChain(forged, rootPubkeyHex);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_course_signature');
  });

  it('step 2: rejects a payload tampered with after signing', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest();
    const result = await verifyManifestChain(
      { ...manifest, files_under_review: ['src/Sneaky.java'] },
      rootPubkeyHex,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_course_signature');
  });

  it('step 3 (LOAD-BEARING): 61B’s key cannot sign a manifest claiming to be 61C', async () => {
    // Both signatures are genuine: the cert really is root-signed for 61B, and
    // the payload really is signed by the key that cert authorizes. Only the
    // course_id comparison catches the forgery.
    const { manifest, rootPubkeyHex } = await makeV2Manifest({
      manifestOverrides: { course_id: 'berkeley-cs61c' },
    });

    expect((await verifyCourseCert(manifest.course_cert as CourseCert, rootPubkeyHex)).ok).toBe(
      true,
    );
    expect((await verifyManifest(manifest, await pub(COURSE_PRIV))).ok).toBe(true);

    const result = await verifyManifestChain(manifest, rootPubkeyHex);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: 'course_id_mismatch',
      manifest_course_id: 'berkeley-cs61c',
      cert_course_id: 'berkeley-cs61b',
    });
  });

  it('step 3: a manifest with no course_id at all does not slip past the comparison', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest();
    const withoutCourseId = { ...manifest };
    delete withoutCourseId.course_id;
    const resigned: Manifest = {
      ...withoutCourseId,
      sig: await signManifest(withoutCourseId, COURSE_PRIV),
    };
    const result = await verifyManifestChain(resigned, rootPubkeyHex);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: 'course_id_mismatch',
      manifest_course_id: null,
      cert_course_id: 'berkeley-cs61b',
    });
  });

  it('step 4: an issued_at AFTER valid_until is reported but does NOT fail the chain', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest({
      manifestOverrides: { issued_at: '2027-06-01T00:00:00Z' },
    });
    const result = await verifyManifestChain(manifest, rootPubkeyHex);
    // Non-fatal: an expired cert must not silently stop recording for a class.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.window).toEqual({ in_window: false, reason: 'after_valid_until' });
  });

  it('step 4: an issued_at BEFORE valid_from is reported but does NOT fail the chain', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest({
      manifestOverrides: { issued_at: '2026-01-01T00:00:00Z' },
    });
    const result = await verifyManifestChain(manifest, rootPubkeyHex);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.window).toEqual({ in_window: false, reason: 'before_valid_from' });
  });

  it('step 4 uses issued_at, never wall-clock now: a long-expired cert still reports in_window', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest({
      certOverrides: { valid_from: '2020-08-20', valid_until: '2021-01-15' },
      manifestOverrides: { issued_at: '2020-09-08T00:00:00Z' },
    });
    const result = await verifyManifestChain(manifest, rootPubkeyHex);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Today is years past valid_until; the answer is about issued_at.
    expect(result.value.window).toEqual({ in_window: true });
  });

  it('step 4 runs LAST: an out-of-window manifest with a bad course sig reports the signature failure', async () => {
    const { manifest, rootPubkeyHex } = await makeV2Manifest({
      manifestOverrides: { issued_at: '2027-06-01T00:00:00Z' },
    });
    const result = await verifyManifestChain({ ...manifest, semester: 'sp99' }, rootPubkeyHex);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_course_signature');
  });

  it('the root public key is a parameter: the same manifest verifies under whichever root signed it', async () => {
    const a = await makeV2Manifest();
    const b = await makeV2Manifest({ rootPriv: WRONG_ROOT_PRIV });
    expect((await verifyManifestChain(a.manifest, a.rootPubkeyHex)).ok).toBe(true);
    expect((await verifyManifestChain(b.manifest, b.rootPubkeyHex)).ok).toBe(true);
    expect((await verifyManifestChain(a.manifest, b.rootPubkeyHex)).ok).toBe(false);
  });

  it('step 0: rejects a 1.x manifest — there is no chain to walk below 2.0', async () => {
    const { text } = await makeSignedManifest();
    const parsed = parseManifest(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = await verifyManifestChain(parsed.value, await pub(ROOT_PRIV));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'not_manifest_2_0', format_version: '1.0' });
  });

  it('step 0 closes the 1.x DOWNGRADE attack: a stapled cert + unsigned policy must not chain', async () => {
    // The whole attack needs no private key. The student has:
    //   - a genuine 1.x manifest their course issued and signed, and
    //   - their course's certificate, which is public (it ships in every 2.0
    //     manifest and is root-signed, so it cannot be forged but CAN be copied).
    // At 1.x, course_id / collaboration / submission / scope / policy are all
    // outside the signed payload, so the student can invent them freely.
    const legacyFields = {
      assignment_id: 'hw3',
      semester: 'fa25',
      issued_at: '2026-09-01T00:00:00Z',
      files_under_review: ['a.py'] as readonly string[],
    };
    const genuineLegacySig = await signManifest(legacyFields, COURSE_PRIV);
    const { manifest: real, rootPubkeyHex } = await makeV2Manifest();

    const forged: Manifest = {
      ...legacyFields,
      sig: genuineLegacySig,
      course_cert: real.course_cert as CourseCert,
      // Chosen to satisfy step 3 — it is unsigned at 1.x, so it is free.
      course_id: 'berkeley-cs61b',
      collaboration: 'group',
      submission: 'git',
      scope: 'repo',
      // The payload of the attack: capture turned off by the student.
      policy: {
        capture: {
          selection_change: false,
          focus_change: false,
          terminal: false,
          doc_open_close: false,
          inline_content: false,
          heartbeat_interval_ms: 120000,
        },
      },
    };

    // Every individual signature in the forgery is genuine...
    expect((await verifyCourseCert(forged.course_cert as CourseCert, rootPubkeyHex)).ok).toBe(true);
    expect((await verifyManifest(forged, await pub(COURSE_PRIV))).ok).toBe(true);
    expect(forged.course_id).toBe((forged.course_cert as CourseCert).course_id);

    // ...and the chain must still refuse it, on the version gate.
    const result = await verifyManifestChain(forged, rootPubkeyHex);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'not_manifest_2_0', format_version: '1.0' });
  });

  it('parseManifest drops the 2.0 fields from a 1.x manifest, so they can never be read as signed', async () => {
    const parsed = parseManifest(
      JSON.stringify({
        assignment_id: 'hw3',
        semester: 'fa25',
        issued_at: '2026-09-01T00:00:00Z',
        files_under_review: ['a.py'],
        sig: 'a'.repeat(128),
        // All unsigned at 1.x; a parser that carried them through would let a
        // caller mistake attacker-controlled values for course-signed ones.
        course_id: 'berkeley-cs61b',
        collaboration: 'group',
        submission: 'git',
        scope: 'repo',
        policy: { capture: { selection_change: false } },
        course_cert: { course_id: 'x' },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.course_id).toBeUndefined();
    expect(parsed.value.collaboration).toBeUndefined();
    expect(parsed.value.submission).toBeUndefined();
    expect(parsed.value.scope).toBeUndefined();
    expect(parsed.value.policy).toBeUndefined();
    expect(parsed.value.course_cert).toBeUndefined();
  });
});
