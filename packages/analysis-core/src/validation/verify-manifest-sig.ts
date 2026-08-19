/**
 * Check 1 — Bundle manifest signature.
 * PRD §5.4 step 1; program spec §8 for the rolling seal.
 *
 * ## Classic seal
 *
 * The seal command signs the canonicalized manifest.json with the active
 * session's ed25519 private key. We verify against the session_pubkey stored
 * in each session.start.data, trying the most-recently-started session first
 * and falling back to all others.
 *
 * "Most recent" = last entry in bundle.sessions (sorted oldest→newest by the
 * loader).
 *
 * ## Rolling seal
 *
 * A git-submitted bundle has no `manifest.json`. It carries one
 * `manifest-<session_id>.json` + `.sig` per session, and — this is the whole
 * point — each one is signed by THAT session's own ephemeral key. So there is no
 * try-every-key fallback here: a rolling seal is verified against exactly one
 * public key, the one in its own session's `session.start`. That is what makes a
 * shared 61B `.provenance/` work, where a partner's sessions carry a partner's
 * keys and no key can vouch for another session; and it is what makes the
 * filename ↔ `session_id` binding meaningful, since falling back to other keys
 * would let `manifest-A.json` holding B's seal verify against B and pass.
 *
 * Every rolling-seal defect the loader recorded (unsigned manifest, missing
 * manifest, shape failure, sideways copy, sealed-but-absent session, unsealed
 * session, seals disagreeing on the assignment) is reported here as a failure of
 * this check. That is deliberate: those are integrity findings, and this is the
 * check that carries integrity findings about the seal.
 *
 * A bundle carrying BOTH shapes must satisfy both: the classic signature AND
 * every per-session rolling signature. Neither is allowed to excuse the other.
 */

import * as ed from '@noble/ed25519';
import { canonicalize } from '@provenance/log-core';
import type { Bundle, BundleRollingSeal } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

const ID = 'manifest_sig' as const;
const LABEL = 'Bundle manifest signature';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Decode a hex string to Uint8Array.
 * Returns null if the input is not valid hex.
 */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(byte)) return null;
    bytes[i / 2] = byte;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Classic seal — unchanged. A bundle with no rolling manifests reaches this and
// nothing else, and gets exactly the verdict it got before the rolling seal.
// ---------------------------------------------------------------------------

async function verifyClassicSeal(bundle: Bundle, manifestSigHex: string): Promise<ValidationCheck> {
  const sigBytes = hexToBytes(manifestSigHex);
  if (sigBytes === null) {
    return {
      id: ID,
      label: LABEL,
      status: 'fail',
      detail: `manifest.sig is not valid hex (length ${manifestSigHex.length}).`,
    };
  }

  const canonicalManifest = canonicalize(bundle.manifest);
  const messageBytes = new TextEncoder().encode(canonicalManifest);

  // Try most-recent session first, then fall back to others.
  const orderedSessions = [...bundle.sessions].reverse();

  for (const session of orderedSessions) {
    const pubkeyHex = session.firstEvent.data.session_pubkey;
    const pubkeyBytes = hexToBytes(pubkeyHex);
    if (pubkeyBytes === null) continue;

    try {
      const valid = await ed.verifyAsync(sigBytes, messageBytes, pubkeyBytes);
      if (valid) {
        return {
          id: ID,
          label: LABEL,
          status: 'pass',
          detail: `Verified against session ${session.sessionId}.`,
        };
      }
    } catch {
      // verifyAsync throws on malformed keys/sigs; treat as non-match and continue.
    }
  }

  const sessionIds = bundle.sessions.map((s) => s.sessionId).join(', ');
  return {
    id: ID,
    label: LABEL,
    status: 'fail',
    detail: `Signature did not verify against any session pubkey. Tried sessions: [${sessionIds}].`,
  };
}

// ---------------------------------------------------------------------------
// Rolling seal — one manifest per session, each against its OWN session key.
// ---------------------------------------------------------------------------

/**
 * Verify each rolling seal against the public key of the session it names.
 *
 * Seals that the loader already recorded a defect for (no `.sig`, no `.slog`) are
 * skipped rather than re-reported: their defect is already in
 * `rollingSeal.defects` and is folded into the same verdict below.
 *
 * @returns Human-readable problems, one per seal that failed cryptographically.
 */
async function verifyRollingSeals(
  bundle: Bundle,
  rollingSeal: BundleRollingSeal,
): Promise<{ problems: string[]; verifiedSessionIds: string[] }> {
  const problems: string[] = [];
  const verifiedSessionIds: string[] = [];
  const sessionsById = new Map(bundle.sessions.map((s) => [s.sessionId, s]));

  for (const seal of rollingSeal.seals) {
    // Already covered by a `missing_sig` defect — nothing to verify.
    if (seal.sigHex === null) continue;

    const session = sessionsById.get(seal.sessionId);
    // Already covered by a `no_session_log` defect — no key to verify against.
    if (session === undefined) continue;

    const sigBytes = hexToBytes(seal.sigHex);
    if (sigBytes === null) {
      problems.push(
        `manifest-${seal.sessionId}.sig is not valid hex (length ${seal.sigHex.length})`,
      );
      continue;
    }

    // THE key, not A key. Each rolling manifest is signed by its own session's
    // ephemeral key; trying any other session's key would defeat the filename ↔
    // session_id binding the loader just enforced.
    const pubkeyBytes = hexToBytes(session.firstEvent.data.session_pubkey);
    if (pubkeyBytes === null) {
      problems.push(
        `session ${seal.sessionId} has a malformed session_pubkey, so its rolling seal cannot be verified`,
      );
      continue;
    }

    const messageBytes = new TextEncoder().encode(canonicalize(seal.manifest));
    let valid = false;
    try {
      valid = await ed.verifyAsync(sigBytes, messageBytes, pubkeyBytes);
    } catch {
      // verifyAsync throws on malformed keys/sigs; treat as a non-match.
      valid = false;
    }

    if (valid) {
      verifiedSessionIds.push(seal.sessionId);
    } else {
      problems.push(
        `manifest-${seal.sessionId}.json did not verify against session ${seal.sessionId}'s own pubkey`,
      );
    }
  }

  return { problems, verifiedSessionIds };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function verifyManifestSig(bundle: Bundle): Promise<ValidationCheck> {
  const { rollingSeal } = bundle;

  // Classic-only: the overwhelmingly common case, and the one path that must not
  // move. Returns before any rolling code is even reached.
  if (rollingSeal === undefined) {
    if (bundle.manifestSigHex === null) {
      // The loader rejects a bundle with neither seal, so this is unreachable via
      // loadBundle. Guard defensively rather than claiming a pass.
      return {
        id: ID,
        label: LABEL,
        status: 'fail',
        detail: 'Bundle carries no manifest signature of either shape.',
      };
    }
    return verifyClassicSeal(bundle, bundle.manifestSigHex);
  }

  const problems: string[] = [];

  // A both-shapes bundle must satisfy the classic signature too.
  if (bundle.manifestSigHex !== null) {
    const classic = await verifyClassicSeal(bundle, bundle.manifestSigHex);
    if (classic.status !== 'pass') {
      problems.push(`classic manifest.json: ${classic.detail ?? 'signature did not verify'}`);
    }
  }

  const { problems: sigProblems, verifiedSessionIds } = await verifyRollingSeals(
    bundle,
    rollingSeal,
  );
  problems.push(...sigProblems);
  problems.push(...rollingSeal.defects.map((d) => d.detail));

  if (problems.length > 0) {
    return {
      id: ID,
      label: LABEL,
      status: 'fail',
      detail: `Rolling seal did not fully verify: ${problems.join(' | ')}`,
      supportingSeqs: rollingSeal.defects
        .filter((d) => bundle.sessions.some((s) => s.sessionId === d.sessionId))
        .map((d) => ({ sessionId: d.sessionId, seq: 0 })),
    };
  }

  const classicNote = bundle.manifestSigHex === null ? '' : ' Classic manifest.json also verified.';
  return {
    id: ID,
    label: LABEL,
    status: 'pass',
    detail:
      `${verifiedSessionIds.length} rolling manifest(s) verified, each against its own ` +
      `session key: [${verifiedSessionIds.join(', ')}].${classicNote}`,
  };
}
