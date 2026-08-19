/**
 * Build the `session.start.identity` block (program spec §5, §5a step 5).
 *
 * This is the one place on the recorder where the student's per-course private
 * key is used. It derives that key from the master secret, countersigns this
 * session's ephemeral `session_pubkey`, and assembles
 * `{ enrollment, enrollment_cert, session_pubkey_sig }`.
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
  manifestFormatVersion,
  signSessionPubkey,
  verifyIdentityChain,
} from '@provenance/log-core';
import type {
  CourseCert,
  IdentityChainError,
  IdentityChainOk,
  Manifest,
  SessionIdentity,
} from '@provenance/log-core';
import { loadEnrollment, loadMasterSecret } from './secret-store.js';
import type { SecretStore } from './secret-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why no `identity` was emitted. Diagnostic only — none of these stop recording. */
export type IdentitySkipReason =
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
}): Promise<IdentityOutcome> {
  const { manifest, sessionPubkeyHex, sessionStartedAt, secrets } = input;

  try {
    // --- Anchor. There is no identity chain without a course cert to anchor it.
    const courseCert: CourseCert | undefined = manifest.course_cert;
    const courseId = manifest.course_id;
    if (manifestFormatVersion(manifest) !== '2.0' || courseCert === undefined || !courseId) {
      return { kind: 'skipped', reason: { kind: 'manifest_not_2_0' } };
    }

    if (!HEX_64_RE.test(sessionPubkeyHex)) {
      return { kind: 'skipped', reason: { kind: 'invalid_session_pubkey' } };
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
