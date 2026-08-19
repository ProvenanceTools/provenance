import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { startGitWiring } from './git-wiring.js';
import { isRepoOwnedByRoot, resolveOwnerRoot } from '../session/session-router.js';
import { ExplanationTagger } from '../events/explanation-tags.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StateChangeHandler = () => void;

type FakeRepo = {
  rootUri: { fsPath: string };
  state: {
    HEAD: { commit: string | undefined };
    _handlers: StateChangeHandler[];
    onDidChange: (h: StateChangeHandler) => vscode.Disposable;
  };
  fireStateChange: () => void;
  setCommit: (sha: string | undefined) => void;
};

function makeFakeRepo(initialCommit?: string, rootFsPath = '/ws/fake'): FakeRepo {
  const _handlers: StateChangeHandler[] = [];
  const state: FakeRepo['state'] = {
    HEAD: { commit: initialCommit },
    _handlers,
    onDidChange: (h: StateChangeHandler) => {
      _handlers.push(h);
      return { dispose: () => undefined };
    },
  };
  return {
    rootUri: { fsPath: rootFsPath },
    state,
    fireStateChange: () => _handlers.forEach((h) => h()),
    setCommit: (sha: string | undefined) => {
      state.HEAD = { commit: sha };
    },
  };
}

type OpenHandler = (repo: unknown) => void;

function makeGitExtension(
  repos: FakeRepo[],
  opts?: { throwOnGetAPI?: boolean },
): vscode.Extension<unknown> {
  let openHandler: OpenHandler | undefined;
  return {
    id: 'vscode.git',
    isActive: true,
    extensionUri: {} as vscode.Uri,
    extensionPath: '',
    extensionKind: 2,
    exports: {
      getAPI: (v: number) => {
        if (opts?.throwOnGetAPI) throw new Error('API not available');
        if (v !== 1) return undefined;
        return {
          repositories: repos,
          onDidOpenRepository: (h: OpenHandler) => {
            openHandler = h;
            return { dispose: () => undefined };
          },
          onDidCloseRepository: (_h: unknown) => ({ dispose: () => undefined }),
          _fireOpen: (repo: unknown) => openHandler?.(repo),
        };
      },
    },
    packageJSON: {},
    activate: () => Promise.resolve(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startGitWiring — no git extension', () => {
  it('returns a no-op disposable when getGitExtension returns undefined', () => {
    const emitted: unknown[] = [];
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => undefined,
    });
    // Dispose should not throw.
    expect(() => wiring.dispose()).not.toThrow();
    expect(emitted).toHaveLength(0);
  });

  it('returns a no-op disposable when getAPI throws', () => {
    const emitted: unknown[] = [];
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => makeGitExtension([], { throwOnGetAPI: true }),
    });
    expect(() => wiring.dispose()).not.toThrow();
    expect(emitted).toHaveLength(0);
  });
});

// NOTE — the five tests below CHANGED MEANING with S5. They previously asserted
// that `emit` had been called by the time `fireStateChange()` returned. Emission
// is now asynchronous, because `parents` requires the git API's async
// `getCommit`; each therefore awaits `wiring.settled()` first. What is asserted
// about the payload is unchanged, and the synchronous half of the handler
// (the explanation tagger's markGit) is still asserted synchronously — see
// 'marks the explanation tagger SYNCHRONOUSLY' below.
describe('startGitWiring — state change events', () => {
  it('emits git.event with operation "state_change" and commit_sha on HEAD change', async () => {
    const emitted: Array<{ operation: string; commit_sha?: string }> = [];
    const repo = makeFakeRepo('abc123');
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => makeGitExtension([repo]),
    });
    repo.setCommit('def456');
    repo.fireStateChange();
    await wiring.settled();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.operation).toBe('state_change');
    expect(emitted[0]!.commit_sha).toBe('def456');
  });

  it('omits commit_sha when HEAD.commit is undefined', async () => {
    const emitted: Array<{ operation: string; commit_sha?: string }> = [];
    const repo = makeFakeRepo(undefined);
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => makeGitExtension([repo]),
    });
    repo.fireStateChange();
    await wiring.settled();
    expect(emitted[0]).not.toHaveProperty('commit_sha');
  });

  it('calls explanationTagger.markGit() on each emitted git.event', () => {
    const tagger = new ExplanationTagger({ getNow: () => Date.now() });
    const markGit = vi.spyOn(tagger, 'markGit');
    const repo = makeFakeRepo('sha1');
    startGitWiring({
      emit: () => undefined,
      getGitExtension: () => makeGitExtension([repo]),
      explanationTagger: tagger,
    });
    repo.setCommit('sha2');
    repo.fireStateChange();
    expect(markGit).toHaveBeenCalledOnce();
  });

  it('emits for multiple repositories', async () => {
    const emitted: unknown[] = [];
    const repo1 = makeFakeRepo('sha-a');
    const repo2 = makeFakeRepo('sha-b');
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => makeGitExtension([repo1, repo2]),
    });
    repo1.setCommit('sha-a2');
    repo1.fireStateChange();
    repo2.setCommit('sha-b2');
    repo2.fireStateChange();
    await wiring.settled();
    expect(emitted).toHaveLength(2);
  });

  it('disposes all subscriptions on dispose()', () => {
    const emitted: unknown[] = [];
    const repo = makeFakeRepo('sha1');
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => makeGitExtension([repo]),
    });
    wiring.dispose();
    repo.setCommit('sha2');
    repo.fireStateChange();
    // After dispose, state change handler should be removed from the disposables
    // but the actual onDidChange handlers in our fake remain subscribed.
    // The key check is that dispose() does not throw.
    expect(() => wiring.dispose()).not.toThrow();
  });
});

describe('rootUri-based ownership routing', () => {
  function makeRepo(rootFsPath: string, initialCommit?: string) {
    let changeHandler: (() => void) | undefined;
    const repo = {
      rootUri: { fsPath: rootFsPath },
      state: {
        HEAD: initialCommit !== undefined ? { commit: initialCommit } : undefined,
        onDidChange: (h: () => void) => {
          changeHandler = h;
          return { dispose() {} };
        },
      },
    };
    return {
      repo,
      fireChange: (commit?: string) => {
        if (commit !== undefined) repo.state.HEAD = { commit };
        changeHandler?.();
      },
    };
  }

  it('emits git.event when the repo rootUri is owned', async () => {
    const emit = vi.fn();
    const { repo, fireChange } = makeRepo('/ws/cats', 'abc');
    const wiring = startGitWiring({
      emit,
      getGitExtension: () =>
        ({
          exports: {
            getAPI: () => ({ repositories: [repo], onDidOpenRepository: () => ({ dispose() {} }) }),
          },
        }) as unknown as import('vscode').Extension<unknown>,
      isRepoOwnedByThisRoot: (fsPath) => fsPath === '/ws/cats',
    });
    fireChange('def');
    await wiring.settled();
    expect(emit).toHaveBeenCalledOnce();
  });

  it('drops git.event when the repo rootUri is owned by no session', () => {
    const emit = vi.fn();
    const { repo, fireChange } = makeRepo('/ws/parent', 'abc');
    startGitWiring({
      emit,
      getGitExtension: () =>
        ({
          exports: {
            getAPI: () => ({ repositories: [repo], onDidOpenRepository: () => ({ dispose() {} }) }),
          },
        }) as unknown as import('vscode').Extension<unknown>,
      isRepoOwnedByThisRoot: (fsPath) => fsPath === '/ws/cats',
    });
    fireChange('def');
    expect(emit).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Nested assignment inside a shared repository — the layout 61B/61C actually
  // ship, and the one for which git capture was silently 100% off.
  //
  // These wire the REAL predicate rather than a hand-written lambda, because the
  // defect was never in git-wiring's own logic: it was in which predicate the
  // caller handed it. A test that fakes the predicate cannot catch that.
  // -------------------------------------------------------------------------

  function makeExtension(repo: unknown) {
    return {
      exports: {
        getAPI: () => ({ repositories: [repo], onDidOpenRepository: () => ({ dispose() {} }) }),
      },
    } as unknown as import('vscode').Extension<unknown>;
  }

  const REPO_ROOT = path.join('/ws', 'cs61b-repo');
  const PROJ1 = path.join(REPO_ROOT, 'proj1');
  const PROJ2 = path.join(REPO_ROOT, 'proj2');

  it('emits git.event when the assignment root is NESTED inside the repo root', async () => {
    const emit = vi.fn();
    const { repo, fireChange } = makeRepo(REPO_ROOT, 'abc');
    const wiring = startGitWiring({
      emit,
      getGitExtension: () => makeExtension(repo),
      isRepoOwnedByThisRoot: (p) => isRepoOwnedByRoot(p, PROJ2, [PROJ1, PROJ2]),
    });
    fireChange('def');
    await wiring.settled();
    expect(emit).toHaveBeenCalledOnce();
  });

  it('is the exact call that dropped every git.event before the fix', async () => {
    // Reproduces the shipped wiring: `resolveOwnerRoot(repoRoot, roots) === root`.
    // A repo root is an ANCESTOR of the assignment, so no root contains it, the
    // comparison is `null === PROJ2`, and the handler returns early.
    const emit = vi.fn();
    const { repo, fireChange } = makeRepo(REPO_ROOT, 'abc');
    const wiring = startGitWiring({
      emit,
      getGitExtension: () => makeExtension(repo),
      isRepoOwnedByThisRoot: (p) => resolveOwnerRoot(p, [PROJ1, PROJ2]) === PROJ2,
    });
    fireChange('def');
    await wiring.settled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits into every concurrently-recording assignment under the one repo', async () => {
    const emitProj1 = vi.fn();
    const emitProj2 = vi.fn();
    const a = makeRepo(REPO_ROOT, 'abc');
    const b = makeRepo(REPO_ROOT, 'abc');
    const w1 = startGitWiring({
      emit: emitProj1,
      getGitExtension: () => makeExtension(a.repo),
      isRepoOwnedByThisRoot: (p) => isRepoOwnedByRoot(p, PROJ1, [PROJ1, PROJ2]),
    });
    const w2 = startGitWiring({
      emit: emitProj2,
      getGitExtension: () => makeExtension(b.repo),
      isRepoOwnedByThisRoot: (p) => isRepoOwnedByRoot(p, PROJ2, [PROJ1, PROJ2]),
    });
    a.fireChange('def');
    b.fireChange('def');
    await Promise.all([w1.settled(), w2.settled()]);
    expect(emitProj1).toHaveBeenCalledOnce();
    expect(emitProj2).toHaveBeenCalledOnce();
  });

  it('still drops an UNRELATED repository the session does not own', async () => {
    // The reason the check exists. Widening ownership to ancestors must not
    // widen it to "any repository open in the window".
    const emit = vi.fn();
    const { repo, fireChange } = makeRepo(path.join('/ws', 'unrelated-repo'), 'abc');
    const wiring = startGitWiring({
      emit,
      getGitExtension: () => makeExtension(repo),
      isRepoOwnedByThisRoot: (p) => isRepoOwnedByRoot(p, PROJ2, [PROJ1, PROJ2]),
    });
    fireChange('def');
    await wiring.settled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('still drops a SIBLING assignment folder that is its own repository', async () => {
    const emit = vi.fn();
    const { repo, fireChange } = makeRepo(PROJ1, 'abc');
    const wiring = startGitWiring({
      emit,
      getGitExtension: () => makeExtension(repo),
      isRepoOwnedByThisRoot: (p) => isRepoOwnedByRoot(p, PROJ2, [PROJ1, PROJ2]),
    });
    fireChange('def');
    await wiring.settled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('defaults to owning everything when isRepoOwnedByThisRoot is omitted (regression)', async () => {
    const emit = vi.fn();
    const { repo, fireChange } = makeRepo('/ws/hw03', 'abc');
    const wiring = startGitWiring({
      emit,
      getGitExtension: () =>
        ({
          exports: {
            getAPI: () => ({ repositories: [repo], onDidOpenRepository: () => ({ dispose() {} }) }),
          },
        }) as unknown as import('vscode').Extension<unknown>,
    });
    fireChange('def');
    await wiring.settled();
    expect(emit).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// S5 — the commit graph (sha / parents / branch)
// ---------------------------------------------------------------------------

/**
 * A repo whose `getCommit` behaves like VS Code's git API: async, and returning
 * a Commit object that ALSO carries author identity. The fake deliberately
 * includes `authorName`/`authorEmail` so the tests below can prove the recorder
 * does not read them — a fake that omitted them could not prove anything.
 */
function makeGraphRepo(opts: {
  commit?: string | undefined;
  branch?: string | undefined;
  parents?: Record<string, string[]> | undefined;
  rootFsPath?: string | undefined;
  getCommitRejects?: boolean | undefined;
  omitGetCommit?: boolean | undefined;
}) {
  let changeHandler: (() => void) | undefined;
  const state = {
    HEAD: { commit: opts.commit, name: opts.branch } as {
      commit?: string | undefined;
      name?: string | undefined;
    },
    onDidChange: (h: () => void) => {
      changeHandler = h;
      return { dispose() {} };
    },
  };
  const repo: Record<string, unknown> = {
    rootUri: { fsPath: opts.rootFsPath ?? '/ws/repo' },
    state,
  };
  if (opts.omitGetCommit !== true) {
    repo['getCommit'] = (ref: string) => {
      if (opts.getCommitRejects === true) return Promise.reject(new Error('bad object'));
      return Promise.resolve({
        hash: ref,
        parents: opts.parents?.[ref] ?? [],
        message: 'some commit message',
        // Present on the real API. The recorder must never read these.
        authorName: 'Ada Lovelace',
        authorEmail: 'ada@berkeley.edu',
        authorDate: new Date(0),
      });
    };
  }
  return {
    repo,
    setHead: (commit?: string, branch?: string) => {
      state.HEAD = { commit, name: branch };
    },
    fire: () => changeHandler?.(),
  };
}

function graphExtension(repo: unknown): vscode.Extension<unknown> {
  return {
    exports: {
      getAPI: () => ({ repositories: [repo], onDidOpenRepository: () => ({ dispose() {} }) }),
    },
  } as unknown as vscode.Extension<unknown>;
}

describe('startGitWiring — commit graph (program spec S5)', () => {
  it('captures sha, parents and branch', async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const g = makeGraphRepo({
      commit: 'a'.repeat(40),
      branch: 'main',
      parents: { ['c'.repeat(40)]: ['a'.repeat(40), 'b'.repeat(40)] },
    });
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d as Record<string, unknown>),
      getGitExtension: () => graphExtension(g.repo),
    });

    g.setHead('c'.repeat(40), 'main');
    g.fire();
    await wiring.settled();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!['sha']).toBe('c'.repeat(40));
    expect(emitted[0]!['parents']).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    expect(emitted[0]!['branch']).toBe('main');
    // Still emitted, for 1.x readers.
    expect(emitted[0]!['commit_sha']).toBe('c'.repeat(40));
  });

  it('NEVER captures git author name or email', async () => {
    // The hard constraint: the approved CPHS protocol treats a new category of
    // identifier as requiring a filed modification BEFORE implementation, and
    // author identity is exactly that. The fake's getCommit returns both.
    const emitted: Array<Record<string, unknown>> = [];
    const g = makeGraphRepo({ commit: 'a'.repeat(40), branch: 'main' });
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d as Record<string, unknown>),
      getGitExtension: () => graphExtension(g.repo),
    });

    g.setHead('b'.repeat(40), 'main');
    g.fire();
    await wiring.settled();

    const payload = emitted[0]!;
    expect(Object.keys(payload).sort()).toEqual([
      'branch',
      'commit_sha',
      'operation',
      'parents',
      'sha',
    ]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('Ada');
    expect(serialized).not.toContain('ada@berkeley.edu');
    expect(serialized).not.toContain('some commit message');
  });

  it('records a root commit as an EMPTY parents array', async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const g = makeGraphRepo({ commit: undefined, parents: { ['a'.repeat(40)]: [] } });
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d as Record<string, unknown>),
      getGitExtension: () => graphExtension(g.repo),
    });

    g.setHead('a'.repeat(40), 'main');
    g.fire();
    await wiring.settled();

    // [] means "genuinely no parents"; absent means "could not read". The two
    // must stay distinguishable.
    expect(emitted[0]!['parents']).toEqual([]);
  });

  it('OMITS parents when getCommit fails, rather than claiming a root commit', async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const g = makeGraphRepo({ commit: 'a'.repeat(40), branch: 'main', getCommitRejects: true });
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d as Record<string, unknown>),
      getGitExtension: () => graphExtension(g.repo),
    });

    g.setHead('b'.repeat(40), 'main');
    g.fire();
    await wiring.settled();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).not.toHaveProperty('parents');
    // The rest of the event still lands — a graph read failure must not lose it.
    expect(emitted[0]!['sha']).toBe('b'.repeat(40));
  });

  it('still emits when the git API predates getCommit', async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const g = makeGraphRepo({ commit: 'a'.repeat(40), branch: 'main', omitGetCommit: true });
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d as Record<string, unknown>),
      getGitExtension: () => graphExtension(g.repo),
    });

    g.setHead('b'.repeat(40), 'main');
    g.fire();
    await wiring.settled();

    expect(emitted[0]!['sha']).toBe('b'.repeat(40));
    expect(emitted[0]).not.toHaveProperty('parents');
  });

  it('OMITS branch when HEAD is detached, rather than inventing one', async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const g = makeGraphRepo({ commit: 'a'.repeat(40), branch: undefined });
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d as Record<string, unknown>),
      getGitExtension: () => graphExtension(g.repo),
    });

    g.setHead('b'.repeat(40), undefined);
    g.fire();
    await wiring.settled();

    expect(emitted[0]).not.toHaveProperty('branch');
  });

  it('omits sha and parents entirely when HEAD has no commit', async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const g = makeGraphRepo({ commit: undefined, branch: 'main' });
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d as Record<string, unknown>),
      getGitExtension: () => graphExtension(g.repo),
    });

    g.fire();
    await wiring.settled();

    expect(emitted[0]).not.toHaveProperty('sha');
    expect(emitted[0]).not.toHaveProperty('commit_sha');
    expect(emitted[0]).not.toHaveProperty('parents');
    expect(emitted[0]!['branch']).toBe('main');
  });

  it('emits in the order the state changes fired, despite the async parent read', async () => {
    // Log entries are ordered. An unserialized async read would let a fast
    // getCommit overtake a slow one and write the graph out of order.
    const emitted: Array<Record<string, unknown>> = [];
    let resolveFirst: ((v: unknown) => void) | undefined;
    let call = 0;

    let changeHandler: (() => void) | undefined;
    const state = {
      HEAD: { commit: 'x', name: 'main' } as {
        commit?: string | undefined;
        name?: string | undefined;
      },
      onDidChange: (h: () => void) => {
        changeHandler = h;
        return { dispose() {} };
      },
    };
    const repo = {
      rootUri: { fsPath: '/ws/repo' },
      state,
      getCommit: (ref: string) => {
        call += 1;
        if (call === 1) {
          return new Promise((res) => {
            resolveFirst = res as (v: unknown) => void;
          }).then(() => ({ hash: ref, parents: ['1'.repeat(40)] }));
        }
        return Promise.resolve({ hash: ref, parents: ['2'.repeat(40)] });
      },
    };

    const wiring = startGitWiring({
      emit: (d) => emitted.push(d as Record<string, unknown>),
      getGitExtension: () => graphExtension(repo),
    });

    state.HEAD = { commit: 'a'.repeat(40), name: 'main' };
    changeHandler?.();
    state.HEAD = { commit: 'b'.repeat(40), name: 'main' };
    changeHandler?.();

    // Let the queued handlers start, so the first getCommit has actually been
    // called and handed us its resolver.
    await new Promise((r) => setTimeout(r, 0));

    // The SECOND read resolves immediately; the first is still pending. If the
    // handler were not serialized, the second event would be emitted first.
    resolveFirst?.(undefined);
    await wiring.settled();

    expect(emitted.map((e) => e['sha'])).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });

  it('marks the explanation tagger SYNCHRONOUSLY, before the async parent read', () => {
    // markGit() suppresses fs.external_change false positives from the file
    // writes a checkout performs. Those writes land immediately, so deferring
    // the mark behind an await would reintroduce the false positives the tagger
    // exists to prevent. Note: no `await` here — that is the assertion.
    const tagger = new ExplanationTagger({ getNow: () => Date.now() });
    const markGit = vi.spyOn(tagger, 'markGit');
    const g = makeGraphRepo({ commit: 'a'.repeat(40), branch: 'main' });
    startGitWiring({
      emit: () => undefined,
      getGitExtension: () => graphExtension(g.repo),
      explanationTagger: tagger,
    });

    g.setHead('b'.repeat(40), 'main');
    g.fire();
    expect(markGit).toHaveBeenCalledOnce();
  });

  it('does not emit after dispose(), even for an in-flight parent read', async () => {
    const emitted: unknown[] = [];
    const g = makeGraphRepo({ commit: 'a'.repeat(40), branch: 'main' });
    const wiring = startGitWiring({
      emit: (d) => emitted.push(d),
      getGitExtension: () => graphExtension(g.repo),
    });

    g.setHead('b'.repeat(40), 'main');
    g.fire();
    wiring.dispose();
    await wiring.settled();

    // Writing to a session whose writer is closed is the failure this prevents.
    expect(emitted).toHaveLength(0);
  });

  it('drops an unowned repo BEFORE reading its commit graph', async () => {
    // Ownership is a routing decision, not a filter on the payload: reading the
    // graph of a repo this session does not own is work it should never do.
    let getCommitCalls = 0;
    const g = makeGraphRepo({ commit: 'a'.repeat(40), branch: 'main', rootFsPath: '/ws/other' });
    const original = g.repo['getCommit'] as (ref: string) => Promise<unknown>;
    g.repo['getCommit'] = (ref: string) => {
      getCommitCalls += 1;
      return original(ref);
    };

    const emit = vi.fn();
    const wiring = startGitWiring({
      emit,
      getGitExtension: () => graphExtension(g.repo),
      isRepoOwnedByThisRoot: (fsPath) => fsPath === '/ws/mine',
    });

    g.setHead('b'.repeat(40), 'main');
    g.fire();
    await wiring.settled();

    expect(emit).not.toHaveBeenCalled();
    expect(getCommitCalls).toBe(0);
  });
});
