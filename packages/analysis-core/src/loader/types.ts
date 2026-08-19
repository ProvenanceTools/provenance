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
  RollingSessionManifest,
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
  /**
   * Hex sha256 of the .slog file's bytes EXACTLY as they sat in the ZIP.
   *
   * Taken before any decoding, so it is directly comparable to the
   * `slog_sha256` the signed manifest commits to. See
   * `validation/verify-log-bytes.ts`.
   */
  slogSha256: string;
  /** Hex sha256 of the .slog.meta file's bytes exactly as they sat in the ZIP. */
  metaSha256: string;
};

/**
 * A raw `manifest-<session_id>.json` / `.sig` pair as the unzipper found it.
 *
 * Either half may be absent — the unzipper reports what is on disk and
 * `loader/rolling-seal.ts` decides what that means. A candidate with both halves
 * `null` is never produced.
 */
export type RawRollingSealFiles = {
  /** Session id taken from the FILENAME, via `parseRollingManifestFilename`. */
  sessionId: string;
  /** Raw text of `manifest-<session_id>.json`, or null if that file is absent. */
  manifestJson: string | null;
  /** Trimmed hex from `manifest-<session_id>.sig`, or null if that file is absent. */
  sigHex: string | null;
};

export type BundleFiles = {
  /**
   * Raw text content of the classic `manifest.json`.
   *
   * `null` only on a rolling-sealed bundle that carries no classic manifest. A
   * bundle with neither a classic manifest nor any rolling manifest is rejected
   * with `missing_manifest`, so this is never null without `rollingSeals` being
   * non-empty.
   */
  manifestJson: string | null;
  /** Raw hex content of the classic `manifest.sig`. `null` iff `manifestJson` is. */
  manifestSigHex: string | null;
  /**
   * Rolling seal files found in the ZIP (program spec §8). Empty on a classic
   * sealed bundle — `parseRollingManifestFilename` does not match
   * `manifest.json`, so a classic bundle can never populate this.
   */
  rollingSeals: RawRollingSealFiles[];
  /** One entry per session pair found in the ZIP. */
  sessions: SessionFiles[];
  /** Raw bytes of each submitted file present in the zip, keyed by manifest path. */
  submissionFiles: Map<string, Uint8Array>;
};

// ---------------------------------------------------------------------------
// Rolling seal (program spec §8, S3) — see loader/rolling-seal.ts
// ---------------------------------------------------------------------------

/**
 * One session's on-disk rolling seal, shape-validated and bound to its filename.
 *
 * `manifest` has already passed `validateRollingSessionManifest`, so it covers
 * exactly one session whose `session_id` equals `sessionId`.
 */
export type RollingSeal = {
  /** Session id from the filename, which the manifest is proven to agree with. */
  sessionId: string;
  /** Raw text of the `.json` file, kept verbatim; never rewritten. */
  manifestJson: string;
  manifest: RollingSessionManifest;
  /**
   * Hex signature from `manifest-<session_id>.sig`, or `null` when that file is
   * absent. A null signature is always accompanied by a `missing_sig` defect and
   * makes check 1 fail: an unsigned manifest is not a seal.
   */
  sigHex: string | null;
};

/**
 * Something wrong with a bundle's rolling seals.
 *
 * Defects do NOT fail the load — they are evidence, and the channel for evidence
 * is the validation report. Check 1 (`manifest_sig`) reports every one of them.
 * See the module docstring of `loader/rolling-seal.ts` for why.
 */
export type RollingSealDefect = {
  /** The session named by the offending FILENAME. */
  sessionId: string;
  kind: /** `.json` present, `.sig` absent — the manifest is unsigned. */
    | 'missing_sig'
    /** `.sig` present, `.json` absent — the sealed manifest was removed. */
    | 'missing_manifest'
    /** `.json` is not parseable JSON. */
    | 'invalid_json'
    /** `.json` fails `validateBundleManifestShape`. */
    | 'invalid_shape'
    /** `.json` is not a 1.2 single-session manifest. */
    | 'not_rolling'
    /** `.json` covers a different session than its filename names. */
    | 'session_id_mismatch'
    /** A seal names a session with no `.slog` in the bundle. */
    | 'no_session_log'
    /** A session's `.slog` is covered by no seal at all. */
    | 'unsealed_session'
    /** Two seals disagree on assignment_id / semester / extension_hash. */
    | 'divergent_scope';
  detail: string;
};

/** A bundle's rolling seals, as resolved by the loader. */
export type BundleRollingSeal = {
  /** Seals that passed shape + filename-binding validation, session order. */
  seals: RollingSeal[];
  /** Everything wrong with the seals. Check 1 reports all of these. */
  defects: RollingSealDefect[];
};

// ---------------------------------------------------------------------------
// ParsedSession — result of parse-session.ts
// ---------------------------------------------------------------------------

export type ParsedSession = {
  sessionId: string;
  events: readonly HashedEnvelope[];
  meta: SlogMeta;
  /**
   * Hex sha256 of this session's `.slog` bytes as loaded, carried through from
   * {@link SessionFiles} so validation can compare it against the signed
   * manifest's commitment without re-reading the ZIP.
   *
   * Only the 64-char digest is retained, never the raw bytes: the server holds
   * parsed bundles in an LRU cache, and keeping a second full copy of every log
   * would roughly double that cache's footprint for no analytical gain.
   */
  slogSha256: string;
  /** Hex sha256 of this session's `.slog.meta` bytes as loaded. */
  metaSha256: string;
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
  /**
   * The bundle's manifest.
   *
   * On a classic sealed bundle this is `manifest.json`, unchanged. On a
   * rolling-sealed bundle (program spec §8) there is no `manifest.json`, and this
   * is the SYNTHESIZED union at `format_version: '1.2'` spanning every
   * per-session rolling manifest found — see `loader/rolling-seal.ts`. On a bundle
   * carrying both, the classic manifest wins and the rolling seals are still
   * verified alongside it.
   */
  manifest: BundleManifest;
  /**
   * Hex-encoded ed25519 signature over canonical manifest JSON.
   *
   * `null` on a rolling-sealed bundle with no classic `manifest.sig`: there is no
   * single bundle-wide signature there, because each session's manifest is signed
   * by that session's own key. Those live in {@link Bundle.rollingSeal}.
   */
  manifestSigHex: string | null;
  /**
   * Present iff the bundle carried at least one `manifest-<session_id>.json`.
   *
   * `undefined` on a classic sealed bundle, which is what keeps the classic path
   * byte-for-byte identical: every consumer that does not know about the rolling
   * seal simply never sees it.
   */
  rollingSeal?: BundleRollingSeal;
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
