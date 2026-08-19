/**
 * Types for the bundle loader (Phase 1).
 *
 * PRD §5.1, §5.3, §4.6.
 *
 * Naming note: log-core's ndjson.ts also exports a `ParseError` type (for
 * line-level JSON parse failures). The type exported here is the *loader-level*
 * parse error union and is intentionally named `SessionParseError` to avoid
 * shadowing the log-core import in parse-session.ts.
 */

import type {
  HashedEnvelope,
  SlogMeta,
  BundleManifest,
  SessionStartPayload,
} from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Loader errors (unzip / structural)
// ---------------------------------------------------------------------------

export type LoaderError =
  | { kind: 'not_a_zip'; detail?: string }
  | { kind: 'missing_manifest' }
  | { kind: 'invalid_manifest'; detail: string }
  | { kind: 'missing_signature' }
  | { kind: 'no_sessions' }
  | { kind: 'orphaned_meta'; sessionId: string }
  | { kind: 'orphaned_slog'; sessionId: string }
  | { kind: 'unexpected_file'; filename: string; detail?: string }
  | { kind: 'unknown_failure'; detail: string };

// ---------------------------------------------------------------------------
// Session parse errors
// ---------------------------------------------------------------------------

export type SessionParseError =
  | { kind: 'ndjson_parse_failed'; line: number; detail: string }
  | { kind: 'meta_invalid_shape'; detail: string }
  | { kind: 'first_event_not_session_start'; actualKind: string }
  | { kind: 'session_id_mismatch'; slogSessionId: string; metaSessionId: string };

// ---------------------------------------------------------------------------
// BundleFiles — raw unzipped content
// ---------------------------------------------------------------------------

export type SessionFiles = {
  /** Session UUID extracted from the filename (e.g. `session-<uuid>.slog`). */
  sessionId: string;
  /** Raw NDJSON text of the .slog file. */
  slogText: string;
  /** Raw JSON text of the .slog.meta file. */
  metaJson: string;
};

export type BundleFiles = {
  /** Raw text content of manifest.json. */
  manifestJson: string;
  /** Raw hex content of manifest.sig. */
  manifestSigHex: string;
  /** One entry per session pair found in the ZIP. */
  sessions: SessionFiles[];
  /** Raw bytes of each submitted file present in the zip, keyed by manifest path. */
  submissionFiles: Map<string, Uint8Array>;
};

// ---------------------------------------------------------------------------
// ParsedSession — result of parse-session.ts
// ---------------------------------------------------------------------------

export type ParsedSession = {
  sessionId: string;
  events: readonly HashedEnvelope[];
  meta: SlogMeta;
  /** Narrowed to session.start — guaranteed to be the first event. */
  firstEvent: HashedEnvelope<'session.start'> & { data: SessionStartPayload };
};

// ---------------------------------------------------------------------------
// Bundle — fully loaded, sorted, validated
// ---------------------------------------------------------------------------

/**
 * Whether this bundle's Manifest 2.0 trust chain has actually been verified.
 *
 * The one input `resolveBundleCapturePolicy` consults before honouring a
 * course-signed capture policy. It lives on the Bundle — rather than being
 * threaded through `Heuristic.run` — because signature verification is async
 * and `isSignalCaptured` must stay pure, synchronous and cheap enough for a
 * heuristic to call inline. See `manifest/bundle-manifest.ts`.
 *
 * `undefined` means nobody has verified this bundle yet and is treated exactly
 * like `'unverified'`: an unverified policy is not a policy.
 */
export type CapturePolicyTrust = 'verified' | 'unverified';

export type Bundle = {
  /**
   * Stable per-bundle identifier. Computed at load time via crypto.randomUUID()
   * (WebCrypto, available in browsers and jsdom). Used as a map key in
   * BundleContext's per-bundle maps (indicesByBundle, etc.).
   */
  id: string;
  /**
   * Trust-chain verdict, stamped by `establishBundleTrust` (which check 2 and
   * the server's `loadSubmissionIndex` both call). Deliberately mutable and
   * deliberately absent from the loader's output: `loadBundle` performs no
   * signature work, so a freshly parsed bundle is untrusted until something
   * with a root public key says otherwise.
   */
  capturePolicyTrust?: CapturePolicyTrust;
  manifest: BundleManifest;
  /** Hex-encoded ed25519 signature over canonical manifest JSON. */
  manifestSigHex: string;
  /** Sessions sorted oldest → newest by firstEvent.wall. */
  sessions: ParsedSession[];
  /** Original filename of the ZIP that was loaded. */
  sourceFilename: string;
  /** ISO timestamp of when loadBundle() was called; used for export headers. */
  loadedAt: string;
  /**
   * Submitted files from the bundle (1.1+). Keyed by manifest path. `bytes` is
   * present only for status 'present' files whose zip entry verified against the
   * manifest sha256. `hashOk` records whether the bundle self-check passed.
   */
  submissionFiles: Map<
    string,
    { status: 'present' | 'missing'; sha256: string | null; bytes?: Uint8Array; hashOk: boolean }
  >;
};
