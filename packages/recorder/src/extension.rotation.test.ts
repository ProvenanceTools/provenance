/**
 * Rotation orchestration in extension.ts (PRD §4.6, design §3.2).
 *
 * `rotate()` is deliberately not exported: it is reachable only through the
 * `requestRotation` callback that `startAndRegister` installs on every session,
 * which is exactly how production reaches it. These tests therefore drive the
 * real `activate()` with a fake `startSession` (the `ActivateWiring` seam that
 * activation.integration.test.ts already uses), capture the `requestRotation`
 * the extension handed to each session, and call it.
 *
 * What they pin, in order of how much it hurt to get wrong:
 *
 * 1. The predecessor's WIRING is actually disposed. `startAndRegister` hands
 *    `ownDisposables` to `context.subscriptions` and empties the array, so
 *    `dispose()`'s own LIFO teardown loop finds nothing — and nothing disposes
 *    `context.subscriptions` on a rotation. Without the fix the predecessor's doc
 *    wiring, fs watcher, heartbeat and peer watcher stayed subscribed for the
 *    editor's lifetime, throwing `append() called after dispose()` on every
 *    keystroke and witnessing the successor's own `.slog` as a peer file.
 * 2. End-then-start ordering, never the reverse.
 * 3. The successor is linked by `prev_session_id`.
 * 4. Re-entrancy and a stale `endedSessionId` are both refused.
 * 5. A successor that fails to start leaves NO session registered for that root.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { Manifest } from '@provenance/log-core';
import { activate, deactivate, activeSessionsForTest } from './extension.js';
import type { ActivateWiring } from './extension.js';
import type { startSession } from './session/session-registry.js';
import type { StartSessionDeps, ActiveSession } from './session/session-registry.js';

type StartCall = {
  deps: StartSessionDeps;
  session: ActiveSession;
};

describe('extension.ts — session rotation', () => {
  const root = path.join(os.tmpdir(), 'provenance-rotation-root');

  /** Everything that happened, in order, so ordering itself is assertable. */
  let trace: string[];
  let calls: StartCall[];
  /** The stand-in wiring disposable each fake session owns, by session id. */
  let wirings: Map<string, vscode.Disposable>;
  let context: vscode.ExtensionContext;
  /** Per start call, what the fake session should do — throw, or hang. */
  let startBehaviour: ((n: number) => Promise<void>) | undefined;

  function makeContext(): vscode.ExtensionContext {
    const store = new Map<string, unknown>();
    return {
      subscriptions: [] as vscode.Disposable[],
      extensionPath: '/fake/ext',
      extensionUri: { fsPath: '/fake/ext' },
      secrets: undefined,
      globalState: {
        get: (key: string) => store.get(key),
        update: (key: string, value: unknown) => {
          store.set(key, value);
          return Promise.resolve();
        },
      },
    } as unknown as vscode.ExtensionContext;
  }

  const manifest = {
    assignment_id: 'hw03',
    semester: 'fa26',
    issued_at: '2026-01-01T00:00:00Z',
    files_under_review: ['hw.py'],
    sig: 'deadbeef',
  } as unknown as Manifest;

  /**
   * A fake ActiveSession with ONE own-disposable that records its own teardown.
   * That disposable stands in for the real doc wiring: if it is never disposed,
   * the real one would still be subscribed.
   */
  function fakeSession(sessionId: string): ActiveSession {
    const wiring: vscode.Disposable = {
      dispose: () => {
        trace.push(`wiring-disposed:${sessionId}`);
      },
    };
    wirings.set(sessionId, wiring);
    return {
      assignmentRoot: root,
      sessionId,
      provenanceDir: path.join(root, '.provenance'),
      manifest,
      ownDisposables: [wiring],
      dispose: (reason?: string) => {
        trace.push(`session-disposed:${sessionId}:${reason ?? 'deactivate'}`);
        return Promise.resolve();
      },
    } as unknown as ActiveSession;
  }

  const fakeStart: typeof startSession = async (deps: StartSessionDeps) => {
    const n = calls.length;
    trace.push(`start:${n}:prev=${deps.prevSessionIdOverride ?? 'none'}`);
    if (startBehaviour !== undefined) await startBehaviour(n);
    const session = fakeSession(String.fromCharCode(65 + n)); // A, B, C…
    calls.push({ deps, session });
    return session;
  };

  const fakeDiscover: NonNullable<ActivateWiring['discoverManifests']> = () =>
    Promise.resolve({ found: [{ root, manifest }], skipped: [] });

  /** The `requestRotation` the extension installed on the n-th started session. */
  function requestRotationOf(n: number): (endedSessionId: string) => void {
    const fn = calls[n]?.deps.requestRotation;
    if (fn === undefined) throw new Error(`no requestRotation captured for start #${n}`);
    return fn;
  }

  beforeEach(async () => {
    trace = [];
    calls = [];
    wirings = new Map();
    startBehaviour = undefined;
    context = makeContext();
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: root }, name: 'root', index: 0 },
    ];
    await activate(context, { discoverManifests: fakeDiscover, startSession: fakeStart });
    expect(calls).toHaveLength(1);
  });

  afterEach(async () => {
    // Clears the module-level registry and rotation bookkeeping.
    await deactivate();
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
    vi.restoreAllMocks();
  });

  /** A rotation is requested synchronously from onEntry; let its promise settle. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('ends the predecessor, disposes its wiring, then starts a linked successor', async () => {
    requestRotationOf(0)('A');
    await settle();

    // Ordering: the predecessor is fully torn down BEFORE the successor starts.
    // Reversing it would leave two doc wirings subscribed and record one
    // keystroke into two logs.
    expect(trace).toEqual([
      'start:0:prev=none',
      'session-disposed:A:rotate',
      'wiring-disposed:A',
      'start:1:prev=A',
    ]);

    // The successor replaced the predecessor for this root.
    expect(activeSessionsForTest()).toEqual([{ root, sessionId: 'B' }]);

    // The successor also skips chain recovery (design §3.3 mechanism 2): it was
    // handed its predecessor's id, and re-validating a 40 MiB log with no wiring
    // attached is the largest term in the window where a keystroke can be lost.
    expect(calls[1]!.deps.skipChainRecovery).toBe(true);
    // An ordinary (non-rotation) start must NOT skip it.
    expect(calls[0]!.deps.skipChainRecovery).toBeUndefined();
    expect(calls[0]!.deps.prevSessionIdOverride).toBeUndefined();
  });

  it("disposes the predecessor's context-owned disposables and drops them from context", async () => {
    // This is the regression the leak review found: `startAndRegister` empties
    // ownDisposables, so ONLY the rotation path can dispose them.
    const wiringA = wirings.get('A')!;
    expect(calls[0]!.session.ownDisposables).toEqual([]); // handed to context
    expect(context.subscriptions).toContain(wiringA);
    expect(trace).not.toContain('wiring-disposed:A');

    const before = context.subscriptions.length;
    requestRotationOf(0)('A');
    await settle();

    expect(trace).toContain('wiring-disposed:A');
    // It must be GONE from context.subscriptions: VS Code's own teardown would
    // otherwise dispose an already-disposed wiring at shutdown.
    expect(context.subscriptions).not.toContain(wiringA);
    expect(context.subscriptions).toContain(wirings.get('B'));
    // Exactly one wiring left context.subscriptions and exactly one joined it, so
    // the array does not grow by a wiring set per rotation, and VS Code's own
    // teardown cannot dispose the dead one a second time.
    expect(context.subscriptions).toHaveLength(before);
  });

  it('ignores a rotation request naming a session that is no longer current', async () => {
    requestRotationOf(0)('A');
    await settle();
    trace.length = 0;

    // The predecessor's callback firing again after the swap (a queued request
    // from the old session) must not tear down the successor.
    requestRotationOf(0)('A');
    await settle();

    expect(trace).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(activeSessionsForTest()).toEqual([{ root, sessionId: 'B' }]);
  });

  it('ignores a second rotation request for the same root while one is in flight', async () => {
    // Hold the successor's start open so both requests are genuinely concurrent.
    let release: (() => void) | undefined;
    startBehaviour = (n) =>
      n === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();

    requestRotationOf(0)('A');
    await settle();
    requestRotationOf(0)('A');
    await settle();

    release?.();
    await settle();

    // One dispose, one successor — not two.
    expect(trace.filter((t) => t === 'session-disposed:A:rotate')).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(activeSessionsForTest()).toEqual([{ root, sessionId: 'B' }]);
  });

  it('registers NO session for the root when the successor fails to start', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    startBehaviour = (n) => (n === 1 ? Promise.reject(new Error('ENOSPC')) : Promise.resolve());

    requestRotationOf(0)('A');
    await settle();

    // The predecessor is sealed and gone; nothing is left claiming to record.
    expect(trace).toContain('session-disposed:A:rotate');
    expect(trace).toContain('wiring-disposed:A');
    expect(activeSessionsForTest()).toEqual([]);
    // The student is told, exactly as the activation loop tells them.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalled();
  });

  it('can rotate again after a successful rotation', async () => {
    requestRotationOf(0)('A');
    await settle();
    trace.length = 0;

    requestRotationOf(1)('B');
    await settle();

    expect(trace).toEqual(['session-disposed:B:rotate', 'wiring-disposed:B', 'start:2:prev=B']);
    expect(activeSessionsForTest()).toEqual([{ root, sessionId: 'C' }]);
  });

  // -------------------------------------------------------------------------
  // Abandonment (design §3.2 item 3) — review finding F2.
  // -------------------------------------------------------------------------

  it('abandons a rotation in flight when the extension deactivates, leaving nothing dangling', async () => {
    // The window: a student closes the editor while the successor is starting.
    // `registry.disposeAll()` cannot reach a session that is not registered yet, so
    // without abandonment the successor is registered AFTER teardown and the
    // process exits with its session.end never written — the student's next launch
    // then reports `previous_session_dangling`, a crash-shaped session produced by
    // closing a window normally.
    let release: (() => void) | undefined;
    startBehaviour = (n) =>
      n === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();

    requestRotationOf(0)('A');
    await settle();
    // Predecessor already sealed; the successor's start is hanging.
    expect(trace).toContain('session-disposed:A:rotate');
    expect(calls).toHaveLength(1);

    // The window closes here.
    const shuttingDown = deactivate();
    await settle();
    release?.();
    await shuttingDown;

    // The successor was started (the start had already been entered) — so it must
    // have been torn down, with its session.end written, and it must not be left
    // registered after teardown.
    expect(calls).toHaveLength(2);
    expect(trace).toContain('session-disposed:B:deactivate');
    expect(trace).toContain('wiring-disposed:B');
    expect(activeSessionsForTest()).toEqual([]);
    // Nothing of that session is left in context.subscriptions either.
    expect(context.subscriptions).not.toContain(wirings.get('B'));
  });

  it('does not start a successor at all when deactivation lands before the start', async () => {
    // Same abandonment, one step earlier: the predecessor's teardown is what is in
    // flight. Starting a successor here would only create something else to stop.
    let release: (() => void) | undefined;
    calls[0]!.session.dispose = (reason?: string) => {
      trace.push(`session-disposed:A:${reason ?? 'deactivate'}`);
      return new Promise<void>((resolve) => (release = resolve));
    };

    requestRotationOf(0)('A');
    await settle();
    const shuttingDown = deactivate();
    await settle();
    release?.();
    await shuttingDown;

    // No second start, and no session left registered.
    expect(calls).toHaveLength(1);
    expect(trace.filter((t) => t.startsWith('start:'))).toEqual(['start:0:prev=none']);
    expect(activeSessionsForTest()).toEqual([]);
  });
});
