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
import type { HashedEnvelope, Clock, Manifest, SessionIdentity } from '@provenance/log-core';
import { buildRecorderContext } from './recorder-context.js';
import { buildSessionIdentity } from '../identity/session-identity.js';
import type { SecretStore } from '../identity/secret-store.js';
import { createSessionHost } from './session-host.js';
import { SessionWriter } from '../io/session-writer.js';
import { MetaWriter } from '../io/meta-writer.js';
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
import { startGitWiring } from '../wiring/git-wiring.js';
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
};

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
  const ownDisposables: vscode.Disposable[] = [];

  // Optional per-session status bar. extension.ts mounts a single global status
  // bar instead, so single-root callers leave this undefined.
  if (deps.createStatusBar !== undefined) {
    deps.createStatusBar(ownDisposables);
  }

  // Step 3a: Determine .provenance/ dir early (needed by chain recovery + session writer).
  const provenanceDir = deps.provenanceDirOverride ?? path.join(assignmentRoot, '.provenance');
  await fsPromises.mkdir(provenanceDir, { recursive: true });

  // Step 3b: Chain recovery — inspect the provenanceDir for a previous session.
  // PRD §4.8: on extension crash → set prev_session_id. On corrupt log → quarantine.
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
  });

  // Determine prev_session_id from recovery result.
  // Only set for dangling sessions (crashes) — not for cleanly ended sessions.
  const prevSessionId: string | null =
    recovery.kind === 'previous_session_dangling' ? recovery.prevSessionId : null;

  // Step 3b-bis: Resolve the course's capture policy from the ALREADY-VERIFIED
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
  let identity: SessionIdentity | undefined;
  if (deps.secrets !== undefined) {
    const outcome = await buildSessionIdentity({
      manifest,
      sessionPubkeyHex: keypair.publicKeyHex,
      // The window checks are judged against the session's own start instant, never
      // wall-clock now, so an archived bundle still reads correctly years later.
      sessionStartedAt: clock.wall(),
      secrets: deps.secrets,
    });
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

  // Step 3d: Build recorder context (generates sessionId, machineId, etc.).
  const recorderContext = buildRecorderContext({
    manifest,
    prevSessionId,
    extension,
    vscodeVersion,
    platform,
    sessionPubkeyHex: keypair.publicKeyHex,
    ...(identity !== undefined ? { identity } : {}),
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

  // Step 5: Create the session host.
  // Hook checkpoints: every CHECKPOINT_INTERVAL entries, sign + write.
  // Fire-and-forget on the append path; tracked via pendingCheckpoint so dispose()
  // can drain the last in-flight sign before closing the meta file.
  const CHECKPOINT_INTERVAL = 100;
  let entryCountSinceLastCheckpoint = 0;
  let pendingCheckpoint: Promise<void> = Promise.resolve();

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
          });
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
    isOwnedByThisRoot,
  });
  ownDisposables.push(gitW);

  // computeExtensionHash is referenced by the caller (extension.ts) at seal time, not here.
  void computeExtensionHash;

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
