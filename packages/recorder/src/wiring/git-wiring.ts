/**
 * git-wiring.ts — subscribe to the vscode.git extension's repository events.
 *
 * PRD §4.2: "Git operation observed via the Git extension API — operation,
 * commit_sha if applicable."
 *
 * The vscode.git extension exposes a typed API via exports; the canonical way
 * to consume it is:
 *   const api = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1);
 *
 * The API surface is documented in:
 *   https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 *
 * That same API publishes `api.git.path`, the git executable the git extension
 * itself resolved. We use it — together with the `git.path` SETTING — so the
 * discriminator's `execFile` finds the same git VS Code is already using, rather
 * than only a git that happens to be on the PATH a GUI-launched editor
 * inherited. On Windows those are routinely not the same thing. The ordering and
 * the fall-through rules live in `root-commit-sha.ts`; both reads here are
 * defensive, and losing both costs a hint, never the wiring.
 *
 * Key types we rely on (reproduced minimally to avoid importing the git type defs):
 *   Repository.state: RepositoryState
 *   RepositoryState.HEAD: { commit?: string; name?: string; ... }
 *   RepositoryState.onDidChange: Event<void>
 *   Repository.getCommit(ref): Thenable<Commit>
 *
 * Design notes:
 * - We ask for API version 1 (stable). If unavailable we return a no-op Disposable.
 * - On each repository state change we emit git.event with the commit graph:
 *     operation: 'state_change'
 *     commit_sha: the current HEAD commit sha (retained for 1.x readers)
 *     sha / parents / branch: program spec S5, see below
 *     root_commit_sha: the repository discriminator (decision D12), derived once
 *       per repository at setup by root-commit-sha.ts and omitted when unknown
 * - We call explanationTagger?.markGit() on each emit to suppress fs.external_change
 *   false positives (PRD §4.5 / explanation-tags.ts).
 * - All field accesses are defensive — any failure logs a warning and continues.
 *
 * ## The commit graph (program spec S5)
 *
 * Gradescope delivers no `.git`, and a `.git` that did travel would prove less
 * than it looks like it does: `commit --amend`, `rebase`, and `filter-branch`
 * rewrite history after the fact. The recorder sits on the LIVE repository while
 * the work happens, so recording `sha`, `parents`, and `branch` here puts the
 * graph inside the signed hash chain at the instant it existed, where it can no
 * longer be rewritten. That is strictly better evidence than a shipped `.git`.
 *
 * ## NO AUTHOR IDENTITY — this is a protocol constraint, not a preference
 *
 * The git `Commit` object that {@link GitRepository.getCommit} resolves to also
 * carries `authorName`, `authorEmail`, `authorDate`, and `message`. **None of
 * them is read, here or anywhere else in the recorder.** The approved CPHS
 * protocol treats a new category of identifier as requiring a filed modification
 * BEFORE implementation, and a real name plus a real email address on every
 * commit is exactly that. `sha`, `parents`, and `branch` are structural — they
 * describe the shape of the history, not who produced it — and attribution
 * already has a designed, opaque home in `session.start.identity.student_ref`.
 *
 * The local {@link GitCommit} type below therefore declares only `hash` and
 * `parents`, so the other fields are not merely unused but unreachable. Widening
 * it is out of protocol.
 *
 * ## Why emission became asynchronous
 *
 * `sha` and `branch` are readable synchronously off `state.HEAD`, but `parents`
 * needs `getCommit(ref)`, which is async. Two consequences are handled here:
 *
 *  - **Ordering.** Log entries are ordered, and an unserialized async read would
 *    let a fast `getCommit` overtake a slow one, writing the graph out of order.
 *    Handlers are therefore chained through a single promise per wiring.
 *  - **`markGit()` stays synchronous.** The tagger suppresses `fs.external_change`
 *    false positives from the file writes a checkout performs, and those writes
 *    land immediately. Deferring the mark behind an `await` would reintroduce
 *    exactly the false positives it exists to prevent, so it is called in the
 *    synchronous part of the handler, before anything is awaited.
 */

import * as vscode from 'vscode';
import type { GitEventPayload } from '@provenance/log-core';
import type { ExplanationTagger } from '../events/explanation-tags.js';
import { createGitRunner, deriveRootCommitSha, resolveGitPathCandidates } from './root-commit-sha.js';
import type { GitRunner } from './root-commit-sha.js';

// ---------------------------------------------------------------------------
// Minimal typing for the vscode.git extension API
// We do not import from a git type declaration file — we cast defensively.
// ---------------------------------------------------------------------------

type GitAPI = {
  repositories: GitRepository[];
  onDidOpenRepository: (handler: (repo: GitRepository) => void) => vscode.Disposable;
  onDidCloseRepository: (handler: (repo: GitRepository) => void) => vscode.Disposable;
  /**
   * `API.git.path` — the git executable the git extension itself resolved and
   * uses. Optional here because this is a defensive cast over another
   * extension's untyped `exports`, not an import of its type declarations; a
   * build that does not publish it simply contributes no hint.
   */
  git?: { path?: unknown };
};

/**
 * The ONLY two fields of the git API's `Commit` this recorder may read.
 *
 * The real object also carries `authorName`, `authorEmail`, `authorDate`, and
 * `message`. They are deliberately absent from this type so they are unreachable
 * rather than merely unused — see the module docstring. Adding one requires a
 * filed CPHS protocol modification first.
 */
type GitCommit = {
  hash?: string;
  parents?: string[];
};

type GitRepository = {
  rootUri: { fsPath: string };
  state: {
    /** `name` is the current branch; absent when HEAD is detached. */
    HEAD?: { commit?: string; name?: string };
    onDidChange: (handler: () => void) => vscode.Disposable;
  };
  /** Absent on git API builds that predate it — treated as "parents unknown". */
  getCommit?: (ref: string) => Thenable<GitCommit>;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The wiring handle. A `vscode.Disposable`, plus {@link GitWiring.settled} for
 * tests and shutdown to await the in-flight commit-graph reads.
 */
export type GitWiring = vscode.Disposable & {
  /** Resolves once every queued state-change handler has finished. */
  settled: () => Promise<void>;
};

export type GitWiringDeps = {
  emit: (data: GitEventPayload) => void;
  getGitExtension: () => vscode.Extension<unknown> | undefined;
  /** If present, markGit() is called after each emitted git.event. */
  explanationTagger?: ExplanationTagger;
  /**
   * Ownership filter for a REPOSITORY ROOT — not for a file.
   *
   * The argument is always `repo.rootUri.fsPath`, and a repository root is
   * normally an ANCESTOR of the assignment root it serves (one repo, one
   * `.provenance/` per assignment beneath it). A file-containment predicate such
   * as `resolveOwnerRoot(fsPath, roots) === root` therefore returns `null` for
   * every repository above the assignment and silently drops 100% of this
   * session's `git.event`s — spec §3 S14(a). Callers must supply
   * `isRepoOwnedByRoot` from `session/session-router.ts`, which handles both
   * directions.
   *
   * Defaults to "always owned" when omitted.
   */
  isRepoOwnedByThisRoot?: (repoRootFsPath: string) => boolean;
  /**
   * Derive the repository discriminator (`root_commit_sha`, decision D12) for a
   * repository root, or `undefined` to OMIT the field.
   *
   * Defaults to the real `deriveRootCommitSha`, which shells out to two
   * read-only git plumbing commands, run against the first git executable that
   * starts out of `api.git.path`, the `git.path` setting, and bare `git`. The
   * default is the PRODUCTION one on
   * purpose: a dep that must be remembered is a dep that eventually is not, and
   * a forgotten discriminator is not a loud failure — it is a silently
   * unlabelled repository, which is exactly the shape decision-log bug 3 took
   * when the whole commit-graph feature went dark for the standard layout.
   *
   * Overridden in tests, which must not spawn git.
   */
  deriveRepositoryDiscriminator?: (repoRootFsPath: string) => Promise<string | undefined>;
  /**
   * Reads the `git.path` SETTING — a string, an array of candidate paths, or
   * absent. Only a hint; see {@link resolveGitPathCandidates}.
   *
   * Defaults to the real `workspace.getConfiguration('git').get('path')`,
   * consulted lazily and only when `deriveRepositoryDiscriminator` is not
   * overridden, so a unit test that injects the derivation never touches
   * configuration at all.
   */
  readConfiguredGitPath?: () => unknown;
};

// ---------------------------------------------------------------------------
// startGitWiring
// ---------------------------------------------------------------------------

/** A wiring handle that does nothing, for every "no git here" exit below. */
function inertWiring(): GitWiring {
  return { dispose() {}, settled: () => Promise.resolve() };
}

export function startGitWiring(deps: GitWiringDeps): GitWiring {
  const { emit, getGitExtension, explanationTagger } = deps;
  const isRepoOwnedByThisRoot = deps.isRepoOwnedByThisRoot ?? (() => true);
  const readConfiguredGitPath =
    deps.readConfiguredGitPath ??
    (() => vscode.workspace.getConfiguration('git').get<unknown>('path'));

  const gitExtension = getGitExtension();
  if (gitExtension === undefined) {
    console.warn('[provenance] vscode.git extension not found; git.event wiring skipped.');
    return inertWiring();
  }

  let api: GitAPI | undefined;
  try {
    const exports = gitExtension.exports as { getAPI?: (v: number) => GitAPI } | undefined;
    api = exports?.getAPI?.(1);
  } catch (e) {
    console.warn('[provenance] failed to get vscode.git API v1:', e);
    return inertWiring();
  }

  if (api === undefined) {
    console.warn('[provenance] vscode.git getAPI(1) returned undefined; git.event wiring skipped.');
    return inertWiring();
  }

  /**
   * The git executables to try, resolved ONCE and only if the production
   * derivation is actually going to run. Both reads are defensive: `api.git` is
   * another extension's untyped export and the setting is a user-editable file,
   * and a throw from either must not take the wiring down — it only costs a
   * hint, and the bare PATH lookup remains.
   */
  let productionRun: GitRunner | undefined;
  function gitRunner(): GitRunner {
    if (productionRun === undefined) {
      let extensionApiGitPath: unknown;
      try {
        extensionApiGitPath = api?.git?.path;
      } catch (e) {
        console.warn('[provenance] git wiring: failed to read the git API executable path:', e);
      }
      let configuredGitPath: unknown;
      try {
        configuredGitPath = readConfiguredGitPath();
      } catch (e) {
        console.warn('[provenance] git wiring: failed to read the git.path setting:', e);
      }
      productionRun = createGitRunner(
        resolveGitPathCandidates({ extensionApiGitPath, configuredGitPath }),
      );
    }
    return productionRun;
  }

  const deriveDiscriminator =
    deps.deriveRepositoryDiscriminator ??
    ((root: string) => deriveRootCommitSha(root, gitRunner()));

  const disposables: vscode.Disposable[] = [];

  /**
   * Serializes the async commit-graph reads. Log entries are ordered, so every
   * state-change handler is appended to this one chain rather than racing: a
   * fast `getCommit` must not overtake a slow one and emit out of order.
   */
  let queue: Promise<void> = Promise.resolve();

  /** Set by dispose(). An in-flight read must not write into a closed session. */
  let disposed = false;

  // Track the last-seen HEAD commit per repository to emit only on actual changes.
  const lastCommit = new Map<GitRepository, string | undefined>();

  /**
   * The repository discriminator, per REPOSITORY, derived ONCE at setup
   * (decision D12 writer rule 1) and memoized as the in-flight promise.
   *
   * Keyed by the repository object, and derived with that repository's OWN root
   * as `cwd`, which is writer rule 9: a session that sees a submodule as well as
   * its outer repository labels each event with its own repository's root. The
   * vscode.git API surfaces a submodule as a separate `Repository`, so it
   * reaches `watchRepo` separately and gets its own entry here. Labelling a
   * submodule event with the outer repository's root would re-create the exact
   * sha-space merge this field exists to prevent.
   */
  const discriminatorByRepo = new Map<GitRepository, Promise<string | undefined>>();

  function watchRepo(repo: GitRepository): void {
    // The discriminator is derived here — at wiring setup, once per repository —
    // and never on the event path. Only for repositories this session owns:
    // running git in a repository whose events are dropped is work it should
    // never do. Ownership of a repository root cannot change during a session.
    if (!discriminatorByRepo.has(repo)) {
      let owned = false;
      try {
        owned = isRepoOwnedByThisRoot(repo.rootUri.fsPath);
      } catch (e) {
        console.warn('[provenance] git wiring: ownership check failed for discriminator:', e);
      }
      discriminatorByRepo.set(
        repo,
        owned
          ? // deriveRootCommitSha never rejects, but a caller-supplied override
            // might; an unhandled rejection must not reach the extension host.
            Promise.resolve()
              .then(() => deriveDiscriminator(repo.rootUri.fsPath))
              .catch(() => undefined)
          : Promise.resolve(undefined),
      );
    }

    // Record the initial commit to avoid a spurious emit on first change.
    let current: string | undefined;
    try {
      current = repo.state.HEAD?.commit;
    } catch (e) {
      console.warn('[provenance] git wiring: failed to read repo HEAD:', e);
    }
    lastCommit.set(repo, current);

    let sub: vscode.Disposable;
    try {
      sub = repo.state.onDidChange(() => {
        // --- Synchronous part. Everything here must happen before any await.
        let commit_sha: string | undefined;
        let branch: string | undefined;
        try {
          commit_sha = repo.state.HEAD?.commit;
          // `name` is absent when HEAD is detached. Never invented — an omitted
          // branch and a branch called "HEAD" are different claims.
          branch = repo.state.HEAD?.name;
        } catch (e) {
          console.warn('[provenance] git wiring: failed to read HEAD on state change:', e);
        }

        const prev = lastCommit.get(repo);
        lastCommit.set(repo, commit_sha);

        // Ownership is a routing decision, so it is made BEFORE the graph read:
        // fetching the commit graph of a repo this session does not own is work
        // it should never do.
        if (!isRepoOwnedByThisRoot(repo.rootUri.fsPath)) {
          return;
        }

        // Suppress fs.external_change false positives (git checkout rewrites
        // files). Called SYNCHRONOUSLY and before the emit: those writes land
        // immediately, so deferring the mark behind the await below would
        // reintroduce exactly the false positives the tagger exists to prevent.
        explanationTagger?.markGit();

        void prev; // kept for future use; the sha itself is emitted below

        // --- Async part, appended to the shared queue so emission stays ordered.
        queue = queue.then(async () => {
          if (disposed) return;

          // `parents` needs an async read, and is OMITTED when it cannot be
          // obtained. An empty array would be a positive claim of "root commit",
          // which a read failure is not entitled to make.
          let parents: string[] | undefined;
          if (commit_sha !== undefined && typeof repo.getCommit === 'function') {
            try {
              const commit = await repo.getCommit(commit_sha);
              // ONLY `parents` is read off the commit. The object also carries
              // authorName / authorEmail / authorDate / message; reading any of
              // them is out of protocol — see the module docstring.
              if (Array.isArray(commit?.parents)) {
                parents = commit.parents.filter((p): p is string => typeof p === 'string');
              }
            } catch (e) {
              console.warn('[provenance] git wiring: failed to read commit parents:', e);
            }
          }

          // The discriminator was derived at setup; this awaits a settled
          // promise, so it costs a microtask and never a git invocation. It is
          // read here rather than captured above because a state change can
          // arrive before the setup derivation has resolved, and omitting the
          // label in that window would leave the session's first observations
          // silently uncorrelatable.
          const rootCommitSha = await discriminatorByRepo.get(repo);

          if (disposed) return;

          // Emitted even for non-commit operations (branch switch, index change)
          // so the analyzer sees the activity. `commit_sha` duplicates `sha` on
          // purpose: 1.x readers only know the former.
          //
          // `root_commit_sha` rides along on every event that carries a `sha`
          // (D12 writer rule 10) — not only on commits, because an unlabelled
          // observation does not correlate even when its neighbours in the same
          // session do. It is OMITTED, never `null` (rule 6): an absent key and
          // a `null` value canonicalize differently and chain to different
          // hashes, exactly as `parents: []` and an absent `parents` do.
          emit({
            operation: 'state_change',
            ...(commit_sha !== undefined ? { commit_sha, sha: commit_sha } : {}),
            ...(parents !== undefined ? { parents } : {}),
            ...(branch !== undefined ? { branch } : {}),
            ...(commit_sha !== undefined && rootCommitSha !== undefined
              ? { root_commit_sha: rootCommitSha }
              : {}),
          });
        });
      });
    } catch (e) {
      console.warn('[provenance] git wiring: failed to subscribe to repo state:', e);
      return;
    }
    disposables.push(sub);
  }

  // Watch all already-open repositories.
  try {
    for (const repo of api.repositories) {
      watchRepo(repo);
    }
  } catch (e) {
    console.warn('[provenance] git wiring: failed to iterate repositories:', e);
  }

  // Watch repositories that open after our subscription.
  try {
    const openSub = api.onDidOpenRepository((repo) => {
      watchRepo(repo);
    });
    disposables.push(openSub);
  } catch (e) {
    console.warn('[provenance] git wiring: failed to subscribe to onDidOpenRepository:', e);
  }

  return {
    dispose() {
      // Set first: an in-flight commit-graph read must not emit into a session
      // whose writer is being closed.
      disposed = true;
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // Best effort.
        }
      }
      disposables.length = 0;
      lastCommit.clear();
      discriminatorByRepo.clear();
    },
    settled: () => queue,
  };
}
