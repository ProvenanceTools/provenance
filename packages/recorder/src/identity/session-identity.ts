/**
 * Build the `session.start.identity` block (program spec §5, §5a step 5).
 *
 * This is the one place on the recorder where the student's private key is used.
 * It derives that key from the master secret, countersigns this session's
 * ephemeral `session_pubkey`, and assembles
 * `{ enrollment, enrollment_cert, session_pubkey_sig }`.
 *
 * ## Two identity families, and which one wins
 *
 * - **2.1, INSTITUTION-scoped (current).** Anchored to the recorder's embedded
 *   ROOT public key, using the student's single GLOBAL key. Does not consult the
 *   manifest at all, so it works in any workspace.
 * - **2.0, COURSE-scoped (legacy).** Anchored to the manifest's root-verified
 *   `course_cert`, using a per-course derived key. Kept forever: a token a
 *   student already holds must keep working.
 *
 * **If a 2.1 credential is stored it decides, with no fallback to 2.0.** The two
 * families attribute to different `student_ref`s — 2.0's is per-course, 2.1's is
 * global — so quietly falling back would file the session under a different
 * contributor than the student believes, and hide the 2.1 problem that caused
 * it. See the precedence comment in {@link buildSessionIdentity}.
 *
 * ## Two rules, in priority order
 *
 * **1. Never block recording.** Every failure below returns `skipped` and the
 * session records without an `identity`. This is the same reasoning §4 applies to
 * an expired `course_cert`: for an integrity tool, silently not recording is a
 * worse failure than recording under an incomplete credential. A student who has
 * not enrolled yet, whose keyring is unavailable, or whose course let a cert
 * lapse still produces a bundle with a full, chain-verifiable event stream.
 *
 * **2. Never emit an identity that does not verify.** Before returning, the
 * assembled block is walked with `verifyIdentityChain` against the manifest's
 * ALREADY-VERIFIED `course_cert` — the same walk the analyzer will perform. A
 * block that fails is dropped rather than written, because `session.start` is
 * signed and hash-chained: a broken claim in there is permanent, unrepairable,
 * and looks exactly like tampering during an adjudication.
 *
 * ## No network. Ever.
 *
 * Recorder PRD NG2. Nothing here fetches. The enrollment token arrives by paste
 * (`commands/enrollment.ts`) and everything else is derived locally, so the whole
 * identity path works on a plane.
 */

import {
  deriveCourseKeypair,
  deriveStudentKeypair,
  manifestFormatVersion,
  signSessionPubkey,
  signStudentSessionBinding,
  verifyIdentityChain,
  verifyInstitutionCert,
} from '@provenance/log-core';
import type {
  CourseCert,
  IdentityChainError,
  IdentityChainOk,
  Manifest,
  SessionIdentity,
} from '@provenance/log-core';
import {
  loadEnrollment,
  loadMasterSecret,
  loadStudentCredentialArtifact,
} from './secret-store.js';
import type { SecretStore, StoredCredential } from './secret-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why no `identity` was emitted. Diagnostic only — none of these stop recording. */
export type IdentitySkipReason =
  /**
   * 2.1: the recorder has no embedded ROOT public key, so the institution cert
   * cannot be turned into a trust anchor. A build/packaging problem, not a
   * student one.
   */
  | { kind: 'no_root_public_key' }
  /**
   * 2.1: the stored `institution_cert` does not verify against the recorder's
   * embedded ROOT key. The cert is not authentic, so nothing under it can be
   * trusted — and an unverifiable anchor must never be passed to the chain walk,
   * because an attacker who supplies the anchor supplies its public key too.
   */
  | { kind: 'institution_cert_not_root_signed' }
  /**
   * 2.1: the credential names a `student_pubkey` this master secret does not
   * derive. The 2.1 analogue of `student_key_mismatch`.
   */
  | { kind: 'credential_key_mismatch'; credential_student_pubkey: string; derived_pubkey: string }
  /** A 1.x manifest, or a 2.0 one missing `course_id`/`course_cert`. Nothing to anchor to. */
  | { kind: 'manifest_not_2_0' }
  /** No token stored for this manifest's course. The ordinary pre-enrollment state. */
  | { kind: 'not_enrolled'; course_id: string }
  /** No usable master secret — absent, corrupt, or an unavailable keyring. */
  | { kind: 'master_secret_unavailable'; reason: string }
  /** The session key this recorder generated is not 64-char hex. */
  | { kind: 'invalid_session_pubkey' }
  /**
   * The stored token names a `student_pubkey` this master secret does not derive
   * — normally a token minted before the student moved machines and imported a
   * different secret. Signing anyway would produce a countersignature that
   * cannot verify.
   */
  | { kind: 'student_key_mismatch'; token_student_pubkey: string; derived_pubkey: string }
  /** The assembled block failed the chain walk. Rule 2: drop it. */
  | { kind: 'chain_did_not_verify'; error: IdentityChainError }
  /** Any unexpected throw. Recording continues regardless. */
  | { kind: 'unexpected_error'; reason: string };

export type IdentityOutcome =
  | {
      kind: 'emitted';
      identity: SessionIdentity;
      /**
       * The chain-walk result. Its `cert_window` / `token_window` are NON-FATAL
       * and may report out-of-window; callers use them for a student-facing
       * nudge, never as a reason to withhold the block.
       */
      verified: IdentityChainOk;
    }
  | { kind: 'skipped'; reason: IdentitySkipReason };

const HEX_64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// buildSessionIdentity
// ---------------------------------------------------------------------------

/**
 * @param manifest          The ALREADY-VERIFIED manifest for this assignment root.
 *                          Its `course_cert` is the trust anchor for the chain
 *                          walk, so passing an unverified manifest makes the
 *                          verification meaningless (see `verifyIdentityChain`).
 * @param sessionPubkeyHex  This session's ephemeral public key, 64-char hex.
 * @param sessionStartedAt  ISO 8601 session start. The token's validity window is
 *                          judged against this, never wall-clock now, so an
 *                          archived bundle still reads correctly years later.
 * @param secrets           `ExtensionContext.secrets` in production.
 */
export async function buildSessionIdentity(input: {
  manifest: Manifest;
  sessionPubkeyHex: string;
  sessionStartedAt: string;
  secrets: SecretStore;
  /**
   * The recorder's embedded ROOT public key, 64-char hex. The trust anchor for
   * the 2.1 chain: the stored `institution_cert` is root-verified against it
   * before it is used, because an attacker who supplies the cert supplies its
   * `institution_pubkey` too.
   *
   * Optional so existing callers keep working; absent means the 2.1 path cannot
   * run and is reported as `no_root_public_key` rather than silently skipped.
   */
  rootPubkeyHex?: string;
}): Promise<IdentityOutcome> {
  const { manifest, sessionPubkeyHex, sessionStartedAt, secrets, rootPubkeyHex } = input;

  try {
    if (!HEX_64_RE.test(sessionPubkeyHex)) {
      return { kind: 'skipped', reason: { kind: 'invalid_session_pubkey' } };
    }

    // --- PRECEDENCE: 2.1 first, and if a 2.1 credential is stored it DECIDES.
    //
    // A student holding both a 2.1 credential and a legacy 2.0 token gets 2.1,
    // and if the 2.1 path then fails there is deliberately NO fallback to 2.0.
    //
    // Falling back would be the more forgiving choice and it is the wrong one.
    // The two families attribute to DIFFERENT refs — 2.0's `student_ref` is
    // per-course, 2.1's is global — so a silent fallback would file this
    // session under a different contributor than the student believes they are
    // recording as, and the 2.1 problem that caused it would never surface. An
    // integrity tool must not quietly change who it says did the work.
    //
    // Not blocking recording is preserved either way: a failed 2.1 path skips
    // the identity block, exactly as every other failure here does.
    const credential = await loadStudentCredentialArtifact(secrets);
    if (credential !== undefined) {
      return await buildInstitutionIdentity({
        stored: credential,
        sessionPubkeyHex,
        sessionStartedAt,
        secrets,
        rootPubkeyHex,
      });
    }

    // --- 2.0, LEGACY. Reached only when no 2.1 credential is stored.
    // --- Anchor. There is no 2.0 identity chain without a course cert.
    const courseCert: CourseCert | undefined = manifest.course_cert;
    const courseId = manifest.course_id;
    if (manifestFormatVersion(manifest) !== '2.0' || courseCert === undefined || !courseId) {
      return { kind: 'skipped', reason: { kind: 'manifest_not_2_0' } };
    }

    // --- The token for THIS course. Keyed by the manifest's course_id, so an
    // --- enrollment in another course is simply "not enrolled" here; the chain
    // --- walk's step 3 would reject it anyway.
    const stored = await loadEnrollment(secrets, courseId);
    if (stored === undefined) {
      return { kind: 'skipped', reason: { kind: 'not_enrolled', course_id: courseId } };
    }

    // --- The student key. Loaded, never created: a freshly generated secret
    // --- could not possibly derive the key an existing token names, so creating
    // --- one here would only manufacture a mismatch.
    const master = await loadMasterSecret(secrets);
    if (!master.ok) {
      return {
        kind: 'skipped',
        reason: { kind: 'master_secret_unavailable', reason: master.error.kind },
      };
    }

    const derived = await deriveCourseKeypair(master.value, courseId);
    if (derived.publicKeyHex !== stored.enrollment.student_pubkey) {
      return {
        kind: 'skipped',
        reason: {
          kind: 'student_key_mismatch',
          token_student_pubkey: stored.enrollment.student_pubkey,
          derived_pubkey: derived.publicKeyHex,
        },
      };
    }

    // --- Countersign this session's ephemeral key. `student_ref` and `course_id`
    // --- come from the token, so the signature asserts which student, in which
    // --- course, adopted this key — and the verifier cross-checks both.
    const session_pubkey_sig = await signSessionPubkey(
      {
        course_id: stored.enrollment.course_id,
        student_ref: stored.enrollment.student_ref,
        session_pubkey: sessionPubkeyHex,
      },
      derived.privateKey,
    );

    const identity: SessionIdentity = {
      enrollment: stored.enrollment,
      enrollment_cert: stored.enrollment_cert,
      session_pubkey_sig,
    };

    // --- Rule 2. Walk it exactly as the analyzer will, before it becomes part of
    // --- a signed chain we can never amend.
    const walked = await verifyIdentityChain({
      identity,
      session_pubkey: sessionPubkeyHex,
      course_cert: courseCert,
      session_started_at: sessionStartedAt,
    });
    if (!walked.ok) {
      return { kind: 'skipped', reason: { kind: 'chain_did_not_verify', error: walked.error } };
    }

    // Out-of-window is deliberately NOT a reason to withhold: expiry is reported,
    // never enforced (program spec §4). `walked.value.*_window` carries it on.
    return { kind: 'emitted', identity, verified: walked.value };
  } catch (e) {
    return {
      kind: 'skipped',
      reason: {
        kind: 'unexpected_error',
        reason: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// The 2.1 INSTITUTION-scoped path
// ---------------------------------------------------------------------------

/**
 * Build the identity block from a 2.1 credential.
 *
 * Structurally the twin of the 2.0 path above, with three differences that all
 * follow from identity no longer being course-scoped:
 *
 *  - **The manifest is not consulted at all.** A 2.1 credential names no course,
 *    so there is nothing to match against `manifest.course_id`, and the trust
 *    anchor is the recorder's embedded ROOT key rather than the manifest's
 *    `course_cert`. A student with a 2.1 credential therefore gets an identity
 *    even in a 1.x workspace — which is the point: the 2.0 design could not
 *    produce an identity before the student's first submission.
 *  - **The student key is the single GLOBAL one** (`deriveStudentKeypair`), not
 *    a per-course derivation.
 *  - **The anchor is root-verified here, by us.** `verifyIdentityChain` does not
 *    do it, deliberately — it takes the anchor as a parameter exactly as the 2.0
 *    walk takes an already-verified `course_cert`. Passing the bundle's own
 *    unverified cert would make the entire walk meaningless.
 */
async function buildInstitutionIdentity(input: {
  stored: StoredCredential;
  sessionPubkeyHex: string;
  sessionStartedAt: string;
  secrets: SecretStore;
  rootPubkeyHex: string | undefined;
}): Promise<IdentityOutcome> {
  const { stored, sessionPubkeyHex, sessionStartedAt, secrets, rootPubkeyHex } = input;

  if (rootPubkeyHex === undefined || !HEX_64_RE.test(rootPubkeyHex)) {
    return { kind: 'skipped', reason: { kind: 'no_root_public_key' } };
  }

  // --- Turn the travelling cert into a TRUST ANCHOR, or refuse to proceed.
  const anchored = await verifyInstitutionCert(stored.enrollment_cert, rootPubkeyHex);
  if (!anchored.ok) {
    return { kind: 'skipped', reason: { kind: 'institution_cert_not_root_signed' } };
  }

  // --- The student key. Loaded, never created: a freshly generated secret could
  // --- not possibly derive the key an existing credential names.
  const master = await loadMasterSecret(secrets);
  if (!master.ok) {
    return {
      kind: 'skipped',
      reason: { kind: 'master_secret_unavailable', reason: master.error.kind },
    };
  }

  const derived = await deriveStudentKeypair(master.value);
  if (derived.publicKeyHex !== stored.enrollment.student_pubkey) {
    return {
      kind: 'skipped',
      reason: {
        kind: 'credential_key_mismatch',
        credential_student_pubkey: stored.enrollment.student_pubkey,
        derived_pubkey: derived.publicKeyHex,
      },
    };
  }

  // --- Countersign this session's ephemeral key under the v2 binding payload.
  // --- Its `purpose` tag differs from 2.0's, so a countersignature can never be
  // --- replayed across versions.
  const session_pubkey_sig = await signStudentSessionBinding(
    {
      institution_id: stored.enrollment.institution_id,
      student_ref: stored.enrollment.student_ref,
      session_pubkey: sessionPubkeyHex,
    },
    derived.privateKey,
  );

  const identity: SessionIdentity = {
    enrollment: stored.enrollment,
    enrollment_cert: stored.enrollment_cert,
    session_pubkey_sig,
  };

  // --- Rule 2. Walk it exactly as the analyzer will, before it becomes part of
  // --- a signed chain we can never amend.
  const walked = await verifyIdentityChain({
    identity,
    session_pubkey: sessionPubkeyHex,
    institution_cert: stored.enrollment_cert,
    session_started_at: sessionStartedAt,
  });
  if (!walked.ok) {
    return { kind: 'skipped', reason: { kind: 'chain_did_not_verify', error: walked.error } };
  }

  return { kind: 'emitted', identity, verified: walked.value };
}
