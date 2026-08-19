import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  INSTITUTION_IDENTITY_FORMAT_VERSION,
  STUDENT_SESSION_BINDING_PURPOSE,
  buildInstitutionCertSignedPayload,
  buildStudentCredentialSignedPayload,
  buildStudentSessionBindingPayload,
  parseInstitutionCert,
  parseStudentCredential,
  signInstitutionCert,
  signStudentCredential,
  signStudentSessionBinding,
  verifyInstitutionCert,
  verifyStudentCredential,
  verifyStudentSessionBinding,
  checkInstitutionCertWindow,
  checkCredentialWindow,
} from './institution.js';
import type { InstitutionCert, StudentCredential } from './institution.js';
import { verifyIdentityChain } from './enrollment.js';
import type { SessionIdentity } from './enrollment.js';
import { canonicalize } from './canonical.js';

// ---------------------------------------------------------------------------
// Fixed keys — the same seeds tools/export-conformance-vectors.ts uses, so a
// change here surfaces as a conformance-vector diff in the sibling repos too.
// ---------------------------------------------------------------------------

const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);

const ROOT_PRIV = seed(0x0a);
const WRONG_ROOT_PRIV = seed(0x0c);
const INSTITUTION_PRIV = seed(0x14);
const OTHER_INSTITUTION_PRIV = seed(0x15);
const STUDENT_PRIV = seed(0x16);
const OTHER_STUDENT_PRIV = seed(0x17);
const SESSION_PRIV = seed(0x18);

const INSTITUTION_ID = 'berkeley';
const OTHER_INSTITUTION_ID = 'stanford';
const STUDENT_REF = '9c8e1a70-2f2b-4c55-8f1e-6b4a0d9c7e21';

const CERT_VALID_FROM = '2026-08-20';
const CERT_VALID_UNTIL = '2027-01-15';
const CREDENTIAL_ISSUED_AT = '2026-09-01T00:00:00Z';
const CREDENTIAL_EXPIRES_AT = '2027-01-15';
const SESSION_STARTED_AT = '2026-09-08T12:00:00Z';

const pubHex = async (priv: Uint8Array): Promise<string> =>
  bytesToHex(await ed.getPublicKeyAsync(priv));

async function makeInstitutionCert(
  overrides: Partial<Omit<InstitutionCert, 'root_sig'>> = {},
  rootPriv: Uint8Array = ROOT_PRIV,
): Promise<InstitutionCert> {
  const unsigned = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: INSTITUTION_ID,
    institution_pubkey: await pubHex(INSTITUTION_PRIV),
    valid_from: CERT_VALID_FROM,
    valid_until: CERT_VALID_UNTIL,
    ...overrides,
  };
  return { ...unsigned, root_sig: await signInstitutionCert(unsigned, rootPriv) };
}

async function makeCredential(
  overrides: Partial<Omit<StudentCredential, 'institution_sig'>> = {},
  institutionPriv: Uint8Array = INSTITUTION_PRIV,
): Promise<StudentCredential> {
  const unsigned = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: INSTITUTION_ID,
    student_ref: STUDENT_REF,
    student_pubkey: await pubHex(STUDENT_PRIV),
    issued_at: CREDENTIAL_ISSUED_AT,
    expires_at: CREDENTIAL_EXPIRES_AT,
    ...overrides,
  };
  return {
    ...unsigned,
    institution_sig: await signStudentCredential(unsigned, institutionPriv),
  };
}

async function makeIdentity(
  overrides: Partial<SessionIdentity> = {},
  studentPriv: Uint8Array = STUDENT_PRIV,
): Promise<SessionIdentity> {
  const enrollment = (overrides.enrollment ?? (await makeCredential())) as StudentCredential;
  const enrollment_cert = overrides.enrollment_cert ?? (await makeInstitutionCert());
  const sessionPubkey = await pubHex(SESSION_PRIV);
  return {
    enrollment,
    enrollment_cert,
    session_pubkey_sig:
      overrides.session_pubkey_sig ??
      (await signStudentSessionBinding(
        {
          institution_id: enrollment.institution_id,
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
    institution_cert: await makeInstitutionCert(),
    session_started_at: SESSION_STARTED_AT,
    ...overrides,
  } as Parameters<typeof verifyIdentityChain>[0];
}

// ---------------------------------------------------------------------------
// Signed payloads — the exact bytes three ports must reproduce
// ---------------------------------------------------------------------------

describe('buildInstitutionCertSignedPayload', () => {
  it('emits JCS key order and excludes root_sig', async () => {
    const cert = await makeInstitutionCert();
    const text = new TextDecoder().decode(buildInstitutionCertSignedPayload(cert));
    expect(text).toBe(
      canonicalize({
        format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
        institution_id: INSTITUTION_ID,
        institution_pubkey: await pubHex(INSTITUTION_PRIV),
        valid_from: CERT_VALID_FROM,
        valid_until: CERT_VALID_UNTIL,
      }),
    );
    expect(text).not.toContain('root_sig');
    expect(text.indexOf('"format_version"')).toBeLessThan(text.indexOf('"institution_id"'));
    expect(text.indexOf('"institution_pubkey"')).toBeLessThan(text.indexOf('"valid_from"'));
  });

  it('ignores unknown keys, so a forward-compatible field cannot move the bytes', async () => {
    const cert = { ...(await makeInstitutionCert()), future_field: 'ignored' };
    const text = new TextDecoder().decode(buildInstitutionCertSignedPayload(cert));
    expect(text).not.toContain('future_field');
  });
});

describe('buildStudentCredentialSignedPayload', () => {
  it('emits JCS key order and excludes institution_sig', async () => {
    const credential = await makeCredential();
    const text = new TextDecoder().decode(buildStudentCredentialSignedPayload(credential));
    expect(text).toBe(
      canonicalize({
        expires_at: CREDENTIAL_EXPIRES_AT,
        format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
        institution_id: INSTITUTION_ID,
        issued_at: CREDENTIAL_ISSUED_AT,
        student_pubkey: await pubHex(STUDENT_PRIV),
        student_ref: STUDENT_REF,
      }),
    );
    expect(text).not.toContain('institution_sig');
  });

  it('carries student_ref as a VALUE at a fixed ASCII key, never as a key', async () => {
    // The Lua port sorts JCS object keys bytewise while JS and Kotlin sort by
    // UTF-16 code unit, so a user-derived object key can silently produce
    // different signed bytes across the three recorders.
    const text = new TextDecoder().decode(
      buildStudentCredentialSignedPayload(await makeCredential()),
    );
    expect(text).toContain(`"student_ref":"${STUDENT_REF}"`);
    expect(text).not.toContain(`"${STUDENT_REF}":`);
  });

  it('contains no JSON arrays', async () => {
    const text = new TextDecoder().decode(
      buildStudentCredentialSignedPayload(await makeCredential()),
    );
    expect(text).not.toContain('[');
  });
});

describe('buildStudentSessionBindingPayload', () => {
  it('binds institution_id, student_ref, and session_pubkey under a fixed purpose tag', async () => {
    const sessionPubkey = await pubHex(SESSION_PRIV);
    const text = new TextDecoder().decode(
      buildStudentSessionBindingPayload({
        institution_id: INSTITUTION_ID,
        student_ref: STUDENT_REF,
        session_pubkey: sessionPubkey,
      }),
    );
    expect(text).toBe(
      canonicalize({
        institution_id: INSTITUTION_ID,
        purpose: STUDENT_SESSION_BINDING_PURPOSE,
        session_pubkey: sessionPubkey,
        student_ref: STUDENT_REF,
      }),
    );
  });

  it('uses a DIFFERENT purpose tag from the 2.0 binding, so the two cannot be confused', () => {
    expect(STUDENT_SESSION_BINDING_PURPOSE).toBe('provenance-session-pubkey-binding-v2');
    expect(STUDENT_SESSION_BINDING_PURPOSE).not.toBe('provenance-session-pubkey-binding-v1');
  });
});

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

describe('parseInstitutionCert', () => {
  it('accepts a well-formed cert', async () => {
    const r = parseInstitutionCert(await makeInstitutionCert());
    expect(r.ok).toBe(true);
  });

  it.each(['format_version', 'institution_id', 'valid_from', 'valid_until'])(
    'rejects a missing %s',
    async (field) => {
      const cert = (await makeInstitutionCert()) as unknown as Record<string, unknown>;
      delete cert[field];
      const r = parseInstitutionCert(cert);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ kind: 'invalid_shape', field });
    },
  );

  it('treats an undefined-valued key exactly like a missing one', async () => {
    // `canonicalize` OMITS undefined-valued keys, so the two are the same thing
    // by the time bytes are signed and nothing may rely on the difference.
    const cert = { ...(await makeInstitutionCert()), institution_id: undefined };
    const r = parseInstitutionCert(cert);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'institution_id' });
  });

  it('rejects a non-hex institution_pubkey', async () => {
    const r = parseInstitutionCert({
      ...(await makeInstitutionCert()),
      institution_pubkey: 'zz',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'institution_pubkey' });
  });

  it('rejects a non-hex root_sig', async () => {
    const r = parseInstitutionCert({ ...(await makeInstitutionCert()), root_sig: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'root_sig' });
  });

  it('rejects an unparseable bound', async () => {
    const r = parseInstitutionCert({ ...(await makeInstitutionCert()), valid_until: 'whenever' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'valid_until' });
  });

  it('rejects valid_until earlier than valid_from', async () => {
    const r = parseInstitutionCert({
      ...(await makeInstitutionCert()),
      valid_from: '2027-01-01',
      valid_until: '2026-01-01',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'valid_until' });
  });

  it.each([
    ['a string', 'nope'],
    ['null', null],
    ['an array', []],
  ] as const)('rejects %s', (_label, value) => {
    const r = parseInstitutionCert(value);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toMatchObject({ kind: 'invalid_shape', reason: 'must be an object' });
  });
});

describe('parseStudentCredential', () => {
  it('accepts a well-formed credential', async () => {
    const r = parseStudentCredential(await makeCredential());
    expect(r.ok).toBe(true);
  });

  it.each(['format_version', 'institution_id', 'student_ref', 'issued_at', 'expires_at'])(
    'rejects a missing %s',
    async (field) => {
      const credential = (await makeCredential()) as unknown as Record<string, unknown>;
      delete credential[field];
      const r = parseStudentCredential(credential);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ kind: 'invalid_shape', field });
    },
  );

  it('rejects a non-hex student_pubkey', async () => {
    const r = parseStudentCredential({ ...(await makeCredential()), student_pubkey: 'zz' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'student_pubkey' });
  });

  it('rejects a non-hex institution_sig', async () => {
    const r = parseStudentCredential({ ...(await makeCredential()), institution_sig: 'zz' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'institution_sig' });
  });

  it('rejects expires_at earlier than issued_at', async () => {
    const r = parseStudentCredential({
      ...(await makeCredential()),
      issued_at: '2027-01-01T00:00:00Z',
      expires_at: '2026-01-01',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ field: 'expires_at' });
  });

  it.each([
    ['a string', 'nope'],
    ['null', null],
    ['an array', []],
  ] as const)('rejects %s', (_label, value) => {
    const r = parseStudentCredential(value);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toMatchObject({ kind: 'invalid_shape', reason: 'must be an object' });
  });
});

// ---------------------------------------------------------------------------
// Single-link verification
// ---------------------------------------------------------------------------

describe('verifyInstitutionCert', () => {
  it('accepts a cert genuinely signed by the root key', async () => {
    const r = await verifyInstitutionCert(await makeInstitutionCert(), await pubHex(ROOT_PRIV));
    expect(r.ok).toBe(true);
  });

  it('rejects a cert signed by a key that is not the root', async () => {
    const cert = await makeInstitutionCert({}, WRONG_ROOT_PRIV);
    const r = await verifyInstitutionCert(cert, await pubHex(ROOT_PRIV));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'invalid_signature' });
  });

  it('rejects a cert whose institution_pubkey was swapped after signing', async () => {
    const cert = await makeInstitutionCert();
    const tampered = { ...cert, institution_pubkey: await pubHex(OTHER_INSTITUTION_PRIV) };
    const r = await verifyInstitutionCert(tampered, await pubHex(ROOT_PRIV));
    expect(r.ok).toBe(false);
  });

  it('treats a malformed signature as a failure, not an exception', async () => {
    const cert = { ...(await makeInstitutionCert()), root_sig: 'not-hex' };
    const r = await verifyInstitutionCert(cert, await pubHex(ROOT_PRIV));
    expect(r.ok).toBe(false);
  });

  it('treats a malformed public key as a failure, not an exception', async () => {
    const r = await verifyInstitutionCert(await makeInstitutionCert(), 'not-hex');
    expect(r.ok).toBe(false);
  });

  it('treats a well-formed but invalid curve point as a failure, not an exception', async () => {
    // 64 hex chars that are not a valid ed25519 point: @noble throws internally,
    // and a value arriving from a student-editable file must never do that.
    const r = await verifyInstitutionCert(await makeInstitutionCert(), 'ff'.repeat(32));
    expect(r.ok).toBe(false);
  });
});

describe('verifyStudentCredential', () => {
  it('accepts a credential signed by the certified institution key', async () => {
    const r = await verifyStudentCredential(await makeCredential(), await pubHex(INSTITUTION_PRIV));
    expect(r.ok).toBe(true);
  });

  it('rejects a credential signed by an uncertified key', async () => {
    const credential = await makeCredential({}, OTHER_INSTITUTION_PRIV);
    const r = await verifyStudentCredential(credential, await pubHex(INSTITUTION_PRIV));
    expect(r.ok).toBe(false);
  });

  it('rejects a credential whose student_pubkey was swapped after signing', async () => {
    const credential = await makeCredential();
    const tampered = { ...credential, student_pubkey: await pubHex(OTHER_STUDENT_PRIV) };
    const r = await verifyStudentCredential(tampered, await pubHex(INSTITUTION_PRIV));
    expect(r.ok).toBe(false);
  });
});

describe('verifyStudentSessionBinding', () => {
  it('accepts the student key countersigning its own session pubkey', async () => {
    const sessionPubkey = await pubHex(SESSION_PRIV);
    const binding = {
      institution_id: INSTITUTION_ID,
      student_ref: STUDENT_REF,
      session_pubkey: sessionPubkey,
    };
    const sig = await signStudentSessionBinding(binding, STUDENT_PRIV);
    const r = await verifyStudentSessionBinding(binding, sig, await pubHex(STUDENT_PRIV));
    expect(r.ok).toBe(true);
  });

  it('rejects a countersignature made by a different student key', async () => {
    const binding = {
      institution_id: INSTITUTION_ID,
      student_ref: STUDENT_REF,
      session_pubkey: await pubHex(SESSION_PRIV),
    };
    const sig = await signStudentSessionBinding(binding, OTHER_STUDENT_PRIV);
    const r = await verifyStudentSessionBinding(binding, sig, await pubHex(STUDENT_PRIV));
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Windows — non-fatal, never against wall-clock now
// ---------------------------------------------------------------------------

describe('checkCredentialWindow', () => {
  it('is in window mid-semester', async () => {
    expect(checkCredentialWindow(await makeCredential(), '2026-10-01T00:00:00Z')).toEqual({
      in_window: true,
    });
  });

  it('reports a session predating issuance', async () => {
    expect(checkCredentialWindow(await makeCredential(), '2026-08-25T00:00:00Z')).toEqual({
      in_window: false,
      reason: 'before_valid_from',
    });
  });

  it('treats a date-only expires_at as covering the WHOLE of that day', async () => {
    expect(checkCredentialWindow(await makeCredential(), '2027-01-15T23:59:59Z')).toEqual({
      in_window: true,
    });
  });

  it('and expires at the first instant of the next day', async () => {
    expect(checkCredentialWindow(await makeCredential(), '2027-01-16T00:00:00Z')).toEqual({
      in_window: false,
      reason: 'after_valid_until',
    });
  });

  it('reports an unparseable instant rather than throwing', async () => {
    expect(checkCredentialWindow(await makeCredential(), 'whenever')).toEqual({
      in_window: false,
      reason: 'unparseable_timestamp',
    });
  });
});

describe('checkInstitutionCertWindow', () => {
  it('is judged against the instant it is given, not wall-clock now', async () => {
    const cert = await makeInstitutionCert();
    expect(checkInstitutionCertWindow(cert, CREDENTIAL_ISSUED_AT)).toEqual({ in_window: true });
    expect(checkInstitutionCertWindow(cert, '2020-01-01T00:00:00Z')).toEqual({
      in_window: false,
      reason: 'before_valid_from',
    });
  });

  it('reports an unparseable bound rather than throwing', async () => {
    const cert = { ...(await makeInstitutionCert()), valid_from: 'whenever' };
    expect(checkInstitutionCertWindow(cert, CREDENTIAL_ISSUED_AT)).toEqual({
      in_window: false,
      reason: 'unparseable_timestamp',
    });
  });
});

// ---------------------------------------------------------------------------
// verifyIdentityChain — the 2.1 institution walk
// ---------------------------------------------------------------------------

describe('verifyIdentityChain (2.1 institution)', () => {
  it('walks institution_cert -> credential -> session_pubkey_sig', async () => {
    const r = await verifyIdentityChain(await chainInput());
    expect(r.ok).toBe(true);
    if (r.ok && r.value.identity_version === '2.1') {
      expect(r.value.scope).toBe('institution');
      expect(r.value.institution_id).toBe(INSTITUTION_ID);
      expect(r.value.student_ref).toBe(STUDENT_REF);
      expect(r.value.student_pubkey).toBe(await pubHex(STUDENT_PRIV));
      expect(r.value.institution_pubkey).toBe(await pubHex(INSTITUTION_PRIV));
      expect(r.value.cert_window).toEqual({ in_window: true });
      expect(r.value.token_window).toEqual({ in_window: true });
    } else {
      expect.unreachable('a 2.1 identity block must route to the institution walk');
    }
  });

  it('does NOT need a course_cert — identity no longer depends on a course', async () => {
    const input = await chainInput();
    expect('course_cert' in input).toBe(false);
    expect((await verifyIdentityChain(input)).ok).toBe(true);
  });

  // --- step 0: version gate --------------------------------------------------

  it('refuses a 3.0 institution cert BEFORE any signature work', async () => {
    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({
          enrollment_cert: await makeInstitutionCert({ format_version: '3.0' }),
          enrollment: await makeCredential({ format_version: '3.0' }),
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('unsupported_identity_version');
      expect(r.error).toMatchObject({ format_version: '3.0' });
    }
  });

  it('refuses a 2.1 cert paired with a 2.0-versioned credential', async () => {
    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({
          enrollment: await makeCredential({ format_version: '2.0' }),
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('identity_version_mismatch');
      expect(r.error).toMatchObject({ cert_version: '2.1', credential_version: '2.0' });
    }
  });

  it('refuses a cert with a non-string format_version', async () => {
    const r = await verifyIdentityChain(
      await chainInput({
        identity: {
          ...(await makeIdentity()),
          enrollment_cert: { ...(await makeInstitutionCert()), format_version: 7 },
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('unsupported_identity_version');
      expect(r.error).toMatchObject({ format_version: '' });
    }
  });

  it('refuses a credential with a non-string format_version', async () => {
    const r = await verifyIdentityChain(
      await chainInput({
        identity: {
          ...(await makeIdentity()),
          enrollment: { ...(await makeCredential()), format_version: null },
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('identity_version_mismatch');
  });

  it('reports a missing institution_cert anchor rather than silently passing', async () => {
    const { institution_cert: _omitted, ...withoutAnchor } = await chainInput();
    const r = await verifyIdentityChain(withoutAnchor);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('missing_trust_anchor');
      expect(r.error).toMatchObject({ required: 'institution_cert' });
    }
  });

  // --- step 0b: shape before signatures --------------------------------------

  it('rejects a shape-invalid cert before doing signature work', async () => {
    const cert = (await makeInstitutionCert()) as unknown as Record<string, unknown>;
    delete cert['valid_until'];
    const r = await verifyIdentityChain(
      await chainInput({
        identity: { ...(await makeIdentity()), enrollment_cert: cert },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_cert_shape');
      expect(r.error).toMatchObject({ field: 'valid_until' });
    }
  });

  it('rejects a shape-invalid credential before doing signature work', async () => {
    const credential = (await makeCredential()) as unknown as Record<string, unknown>;
    delete credential['student_ref'];
    const r = await verifyIdentityChain(
      await chainInput({
        identity: { ...(await makeIdentity()), enrollment: credential },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_token_shape');
      expect(r.error).toMatchObject({ field: 'student_ref' });
    }
  });

  // --- step 1: the credential must be signed by the root-certified key -------

  it('rejects a credential signed by a key the root never certified', async () => {
    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({
          enrollment: await makeCredential({}, OTHER_INSTITUTION_PRIV),
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_institution_signature');
  });

  it('verifies against the ANCHOR key, so swapping the travelling cert cannot install a new key', async () => {
    // The travelling cert names the attacker's institution key AND is genuinely
    // root-signed; only the anchor still names the real one. Reading the key
    // from the anchor means the forged credential never verifies at all.
    const attackerCert = await makeInstitutionCert({
      institution_pubkey: await pubHex(OTHER_INSTITUTION_PRIV),
    });
    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({
          enrollment_cert: attackerCert,
          enrollment: await makeCredential({}, OTHER_INSTITUTION_PRIV),
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_institution_signature');
  });

  // --- step 2: THE INSTITUTION ANCHOR CHECK ---------------------------------

  it('MANDATORY: rejects a cross-institution forgery in which every signature is genuine', async () => {
    // Stanford holds a genuinely root-certified institution key. It mints a
    // credential naming BERKELEY and ships it with its own genuine cert.
    // Signature-wise everything checks out: the cert is root-signed, and the
    // credential is signed by exactly the key that cert names. Only comparing
    // the institution id at every link rejects it. This is the institution-scoped
    // replacement for the 2.0 cross-course forgery check, and it must be
    // impossible, not merely unlikely.
    const stanfordCert = await makeInstitutionCert({
      institution_id: OTHER_INSTITUTION_ID,
      institution_pubkey: await pubHex(OTHER_INSTITUTION_PRIV),
    });
    const berkeleyClaimingCredential = await makeCredential(
      { institution_id: INSTITUTION_ID },
      OTHER_INSTITUTION_PRIV,
    );

    // Both signatures are individually genuine — assert that, so the test cannot
    // pass for the wrong reason.
    expect((await verifyInstitutionCert(stanfordCert, await pubHex(ROOT_PRIV))).ok).toBe(true);
    expect(
      (
        await verifyStudentCredential(
          berkeleyClaimingCredential,
          await pubHex(OTHER_INSTITUTION_PRIV),
        )
      ).ok,
    ).toBe(true);

    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({
          enrollment_cert: stanfordCert,
          enrollment: berkeleyClaimingCredential,
        }),
        institution_cert: stanfordCert,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('institution_mismatch');
      expect(r.error).toMatchObject({
        credential_institution_id: INSTITUTION_ID,
        cert_institution_id: OTHER_INSTITUTION_ID,
        anchor_institution_id: OTHER_INSTITUTION_ID,
        pubkey_mismatch: false,
      });
    }
  });

  it('rejects a travelling cert that names a different institution than the anchor', async () => {
    const otherCert = await makeInstitutionCert({ institution_id: OTHER_INSTITUTION_ID });
    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({ enrollment_cert: otherCert }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('institution_mismatch');
      expect(r.error).toMatchObject({ anchor_institution_id: INSTITUTION_ID });
    }
  });

  it('rejects a travelling cert that names a different KEY than the anchor', async () => {
    // Same institution id, different certified key. Caught by the pubkey half of
    // the anchor check, and reported as such.
    const swappedKeyCert = await makeInstitutionCert({
      institution_pubkey: await pubHex(OTHER_INSTITUTION_PRIV),
    });
    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({ enrollment_cert: swappedKeyCert }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('institution_mismatch');
      expect(r.error).toMatchObject({ pubkey_mismatch: true });
    }
  });

  // --- step 3: the session binding ------------------------------------------

  it('rejects a session pubkey that is not 64-char hex', async () => {
    const r = await verifyIdentityChain(await chainInput({ session_pubkey: 'nope' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_session_pubkey');
  });

  it('rejects a countersignature made by a different student key', async () => {
    const r = await verifyIdentityChain(
      await chainInput({ identity: await makeIdentity({}, OTHER_STUDENT_PRIV) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_session_pubkey_signature');
  });

  it('rejects a genuine countersignature lifted onto a DIFFERENT session key', async () => {
    const r = await verifyIdentityChain(
      await chainInput({ session_pubkey: await pubHex(seed(0x19)) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_session_pubkey_signature');
  });

  it('rejects a 2.0 countersignature replayed into a 2.1 chain', async () => {
    // Different purpose tag, different payload shape: a v1 binding can never
    // satisfy a v2 chain even for the same student and the same session key.
    const { buildSessionPubkeyBindingPayload } = await import('./enrollment.js');
    const v1Payload = buildSessionPubkeyBindingPayload({
      course_id: INSTITUTION_ID,
      student_ref: STUDENT_REF,
      session_pubkey: await pubHex(SESSION_PRIV),
    });
    const v1Sig = bytesToHex(await ed.signAsync(v1Payload, STUDENT_PRIV));
    const r = await verifyIdentityChain(
      await chainInput({
        identity: { ...(await makeIdentity()), session_pubkey_sig: v1Sig },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_session_pubkey_signature');
  });

  // --- step 4: windows are reported, never enforced --------------------------

  it('an EXPIRED credential still returns ok, reporting token_window', async () => {
    // An expired credential must never stop a recorder from recording (program
    // spec §4). The analyzer decides what to do about it.
    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({
          enrollment: await makeCredential({
            issued_at: '2025-09-01T00:00:00Z',
            expires_at: '2025-12-15',
          }),
        }),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.token_window).toEqual({ in_window: false, reason: 'after_valid_until' });
    }
  });

  it('an EXPIRED institution cert still returns ok, reporting cert_window', async () => {
    const expiredCert = await makeInstitutionCert({
      valid_from: '2020-01-01',
      valid_until: '2020-12-31',
    });
    const r = await verifyIdentityChain(
      await chainInput({
        identity: await makeIdentity({ enrollment_cert: expiredCert }),
        institution_cert: expiredCert,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cert_window).toEqual({ in_window: false, reason: 'after_valid_until' });
    }
  });

  it('judges the cert window against the CREDENTIAL issue time, not wall-clock now', async () => {
    // The archived-bundle guarantee: this must not depend on when the test runs.
    const r = await verifyIdentityChain(await chainInput());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cert_window).toEqual({ in_window: true });
  });
});
