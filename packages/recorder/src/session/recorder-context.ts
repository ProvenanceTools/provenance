/**
 * Gathers PRD §5.1 session.start payload fields, plus the program spec §5
 * `session.start` 2.0 additions (`manifest`, `host`).
 * Pure(ish) function — dependencies are injected for testability.
 * CLAUDE.md: "test the event-to-log-entry transformation as a pure function,
 * separately from the VS Code wiring."
 */

import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { buildFileScope, isExactEntry } from '@provenance/log-core';
import type {
  GitCaptureCapability,
  Manifest,
  SessionFileScope,
  SessionIdentity,
  SessionStartPayload,
  WitnessCaptureCapability,
} from '@provenance/log-core';

/**
 * The cap on {@link SessionFileScope.watched}, in entries.
 *
 * Today's resolver is the manifest's own `files_under_review`, a hand-authored
 * course list of a handful of files, so this never bites. It exists because the
 * field's whole value is that a consumer can read a path's ABSENCE from the
 * list as "not watched", and an unbounded list inside a single hash-chained
 * entry is not something a future `scope: 'repo'` resolver should be able to
 * produce by accident. When the cap bites the recorder emits `complete: false`,
 * and every reader then downgrades absence to _unknown_ rather than to _not
 * watched_.
 *
 * Part of the writer contract: the three recorders must cap at the same number,
 * or two ports disagree about when `complete` goes false.
 */
export const FILE_SCOPE_MAX_ENTRIES = 4096;

/**
 * Resolve the EFFECTIVE FILE SET this session will watch — collaboration spec
 * §5.6 item 1, S25.
 *
 * ## Why the list and not the rule
 *
 * S25's problem is that "no events for this file" is ambiguous between _nothing
 * happened_ and _it was never watched_. Only the resolved LIST answers that: a
 * count cannot be asked whether it contains `Solver.java`, and publishing the
 * unresolved glob set instead would require three hand-written recorder ports
 * and one analyzer to agree on a matcher — the divergence risk S25 itself names
 * and parent spec §10 exists to prevent. Publishing the RESULT keeps exactly one
 * matcher, wherever it eventually lives.
 *
 * ## Why this is not merely a copy of the manifest
 *
 * Today the recorder's resolver is the identity function: `files_under_review`
 * is an exact-string list, `ExpectedContentRegistry` does `new Set(...)` and
 * `fs-watcher.ts` builds one `RelativePattern` per entry, so the effective set
 * IS the declared set. So for a 2.0 session — whose payload already carries the
 * full signed manifest — this field is currently byte-equal to something the
 * analyzer already has.
 *
 * It is still the right field, for three reasons. It is a DIFFERENT assertion:
 * the manifest is the course's declaration of what should be watched, this is
 * the recorder's report of what it actually watched, and the whole §5.6 rule is
 * that the recorder must say what it did rather than let a reader infer it. It
 * is the only form available to a 1.x session, whose payload carries no
 * manifest. And it is what makes the still-open `scope: 'repo'` format decision
 * (collaboration spec §8.7) a change to ONE resolver rather than a change to the
 * format and all three ports — the field, the readers and the vectors are
 * already in place.
 *
 * ## Privacy
 *
 * Entries travel VERBATIM and are never made absolute. `files_under_review` is
 * assignment-root-relative by construction (`fs-watcher.ts` feeds each entry to
 * `new RelativePattern(assignmentRoot, entry)`), which is the same category of
 * path `doc.open.path` already carries, so this introduces no new identifier.
 * `buildFileScope` rejects an absolute path, a colon (every remote-URL spelling)
 * and any `..` segment; a course that put one in its manifest gets the field
 * OMITTED rather than an absolute path in a signed log — S14(b).
 *
 * ## Rules make the list partial, not wrong
 *
 * A manifest may now name a folder or a suffix (design spec §3). Those entries
 * cannot be enumerated at session start — that is the whole point of naming one
 * — so `watched` carries the exact-path entries only and `complete` goes false.
 * The analyzer then has two better answers available before it falls back to
 * `unknown`: it can evaluate the rules itself against the signed manifest in
 * `session.start` (§5.1 tier 1), and any file with recorded activity was
 * self-evidently watched.
 */
export function resolveFileScope(
  filesUnderReview: readonly string[],
): SessionFileScope | undefined {
  // A rule entry cannot be enumerated, so it cannot go in `watched` — and its
  // presence means absence from `watched` no longer proves "not watched".
  // `complete: false` is precisely the downgrade-to-unknown this field already
  // defines for the truncation case; rules reuse it unchanged.
  const exact = filesUnderReview.filter(isExactEntry);
  const hasRules = exact.length !== filesUnderReview.length;
  const complete = !hasRules && exact.length <= FILE_SCOPE_MAX_ENTRIES;
  const watched =
    exact.length <= FILE_SCOPE_MAX_ENTRIES ? exact : exact.slice(0, FILE_SCOPE_MAX_ENTRIES);
  return buildFileScope(watched, complete);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The full data needed to build a session.start payload.
 * All fields from PRD §5.1, with Phase 3 placeholder values where noted.
 */
export type RecorderContext = SessionStartPayload;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a machine_id as sha256Hex(hostname + ':' + username + ':' + sessionId).
 * Using the sessionId as a per-session salt prevents cross-assignment correlation
 * (per implementation-plan §0.4 decision: sha256(hostname + username + session_salt)).
 */
function computeMachineId(sessionId: string): string {
  const hostname = os.hostname();
  // os.userInfo() can throw on some platforms; fall back to process.env.USER.
  let username: string;
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown';
  }
  const input = `${hostname}:${username}:${sessionId}`;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a RecorderContext (= SessionStartPayload) from injected dependencies.
 *
 * @param manifest          The verified `.provenance-manifest`/`provenance-manifest` file.
 *                          MUST already have passed activation/manifest-loader.ts — it is
 *                          emitted verbatim into `session.start` (program spec §5), so an
 *                          unverified manifest here would put an unverified trust chain
 *                          into a signed log.
 * @param prevSessionId     The previous session's id if continuing after a crash, else null.
 * @param extension         The recorder's own VS Code Extension object (for version/id).
 * @param vscodeVersion     vscode.version string injected for testability.
 * @param platform          Platform string, e.g. "darwin-arm64". Callers should supply
 *                          `process.platform + '-' + process.arch`.
 * @param sessionPubkeyHex  Hex-encoded ed25519 public key for this session (Phase 9+).
 *                          Pass '' for pre-Phase-9 sessions or tests that don't need a real key.
 * @param identity          The S2 identity block, when the student holds a verifying
 *                          enrollment for this manifest's course. MUST come from
 *                          `identity/session-identity.ts`, which has already walked it
 *                          against the manifest's root-verified `course_cert`. Omitted
 *                          entirely when absent — see the note at the emission site.
 */
export function buildRecorderContext(args: {
  manifest: Manifest;
  prevSessionId: string | null;
  extension: vscode.Extension<unknown>;
  vscodeVersion: string;
  platform: string;
  sessionPubkeyHex?: string;
  identity?: SessionIdentity;
  /**
   * §5.6 item 2 — whether git observation was available. `undefined` OMITS the
   * field, which is the blameless answer whenever the probe could not establish
   * one. See `wiring/git-wiring.ts`'s `probeGitCapture`.
   */
  gitCapture?: GitCaptureCapability;
  /**
   * §5.6 item 3 — whether `.provenance/` witnessing was available. `undefined`
   * OMITS the field.
   */
  witnessCapture?: WitnessCaptureCapability;
}): RecorderContext {
  const {
    manifest,
    prevSessionId,
    extension,
    vscodeVersion,
    platform,
    sessionPubkeyHex,
    identity,
    gitCapture,
    witnessCapture,
  } = args;

  // §5.6 item 1. `undefined` when the resolved set carries something the format
  // forbids — OMIT rather than publish it.
  const fileScope = resolveFileScope(manifest.files_under_review);

  const sessionId = crypto.randomUUID();
  const machineId = computeMachineId(sessionId);

  // extension.packageJSON is typed as `any` in @types/vscode — this is the expected
  // FFI boundary for reading package metadata.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pkg = extension.packageJSON as Record<string, any>;
  const recorderVersion: string =
    typeof pkg['version'] === 'string' ? (pkg['version'] as string) : '0.0.0';
  const recorderExtensionId: string =
    typeof pkg['publisher'] === 'string' && typeof pkg['name'] === 'string'
      ? `${pkg['publisher'] as string}.${pkg['name'] as string}`
      : extension.id;

  return {
    format_version: '1.0',
    session_id: sessionId,
    prev_session_id: prevSessionId,
    assignment: {
      id: manifest.assignment_id,
      semester: manifest.semester,
    },
    manifest_sig: manifest.sig,
    machine_id: machineId,
    // The FULL manifest — signed payload + sig + course_cert (program spec §5).
    // This is what turns validation check 2 into a real check: today
    // verify-session-binding.ts can only compare manifest_sig across sessions for
    // equality, because the signed payload never enters the bundle. Carrying the
    // whole manifest lets the analyzer walk root -> course -> manifest -> session
    // entirely offline, trusting nothing from the server, and it is also how the
    // certificate's validity window reaches the analyzer: an expired cert does not
    // stop the recorder (spec §4), so `course_cert` + `issued_at` travelling here
    // are what let the analyzer re-run checkCertWindow and decide for itself.
    //
    // Emitted for 1.x manifests too. It is additive, and a 1.x manifest's parsed
    // form carries no 2.0-only fields, so nothing unsigned can ride along.
    manifest,
    // `host` replaces the VS Code-shaped `vscode` block (program spec §5). `vscode`
    // is retained below, populated, so 1.x readers keep working through the
    // reader-before-writer migration; a later change drops it.
    host: {
      editor: 'vscode',
      editor_version: vscodeVersion,
      // '' is permitted and expected here: the VS Code public extension API exposes
      // no build/commit identifier. Analyzers must accept the empty string.
      editor_build: '',
      platform,
    },
    // `identity` (program spec §5, §5a) — the enrollment token, its course-signed
    // `enrollment_cert`, and the student per-course key's signature over
    // `session_pubkey`.
    //
    // The key is spread rather than assigned: when the student is not enrolled the
    // field must be ABSENT, not `undefined`. `session.start` is hash-chained through
    // JCS, which omits undefined-valued keys — so the two forms would in fact hash
    // identically today, but relying on that would make the payload's shape depend
    // on a canonicalizer detail. The three ports each have to reproduce this
    // exactly, so the payload says what it means.
    //
    // Absence is the ordinary, expected state and never blocks recording: a student
    // who has not enrolled yet, whose keyring is unavailable, or whose course let a
    // cert lapse still produces a fully chain-verifiable bundle. Anything that
    // fails to verify is dropped upstream in `identity/session-identity.ts` rather
    // than written, because a broken claim inside a signed chain is permanent.
    ...(identity !== undefined ? { identity } : {}),
    // The three CAPABILITY REPORTS (collaboration spec §5.6). Each key is
    // SPREAD, never assigned, because the format pins OMISSION for the unknown
    // case: an absent key and a `null` value canonicalize differently and
    // therefore chain to different hashes, exactly as `parents: []` and an
    // absent `parents` do. Emitting `null` here would make this recorder's
    // entries hash differently from every other recorder's for the same
    // session, which is the one thing the shared vectors exist to prevent.
    //
    // Absence is a legal, permanent, blameless answer: a reader treats it as
    // "this recorder does not report", which is what every bundle recorded
    // before §5.6 landed says.
    ...(gitCapture !== undefined ? { git_capture: gitCapture } : {}),
    ...(witnessCapture !== undefined ? { witness_capture: witnessCapture } : {}),
    ...(fileScope !== undefined ? { file_scope: fileScope } : {}),
    vscode: {
      version: vscodeVersion,
      // vscode.version is the only publicly available version string in the extension API.
      // The commit hash is not exposed via the public API; we leave it as an empty string
      // in Phase 3. Phase 9 or a future phase can populate this via vscode.env if available.
      commit: '',
      platform,
    },
    recorder: {
      version: recorderVersion,
      extension_id: recorderExtensionId,
      // extension_hash: Phase 10 territory — computed over dist/ at bundle-seal time.
    },
    // Phase 9: populated from a real per-session ed25519 keypair via generateSessionKeypair().
    // Empty string only for pre-Phase-9 callers or tests that don't need a real key.
    session_pubkey: sessionPubkeyHex ?? '',
  };
}
