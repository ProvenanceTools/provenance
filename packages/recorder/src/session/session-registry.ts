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
import { startPasteIntercept } from '../wiring/paste-command-intercept.js';
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
import { resolveVerifiedCapturePolicy } from '../activation/manifest-loader.js';
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

export type ActiveSession = {
  assignmentRoot: string;
  manifest: Manifest;
  provenanceDir: string;
  slogPath: string;
  writer: SessionWriter;
  metaWriter: MetaWriter;
  sessionHost: ReturnType<typeof createSessionHost>;
  sessionKeypair: { privateKey: Uint8Array; publicKeyHex: string };
  /**
   * Whether this session could claim an identity, and if not, why.
   *
   * `undefined` means identity was never attempted (no `secrets` supplied) — NOT
   * that the student is un-enrolled. `activation/enroll-nudge.ts` consumes this
   * to decide the status bar wording and whether to offer the enrollment page.
   */
  identityOutcome: IdentityOutcome | undefined;
  /** All VS Code subscriptions this session owns (doc-wiring, fs-watcher, heartbeat, etc). Disposed by dispose(). */
  ownDisposables: vscode.Disposable[];
  /** Most recent checkpoint write chain. dispose() awaits this so the final checkpoint isn't lost. */
  getPendingCheckpoint: () => Promise<void>;
  /** Emits session.end, flushes the writer, drains the pending checkpoint, disposes metaWriter + ownDisposables, in that order. */
  dispose: () => Promise<void>;
};

export type StartSessionDeps = {
  assignmentRoot: string;
  manifest: Manifest;
  extension: vscode.Extension<unknown>;
  vscodeVersion: string;
  platform: string;
  clock: Clock;
  provenanceDirOverride?: string;
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
  const recovery = await recoverPreviousSession({
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
  const prevSessionId: string | null =
    recovery.kind === 'previous_session_dangling' ? recovery.prevSessionId : null;

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
   */
  function rewriteRollingSeal(opts?: { final?: boolean }): Promise<void> {
    if (!rollingSealEnabled) return Promise.resolve();
    const isFinal = opts?.final === true;
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
        filesUnderReview: manifest.files_under_review,
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
      // Route through disk-full handler.
      // If degraded: critical entries go to the ring; non-critical are dropped.
      // If not degraded: write to disk as normal.
      if (diskFullHandler.degraded) {
        diskFullHandler.enqueue(entry);
        return;
      }

      writer.append(entry);
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
          .then(() => rewriteRollingSeal());
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
  await rewriteRollingSeal();

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
  const pasteIntercept = startPasteIntercept({
    registerCommand: (id, handler) => vscode.commands.registerCommand(id, handler),
    executeCommand: (id, ...args) => vscode.commands.executeCommand(id, ...args),
    getNow: () => clock.now(),
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
  const expectedContentRegistry = new ExpectedContentRegistry(manifest.files_under_review);

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
    filesUnderReview: manifest.files_under_review,
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
   * Note: when extension.ts hands ownDisposables to VS Code's context.subscriptions
   * (single-root case), it empties this array so the LIFO teardown here is a no-op —
   * VS Code disposes those first, matching the historical ordering.
   */
  async function dispose(): Promise<void> {
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
      sessionHost.emit('session.end', { reason: 'deactivate' });
    } catch {
      // Ignore — best effort.
    }
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
    manifest,
    provenanceDir,
    slogPath,
    writer,
    metaWriter,
    sessionHost,
    sessionKeypair: { privateKey: keypair.privateKey, publicKeyHex: keypair.publicKeyHex },
    identityOutcome,
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
