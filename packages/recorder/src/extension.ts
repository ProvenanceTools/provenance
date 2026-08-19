/**
 * VS Code extension entry point.
 *
 * activate() discovers every verified `.provenance-manifest` nested under the
 * open workspace folder(s) via discoverManifests(), starts one session per
 * discovered root via startSession(), and tracks them all in a module-level
 * SessionRegistry. deactivate() disposes the whole registry. rescan() reacts to
 * vscode.workspace.onDidChangeWorkspaceFolders to prune sessions whose root left
 * the workspace and start sessions for newly discovered roots.
 *
 * activateImpl()/activeSession below are Task 4's single-workspaceFolder
 * extraction, kept only so activation.integration.test.ts's pre-existing
 * single-session coverage keeps working — activate()/deactivate() (the real
 * VS Code entrypoints) no longer call activateImpl() or use activeSession.
 *
 * PRD §4.1: Activate only when a `.provenance-manifest` (or `provenance-manifest`) is present and signature-valid.
 * PRD §5.1: Emit session.start with full context; emit session.end on deactivate.
 * PRD §4.2: session.heartbeat every 30s; clock.skew on wall-clock drift.
 * PRD §4.7: Buffered, async I/O via SessionWriter (not a raw WriteStream).
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { SystemClock } from '@provenance/log-core';
import { loadAndVerifyManifest } from './activation/manifest-loader.js';
import type { ActivationError } from './activation/manifest-loader.js';
import { discoverManifests } from './activation/manifest-discovery.js';
import { createRecordingStatusBar } from './activation/status-bar.js';
import { sealBundle } from './commands/seal.js';
import { chooseSessionForSeal } from './commands/seal-selector.js';
import { computeExtensionHash } from './commands/extension-hash.js';
import { startSession, SessionRegistry } from './session/session-registry.js';
import type { ActiveSession, HeartbeatVscodeDeps } from './session/session-registry.js';
import { resolveOwnerRoot } from './session/session-router.js';
import type { Manifest } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Injected dependencies for activateImpl
// Allows tests to replace vscode, fs, and clock without the real VS Code runtime.
// ---------------------------------------------------------------------------

export type ActivateDeps = {
  /** First workspace folder. */
  workspaceFolder: vscode.WorkspaceFolder;
  /** The recorder's own Extension object (for package.json metadata). */
  extension: vscode.Extension<unknown>;
  /** VS Code version string (vscode.version in production). */
  vscodeVersion: string;
  /** Platform string (process.platform + '-' + process.arch in production). */
  platform: string;
  /**
   * Override for the embedded manifest-verification key (tests inject a test
   * keypair's pubkey). At Manifest 2.0 this is the ROOT key the inline
   * `course_cert` must chain to; at 1.x it is the key the payload signature is
   * checked against directly. Defaults, per format_version, to ROOT_PUBLIC_KEY_HEX
   * at 2.0 and the grandfathered LEGACY_COURSE_PUBLIC_KEY_HEX at 1.x — see
   * manifest-loader.ts.
   */
  pubkeyHex?: string;
  /** Override for the .provenance/ directory path (tests inject a tmp dir). */
  provenanceDirOverride?: string;
  /** Clock to inject (tests use FixedClock). */
  clock: import('@provenance/log-core').Clock;
  /** Disposable sink — items pushed here are cleaned up on deactivate. */
  disposables: vscode.Disposable[];
  /** Optional override for createStatusBar (tests can provide a no-op). */
  createStatusBar?: (disposables: vscode.Disposable[]) => vscode.StatusBarItem;
  /** Optional pre-loaded manifest (skips file I/O in tests that construct a manifest directly). */
  preloadedManifest?: Manifest;
  /**
   * Heartbeat + clock-watcher VS Code subscriptions.
   * Tests inject no-op stubs; production wires to vscode.window / workspace.
   */
  heartbeatDeps?: HeartbeatVscodeDeps;
  /**
   * Path to the recorder's dist/ directory for extension-hash computation.
   * Tests can inject a tmp dir; production uses context.extensionPath + '/dist'.
   */
  extensionDistPath?: string;
};

// ---------------------------------------------------------------------------
// Shared session state (scoped to the activation lifetime)
// ---------------------------------------------------------------------------

let activeSession: ActiveSession | null = null;

// ---------------------------------------------------------------------------
// Inactive-workspace fallback
// ---------------------------------------------------------------------------

/**
 * Human-readable guidance shown when a student runs "Prepare Submission Bundle"
 * in a folder where the recorder did not activate. Turns VS Code's opaque
 * "command not found" into an actionable message, tailored to why activation was
 * skipped. Pure so the wording is unit-testable without the VS Code runtime.
 *
 * PRD §4.1 still holds: the recorder does nothing on activation for these cases.
 * This text is only surfaced in reaction to an explicit command invocation.
 */
export function fallbackActivationMessage(error: ActivationError): string {
  switch (error.kind) {
    case 'no_manifest_file':
    case 'no_workspace':
      return (
        'No Provenance assignment was detected in this folder, so recording was ' +
        'not active and no session was captured. Open the assignment folder that ' +
        'contains a ".provenance-manifest" file (the one distributed by your course) ' +
        'and try again.'
      );
    case 'manifest_signature_invalid':
    case 'manifest_chain_invalid':
    case 'manifest_parse_error':
      return (
        'This folder\'s ".provenance-manifest" could not be verified, so Provenance ' +
        'recording did not start and no session was captured. Re-download the ' +
        'assignment from your course; if the problem persists, contact course staff.'
      );
    case 'manifest_read_error':
      return (
        'Provenance could not read the ".provenance-manifest" in this folder, so ' +
        `recording did not start and no session was captured (${error.message}). ` +
        'Re-download the assignment; if the problem persists, contact course staff.'
      );
  }
}

/**
 * Register a no-op stub for `provenance.prepareSubmissionBundle` in a workspace
 * where the recorder is inactive, so the palette command explains itself instead
 * of throwing "command not found". The stub only shows a message when invoked; it
 * creates no files and records nothing. The disposable is tracked for teardown.
 */
function registerInactiveStub(disposables: vscode.Disposable[], error: ActivationError): void {
  const message = fallbackActivationMessage(error);
  const stub = vscode.commands.registerCommand('provenance.prepareSubmissionBundle', () => {
    void vscode.window.showWarningMessage(message);
  });
  disposables.push(stub);
}

// ---------------------------------------------------------------------------
// activateImpl — testable core
// ---------------------------------------------------------------------------

/**
 * Core activation logic. Called by activate() with production deps,
 * and by integration tests with injected deps.
 *
 * Returns an ActiveSession if activation succeeded, or null if the workspace
 * is not a valid assignment workspace (callers should silently return).
 */
export async function activateImpl(deps: ActivateDeps): Promise<ActiveSession | null> {
  const { workspaceFolder, extension, vscodeVersion, platform, clock, disposables } = deps;

  // Initialize activeSession to null before we begin (in case we early-return or error).
  activeSession = null;

  // Step 1: Load and verify the `.provenance-manifest`/`provenance-manifest` file.
  let manifest: Manifest;
  if (deps.preloadedManifest !== undefined) {
    manifest = deps.preloadedManifest;
  } else {
    const manifestResult = await loadAndVerifyManifest(workspaceFolder, deps.pubkeyHex);
    if (!manifestResult.ok) {
      // PRD §4.1: "If the signature doesn't verify, the extension does nothing."
      // Not an error from the user's perspective; silent exit — no session, no files.
      console.error(`[provenance] activation skipped: ${manifestResult.error.kind}`);
      // ...but VS Code statically contributes the "Prepare Submission Bundle" palette
      // entry. Without a registered handler it fails with an opaque "command not found"
      // when a student runs it here (e.g. they opened just the assignment file, not the
      // folder holding `.provenance-manifest`). Register a lightweight stub that only
      // reacts to that explicit invocation and explains what to do. It records nothing
      // and creates no files, so the "does nothing" guarantee above still holds.
      registerInactiveStub(disposables, manifestResult.error);
      return null;
    }
    manifest = manifestResult.value;
  }

  // Step 2: Mount the status bar. extension.ts owns the single global status bar;
  // startSession() does not mount its own (its createStatusBar dep is left unset).
  if (deps.createStatusBar !== undefined) {
    deps.createStatusBar(disposables);
  } else {
    createRecordingStatusBar(disposables);
  }

  // Step 3: Delegate the per-assignment-root session lifecycle to startSession().
  // For the single-root case, the assignment root IS the opened workspace folder,
  // so this preserves today's behavior exactly.
  const session = await startSession({
    assignmentRoot: workspaceFolder.uri.fsPath,
    manifest,
    extension,
    vscodeVersion,
    platform,
    clock,
    ...(deps.provenanceDirOverride !== undefined
      ? { provenanceDirOverride: deps.provenanceDirOverride }
      : {}),
    ...(deps.heartbeatDeps !== undefined ? { heartbeatDeps: deps.heartbeatDeps } : {}),
    ...(deps.extensionDistPath !== undefined ? { extensionDistPath: deps.extensionDistPath } : {}),
  });

  // Hand this session's subscriptions to VS Code's context.subscriptions so they are
  // disposed in LIFO order BEFORE deactivate() runs — matching the historical teardown
  // ordering. Emptying ownDisposables afterward prevents session.dispose() from
  // double-disposing them.
  disposables.push(...session.ownDisposables);
  session.ownDisposables.length = 0;

  // Step 4: Register the "Prepare Submission Bundle" command (PRD §4.6 + §5.3).
  // The extensionDistPath for extension-hash is derived from context.extensionPath in
  // production; tests inject an override via deps.extensionDistPath.
  const extensionDistPath = deps.extensionDistPath ?? path.join(extension.extensionPath, 'dist');

  const sealCmd = vscode.commands.registerCommand(
    'provenance.prepareSubmissionBundle',
    async () => {
      // Flush the writer so any pending events land in the .slog before we read it.
      await activeSession?.writer.flush();

      const result = await sealBundle({
        assignmentRoot: workspaceFolder.uri.fsPath,
        provenanceDir: session.provenanceDir,
        assignmentId: session.manifest.assignment_id,
        semester: session.manifest.semester,
        filesUnderReview: session.manifest.files_under_review,
        sessionPrivkey: session.sessionKeypair.privateKey,
        sessionPubkeyHex: session.sessionKeypair.publicKeyHex,
        computeExtensionHash: () => computeExtensionHash(extensionDistPath),
        now: () => new Date(),
      });

      if (result.kind === 'ok') {
        void vscode.window.showInformationMessage(
          `Provenance bundle saved to ${result.bundlePath}`,
        );
        if (result.warnings.chainBroken || result.warnings.unreadableSession) {
          void vscode.window.showWarningMessage(
            'Provenance bundle produced. Integrity issues were detected in the recording and will be reviewed by course staff.',
          );
        }
      } else if (result.kind === 'no_sessions') {
        void vscode.window.showWarningMessage('No session data to seal.');
      } else if (result.kind === 'write_error') {
        void vscode.window.showErrorMessage(`Bundle write error: ${result.message}`);
      }
    },
  );
  disposables.push(sealCmd);

  activeSession = session;
  return session;
}

// ---------------------------------------------------------------------------
// VS Code extension hooks
// ---------------------------------------------------------------------------

const registry = new SessionRegistry();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  const ownExtension = vscode.extensions.getExtension('itsgeagle.provenance-recorder');
  if (ownExtension === undefined) {
    console.error(
      '[provenance] WARNING: could not locate own extension via getExtension; using context fallback.',
    );
  }
  const extension: vscode.Extension<unknown> =
    ownExtension ??
    ({
      id: 'itsgeagle.provenance-recorder',
      extensionUri: context.extensionUri,
      extensionPath: context.extensionPath,
      isActive: true,
      packageJSON: { version: '0.0.0', publisher: 'itsgeagle', name: 'provenance-recorder' },
      exports: undefined,
      activate: () => Promise.resolve(undefined),
      extensionKind: vscode.ExtensionKind.Workspace,
    } as vscode.Extension<unknown>);

  const extensionDistPath = path.join(context.extensionPath, 'dist');

  try {
    const { found, skipped } = await discoverManifests({
      workspaceFolders,
      findFiles: (include, exclude) =>
        Promise.resolve(vscode.workspace.findFiles(include, exclude)),
    });

    for (const skip of skipped) {
      console.error(`[provenance] activation skipped for ${skip.root}: ${skip.error.kind}`);
    }

    if (found.length === 0) {
      // No verified manifest anywhere — register the inactive stub once, using the
      // first skip reason if any, else a synthetic no_manifest_file (mirrors the
      // pre-nested-discovery single-root "nothing found" case).
      const reason: ActivationError = skipped[0]?.error ?? { kind: 'no_manifest_file' };
      registerInactiveStub(context.subscriptions, reason);
      return;
    }

    if (found.length > 0) {
      createRecordingStatusBar(context.subscriptions);
    }

    for (const { root, manifest } of found) {
      const session = await startSession({
        assignmentRoot: root,
        manifest,
        extension,
        vscodeVersion: vscode.version,
        platform: `${process.platform}-${process.arch}`,
        clock: new SystemClock(),
        extensionDistPath,
        isOwnedByThisRoot: (fsPath: string) =>
          resolveOwnerRoot(
            fsPath,
            found.map((f) => f.root),
          ) === root,
      });
      context.subscriptions.push(...session.ownDisposables);
      session.ownDisposables.length = 0;
      registry.add(session);
    }

    registerSealCommand(context, extensionDistPath);

    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void rescan(context, extensionDistPath, extension);
      }),
    );
  } catch (e) {
    console.error('[provenance] unexpected error during activation:', e);
  }
}

async function rescan(
  context: vscode.ExtensionContext,
  extensionDistPath: string,
  extension: vscode.Extension<unknown>,
): Promise<void> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const currentRoots = workspaceFolders.map((f) => f.uri.fsPath);

    // Stop sessions whose root left the workspace.
    await registry.pruneToRoots(currentRoots);

    // Start sessions for any newly-discovered root not already active.
    const { found } = await discoverManifests({
      workspaceFolders,
      findFiles: (include, exclude) =>
        Promise.resolve(vscode.workspace.findFiles(include, exclude)),
    });
    const allRoots = found.map((f) => f.root);

    for (const { root, manifest } of found) {
      if (registry.get(root) !== undefined) continue;
      const session = await startSession({
        assignmentRoot: root,
        manifest,
        extension,
        vscodeVersion: vscode.version,
        platform: `${process.platform}-${process.arch}`,
        clock: new SystemClock(),
        extensionDistPath,
        isOwnedByThisRoot: (fsPath: string) => resolveOwnerRoot(fsPath, allRoots) === root,
      });
      context.subscriptions.push(...session.ownDisposables);
      session.ownDisposables.length = 0;
      registry.add(session);
    }
  } catch (e) {
    console.error('[provenance] unexpected error during workspace-folder rescan:', e);
  }
}

/**
 * Registers the "Prepare Submission Bundle" command against the whole registry.
 * When more than one session is active, prompts the student via QuickPick to
 * choose which assignment to bundle (Task 11).
 */
function registerSealCommand(context: vscode.ExtensionContext, extensionDistPath: string): void {
  const sealCmd = vscode.commands.registerCommand(
    'provenance.prepareSubmissionBundle',
    async () => {
      const sessions = registry.all();
      if (sessions.length === 0) {
        void vscode.window.showWarningMessage('No session data to seal.');
        return;
      }

      const activeEditorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
      const chosen = await chooseSessionForSeal(
        sessions,
        (items, opts) => Promise.resolve(vscode.window.showQuickPick(items, opts)),
        activeEditorPath,
      );
      if (chosen === undefined) {
        if (sessions.length > 1) {
          // User dismissed the QuickPick — no message needed, they cancelled deliberately.
          return;
        }
        void vscode.window.showWarningMessage('No session data to seal.');
        return;
      }
      await chosen.writer.flush();

      const result = await sealBundle({
        assignmentRoot: chosen.assignmentRoot,
        provenanceDir: chosen.provenanceDir,
        assignmentId: chosen.manifest.assignment_id,
        semester: chosen.manifest.semester,
        filesUnderReview: chosen.manifest.files_under_review,
        sessionPrivkey: chosen.sessionKeypair.privateKey,
        sessionPubkeyHex: chosen.sessionKeypair.publicKeyHex,
        computeExtensionHash: () => computeExtensionHash(extensionDistPath),
        now: () => new Date(),
      });

      if (result.kind === 'ok') {
        void vscode.window.showInformationMessage(
          `Provenance bundle saved to ${result.bundlePath}`,
        );
        if (result.warnings.chainBroken || result.warnings.unreadableSession) {
          void vscode.window.showWarningMessage(
            'Provenance bundle produced. Integrity issues were detected in the recording and will be reviewed by course staff.',
          );
        }
      } else if (result.kind === 'no_sessions') {
        void vscode.window.showWarningMessage('No session data to seal.');
      } else if (result.kind === 'write_error') {
        void vscode.window.showErrorMessage(`Bundle write error: ${result.message}`);
      }
    },
  );
  context.subscriptions.push(sealCmd);
}

export async function deactivate(): Promise<void> {
  await registry.disposeAll();
}
