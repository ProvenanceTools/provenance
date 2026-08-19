/**
 * Check 2 — Session binding.
 * PRD §5.4 step 2; program spec §5 ("Check 2 becomes a real check").
 *
 * ## What this check proves, per format version
 *
 * **1.0 / 1.1** — the bundle carries only
 * `session.start.data.manifest_sig`: a 128-hex string copied out of the
 * `.provenance-manifest` the session started against. The signed payload never
 * entered the bundle, so the only statement available is a *consistency* one:
 * every session must have been started against the same assignment manifest.
 * That is exactly what this check did before Manifest 2.0, and it is what it
 * still does for 1.x bundles — permanently. Archived submissions must keep
 * validating years later (program spec §9).
 *
 * **2.0** — `session.start.data.manifest` carries the FULL manifest: the
 * course-signed payload, its `sig`, and the root-signed `course_cert`. That
 * turns the check into a real cryptographic verification, walked entirely
 * offline and trusting nothing from the server:
 *
 *   1. `course_cert` verifies against the configured ROOT public key.
 *   2. The manifest payload — `course_id`, `assignment_id`, `semester`,
 *      `issued_at`, `files_under_review`, `collaboration`, `submission`,
 *      `scope`, and the capture `policy` — verifies against the course public
 *      key that certificate vouches for.
 *   3. `manifest.course_id === course_cert.course_id`, so one course's key
 *      cannot sign a manifest claiming to be another course.
 *   4. `manifest.issued_at` falls inside the certificate's validity window
 *      (non-fatal — reported, never a failure; see below).
 *   5. Every session's `manifest_sig` equals the embedded `manifest.sig`. This
 *      is the binding to the session keys: `manifest_sig` is the HKDF input
 *      keying material for the per-session keypair, so requiring the equality
 *      is what ties the *verified* manifest to the key that signed this
 *      session's checkpoints and the bundle seal.
 *   6. All sessions still share one `manifest_sig` (5 implies this).
 *
 * ## Why an expired certificate is not a failure
 *
 * Program spec §4: a course that lets a certificate lapse mid-semester must not
 * have recording silently stop for the whole class, so the recorder records and
 * stamps the expiry and the analyzer decides. The window result is surfaced in
 * `detail` rather than turning into a `fail`, because a bundle whose signatures
 * all verify is not tampered with — it is late paperwork. The window is
 * evaluated against `issued_at`, never wall-clock now: a Fall 2026 bundle must
 * still verify in 2028 for an adjudication case.
 *
 * ## The root public key is a parameter
 *
 * `analysis-core` is isomorphic and must stay pure — it never hardcodes a key.
 * When no root key is configured the 2.0 chain cannot be walked, and the check
 * reports `skipped` rather than pretending either way.
 */

import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';
import { verifyBundleTrustChain, describeTrustChainError } from '../manifest/bundle-manifest.js';

const LABEL = 'Session binding to assignment manifest';

export type SessionBindingOptions = {
  /**
   * Hex ed25519 ROOT public key. Required to walk a 2.0 trust chain; omitted or
   * empty means the chain cannot be verified and the check reports `skipped`
   * for 2.0 bundles. 1.x bundles never consult it.
   */
  rootPubkeyHex?: string;
};

// ---------------------------------------------------------------------------
// 1.x path — sig equality across sessions (unchanged, permanently supported)
// ---------------------------------------------------------------------------

function verifyLegacySigEquality(bundle: Bundle): ValidationCheck {
  const firstSig = bundle.sessions[0]!.firstEvent.data.manifest_sig;

  for (let i = 1; i < bundle.sessions.length; i++) {
    const session = bundle.sessions[i]!;
    const sig = session.firstEvent.data.manifest_sig;
    if (sig !== firstSig) {
      return {
        id: 'session_binding',
        label: LABEL,
        status: 'fail',
        detail:
          `Session ${session.sessionId} was started against a different assignment manifest ` +
          `(manifest_sig mismatch vs session ${bundle.sessions[0]!.sessionId}). ` +
          `This bundle mixes sessions from different assignments.`,
        supportingSeqs: [{ sessionId: session.sessionId, seq: 0 }],
      };
    }
  }

  return {
    id: 'session_binding',
    label: LABEL,
    status: 'pass',
    detail:
      bundle.sessions.length === 1
        ? 'Single session; binding trivially consistent.'
        : `All ${bundle.sessions.length} sessions share the same manifest_sig.`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function verifySessionBinding(
  bundle: Bundle,
  options: SessionBindingOptions = {},
): Promise<ValidationCheck> {
  if (bundle.sessions.length === 0) {
    // The loader already rejects empty session arrays, but guard defensively.
    return {
      id: 'session_binding',
      label: LABEL,
      status: 'fail',
      detail: 'Bundle contains no sessions.',
    };
  }

  const chain = await verifyBundleTrustChain(bundle, options.rootPubkeyHex);

  switch (chain.kind) {
    case 'legacy':
      return verifyLegacySigEquality(bundle);

    case 'unconfigured':
      return {
        id: 'session_binding',
        label: LABEL,
        status: 'skipped',
        detail:
          `Bundle carries a Manifest 2.0 trust chain (course ${String(chain.manifest.course_id)}), ` +
          `and all ${bundle.sessions.length} session(s) bind to it, but no root public key is ` +
          `configured so the chain could not be verified.`,
      };

    case 'invalid': {
      const failing =
        chain.error.kind === 'manifest_sig_mismatch' ||
        chain.error.kind === 'embedded_manifest_invalid'
          ? chain.error.sessionId
          : null;
      return {
        id: 'session_binding',
        label: LABEL,
        status: 'fail',
        detail: `Manifest 2.0 trust chain did not verify: ${describeTrustChainError(chain.error)}.`,
        ...(failing === null ? {} : { supportingSeqs: [{ sessionId: failing, seq: 0 }] }),
      };
    }

    case 'verified': {
      const { chain: ok } = chain;
      const windowNote = ok.window.in_window
        ? `certificate valid at issue time (${chain.manifest.issued_at})`
        : `NOTE: certificate was ${ok.window.reason} at issue time (${chain.manifest.issued_at}) — ` +
          `signatures still verify; the course let the certificate lapse`;
      return {
        id: 'session_binding',
        label: LABEL,
        status: 'pass',
        detail:
          `Trust chain verified offline: root → course_cert (${ok.course_id}) → manifest → ` +
          `all ${bundle.sessions.length} session(s). Course key ${ok.course_pubkey.slice(0, 16)}…; ` +
          `${windowNote}.`,
      };
    }
  }
}
