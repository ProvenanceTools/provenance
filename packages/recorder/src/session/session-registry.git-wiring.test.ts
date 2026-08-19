/**
 * Which ownership predicate does startSession hand to the git wiring?
 *
 * This lives in its own file because it mocks `startGitWiring` at the seam, and
 * that mock must not leak into `session-registry.test.ts`, which exercises the
 * real wiring set.
 *
 * WHY IT EXISTS. The `git.event` blackout (spec §3 S14(a)) was never a bug in
 * git-wiring's own logic — the gate did exactly what it was told. The bug was
 * that the caller handed it a FILE predicate (`resolveOwnerRoot(p, roots) ===
 * root`) to answer a question about a REPOSITORY ROOT, which is an ancestor of
 * the assignment rather than a descendant of it. Every test that fakes the
 * predicate is blind to that class of mistake by construction, so the wiring
 * itself has to be pinned: git must receive `isRepoOwnedByThisRoot`, never
 * `isOwnedByThisRoot`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FixedClock, canonicalize } from '@provenance/log-core';
import type { Manifest } from '@provenance/log-core';

/** Captures the deps every `startGitWiring` call received, in order. */
const gitWiringCalls: Array<{ isRepoOwnedByThisRoot?: (p: string) => boolean }> = [];

vi.mock('../wiring/git-wiring.js', () => ({
  startGitWiring: (deps: { isRepoOwnedByThisRoot?: (p: string) => boolean }) => {
    gitWiringCalls.push(deps);
    return { dispose() {}, settled: () => Promise.resolve() };
  },
}));

const { startSession } = await import('./session-registry.js');
const { isRepoOwnedByRoot, resolveOwnerRoot } = await import('./session-router.js');

function makeExtension(): import('vscode').Extension<unknown> {
  return {
    id: 'itsgeagle.provenance-recorder',
    extensionUri: { fsPath: '/fake/ext' } as import('vscode').Uri,
    extensionPath: '/fake/ext',
    isActive: true,
    packageJSON: { version: '0.0.0', publisher: 'itsgeagle', name: 'provenance-recorder' },
    exports: undefined,
    activate: () => Promise.resolve(undefined),
    extensionKind: 1 as import('vscode').ExtensionKind,
  };
}

async function signedManifest(): Promise<Manifest> {
  const fields = {
    assignment_id: 'proj2',
    semester: 'fa26',
    issued_at: '2026-09-15T00:00:00Z',
    files_under_review: ['Main.java'],
  };
  const secretKey = ed.utils.randomSecretKey();
  const sig = await ed.signAsync(new TextEncoder().encode(canonicalize(fields)), secretKey);
  return { ...fields, sig: bytesToHex(sig) };
}

describe('startSession — the predicate handed to the git wiring', () => {
  let tmpDir: string;
  let repoRoot: string;
  let proj1: string;
  let proj2: string;

  beforeEach(async () => {
    gitWiringCalls.length = 0;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-git-routing-'));
    // The shipped CS 61B/61C layout: ONE git repo, one assignment (and its own
    // .provenance/) per subdirectory.
    repoRoot = path.join(tmpDir, 'cs61b-repo');
    proj1 = path.join(repoRoot, 'proj1');
    proj2 = path.join(repoRoot, 'proj2');
    await fs.mkdir(proj1, { recursive: true });
    await fs.mkdir(proj2, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function start(): Promise<{ dispose: () => Promise<void> }> {
    const allRoots = [proj1, proj2];
    const session = await startSession({
      assignmentRoot: proj2,
      manifest: await signedManifest(),
      extension: makeExtension(),
      vscodeVersion: '1.100.0',
      platform: 'darwin-arm64',
      clock: new FixedClock(),
      // Exactly what extension.ts wires: a file predicate AND a repository
      // predicate, which must not be interchangeable.
      isOwnedByThisRoot: (p: string) => resolveOwnerRoot(p, allRoots) === proj2,
      isRepoOwnedByThisRoot: (p: string) => isRepoOwnedByRoot(p, proj2, allRoots),
    });
    return session;
  }

  it('gives git a predicate that OWNS the repository containing the assignment', async () => {
    const session = await start();
    try {
      expect(gitWiringCalls).toHaveLength(1);
      const gate = gitWiringCalls[0]?.isRepoOwnedByThisRoot;
      expect(gate).toBeTypeOf('function');
      // The repo root is an ANCESTOR of proj2. Under the file predicate this is
      // false and every git.event is dropped; under the repository predicate it
      // is true. This assertion is the difference between the two.
      expect(gate?.(repoRoot)).toBe(true);
      expect(gate?.(proj2)).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  it('gives git a predicate that still refuses an unrelated repository', async () => {
    const session = await start();
    try {
      const gate = gitWiringCalls[0]?.isRepoOwnedByThisRoot;
      expect(gate?.(path.join(tmpDir, 'somewhere-else'))).toBe(false);
      // A sibling assignment that is its own repository is not ours either.
      expect(gate?.(proj1)).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  it('does NOT hand git the file-containment predicate', async () => {
    // The defect, stated directly: if git is wired to `isOwnedByThisRoot`, the
    // gate returns false for the repository root and the whole commit-graph
    // capture goes dark with no error anywhere.
    const session = await start();
    try {
      const gate = gitWiringCalls[0]?.isRepoOwnedByThisRoot;
      // Asserted before use: an ABSENT predicate is the same defect wearing a
      // different hat (git-wiring defaults to "own everything", which is the
      // opposite failure), so `gate?.(...) === undefined` must not read as a pass.
      expect(gate).toBeTypeOf('function');
      const fileGate = (p: string) => resolveOwnerRoot(p, [proj1, proj2]) === proj2;
      expect(fileGate(repoRoot)).toBe(false);
      expect(gate?.(repoRoot)).toBe(true);
    } finally {
      await session.dispose();
    }
  });
});
