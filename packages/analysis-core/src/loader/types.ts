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
import type { RollingSealCoverage } from './rolling-coverage.js';
// Type-only, and `identity/types.ts` imports nothing from this directory, so the
// stamp below costs no runtime cycle.
import type { BundleContributors } from '../identity/types.js';

export type { RollingSealCoverage, SealCoverage } from './rolling-coverage.js';

// ---------------------------------------------------------------------------
// Loader errors (unzip / structural)
// ---------------------------------------------------------------------------

export type LoaderError =
  | { kind: 'not_a_zip'; detail?: string }
  | { kind: 'missing_manifest' }
  | { kind: 'invalid_manifest'; detail: string }
  | { kind: 'missing_signature' }
  | { kind: 'no_sessions' }
  // `sessionId` on these two is the `.slog` FILENAME uuid, not a logical
  // session id — the log that would tell us the logical id is the very thing
  // that is missing or unreadable. It is displayed, never matched on. Kept
  // unbranded because the analyzer renders this union directly (`ErrorPanel`).
  // See {@link LogFileId}.
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

declare const LOG_FILE_ID_BRAND: unique symbol;

/**
 * The uuid in a `.slog` FILENAME. **Not** a session id.
 *
 * ## The two id spaces, and why this type exists
 *
 * A bundle carries two independent identifiers per session, and in production
 * they are ALWAYS different values:
 *
 *  - the **log file id** — the uuid in `session-<uuid>.slog`, minted by the
 *    recorder's writer (`session-registry.ts`: `session-${randomUUID()}.slog`).
 *    It names a file and nothing else.
 *  - the **logical session id** — `session.start.data.session_id`, which is
 *    `recorderContext.session_id`. It is what a rolling seal is named after
 *    (`manifest-<session_id>.json`), what the manifest's `sessions[].session_id`
 *    carries, and what `ParsedSession.sessionId` / `Bundle.sessions[].sessionId`
 *    hold everywhere downstream.
 *
 * Crossing them has now produced a maximum-severity false accusation TWICE.
 * Most recently a `Map` keyed by log file id was looked up by a seal's logical
 * id in `parse-bundle.ts`: the miss was silent, every rolling-only bundle came
 * out with EMPTY prefix coverage, and `log_bytes_match` fell back to whole-file
 * equality — failing at high severity / confidence 1.0 on every honest git
 * submission whose last seal was non-final.
 *
 * The brand makes that specific mistake a COMPILE ERROR:
 * `Map<LogFileId, …>.get(someLogicalId)` does not type-check, because a plain
 * `string` is not assignable to `LogFileId`. Fixtures cannot save you here —
 * every fixture in this repo used to spell both ids with the same value, so no
 * test could distinguish confusing them. The type system can.
 *
 * One brand is not enough on its own — a `LogFileId` is still assignable to
 * `string`, so a map keyed by a bare `string` would accept either id. See
 * {@link LogicalSessionId} for the other half, which closes that direction.
 *
 * Both brands are deliberately narrow: they cover `loader/`, the one place the
 * two spaces are in scope at once. Branding every downstream `sessionId` would
 * reach `log-core`'s frozen manifest shape and every read path in `analyzer` and
 * `server`.
 */
export type LogFileId = string & { readonly [LOG_FILE_ID_BRAND]: 'slog-filename-uuid' };

/** Tag a `.slog` filename uuid. The only sanctioned way to mint a {@link LogFileId}. */
export function asLogFileId(raw: string): LogFileId {
  return raw as LogFileId;
}

declare const LOGICAL_SESSION_ID_BRAND: unique symbol;

/**
 * A LOGICAL session id — `session.start.data.session_id`. **Not** a filename.
 *
 * The other half of the pair described on {@link LogFileId}, and the reason that
 * one is not enough on its own. A single brand is one-directional: it stops
 * `Map<LogFileId, …>.get(logicalId)`, but a `LogFileId` is still assignable to
 * `string`, so a map keyed by a bare `string` happily accepts EITHER id. That is
 * the map at the centre of the false accusation, so leaving it unbranded would
 * have left the hazard standing behind a fix that looked total.
 *
 * With both brands the two spaces are mutually unassignable: neither id can be
 * used where the other belongs, in either direction, without a deliberate cast.
 *
 * Scope is still deliberately the loader. `ParsedSession.sessionId` and
 * `Bundle.sessions[].sessionId` stay plain `string`, because branding those
 * reaches `log-core`'s frozen manifest shape and every read path in `analyzer`
 * and `server` — a much larger change than this defect justifies. What is
 * branded is the pair that actually met: the seal's id and the log files.
 */
export type LogicalSessionId = string & {
  readonly [LOGICAL_SESSION_ID_BRAND]: 'session-start-session-id';
};

/**
 * Tag a `session.start.data.session_id`. The only sanctioned way to mint a
 * {@link LogicalSessionId} — deliberately greppable, so every entry into the
 * logical id space is one search away.
 */
export function asLogicalSessionId(raw: string): LogicalSessionId {
  return raw as LogicalSessionId;
}

// ---------------------------------------------------------------------------
// The read-side orphan guard (see `unzip.ts` step 5)
// ---------------------------------------------------------------------------

/**
 * One artifact the loader left out of the analysis because it is not analysable.
 *
 * ## Why this exists — the git path never runs `seal`
 *
 * All three recorders guard the ZIP path: `sealBundle` drops an artifact the
 * analyzer could not open and reports it in the seal warnings. A GIT-NATIVE
 * submission has no seal step at all — the student pushes, the grader clones,
 * and whatever is in `.provenance/` on disk IS the submission. So that guard
 * protects the git path not at all, and the leftovers it exists to catch are
 * exactly the ones a git submission carries: `chain-recovery.ts` quarantines a
 * damaged `.slog` to `.corrupt-<ISO>` and leaves the `.slog.meta` behind, and a
 * session torn down before its first flush leaves a zero-byte `.slog`.
 *
 * Presented to the loader, each of those used to be fatal to THE WHOLE BUNDLE,
 * before a single check ran. One leftover file cost a student every session they
 * had recorded, for something they did not do and could not have prevented.
 *
 * So the loader now applies the same rule the seal path applies, on the read
 * side: **an artifact that cannot be analysed is dropped from the analysis and
 * reported.** Drop from the ANALYSIS only — this module reads, it never writes,
 * so nothing on disk is touched. That matters twice over on the git path: the
 * `.provenance/` directory is the submission itself, and in a shared repo those
 * bytes may be a partner's only evidence.
 *
 * ## Why the loader, and not ingest or the recorder
 *
 * The loader is the one place every path converges — server ingest, the
 * analyzer's in-browser `/local` route, and the `tools/` conformance gates all
 * reach a bundle through `loadBundle`. Normalising in server ingest would fix
 * one of those three. The recorder cannot fix it at all: on the git path there
 * is no seal step to hook, and cleaning `.provenance/` on disk would mean
 * deleting or renaming files that in a shared repo belong to a partner.
 *
 * This is the same argument `loader/rolling-seal.ts` already makes for
 * preferring defects to hard errors, applied one layer down.
 *
 * ## This is NOT an integrity finding
 *
 * A dropped artifact says a recording is INCOMPLETE, not that anything was
 * tampered with — exactly the distinction the recorders' seal warnings draw.
 * Nothing here produces a `Flag`, fails a validation check, or moves
 * `ValidationReport.overall`. It is a fact about the archive, reported so that a
 * silent exclusion never reads as nothing having been wrong.
 */
export type DroppedArtifact = {
  kind: /** A `.slog.meta` whose `.slog` is absent — quarantined away, or deleted. */
    | 'orphaned_meta'
    /** A `.slog` with no `.slog.meta` beside it. */
    | 'orphaned_slog'
    /** A `.slog` of zero bytes — a session that started and never flushed. */
    | 'empty_slog'
    /** A `.slog` quarantined to `.corrupt-<ISO>` by the recorder's chain recovery. */
    | 'quarantined_log'
    /** A `.tmp` leftover from an interrupted atomic write. */
    | 'staging_leftover'
    /** A rolling seal for a session this bundle does not carry. */
    | 'orphaned_rolling_seal';
  /** The entry name exactly as it appeared in the archive. */
  filename: string;
  /**
   * The `.slog` FILENAME uuid, when the artifact is named after one.
   *
   * Absent on artifacts that are not per-session log files. NEVER a logical
   * session id — see {@link LogFileId} and {@link logicalSessionId} below.
   */
  logFileId?: LogFileId;
  /**
   * The LOGICAL session id of the recording this artifact belonged to, when it
   * could be recovered — read out of the `.slog.meta` sidecar's `session_id`,
   * which survives even when the log itself does not.
   *
   * This is what lets a dropped session's rolling seal be dropped with it
   * instead of surfacing as a `no_session_log` defect, which fails check 1 — a
   * finding produced by a crash. (The defect's text no longer asserts deletion
   * or planting, since the evidence cannot distinguish either from a partial
   * push; it is still a finding, and still the wrong one here, because this is
   * the one path where the loader DOES know why the log is absent.) See
   * `parse-bundle.ts`.
   */
  logicalSessionId?: LogicalSessionId;
  /** Staff-facing prose: what was left out, and why that is not a finding. */
  detail: string;
};

export type SessionFiles = {
  /**
   * The uuid in this session's `.slog` FILENAME — NOT its logical session id.
   *
   * Named `logFileId` rather than `sessionId` on purpose: the old name made two
   * different id spaces read identically at the call site, which is how they got
   * crossed. See {@link LogFileId}.
   */
  logFileId: LogFileId;
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
  /**
   * Artifacts the unzipper recognized but could not hand on for analysis, each
   * dropped rather than made fatal. Sorted by filename; usually empty.
   * See {@link DroppedArtifact}.
   */
  droppedArtifacts: readonly DroppedArtifact[];
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
  /**
   * LOGICAL session id from the `manifest-<session_id>.json` filename, which the
   * manifest is proven to agree with.
   *
   * Branded so it cannot be used to key anything in the `.slog`-filename id
   * space — the exact confusion that made this seal's prefix coverage vanish.
   * See {@link LogicalSessionId} and {@link LogFileId}.
   */
  sessionId: LogicalSessionId;
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
    /**
     * Several `.slog` files claim the session this seal names, so which log the
     * seal commits to cannot be established.
     *
     * Reported so the ambiguity is visible; it is NOT an integrity finding on
     * its own. The seal's coverage becomes `indeterminate` rather than falling
     * through to whole-file equality, which is what used to turn a duplicated
     * log into a maximum-severity tamper accusation. See
     * `loader/rolling-coverage.ts` / `resolveAmbiguousCoverage`.
     */
    | 'ambiguous_session_log'
    /** A session's `.slog` is covered by no seal at all. */
    | 'unsealed_session'
    /**
     * Two seals disagree on assignment_id / semester.
     *
     * NOT extension_hash: updating the recorder mid-assignment legitimately
     * varies it. See `synthesizeRollingUnionManifest`.
     */
    | 'divergent_scope';
  detail: string;
};

/** A bundle's rolling seals, as resolved by the loader. */
export type BundleRollingSeal = {
  /** Seals that passed shape + filename-binding validation, session order. */
  seals: RollingSeal[];
  /** Everything wrong with the seals. Check 1 reports all of these. */
  defects: RollingSealDefect[];
  /**
   * Every distinct `extension_hash` any seal reported, sorted and de-duplicated.
   *
   * A student who updates their recorder mid-assignment legitimately produces
   * sessions with different build hashes, so the union manifest's single
   * `extension_hash` scalar cannot represent them all. Keeping the full set here
   * is what lets `heuristics/extension-hash-mismatch.ts` check EVERY build that
   * touched the work against the known-good allowlist — otherwise a student
   * could run one official session and do the rest under a modified recorder,
   * and only the session that happened to sort first would ever be checked.
   */
  observedExtensionHashes: readonly string[];
  /**
   * How much of each session's logs its rolling seal actually covers.
   *
   * Present ONLY when the synthesized union manifest is this bundle's manifest —
   * i.e. when there is no classic `manifest.json`. A rolling seal is rewritten
   * as the session grows, so its digests commit to a PREFIX; a classic seal is
   * taken once over a finished log and commits to the whole file. Leaving this
   * absent for a classic or both-shapes bundle is what keeps whole-file equality
   * (and therefore post-seal append detection) at full strength there.
   *
   * A seal the recorder marked `final` at `dispose()` is the exception: it was
   * signed over a finished log, so its entry here is computed with whole-file
   * semantics (`final: true`) and an append past it fails.
   *
   * See `loader/rolling-coverage.ts` and `validation/verify-log-bytes.ts`.
   */
  coverage?: readonly RollingSealCoverage[];
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
  /**
   * Hex sha256 of this session's `.slog` with git's LF→CRLF widening undone —
   * or `null`, which is the normal case and means the question does not arise.
   *
   * Non-null ONLY when the archived `.slog` actually carries CRLF terminators
   * AND its decoded text re-encodes to {@link ParsedSession.slogSha256}. It is
   * computed once here, on the one code path that still holds the log text, so
   * `verify-log-bytes.ts` can stay a pure comparison that does no hashing.
   *
   * Its whole purpose is to let a byte mismatch be EXPLAINED rather than
   * accused: if this equals the digest the signed manifest commits to, the
   * archived file is provably the sealed file with some LF terminators widened
   * by git and nothing else. See `loader/line-endings.ts` for why that is a
   * proof rather than a tolerance, and for the direction it cannot cover.
   *
   * Like {@link ParsedSession.slogSha256}, only the digest is kept — never a
   * second copy of the normalized text.
   */
  slogSha256Lf: string | null;
  /** Hex sha256 of this session's `.slog.meta` bytes as loaded. */
  metaSha256: string;
  /** Narrowed to session.start — guaranteed to be the first event. */
  firstEvent: HashedEnvelope<'session.start'> & { data: SessionStartPayload };
  /**
   * A TORN FINAL LINE that was truncated away, or `null` — which is the normal
   * case and means the log ended cleanly.
   *
   * ## Why the session is kept rather than dropped
   *
   * This is the read-side orphan guard's missing case, and it is different in
   * kind from the artifacts that guard drops. A stranded `.slog.meta`, a
   * zero-byte `.slog` and a `.corrupt-<ISO>` quarantine all carry NO analysable
   * evidence, so dropping them costs nothing. A `.slog` with a torn tail is a
   * complete, chained, checkpointed recording of real work with forty bad bytes
   * on the end. Dropping it would throw away every event the student recorded —
   * and would do worse than that: check 8 (`submitted_code_match`) resolves the
   * last recorded state of each file by scanning `bundle.sessions`, so removing
   * a session removes the saves that explain the submitted code, and the crash
   * would come back as "code appeared that the log never recorded". That is a
   * STRONGER accusation than the load failure it replaced, which is the exact
   * trap the seal half of the orphan guard was built to avoid one layer up.
   *
   * So the session is kept, truncated to its last complete entry, and the
   * truncation is reported here.
   *
   * ## What must never be derived from the truncation
   *
   * {@link ParsedSession.slogSha256} and {@link ParsedSession.slogSha256Lf} are
   * taken over the FULL archived bytes and are never recomputed from the kept
   * prefix, and `parse-bundle.ts` runs the rolling seal's prefix search over
   * `SessionFiles.slogText`, also the full text. Both are load-bearing. If a
   * digest were taken over the truncated view, appending past a seal and then
   * tearing the last line would convert a FAILING `log_bytes_match` into a
   * PASSING one — a laundering path strictly worse than the bug this field
   * exists to fix. If the coverage search ran over the truncated view, the text
   * would fail to re-encode to the archived digest, `computeSlogCoverage` would
   * answer `unavailable`, and `verify-log-bytes.ts` would fall back to
   * whole-file equality against a prefix commitment — the same false accusation
   * as bugs 5, 10 and 12, fired at the crash victim this fix is for.
   *
   * Never a `Flag`, never a check failure, never a score. A fact about the
   * archive, on the same footing as {@link DroppedArtifact}.
   */
  tornTail: {
    /** 1-indexed line number of the incomplete final line. */
    line: number;
    /** How many characters were discarded. */
    discardedChars: number;
    /** Staff-facing prose: what was left out, and why that is not a finding. */
    detail: string;
  } | null;
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
   * Contributor verdict per session, stamped by `establishBundleContributors`
   * (`identity/resolve-contributors.ts`). Deliberately mutable and deliberately
   * absent from the loader's output, for the same reason as
   * {@link Bundle.capturePolicyTrust}: `loadBundle` does no signature work, so a
   * freshly parsed bundle has no attributions until something holding a root
   * public key resolves them.
   *
   * `undefined` reads as fully `unattributed` through `contributorOf` — the
   * direction that keeps the contributor-gated heuristics firing rather than
   * silently suppressing them.
   */
  contributors?: BundleContributors;
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
  /**
   * Everything the loader left out of this bundle's analysis, and why.
   *
   * Always present, usually empty. Non-empty means the submission is DEGRADED,
   * not that anything is wrong with it: the sessions that are here were analysed
   * in full, and each entry names one artifact that could not be. Nothing here
   * produces a `Flag` or fails a check — see {@link DroppedArtifact}.
   *
   * Consumers must surface it. A dropped artifact that nobody reports is a
   * silent exclusion, which is the one outcome worse than the fatal error this
   * replaced.
   */
  droppedArtifacts: readonly DroppedArtifact[];
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
