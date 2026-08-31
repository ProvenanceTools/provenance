import { describe, expect, it, vi } from 'vitest';
import {
  createPasteInterceptRegistrar,
  startPasteIntercept,
  PASTE_INTERCEPT_COMMAND_ID,
} from './paste-command-intercept.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDisposable() {
  let disposed = false;
  return {
    dispose: () => {
      disposed = true;
    },
    isDisposed: () => disposed,
  };
}

function makeDeps(nowMs = 1000) {
  let currentTime = nowMs;
  const registeredCommands = new Map<string, () => Thenable<unknown>>();
  const executedCommands: string[] = [];
  const disposable = makeDisposable();

  return {
    deps: {
      registerCommand: (id: string, handler: () => Thenable<unknown>) => {
        registeredCommands.set(id, handler);
        return disposable;
      },
      executeCommand: (id: string, ..._args: unknown[]) => {
        executedCommands.push(id);
        return Promise.resolve(undefined);
      },
      getNow: () => currentTime,
    },
    registeredCommands,
    executedCommands,
    disposable,
    setNow: (ms: number) => {
      currentTime = ms;
    },
    advanceTime: (ms: number) => {
      currentTime += ms;
    },
    /** Invoke the registered intercept command. */
    triggerCommand: () => {
      const handler = registeredCommands.get(PASTE_INTERCEPT_COMMAND_ID);
      if (handler === undefined) throw new Error('command not registered');
      return handler();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startPasteIntercept', () => {
  it('registers the provenance.internal.pasteIntercept command', () => {
    const { deps, registeredCommands } = makeDeps();
    startPasteIntercept(deps);
    expect(registeredCommands.has(PASTE_INTERCEPT_COMMAND_ID)).toBe(true);
  });

  it('interceptCount starts at 0', () => {
    const { deps } = makeDeps();
    const intercept = startPasteIntercept(deps);
    expect(intercept.interceptCount).toBe(0);
  });

  it('invoking the command increments interceptCount', async () => {
    const { deps, triggerCommand } = makeDeps();
    const intercept = startPasteIntercept(deps);
    await triggerCommand();
    expect(intercept.interceptCount).toBe(1);
    await triggerCommand();
    expect(intercept.interceptCount).toBe(2);
  });

  it('invoking the command forwards to editor.action.clipboardPasteAction', async () => {
    const { deps, executedCommands, triggerCommand } = makeDeps();
    startPasteIntercept(deps);
    await triggerCommand();
    expect(executedCommands).toContain('editor.action.clipboardPasteAction');
  });

  it('consumeIfPasteExpected returns false before any command invocation', () => {
    const { deps } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);
    expect(intercept.consumeIfPasteExpected(1000)).toBe(false);
  });

  it('consumeIfPasteExpected returns true within default 50ms window', async () => {
    const { deps, triggerCommand } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);
    await triggerCommand(); // sets pasteExpectedAtMs = 1000
    expect(intercept.consumeIfPasteExpected(1040)).toBe(true); // 40ms later — within window
  });

  it('consumeIfPasteExpected returns true at exactly withinMs', async () => {
    const { deps, triggerCommand } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);
    await triggerCommand();
    expect(intercept.consumeIfPasteExpected(1050)).toBe(true); // exactly 50ms
  });

  it('consumeIfPasteExpected returns false when window has expired', async () => {
    const { deps, triggerCommand } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);
    await triggerCommand();
    expect(intercept.consumeIfPasteExpected(1051)).toBe(false); // 51ms — expired
  });

  it('consumeIfPasteExpected consumes the flag (second call returns false)', async () => {
    const { deps, triggerCommand } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);
    await triggerCommand();
    expect(intercept.consumeIfPasteExpected(1020)).toBe(true); // consumes
    expect(intercept.consumeIfPasteExpected(1025)).toBe(false); // already consumed
  });

  it('custom withinMs window is respected', async () => {
    const { deps, triggerCommand, setNow } = makeDeps(1000);
    const intercept = startPasteIntercept(deps);

    // Invoke at t=1000; then check at t=1200 with window=100 → 200ms elapsed > window → false
    await triggerCommand(); // pasteExpectedAtMs = 1000
    expect(intercept.consumeIfPasteExpected(1200, 100)).toBe(false);

    // Invoke again at t=2000; check at t=2050 with window=100 → 50ms elapsed ≤ window → true
    setNow(2000);
    await triggerCommand(); // pasteExpectedAtMs = 2000
    expect(intercept.consumeIfPasteExpected(2050, 100)).toBe(true);
  });

  it('disposable from deps is returned as intercept.disposable', () => {
    const { deps, disposable } = makeDeps();
    const intercept = startPasteIntercept(deps);
    // The returned disposable should be the one the registerCommand produced
    intercept.disposable.dispose();
    expect(disposable.isDisposed()).toBe(true);
  });

  it('vi.fn() version: calls registerCommand exactly once', () => {
    const registerCommand = vi.fn(() => ({ dispose: vi.fn() }));
    const executeCommand = vi.fn(() => Promise.resolve(undefined));
    startPasteIntercept({ registerCommand, executeCommand, getNow: () => 0 });
    expect(registerCommand).toHaveBeenCalledOnce();
    expect(registerCommand).toHaveBeenCalledWith(PASTE_INTERCEPT_COMMAND_ID, expect.any(Function));
  });
});

// ---------------------------------------------------------------------------
// Shared registrar — regression coverage for the production crash
//
//   Error: command 'provenance.internal.pasteIntercept' already exists
//     at registerCommand → startPasteIntercept → startSession → async activate
//
// The command id is a fixed keybinding target, but startPasteIntercept runs once
// per session. Once nested manifest discovery let one opened course folder record
// several assignment roots, the SECOND session threw out of activate() — which is
// why students saw "Provenance: recording" with no working
// "Prepare Submission Bundle" command.
// ---------------------------------------------------------------------------

describe('createPasteInterceptRegistrar', () => {
  function makeHostDeps() {
    const registered = new Map<string, () => Thenable<unknown>>();
    const executed: string[] = [];
    let registerCalls = 0;
    let disposeCalls = 0;

    return {
      deps: {
        registerCommand: (id: string, handler: () => Thenable<unknown>) => {
          if (registered.has(id)) {
            // Exactly what the real extension host does.
            throw new Error(`command '${id}' already exists`);
          }
          registerCalls++;
          registered.set(id, handler);
          return {
            dispose: () => {
              disposeCalls++;
              registered.delete(id);
            },
          };
        },
        executeCommand: (id: string, ..._args: unknown[]) => {
          executed.push(id);
          return Promise.resolve(undefined);
        },
      },
      registered,
      executed,
      counts: () => ({ registerCalls, disposeCalls }),
      trigger: () => {
        const handler = registered.get(PASTE_INTERCEPT_COMMAND_ID);
        if (handler === undefined) throw new Error('command not registered');
        return handler();
      },
    };
  }

  it('a second session does not throw "already exists"', () => {
    const host = makeHostDeps();
    const registrar = createPasteInterceptRegistrar(host.deps);

    expect(() => {
      startPasteIntercept({ ...host.deps, getNow: () => 0, registrar });
      startPasteIntercept({ ...host.deps, getNow: () => 0, registrar });
      startPasteIntercept({ ...host.deps, getNow: () => 0, registrar });
    }).not.toThrow();

    expect(host.counts().registerCalls).toBe(1);
  });

  it('without the shared registrar a second session still throws (the shipped bug)', () => {
    // Pins WHY the registrar exists. This is exactly what startSession used to do
    // per session, and what the extension host did in response.
    const host = makeHostDeps();
    startPasteIntercept({ ...host.deps, getNow: () => 0 });
    expect(() => startPasteIntercept({ ...host.deps, getNow: () => 0 })).toThrow(/already exists/);
  });

  it('notifies every subscribed session but pastes exactly once', async () => {
    const host = makeHostDeps();
    const registrar = createPasteInterceptRegistrar(host.deps);
    const a = startPasteIntercept({ ...host.deps, getNow: () => 100, registrar });
    const b = startPasteIntercept({ ...host.deps, getNow: () => 100, registrar });

    await host.trigger();

    expect(a.consumeIfPasteExpected(100)).toBe(true);
    expect(b.consumeIfPasteExpected(100)).toBe(true);
    // One keystroke must produce one paste, not one per open assignment.
    expect(host.executed).toEqual(['editor.action.clipboardPasteAction']);
  });

  it('only the session owning the active editor counts the paste', async () => {
    const host = makeHostDeps();
    const registrar = createPasteInterceptRegistrar(host.deps);
    const mine = startPasteIntercept({
      ...host.deps,
      getNow: () => 100,
      registrar,
      isForThisSession: () => true,
    });
    const theirs = startPasteIntercept({
      ...host.deps,
      getNow: () => 100,
      registrar,
      isForThisSession: () => false,
    });

    await host.trigger();

    expect(mine.interceptCount).toBe(1);
    // Counting it here too would inflate the other assignment's intercept count
    // and make the reconciler raise paste.anomaly against an innocent student.
    expect(theirs.interceptCount).toBe(0);
    expect(theirs.consumeIfPasteExpected(100)).toBe(false);
  });

  it('releases the command only after the last session goes', () => {
    const host = makeHostDeps();
    const registrar = createPasteInterceptRegistrar(host.deps);
    const a = startPasteIntercept({ ...host.deps, getNow: () => 0, registrar });
    const b = startPasteIntercept({ ...host.deps, getNow: () => 0, registrar });

    a.disposable.dispose();
    expect(host.registered.has(PASTE_INTERCEPT_COMMAND_ID)).toBe(true);

    b.disposable.dispose();
    expect(host.registered.has(PASTE_INTERCEPT_COMMAND_ID)).toBe(false);
    expect(host.counts().disposeCalls).toBe(1);

    // And a later session can register again on the same registrar.
    expect(() => startPasteIntercept({ ...host.deps, getNow: () => 0, registrar })).not.toThrow();
  });
});
