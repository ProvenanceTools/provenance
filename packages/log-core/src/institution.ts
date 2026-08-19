/**
 * Institution certificate + student credential — the INSTITUTION-SCOPED identity
 * chain, at identity `format_version` 2.1.
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §2, §5, §5a describe the 2.0 COURSE-scoped chain this replaces. Read
 * `enrollment.ts` first — this file is its deliberate structural parallel, and
 * that file remains live forever for archived bundles.
 *
 * ## Why identity stopped being course-scoped
 *
 * The 2.0 chain bound a student to a COURSE: a per-course derived key, a
 * course-signed enrollment cert, a token naming a `course_id`. Minting that token
 * required a roster match, and rosters are populated by the Gradescope ingest
 * path, which only runs AFTER a student submits. So a student could not obtain an
 * identity until after their first submission — but their sessions need an
 * identity BEFORE they work, or the work carries none. That is a deadlock, and
 * course-scoping is what creates it.
 *
 * What is actually needed is narrower than what 2.0 built: an identifier a
 * student obtains ONCE from our server, which lets a reader tell two students on
 * one submission apart and say which is which. Verifying course MEMBERSHIP is
 * explicitly not wanted — that is a roster question, answered later, by the
 * server, against data it owns.
 *
 * ## The chain
 *
 * ```
 *   root keypair              (offline, maintainer-held; signs course certs
 *        │ signs               AND institution certs — nothing else)
 *        ▼
 *   institution_cert          { format_version, institution_id,
 *        │ authorizes           institution_pubkey, valid_from, valid_until }
 *        ▼                      + root_sig
 *   institution keypair       ◄── LIVES ON THE SERVER. The only private key that
 *        │ signs                  does. Signs student credentials, nothing else.
 *        ▼
 *   student_credential        { format_version, institution_id, student_ref,
 *        │ authorizes           student_pubkey, issued_at, expires_at }
 *        ▼                      + institution_sig
 *   student keypair           (ONE per student, forever, across every course;
 *        │ countersigns         derived on the student's machine — student-keys.ts)
 *        ▼
 *   session_pubkey            (the existing ephemeral session key)
 * ```
 *
 * One delegation from root, not two. The 2.0 chain needed the extra
 * `course_cert → enrollment_cert` hop purely because the course key is offline
 * and cannot mint per-student tokens on demand. The institution key is certified
 * by root directly and lives on the server, so that hop has nothing left to do.
 *
 * **Course keys are unaffected.** They keep signing manifests and capture policy
 * exactly as before. This change is only about identity, and the identity chain
 * deliberately does NOT anchor to whichever `course_cert` a manifest carries.
 *
 * ## The invariant that replaces the cross-course forgery check
 *
 * The 2.0 walk compared `course_id` across three links, and that comparison was
 * not a formality: without it 61B's course key could certify an enrollment key
 * "for 61C", that key could mint a 61C token, and every signature would be
 * individually genuine. Only the comparison caught it.
 *
 * The institution chain has the identical hazard one level up, and needs the
 * identical answer. Root legitimately certifies MANY institutions. An attacker
 * holding a genuinely root-certified institution key for `stanford` can mint a
 * credential whose `institution_id` says `berkeley`, ship it with their own
 * (genuine, root-signed) `stanford` cert, and every signature verifies. What
 * stops it is asserting that
 *
 *     credential.institution_id === institution_cert.institution_id === anchor.institution_id
 *
 * and that the cert travelling in the bundle names the SAME public key as the
 * root-verified anchor. One signer's credential can then never be replayed under
 * another signer's authority. This is a MANDATORY conformance vector
 * (`cross_institution_forgery`), exactly as `cross_course_forgery` is for 2.0.
 *
 * ## `student_ref` is global, opaque, and always a VALUE
 *
 * `student_ref` is an opaque UUID — never a raw SID, name, or email. It is now
 * GLOBAL rather than per-course: one student, one ref, one credential, every
 * course. In a shared repo one partner can read the other's `session.start`, and
 * must see only a UUID.
 *
 * It is also never an object KEY in a signed payload — the permanent constraint
 * documented in `course-cert.ts`. provnvim's hand-rolled Lua JCS sorts object
 * keys bytewise while JS and Kotlin sort by UTF-16 code unit, so any user-derived
 * key risks silently different signed bytes across recorders. Every key in every
 * payload below is a fixed ASCII identifier chosen by us, and for the same
 * cross-port reason there are no JSON arrays anywhere in a signed payload.
 *
 * ## Expiry is reported, never enforced
 *
 * Unchanged from 2.0. An out-of-window credential is NOT an error; it is returned
 * on the success value for the caller to act on. An institution letting a cert
 * lapse mid-semester must not silently stop recording — for an integrity tool
 * that is a worse failure than recording under a stale credential (program spec
 * §4). And every window is judged against the RELEVANT ISSUE TIME, never
 * wall-clock now, so an archived bundle still verifies years later:
 *
 *  - the institution cert's window is checked against the CREDENTIAL's
 *    `issued_at` ("was this key authorized when it issued this credential");
 *  - the credential's window is checked against the SESSION start ("did this
 *    student hold a valid identity when they did this work").
 *
 * ## Revocation
 *
 * Not modelled here, for the same reason as `course_cert` and `enrollment_cert`:
 * an offline recorder cannot learn about it without a network call, which
 * recorder PRD NG2 forbids. A server-side list must key on `institution_pubkey`
 * and on `student_ref`, never on a certificate or credential identity — both
 * travel outside any payload that binds to them, so the holder chooses which copy
 * ships. The offline mitigation is short windows.
 */

import * as ed from '@noble/ed25519';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { canonicalize } from './canonical.js';
import { ok, err } from './result.js';
import type { Result } from './result.js';
import type { CertWindowStatus } from './course-cert.js';
import {
  HEX_64_RE,
  HEX_128_RE,
  requireString,
  requireHex,
  requireOrderedBounds,
  checkWindow,
} from './identity-shapes.js';

// ---------------------------------------------------------------------------
// Constants — the cross-language contract
// ---------------------------------------------------------------------------

/**
 * The identity `format_version` at which identity is INSTITUTION-scoped.
 *
 * This value is the DISCRIMINATOR the identity chain routes on. It lives inside
 * both signed payloads, so it cannot be flipped without invalidating a
 * signature, and `verifyIdentityChain` reads it before doing any signature work.
 *
 * Routing on a signed version — rather than on which fields happen to be present
 * — is not a stylistic preference here. `bundle-manifest.ts` once read the mere
 * PRESENCE of an embedded manifest as a 2.0 claim, and that made the entire
 * legacy path unreachable. Presence is attacker-controlled and ambiguous; a
 * signed version is neither.
 */
export const INSTITUTION_IDENTITY_FORMAT_VERSION = '2.1';

/**
 * Domain-separation tag for the 2.1 session-pubkey countersignature.
 *
 * Deliberately a DIFFERENT string from the 2.0 tag. The two binding payloads
 * already differ structurally (`institution_id` vs `course_id`), so their bytes
 * could never collide — but a distinct tag makes the separation an explicit
 * property of the protocol rather than an accident of field naming, and leaves
 * the 2.0 tag meaning exactly one thing forever.
 */
export const STUDENT_SESSION_BINDING_PURPOSE = 'provenance-session-pubkey-binding-v2';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A ROOT-signed statement that an INSTITUTION key may issue student credentials.
 *
 * Structurally the institution-side twin of `course_cert`: same issuer (root),
 * same window semantics, same "travels beside the thing it authorizes, outside
 * the payload that signs it" distribution rule. It rides inline in the
 * `session.start` identity block so a bundle is self-contained — an analyzer
 * adjudicating in 2031 has the whole chain in the file and fetches nothing.
 */
export type InstitutionCert = {
  /** Must be {@link INSTITUTION_IDENTITY_FORMAT_VERSION}. Inside the signed payload. */
  format_version: string;
  /**
   * The institution this key speaks for. MUST equal the credential's
   * `institution_id` and the root-verified anchor's — see the module docstring.
   */
  institution_id: string;
  /** Hex ed25519 public key of the server-held institution signing key, 64 chars. */
  institution_pubkey: string;
  /**
   * Inclusive lower bound. ISO 8601 date or timestamp. A date-only value means
   * the first instant of that day (UTC midnight).
   */
  valid_from: string;
  /**
   * Inclusive upper bound. A date-only value means THROUGH THE END of that day;
   * a full timestamp means exactly that instant. Same asymmetric resolution as
   * `course_cert.valid_until` — see `resolveValidUntilExclusiveMs`.
   */
  valid_until: string;
  /** Hex ed25519 signature by the ROOT key, 128 chars (64 bytes). */
  root_sig: string;
};

/**
 * An institution-signed statement that a student public key belongs to a
 * particular person at that institution.
 *
 * The whole of a student's identity, obtained ONCE. It names no course, no
 * assignment, and no semester — deliberately. Course membership is a roster
 * question the server answers later against data it owns; making it a
 * precondition of having an identity is what deadlocked the 2.0 design.
 */
export type StudentCredential = {
  /** Must be {@link INSTITUTION_IDENTITY_FORMAT_VERSION}. Inside the signed payload. */
  format_version: string;
  /** The institution whose key issued this. */
  institution_id: string;
  /**
   * Opaque GLOBAL roster reference. Never a student ID number, name, or email,
   * and never an object key. One per student, not one per course.
   */
  student_ref: string;
  /** Hex ed25519 public key of the student's single long-lived key, 64 chars. */
  student_pubkey: string;
  /** ISO 8601. Also the instant the institution cert's window is judged against. */
  issued_at: string;
  /** ISO 8601. Date-only resolves through the end of that day. */
  expires_at: string;
  /** Hex ed25519 signature by the INSTITUTION key, 128 chars (64 bytes). */
  institution_sig: string;
};

/** Failure modes of the single-link institution helpers. */
export type InstitutionError =
  | { kind: 'invalid_shape'; field?: string; reason?: string }
  | { kind: 'invalid_signature' };

// ---------------------------------------------------------------------------
// Signed payloads — the exact bytes three ports must reproduce
// ---------------------------------------------------------------------------

/**
 * Build the canonical bytes the ROOT key signs for an institution cert.
 *
 * `root_sig` is excluded; the five remaining fields are canonicalized. JCS orders
 * keys, so the literal order below is irrelevant to the output — the resulting
 * key order is always:
 *
 *   format_version, institution_id, institution_pubkey, valid_from, valid_until
 */
export function buildInstitutionCertSignedPayload(
  cert: Omit<InstitutionCert, 'root_sig'>,
): Uint8Array {
  const payload = canonicalize({
    format_version: cert.format_version,
    institution_id: cert.institution_id,
    institution_pubkey: cert.institution_pubkey,
    valid_from: cert.valid_from,
    valid_until: cert.valid_until,
  });
  return new TextEncoder().encode(payload);
}

/**
 * Build the canonical bytes the INSTITUTION key signs for a student credential.
 *
 * `institution_sig` is excluded; the six remaining fields are canonicalized. The
 * resulting JCS key order is always:
 *
 *   expires_at, format_version, institution_id, issued_at, student_pubkey, student_ref
 *
 * Note `student_ref` appears as a VALUE at a fixed ASCII key — never promoted to
 * a key itself. See the module docstring.
 */
export function buildStudentCredentialSignedPayload(
  credential: Omit<StudentCredential, 'institution_sig'>,
): Uint8Array {
  const payload = canonicalize({
    expires_at: credential.expires_at,
    format_version: credential.format_version,
    institution_id: credential.institution_id,
    issued_at: credential.issued_at,
    student_pubkey: credential.student_pubkey,
    student_ref: credential.student_ref,
  });
  return new TextEncoder().encode(payload);
}

/**
 * Build the canonical bytes the STUDENT key signs to bind an ephemeral
 * `session_pubkey` to itself.
 *
 * A bare 64-char hex string would have been the minimal thing to sign. It is not
 * what is signed, for the same two reasons as in 2.0:
 *
 *  - **Domain separation.** A signature over an unstructured blob is a signature
 *    over anything that blob might also mean. The fixed `purpose` tag makes this
 *    message unmistakably this message.
 *  - **Self-describing binding.** Including `institution_id` and `student_ref`
 *    means the countersignature itself asserts WHICH student, at WHICH
 *    institution, adopted this session key, rather than taking either on trust
 *    from elsewhere in the payload.
 *
 * JCS key order is always: institution_id, purpose, session_pubkey, student_ref.
 */
export function buildStudentSessionBindingPayload(binding: {
  institution_id: string;
  student_ref: string;
  session_pubkey: string;
}): Uint8Array {
  const payload = canonicalize({
    institution_id: binding.institution_id,
    purpose: STUDENT_SESSION_BINDING_PURPOSE,
    session_pubkey: binding.session_pubkey,
    student_ref: binding.student_ref,
  });
  return new TextEncoder().encode(payload);
}

// ---------------------------------------------------------------------------
// Shape validation — always before signature work
// ---------------------------------------------------------------------------

/**
 * Validate the shape of an already-JSON-parsed institution cert.
 *
 * Takes `unknown` rather than text because the cert travels inline inside a
 * `session.start` payload. Unknown keys are ignored for forward compatibility,
 * which is safe: canonicalization operates on the five named fields only, so an
 * unknown key cannot silently change the signed bytes.
 *
 * This does NOT check `format_version` against the expected constant — the chain
 * gates on that first and reports it as a distinct error, so a version problem is
 * never mistaken for a malformed artifact.
 */
export function parseInstitutionCert(value: unknown): Result<InstitutionCert, InstitutionError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({ kind: 'invalid_shape', reason: 'must be an object' });
  }
  const obj = value as Record<string, unknown>;

  const formatVersion = requireString(obj, 'format_version');
  if (!formatVersion.ok) return formatVersion;

  const institutionId = requireString(obj, 'institution_id');
  if (!institutionId.ok) return institutionId;

  const bounds = requireOrderedBounds(obj, 'valid_from', 'valid_until');
  if (!bounds.ok) return bounds;

  const institutionPubkey = requireHex(obj, 'institution_pubkey', HEX_64_RE, 64);
  if (!institutionPubkey.ok) return institutionPubkey;

  const rootSig = requireHex(obj, 'root_sig', HEX_128_RE, 128);
  if (!rootSig.ok) return rootSig;

  return ok({
    format_version: formatVersion.value,
    institution_id: institutionId.value,
    institution_pubkey: institutionPubkey.value,
    valid_from: bounds.value.lower,
    valid_until: bounds.value.upper,
    root_sig: rootSig.value,
  });
}

/**
 * Validate the shape of an already-JSON-parsed student credential. Unknown keys
 * are ignored, for the same reason as {@link parseInstitutionCert}.
 */
export function parseStudentCredential(
  value: unknown,
): Result<StudentCredential, InstitutionError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({ kind: 'invalid_shape', reason: 'must be an object' });
  }
  const obj = value as Record<string, unknown>;

  const formatVersion = requireString(obj, 'format_version');
  if (!formatVersion.ok) return formatVersion;

  const institutionId = requireString(obj, 'institution_id');
  if (!institutionId.ok) return institutionId;

  const studentRef = requireString(obj, 'student_ref');
  if (!studentRef.ok) return studentRef;

  const bounds = requireOrderedBounds(obj, 'issued_at', 'expires_at');
  if (!bounds.ok) return bounds;

  const studentPubkey = requireHex(obj, 'student_pubkey', HEX_64_RE, 64);
  if (!studentPubkey.ok) return studentPubkey;

  const institutionSig = requireHex(obj, 'institution_sig', HEX_128_RE, 128);
  if (!institutionSig.ok) return institutionSig;

  return ok({
    format_version: formatVersion.value,
    institution_id: institutionId.value,
    student_ref: studentRef.value,
    student_pubkey: studentPubkey.value,
    issued_at: bounds.value.lower,
    expires_at: bounds.value.upper,
    institution_sig: institutionSig.value,
  });
}

// ---------------------------------------------------------------------------
// Signing — maintainer/server tooling and the vector generator only.
// A recorder never calls the first two; it only ever verifies.
// ---------------------------------------------------------------------------

/** Sign an institution cert with the ROOT private key (offline operation). */
export async function signInstitutionCert(
  cert: Omit<InstitutionCert, 'root_sig'>,
  rootPrivkey: Uint8Array,
): Promise<string> {
  return bytesToHex(await ed.signAsync(buildInstitutionCertSignedPayload(cert), rootPrivkey));
}

/** Sign a student credential with the INSTITUTION private key (server-side). */
export async function signStudentCredential(
  credential: Omit<StudentCredential, 'institution_sig'>,
  institutionPrivkey: Uint8Array,
): Promise<string> {
  return bytesToHex(
    await ed.signAsync(buildStudentCredentialSignedPayload(credential), institutionPrivkey),
  );
}

/**
 * Countersign a session public key with the student's long-lived private key.
 * Called by the recorder at session start — the one signing operation on this
 * path that happens on the student's machine.
 */
export async function signStudentSessionBinding(
  binding: { institution_id: string; student_ref: string; session_pubkey: string },
  studentPrivkey: Uint8Array,
): Promise<string> {
  return bytesToHex(await ed.signAsync(buildStudentSessionBindingPayload(binding), studentPrivkey));
}

// ---------------------------------------------------------------------------
// Single-link verification
// ---------------------------------------------------------------------------

/**
 * Shared ed25519 verification. Every malformed input is a verification FAILURE
 * rather than an exception: these are values arriving from a student-editable
 * file, so a bad hex string is an expected condition, not a bug.
 */
async function verifyDetached(
  payload: Uint8Array,
  sigHex: string,
  pubkeyHex: string,
): Promise<boolean> {
  if (!HEX_128_RE.test(sigHex) || !HEX_64_RE.test(pubkeyHex)) return false;
  try {
    return await ed.verifyAsync(hexToBytes(sigHex), payload, hexToBytes(pubkeyHex));
  } catch {
    return false;
  }
}

/**
 * Verify an institution cert against the ROOT public key.
 *
 * This is the call that turns a cert travelling in a student-editable bundle into
 * a TRUST ANCHOR. `verifyIdentityChain` does NOT do it — exactly as it does not
 * re-verify `course_cert`, and exactly as `verifyCourseCert` takes the root key
 * as a parameter rather than knowing one. The caller performs it and passes the
 * result in; skipping it makes the whole chain meaningless, because an attacker
 * who supplies the cert supplies `institution_pubkey` too.
 *
 * @param rootPubkeyHex The recorder's embedded `ROOT_PUBLIC_KEY_HEX`, or the
 *                      analyzer's configured root key. Never read from the bundle.
 */
export async function verifyInstitutionCert(
  cert: InstitutionCert,
  rootPubkeyHex: string,
): Promise<Result<true, InstitutionError>> {
  const valid = await verifyDetached(
    buildInstitutionCertSignedPayload(cert),
    cert.root_sig,
    rootPubkeyHex,
  );
  return valid ? ok(true as const) : err({ kind: 'invalid_signature' });
}

/**
 * Verify a student credential against the institution public key the root
 * certified.
 *
 * @param institutionPubkeyHex MUST come from an already-root-verified
 *                             `institution_cert`. Reading it from the credential's
 *                             own travelling companion makes this check circular.
 */
export async function verifyStudentCredential(
  credential: StudentCredential,
  institutionPubkeyHex: string,
): Promise<Result<true, InstitutionError>> {
  const valid = await verifyDetached(
    buildStudentCredentialSignedPayload(credential),
    credential.institution_sig,
    institutionPubkeyHex,
  );
  return valid ? ok(true as const) : err({ kind: 'invalid_signature' });
}

/**
 * Verify that the student key named by a credential countersigned this session's
 * ephemeral public key.
 */
export async function verifyStudentSessionBinding(
  binding: { institution_id: string; student_ref: string; session_pubkey: string },
  sigHex: string,
  studentPubkeyHex: string,
): Promise<Result<true, InstitutionError>> {
  const valid = await verifyDetached(
    buildStudentSessionBindingPayload(binding),
    sigHex,
    studentPubkeyHex,
  );
  return valid ? ok(true as const) : err({ kind: 'invalid_signature' });
}

// ---------------------------------------------------------------------------
// Window checks — non-fatal, never against wall-clock now
// ---------------------------------------------------------------------------

/**
 * Was `credential` in window at `at`?
 *
 * `at` is the SESSION start time, not wall-clock now: a Fall 2026 session must
 * still read as in-window in 2031. Reuses `CertWindowStatus`, so one status
 * vocabulary covers every window in the system.
 */
export function checkCredentialWindow(credential: StudentCredential, at: string): CertWindowStatus {
  return checkWindow(credential.issued_at, credential.expires_at, at);
}

/**
 * Was `cert` in window at `at`? `at` is the CREDENTIAL's `issued_at` when called
 * from the identity chain — "was this institution key authorized when it issued
 * that credential".
 */
export function checkInstitutionCertWindow(cert: InstitutionCert, at: string): CertWindowStatus {
  return checkWindow(cert.valid_from, cert.valid_until, at);
}
