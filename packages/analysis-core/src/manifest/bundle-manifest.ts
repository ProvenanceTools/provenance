/**
 * Reading the assignment manifest that travels *inside* a bundle.
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §3 (Manifest 2.0), §4 (capture policy), §5 (`session.start` 2.0).
 *
 * Before Manifest 2.0 the analyzer never saw the assignment manifest at all: a
 * bundle carried only `session.start.data.manifest_sig`, a 128-hex opaque
 * string. From 2.0 on, `session.start.data.manifest` carries the FULL manifest
 * — signed payload, `sig`, and the root-signed `course_cert` — so every reader
 * in this repo can answer three new questions entirely offline:
 *
 *  1. Which course signed this, and was that course key vouched for by the root?
 *     (`verifyBundleTrustChain` — validation check 2.)
 *  2. What capture policy was in force? (`resolveBundleCapturePolicy` — the
 *     absence-vs-disabled rule; see below.)
 *  3. What are the assignment's capability flags? (`summarizeBundleManifest` —
 *     what the analyzer UI shows.)
 *
 * ## 1.x is supported permanently
 *
 * Every function here degrades to exactly the pre-2.0 answer for a bundle with
 * no embedded manifest: `resolveBundleCapturePolicy` returns
 * `DEFAULT_CAPTURE_POLICY` (everything on, 30s heartbeat — i.e. what a 1.x
 * recorder actually did), and `verifyBundleTrustChain` returns `legacy` rather
 * than an error. Archived submissions must still validate years later; that
 * adjudication case is what justifies the whole program (spec §9).
 *
 * ## The absence-vs-disabled rule (spec §4)
 *
 * A heuristic that reads "no `selection.change` events" as suspicious will
 * manufacture false accusations against students in a course that turned that
 * signal off. Any heuristic consuming a policy-gated signal MUST call
 * {@link isSignalCaptured} (or {@link bundleHeartbeatIntervalMs}) and return
 * not-applicable rather than a flag or a zero.
 *
 * ## Why "most restrictive wins" when sessions disagree
 *
 * A bundle's sessions should all carry the same manifest — check 2 fails if
 * their `manifest_sig` values differ. If they nonetheless disagree (a course
 * re-issued a manifest mid-assignment), a signal disabled in ANY session is
 * treated as disabled for the whole bundle, because that session's silence is
 * explained by policy and a heuristic must not read it as evidence. The
 * heartbeat interval merges the other way — the LONGEST interval wins — so
 * interval-derived gap thresholds stay permissive.
 */

import {
  parseManifestValue,
  manifestFormatVersion,
  verifyManifestChain,
  resolveCapturePolicy,
  DEFAULT_CAPTURE_POLICY,
  MANIFEST_FORMAT_VERSION_2,
} from '@provenance/log-core';
import type {
  Manifest,
  ManifestChainError,
  ManifestChainOk,
  CapturePolicy,
  CertWindowStatus,
} from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';

// ---------------------------------------------------------------------------
// Session-level extraction
// ---------------------------------------------------------------------------

export type SessionManifestBinding = {
  sessionId: string;
  /** `session.start.data.manifest_sig` — present in every format version. */
  manifestSig: string;
  /** The full manifest carried by `session.start` 2.0; `null` for 1.x. */
  manifest: Manifest | null;
  /**
   * Set when `data.manifest` was present but failed shape validation. A
   * malformed embedded manifest is a validation failure, never an exception —
   * it arrives from a file a student can edit.
   */
  manifestError: string | null;
};

/**
 * Read each session's manifest binding.
 *
 * Validates the embedded object through `parseManifestValue` rather than
 * trusting its shape: a 2.0 manifest missing `policy` would otherwise chain
 * cleanly while carrying no policy at all (`canonicalize` drops
 * undefined-valued keys), and "the chain verified" would stop implying "the
 * course signed a capture policy".
 */
export function readSessionManifests(bundle: Bundle): SessionManifestBinding[] {
  return bundle.sessions.map((session) => {
    const data = session.firstEvent.data;
    const manifestSig = typeof data.manifest_sig === 'string' ? data.manifest_sig : '';
    const raw: unknown = data.manifest;

    if (raw === undefined || raw === null) {
      return { sessionId: session.sessionId, manifestSig, manifest: null, manifestError: null };
    }

    const parsed = parseManifestValue(raw);
    if (!parsed.ok) {
      const e = parsed.error;
      const detail =
        e.kind === 'invalid_shape'
          ? `${e.field ?? 'manifest'}: ${e.reason ?? 'invalid'}`
          : e.kind === 'invalid_json'
            ? e.message
            : 'invalid signature encoding';
      return {
        sessionId: session.sessionId,
        manifestSig,
        manifest: null,
        manifestError: detail,
      };
    }

    return {
      sessionId: session.sessionId,
      manifestSig,
      manifest: parsed.value,
      manifestError: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Capture policy
// ---------------------------------------------------------------------------

/** The boolean capture signals a course policy can switch off (spec §4). */
export type CaptureSignal = 'selection_change' | 'focus_change' | 'terminal' | 'inline_content';

/** Fixed order, so `disabledSignals` is deterministic for snapshots and UI. */
export const CAPTURE_SIGNALS: readonly CaptureSignal[] = [
  'selection_change',
  'focus_change',
  'terminal',
  'inline_content',
];

export type BundleCapturePolicy = {
  /**
   * `'manifest_2_0'` when at least one session carried a 2.0 manifest with a
   * policy block; `'default'` for every 1.x bundle.
   */
  source: 'manifest_2_0' | 'default';
  /** The policy heuristics must gate on. See the module docstring for the merge. */
  effective: CapturePolicy;
  /** Per-session resolved policy, for consumers that reason per session. */
  bySession: Map<string, CapturePolicy>;
  /** Gated signals the course switched off. Always empty when `source` is `'default'`. */
  disabledSignals: CaptureSignal[];
};

/**
 * Resolve the effective capture policy recorded in a bundle.
 *
 * Cheap (one pass over sessions) and pure, so heuristics call it directly
 * rather than threading it through the `Heuristic.run` signature.
 */
export function resolveBundleCapturePolicy(bundle: Bundle): BundleCapturePolicy {
  const bySession = new Map<string, CapturePolicy>();
  let sawManifest = false;

  const effective: CapturePolicy = { ...DEFAULT_CAPTURE_POLICY };
  let intervalSeen = false;

  for (const binding of readSessionManifests(bundle)) {
    if (binding.manifest === null) {
      // 1.x session, or a session whose embedded manifest did not validate.
      // Either way we know nothing was disabled, so the default applies.
      bySession.set(binding.sessionId, { ...DEFAULT_CAPTURE_POLICY });
      continue;
    }
    sawManifest = true;
    const resolved = resolveCapturePolicy(binding.manifest.policy);
    bySession.set(binding.sessionId, resolved);

    for (const signal of CAPTURE_SIGNALS) {
      if (!resolved[signal]) effective[signal] = false;
    }
    effective.heartbeat_interval_ms = intervalSeen
      ? Math.max(effective.heartbeat_interval_ms, resolved.heartbeat_interval_ms)
      : resolved.heartbeat_interval_ms;
    intervalSeen = true;
  }

  return {
    source: sawManifest ? 'manifest_2_0' : 'default',
    effective,
    bySession,
    disabledSignals: CAPTURE_SIGNALS.filter((s) => !effective[s]),
  };
}

/**
 * Was `signal` captured for this bundle?
 *
 * The gate every policy-sensitive heuristic calls. `true` for every 1.x bundle,
 * so pre-2.0 behaviour is byte-for-byte unchanged.
 */
export function isSignalCaptured(bundle: Bundle, signal: CaptureSignal): boolean {
  return resolveBundleCapturePolicy(bundle).effective[signal];
}

/**
 * The heartbeat cadence this bundle was recorded at, in milliseconds.
 *
 * `heartbeat_interval_ms` is tunable per course (clamped to [5s, 120s]), so any
 * threshold expressed in "missed heartbeats" must be derived from this rather
 * than from a constant. 1.x bundles return 30_000 — what a 1.x recorder used.
 */
export function bundleHeartbeatIntervalMs(bundle: Bundle): number {
  return resolveBundleCapturePolicy(bundle).effective.heartbeat_interval_ms;
}

// ---------------------------------------------------------------------------
// Trust chain
// ---------------------------------------------------------------------------

/**
 * A session bound itself to a manifest whose `sig` is not the one it recorded
 * in `manifest_sig`.
 *
 * This matters more than it looks: `manifest_sig` is the HKDF input keying
 * material for the session keypair (`session-keys.ts`). Requiring
 * `manifest.sig === manifest_sig` is what binds the *verified* manifest to the
 * key that signed this session's checkpoints and bundle seal. Without it, a
 * bundle could staple a genuine 2.0 manifest from one assignment onto sessions
 * keyed by a different one.
 */
export type ManifestSigMismatch = {
  kind: 'manifest_sig_mismatch';
  sessionId: string;
  manifestSig: string;
  embeddedSig: string;
};

/** The embedded manifest object failed shape validation. */
export type EmbeddedManifestInvalid = {
  kind: 'embedded_manifest_invalid';
  sessionId: string;
  detail: string;
};

export type BundleTrustChainError =
  | ManifestChainError
  | ManifestSigMismatch
  | EmbeddedManifestInvalid;

export type BundleTrustChain =
  /** No session carried an embedded manifest — a 1.0/1.1 bundle. Not an error. */
  | { kind: 'legacy' }
  /** A 2.0 bundle, but no root public key was supplied, so step 1 cannot run. */
  | { kind: 'unconfigured'; manifest: Manifest }
  | { kind: 'verified'; manifest: Manifest; chain: ManifestChainOk }
  | { kind: 'invalid'; manifest: Manifest | null; error: BundleTrustChainError };

/**
 * Walk root → `course_cert` → manifest → session for a bundle, offline.
 *
 * @param rootPubkeyHex The embedded root public key. A PARAMETER, never a
 *   constant in this package: `analysis-core` is isomorphic and must stay pure,
 *   and one deployment's root key is not another's. The server reads it from
 *   env; the browser from build config.
 *
 * Steps 1–4 are `verifyManifestChain` in log-core. This function adds the two
 * bundle-level bindings log-core cannot see: every session must record the same
 * `manifest_sig` (the pre-2.0 check 2, retained), and that sig must be the
 * embedded manifest's own `sig`.
 */
export async function verifyBundleTrustChain(
  bundle: Bundle,
  rootPubkeyHex?: string,
): Promise<BundleTrustChain> {
  const bindings = readSessionManifests(bundle);

  const withManifest = bindings.filter((b) => b.manifest !== null);
  if (withManifest.length === 0) {
    const broken = bindings.find((b) => b.manifestError !== null);
    if (broken !== undefined) {
      return {
        kind: 'invalid',
        manifest: null,
        error: {
          kind: 'embedded_manifest_invalid',
          sessionId: broken.sessionId,
          detail: broken.manifestError ?? 'invalid',
        },
      };
    }
    return { kind: 'legacy' };
  }

  // A session that carries a manifest but fails to validate it is a hard error
  // even if other sessions are fine — the bundle claims 2.0 and does not honour it.
  const broken = bindings.find((b) => b.manifestError !== null);
  if (broken !== undefined) {
    return {
      kind: 'invalid',
      manifest: null,
      error: {
        kind: 'embedded_manifest_invalid',
        sessionId: broken.sessionId,
        detail: broken.manifestError ?? 'invalid',
      },
    };
  }

  const manifest = withManifest[0]!.manifest as Manifest;

  // Bundle binding: every session's manifest_sig must be the embedded sig.
  // Checked BEFORE the signature work so a mixed bundle reports the useful
  // cause rather than a signature failure on an unrelated manifest.
  for (const binding of bindings) {
    if (binding.manifestSig !== manifest.sig) {
      return {
        kind: 'invalid',
        manifest,
        error: {
          kind: 'manifest_sig_mismatch',
          sessionId: binding.sessionId,
          manifestSig: binding.manifestSig,
          embeddedSig: manifest.sig,
        },
      };
    }
  }

  if (rootPubkeyHex === undefined || rootPubkeyHex.length === 0) {
    return { kind: 'unconfigured', manifest };
  }

  const chain = await verifyManifestChain(manifest, rootPubkeyHex);
  if (!chain.ok) {
    return { kind: 'invalid', manifest, error: chain.error };
  }
  return { kind: 'verified', manifest, chain: chain.value };
}

// ---------------------------------------------------------------------------
// UI/API-facing summary
// ---------------------------------------------------------------------------

export type BundleManifestCert = {
  course_id: string;
  course_pubkey: string;
  valid_from: string;
  valid_until: string;
  /** Evaluated against `manifest.issued_at`, never wall-clock now (spec §2). */
  in_window: boolean;
  /** Non-null only when `in_window` is false. */
  window_reason: string | null;
};

/**
 * Everything a reader needs to render "what kind of assignment is this, and
 * what is absent by policy rather than by omission".
 */
export type BundleManifestSummary = {
  /** `'2.0'` or `'1.x'` — 1.0 and 1.1 are indistinguishable from inside a bundle. */
  format_version: '1.x' | '2.0';
  course_id: string | null;
  collaboration: 'solo' | 'group' | null;
  submission: 'bundle' | 'git' | null;
  scope: 'directory' | 'repo' | null;
  /** Gated signals the course switched off. Empty for 1.x. */
  disabled_signals: CaptureSignal[];
  heartbeat_interval_ms: number;
  cert: BundleManifestCert | null;
  trust_chain: 'legacy' | 'unconfigured' | 'verified' | 'invalid';
  /** Human-readable cause when `trust_chain` is `'invalid'`. */
  trust_chain_detail: string | null;
};

function windowFields(
  window: CertWindowStatus,
): Pick<BundleManifestCert, 'in_window' | 'window_reason'> {
  return window.in_window
    ? { in_window: true, window_reason: null }
    : { in_window: false, window_reason: window.reason };
}

export function describeTrustChainError(error: BundleTrustChainError): string {
  switch (error.kind) {
    case 'not_manifest_2_0':
      return `manifest is format_version ${error.format_version}, not 2.0`;
    case 'missing_course_cert':
      return 'manifest carries no course_cert';
    case 'invalid_manifest_shape':
      return `manifest shape invalid${error.field === undefined ? '' : ` at ${error.field}`}${
        error.reason === undefined ? '' : `: ${error.reason}`
      }`;
    case 'invalid_root_signature':
      return 'course_cert does not verify against the root public key';
    case 'invalid_course_signature':
      return 'manifest payload does not verify against the certified course public key';
    case 'course_id_mismatch':
      return `manifest course_id ${String(error.manifest_course_id)} does not match certificate course_id ${error.cert_course_id}`;
    case 'manifest_sig_mismatch':
      return `session ${error.sessionId} recorded manifest_sig ${error.manifestSig.slice(0, 16)}… but carries a manifest signed ${error.embeddedSig.slice(0, 16)}…`;
    case 'embedded_manifest_invalid':
      return `session ${error.sessionId} carries a malformed manifest (${error.detail})`;
  }
}

/**
 * Summarize a bundle's assignment manifest, verifying the trust chain when a
 * root public key is available.
 */
export async function summarizeBundleManifest(
  bundle: Bundle,
  rootPubkeyHex?: string,
): Promise<BundleManifestSummary> {
  const policy = resolveBundleCapturePolicy(bundle);
  const chain = await verifyBundleTrustChain(bundle, rootPubkeyHex);

  const manifest = chain.kind === 'legacy' ? null : chain.manifest;
  const isV2 = manifest !== null && manifestFormatVersion(manifest) === MANIFEST_FORMAT_VERSION_2;

  let cert: BundleManifestCert | null = null;
  if (chain.kind === 'verified') {
    cert = {
      course_id: chain.chain.cert.course_id,
      course_pubkey: chain.chain.cert.course_pubkey,
      valid_from: chain.chain.cert.valid_from,
      valid_until: chain.chain.cert.valid_until,
      ...windowFields(chain.chain.window),
    };
  } else if (manifest?.course_cert !== undefined) {
    // Unverified (or failed) — still show what the bundle claims, but the
    // window is the only thing we can state without trusting the signature.
    cert = {
      course_id: manifest.course_cert.course_id,
      course_pubkey: manifest.course_cert.course_pubkey,
      valid_from: manifest.course_cert.valid_from,
      valid_until: manifest.course_cert.valid_until,
      in_window: false,
      window_reason: 'unverified',
    };
  }

  return {
    format_version: isV2 ? '2.0' : '1.x',
    course_id: manifest?.course_id ?? null,
    collaboration: manifest?.collaboration ?? null,
    submission: manifest?.submission ?? null,
    scope: manifest?.scope ?? null,
    disabled_signals: policy.disabledSignals,
    heartbeat_interval_ms: policy.effective.heartbeat_interval_ms,
    cert,
    trust_chain: chain.kind,
    trust_chain_detail: chain.kind === 'invalid' ? describeTrustChainError(chain.error) : null,
  };
}
