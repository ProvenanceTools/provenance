/**
 * Test-only helper: mint `session.start.identity` blocks for BOTH identity
 * families — the archived 2.0 course-scoped chain (`log-core/enrollment.ts`) and
 * the current 2.1 institution-scoped one (`log-core/institution.ts`).
 *
 * Everything here signs for real, with the real log-core payload builders, so
 * `identity/resolve-contributors.test.ts` exercises the actual chain walk rather
 * than a hand-stubbed object. A fixture whose signature is a hex placeholder
 * cannot tell "we verified it" apart from "we never looked".
 *
 * Not browser-safe by design (test infrastructure only); it uses the same
 * @noble/ed25519 sha512 wiring as `build-test-bundle.ts`.
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  signEnrollmentCert,
  signEnrollmentToken,
  signSessionPubkey,
  signInstitutionCert,
  signStudentCredential,
  signStudentSessionBinding,
  ENROLLMENT_FORMAT_VERSION,
  INSTITUTION_IDENTITY_FORMAT_VERSION,
} from '@provenance/log-core';
import type {
  EnrollmentCert,
  EnrollmentToken,
  InstitutionCert,
  SessionIdentity,
  StudentCredential,
} from '@provenance/log-core';

// Same wiring as build-test-bundle.ts — jsdom's WebCrypto rejects the buffers
// @noble/ed25519's default async sha512 hands it.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type Keypair = { privkey: Uint8Array; pubkeyHex: string };

/** A deterministic ed25519 keypair from a single repeated seed byte. */
export async function seededKeypair(seedByte: number): Promise<Keypair> {
  const privkey = new Uint8Array(32).fill(seedByte);
  return { privkey, pubkeyHex: bytesToHex(await ed.getPublicKeyAsync(privkey)) };
}

export type IdentityTestKeys = {
  /** Signs course certs AND institution certs. Nothing else. */
  root: Keypair;
  /** 2.1: signs student credentials. Lives on the server. */
  institution: Keypair;
  /** 2.0: signs enrollment tokens. Authorized by the course key. */
  enrollment: Keypair;
  /** The student's long-lived key, which countersigns session pubkeys. */
  student: Keypair;
};

/**
 * Deterministic key material for the identity chains.
 *
 * `rootSeedByte` deliberately defaults to `0x11`, matching
 * `buildTrustChainKeys` in `build-manifest-2.ts`, so a test can mint a
 * Manifest 2.0 and a 2.0 identity that anchor to the SAME root.
 */
export async function buildIdentityKeys(opts?: {
  rootSeedByte?: number;
  institutionSeedByte?: number;
  enrollmentSeedByte?: number;
  studentSeedByte?: number;
}): Promise<IdentityTestKeys> {
  return {
    root: await seededKeypair(opts?.rootSeedByte ?? 0x11),
    institution: await seededKeypair(opts?.institutionSeedByte ?? 0x33),
    enrollment: await seededKeypair(opts?.enrollmentSeedByte ?? 0x44),
    student: await seededKeypair(opts?.studentSeedByte ?? 0x55),
  };
}

// ---------------------------------------------------------------------------
// 2.1 — institution-scoped (current)
// ---------------------------------------------------------------------------

export type BuildInstitutionIdentityOpts = {
  keys: IdentityTestKeys;
  /** The session's ephemeral public key, which the student key countersigns. */
  sessionPubkeyHex: string;
  institutionId?: string;
  /** Override just the CERT's institution_id, to drive `institution_mismatch`. */
  certInstitutionId?: string;
  studentRef?: string;
  issuedAt?: string;
  expiresAt?: string;
  validFrom?: string;
  validUntil?: string;
  /** Sign the institution cert with this key instead of root (forged anchor). */
  certSignedBy?: Uint8Array;
  /** Sign the credential with this key instead of the institution key. */
  credentialSignedBy?: Uint8Array;
  /** Countersign the session pubkey with this key instead of the student key. */
  countersignedBy?: Uint8Array;
  /** Countersign a DIFFERENT session pubkey — a replayed binding. */
  bindSessionPubkeyHex?: string;
};

/** Mint a fully-signed 2.1 `session.start.identity` block. */
export async function buildInstitutionIdentity(
  opts: BuildInstitutionIdentityOpts,
): Promise<SessionIdentity> {
  const {
    keys,
    sessionPubkeyHex,
    institutionId = 'berkeley',
    studentRef = '9c8e1a70-2f2b-4c55-8f1e-6b4a0d9c7e21',
    issuedAt = '2025-12-15T00:00:00Z',
    expiresAt = '2026-12-31',
    validFrom = '2025-12-01',
    validUntil = '2026-12-31',
  } = opts;

  const unsignedCert: Omit<InstitutionCert, 'root_sig'> = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: opts.certInstitutionId ?? institutionId,
    institution_pubkey: keys.institution.pubkeyHex,
    valid_from: validFrom,
    valid_until: validUntil,
  };
  const cert: InstitutionCert = {
    ...unsignedCert,
    root_sig: await signInstitutionCert(unsignedCert, opts.certSignedBy ?? keys.root.privkey),
  };

  const unsignedCredential: Omit<StudentCredential, 'institution_sig'> = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: institutionId,
    student_ref: studentRef,
    student_pubkey: keys.student.pubkeyHex,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const credential: StudentCredential = {
    ...unsignedCredential,
    institution_sig: await signStudentCredential(
      unsignedCredential,
      opts.credentialSignedBy ?? keys.institution.privkey,
    ),
  };

  return {
    enrollment: credential,
    enrollment_cert: cert,
    session_pubkey_sig: await signStudentSessionBinding(
      {
        institution_id: institutionId,
        student_ref: studentRef,
        session_pubkey: opts.bindSessionPubkeyHex ?? sessionPubkeyHex,
      },
      opts.countersignedBy ?? keys.student.privkey,
    ),
  };
}

// ---------------------------------------------------------------------------
// 2.0 — course-scoped (archived, supported forever)
// ---------------------------------------------------------------------------

export type BuildCourseIdentityOpts = {
  keys: IdentityTestKeys;
  /** The COURSE private key — the same one that signed the bundle's Manifest 2.0. */
  coursePrivkey: Uint8Array;
  sessionPubkeyHex: string;
  courseId?: string;
  /** Override just the CERT's course_id, to drive `course_id_mismatch`. */
  certCourseId?: string;
  studentRef?: string;
  issuedAt?: string;
  expiresAt?: string;
  validFrom?: string;
  validUntil?: string;
  /** Sign the enrollment cert with this key instead of the course key. */
  certSignedBy?: Uint8Array;
  /** Sign the token with this key instead of the enrollment key. */
  tokenSignedBy?: Uint8Array;
  countersignedBy?: Uint8Array;
};

/** Mint a fully-signed legacy 2.0 `session.start.identity` block. */
export async function buildCourseIdentity(
  opts: BuildCourseIdentityOpts,
): Promise<SessionIdentity> {
  const {
    keys,
    coursePrivkey,
    sessionPubkeyHex,
    courseId = 'berkeley-cs61b',
    studentRef = '5f0c2b31-7d44-4a19-9c88-1e2f3a4b5c6d',
    issuedAt = '2025-12-15T00:00:00Z',
    expiresAt = '2026-12-31',
    validFrom = '2025-12-01',
    validUntil = '2026-12-31',
  } = opts;

  const unsignedCert: Omit<EnrollmentCert, 'course_sig'> = {
    format_version: ENROLLMENT_FORMAT_VERSION,
    course_id: opts.certCourseId ?? courseId,
    enrollment_pubkey: keys.enrollment.pubkeyHex,
    valid_from: validFrom,
    valid_until: validUntil,
  };
  const cert: EnrollmentCert = {
    ...unsignedCert,
    course_sig: await signEnrollmentCert(unsignedCert, opts.certSignedBy ?? coursePrivkey),
  };

  const unsignedToken: Omit<EnrollmentToken, 'enrollment_sig'> = {
    format_version: ENROLLMENT_FORMAT_VERSION,
    student_ref: studentRef,
    course_id: courseId,
    student_pubkey: keys.student.pubkeyHex,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const token: EnrollmentToken = {
    ...unsignedToken,
    enrollment_sig: await signEnrollmentToken(
      unsignedToken,
      opts.tokenSignedBy ?? keys.enrollment.privkey,
    ),
  };

  return {
    enrollment: token,
    enrollment_cert: cert,
    session_pubkey_sig: await signSessionPubkey(
      { course_id: courseId, student_ref: studentRef, session_pubkey: sessionPubkeyHex },
      opts.countersignedBy ?? keys.student.privkey,
    ),
  };
}
