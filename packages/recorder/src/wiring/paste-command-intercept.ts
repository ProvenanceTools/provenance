/**
 * Paste command intercept — signal 2 of three-signal paste detection (PRD §4.3).
 *
 * PRD §4.3: "Register a command handler that wraps the default
 * editor.action.clipboardPasteAction and emits a paste marker immediately
 * before the resulting doc.change fires."
 *
 * VS CODE LIMITATION (surfaced per CLAUDE.md):
 * VS Code does NOT allow re-registering or overriding built-in command IDs
 * (e.g. 'editor.action.clipboardPasteAction'). Calling
 * vscode.commands.registerCommand with a built-in ID will throw
 * "command already registered" in the extension host. This is a hard VS Code
 * API constraint; there is no workaround short of using an undocumented
 * internal API that could break in any VS Code update.
 *
 * v1 approach:
 * We register a SEPARATE provenance command ('provenance.internal.pasteIntercept')
 * that explicitly calls clipboardPasteAction under the hood. Course staff can
 * bind this command to Cmd+V / Ctrl+V via a workspace keybindings.json if they
 * want higher-fidelity signal 2. When invoked it:
 *   1. Sets a "paste expected" timestamp.
 *   2. Increments the interceptCount.
 *   3. Executes 'editor.action.clipboardPasteAction'.
 *
 * For sessions where the keybinding is not installed, signal 2 contributes 0
 * to the intercept count and signal 3 (reconciler) will detect the mismatch,
 * surfacing it as paste.anomaly events rather than silently misclassifying.
 *
 * The three-signal rule is preserved: signal 1 (size heuristic) + signal 3
 * (reconciler) still function regardless of whether signal 2 fires.
 */

import type * as vscode from 'vscode';

export type PasteIntercept = {
  disposable: vscode.Disposable;
  /**
   * Returns true if the most recent doc.change should be considered a
   * confirmed paste (command was invoked within `withinMs` ms of `now`).
   * Consumes the flag — a single intercept matches at most one doc.change.
   */
  consumeIfPasteExpected(now: number, withinMs?: number): boolean;
  /** How many times the paste command has been invoked since start. */
  readonly interceptCount: number;
};

export type PasteInterceptDeps = {
  registerCommand: (id: string, handler: () => Thenable<unknown>) => vscode.Disposable;
  executeCommand: (id: string, ...args: unknown[]) => Thenable<unknown>;
  getNow: () => number;
  /**
   * Shared owner of the ONE VS Code registration of
   * {@link PASTE_INTERCEPT_COMMAND_ID}. Supply this whenever more than one
   * session can be alive at once — see {@link createPasteInterceptRegistrar}.
   *
   * Omitted, each call registers the command for itself, which is correct for a
   * lone session and for tests, and is what every existing caller relies on.
   */
  registrar?: PasteInterceptRegistrar;
  /**
   * Whether the paste being intercepted belongs to THIS session. Nested
   * discovery means several assignment roots record concurrently, but a paste
   * lands in exactly one document and so in exactly one session: counting it in
   * all of them would inflate every other session's intercept count and make
   * signal 3 (the reconciler) report paste.anomaly against a student who did
   * nothing. Defaults to always-mine, which is exactly right when there is only
   * one session.
   */
  isForThisSession?: () => boolean;
};

/**
 * Owner of the single VS Code registration of {@link PASTE_INTERCEPT_COMMAND_ID},
 * fanning invocations out to every subscribed session.
 *
 * `provenance.internal.pasteIntercept` is a KEYBINDING TARGET — course staff bind
 * Cmd+V/Ctrl+V to it by name — so its id is fixed and global, while
 * `startPasteIntercept` is called once per recording session. Registering it per
 * session therefore threw
 *
 *     Error: command 'provenance.internal.pasteIntercept' already exists
 *
 * out of the SECOND session's startSession() as soon as nested manifest discovery
 * let one opened course folder record more than one assignment. That throw
 * propagated out of activate(), which is how students ended up with a status bar
 * reading "Provenance: recording" and no working "Prepare Submission Bundle"
 * command. This type makes the registration what it always was in reality: one
 * per extension host, shared.
 */
export type PasteInterceptRegistrar = {
  /**
   * Register `onInvoked` to run when the paste command fires. Registers the VS
   * Code command on the first subscriber and disposes it after the last one
   * leaves, so a host that ends up with no sessions holds no command.
   */
  subscribe(onInvoked: () => void): vscode.Disposable;
};

/**
 * Create a registrar owning one registration of {@link PASTE_INTERCEPT_COMMAND_ID}.
 *
 * The underlying `editor.action.clipboardPasteAction` runs EXACTLY ONCE per
 * invocation no matter how many sessions are subscribed — the registrar performs
 * it, not the subscribers. A subscriber that also pasted would paste once per
 * open assignment.
 */
export function createPasteInterceptRegistrar(deps: {
  registerCommand: (id: string, handler: () => Thenable<unknown>) => vscode.Disposable;
  executeCommand: (id: string, ...args: unknown[]) => Thenable<unknown>;
}): PasteInterceptRegistrar {
  const subscribers = new Set<() => void>();
  let registration: vscode.Disposable | null = null;

  return {
    subscribe(onInvoked: () => void): vscode.Disposable {
      if (registration === null) {
        registration = deps.registerCommand(PASTE_INTERCEPT_COMMAND_ID, async () => {
          // Snapshot: a subscriber disposing during dispatch must not perturb
          // the iteration.
          for (const notify of [...subscribers]) notify();
          return deps.executeCommand('editor.action.clipboardPasteAction');
        });
      }
      subscribers.add(onInvoked);

      let disposed = false;
      return {
        dispose: (): void => {
          if (disposed) return;
          disposed = true;
          subscribers.delete(onInvoked);
          if (subscribers.size === 0 && registration !== null) {
            registration.dispose();
            registration = null;
          }
        },
      };
    },
  };
}

/** The VS Code command ID for the internal paste intercept. */
export const PASTE_INTERCEPT_COMMAND_ID = 'provenance.internal.pasteIntercept';

/**
 * Register the provenance paste-intercept command and return a PasteIntercept
 * handle that the doc-change handler can query.
 */
export function startPasteIntercept(deps: PasteInterceptDeps): PasteIntercept {
  const { getNow } = deps;
  // No registrar supplied: own the registration privately. Identical behaviour to
  // before for a lone session, and for every existing test.
  const registrar = deps.registrar ?? createPasteInterceptRegistrar(deps);
  const isForThisSession = deps.isForThisSession ?? ((): boolean => true);

  let pasteExpectedAtMs: number | null = null;
  let _interceptCount = 0;

  const commandDisposable = registrar.subscribe(() => {
    if (!isForThisSession()) return;
    pasteExpectedAtMs = getNow();
    _interceptCount++;
  });

  return {
    disposable: commandDisposable,

    consumeIfPasteExpected(now: number, withinMs = 50): boolean {
      if (pasteExpectedAtMs === null) {
        return false;
      }
      const elapsed = now - pasteExpectedAtMs;
      if (elapsed <= withinMs) {
        pasteExpectedAtMs = null; // consume
        return true;
      }
      // Expired — clear the stale flag so it doesn't block future checks
      pasteExpectedAtMs = null;
      return false;
    },

    get interceptCount(): number {
      return _interceptCount;
    },
  };
}
