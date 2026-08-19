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
import type { Manifest, SessionIdentity, SessionStartPayload } from '@provenance/log-core';

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
}): RecorderContext {
  const {
    manifest,
    prevSessionId,
    extension,
    vscodeVersion,
    platform,
    sessionPubkeyHex,
    identity,
  } = args;

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
