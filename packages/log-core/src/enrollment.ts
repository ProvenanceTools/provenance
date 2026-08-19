/**
 * Enrollment certificate + enrollment token — the identity half of the trust
 * chain (program spec §S2).
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §2, §5, §S2. Structurally parallel to `course-cert.ts`: read that file first,
 * this one deliberately mirrors its shape, its `Result` style, and its rules.
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
import { parseIsoInstantMs, resolveValidUntilExclusiveMs } from './course-cert.js';
import type { CourseCert, CertWindowStatus } from './course-cert.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The version at which the identity chain exists. Both the enrollment cert and
 * the enrollment token carry it INSIDE their signed payloads, and
 * {@link verifyIdentityChain} gates on it before walking anything.
 *
 * There is no 1.x identity artifact — this layer is new — so unlike
 * `manifest.format_version` there is nothing to default and nothing to
 * grandfather. The field exists purely so a future 3.0 cannot be presented as a
 * 2.0 artifact: because it is signed, a downgraded 3.0 token fails signature
 * verification rather than being silently read under 2.0 rules. That is the S0
 * lesson, applied before it can bite rather than after.
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
 * The identity block carried in `session.start` 2.0 (program spec §5).
 *
 * `enrollment_cert` travels here, beside the token rather than inside it, for
 * the same reason `course_cert` travels inside the manifest rather than inside
 * the course-signed payload: the issuer does not sign its own authorization, and
 * one bundled blob cannot be separated from the thing it authorizes.
 */
export type SessionIdentity = {
  enrollment: EnrollmentToken;
  /** The course-signed authorization for whichever key signed `enrollment`. */
  enrollment_cert: EnrollmentCert;
  /**
   * The student per-course key's signature over the session's ephemeral
   * `session_pubkey`. This is the link that binds an ephemeral session key to a
   * named contributor. See {@link buildSessionPubkeyBindingPayload}.
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
   * Step 0: an artifact declares a version whose rules this code does not
   * implement. Gated before any signature work, so a future format cannot be
   * walked under today's assumptions about which fields are signed.
   */
  | { kind: 'not_enrollment_2_0'; artifact: 'cert' | 'token'; format_version: string }
  /**
   * Step 0b: the enrollment cert does not satisfy the 2.0 shape. Reported before
   * signature work because `canonicalize` OMITS keys whose value is `undefined`
   * — an artifact missing a required field would otherwise sign and verify
   * cleanly while carrying nothing at that field.
   */
  | { kind: 'invalid_cert_shape'; field?: string; reason?: string }
  /** Step 0b, same reasoning, for the token. */
  | { kind: 'invalid_token_shape'; field?: string; reason?: string }
  /** Step 1: `enrollment_cert` does not verify against `course_cert.course_pubkey`. */
  | { kind: 'invalid_course_signature' }
  /** Step 2: the token does not verify against `enrollment_cert.enrollment_pubkey`. */
  | { kind: 'invalid_enrollment_signature' }
  /** Step 3: the three links do not all name the same course. */
  | {
      kind: 'course_id_mismatch';
      token_course_id: string;
      cert_course_id: string;
      course_cert_course_id: string;
    }
  /** Step 4: the supplied session public key is not a 64-char hex string. */
  | { kind: 'invalid_session_pubkey' }
  /** Step 4: `session_pubkey_sig` does not verify against `token.student_pubkey`. */
  | { kind: 'invalid_session_pubkey_signature' };

export type IdentityChainOk = {
  /** The course all three links agree on. */
  course_id: string;
  /** The roster reference this session is attributed to. Opaque. */
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
   * Non-fatal. Was the token in window when this session ran? Judged against the
   * supplied session start time, never wall-clock now.
   */
  token_window: CertWindowStatus;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEX_128_RE = /^[0-9a-f]{128}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;

/**
 * Validate a required non-empty string field.
 * Note that a missing key and an `undefined`-valued key are treated identically
 * — `canonicalize` erases the difference, so nothing downstream can rely on it.
 */
function requireString(
  obj: Record<string, unknown>,
  field: string,
): Result<string, EnrollmentError> {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    return err({ kind: 'invalid_shape', field, reason: 'must be a non-empty string' });
  }
  return ok(value);
}

function requireHex(
  obj: Record<string, unknown>,
  field: string,
  re: RegExp,
  chars: number,
): Result<string, EnrollmentError> {
  const value = obj[field];
  if (typeof value !== 'string' || !re.test(value)) {
    return err({ kind: 'invalid_shape', field, reason: `must be a ${chars}-char hex string` });
  }
  return ok(value);
}

/**
 * Validate an ordered pair of ISO 8601 bounds.
 *
 * Both bounds MUST parse. Short validity windows are the only offline mitigation
 * this scheme has for the absence of revocation, so a bound that silently never
 * binds would undercut the sole control there is. These artifacts are new, so
 * unlike `manifest.issued_at` there is no archived-data compatibility cost to
 * enforcing it.
 */
function requireOrderedBounds(
  obj: Record<string, unknown>,
  lowerField: string,
  upperField: string,
): Result<{ lower: string; upper: string }, EnrollmentError> {
  const parsed: Record<string, number> = {};
  for (const field of [lowerField, upperField]) {
    const asString = requireString(obj, field);
    if (!asString.ok) return asString;
    const ms = parseIsoInstantMs(asString.value);
    if (ms === null) {
      return err({ kind: 'invalid_shape', field, reason: 'must be an ISO 8601 date or timestamp' });
    }
    parsed[field] = ms;
  }
  if ((parsed[lowerField] as number) > (parsed[upperField] as number)) {
    return err({
      kind: 'invalid_shape',
      field: upperField,
      reason: `must not be earlier than ${lowerField}`,
    });
  }
  return ok({
    lower: obj[lowerField] as string,
    upper: obj[upperField] as string,
  });
}

/**
 * Shared window arithmetic: is `at` inside `[lower, upper]`?
 *
 * `lower` is inclusive from its first instant; a date-only `upper` is inclusive
 * through the END of that day, via `resolveValidUntilExclusiveMs`. Identical
 * semantics to `checkCertWindow`, so a port implements the rule once.
 */
function checkWindow(lower: string, upper: string, at: string): CertWindowStatus {
  const from = parseIsoInstantMs(lower);
  const untilExclusive = resolveValidUntilExclusiveMs(upper);
  const instant = parseIsoInstantMs(at);

  if (from === null || untilExclusive === null || instant === null) {
    return { in_window: false, reason: 'unparseable_timestamp' };
  }
  if (instant < from) return { in_window: false, reason: 'before_valid_from' };
  if (instant >= untilExclusive) return { in_window: false, reason: 'after_valid_until' };
  return { in_window: true };
}

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

/**
 * Walk the identity chain: course_cert → enrollment_cert → token → session_pubkey_sig.
 *
 * **The steps run in this order and the order is load-bearing**, mirroring
 * `verifyManifestChain`:
 *
 *  0. Both artifacts declare `format_version === '2.0'`. Gated before any
 *     signature work — see {@link IdentityChainError}.
 *  0b. Both artifacts satisfy the 2.0 shape. Also before signature work:
 *     `canonicalize` omits `undefined`-valued keys, so an artifact missing a
 *     required field signs and verifies cleanly while carrying nothing there.
 *  1. `enrollment_cert` minus `course_sig` verifies against
 *     `courseCert.course_pubkey`.
 *  2. The token minus `enrollment_sig` verifies against
 *     `enrollment_cert.enrollment_pubkey`.
 *  3. `token.course_id === enrollment_cert.course_id === courseCert.course_id`.
 *  4. `session_pubkey_sig` verifies against `token.student_pubkey` over the
 *     binding payload for this exact session pubkey.
 *  5. Both validity windows — NON-FATAL, returned on the success value.
 *
 * Step 3 is not a formality, and it is why all THREE ids are compared rather
 * than two. Without it, 61B's course key can certify an enrollment key "for
 * 61C", that key can mint a 61C token, and steps 1 and 2 both pass: every
 * signature is genuine. Only comparing ids across every link catches a
 * cross-course forgery, and the requirement is that it be impossible, not
 * merely unlikely.
 *
 * ## The `course_cert` MUST already be verified
 *
 * This function takes the course certificate as a trust anchor and does not
 * re-verify it against the root key — exactly as `verifyCourseCert` takes the
 * root public key as a parameter rather than knowing one. The caller is
 * responsible for having obtained it from a successful `verifyManifestChain`.
 * Passing an unverified cert makes every result below meaningless, because an
 * attacker who supplies the cert supplies `course_pubkey` too and can then
 * satisfy the entire chain with keys of their own.
 *
 * @param input.identity           The `session.start` identity block.
 * @param input.session_pubkey     The session's ephemeral public key, 64-char hex.
 * @param input.course_cert        An ALREADY ROOT-VERIFIED course certificate.
 * @param input.session_started_at ISO 8601 session start; the token's window is
 *                                 judged against this, never wall-clock now.
 */
export async function verifyIdentityChain(input: {
  identity: SessionIdentity;
  session_pubkey: string;
  course_cert: CourseCert;
  session_started_at: string;
}): Promise<Result<IdentityChainOk, IdentityChainError>> {
  const { identity, session_pubkey, course_cert, session_started_at } = input;

  // Step 0 — version gate, before anything is trusted or verified. Reading the
  // declared version off an unvalidated object is safe precisely because nothing
  // else has happened yet.
  const declaredCertVersion = (identity.enrollment_cert as Partial<EnrollmentCert> | undefined)
    ?.format_version;
  if (declaredCertVersion !== ENROLLMENT_FORMAT_VERSION) {
    return err({
      kind: 'not_enrollment_2_0',
      artifact: 'cert',
      format_version: typeof declaredCertVersion === 'string' ? declaredCertVersion : '',
    });
  }
  const declaredTokenVersion = (identity.enrollment as Partial<EnrollmentToken> | undefined)
    ?.format_version;
  if (declaredTokenVersion !== ENROLLMENT_FORMAT_VERSION) {
    return err({
      kind: 'not_enrollment_2_0',
      artifact: 'token',
      format_version: typeof declaredTokenVersion === 'string' ? declaredTokenVersion : '',
    });
  }

  // Step 0b — shape before signatures, for both artifacts.
  const parsedCert = parseEnrollmentCert(identity.enrollment_cert);
  if (!parsedCert.ok) {
    const inner = parsedCert.error;
    return err({
      kind: 'invalid_cert_shape',
      ...(inner.kind === 'invalid_shape' && inner.field !== undefined
        ? { field: inner.field }
        : {}),
      ...(inner.kind === 'invalid_shape' && inner.reason !== undefined
        ? { reason: inner.reason }
        : {}),
    });
  }
  const parsedToken = parseEnrollmentToken(identity.enrollment);
  if (!parsedToken.ok) {
    const inner = parsedToken.error;
    return err({
      kind: 'invalid_token_shape',
      ...(inner.kind === 'invalid_shape' && inner.field !== undefined
        ? { field: inner.field }
        : {}),
      ...(inner.kind === 'invalid_shape' && inner.reason !== undefined
        ? { reason: inner.reason }
        : {}),
    });
  }

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
