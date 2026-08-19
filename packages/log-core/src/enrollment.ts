/**
 * Enrollment certificate + enrollment token — the LEGACY course-scoped identity
 * chain, at identity `format_version` 2.0 (program spec §S2). Plus
 * {@link verifyIdentityChain}, which routes between this chain and the current
 * institution-scoped one.
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §2, §5, §S2. Structurally parallel to `course-cert.ts`: read that file first,
 * this one deliberately mirrors its shape, its `Result` style, and its rules.
 *
 * ## THIS CHAIN IS SUPERSEDED, AND IS SUPPORTED FOREVER
 *
 * Identity is no longer course-scoped. A course-scoped credential required a
 * roster match, rosters are populated by the Gradescope ingest path, and that
 * path only runs AFTER a student submits — so a student could not hold an
 * identity until after their first submission, while their first session needs
 * one before they do any work. `institution.ts` describes the replacement and
 * why it exists; new material is written there, at 2.1.
 *
 * Nothing in this file may change behaviour. Every bundle already archived
 * carries a 2.0 identity block, and program spec §9 makes parsing it permanent:
 * adjudicating a case years after the fact is the entire justification for this
 * system. Treat the code below as a format contract that happens to be
 * executable.
 *
 * ## The problem this layer exists to solve
 *
 * An enrollment token binds a student's per-course public key to a roster
 * identity, and must be signed by the course. But the course's manifest-signing
 * key is deliberately OFFLINE — that is most of what `course_cert` buys. Minting
 * a token per student per semester is a server-side, on-demand operation, so
 * putting the course key on a server to do it would defeat the whole design.
 *
 * The fix is one more delegation, exactly the shape of root → course:
 *
 * ```
 *   root keypair                (offline; signs course certs only)
 *        │ signs
 *        ▼
 *   course_cert                 { course_id, course_pubkey, valid_from, valid_until }
 *        │ authorizes
 *        ▼
 *   course keypair              (OFFLINE; signs manifests AND enrollment certs)
 *        │ signs
 *        ▼
 *   enrollment_cert             { format_version, course_id, enrollment_pubkey,
 *                                 valid_from, valid_until }
 *        │ authorizes
 *        ▼
 *   enrollment keypair          ◄── LIVES ON THE SERVER. The only private key
 *        │ signs                    in the whole scheme that does.
 *        ▼
 *   enrollment token            { format_version, student_ref, course_id,
 *                                 student_pubkey, issued_at, expires_at }
 *        │ authorizes
 *        ▼
 *   student per-course key      (derived on the student's machine; see student-keys.ts)
 *        │ countersigns
 *        ▼
 *   session_pubkey              (the existing ephemeral session key)
 * ```
 *
 * A recorder or analyzer holding only the embedded ROOT public key can walk all
 * five links offline. Nothing needs to be fetched, and nothing from the server
 * is trusted.
 *
 * **What the compromise of each key costs**, which is the point of the extra
 * layer: an attacker who takes the enrollment key can mint tokens for that one
 * course, for as long as its enrollment_cert window runs. They cannot sign a
 * manifest, cannot touch another course, and cannot outlive the cert. Recovery is
 * to issue a fresh enrollment_cert for a new key — an offline operation the
 * course already knows how to do. Taking the course key would be far worse, which
 * is precisely why it does not go on a server.
 *
 * ## `student_ref` is opaque, and is a VALUE
 *
 * `student_ref` is an opaque UUID, never a raw SID, name, or email. In a shared
 * CS 61B repo one partner can read the other's `session.start`; the server maps
 * `student_ref` → `roster_entries.id`, so a partner sees only a UUID.
 *
 * It is also never an object KEY in a signed payload — see the permanent
 * constraint documented in `course-cert.ts`. provnvim's hand-rolled Lua JCS sorts
 * object keys bytewise while JS and Kotlin sort by UTF-16 code unit, so any
 * user-derived key risks silently different signed bytes across recorders. Every
 * key in every payload below is a fixed ASCII identifier chosen by us.
 *
 * For the same cross-port reason the signed payloads contain **no JSON arrays**:
 * the Lua port must tag arrays explicitly at each call site (`json.array()`),
 * which is one more thing to get wrong. Objects only.
 *
 * ## Expiry is reported, never enforced
 *
 * Exactly as for `course_cert`: an out-of-window credential is NOT an error. It
 * is returned on the success value for the caller to act on. A course letting an
 * enrollment cert lapse mid-semester must not silently stop recording for the
 * whole class — for an integrity tool that is a worse failure than recording
 * under a stale credential (program spec §4).
 *
 * And every window is evaluated against **the relevant issue time**, never
 * wall-clock now, so an archived bundle still verifies years later during an
 * adjudication:
 *
 *  - the enrollment cert's window is checked against the TOKEN's `issued_at`
 *    ("was the enrollment key authorized when it minted this token");
 *  - the token's window is checked against the SESSION's start time
 *    ("was this student enrolled when they did this work").
 *
 * ## Revocation
 *
 * Not modelled here, for the same reason as `course_cert`: an offline recorder
 * cannot learn about it without a network call, which recorder PRD NG2 forbids.
 * A server-side list must key on `enrollment_pubkey` and on `student_ref`, not on
 * a certificate or token identity — both travel outside any payload that binds
 * to them, so the holder chooses which copy ships. The offline mitigation is
 * short windows.
 */

import * as ed from '@noble/ed25519';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { canonicalize } from './canonical.js';
import { ok, err } from './result.js';
import type { Result } from './result.js';
import type { CourseCert, CertWindowStatus } from './course-cert.js';
import {
  HEX_64_RE,
  HEX_128_RE,
  requireString,
  requireHex,
  requireOrderedBounds,
  checkWindow,
} from './identity-shapes.js';
import {
  INSTITUTION_IDENTITY_FORMAT_VERSION,
  parseInstitutionCert,
  parseStudentCredential,
  verifyStudentCredential,
  verifyStudentSessionBinding,
  checkInstitutionCertWindow,
  checkCredentialWindow,
} from './institution.js';
import type { InstitutionCert, StudentCredential } from './institution.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The identity `format_version` at which identity is COURSE-scoped.
 *
 * Both the enrollment cert and the enrollment token carry it INSIDE their signed
 * payloads, and {@link verifyIdentityChain} gates on it before walking anything.
 * It is now also half of the DISCRIMINATOR that selects which walk runs — the
 * other half being `INSTITUTION_IDENTITY_FORMAT_VERSION` (`'2.1'`).
 *
 * There is no 1.x identity artifact — this layer was new when it shipped — so
 * unlike `manifest.format_version` there is nothing to default and nothing to
 * grandfather. The field exists so a future version cannot be presented as a 2.0
 * artifact: because it is signed, a downgraded 3.0 token is rejected at the gate
 * rather than being silently read under 2.0 rules. That is the S0 lesson,
 * applied before it can bite rather than after, and it is exactly what made
 * adding 2.1 alongside 2.0 a routing change rather than a migration.
 */
export const ENROLLMENT_FORMAT_VERSION = '2.0';

/** Fixed domain-separation tag for the session-pubkey countersignature. */
export const SESSION_PUBKEY_BINDING_PURPOSE = 'provenance-session-pubkey-binding-v1';

/**
 * A course-signed statement that an ENROLLMENT key may mint tokens for a course.
 *
 * The middle link of the identity chain, and the reason the course key can stay
 * offline. Travels inline next to the token (see {@link SessionIdentity}),
 * outside any payload that signs it — same distribution logic as `course_cert`
 * inside a manifest: one thing to carry, no chance of separation.
 */
export type EnrollmentCert = {
  /** Must be {@link ENROLLMENT_FORMAT_VERSION}. Inside the signed payload. */
  format_version: string;
  /** Must equal the enclosing `course_cert.course_id` and the token's `course_id`. */
  course_id: string;
  /** Hex ed25519 public key of the server-held enrollment signing key, 64 chars. */
  enrollment_pubkey: string;
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
  /** Hex ed25519 signature by the COURSE key, 128 chars (64 bytes). */
  course_sig: string;
};

/**
 * An enrollment-signed statement that a student public key belongs to a roster
 * entry in a course.
 *
 * Signed by the ENROLLMENT key (which `enrollment_cert` authorizes), NOT by the
 * course key directly — the course key is offline and cannot mint per-student
 * tokens on demand.
 */
export type EnrollmentToken = {
  /** Must be {@link ENROLLMENT_FORMAT_VERSION}. Inside the signed payload. */
  format_version: string;
  /** Opaque roster reference. Never a student ID number, name, or email. */
  student_ref: string;
  course_id: string;
  /** Hex ed25519 public key of the student's per-course key, 64 chars. */
  student_pubkey: string;
  /** ISO 8601. Also the instant the enrollment cert's window is judged against. */
  issued_at: string;
  /** ISO 8601. Date-only resolves through the end of that day. */
  expires_at: string;
  /** Hex ed25519 signature by the ENROLLMENT key, 128 chars (64 bytes). */
  enrollment_sig: string;
};

/**
 * The identity block carried in `session.start` (program spec §5).
 *
 * TWO SHAPES SHARE THESE TWO WIRE SLOTS, distinguished by the signed
 * `format_version` inside `enrollment_cert`:
 *
 *  - **`'2.0'` — legacy, COURSE-scoped.** `enrollment_cert` is an
 *    {@link EnrollmentCert} (course-signed) and `enrollment` is an
 *    {@link EnrollmentToken}. Every archived bundle in the field carries this,
 *    and it is supported FOREVER: adjudicating a case years later is the entire
 *    justification for this system (program spec §9).
 *  - **`'2.1'` — current, INSTITUTION-scoped.** `enrollment_cert` is an
 *    {@link InstitutionCert} (ROOT-signed) and `enrollment` is a
 *    {@link StudentCredential}. See `institution.ts` for why identity stopped
 *    being course-scoped.
 *
 * **The wire slot names are historical and deliberately unchanged.** `enrollment`
 * means "the credential"; `enrollment_cert` means "the authorization for whoever
 * signed it". Renaming them for 2.1 would have forced the version discriminator
 * to be found by looking at WHICH FIELDS EXIST — and this project has already
 * been burned at exactly that spot: `bundle-manifest.ts` read the mere PRESENCE
 * of an embedded manifest as a 2.0 claim, which made the whole legacy path
 * unreachable. One stable slot carrying a signed version is the shape that
 * cannot repeat that bug.
 *
 * In both versions the cert travels here, BESIDE the credential rather than
 * inside it, for the same reason `course_cert` travels inside the manifest
 * rather than inside the course-signed payload: an issuer does not sign its own
 * authorization, and one bundled blob cannot be separated from the thing it
 * authorizes by a copy or a `.gitignore`.
 */
export type SessionIdentity = {
  /** The credential: a 2.0 {@link EnrollmentToken} or a 2.1 {@link StudentCredential}. */
  enrollment: EnrollmentToken | StudentCredential;
  /**
   * The authorization for whichever key signed `enrollment`, and the artifact
   * whose SIGNED `format_version` selects the walk: a 2.0 {@link EnrollmentCert}
   * (course-signed) or a 2.1 {@link InstitutionCert} (root-signed).
   */
  enrollment_cert: EnrollmentCert | InstitutionCert;
  /**
   * The student key's signature over the session's ephemeral `session_pubkey`.
   * This is the link that binds an ephemeral session key to a named contributor.
   * See {@link buildSessionPubkeyBindingPayload} (2.0) and
   * `buildStudentSessionBindingPayload` (2.1) — the two payloads carry different
   * `purpose` tags, so a countersignature can never be replayed across versions.
   */
  session_pubkey_sig: string;
};

export type EnrollmentError =
  | { kind: 'invalid_shape'; field?: string; reason?: string }
  | { kind: 'invalid_signature' };

/**
 * Failure modes of {@link verifyIdentityChain}, in the order the steps run.
 * Out-of-window results are deliberately NOT here — they are non-fatal and are
 * reported on the success value instead.
 */
export type IdentityChainError =
  /**
   * Step 0: the identity block declares a version whose rules this code does not
   * implement. Gated before any signature work, so a future 3.0 cannot be walked
   * under today's assumptions about which fields are signed.
   */
  | { kind: 'unsupported_identity_version'; format_version: string }
  /**
   * Step 0: the cert and the credential declare DIFFERENT versions. Refused
   * rather than resolved: allowing a mix would let a legacy course-signed cert be
   * paired with an institution credential, and each artifact would then be read
   * under rules the other never agreed to.
   */
  | { kind: 'identity_version_mismatch'; cert_version: string; credential_version: string }
  /**
   * Step 0: the caller did not supply the trust anchor this version's walk needs
   * — a `course_cert` for 2.0, an `institution_cert` for 2.1. A programmer error
   * at the call site, reported as a value because which anchor is needed is only
   * known after reading the bundle.
   */
  | { kind: 'missing_trust_anchor'; required: 'course_cert' | 'institution_cert' }
  /**
   * Step 0b: the cert does not satisfy its version's shape. Reported before
   * signature work because `canonicalize` OMITS keys whose value is `undefined`
   * — an artifact missing a required field would otherwise sign and verify
   * cleanly while carrying nothing at that field.
   */
  | { kind: 'invalid_cert_shape'; field?: string; reason?: string }
  /** Step 0b, same reasoning, for the credential. */
  | { kind: 'invalid_token_shape'; field?: string; reason?: string }
  /** 2.0 step 1: `enrollment_cert` does not verify against `course_cert.course_pubkey`. */
  | { kind: 'invalid_course_signature' }
  /** 2.0 step 2: the token does not verify against `enrollment_cert.enrollment_pubkey`. */
  | { kind: 'invalid_enrollment_signature' }
  /** 2.0 step 3: the three links do not all name the same course. */
  | {
      kind: 'course_id_mismatch';
      token_course_id: string;
      cert_course_id: string;
      course_cert_course_id: string;
    }
  /** 2.1 step 1: the credential does not verify against the anchor's `institution_pubkey`. */
  | { kind: 'invalid_institution_signature' }
  /**
   * 2.1 step 2, the MANDATORY anchor check — the institution-scoped replacement
   * for `course_id_mismatch`. The credential, the cert travelling with it, and
   * the root-verified anchor must all name the same institution, and the
   * travelling cert must name the anchor's key. Without it, an attacker holding a
   * genuinely root-certified institution key for one institution can mint a
   * credential naming ANOTHER, and every signature verifies.
   */
  | {
      kind: 'institution_mismatch';
      credential_institution_id: string;
      cert_institution_id: string;
      anchor_institution_id: string;
      /** True when the travelling cert names a different key than the anchor. */
      pubkey_mismatch: boolean;
    }
  /** Both versions: the supplied session public key is not a 64-char hex string. */
  | { kind: 'invalid_session_pubkey' }
  /** Both versions: `session_pubkey_sig` does not verify against the student pubkey. */
  | { kind: 'invalid_session_pubkey_signature' };

/**
 * Success value of {@link verifyIdentityChain}, discriminated by the identity
 * version that was walked.
 *
 * `student_ref`, `student_pubkey`, `cert_window` and `token_window` are present
 * in BOTH branches under the same names, so a caller that only needs "who is
 * this, and were their credentials in date" reads them without narrowing. The
 * window field names in particular are kept identical across versions on
 * purpose: the three ports iterate the conformance vectors generically, and a
 * renamed field there is a port-level break for no benefit.
 */
export type IdentityChainOk =
  | {
      /** Legacy COURSE-scoped identity. */
      identity_version: '2.0';
      scope: 'course';
      /** The course all three links agree on. */
      course_id: string;
      /** The roster reference this session is attributed to. Opaque, per-course. */
      student_ref: string;
      /** The student per-course public key that countersigned `session_pubkey`. */
      student_pubkey: string;
      /** The enrollment public key the course vouched for. */
      enrollment_pubkey: string;
      cert: EnrollmentCert;
      token: EnrollmentToken;
      /**
       * Non-fatal. Was the enrollment cert in window when it minted this token?
       * Judged against `token.issued_at`, never wall-clock now.
       */
      cert_window: CertWindowStatus;
      /**
       * Non-fatal. Was the token in window when this session ran? Judged against
       * the supplied session start time, never wall-clock now.
       */
      token_window: CertWindowStatus;
    }
  | {
      /** Current INSTITUTION-scoped identity. */
      identity_version: '2.1';
      scope: 'institution';
      /** The institution the credential, its cert, and the anchor all agree on. */
      institution_id: string;
      /** The GLOBAL roster reference this session is attributed to. Opaque. */
      student_ref: string;
      /** The student's single long-lived public key, which countersigned `session_pubkey`. */
      student_pubkey: string;
      /** The institution public key the ROOT vouched for. */
      institution_pubkey: string;
      cert: InstitutionCert;
      credential: StudentCredential;
      /**
       * Non-fatal. Was the institution cert in window when it issued this
       * credential? Judged against `credential.issued_at`, never wall-clock now.
       */
      cert_window: CertWindowStatus;
      /**
       * Non-fatal. Was the credential in window when this session ran? Judged
       * against the supplied session start time, never wall-clock now.
       */
      token_window: CertWindowStatus;
    };

// ---------------------------------------------------------------------------
// Helpers
//
// Shape and window primitives are shared with the institution-scoped chain via
// `identity-shapes.ts`. Two copies of "is this an ISO 8601 bound" is exactly how
// two ports of the same rule drift apart, and this repo is the reference the
// three recorders are held against.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Signed payloads — the exact bytes three ports must reproduce
// ---------------------------------------------------------------------------

/**
 * Build the canonical bytes the COURSE key signs for an enrollment cert.
 *
 * `course_sig` is excluded; the five remaining fields are canonicalized. JCS
 * orders keys, so the literal order below is irrelevant to the output — the
 * resulting key order is always:
 *
 *   course_id, enrollment_pubkey, format_version, valid_from, valid_until
 */
export function buildEnrollmentCertSignedPayload(
  cert: Omit<EnrollmentCert, 'course_sig'>,
): Uint8Array {
  const payload = canonicalize({
    course_id: cert.course_id,
    enrollment_pubkey: cert.enrollment_pubkey,
    format_version: cert.format_version,
    valid_from: cert.valid_from,
    valid_until: cert.valid_until,
  });
  return new TextEncoder().encode(payload);
}

/**
 * Build the canonical bytes the ENROLLMENT key signs for a token.
 *
 * `enrollment_sig` is excluded; the six remaining fields are canonicalized. The
 * resulting JCS key order is always:
 *
 *   course_id, expires_at, format_version, issued_at, student_pubkey, student_ref
 *
 * Note `student_ref` appears as a VALUE at a fixed ASCII key — never promoted to
 * a key itself.
 */
export function buildEnrollmentTokenSignedPayload(
  token: Omit<EnrollmentToken, 'enrollment_sig'>,
): Uint8Array {
  const payload = canonicalize({
    course_id: token.course_id,
    expires_at: token.expires_at,
    format_version: token.format_version,
    issued_at: token.issued_at,
    student_pubkey: token.student_pubkey,
    student_ref: token.student_ref,
  });
  return new TextEncoder().encode(payload);
}

/**
 * Build the canonical bytes the STUDENT per-course key signs to bind an
 * ephemeral `session_pubkey` to itself.
 *
 * A bare 64-char hex string would have been the minimal thing to sign. It is not
 * what is signed, for two reasons:
 *
 *  - **Domain separation.** A signature over an unstructured blob is a signature
 *    over anything that blob might also mean. The fixed `purpose` tag makes this
 *    message unmistakably this message, and leaves room to add a second thing the
 *    student key signs later without the two being confusable.
 *  - **Self-describing binding.** Including `course_id` and `student_ref` means
 *    the countersignature itself asserts which student, in which course, adopted
 *    this session key. Verification therefore cross-checks those values against
 *    the token rather than taking them on trust from elsewhere in the payload.
 *
 * JCS key order is always: course_id, purpose, session_pubkey, student_ref.
 */
export function buildSessionPubkeyBindingPayload(binding: {
  course_id: string;
  student_ref: string;
  session_pubkey: string;
}): Uint8Array {
  const payload = canonicalize({
    course_id: binding.course_id,
    purpose: SESSION_PUBKEY_BINDING_PURPOSE,
    session_pubkey: binding.session_pubkey,
    student_ref: binding.student_ref,
  });
  return new TextEncoder().encode(payload);
}

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

/**
 * Validate the shape of an already-JSON-parsed enrollment cert.
 *
 * Takes `unknown` rather than text because the cert travels inline inside a
 * `session.start` payload. Unknown keys are ignored for forward compatibility,
 * which is safe: canonicalization operates on the five named fields only, so an
 * unknown key cannot silently change the signed bytes.
 *
 * This does NOT check `format_version` — {@link verifyIdentityChain} gates on
 * that first, and reports it as a distinct error so a version problem is never
 * mistaken for a malformed artifact.
 */
export function parseEnrollmentCert(value: unknown): Result<EnrollmentCert, EnrollmentError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({ kind: 'invalid_shape', reason: 'must be an object' });
  }
  const obj = value as Record<string, unknown>;

  const formatVersion = requireString(obj, 'format_version');
  if (!formatVersion.ok) return formatVersion;

  const courseId = requireString(obj, 'course_id');
  if (!courseId.ok) return courseId;

  const bounds = requireOrderedBounds(obj, 'valid_from', 'valid_until');
  if (!bounds.ok) return bounds;

  const enrollmentPubkey = requireHex(obj, 'enrollment_pubkey', HEX_64_RE, 64);
  if (!enrollmentPubkey.ok) return enrollmentPubkey;

  const courseSig = requireHex(obj, 'course_sig', HEX_128_RE, 128);
  if (!courseSig.ok) return courseSig;

  return ok({
    format_version: formatVersion.value,
    course_id: courseId.value,
    enrollment_pubkey: enrollmentPubkey.value,
    valid_from: bounds.value.lower,
    valid_until: bounds.value.upper,
    course_sig: courseSig.value,
  });
}

/**
 * Validate the shape of an already-JSON-parsed enrollment token. Unknown keys
 * are ignored, for the same reason as {@link parseEnrollmentCert}.
 */
export function parseEnrollmentToken(value: unknown): Result<EnrollmentToken, EnrollmentError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({ kind: 'invalid_shape', reason: 'must be an object' });
  }
  const obj = value as Record<string, unknown>;

  const formatVersion = requireString(obj, 'format_version');
  if (!formatVersion.ok) return formatVersion;

  const studentRef = requireString(obj, 'student_ref');
  if (!studentRef.ok) return studentRef;

  const courseId = requireString(obj, 'course_id');
  if (!courseId.ok) return courseId;

  const bounds = requireOrderedBounds(obj, 'issued_at', 'expires_at');
  if (!bounds.ok) return bounds;

  const studentPubkey = requireHex(obj, 'student_pubkey', HEX_64_RE, 64);
  if (!studentPubkey.ok) return studentPubkey;

  const enrollmentSig = requireHex(obj, 'enrollment_sig', HEX_128_RE, 128);
  if (!enrollmentSig.ok) return enrollmentSig;

  return ok({
    format_version: formatVersion.value,
    student_ref: studentRef.value,
    course_id: courseId.value,
    student_pubkey: studentPubkey.value,
    issued_at: bounds.value.lower,
    expires_at: bounds.value.upper,
    enrollment_sig: enrollmentSig.value,
  });
}

// ---------------------------------------------------------------------------
// Signing — course/server tooling and the conformance-vector generator only.
// A recorder never calls the first two; it only ever verifies.
// ---------------------------------------------------------------------------

/** Sign an enrollment cert with the COURSE private key (offline operation). */
export async function signEnrollmentCert(
  cert: Omit<EnrollmentCert, 'course_sig'>,
  coursePrivkey: Uint8Array,
): Promise<string> {
  return bytesToHex(await ed.signAsync(buildEnrollmentCertSignedPayload(cert), coursePrivkey));
}

/** Sign an enrollment token with the ENROLLMENT private key (server-side). */
export async function signEnrollmentToken(
  token: Omit<EnrollmentToken, 'enrollment_sig'>,
  enrollmentPrivkey: Uint8Array,
): Promise<string> {
  return bytesToHex(
    await ed.signAsync(buildEnrollmentTokenSignedPayload(token), enrollmentPrivkey),
  );
}

/**
 * Countersign a session public key with the student's per-course private key.
 * Called by the recorder at session start — the one signing operation on this
 * path that happens on the student's machine.
 */
export async function signSessionPubkey(
  binding: { course_id: string; student_ref: string; session_pubkey: string },
  studentPrivkey: Uint8Array,
): Promise<string> {
  return bytesToHex(await ed.signAsync(buildSessionPubkeyBindingPayload(binding), studentPrivkey));
}

// ---------------------------------------------------------------------------
// Single-link verification
// ---------------------------------------------------------------------------

/**
 * Shared ed25519 verification. Every malformed input is a verification FAILURE
 * rather than an exception: these are values arriving from a student-editable
 * file, so a bad hex string is an expected condition.
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
 * Identity chain step 1: verify an enrollment cert against the course public key
 * that a root-verified `course_cert` vouched for.
 *
 * @param coursePubkeyHex MUST come from an already-root-verified `course_cert`.
 *                        Reading it from anywhere else makes this check circular.
 */
export async function verifyEnrollmentCert(
  cert: EnrollmentCert,
  coursePubkeyHex: string,
): Promise<Result<true, EnrollmentError>> {
  const valid = await verifyDetached(
    buildEnrollmentCertSignedPayload(cert),
    cert.course_sig,
    coursePubkeyHex,
  );
  return valid ? ok(true as const) : err({ kind: 'invalid_signature' });
}

/**
 * Identity chain step 2: verify an enrollment token against the enrollment
 * public key the course certified.
 */
export async function verifyEnrollmentToken(
  token: EnrollmentToken,
  enrollmentPubkeyHex: string,
): Promise<Result<true, EnrollmentError>> {
  const valid = await verifyDetached(
    buildEnrollmentTokenSignedPayload(token),
    token.enrollment_sig,
    enrollmentPubkeyHex,
  );
  return valid ? ok(true as const) : err({ kind: 'invalid_signature' });
}

/**
 * Identity chain step 4: verify that the student per-course key named by a token
 * countersigned this session's ephemeral public key.
 */
export async function verifySessionPubkeySig(
  binding: { course_id: string; student_ref: string; session_pubkey: string },
  sigHex: string,
  studentPubkeyHex: string,
): Promise<Result<true, EnrollmentError>> {
  const valid = await verifyDetached(
    buildSessionPubkeyBindingPayload(binding),
    sigHex,
    studentPubkeyHex,
  );
  return valid ? ok(true as const) : err({ kind: 'invalid_signature' });
}

// ---------------------------------------------------------------------------
// Window checks — non-fatal, never against wall-clock now
// ---------------------------------------------------------------------------

/**
 * Was `token` in window at `at`?
 *
 * `at` is the SESSION start time, not wall-clock now: a Fall 2026 session must
 * still read as in-window in 2030. Reuses `CertWindowStatus`, so `before_valid_from`
 * here means "before the token was issued" and `after_valid_until` means "after it
 * expired" — one status vocabulary for every window in the system.
 */
export function checkTokenWindow(token: EnrollmentToken, at: string): CertWindowStatus {
  return checkWindow(token.issued_at, token.expires_at, at);
}

/**
 * Was `cert` in window at `at`? `at` is the TOKEN's `issued_at` when called from
 * {@link verifyIdentityChain} — "was this enrollment key authorized when it
 * minted that token".
 */
export function checkEnrollmentCertWindow(cert: EnrollmentCert, at: string): CertWindowStatus {
  return checkWindow(cert.valid_from, cert.valid_until, at);
}

// ---------------------------------------------------------------------------
// The full identity chain
// ---------------------------------------------------------------------------

/** Narrow a shape error into the chain's cert/credential shape-error members. */
function shapeErr<K extends 'invalid_cert_shape' | 'invalid_token_shape'>(
  kind: K,
  inner: { kind: 'invalid_shape'; field?: string; reason?: string } | { kind: 'invalid_signature' },
): IdentityChainError {
  return {
    kind,
    ...(inner.kind === 'invalid_shape' && inner.field !== undefined ? { field: inner.field } : {}),
    ...(inner.kind === 'invalid_shape' && inner.reason !== undefined
      ? { reason: inner.reason }
      : {}),
  } as IdentityChainError;
}

/**
 * Walk the identity chain for whichever identity version the bundle declares.
 *
 * ## Routing — on a SIGNED discriminator, never on field presence
 *
 * Step 0 reads `identity.enrollment_cert.format_version`. That field is inside
 * the cert's signed payload in BOTH versions, at the same wire slot, so it
 * cannot be flipped without invalidating a signature and it can be found without
 * first guessing which shape is present.
 *
 * Routing on which fields EXIST would have been the obvious alternative and is
 * forbidden here: `bundle-manifest.ts` once treated the mere presence of an
 * embedded manifest as a 2.0 claim, and that made the entire legacy path
 * unreachable. Presence is attacker-controlled and ambiguous; a signed version
 * is neither. The credential's own `format_version` must then MATCH the cert's,
 * so a legacy course-signed cert can never be paired with an institution
 * credential.
 *
 * ## `'2.0'` — legacy, COURSE-scoped. Supported forever.
 *
 * Every bundle already archived carries this shape, and program spec §9 makes
 * 1.x/2.0 parsing permanent: adjudicating a case years after the fact is the
 * entire justification for this system. The walk below is unchanged from the day
 * it shipped, down to the error values.
 *
 *  0.  `format_version === '2.0'` on both artifacts.
 *  0b. Both satisfy the 2.0 shape — before any signature work, because
 *      `canonicalize` omits `undefined`-valued keys, so an artifact missing a
 *      required field would sign and verify cleanly while carrying nothing there.
 *  1.  `enrollment_cert` minus `course_sig` verifies against `course_cert.course_pubkey`.
 *  2.  The token minus `enrollment_sig` verifies against `enrollment_cert.enrollment_pubkey`.
 *  3.  `token.course_id === enrollment_cert.course_id === course_cert.course_id`.
 *      Not a formality: without it 61B's course key can certify an enrollment key
 *      "for 61C", that key mints a 61C token, and steps 1 and 2 both pass because
 *      every signature is genuine.
 *  4.  `session_pubkey_sig` verifies against `token.student_pubkey` over the v1
 *      binding payload for this exact session pubkey.
 *  5.  Both validity windows — NON-FATAL, returned on the success value.
 *
 * ## `'2.1'` — current, INSTITUTION-scoped.
 *
 *  0.  `format_version === '2.1'` on both artifacts.
 *  0b. Both satisfy the 2.1 shape. Same reasoning as above.
 *  1.  The credential minus `institution_sig` verifies against the ANCHOR's
 *      `institution_pubkey` — never the travelling cert's copy, so a swapped
 *      cert can never introduce a key of the attacker's choosing even if step 2
 *      were somehow bypassed.
 *  2.  **The institution anchor check — the replacement for step 3 above, and
 *      mandatory for the same reason.** `credential.institution_id`, the
 *      travelling cert's `institution_id`, and the anchor's must all agree, and
 *      the travelling cert must name the anchor's `institution_pubkey`. Root
 *      legitimately certifies many institutions; without this, a holder of a
 *      genuinely root-certified key for one institution can mint a credential
 *      naming ANOTHER and ship it with their own genuine cert, and every
 *      signature verifies. One signer's credential must never be replayable
 *      under another signer's authority.
 *  3.  `session_pubkey_sig` verifies against `credential.student_pubkey` over the
 *      v2 binding payload (a distinct `purpose` tag, so 2.0 and 2.1
 *      countersignatures can never be swapped).
 *  4.  Both validity windows — NON-FATAL, returned on the success value.
 *
 * ## The trust anchor MUST already be verified
 *
 * This function takes its anchor as a parameter and does NOT re-verify it against
 * the root key — exactly as `verifyCourseCert` and `verifyInstitutionCert` take
 * the root public key as a parameter rather than knowing one. The caller obtains
 * a `course_cert` from a successful `verifyManifestChain`, or root-verifies the
 * `institution_cert` with `verifyInstitutionCert` before passing it. Passing an
 * unverified anchor makes every result meaningless, because an attacker who
 * supplies the anchor supplies its public key too and can then satisfy the whole
 * chain with keys of their own.
 *
 * @param input.identity           The `session.start` identity block.
 * @param input.session_pubkey     The session's ephemeral public key, 64-char hex.
 * @param input.course_cert        An ALREADY ROOT-VERIFIED course certificate.
 *                                 Required for a 2.0 chain, ignored by 2.1.
 * @param input.institution_cert   An ALREADY ROOT-VERIFIED institution certificate.
 *                                 Required for a 2.1 chain, ignored by 2.0.
 * @param input.session_started_at ISO 8601 session start; the credential's window
 *                                 is judged against this, never wall-clock now.
 */
export async function verifyIdentityChain(input: {
  identity: SessionIdentity;
  session_pubkey: string;
  course_cert?: CourseCert;
  institution_cert?: InstitutionCert;
  session_started_at: string;
}): Promise<Result<IdentityChainOk, IdentityChainError>> {
  const { identity, session_pubkey, course_cert, institution_cert, session_started_at } = input;

  // Step 0 — the version gate, before anything is trusted, parsed, or verified.
  // Reading the declared version off an unvalidated object is safe precisely
  // because nothing else has happened yet.
  //
  // The discriminator lives in the CERT slot: it is signed in both versions and
  // sits at the same wire key in both, so it can be read without first knowing
  // which shape is present. Never route on which fields exist.
  const declaredCertVersion = (identity.enrollment_cert as { format_version?: unknown } | undefined)
    ?.format_version;
  const certVersion = typeof declaredCertVersion === 'string' ? declaredCertVersion : '';

  if (
    certVersion !== ENROLLMENT_FORMAT_VERSION &&
    certVersion !== INSTITUTION_IDENTITY_FORMAT_VERSION
  ) {
    return err({ kind: 'unsupported_identity_version', format_version: certVersion });
  }

  const declaredCredentialVersion = (
    identity.enrollment as { format_version?: unknown } | undefined
  )?.format_version;
  const credentialVersion =
    typeof declaredCredentialVersion === 'string' ? declaredCredentialVersion : '';

  // No mixing. A legacy course-signed cert paired with an institution credential
  // would leave each artifact read under rules the other never agreed to.
  if (credentialVersion !== certVersion) {
    return err({
      kind: 'identity_version_mismatch',
      cert_version: certVersion,
      credential_version: credentialVersion,
    });
  }

  return certVersion === INSTITUTION_IDENTITY_FORMAT_VERSION
    ? walkInstitutionChain(identity, session_pubkey, institution_cert, session_started_at)
    : walkCourseChain(identity, session_pubkey, course_cert, session_started_at);
}

/**
 * The LEGACY 2.0 course-scoped walk. Unchanged behaviour, kept forever so an
 * archived bundle still verifies during an adjudication years from now.
 */
async function walkCourseChain(
  identity: SessionIdentity,
  session_pubkey: string,
  course_cert: CourseCert | undefined,
  session_started_at: string,
): Promise<Result<IdentityChainOk, IdentityChainError>> {
  if (course_cert === undefined) {
    return err({ kind: 'missing_trust_anchor', required: 'course_cert' });
  }

  // Step 0b — shape before signatures, for both artifacts.
  const parsedCert = parseEnrollmentCert(identity.enrollment_cert);
  if (!parsedCert.ok) return err(shapeErr('invalid_cert_shape', parsedCert.error));
  const parsedToken = parseEnrollmentToken(identity.enrollment);
  if (!parsedToken.ok) return err(shapeErr('invalid_token_shape', parsedToken.error));

  // Verify against the VALIDATED copies, so the bytes checked here are the bytes
  // every later reader sees.
  const cert = parsedCert.value;
  const token = parsedToken.value;

  // Step 1 — enrollment cert vs the course key the root vouched for.
  const certOk = await verifyEnrollmentCert(cert, course_cert.course_pubkey);
  if (!certOk.ok) return err({ kind: 'invalid_course_signature' });

  // Step 2 — token vs the enrollment key the course certified.
  const tokenOk = await verifyEnrollmentToken(token, cert.enrollment_pubkey);
  if (!tokenOk.ok) return err({ kind: 'invalid_enrollment_signature' });

  // Step 3 — every link must name the same course.
  if (token.course_id !== cert.course_id || cert.course_id !== course_cert.course_id) {
    return err({
      kind: 'course_id_mismatch',
      token_course_id: token.course_id,
      cert_course_id: cert.course_id,
      course_cert_course_id: course_cert.course_id,
    });
  }

  // Step 4 — the student key adopted THIS session key.
  if (!HEX_64_RE.test(session_pubkey)) {
    return err({ kind: 'invalid_session_pubkey' });
  }
  const bindingOk = await verifySessionPubkeySig(
    {
      course_id: token.course_id,
      student_ref: token.student_ref,
      session_pubkey,
    },
    identity.session_pubkey_sig,
    token.student_pubkey,
  );
  if (!bindingOk.ok) return err({ kind: 'invalid_session_pubkey_signature' });

  // Step 5 — non-fatal windows, each against its own relevant issue time.
  return ok({
    identity_version: '2.0',
    scope: 'course',
    course_id: token.course_id,
    student_ref: token.student_ref,
    student_pubkey: token.student_pubkey,
    enrollment_pubkey: cert.enrollment_pubkey,
    cert,
    token,
    cert_window: checkEnrollmentCertWindow(cert, token.issued_at),
    token_window: checkTokenWindow(token, session_started_at),
  });
}

/** The CURRENT 2.1 institution-scoped walk. See `institution.ts`. */
async function walkInstitutionChain(
  identity: SessionIdentity,
  session_pubkey: string,
  anchor: InstitutionCert | undefined,
  session_started_at: string,
): Promise<Result<IdentityChainOk, IdentityChainError>> {
  if (anchor === undefined) {
    return err({ kind: 'missing_trust_anchor', required: 'institution_cert' });
  }

  // Step 0b — shape before signatures, for both artifacts.
  const parsedCert = parseInstitutionCert(identity.enrollment_cert);
  if (!parsedCert.ok) return err(shapeErr('invalid_cert_shape', parsedCert.error));
  const parsedCredential = parseStudentCredential(identity.enrollment);
  if (!parsedCredential.ok) return err(shapeErr('invalid_token_shape', parsedCredential.error));

  const cert = parsedCert.value;
  const credential = parsedCredential.value;

  // Step 1 — the credential verifies against the key the ROOT vouched for.
  //
  // Deliberately the ANCHOR's `institution_pubkey`, never the travelling cert's.
  // Step 2 forces the two to be equal anyway, but reading the key from the
  // already-root-verified value means a swapped travelling cert can never
  // introduce a key of the attacker's choosing, whatever happens downstream.
  const credentialOk = await verifyStudentCredential(credential, anchor.institution_pubkey);
  if (!credentialOk.ok) return err({ kind: 'invalid_institution_signature' });

  // Step 2 — THE INSTITUTION ANCHOR CHECK. The replacement for 2.0's
  // course_id triple-comparison, and mandatory for exactly the same reason:
  // root certifies many institutions, so a genuine signature by a genuinely
  // certified key proves only WHO signed, never WHOM they were entitled to
  // speak for. Comparing the id at every link is what makes replaying one
  // signer's credential under another's authority impossible rather than
  // merely unlikely.
  const pubkeyMismatch = cert.institution_pubkey !== anchor.institution_pubkey;
  if (
    credential.institution_id !== cert.institution_id ||
    cert.institution_id !== anchor.institution_id ||
    pubkeyMismatch
  ) {
    return err({
      kind: 'institution_mismatch',
      credential_institution_id: credential.institution_id,
      cert_institution_id: cert.institution_id,
      anchor_institution_id: anchor.institution_id,
      pubkey_mismatch: pubkeyMismatch,
    });
  }

  // Step 3 — the student key adopted THIS session key.
  if (!HEX_64_RE.test(session_pubkey)) {
    return err({ kind: 'invalid_session_pubkey' });
  }
  const bindingOk = await verifyStudentSessionBinding(
    {
      institution_id: credential.institution_id,
      student_ref: credential.student_ref,
      session_pubkey,
    },
    identity.session_pubkey_sig,
    credential.student_pubkey,
  );
  if (!bindingOk.ok) return err({ kind: 'invalid_session_pubkey_signature' });

  // Step 4 — non-fatal windows, each against its own relevant issue time.
  return ok({
    identity_version: '2.1',
    scope: 'institution',
    institution_id: credential.institution_id,
    student_ref: credential.student_ref,
    student_pubkey: credential.student_pubkey,
    institution_pubkey: anchor.institution_pubkey,
    cert,
    credential,
    cert_window: checkInstitutionCertWindow(cert, credential.issued_at),
    token_window: checkCredentialWindow(credential, session_started_at),
  });
}
