import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  ENROLLMENT_FORMAT_VERSION,
  buildEnrollmentCertSignedPayload,
  buildEnrollmentTokenSignedPayload,
  buildSessionPubkeyBindingPayload,
  parseEnrollmentCert,
  parseEnrollmentToken,
  signEnrollmentCert,
  signEnrollmentToken,
  signSessionPubkey,
  verifyEnrollmentCert,
  verifyEnrollmentToken,
  verifySessionPubkeySig,
  checkTokenWindow,
  verifyIdentityChain,
} from './enrollment.js';
import type { EnrollmentCert, EnrollmentToken, SessionIdentity } from './enrollment.js';
import { signCourseCert } from './course-cert.js';
import type { CourseCert } from './course-cert.js';
import { canonicalize } from './canonical.js';

// ---------------------------------------------------------------------------
// Fixed keys — the same seeds tools/export-conformance-vectors.ts uses, so a
// change here surfaces as a conformance-vector diff in the sibling repos too.
// ---------------------------------------------------------------------------

const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);

const ROOT_PRIV = seed(0x0a);
const COURSE_PRIV = seed(0x0b);
const OTHER_COURSE_PRIV = seed(0x0d);
const ENROLLMENT_PRIV = seed(0x0e);
const WRONG_ENROLLMENT_PRIV = seed(0x0f);
const STUDENT_PRIV = seed(0x10);
const OTHER_STUDENT_PRIV = seed(0x11);
const SESSION_PRIV = seed(0x12);

const COURSE_ID = 'berkeley-cs61b';
const OTHER_COURSE_ID = 'berkeley-cs61c';
const STUDENT_REF = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const CERT_VALID_FROM = '2026-08-20';
const CERT_VALID_UNTIL = '2027-01-15';
const TOKEN_ISSUED_AT = '2026-09-01T00:00:00Z';
const TOKEN_EXPIRES_AT = '2027-01-15';
const SESSION_STARTED_AT = '2026-09-08T12:00:00Z';

const pubHex = async (priv: Uint8Array): Promise<string> =>
  bytesToHex(await ed.getPublicKeyAsync(priv));

async function makeCourseCert(overrides: Partial<Omit<CourseCert, 'root_sig'>> = {}) {
  const unsigned = {
    course_id: COURSE_ID,
    course_pubkey: await pubHex(COURSE_PRIV),
    valid_from: CERT_VALID_FROM,
    valid_until: CERT_VALID_UNTIL,
    ...overrides,
  };
  return { ...unsigned, root_sig: await signCourseCert(unsigned, ROOT_PRIV) };
}

async function makeEnrollmentCert(
  overrides: Partial<Omit<EnrollmentCert, 'course_sig'>> = {},
  coursePriv: Uint8Array = COURSE_PRIV,
): Promise<EnrollmentCert> {
  const unsigned = {
    format_version: ENROLLMENT_FORMAT_VERSION,
    course_id: COURSE_ID,
    enrollment_pubkey: await pubHex(ENROLLMENT_PRIV),
    valid_from: CERT_VALID_FROM,
    valid_until: CERT_VALID_UNTIL,
    ...overrides,
  };
  return { ...unsigned, course_sig: await signEnrollmentCert(unsigned, coursePriv) };
}

async function makeToken(
  overrides: Partial<Omit<EnrollmentToken, 'enrollment_sig'>> = {},
  enrollmentPriv: Uint8Array = ENROLLMENT_PRIV,
): Promise<EnrollmentToken> {
  const unsigned = {
    format_version: ENROLLMENT_FORMAT_VERSION,
    student_ref: STUDENT_REF,
    course_id: COURSE_ID,
    student_pubkey: await pubHex(STUDENT_PRIV),
    issued_at: TOKEN_ISSUED_AT,
    expires_at: TOKEN_EXPIRES_AT,
    ...overrides,
  };
  return { ...unsigned, enrollment_sig: await signEnrollmentToken(unsigned, enrollmentPriv) };
}

async function makeIdentity(
  overrides: Partial<SessionIdentity> = {},
  studentPriv: Uint8Array = STUDENT_PRIV,
): Promise<SessionIdentity> {
  // `SessionIdentity.enrollment` is now a 2.0-or-2.1 union; this whole file is
  // the 2.0 suite, so narrow once here rather than at every use.
  const enrollment = (overrides.enrollment ?? (await makeToken())) as EnrollmentToken;
  const enrollment_cert = overrides.enrollment_cert ?? (await makeEnrollmentCert());
  const sessionPubkey = await pubHex(SESSION_PRIV);
  return {
    enrollment,
    enrollment_cert,
    session_pubkey_sig:
      overrides.session_pubkey_sig ??
      (await signSessionPubkey(
        {
          course_id: enrollment.course_id,
          student_ref: enrollment.student_ref,
          session_pubkey: sessionPubkey,
        },
        studentPriv,
      )),
  };
}

async function chainInput(overrides: Record<string, unknown> = {}) {
  return {
    identity: await makeIdentity(),
    session_pubkey: await pubHex(SESSION_PRIV),
    course_cert: await makeCourseCert(),
    session_started_at: SESSION_STARTED_AT,
    ...overrides,
  } as Parameters<typeof verifyIdentityChain>[0];
}

// ---------------------------------------------------------------------------
// Signed payloads — the exact bytes three ports must reproduce
// ---------------------------------------------------------------------------

describe('buildEnrollmentCertSignedPayload', () => {
  it('covers exactly the five non-signature fields, JCS-ordered', async () => {
    const cert = await makeEnrollmentCert();
    const text = new TextDecoder().decode(buildEnrollmentCertSignedPayload(cert));
    expect(text).toBe(
      canonicalize({
        course_id: COURSE_ID,
        enrollment_pubkey: await pubHex(ENROLLMENT_PRIV),
        format_version: '2.0',
        valid_from: CERT_VALID_FROM,
        valid_until: CERT_VALID_UNTIL,
      }),
    );
  });

  it('excludes course_sig — the course does not sign its own signature', async () => {
    const cert = await makeEnrollmentCert();
    expect(new TextDecoder().decode(buildEnrollmentCertSignedPayload(cert))).not.toContain(
      cert.course_sig,
    );
  });

  it('uses only fixed printable-ASCII object keys (bytewise Lua JCS === UTF-16 JS JCS)', async () => {
    const text = new TextDecoder().decode(
      buildEnrollmentCertSignedPayload(await makeEnrollmentCert()),
    );
    const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);
    expect(keys).toEqual([
      'course_id',
      'enrollment_pubkey',
      'format_version',
      'valid_from',
      'valid_until',
    ]);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('buildEnrollmentTokenSignedPayload', () => {
  it('covers exactly the six non-signature fields, JCS-ordered', async () => {
    const token = await makeToken();
    const text = new TextDecoder().decode(buildEnrollmentTokenSignedPayload(token));
    expect(text).toBe(
      canonicalize({
        course_id: COURSE_ID,
        expires_at: TOKEN_EXPIRES_AT,
        format_version: '2.0',
        issued_at: TOKEN_ISSUED_AT,
        student_pubkey: await pubHex(STUDENT_PRIV),
        student_ref: STUDENT_REF,
      }),
    );
  });

  it('carries student_ref as a VALUE, never as an object key', async () => {
    const text = new TextDecoder().decode(buildEnrollmentTokenSignedPayload(await makeToken()));
    expect(Object.keys(JSON.parse(text) as object)).not.toContain(STUDENT_REF);
    expect(text).toContain(`"student_ref":"${STUDENT_REF}"`);
  });

  it('contains no JSON arrays (the Lua port needs explicit array tagging)', async () => {
    const text = new TextDecoder().decode(buildEnrollmentTokenSignedPayload(await makeToken()));
    expect(text).not.toContain('[');
  });
});

describe('buildSessionPubkeyBindingPayload', () => {
  it('binds course_id, student_ref, and session_pubkey under a fixed purpose tag', async () => {
    const sessionPubkey = await pubHex(SESSION_PRIV);
    const text = new TextDecoder().decode(
      buildSessionPubkeyBindingPayload({
        course_id: COURSE_ID,
        student_ref: STUDENT_REF,
        session_pubkey: sessionPubkey,
      }),
    );
    expect(text).toBe(
      canonicalize({
        course_id: COURSE_ID,
        purpose: 'provenance-session-pubkey-binding-v1',
        session_pubkey: sessionPubkey,
        student_ref: STUDENT_REF,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// parseEnrollmentCert
// ---------------------------------------------------------------------------

describe('parseEnrollmentCert', () => {
  it('accepts a well-formed cert', async () => {
    const r = parseEnrollmentCert(await makeEnrollmentCert());
    expect(r.ok).toBe(true);
  });

  it.each([['null', null] as const, ['an array', []] as const, ['a string', 'x'] as const])(
    'rejects %s',
    (_label, value) => {
      const r = parseEnrollmentCert(value);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('invalid_shape');
    },
  );

  it.each([
    'format_version',
    'course_id',
    'enrollment_pubkey',
    'valid_from',
    'valid_until',
    'course_sig',
  ])('rejects a cert missing %s — canonicalize would silently omit it', async (field) => {
    const cert = (await makeEnrollmentCert()) as unknown as Record<string, unknown>;
    delete cert[field];
    const r = parseEnrollmentCert(cert);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_shape');
      expect(r.error).toMatchObject({ field });
    }
  });

  it('rejects an undefined-valued required field as firmly as a missing one', async () => {
    const cert = { ...(await makeEnrollmentCert()), course_id: undefined };
    const r = parseEnrollmentCert(cert);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-hex enrollment_pubkey', async () => {
    const r = parseEnrollmentCert({ ...(await makeEnrollmentCert()), enrollment_pubkey: 'zz' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'enrollment_pubkey' });
  });

  it('rejects a non-hex course_sig', async () => {
    const r = parseEnrollmentCert({ ...(await makeEnrollmentCert()), course_sig: 'abc' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'course_sig' });
  });

  it('rejects an unparseable validity bound', async () => {
    const r = parseEnrollmentCert({ ...(await makeEnrollmentCert()), valid_from: 'last tuesday' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'valid_from' });
  });

  it('rejects valid_until earlier than valid_from', async () => {
    const r = parseEnrollmentCert({
      ...(await makeEnrollmentCert()),
      valid_from: '2027-01-01',
      valid_until: '2026-01-01',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'valid_until' });
  });

  it('ignores unknown keys for forward compatibility', async () => {
    const r = parseEnrollmentCert({ ...(await makeEnrollmentCert()), future_field: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).not.toHaveProperty('future_field');
  });
});

// ---------------------------------------------------------------------------
// parseEnrollmentToken
// ---------------------------------------------------------------------------

describe('parseEnrollmentToken', () => {
  it('accepts a well-formed token', async () => {
    expect(parseEnrollmentToken(await makeToken()).ok).toBe(true);
  });

  it.each([
    'format_version',
    'student_ref',
    'course_id',
    'student_pubkey',
    'issued_at',
    'expires_at',
    'enrollment_sig',
  ])('rejects a token missing %s', async (field) => {
    const token = (await makeToken()) as unknown as Record<string, unknown>;
    delete token[field];
    const r = parseEnrollmentToken(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field });
  });

  it('rejects a non-hex student_pubkey', async () => {
    const r = parseEnrollmentToken({ ...(await makeToken()), student_pubkey: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'student_pubkey' });
  });

  it('rejects an unparseable issued_at', async () => {
    const r = parseEnrollmentToken({ ...(await makeToken()), issued_at: 'soon' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'issued_at' });
  });

  it('rejects expires_at earlier than issued_at', async () => {
    const r = parseEnrollmentToken({
      ...(await makeToken()),
      issued_at: '2027-01-01T00:00:00Z',
      expires_at: '2026-01-01',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'expires_at' });
  });
});

// ---------------------------------------------------------------------------
// Single-link verification
// ---------------------------------------------------------------------------

describe('verifyEnrollmentCert', () => {
  it('verifies against the course public key the root vouched for', async () => {
    const cert = await makeEnrollmentCert();
    expect((await verifyEnrollmentCert(cert, await pubHex(COURSE_PRIV))).ok).toBe(true);
  });

  it('fails against a different course key', async () => {
    const cert = await makeEnrollmentCert();
    const r = await verifyEnrollmentCert(cert, await pubHex(OTHER_COURSE_PRIV));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_signature');
  });

  it('fails when enrollment_pubkey is swapped after signing', async () => {
    const cert = await makeEnrollmentCert();
    const tampered = { ...cert, enrollment_pubkey: await pubHex(WRONG_ENROLLMENT_PRIV) };
    expect((await verifyEnrollmentCert(tampered, await pubHex(COURSE_PRIV))).ok).toBe(false);
  });

  it('fails when valid_until is extended after signing', async () => {
    const cert = await makeEnrollmentCert();
    const tampered = { ...cert, valid_until: '2099-01-01' };
    expect((await verifyEnrollmentCert(tampered, await pubHex(COURSE_PRIV))).ok).toBe(false);
  });

  it('fails on a malformed course pubkey rather than throwing', async () => {
    const r = await verifyEnrollmentCert(await makeEnrollmentCert(), 'not-a-key');
    expect(r.ok).toBe(false);
  });
});

describe('verifyEnrollmentToken', () => {
  it('verifies against the enrollment public key', async () => {
    const token = await makeToken();
    expect((await verifyEnrollmentToken(token, await pubHex(ENROLLMENT_PRIV))).ok).toBe(true);
  });

  it('fails against a different enrollment key', async () => {
    const token = await makeToken();
    expect((await verifyEnrollmentToken(token, await pubHex(WRONG_ENROLLMENT_PRIV))).ok).toBe(
      false,
    );
  });

  it('fails when student_pubkey is swapped after signing — the core forgery', async () => {
    const token = await makeToken();
    const tampered = { ...token, student_pubkey: await pubHex(OTHER_STUDENT_PRIV) };
    expect((await verifyEnrollmentToken(tampered, await pubHex(ENROLLMENT_PRIV))).ok).toBe(false);
  });

  it('fails when student_ref is swapped after signing', async () => {
    const token = await makeToken();
    const tampered = { ...token, student_ref: 'ffffffff-0000-4000-8000-000000000000' };
    expect((await verifyEnrollmentToken(tampered, await pubHex(ENROLLMENT_PRIV))).ok).toBe(false);
  });
});

describe('verifySessionPubkeySig', () => {
  it('verifies the student per-course key binding an ephemeral session key', async () => {
    const identity = await makeIdentity();
    const r = await verifySessionPubkeySig(
      {
        course_id: COURSE_ID,
        student_ref: STUDENT_REF,
        session_pubkey: await pubHex(SESSION_PRIV),
      },
      identity.session_pubkey_sig,
      await pubHex(STUDENT_PRIV),
    );
    expect(r.ok).toBe(true);
  });

  it('fails when a DIFFERENT student key produced the signature', async () => {
    const identity = await makeIdentity({}, OTHER_STUDENT_PRIV);
    const r = await verifySessionPubkeySig(
      {
        course_id: COURSE_ID,
        student_ref: STUDENT_REF,
        session_pubkey: await pubHex(SESSION_PRIV),
      },
      identity.session_pubkey_sig,
      await pubHex(STUDENT_PRIV),
    );
    expect(r.ok).toBe(false);
  });

  it('fails when the session pubkey is swapped — no lifting a sig onto another session', async () => {
    const identity = await makeIdentity();
    const r = await verifySessionPubkeySig(
      {
        course_id: COURSE_ID,
        student_ref: STUDENT_REF,
        session_pubkey: await pubHex(seed(0x13)),
      },
      identity.session_pubkey_sig,
      await pubHex(STUDENT_PRIV),
    );
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkTokenWindow — non-fatal, evaluated against a supplied instant
// ---------------------------------------------------------------------------

describe('checkTokenWindow', () => {
  it('is in window during the semester', async () => {
    expect(checkTokenWindow(await makeToken(), '2026-10-01T00:00:00Z')).toEqual({
      in_window: true,
    });
  });

  it('is before_issued_at for an instant preceding issuance', async () => {
    expect(checkTokenWindow(await makeToken(), '2026-08-25T00:00:00Z')).toEqual({
      in_window: false,
      reason: 'before_valid_from',
    });
  });

  it('treats a date-only expires_at as covering THROUGH THE END of that day', async () => {
    const token = await makeToken({ expires_at: '2027-01-15' });
    expect(checkTokenWindow(token, '2027-01-15T23:59:59Z')).toEqual({ in_window: true });
    expect(checkTokenWindow(token, '2027-01-16T00:00:00Z')).toEqual({
      in_window: false,
      reason: 'after_valid_until',
    });
  });

  it('treats a full-timestamp expires_at as exact to the millisecond', async () => {
    const token = await makeToken({ expires_at: '2027-01-15T12:00:00Z' });
    expect(checkTokenWindow(token, '2027-01-15T12:00:00Z')).toEqual({ in_window: true });
    expect(checkTokenWindow(token, '2027-01-15T12:00:00.001Z')).toEqual({
      in_window: false,
      reason: 'after_valid_until',
    });
  });

  it('reports unparseable_timestamp rather than throwing', async () => {
    expect(checkTokenWindow(await makeToken(), 'whenever')).toEqual({
      in_window: false,
      reason: 'unparseable_timestamp',
    });
  });
});

// ---------------------------------------------------------------------------
// verifyIdentityChain — the whole spine
// ---------------------------------------------------------------------------

describe('verifyIdentityChain', () => {
  it('walks course_cert -> enrollment_cert -> token -> session_pubkey_sig', async () => {
    const r = await verifyIdentityChain(await chainInput());
    expect(r.ok).toBe(true);
    if (r.ok && r.value.identity_version === '2.0') {
      expect(r.value.scope).toBe('course');
      expect(r.value.student_ref).toBe(STUDENT_REF);
      expect(r.value.course_id).toBe(COURSE_ID);
      expect(r.value.student_pubkey).toBe(await pubHex(STUDENT_PRIV));
      expect(r.value.enrollment_pubkey).toBe(await pubHex(ENROLLMENT_PRIV));
      expect(r.value.cert_window).toEqual({ in_window: true });
      expect(r.value.token_window).toEqual({ in_window: true });
    } else {
      expect.unreachable('a 2.0 identity block must route to the 2.0 walk');
    }
  });

  it('routes an archived 2.0 bundle to the course walk without an institution anchor', async () => {
    // The backwards-compatibility guarantee in one assertion: a caller that only
    // has a course_cert — every reader written before institution identity
    // existed — still gets a complete, successful course-scoped walk.
    const input = await chainInput();
    expect('institution_cert' in input).toBe(false);
    const r = await verifyIdentityChain(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.identity_version).toBe('2.0');
  });

  // --- step 0: version gate --------------------------------------------------

  it('refuses an enrollment_cert whose version is neither 2.0 nor 2.1, BEFORE any signature work', async () => {
    const cert = await makeEnrollmentCert({ format_version: '1.0' });
    const r = await verifyIdentityChain(
      await chainInput({ identity: await makeIdentity({ enrollment_cert: cert }) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('unsupported_identity_version');
      expect(r.error).toMatchObject({ format_version: '1.0' });
    }
  });

  it('refuses a FUTURE 3.0 identity outright rather than walking it as 2.0', async () => {
    // The downgrade guard: both artifacts genuinely signed, both declaring 3.0.
    // A reader that ignored the gate would happily walk them under 2.0 rules.
    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({
          enrollment_cert: await makeEnrollmentCert({ format_version: '3.0' }),
          enrollment: await makeToken({ format_version: '3.0' }),
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('unsupported_identity_version');
      expect(r.error).toMatchObject({ format_version: '3.0' });
    }
  });

  it('refuses a cert and a token that declare DIFFERENT versions', async () => {
    const token = await makeToken({ format_version: '3.0' });
    const r = await verifyIdentityChain(
      await chainInput({ identity: await makeIdentity({ enrollment: token }) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('identity_version_mismatch');
      expect(r.error).toMatchObject({ cert_version: '2.0', credential_version: '3.0' });
    }
  });

  it('reports a missing course_cert anchor rather than silently passing', async () => {
    // Omit the key entirely — `exactOptionalPropertyTypes` makes an explicit
    // `undefined` a type error, which is the stronger contract.
    const withAnchor = await chainInput();
    const withoutAnchor = { ...withAnchor };
    delete withoutAnchor.course_cert;
    const r = await verifyIdentityChain(withoutAnchor);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('missing_trust_anchor');
      expect(r.error).toMatchObject({ required: 'course_cert' });
    }
  });

  // --- step 0b: shape before signatures --------------------------------------

  it('rejects a shape-invalid cert before doing signature work', async () => {
    const cert = (await makeEnrollmentCert()) as unknown as Record<string, unknown>;
    delete cert['valid_until'];
    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({ enrollment_cert: cert as unknown as EnrollmentCert }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_cert_shape');
  });

  it('rejects a token missing a signed field — canonicalize would omit it silently', async () => {
    const token = (await makeToken()) as unknown as Record<string, unknown>;
    delete token['expires_at'];
    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({ enrollment: token as unknown as EnrollmentToken }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_token_shape');
  });

  // --- step 1: enrollment_cert vs course key ---------------------------------

  it('fails when the enrollment_cert was signed by a different course key', async () => {
    const cert = await makeEnrollmentCert({}, OTHER_COURSE_PRIV);
    const r = await verifyIdentityChain(
      await chainInput({ identity: await makeIdentity({ enrollment_cert: cert }) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_course_signature');
  });

  // --- step 2: token vs enrollment key ---------------------------------------

  it('fails when the token was signed by a key the course never certified', async () => {
    const token = await makeToken({}, WRONG_ENROLLMENT_PRIV);
    const r = await verifyIdentityChain(
      await chainInput({ identity: await makeIdentity({ enrollment: token }) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_enrollment_signature');
  });

  // --- step 3: course_id agreement at EVERY link -----------------------------

  it('fails when the token names a different course than the enrollment_cert', async () => {
    const token = await makeToken({ course_id: OTHER_COURSE_ID });
    const identity = await makeIdentity({ enrollment: token });
    const r = await verifyIdentityChain(await chainInput({ identity }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('course_id_mismatch');
  });

  it('fails when the enrollment_cert names a different course than the course_cert', async () => {
    // Both signatures are genuine: 61B's course key certifies an enrollment key
    // "for 61C". Only comparing ids across all three links catches it.
    const enrollmentCert = await makeEnrollmentCert({ course_id: OTHER_COURSE_ID });
    const token = await makeToken({ course_id: OTHER_COURSE_ID });
    const identity = await makeIdentity({ enrollment: token, enrollment_cert: enrollmentCert });
    const r = await verifyIdentityChain(await chainInput({ identity }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('course_id_mismatch');
      expect(r.error).toMatchObject({
        cert_course_id: OTHER_COURSE_ID,
        course_cert_course_id: COURSE_ID,
      });
    }
  });

  // --- step 4: session_pubkey_sig -------------------------------------------

  it('fails when the session_pubkey_sig came from another student key', async () => {
    const identity = await makeIdentity({}, OTHER_STUDENT_PRIV);
    const r = await verifyIdentityChain(await chainInput({ identity }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_session_pubkey_signature');
  });

  it('fails when the session_pubkey argument is not the one that was countersigned', async () => {
    const r = await verifyIdentityChain(
      await chainInput({ session_pubkey: await pubHex(seed(0x13)) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_session_pubkey_signature');
  });

  it('rejects a malformed session_pubkey argument as its own error', async () => {
    const r = await verifyIdentityChain(await chainInput({ session_pubkey: 'nope' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_session_pubkey');
  });

  // --- step 5: expiry is NON-FATAL ------------------------------------------

  it('still succeeds with an EXPIRED token, reporting the window instead of blocking', async () => {
    // Program spec §4: an expired credential must never stop a recorder from
    // recording. Report it; the analyzer decides.
    const token = await makeToken({
      issued_at: '2025-09-01T00:00:00Z',
      expires_at: '2025-12-15',
    });
    const identity = await makeIdentity({ enrollment: token });
    const r = await verifyIdentityChain(await chainInput({ identity }));
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value.token_window).toEqual({ in_window: false, reason: 'after_valid_until' });
  });

  it('still succeeds with an EXPIRED enrollment_cert', async () => {
    const cert = await makeEnrollmentCert({
      valid_from: '2020-01-01',
      valid_until: '2020-12-31',
    });
    const identity = await makeIdentity({ enrollment_cert: cert });
    const r = await verifyIdentityChain(await chainInput({ identity }));
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value.cert_window).toEqual({ in_window: false, reason: 'after_valid_until' });
  });

  it('evaluates the enrollment_cert window against the TOKEN issue time, not wall-clock now', async () => {
    // An archived 2026 bundle must still verify in 2030. The cert covers
    // 2026-08-20..2027-01-15 and the token was issued 2026-09-01, so this is
    // in-window regardless of when the test runs.
    const r = await verifyIdentityChain(await chainInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cert_window).toEqual({ in_window: true });
  });

  it('evaluates the token window against the SESSION start, not wall-clock now', async () => {
    const r = await verifyIdentityChain(
      await chainInput({ session_started_at: '2026-12-31T00:00:00Z' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.token_window).toEqual({ in_window: true });
  });
});
