import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  parseCourseCert,
  verifyCourseCert,
  signCourseCert,
  checkCertWindow,
  buildCourseCertSignedPayload,
  parseIsoInstantMs,
} from './course-cert.js';
import type { CourseCert } from './course-cert.js';
import { canonicalize } from './canonical.js';

// ---------------------------------------------------------------------------
// Fixed keys — the same seeds tools/export-conformance-vectors.ts uses, so a
// change here surfaces as a conformance-vector diff in the sibling repos too.
// ---------------------------------------------------------------------------

const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const ROOT_PRIV = seed(0x0a);
const WRONG_ROOT_PRIV = seed(0x0c);
const COURSE_PRIV = seed(0x0b);

const CERT_FIELDS = {
  course_id: 'berkeley-cs61b',
  valid_from: '2026-08-20',
  valid_until: '2027-01-15',
};

async function makeCert(
  overrides: Partial<Omit<CourseCert, 'root_sig'>> = {},
  signWith: Uint8Array = ROOT_PRIV,
): Promise<{ cert: CourseCert; rootPubkeyHex: string }> {
  const unsigned = {
    ...CERT_FIELDS,
    course_pubkey: bytesToHex(await ed.getPublicKeyAsync(COURSE_PRIV)),
    ...overrides,
  };
  const root_sig = await signCourseCert(unsigned, signWith);
  return {
    cert: { ...unsigned, root_sig },
    rootPubkeyHex: bytesToHex(await ed.getPublicKeyAsync(ROOT_PRIV)),
  };
}

// ---------------------------------------------------------------------------
// Signed payload
// ---------------------------------------------------------------------------

describe('buildCourseCertSignedPayload', () => {
  it('excludes root_sig and canonicalizes exactly the four cert fields', async () => {
    const { cert } = await makeCert();
    const expected = canonicalize({
      course_id: cert.course_id,
      course_pubkey: cert.course_pubkey,
      valid_from: cert.valid_from,
      valid_until: cert.valid_until,
    });
    expect(new TextDecoder().decode(buildCourseCertSignedPayload(cert))).toBe(expected);
    expect(expected).not.toContain('root_sig');
  });

  it('is JCS key-ordered, so field insertion order does not change the bytes', async () => {
    const { cert } = await makeCert();
    const reordered = {
      valid_until: cert.valid_until,
      course_pubkey: cert.course_pubkey,
      valid_from: cert.valid_from,
      course_id: cert.course_id,
      root_sig: cert.root_sig,
    };
    expect(buildCourseCertSignedPayload(reordered)).toEqual(buildCourseCertSignedPayload(cert));
  });

  it('every key in the signed payload is ASCII (Lua bytewise-sort parity)', async () => {
    const { cert } = await makeCert();
    const json = new TextDecoder().decode(buildCourseCertSignedPayload(cert));
    for (const key of Object.keys(JSON.parse(json) as Record<string, unknown>)) {
      expect(key).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// parseCourseCert
// ---------------------------------------------------------------------------

describe('parseCourseCert', () => {
  it('accepts a well-formed cert', async () => {
    const { cert } = await makeCert();
    const result = parseCourseCert(cert);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.course_id).toBe('berkeley-cs61b');
  });

  it('ignores unknown top-level keys (forward compatibility)', async () => {
    const { cert } = await makeCert();
    const result = parseCourseCert({ ...cert, future_field: { nested: true } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual([
      'course_id',
      'course_pubkey',
      'root_sig',
      'valid_from',
      'valid_until',
    ]);
  });

  it.each([42, null, [], 'a string'])('rejects the non-object value %j', (value) => {
    const result = parseCourseCert(value);
    expect(result.ok).toBe(false);
  });

  it.each(['course_id', 'valid_from', 'valid_until'])('rejects a missing %s', async (field) => {
    const { cert } = await makeCert();
    const partial = { ...cert } as Record<string, unknown>;
    delete partial[field];
    const result = parseCourseCert(partial);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: 'invalid_shape',
      field,
      reason: 'must be a non-empty string',
    });
  });

  it('rejects a course_pubkey that is not 64 hex chars', async () => {
    const { cert } = await makeCert();
    const result = parseCourseCert({ ...cert, course_pubkey: 'abc' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: 'invalid_shape',
      field: 'course_pubkey',
      reason: 'must be a 64-char hex string',
    });
  });

  it('rejects a missing root_sig distinctly from a malformed one', async () => {
    const { cert } = await makeCert();
    const withoutSig = { ...cert } as Record<string, unknown>;
    delete withoutSig['root_sig'];
    const missing = parseCourseCert(withoutSig);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toEqual({ kind: 'invalid_shape', field: 'root_sig', reason: 'missing' });

    const malformed = parseCourseCert({ ...cert, root_sig: 'AB'.repeat(64) });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.error).toEqual({
      kind: 'invalid_shape',
      field: 'root_sig',
      reason: 'must be a 128-char hex string',
    });
  });
});

// ---------------------------------------------------------------------------
// verifyCourseCert — step 1 of the chain
// ---------------------------------------------------------------------------

describe('verifyCourseCert', () => {
  it('accepts a cert signed by the matching root key', async () => {
    const { cert, rootPubkeyHex } = await makeCert();
    const result = await verifyCourseCert(cert, rootPubkeyHex);
    expect(result.ok).toBe(true);
  });

  it('rejects a cert signed by a DIFFERENT root key (bad root sig)', async () => {
    const { cert, rootPubkeyHex } = await makeCert({}, WRONG_ROOT_PRIV);
    const result = await verifyCourseCert(cert, rootPubkeyHex);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_signature');
  });

  it.each(['course_id', 'course_pubkey', 'valid_from', 'valid_until'] as const)(
    'rejects a cert whose %s was tampered with after signing',
    async (field) => {
      const { cert, rootPubkeyHex } = await makeCert();
      const tampered: CourseCert = {
        ...cert,
        [field]: field === 'course_pubkey' ? 'f'.repeat(64) : 'tampered',
      };
      const result = await verifyCourseCert(tampered, rootPubkeyHex);
      expect(result.ok).toBe(false);
    },
  );

  it('rejects a root pubkey that is not 64 hex chars', async () => {
    const { cert } = await makeCert();
    const result = await verifyCourseCert(cert, 'nope');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_signature');
  });

  it('rejects a malformed root_sig without throwing', async () => {
    const { cert, rootPubkeyHex } = await makeCert();
    const result = await verifyCourseCert({ ...cert, root_sig: 'zz' }, rootPubkeyHex);
    expect(result.ok).toBe(false);
  });

  it('does not throw on an all-zeros pubkey', async () => {
    const { cert } = await makeCert();
    const result = await verifyCourseCert(cert, '0'.repeat(64));
    expect(result.ok).toBe(false);
  });

  it('log-core never hardcodes a root key: the same cert verifies under whichever key signed it', async () => {
    const alt = await makeCert({}, WRONG_ROOT_PRIV);
    const altRootPubkey = bytesToHex(await ed.getPublicKeyAsync(WRONG_ROOT_PRIV));
    const result = await verifyCourseCert(alt.cert, altRootPubkey);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseIsoInstantMs
// ---------------------------------------------------------------------------

describe('parseIsoInstantMs', () => {
  it('reads a date-only string as UTC midnight that day', () => {
    expect(parseIsoInstantMs('2026-08-20')).toBe(Date.UTC(2026, 7, 20, 0, 0, 0, 0));
  });

  it('reads a Z timestamp', () => {
    expect(parseIsoInstantMs('2026-09-08T12:34:56Z')).toBe(Date.UTC(2026, 8, 8, 12, 34, 56, 0));
  });

  it('reads fractional seconds as milliseconds, padding and truncating to 3 digits', () => {
    expect(parseIsoInstantMs('2026-09-08T00:00:00.5Z')).toBe(Date.UTC(2026, 8, 8, 0, 0, 0, 500));
    expect(parseIsoInstantMs('2026-09-08T00:00:00.123456Z')).toBe(
      Date.UTC(2026, 8, 8, 0, 0, 0, 123),
    );
  });

  it('treats a missing offset as UTC', () => {
    expect(parseIsoInstantMs('2026-09-08T00:00:00')).toBe(
      parseIsoInstantMs('2026-09-08T00:00:00Z'),
    );
  });

  it('applies a numeric offset', () => {
    expect(parseIsoInstantMs('2026-09-08T02:00:00+02:00')).toBe(
      parseIsoInstantMs('2026-09-08T00:00:00Z'),
    );
    expect(parseIsoInstantMs('2026-09-07T21:00:00-03:00')).toBe(
      parseIsoInstantMs('2026-09-08T00:00:00Z'),
    );
  });

  it.each([
    'not a date',
    '2026/09/08',
    '20260908',
    '2026-13-01',
    '2026-09-32',
    '2026-09-08T25:00:00Z',
    '2026-09-08 00:00:00Z',
    '',
  ])('rejects %j', (value) => {
    expect(parseIsoInstantMs(value)).toBeNull();
  });

  it.each(['2026-02-31', '2026-02-30', '2027-02-29', '2026-04-31', '2026-06-31'])(
    'rejects the non-existent calendar date %j instead of rolling it forward',
    (value) => {
      // JS Date silently rolls 2026-02-31 to 2026-03-03. Kotlin's java.time and a
      // hand-rolled Lua parser would not, so accepting it would put the three
      // implementations' accepting sets out of sync.
      expect(parseIsoInstantMs(value)).toBeNull();
    },
  );

  it('accepts a real leap day', () => {
    expect(parseIsoInstantMs('2028-02-29')).toBe(Date.UTC(2028, 1, 29));
  });

  it('does not map a four-digit year below 100 onto the 1900s', () => {
    const ms = parseIsoInstantMs('0026-09-08');
    expect(ms).not.toBeNull();
    expect(new Date(ms as number).getUTCFullYear()).toBe(26);
  });
});

// ---------------------------------------------------------------------------
// checkCertWindow — step 4 of the chain
// ---------------------------------------------------------------------------

describe('checkCertWindow', () => {
  const cert = (): CourseCert => ({
    ...CERT_FIELDS,
    course_pubkey: 'a'.repeat(64),
    root_sig: 'b'.repeat(128),
  });

  it('accepts an issued_at inside the window', () => {
    expect(checkCertWindow(cert(), '2026-09-08T00:00:00Z')).toEqual({ in_window: true });
  });

  it('treats both bounds as inclusive', () => {
    expect(checkCertWindow(cert(), '2026-08-20T00:00:00Z')).toEqual({ in_window: true });
    expect(checkCertWindow(cert(), '2027-01-15T00:00:00Z')).toEqual({ in_window: true });
  });

  it('reports before_valid_from', () => {
    expect(checkCertWindow(cert(), '2026-08-19T23:59:59Z')).toEqual({
      in_window: false,
      reason: 'before_valid_from',
    });
  });

  it('reports after_valid_until', () => {
    expect(checkCertWindow(cert(), '2027-01-15T00:00:00.001Z')).toEqual({
      in_window: false,
      reason: 'after_valid_until',
    });
  });

  it('reports unparseable_timestamp rather than guessing', () => {
    expect(checkCertWindow(cert(), 'sometime last fall')).toEqual({
      in_window: false,
      reason: 'unparseable_timestamp',
    });
    expect(checkCertWindow({ ...cert(), valid_until: 'never' }, '2026-09-08T00:00:00Z')).toEqual({
      in_window: false,
      reason: 'unparseable_timestamp',
    });
  });

  it('never consults wall-clock now: a long-expired cert still reports in_window for a contemporaneous issued_at', () => {
    const ancient: CourseCert = {
      ...cert(),
      valid_from: '1999-01-01',
      valid_until: '1999-12-31',
    };
    // Wall clock is decades past valid_until, yet the answer is about issued_at.
    expect(checkCertWindow(ancient, '1999-06-15T00:00:00Z')).toEqual({ in_window: true });
  });
});
