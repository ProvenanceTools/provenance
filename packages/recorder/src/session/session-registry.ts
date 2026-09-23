/**
 * session-registry.ts — per-assignment-root session lifecycle.
 *
 * startSession() is the direct extraction of what used to be the single-session
 * body of extension.ts's activateImpl(): the manifest is already verified by the
 * caller (activation/manifest-loader.ts, and eventually manifest-discovery.ts);
 * this function owns everything from "create .provenance/" through "register this
 * session's own wiring" and returns an ActiveSession whose dispose() tears down
 * exactly this one session.
 *
 * PRD §4.1: manifest is already verified before this is called.
 * PRD §5.1: emits session.start with full context; session.end on dispose().
 * PRD §4.2: session.heartbeat every 30s; clock.skew on wall-clock drift.
 * PRD §4.7: buffered, async I/O via SessionWriter.
 */

import * as vscode from 'vscode';
import * as fsPromises from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  generateSessionKeypair,
  encryptSessionPrivkey,
  signCheckpoint,
  scopeFromManifest,
} from '@provenance/log-core';
import type {
  HashedEnvelope,
  Clock,
  GitCaptureCapability,
  Manifest,
  SessionIdentity,
  WitnessCaptureCapability,
} from '@provenance/log-core';
import { buildRecorderContext } from './recorder-context.js';
import { buildSessionIdentity } from '../identity/session-identity.js';
import type { IdentityOutcome } from '../identity/session-identity.js';
import { ROOT_PUBLIC_KEY_HEX } from '../activation/course-keys.js';
import type { SecretStore } from '../identity/secret-store.js';
import { createSessionHost } from './session-host.js';
import { SessionWriter } from '../io/session-writer.js';
import { MetaWriter } from '../io/meta-writer.js';
import { writeRollingSeal } from '../io/rolling-seal-writer.js';
import { ensureProvenanceGitAttributes } from '../io/git-attributes-writer.js';
import { startHeartbeat } from '../events/heartbeat.js';
import { startClockWatcher } from '../events/clock-watcher.js';
import { startDocWiring } from '../wiring/doc-wiring.js';
import {
  createPasteInterceptRegistrar,
  startPasteIntercept,
} from '../wiring/paste-command-intercept.js';
import { startPasteReconciler } from '../events/paste-reconciler.js';
import { startFsWatcher } from '../wiring/fs-watcher.js';
import { ExplanationTagger } from '../events/explanation-tags.js';
import { ExpectedContentRegistry } from '../state/expected-content-registry.js';
import { startTerminalWiring } from '../wiring/terminal-wiring.js';
import { startExtensionSnapshot } from '../wiring/extension-snapshot.js';
import { startExtensionActivation } from '../wiring/extension-activation.js';
import { probeGitCapture, startGitWiring } from '../wiring/git-wiring.js';
import { startPeerWatcher } from '../wiring/peer-watcher.js';
import type { PeerWatcher, ProvenanceDirWatcher } from '../wiring/peer-watcher.js';
import { recoverPreviousSession } from '../startup/chain-recovery.js';
import { computeExtensionHash } from '../commands/extension-hash.js';
import { DiskFullHandler } from '../failure/disk-full-handler.js';
import { makeAssignmentRelativePath } from './assignment-relative-path.js';
import { resolveOwnerRoot } from './session-router.js';
import {
  resolveVerifiedCapturePolicy,
  resolveVerifiedEnrollmentPolicy,
} from '../activation/manifest-loader.js';
import type { LargeInsertCounter } from '../wiring/doc-wiring.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * VS Code-specific subscriptions needed by the heartbeat.
 * Extracted so tests can stub them without touching the real vscode API.
 */
export type HeartbeatVscodeDeps = {
  windowState: { focused: boolean };
  activeTextEditor: () => string | null;
  onDidChangeFocus: (handler: () => void) => vscode.Disposable;
  onDidChangeActiveTextEditor: (handler: () => void) => vscode.Disposable;
  onDidChangeTextDocument: (handler: () => void) => vscode.Disposable;
};

/**
 * Rotate a session once its `.slog` passes this size (PRD §4.6).
 *
 * `submission: 'git'` assignments commit `.provenance/` to a GitHub repo, and
 * GitHub warns at 50 MB and REFUSES a push containing a file over 100 MB. A
 * session now lives for the editor's lifetime, so an unrotated log can grow
 * past that and leave the student unable to submit. 40 MiB keeps a whole
 * 256 KB flush plus a few 64 KB payloads clear of the warning.
 */
export const ROTATE_AT_BYTES = 40 * 1024 * 1024;

/**
 * Once {@link ROTATE_AT_BYTES} is crossed, wait for this much quiet — no
 * {@link ROTATE_QUIET_KINDS} event recorded — before rotating (design §3.3
 * mechanism 1).
 *
 * The seam between a rotated pair is NOT free. `inter_session_external_change`
 * compares a reconstruction of the predecessor's event stream against the
 * successor's first `doc.open` content, which is a LIVE BUFFER read, by exact
 * string equality. Content lost inside the teardown window is therefore in the
 * successor's baseline and missing from the predecessor's reconstruction, and the
 * heuristic reports at 0.85 confidence that the student edited the file outside the
 * recorder. Rotating only while nothing is mutating content makes "the file did not
 * change during teardown" a property of WHEN we rotate rather than a hope about how
 * fast teardown is.
 */
export const ROTATE_IDLE_QUIET_MS = 2000;

/**
 * The event kinds that reset the idle window: every kind that MUTATES file content
 * (design §3.3 — "content-mutating means `doc.change`, `paste` and
 * `fs.external_change`, not `doc.change` alone").
 *
 * `doc.change` alone is not enough, and the gap is not theoretical:
 *
 * - An inlineable single-shot paste is emitted as kind `paste`, not `doc.change`
 *   (`wiring/doc-wiring.ts`), so a gate on typing alone opens while the student is
 *   reading a web page, fires the rotation, and then loses their Cmd+V inside the
 *   teardown window. A paste is large, so the resulting false flag likely clears
 *   `highSeverityCharsChanged` and is reported at HIGH severity.
 * - `fs.external_change` is a formatter-on-save or a `git checkout`: a whole-file
 *   rewrite, i.e. the same false flag in its worst form.
 *
 * Only these three change bytes in a file. Heartbeats, focus and selection changes,
 * saves, terminal and git events do not, so they must not hold a rotation off —
 * a session that only saves and heartbeats is idle for this purpose.
 */
export const ROTATE_QUIET_KINDS: ReadonlySet<string> = new Set([
  'doc.change',
  'paste',
  'fs.external_change',
]);

/**
 * Rotate even without a quiet window once the log reaches this size (design §3.3).
 *
 * A session that never idles must not grow without limit: past GitHub's 100 MB
 * hard limit the student cannot push at all, and an unpushable repo is worse than
 * a flag.
 *
 * This is the only path on which a rotation can lose a KEYSTROKE — and that is the
 * whole of the claim. It is NOT the only way the seam can diverge:
 *
 * - The quiet gate makes the KEYBOARD safe. It cannot make an EXTERNAL WRITER safe,
 *   because a formatter daemon, a build tool or a partner's `git pull` is not
 *   synchronised to the student's pause. An external write landing inside ANY
 *   teardown window still diverges the seam, and because it is a whole-file rewrite
 *   it lands at HIGH severity.
 * - The window is not microseconds. After `sealing` is set it still contains the
 *   final flush, the checkpoint drain and the rolling seal's walk-and-hash over the
 *   whole 40 MiB log, then the successor's keygen, identity, git probe and catch-up:
 *   order 0.3–1 s. Skipping chain recovery
 *   (see {@link StartSessionDeps.skipChainRecovery}) removed the seconds-long term,
 *   not the window.
 * - And the gate CONCENTRATES rotations into the moments the student is idle, which
 *   is precisely when background repository activity is most likely.
 */
export const ROTATE_HARD_CEILING_BYTES = 48 * 1024 * 1024;

export type ActiveSession = {
  assignmentRoot: string;
  /**
   * This session's LOGICAL `session_id` — the one in `session.start`, which is
   * also what a successor's `prev_session_id` names. NOT the uuid in the `.slog`
   * filename: the two are deliberately different (see `recorder-context.ts`).
   */
  sessionId: string;
  manifest: Manifest;
  provenanceDir: string;
  slogPath: string;
  writer: SessionWriter;
  metaWriter: MetaWriter;
  sessionHost: ReturnType<typeof createSessionHost>;
  sessionKeypair: { privateKey: Uint8Array; publicKeyHex: string };
  /**
   * This session's expected-content registry. `seal` reads
   * `expectedContentRegistry.capHit()` to populate `SealDeps.scopeCapped` — the
   * registry, not the seal command, is what knows whether its cap ever refused
   * an in-scope path this session.
   */
  expectedContentRegistry: ExpectedContentRegistry;
  /**
   * Whether this session could claim an identity, and if not, why.
   *
   * `undefined` means identity was never attempted (no `secrets` supplied) — NOT
   * that the student is un-enrolled. `activation/enroll-nudge.ts` consumes this
   * to decide the status bar wording and whether to offer the enrollment page.
   */
  identityOutcome: IdentityOutcome | undefined;
  /**
   * Does this root's course require its students to enrol?
   *
   * Resolved once here from the ALREADY-VERIFIED manifest, for the same reason
   * `capturePolicy` is: nothing downstream may re-parse or re-verify a manifest.
   * `activation/enroll-nudge.ts` reads it alongside `identityOutcome` so a course
   * that waived enrollment cannot speak for one that did not — the status bar is
   * a single global item across every open root.
   *
   * Always `true` for a 1.x manifest, whose `policy` block is unsigned.
   */
  enrollmentRequired: boolean;
  /** All VS Code subscriptions this session owns (doc-wiring, fs-watcher, heartbeat, etc). Disposed by dispose(). */
  ownDisposables: vscode.Disposable[];
  /** Most recent checkpoint write chain. dispose() awaits this so the final checkpoint isn't lost. */
  getPendingCheckpoint: () => Promise<void>;
  /**
   * Emits session.end, flushes the writer, drains the pending checkpoint, disposes
   * metaWriter + ownDisposables, in that order.
   *
   * `reason` is the `session.end` reason and defaults to `'deactivate'`. Size
   * rotation (PRD §4.6) passes `'rotate'`; everything else takes the default.
   */
  dispose: (reason?: string) => Promise<void>;
};

export type StartSessionDeps = {
  assignmentRoot: string;
  manifest: Manifest;
  extension: vscode.Extension<unknown>;
  vscodeVersion: string;
  platform: string;
  clock: Clock;
  provenanceDirOverride?: string;
  /**
   * Force this session's `prev_session_id`, bypassing chain recovery.
   *
   * Recovery only links a DANGLING previous session (a crash). A rotation ends
   * the previous session CLEANLY, so recovery reports `previous_session_complete`
   * and would link nothing — the successor would look like an unrelated session.
   * The rotation caller therefore passes the ended session's id here.
   */
  prevSessionIdOverride?: string;
  /**
   * Skip chain recovery entirely (design §3.3 mechanism 2).
   *
   * Set only by rotation, which already knows its predecessor's id. Recovery
   * would read, parse and `validateChain` the whole 40 MiB predecessor log —
   * ~150k entries of JCS canonicalization and SHA-256 — while NO wiring is
   * attached, making it by far the largest term in the teardown window. Every
   * millisecond spent there is a millisecond in which a keystroke can be lost,
   * and a lost keystroke accuses the student (see {@link ROTATE_IDLE_QUIET_MS}).
   *
   * Skipping is safe here and ONLY here: the two things recovery produces are a
   * `prev_session_id` (which {@link prevSessionIdOverride} supplies directly) and
   * the quarantine of a corrupt log (which cannot apply — the predecessor was
   * just written and sealed by this same process).
   */
  skipChainRecovery?: boolean;
  /** Production default {@link ROTATE_AT_BYTES}; tests pass a tiny value. */
  rotateAtBytesOverride?: number;
  /** Production default {@link ROTATE_IDLE_QUIET_MS}; tests pass a tiny value. */
  rotateIdleQuietMsOverride?: number;
  /** Production default {@link ROTATE_HARD_CEILING_BYTES}; tests pass a tiny value. */
  rotateHardCeilingBytesOverride?: number;
  /**
   * The chain-recovery seam. Defaults to the real `recoverPreviousSession`.
   *
   * Exists so a test can prove BY CONSTRUCTION that a rotated session runs no
   * recovery (design §5 item 6) — the injected function fails the test if it is
   * called at all. Nothing in production overrides it.
   */
  recoverPreviousSession?: typeof recoverPreviousSession;
  /**
   * Called (at most once) when this session's log should be rotated: the size
   * threshold has been crossed AND the session has been quiet for
   * {@link ROTATE_IDLE_QUIET_MS}, or the hard ceiling has been reached. The
   * session does NOT rotate itself: it owns neither the registry nor its own
   * deps. `extension.ts` supplies this and performs the swap.
   */
  requestRotation?: (endedSessionId: string) => void;
  heartbeatDeps?: HeartbeatVscodeDeps;
  extensionDistPath?: string;
  /**
   * Ownership filter for this session's wiring (Tasks 6-8). Defaults to "always
   * owned" (`() => true`) so single-session callers (and this task's own tests)
   * need not supply it.
   */
  isOwnedByThisRoot?: (fsPath: string) => boolean;
  /**
   * Ownership filter for a git REPOSITORY ROOT, used only by the git wiring.
   *
   * Separate from {@link isOwnedByThisRoot} because the two questions are not the
   * same one: a file is owned by the assignment root that CONTAINS it, whereas a
   * repository root normally CONTAINS the assignment root. Reusing the file
   * predicate here dropped every `git.event` on nested-assignment layouts (spec
   * §3 S14(a)). Callers pass `isRepoOwnedByRoot` from `session-router.ts`.
   *
   * Defaults to {@link isOwnedByThisRoot} so existing callers and tests that only
   * supply the file predicate keep their current behaviour.
   */
  isRepoOwnedByThisRoot?: (repoRootFsPath: string) => boolean;
  /**
   * Mount a status bar item for THIS session. Defaults to a no-op — extension.ts
   * mounts one global status bar, not one per session (plan decision 5).
   */
  createStatusBar?: (disposables: vscode.Disposable[]) => vscode.StatusBarItem;
  /**
   * `ExtensionContext.secrets`, holding the student master secret and their
   * per-course enrollment tokens (program spec §5a). Omitted means no `identity`
   * is emitted and the session records exactly as it does today — which is also
   * what every pre-S2 test caller gets.
   */
  secrets?: SecretStore;
  /**
   * Create the ONE `.provenance/` directory watcher this session uses for peer
   * witnessing, or throw if it cannot be created.
   *
   * Whether this succeeds IS `session.start.witness_capture` (collaboration spec
   * §5.6 item 3), so it is called before the first entry is chained and its
   * result is handed on to `startPeerWatcher` — one watcher, one answer, no way
   * for the report and the wiring to disagree.
   *
   * Defaults to the production `vscode.workspace.createFileSystemWatcher`.
   * Overridden by tests, which have no extension host.
   */
  createProvenanceDirWatcher?: (provenanceDir: string) => ProvenanceDirWatcher;
};

/**
 * The production `.provenance/` watcher — one `FileSystemWatcher` on the
 * directory, matching `*.slog` only.
 *
 * Read-only by construction: the returned handle exposes three subscriptions
 * and `dispose`, and nothing that could rename, rewrite or delete a foreign
 * file (peer-witnessing writer contract rule 5; decision-log bug 2).
 */
function createProvenanceDirWatcher(provenanceDir: string): ProvenanceDirWatcher {
  const w = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(provenanceDir, '*.slog'),
  );
  return {
    onDidCreate: (h) => w.onDidCreate((uri) => h(uri.fsPath)),
    onDidChange: (h) => w.onDidChange((uri) => h(uri.fsPath)),
    onDidDelete: (h) => w.onDidDelete((uri) => h(uri.fsPath)),
    dispose: () => w.dispose(),
  };
}

// ---------------------------------------------------------------------------
// Production heartbeat deps
// ---------------------------------------------------------------------------

export function defaultHeartbeatDeps(): HeartbeatVscodeDeps {
  return {
    windowState: vscode.window.state,
    activeTextEditor: () => {
      const editor = vscode.window.activeTextEditor;
      return editor ? vscode.workspace.asRelativePath(editor.document.uri) : null;
    },
    onDidChangeFocus: (h) => vscode.window.onDidChangeWindowState(h),
    onDidChangeActiveTextEditor: (h) => vscode.window.onDidChangeActiveTextEditor(h),
    onDidChangeTextDocument: (h) => vscode.workspace.onDidChangeTextDocument(h),
  };
}

// ---------------------------------------------------------------------------
// startSession
// ---------------------------------------------------------------------------

/**
 * The one host-wide owner of `provenance.internal.pasteIntercept`.
 *
 * Module scope because the VS Code command id is itself a host-wide resource:
 * every session in this extension host shares this single registration and is
 * fanned out to. It registers lazily on the first session and disposes itself
 * once the last session's subscription goes, so a host with no sessions holds no
 * command.
 */
const sharedPasteInterceptRegistrar = createPasteInterceptRegistrar({
  registerCommand: (id, handler) => vscode.commands.registerCommand(id, handler),
  executeCommand: (id, ...args) => vscode.commands.executeCommand(id, ...args),
});

/**
 * Start a single assignment-root session. The manifest has already been verified
 * by the caller. Owns everything from "create .provenance/" through wiring
 * registration, and returns an ActiveSession whose dispose() tears down exactly
 * this session.
 */
export async function startSession(deps: StartSessionDeps): Promise<ActiveSession> {
  const { assignmentRoot, manifest, extension, vscodeVersion, platform, clock } = deps;
  const isOwnedByThisRoot = deps.isOwnedByThisRoot ?? (() => true);
  const isRepoOwnedByThisRoot = deps.isRepoOwnedByThisRoot ?? isOwnedByThisRoot;
  const ownDisposables: vscode.Disposable[] = [];

  // Optional per-session status bar. extension.ts mounts a single global status
  // bar instead, so single-root callers leave this undefined.
  if (deps.createStatusBar !== undefined) {
    deps.createStatusBar(ownDisposables);
  }

  // Step 3a: Determine .provenance/ dir early (needed by chain recovery + session writer).
  const provenanceDir = deps.provenanceDirOverride ?? path.join(assignmentRoot, '.provenance');
  await fsPromises.mkdir(provenanceDir, { recursive: true });

  // Step 3a-bis: stop git rewriting the bytes we are about to sign.
  //
  // Every file in this directory is covered by a signature over its exact
  // sha256, and a `.slog` is newline-delimited JSON that nothing marks as
  // binary — so git's end-of-line filters will happily widen every LF to CRLF
  // on checkout. The git submission path has no seal step to re-hash the result,
  // so the analyzer sees a log that does not match its signed digest and reports
  // it at the highest severity it has, against a student who did nothing.
  //
  // Prevention has to be here because it is the only place the bytes can still
  // be protected rather than reconstructed: the reader can undo the LF→CRLF
  // direction after the fact, but not the reverse, and not a mixed file. See
  // `log-core/git-attributes.ts`.
  //
  // Never overwrites, never throws, and its failure is not the session's
  // failure — `.provenance/` is shared with partners and a read-only checkout
  // must still record.
  await ensureProvenanceGitAttributes(provenanceDir);

  // Step 3b: Resolve the course's capture policy from the ALREADY-VERIFIED
  // manifest (program spec §4). Resolved exactly once, here, and passed down as
  // plain booleans: nothing on the event path may re-parse or re-verify anything,
  // because `doc.change` fires per keystroke.
  //
  // A 1.x manifest, or a 2.0 manifest whose course specified nothing, resolves to
  // DEFAULT_CAPTURE_POLICY — everything on, 30s heartbeat — i.e. exactly today's
  // behaviour. resolveVerifiedCapturePolicy gates on the format version itself, so
  // a `policy` block stapled onto a 1.x manifest (where it is NOT signed) can never
  // be honoured.
  const capturePolicy = resolveVerifiedCapturePolicy(manifest);

  // Step 3b-bis: and the course's enrollment policy, from the same verified
  // manifest and under the same version gate. This one governs nothing about
  // capture — the bundle is byte-identical either way — only whether an
  // un-enrolled student is TOLD they are un-enrolled.
  const enrollmentRequired = resolveVerifiedEnrollmentPolicy(manifest).required;

  // Step 3c: Generate the session keypair.
  const keypair = await generateSessionKeypair();

  // Step 3c-bis: Build the S2 identity block (program spec §5a step 5).
  //
  // Runs AFTER the session keypair exists, because the student's per-course key
  // countersigns exactly that public key. Never blocks: `buildSessionIdentity`
  // returns `skipped` for every failure — not enrolled, no keyring, a lapsed
  // cert, a token from another machine — and the session records without an
  // `identity`. It also refuses to hand back a block that does not verify against
  // this manifest's root-verified `course_cert`, so nothing unverifiable can enter
  // the hash chain.
  //
  // `secrets` is optional so the many existing test callers (and any caller
  // without an ExtensionContext) keep working; absent means "never enrolled".
  //
  // The outcome is KEPT, not just logged. It is the only place that knows whether
  // this student is enrolled, and `activation/enroll-nudge.ts` reads it to decide
  // the status bar wording and whether to point them at the enrollment page. It
  // stays `undefined` when no `secrets` were supplied, which is "we never asked",
  // distinct from "we asked and they are not enrolled" — a caller that did not
  // wire identity must not make the student think they failed to enrol.
  let identity: SessionIdentity | undefined;
  let identityOutcome: IdentityOutcome | undefined;
  if (deps.secrets !== undefined) {
    const outcome = await buildSessionIdentity({
      manifest,
      sessionPubkeyHex: keypair.publicKeyHex,
      // The window checks are judged against the session's own start instant, never
      // wall-clock now, so an archived bundle still reads correctly years later.
      sessionStartedAt: clock.wall(),
      secrets: deps.secrets,
      // The 2.1 trust anchor. The stored `institution_cert` is root-verified
      // against this before it is used as an anchor — unlike 2.0, whose anchor
      // is the manifest's already-verified `course_cert`.
      rootPubkeyHex: ROOT_PUBLIC_KEY_HEX,
    });
    identityOutcome = outcome;
    if (outcome.kind === 'emitted') {
      identity = outcome.identity;
      // Out-of-window is reported, never enforced (program spec §4) — surface it
      // so the student can renew, but record either way.
      if (!outcome.verified.token_window.in_window) {
        console.warn(
          `[provenance] enrollment token out of window (${outcome.verified.token_window.reason}); recording anyway.`,
        );
      }
    } else {
      console.warn(`[provenance] no session identity emitted: ${outcome.reason.kind}`);
    }
  }

  // Step 3c-ter: Chain recovery — inspect the provenanceDir for a previous session.
  // PRD §4.8: on extension crash → set prev_session_id. On corrupt log → quarantine.
  //
  // ORDERING: this used to run at step 3b, before the keypair and the identity
  // existed. It now runs AFTER step 3c-bis because it needs this session's
  // `student_ref` to tell our own `.slog` files from a partner's in a shared,
  // committed `.provenance/` (git-collaboration spec §3 S9/S19/S22, Tier 0.1+0.2).
  // Nothing between 3a and here depends on the recovery result, and `prevSessionId`
  // is not consumed until step 3d, so the move is behaviour-preserving apart from
  // the ownership gate itself.
  //
  // `ownStudentRef` is null whenever `buildSessionIdentity` did not emit — not
  // enrolled, no keyring, lapsed cert. That is the common case today and it is
  // handled explicitly inside `recoverPreviousSession`; it must never throw or
  // block recording.
  //
  // A ROTATION SKIPS ALL OF IT (design §3.3 mechanism 2). `skipChainRecovery`
  // short-circuits to `clean_start` without touching the filesystem, because the
  // caller already knows the predecessor's id and the predecessor was sealed by
  // this same process moments ago. See `skipChainRecovery`'s docstring for why the
  // cost matters: recovery is the largest term in the teardown window, and the
  // window is where a lost keystroke turns into a false accusation.
  const recover = deps.recoverPreviousSession ?? recoverPreviousSession;
  const recovery =
    deps.skipChainRecovery === true
      ? ({ kind: 'clean_start' } as const)
      : await recover({
          provenanceDir,
          readSlogFile: async (p) => {
            try {
              const text = await fsPromises.readFile(p, 'utf8');
              return { ok: true, text };
            } catch (e) {
              const code = (e as NodeJS.ErrnoException).code;
              return { ok: false, reason: code === 'ENOENT' ? 'not_found' : 'read_error' };
            }
          },
          rename: fsPromises.rename,
          listSlogFiles: async (dir) => {
            try {
              const entries = await fsPromises.readdir(dir);
              return entries.filter((f) => f.endsWith('.slog'));
            } catch {
              return [];
            }
          },
          now: () => new Date(),
          ownStudentRef: identity?.enrollment.student_ref ?? null,
        });

  // Determine prev_session_id from recovery result.
  // Only set for dangling sessions (crashes) — not for cleanly ended sessions.
  // The session it names is now guaranteed to be one of THIS contributor's, so
  // the back-pointer is a real intra-contributor chain link rather than "whoever
  // wrote last by wall clock" (program spec §7 mechanism 1).
  //
  // `prevSessionIdOverride` wins, and exists for exactly one caller: size
  // rotation (PRD §4.6), whose predecessor ended CLEANLY and so is invisible to
  // the dangling-only rule above. Recovery itself is untouched.
  const prevSessionId: string | null =
    deps.prevSessionIdOverride ??
    (recovery.kind === 'previous_session_dangling' ? recovery.prevSessionId : null);

  // Step 3c-quater: THE CAPABILITY REPORTS (collaboration spec §5.6).
  //
  // Both must be known BEFORE `session.start` is built, because that is the
  // entry that carries them, and it is the first entry in the chain. They say
  // "I could not", never "I was told not to" — neither is policy-gated, and
  // neither is ever a finding. `undefined` OMITS the field, which is a legal,
  // permanent, blameless answer.

  // Item 2 — git. A side-effect-free probe that asks `resolveGitApi` the same
  // question `startGitWiring` asks at step 16, through the same function, so
  // the report cannot drift from what the wiring actually does. Cheap and
  // idempotent: `getAPI(1)` is a getter on another extension's exports.
  let gitCapture: GitCaptureCapability | undefined;
  try {
    gitCapture = probeGitCapture({
      getGitExtension: () => vscode.extensions.getExtension('vscode.git'),
      isRepoOwnedByThisRoot,
    });
  } catch (e) {
    // Probing must never cost a session. Omitting the report costs context.
    console.warn('[provenance] git capture probe failed; omitting the report:', e);
  }

  // Item 3 — `.provenance/` witnessing. The capability IS the artifact: the
  // watcher the peer-witnessing wiring will use is created HERE, once, and
  // whether it could be created is the answer. Probing by creating a second,
  // throwaway watcher would let the report and the wiring disagree.
  //
  // Creating it early costs nothing and loses nothing: the peer watcher does not
  // SUBSCRIBE until step 16b, and a foreign file that appears before that
  // subscription is missed today exactly as it would be missed now. This session
  // owns the watcher — it goes into `ownDisposables` — so the peer watcher is
  // handed a non-disposing view of it and only owns its own subscriptions.
  let provenanceDirWatcher: ProvenanceDirWatcher | undefined;
  try {
    provenanceDirWatcher = deps.createProvenanceDirWatcher
      ? deps.createProvenanceDirWatcher(provenanceDir)
      : createProvenanceDirWatcher(provenanceDir);
    ownDisposables.push(provenanceDirWatcher);
  } catch (e) {
    // A watcher that cannot be created costs witnessing, never recording.
    console.warn('[provenance] could not watch .provenance/ for peer witnessing:', e);
  }
  const witnessCapture: WitnessCaptureCapability =
    provenanceDirWatcher !== undefined ? 'available' : 'unavailable';

  // Step 3d: Build recorder context (generates sessionId, machineId, etc.).
  const recorderContext = buildRecorderContext({
    manifest,
    prevSessionId,
    extension,
    vscodeVersion,
    platform,
    sessionPubkeyHex: keypair.publicKeyHex,
    ...(identity !== undefined ? { identity } : {}),
    ...(gitCapture !== undefined ? { gitCapture } : {}),
    witnessCapture,
  });

  // Step 4: Open a SessionWriter (.provenance/ dir already created in Step 3a).
  const slogPath = path.join(provenanceDir, `session-${randomUUID()}.slog`);

  // DiskFullHandler — intercepts write errors, switches to ring buffer on ENOSPC.
  // Constructed before the writer so we can pass handleWriteError as the onError hook.
  // onDegraded emits recorder.degraded through the sessionHost; that event re-enters
  // enqueue() which accepts it (CRITICAL_KINDS) — no infinite loop.
  // handleWriteError is idempotent, so the second call from that re-entry is a no-op.
  //
  // sessionHostEmit is a forward reference populated in Step 5 after sessionHost is created.
  // It is guaranteed to be set before any write error can occur (the writer isn't used
  // until session.start is emitted in Step 6).
  let sessionHostEmit: ((kind: 'recorder.degraded', data: { reason: string }) => void) | null =
    null;

  const diskFullHandler = new DiskFullHandler({
    onDegraded: (data) => {
      // Emit through sessionHost — this will call the onEntry callback below, which
      // will route back through diskFullHandler.enqueue(). The entry is critical and
      // gets stored in the ring. The writer.append() call is skipped because degraded=true.
      sessionHostEmit?.('recorder.degraded', { reason: data.reason });
    },
    notify: (msg) => {
      void vscode.window.showErrorMessage(msg);
    },
  });

  const writer = await SessionWriter.open({
    slogPath,
    clock,
    onError: (e) => diskFullHandler.handleWriteError(e),
  });

  // Step 4b: Encrypt the private key and create the MetaWriter.
  // Encrypt under the manifest sig so it can't be recovered without the course manifest.
  const encryptedPrivkey = await encryptSessionPrivkey(
    keypair.privateKey,
    manifest.sig,
    recorderContext.session_id,
  );
  const metaPath = `${slogPath}.meta`;
  const metaWriter = await MetaWriter.create({
    metaPath,
    sessionId: recorderContext.session_id,
    sessionPubkeyHex: keypair.publicKeyHex,
    encryptedPrivkey,
  });

  // Step 4c-pre: Resolve the course's path scope, and construct this session's
  // expected-content registry. Moved here (ahead of step 11, where doc-wiring
  // and fs-watcher also need it) because the rolling seal below closes over it
  // too, and its first rewrite happens at step 6c — well before step 11 runs.
  // Computed once so the rolling seal, the classic seal, doc-wiring, and
  // fs-watcher all resolve the SAME scope and share the SAME registry instance
  // for this session; two different registries would let `capHit()` disagree
  // with what the recorder actually refused.
  const scope = scopeFromManifest(manifest);
  const expectedContentRegistry = new ExpectedContentRegistry(scope);

  // Step 4c: The ROLLING SEAL (program spec §8). A git-submitted assignment has
  // no seal step, so the recorder rewrites this session's own
  // `.provenance/manifest-<session_id>.json` + `.sig` on every checkpoint —
  // whatever gets committed is then always a valid seal of that moment. See
  // io/rolling-seal-writer.ts.
  //
  // GATED on the course's signed submission mode, and gated to FAIL OPEN.
  //
  // `submission` is part of the 2.0 signed payload, so it is trustworthy: at
  // 1.x, `parseManifestValue` returns early and the object it hands back has no
  // `submission` at all, which means `'bundle'` can only ever come from a
  // manifest the course actually signed. Nothing unsigned can turn the seal off.
  //
  // The asymmetry is deliberate. Rolling where it is not needed costs two extra
  // files in `.provenance/`, and the classic manifest still wins as
  // `bundle.manifest` so nothing about a bundle-submitted course's analysis
  // changes. NOT rolling where it IS needed costs an `unsealed_session` defect
  // on every session, which fails check 1 — a false accusation against a student
  // whose course simply has not migrated to a 2.0 manifest yet. Between "a
  // couple of redundant files" and "an integrity finding against innocent work",
  // only one of those is acceptable, so the seal is suppressed only when the
  // course has signed a statement that it submits bundles.
  const rollingSealEnabled = manifest.submission !== 'bundle';
  //
  // `extension_hash` is resolved lazily and exactly once. computeExtensionHash
  // walks the whole dist/ tree, so doing it per checkpoint would be pathological;
  // doing it eagerly here would add directory-walk latency to activation, which
  // is the one moment the recorder must not be slow. The first checkpoint is 100
  // entries away, long after activation has finished.
  const extensionDistPath =
    deps.extensionDistPath ??
    (typeof extension.extensionPath === 'string'
      ? path.join(extension.extensionPath, 'dist')
      : undefined);
  let extensionHashOnce: Promise<string> | undefined;
  const getExtensionHashOnce = (): Promise<string> => {
    extensionHashOnce ??= computeExtensionHash(extensionDistPath ?? '');
    return extensionHashOnce;
  };

  /**
   * Serializes every rolling-seal rewrite — the one at session start, the one
   * per checkpoint, and the final one in dispose(). Two concurrent rewrites
   * would interleave their `.json` and `.sig` renames and could leave a
   * mismatched pair on disk, which is the one thing the atomic write exists to
   * prevent. dispose() awaits this chain so the last seal is never lost.
   */
  let rollingSealChain: Promise<void> = Promise.resolve();

  /**
   * The checkpoint-triggered roll's time floor (task 13, fix round 1).
   *
   * `CHECKPOINT_INTERVAL` (100 entries) is an EVENT-count bound, not a time
   * bound — 100 events can be a few seconds of fast typing or several minutes
   * of thinking. A course scoped with a broad suffix rule (e.g. `track:
   * ["*.js"]`) against a workspace with a large, non-hard-excluded directory
   * present on disk (a checked-out `node_modules/`) walks and re-hashes every
   * matching file on every roll — measured at ~4.2s for one such workspace —
   * which at a 100-event cadence could mean a multi-MB signed manifest being
   * atomically rewritten into a git working tree every 10-20s of active
   * typing. 60s between checkpoint-triggered rolls is ample staleness for a
   * background artifact whose worst case (data loss window) is already bounded
   * by the SAME 100-event gap this floor sits behind, and it does not touch
   * `isHardExcluded` or invent a cache — it only widens an already-unbounded
   * time gap between rolls.
   *
   * Deliberately NOT applied to the session-start roll (step 6c) or the
   * `dispose()` final roll — see `rewriteRollingSeal`'s `force`/`final`
   * bypass below.
   */
  const ROLLING_SEAL_MIN_INTERVAL_MS = 60_000;
  /** Monotonic time (`clock.now()`) of the last roll actually performed, or `null` before the first. */
  let lastRollAt: number | null = null;

  /**
   * Rewrite the rolling seal. Never throws and never rejects: a seal failure
   * must not abort the checkpoint that carries it, and must never stop
   * recording. Recording is more important than sealing.
   *
   * `final` marks the seal as the LAST this session will get, which promotes the
   * reader from prefix to whole-file semantics. ONLY dispose() may pass it, and
   * only after session.end has been emitted, the writer flushed and the pending
   * checkpoint drained — see the call site. Every other roll leaves it off,
   * because the log is still growing and claiming otherwise would make the
   * student's next keystroke look like an append past a finished seal.
   *
   * `force` bypasses the `ROLLING_SEAL_MIN_INTERVAL_MS` time floor. Only the
   * session-start caller (step 6c) passes it — that first roll is what a
   * short, checkpoint-free session relies on for coverage at all, so it must
   * never be skipped. `final: true` bypasses the floor too, unconditionally:
   * the last seal this session will ever get must always be written, however
   * recently the previous one landed. The checkpoint call site (below, inside
   * `onEntry`) passes neither, so it alone is subject to the floor.
   */
  function rewriteRollingSeal(opts?: { final?: boolean; force?: boolean }): Promise<void> {
    if (!rollingSealEnabled) return Promise.resolve();
    const isFinal = opts?.final === true;
    const bypassFloor = isFinal || opts?.force === true;
    if (
      !bypassFloor &&
      lastRollAt !== null &&
      clock.now() - lastRollAt < ROLLING_SEAL_MIN_INTERVAL_MS
    ) {
      // Too soon since the last roll. The on-disk seal is still a valid (if
      // slightly stale) PREFIX seal — never treated as whole-file by a reader,
      // since only a `final: true` seal makes that claim — and the next
      // checkpoint, or dispose()'s unconditional final roll, will catch up.
      return Promise.resolve();
    }
    lastRollAt = clock.now();
    rollingSealChain = rollingSealChain.then(() => rollingSealOnce(isFinal));
    return rollingSealChain;
  }

  async function rollingSealOnce(isFinal: boolean): Promise<void> {
    try {
      const result = await writeRollingSeal({
        provenanceDir,
        sessionId: recorderContext.session_id,
        prevSessionId,
        slogPath,
        assignmentRoot,
        assignmentId: manifest.assignment_id,
        semester: manifest.semester,
        scope,
        scopeCapped: expectedContentRegistry.capHit(),
        sessionPrivkey: keypair.privateKey,
        extensionHash: await getExtensionHashOnce(),
        ...(isFinal ? { final: true } : {}),
      });
      if (result.kind === 'error') {
        // Degrade exactly like every other non-fatal write problem: surface it
        // and carry on. Deliberately NOT routed into DiskFullHandler — that
        // switches the session to a critical-events-only ring buffer, and
        // throwing away the student's event stream because a seal could not be
        // rewritten would trade the recording for the receipt.
        console.error('[provenance] rolling seal write error:', result.message);
      }
    } catch (e) {
      // Defensive: writeRollingSeal is documented not to throw, and the only
      // other await here is the memoized extension hash.
      console.error('[provenance] rolling seal unexpected error:', e);
    }
  }

  // Step 5: Create the session host.
  // Hook checkpoints: every CHECKPOINT_INTERVAL entries, sign + write.
  // Fire-and-forget on the append path; tracked via pendingCheckpoint so dispose()
  // can drain the last in-flight sign before closing the meta file.
  const CHECKPOINT_INTERVAL = 100;
  let entryCountSinceLastCheckpoint = 0;
  let pendingCheckpoint: Promise<void> = Promise.resolve();
  const rotateAtBytes = deps.rotateAtBytesOverride ?? ROTATE_AT_BYTES;
  const rotateIdleQuietMs = deps.rotateIdleQuietMsOverride ?? ROTATE_IDLE_QUIET_MS;
  const rotateHardCeilingBytes = deps.rotateHardCeilingBytesOverride ?? ROTATE_HARD_CEILING_BYTES;
  /** Requested exactly once, ever. */
  let rotationRequested = false;
  /** Size threshold crossed; waiting for a quiet window (design §3.3). */
  let rotationArmed = false;
  /**
   * When content was last mutated ({@link ROTATE_QUIET_KINDS}), in `clock` time.
   *
   * Seeded in {@link armRotation}, NOT at session start. Arming and the first
   * evaluation happen in the same checkpoint tick, so a session-start seed would be
   * hours old by the time a log reaches 40 MiB — `now - seed` would be hours, `quiet`
   * would be trivially true, and the very first evaluation would rotate the session
   * MID-BURST. That is the false accusation the gate exists to prevent: everything in
   * the teardown window is dropped, and `inter_session_external_change` then reports
   * an honest student at 0.85 confidence.
   *
   * Seeding at arm time instead makes the first evaluation pessimistic — it demands a
   * full quiet window measured from the moment of arming — which is the right default
   * for a mechanism that can accuse someone.
   *
   * Written on the event path, and ONLY while a rotation is armed, so an ordinary
   * session pays a single boolean test per entry and nothing else; the p99 < 1 ms
   * budget (PRD §4.7) binds there and nowhere else. No evaluation happens there, only
   * the timestamp.
   */
  let lastContentChangeAtMs = 0;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  /** Set by `dispose()`: no timer may be armed after teardown has begun. */
  let disposed = false;

  function clearIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
  }

  /**
   * Request a rotation if the log is big enough AND the student is idle — or if
   * the hard ceiling has been reached, idle or not.
   *
   * Called at the checkpoint cadence (every 100 entries) and, once armed, on a
   * poll timer. NEVER per keystroke: a quiet session records nothing, so the
   * checkpoint cadence alone could defer a rotation by 100 heartbeats — but
   * evaluating on the event path would put a clock read and two comparisons in
   * front of every `doc.change`.
   */
  function evaluateRotation(): void {
    if (rotationRequested) return;
    // DEGRADED ABANDONS A ROTATION; IT DOES NOT DEFER IT (design §3.2).
    //
    // Here, at the SINGLE POINT OF COMMIT that both triggers pass through, never at
    // the individual call sites — guarding call sites is how this hole arose. The
    // property "a degraded session never rotates" was structural on the ENTRY path
    // only (`onEntry` returns before the checkpoint branch); the idle poll is a
    // second, independent trigger that never passes through it, and a third trigger
    // added later would repeat the mistake. Arm mid-burst, let the disk fill, and the
    // student's pause while reading the error notification IS the quiet window the
    // gate waits for — so the poll would commit with the byte counter frozen at
    // threshold, tearing the predecessor down and sealing it `final: true` while its
    // `session.end` went to the in-memory ring rather than the log. A bundle sealed
    // final whose log lacks its own terminal `session.end` is an evidence-integrity
    // problem, which is worse than anything rotation was meant to solve.
    //
    // ABANDON, not defer: the poll is stopped and `rotationArmed` is deliberately
    // LEFT SET, so `armRotation` cannot start another one. `degraded` is one-way —
    // nothing clears it without a restart — so a deferred rotation would wait forever
    // while pretending it might still happen.
    //
    // Accepted consequence (§3.2, a behavioural choice shared by all three ports): a
    // degraded session's log can exceed ROTATE_AT_BYTES and, in the extreme, GitHub's
    // 50 MB warning. A degraded session writes almost nothing so it barely grows, and
    // an oversized log is recoverable whereas a falsely-`final` seal is not. There is
    // deliberately no second ceiling to compensate.
    if (diskFullHandler.degraded) {
      clearIdleTimer();
      return;
    }
    // Only an ARMED rotation can fire, because `lastContentChangeAtMs` is only
    // meaningful once `armRotation` has seeded it. Without this, a tick that reached
    // here with arming refused — `dispose()` sets `disposed`, and the `session.end`
    // entry it emits can land on a checkpoint boundary — would compare `now` against
    // an unseeded 0, find the window trivially open, and request a rotation during
    // teardown.
    if (!rotationArmed) return;
    const bytes = writer.bytesAppended;
    if (bytes < rotateAtBytes) return;
    const quiet = clock.now() - lastContentChangeAtMs >= rotateIdleQuietMs;
    if (!quiet && bytes < rotateHardCeilingBytes) return;
    rotationRequested = true;
    clearIdleTimer();
    deps.requestRotation?.(recorderContext.session_id);
  }

  /**
   * Start polling for a quiet window. Idempotent, and the timer exists only while
   * a rotation is armed and unfired, so a session that never reaches the threshold
   * holds no timer at all. Disposed by `dispose()` (CLAUDE.md: every `setInterval`
   * has a shutdown path).
   */
  function armRotation(): void {
    // `disposed` is checked, not just `rotationArmed`: `dispose()` clears the timer
    // on its first line and THEN emits `session.end`, which still runs through
    // `onEntry` (that is the point — see `sealing`). If that entry happens to land
    // on the 100-entry boundary with the log over threshold and not yet quiet, this
    // would otherwise create a fresh interval after teardown.
    if (rotationArmed || disposed) return;
    rotationArmed = true;
    // The quiet window starts NOW, never at session start — see
    // `lastContentChangeAtMs`. `armRotation()` and the first `evaluateRotation()` run
    // in the same checkpoint tick, so without this the first evaluation would compare
    // against a seed hours old and rotate mid-burst.
    lastContentChangeAtMs = clock.now();
    // A quarter of the quiet interval: fine-grained enough that the rotation
    // follows the pause closely, coarse enough to be free (one callback per 500 ms
    // in production, and only while armed).
    const pollMs = Math.max(50, Math.floor(rotateIdleQuietMs / 4));
    idleTimer = setInterval(() => {
      evaluateRotation();
    }, pollMs);
    idleTimer.unref?.();
  }

  /**
   * True from the moment `session.end` has been written onward: this session is
   * sealing and accepts no further entries.
   *
   * Set AFTER the `session.end` emit and after the final peer-witness drain, so
   * both of those still land — `session.end` is by definition the last entry of
   * the log, and the drain's observations belong to the session that saw them.
   * Everything emitted after that point is DROPPED, silently and by design.
   *
   * Why drop rather than throw. `dispose()` closes the writer a few awaits later,
   * and `SessionWriter.append` throws on a disposed writer — correctly, since a
   * use-after-dispose anywhere else is a real bug and must stay loud. But the
   * teardown window is not a bug: the doc wiring is still subscribed while the
   * writer flushes, drains and seals (rotation, PRD §4.6, does not unsubscribe it
   * until teardown returns), so an ordinary keystroke inside that window would
   * raise an exception into a VS Code event listener on the student's machine.
   * Design §3.2 specifies these events as dropped; this is that drop.
   *
   * A DROP IS NOT FREE, and an earlier version of this comment claimed it was.
   * Design §3.3 (correction, 2026-09-23) records why that was wrong:
   * `inter_session_external_change` compares a RECONSTRUCTION of the predecessor's
   * event stream against the successor's first `doc.open` content, which is a live
   * buffer read, by exact string equality. So content dropped here is present on the
   * successor's side and absent from the predecessor's, the two differ, and the
   * student is reported at 0.85 confidence for editing the file outside the recorder.
   * The drop is VISIBLE to the analyzer, and deliberately so — the negative control
   * in `analysis-core` exists to keep it visible.
   *
   * That is why this flag is not the mitigation. The mitigation is WHEN we rotate:
   * {@link ROTATE_IDLE_QUIET_MS} + {@link ROTATE_QUIET_KINDS} mean a rotation begins
   * only after nothing has mutated content for two seconds, so in the ordinary case
   * there is nothing in the window to drop. The one exception is
   * {@link ROTATE_HARD_CEILING_BYTES}, which rotates a never-idle session anyway and
   * can therefore still produce a false flag.
   *
   * What this can hide: any event kind at all, but only in the span after
   * `session.end` has been written, and nothing a reader could otherwise have seen —
   * a log cannot legally continue past its own `session.end`.
   */
  let sealing = false;

  /**
   * PEER WITNESSING (program spec §7 mechanism 2). Forward reference: the
   * watcher needs `sessionHost.emit`, which does not exist until the host below
   * is constructed, while the checkpoint hook that DRAINS it lives inside that
   * construction. It is created at step 16b and is guaranteed to exist long
   * before the first checkpoint, which is 100 entries away.
   */
  let peerWatcher: PeerWatcher | undefined = undefined;

  const sessionHost = createSessionHost({
    sessionId: recorderContext.session_id,
    clock,
    // The single choke point for policy-gated event kinds — see session-host.ts.
    capturePolicy,
    onEntry: (entry: HashedEnvelope) => {
      // This session has already written its `session.end` — see `sealing`.
      // Dropped, not thrown, and not queued anywhere: the log is closed.
      if (sealing) {
        return;
      }

      // Route through disk-full handler.
      // If degraded: critical entries go to the ring; non-critical are dropped.
      // If not degraded: write to disk as normal.
      if (diskFullHandler.degraded) {
        diskFullHandler.enqueue(entry);
        return;
      }

      writer.append(entry);
      // The idle gate's only hot-path cost (design §3.3 mechanism 1): the WHEN,
      // never the whether. Evaluation happens at the checkpoint cadence and on the
      // poll timer, not here. `rotationArmed` is tested FIRST so an ordinary session
      // — which is every session until it passes 40 MiB — pays one boolean and
      // neither a Set lookup nor a clock read.
      if (rotationArmed && ROTATE_QUIET_KINDS.has(entry.kind)) {
        lastContentChangeAtMs = clock.now();
      }
      entryCountSinceLastCheckpoint++;
      if (entryCountSinceLastCheckpoint >= CHECKPOINT_INTERVAL) {
        entryCountSinceLastCheckpoint = 0;
        // Chain onto pendingCheckpoint so dispose() awaits the most recent one,
        // and so concurrent checkpoint writes are serialized.
        pendingCheckpoint = pendingCheckpoint
          .then(() => signCheckpoint(entry.seq, entry.hash, keypair.privateKey))
          .then((cp) => metaWriter.appendCheckpoint(cp))
          .catch((e: unknown) => {
            console.error('[provenance] checkpoint sign/write error:', e);
          })
          // Peer witnessing drains on the checkpoint cadence (writer contract
          // rule 3) — BEFORE the rolling seal, so the observations it emits are
          // in the `.slog` that the seal about to be written commits to. The
          // watcher's callbacks did no I/O; all of it happens here, off the
          // event path. drain() never rejects.
          .then(() => peerWatcher?.drain())
          // The rolling seal runs AFTER the checkpoint has landed in the .meta,
          // so `meta_sha256` covers it, and after the .catch above so a failed
          // checkpoint still gets the best seal available. rewriteRollingSeal
          // never rejects, so it cannot poison the chain dispose() awaits.
          //
          // No `force`/`final` here: this is the ONE call site subject to
          // `ROLLING_SEAL_MIN_INTERVAL_MS` — a checkpoint fired less than 60s
          // after the last actual roll is a no-op, since the walk-and-hash
          // cost that motivates the floor runs at THIS cadence, not the
          // session-start or dispose() rolls (see `rewriteRollingSeal`'s
          // docstring).
          .then(() => rewriteRollingSeal());

        // Size rotation (PRD §4.6). Read INSIDE the checkpoint branch so the
        // check costs one comparison per 100 entries, not one per keystroke —
        // doc.change must stay under 1 ms p99 (§4.7). Requested at most once;
        // the swap itself is extension.ts's job.
        //
        // Crossing the threshold ARMS the rotation (design §3.3); it fires only
        // once the student has been quiet for `rotateIdleQuietMs`, or at the hard
        // ceiling. Both decisions live in `evaluateRotation`, which the poll timer
        // also calls — a session that goes quiet right after arming must not wait
        // 100 more entries for the next checkpoint.
        //
        // A degraded (disk-full) session can never reach here: the degraded
        // branch at the top of onEntry returns before the append. That covers the
        // ENTRY path only, which is why `evaluateRotation` checks the flag itself
        // — the idle poll does not come through here.
        if (!rotationRequested && writer.bytesAppended >= rotateAtBytes) {
          armRotation();
          evaluateRotation();
        }
      }
    },
  });

  // Populate the forward reference for onDegraded so it can emit through sessionHost.
  sessionHostEmit = (kind, data) => sessionHost.emit(kind, data);

  // Step 6: Emit session.start.
  sessionHost.emit('session.start', recorderContext);

  // Step 6b: If we recovered from corruption, emit the recovery event now (after session.start).
  if (recovery.kind === 'previous_session_corrupt') {
    sessionHost.emit('recorder.recovered_from_corruption', {
      quarantined_path: recovery.quarantinedPath,
    });
  }

  // Step 6c: Seal immediately, before the first checkpoint is anywhere near due.
  //
  // Checkpoints land every 100 entries, so a session that records only
  // session.start would never reach one — and in a git-submitted repo that
  // session's `.slog` would be committed with no seal covering it at all
  // (`unsealed_session`). Sealing here means a session is sealed from its first
  // instant and every later rewrite is an update, never the first write.
  //
  // AWAITED on purpose. Fire-and-forget would let a seal write outlive the
  // startSession call that spawned it, landing in a `.provenance/` that the
  // caller (or a test's teardown) has already torn down. The cost is one
  // dist/ walk plus one ed25519 sign at activation, alongside the keypair
  // generation and encrypted-privkey write already happening here.
  //
  // `force: true`: this is the FIRST roll, before `lastRollAt` has a baseline,
  // so the time floor would never actually bite here regardless — but forcing
  // it explicitly documents that this roll is unconditional, matching
  // `rewriteRollingSeal`'s own contract, rather than relying on `lastRollAt`
  // starting `null`.
  await rewriteRollingSeal({ force: true });

  // Step 7: Start heartbeat (PRD §4.2: session.heartbeat every 30s).
  const hbDeps = deps.heartbeatDeps ?? defaultHeartbeatDeps();
  const heartbeat = startHeartbeat({
    ...hbDeps,
    // policy.capture.heartbeat_interval_ms, already clamped to [5000, 120000] by
    // resolveCapturePolicy. session.heartbeat is on the hard floor — only its
    // cadence is tunable.
    intervalMs: capturePolicy.heartbeat_interval_ms,
    getNow: () => clock.now(),
    // Wall-clock source for suspend/resume detection (PRD §4.2 addendum). Deliberately
    // Date.now(), not clock.now() — see heartbeat.ts for why this must be wall-clock.
    getWallMs: () => Date.now(),
    emit: (data) => sessionHost.emit('session.heartbeat', data),
    emitResumed: (data) => sessionHost.emit('session.resumed', data),
  });
  ownDisposables.push(heartbeat);

  // Step 8: Start clock-skew watcher (PRD §4.2: clock.skew on wall drift).
  const clockWatcher = startClockWatcher({
    getMonotonicMs: () => clock.now(),
    getWallMs: () => Date.now(),
    emit: (data) => sessionHost.emit('clock.skew', data),
  });
  ownDisposables.push(clockWatcher);

  // Step 9: Start paste intercept command (PRD §4.3 signal 2).
  //
  // Subscribes to the ONE host-wide registration rather than registering the
  // command itself. `provenance.internal.pasteIntercept` is a fixed keybinding
  // target, so the per-session registration this used to do threw
  // "command 'provenance.internal.pasteIntercept' already exists" out of the
  // second session as soon as nested discovery started recording more than one
  // assignment root — taking the rest of activation, including the seal
  // command, down with it.
  const pasteIntercept = startPasteIntercept({
    registerCommand: (id, handler) => vscode.commands.registerCommand(id, handler),
    executeCommand: (id, ...args) => vscode.commands.executeCommand(id, ...args),
    getNow: () => clock.now(),
    registrar: sharedPasteInterceptRegistrar,
    // A paste lands in the active editor, and that editor belongs to exactly one
    // assignment root. No active editor means nothing was pasted into, so no
    // session claims it.
    isForThisSession: () => {
      const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
      return activePath !== undefined && isOwnedByThisRoot(activePath);
    },
  });
  ownDisposables.push(pasteIntercept.disposable);

  // Step 10: Large-insert counter shared between doc-wiring and the reconciler.
  let _largeInsertCount = 0;
  const largeInsertCounter: LargeInsertCounter = {
    increment() {
      _largeInsertCount++;
    },
    count() {
      return _largeInsertCount;
    },
  };

  // Step 11: Start doc-event wiring (PRD §4.2 + §4.3 paste detection).
  // `scope` and `expectedContentRegistry` were already constructed at step
  // 4c-pre, ahead of the rolling seal's first rewrite at step 6c.

  // ExplanationTagger for formatter/git explanation of external changes.
  const explanationTagger = new ExplanationTagger({ getNow: () => clock.now() });

  // Assignment-root-relative path resolution (plan decision 4). Paths resolve
  // against THIS session's assignment root, not whichever workspace folder vscode
  // would have picked. In the single-root case this equals the old behavior since
  // assignmentRoot === the opened workspace folder.
  const toAssignmentRelative = makeAssignmentRelativePath(assignmentRoot);
  // Production readFile: resolve relative path against the assignment root + read UTF-8.
  const prodReadFile = (relativePath: string): Promise<string> =>
    fsPromises.readFile(path.join(assignmentRoot, relativePath), 'utf8');
  // Sync read for the reload-from-disk discriminator (doc-wiring.ts). Only invoked on the
  // first content change after a buffer goes clean, never on the keystroke firehose.
  const prodReadFileSync = (relativePath: string): string =>
    readFileSync(path.join(assignmentRoot, relativePath), 'utf8');

  const docWiring = startDocWiring({
    workspace: { asRelativePath: (uri) => toAssignmentRelative(uri.fsPath) },
    emitDocOpen: (data) => sessionHost.emit('doc.open', data),
    emitDocChange: (data) => sessionHost.emit('doc.change', data),
    emitDocSave: (data) => sessionHost.emit('doc.save', data),
    emitDocClose: (data) => sessionHost.emit('doc.close', data),
    emitPaste: (data) => sessionHost.emit('paste', data),
    emitSelectionChange: (data) => sessionHost.emit('selection.change', data),
    emitFocusChange: (data) => sessionHost.emit('focus.change', data),
    emitFsExternalChange: (data) => sessionHost.emit('fs.external_change', data),
    filesUnderReview: manifest.files_under_review,
    provenanceDir,
    expectedContent: expectedContentRegistry,
    pasteIntercept,
    largeInsertCounter,
    getNow: () => clock.now(),
    readFile: prodReadFile,
    readFileSync: prodReadFileSync,
    explanationTagger,
    isOwnedByThisRoot,
  });
  ownDisposables.push(docWiring);

  // Step 11b: Start FileSystemWatcher for external changes (PRD §4.5 — "file edited
  // while VS Code unfocused" path). Must come after docWiring so getLastDocChangeAt works.
  const fsWatcher = startFsWatcher({
    assignmentRoot,
    scope,
    registry: expectedContentRegistry,
    emit: (data) => sessionHost.emit('fs.external_change', data),
    getLastDocChangeAt: (p) => docWiring.getLastDocChangeAt(p),
    getLastSaveAt: (p) => docWiring.getLastSaveAt(p),
    getNow: () => clock.now(),
    readFile: prodReadFile,
    explanationTagger,
  });
  ownDisposables.push(fsWatcher);

  // Step 12: Start paste reconciler (PRD §4.3 signal 3).
  const reconciler = startPasteReconciler({
    emit: (data) => sessionHost.emit('paste.anomaly', data),
    getInterceptedCount: () => pasteIntercept.interceptCount,
    getLargeInsertCount: () => largeInsertCounter.count(),
  });
  ownDisposables.push(reconciler);

  // Step 13: Terminal wiring (PRD §4.2 + §4.4).
  // The onDidStartTerminalShellExecution / onDidEndTerminalShellExecution APIs are
  // VS Code 1.93+ additions. We cast window to check for their presence at runtime,
  // and only pass them if they exist. exactOptionalPropertyTypes requires we not pass
  // `undefined` for optional properties — so we build the object conditionally.
  type VscodeWindowExt = typeof vscode.window & {
    onDidStartTerminalShellExecution?: (
      h: (e: import('vscode').TerminalShellExecutionStartEvent) => void,
    ) => import('vscode').Disposable;
    onDidEndTerminalShellExecution?: (
      h: (e: import('vscode').TerminalShellExecutionEndEvent) => void,
    ) => import('vscode').Disposable;
  };
  const windowExt = vscode.window as VscodeWindowExt;
  const terminalWiringDeps = {
    emitTerminalOpen: (d: { terminal_id: string; shell: string; shell_integration: boolean }) =>
      sessionHost.emit('terminal.open', d),
    emitTerminalCommand: (d: { terminal_id: string; command: string; exit_code?: number }) =>
      sessionHost.emit('terminal.command', d),
    onDidOpenTerminal: (h: (t: import('vscode').Terminal) => void) =>
      vscode.window.onDidOpenTerminal(h),
    onDidCloseTerminal: (h: (t: import('vscode').Terminal) => void) =>
      vscode.window.onDidCloseTerminal(h),
    isOwnedByThisRoot,
    ...(windowExt.onDidStartTerminalShellExecution !== undefined
      ? {
          onDidStartTerminalShellExecution: (
            h: (e: import('vscode').TerminalShellExecutionStartEvent) => void,
          ) => windowExt.onDidStartTerminalShellExecution!(h),
        }
      : {}),
    ...(windowExt.onDidEndTerminalShellExecution !== undefined
      ? {
          onDidEndTerminalShellExecution: (
            h: (e: import('vscode').TerminalShellExecutionEndEvent) => void,
          ) => windowExt.onDidEndTerminalShellExecution!(h),
        }
      : {}),
  };
  const terminalWiring = startTerminalWiring(terminalWiringDeps);
  ownDisposables.push(terminalWiring);

  // Step 14: Extension snapshot (PRD §4.2 — ext.snapshot every 5 min + at start).
  const snap = startExtensionSnapshot({
    emit: (d) => sessionHost.emit('ext.snapshot', d),
    getExtensions: () => vscode.extensions.all,
  });
  ownDisposables.push(snap);

  // Step 15: Extension activation poller (PRD §4.2 — ext.activate).
  const extAct = startExtensionActivation({
    emit: (d) => sessionHost.emit('ext.activate', d),
    getExtensions: () => vscode.extensions.all,
  });
  ownDisposables.push(extAct);

  // Step 16: Git wiring (PRD §4.2 — git.event; also feeds explanationTagger for §4.5).
  const gitW = startGitWiring({
    emit: (d) => sessionHost.emit('git.event', d),
    getGitExtension: () => vscode.extensions.getExtension('vscode.git'),
    explanationTagger,
    isRepoOwnedByThisRoot,
    // The `git.path` setting, as a backstop for finding the git binary the
    // repository discriminator shells out to (writer correction 8). Supplied
    // HERE rather than defaulted inside git-wiring.ts because `vscode` is a
    // type-only import there — `tools/`'s seal conformance gate imports that
    // module's built output outside any extension host, where a runtime
    // `vscode` import cannot resolve. The primary hint, `api.git.path`, is read
    // off the git API inside the wiring and needs nothing from here.
    readConfiguredGitPath: () => vscode.workspace.getConfiguration('git').get<unknown>('path'),
  });
  ownDisposables.push(gitW);

  // Step 16b: Peer witnessing (program spec §7 mechanism 2, collaboration spec
  // §5.5). ONE FileSystemWatcher on `.provenance/` — not one per file, because a
  // partner's `.slog` filename is a uuid minted on their machine and is not
  // knowable in advance, and because only a directory watcher sees a file
  // APPEAR, which is the case this exists for.
  //
  // Distinct from the `files_under_review` watchers in fs-watcher.ts: those
  // watch the student's own source under the assignment root, this watches
  // provenance artifacts. Nothing here ever writes, renames or deletes: the
  // watcher is constructed with a read function and no write capability at all.
  const peerW = startPeerWatcher({
    provenanceDir,
    // This session's own `.slog` and `.slog.meta`, by basename. A chain cannot
    // corroborate itself, and the reader excluding a self-witness is not a
    // licence for the writer to produce one.
    isOwnFile: (basename) =>
      basename === path.basename(slogPath) || basename === path.basename(metaPath),
    emit: (data) => sessionHost.emit('peer.observed', data),
    readFile: async (absPath) => {
      try {
        const bytes = await fsPromises.readFile(absPath);
        return { ok: true, bytes };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return {
          ok: false,
          reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unreadable',
        };
      }
    },
    // The watcher was created at step 3c-quater, because whether it COULD be
    // created is `session.start.witness_capture` and that has to be known before
    // the first entry is chained. Handing back a non-disposing view: this
    // session owns the watcher (it is in `ownDisposables`), the peer watcher
    // owns only its own subscriptions.
    //
    // When creation failed there is nothing to hand back, and throwing is the
    // signal `startPeerWatcher` already handles — it logs and carries on with no
    // subscriptions, which is exactly the state `witness_capture: 'unavailable'`
    // reported.
    createWatcher: (): ProvenanceDirWatcher => {
      if (provenanceDirWatcher === undefined) {
        throw new Error('.provenance/ watcher unavailable');
      }
      const w = provenanceDirWatcher;
      return {
        onDidCreate: (h) => w.onDidCreate(h),
        onDidChange: (h) => w.onDidChange(h),
        onDidDelete: (h) => w.onDidDelete(h),
        dispose: () => {
          /* owned by the session, disposed through ownDisposables */
        },
      };
    },
  });
  peerWatcher = peerW;
  ownDisposables.push(peerW);

  /**
   * Tear down exactly this session: emit session.end, flush the writer, drain the
   * pending checkpoint, dispose the metaWriter, then dispose ownDisposables in LIFO
   * order. Each step is best-effort so a failure in one does not skip the rest.
   *
   * `reason` becomes `session.end.reason` and defaults to `'deactivate'`, which is
   * what every caller but size rotation (PRD §4.6, `'rotate'`) passes.
   *
   * Note: when extension.ts hands ownDisposables to VS Code's context.subscriptions
   * (single-root case), it empties this array so the LIFO teardown here is a no-op —
   * VS Code disposes those first, matching the historical ordering.
   */
  async function dispose(reason: string = 'deactivate'): Promise<void> {
    // The rotation idle poll, if one is armed. First, and unconditionally: it is
    // the one background task this function owns directly rather than through
    // ownDisposables, and it must not outlive the session that armed it. `disposed`
    // also stops `armRotation` creating a NEW one from the `session.end` entry that
    // this function is about to write — see `armRotation`.
    disposed = true;
    clearIdleTimer();
    // Final peer-witness drain, BEFORE session.end so the observations land
    // inside the session they belong to. Checkpoints fire every 100 entries, so
    // a partner's log that arrived after the last one would otherwise never be
    // witnessed by this session at all — and a `git pull` immediately before
    // closing the editor is an ordinary thing to do. drain() never rejects.
    try {
      await peerWatcher?.drain();
    } catch {
      // Ignore — witnessing is best effort and never blocks shutdown.
    }
    // Emit session.end event.
    try {
      sessionHost.emit('session.end', { reason });
    } catch {
      // Ignore — best effort.
    }
    // From here on this session accepts nothing more: `onEntry` drops every
    // further entry instead of appending to a writer that is about to close.
    // Set AFTER the emit above so `session.end` itself lands, and after the peer
    // drain above so its observations do. See `sealing`'s docstring and design
    // §3.2 for why a drop is the specified behaviour rather than a throw.
    sealing = true;
    // Flush pending entries and close the file handle. Await this to ensure
    // the writer is fully disposed before VS Code shuts down.
    try {
      await writer.dispose();
    } catch {
      // Ignore — best effort.
    }
    // Drain any in-flight checkpoint sign+write before closing the meta file.
    // Without this, a checkpoint that was kicked off in the last 100 entries can
    // race and never land in the .meta file.
    try {
      await pendingCheckpoint;
    } catch {
      // Ignore — best effort.
    }
    // Dispose the meta writer (no-op today; here for symmetry and future proofing).
    try {
      await metaWriter.dispose();
    } catch {
      // Ignore — best effort.
    }
    // Final rolling-seal rewrite, last of the three file-touching steps so it
    // covers the fully flushed `.slog` (session.end included) and the drained
    // `.meta`. A session killed without dispose() — the editor crashing, the
    // machine losing power — simply keeps whichever seal the last checkpoint
    // left, which is the whole point of maintaining it continuously.
    //
    // Awaiting rewriteRollingSeal() also drains any checkpoint seal still in
    // flight, since both share rollingSealChain.
    //
    // `final: true` is claimable HERE AND ONLY HERE, and only because of the
    // three awaits above: session.end is emitted, the writer is flushed and
    // closed, and the last checkpoint has landed in the `.meta`. Nothing can
    // append to either file after this point, so the digests about to be signed
    // are whole-file commitments rather than prefixes, and a reader is entitled
    // to fail an append against them.
    //
    // The claim is made only on a path that actually reached here. Every way a
    // session can die without a clean dispose — a crash, a power cut, a full
    // disk, a read-only checkout, `.provenance/` removed by a `git checkout` —
    // simply leaves the last non-final seal in place, which a reader treats as a
    // prefix commitment with a reported unattested tail. That is a coverage gap,
    // not a tamper finding, and it is why finality is claimed explicitly here
    // rather than inferred by the reader from a trailing `session.end` entry:
    // `session.end` lives in the log, and the log's completeness is the very
    // thing in question.
    try {
      await rewriteRollingSeal({ final: true });
    } catch {
      // Ignore — best effort. rewriteRollingSeal does not reject anyway.
    }
    // Dispose this session's own subscriptions in LIFO order.
    for (const d of [...ownDisposables].reverse()) {
      try {
        const result = d.dispose();
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          await result;
        }
      } catch {
        // Ignore — best effort.
      }
    }
  }

  return {
    assignmentRoot,
    sessionId: recorderContext.session_id,
    manifest,
    provenanceDir,
    slogPath,
    writer,
    metaWriter,
    sessionHost,
    sessionKeypair: { privateKey: keypair.privateKey, publicKeyHex: keypair.publicKeyHex },
    expectedContentRegistry,
    identityOutcome,
    enrollmentRequired,
    ownDisposables,
    getPendingCheckpoint: () => pendingCheckpoint,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// SessionRegistry
// ---------------------------------------------------------------------------

/** Owns every currently-active ActiveSession, keyed by assignmentRoot. */
export class SessionRegistry {
  private readonly sessions = new Map<string, ActiveSession>();

  add(session: ActiveSession): void {
    this.sessions.set(session.assignmentRoot, session);
  }

  get(root: string): ActiveSession | undefined {
    return this.sessions.get(root);
  }

  /**
   * Forget the session at `root` WITHOUT disposing it.
   *
   * For the one caller that has already disposed it: size rotation (PRD §4.6),
   * when starting the successor failed. Leaving the disposed predecessor in the
   * map would keep `all()` non-empty — so the status bar goes on claiming
   * "recording" — and keep `resolveForPath` routing events to a closed writer.
   * Everything else must go through `pruneToRoots`/`disposeAll`, which dispose.
   */
  remove(root: string): boolean {
    return this.sessions.delete(root);
  }

  all(): readonly ActiveSession[] {
    return [...this.sessions.values()];
  }

  resolveForPath(fsPath: string): ActiveSession | undefined {
    const root = resolveOwnerRoot(fsPath, [...this.sessions.keys()]);
    return root === null ? undefined : this.sessions.get(root);
  }

  async pruneToRoots(currentRoots: readonly string[]): Promise<void> {
    const toRemove: string[] = [];
    for (const root of this.sessions.keys()) {
      if (resolveOwnerRoot(root, currentRoots) === null) {
        toRemove.push(root);
      }
    }
    for (const root of toRemove) {
      const session = this.sessions.get(root);
      this.sessions.delete(root);
      if (session !== undefined) {
        await session.dispose();
      }
    }
  }

  async disposeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      await session.dispose();
    }
  }
}
