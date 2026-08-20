/**
 * Tests for the repository-discriminator WRITER (decision D12).
 *
 * Two layers, deliberately:
 *
 *  1. A stubbed {@link GitRunner}, which is where the DECISION rules live —
 *     shallow, several roots, failure, and the shape check. These are the rules
 *     the two sibling recorders must reproduce, so they are pinned as pure
 *     input/output.
 *  2. REAL git repositories in a temp directory, which is the only thing that
 *     proves the two commands and their flags are the right ones. A stub that
 *     agrees with a wrong command is a test that proves nothing — the class of
 *     failure the `tools/` composition gates exist for.
 *
 * The acceptance side is checked through log-core's OWN
 * `readRepositoryDiscriminator`, not a local regex, so a writer can never emit a
 * value its reader rejects.
 */

import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { readRepositoryDiscriminator } from '@provenance/log-core';
import { deriveRootCommitSha } from './root-commit-sha.js';
import type { GitRunner } from './root-commit-sha.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const SHA256_ROOT = '9'.repeat(64);

/** A runner that answers `rev-parse` and `rev-list` from a script. */
function stubRunner(script: {
  shallow?: string | Error;
  revList?: string | Error;
  onCall?: (args: readonly string[], cwd: string) => void;
}): GitRunner {
  return async (args, cwd) => {
    script.onCall?.(args, cwd);
    const answer = args[0] === 'rev-parse' ? (script.shallow ?? 'false\n') : (script.revList ?? '');
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

// ---------------------------------------------------------------------------
// The decision rules
// ---------------------------------------------------------------------------

describe('deriveRootCommitSha — the writer contract', () => {
  it('asks git for the FIRST-PARENT root of HEAD, in the repository root', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const sha = await deriveRootCommitSha(
      '/ws/proj',
      stubRunner({ revList: `${A}\n`, onCall: (args, cwd) => calls.push({ args, cwd }) }),
    );

    expect(sha).toBe(A);
    expect(calls.map((c) => c.args)).toEqual([
      ['rev-parse', '--is-shallow-repository'],
      ['rev-list', '--max-parents=0', '--first-parent', 'HEAD'],
    ]);
    // MUTATION GUARD: dropping `--first-parent` — which makes two partners on
    // one repository disagree the moment an imported history is merged in —
    // fails here.
    expect(calls.every((c) => c.cwd === '/ws/proj')).toBe(true);
  });

  it('takes the LEXICOGRAPHICALLY SMALLEST when a repository has several roots', async () => {
    // Ordinary: an orphan branch, a squashed import. Never a finding. The rule
    // exists only so two partners with the same history agree.
    const sha = await deriveRootCommitSha(
      '/ws/proj',
      stubRunner({ revList: `${B}\n${A}\n` }),
    );
    expect(sha).toBe(A);

    const reversed = await deriveRootCommitSha(
      '/ws/proj',
      stubRunner({ revList: `${A}\n${B}\n` }),
    );
    // MUTATION GUARD: `roots[0]` without the sort makes these two disagree.
    expect(reversed).toBe(A);
  });

  it('OMITS the field for a shallow repository', async () => {
    // A shallow clone's boundary commit has no parents and is NOT a root:
    // emitting it publishes a value a full clone of the same repository
    // disagrees with. Absent is legal, permanent and blameless.
    const run = vi.fn(stubRunner({ shallow: 'true\n', revList: `${A}\n` }));
    expect(await deriveRootCommitSha('/ws/proj', run)).toBeUndefined();
    // MUTATION GUARD: skipping the shallow probe entirely returns A here.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('OMITS the field when the shallow probe answers anything but a definite false', async () => {
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ shallow: '' }))).toBeUndefined();
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ shallow: 'maybe' }))).toBeUndefined();
  });

  it('OMITS the field on ANY failure — git missing, not a repo, timed out', async () => {
    const err = new Error('spawn git ENOENT');
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ shallow: err }))).toBeUndefined();
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ revList: err }))).toBeUndefined();
  });

  it('OMITS the field for an empty repository (rev-list returns nothing)', async () => {
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ revList: '\n\n' }))).toBeUndefined();
  });

  it('returns UNDEFINED, never null — omission and null chain to different hashes', async () => {
    const sha = await deriveRootCommitSha('/ws/p', stubRunner({ revList: '' }));
    // MUTATION GUARD: returning `null` here reaches the emit site as a present
    // key, and `root_commit_sha: null` is a nonconforming payload whose
    // canonical bytes differ from every other recorder's for the same fact.
    expect(sha).toBeUndefined();
    expect(sha).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The shape check — S14(b)
// ---------------------------------------------------------------------------

describe('the shape check runs on the WRITE side too', () => {
  it('accepts a sha-256 repository’s 64-hex root', async () => {
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ revList: `${SHA256_ROOT}\n` }))).toBe(
      SHA256_ROOT,
    );
  });

  it('NEVER emits a repository path or a remote URL', async () => {
    // S14(b): a path is arguably an identifier and a remote URL embeds the org
    // and frequently the student's own username. This is the reason the reader
    // shape-checks at all; running the same check on the write side means such
    // a value is never written down in the first place.
    for (const bad of [
      '/Users/student/cs61b/proj2',
      'git@github.com:cs61b-students/proj2.git',
      'https://github.com/some-org/proj2',
    ]) {
      expect(await deriveRootCommitSha('/ws/p', stubRunner({ revList: `${bad}\n` }))).toBeUndefined();
    }
  });

  it('rejects an uppercased or abbreviated sha rather than folding it', async () => {
    expect(
      await deriveRootCommitSha('/ws/p', stubRunner({ revList: `${'A'.repeat(40)}\n` })),
    ).toBeUndefined();
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ revList: '9abcdef\n' }))).toBeUndefined();
  });

  it('anything it DOES return is accepted by log-core’s reader', async () => {
    for (const good of [A, B, SHA256_ROOT]) {
      const sha = await deriveRootCommitSha('/ws/p', stubRunner({ revList: `${good}\n` }));
      expect(sha).toBeDefined();
      expect(readRepositoryDiscriminator({ root_commit_sha: sha }).kind).toBe('recorded');
    }
  });
});

// ---------------------------------------------------------------------------
// Real git — proving the commands themselves are right
// ---------------------------------------------------------------------------

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  return stdout;
}

async function initRepo(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prov-root-'));
  await git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

async function commit(dir: string, message: string, file = 'f.txt'): Promise<string> {
  await fsPromises.writeFile(path.join(dir, file), `${message}\n`, 'utf8');
  await git(dir, 'add', file);
  await git(dir, 'commit', '-q', '--no-gpg-sign', '-m', message);
  return (await git(dir, 'rev-parse', 'HEAD')).trim();
}

describe('against a REAL git repository', () => {
  it('derives the actual root commit of a linear history', async () => {
    const dir = await initRepo();
    const root = await commit(dir, 'one');
    await commit(dir, 'two');
    await commit(dir, 'three');

    expect(await deriveRootCommitSha(dir)).toBe(root);
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('stays on the MAINLINE root when an imported history is merged in', async () => {
    // The case `--first-parent` exists for: two partners must agree, and a
    // merged-in orphan history must not change the answer.
    const dir = await initRepo();
    const mainRoot = await commit(dir, 'main-one');
    await commit(dir, 'main-two');

    // A disjoint path, so the merge below is a real merge and not a conflict.
    await git(dir, 'checkout', '-q', '--orphan', 'imported');
    await git(dir, 'rm', '-q', '-rf', '.');
    const importedRoot = await commit(dir, 'imported-one', 'vendored.txt');

    await git(dir, 'checkout', '-q', 'main');
    await git(dir, 'merge', '-q', '--no-gpg-sign', '--allow-unrelated-histories', '-m', 'merge', 'imported');

    const derived = await deriveRootCommitSha(dir);
    expect(derived).toBe(mainRoot);
    // MUTATION GUARD: without `--first-parent`, git reports BOTH roots and the
    // lexicographic tie-break picks whichever sorts first — so a partner who
    // merged and a partner who has not would disagree about the repository.
    expect(derived).not.toBe(importedRoot);
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('gives a SUBMODULE a different value from its outer repository', async () => {
    // Writer rule 9, and the whole reason the field exists: a submodule's sha
    // space is unrelated to its parent's, and labelling its events with the
    // outer root re-creates the merge the discriminator prevents.
    const outer = await initRepo();
    const inner = await initRepo();
    await commit(outer, 'outer-one');
    await commit(inner, 'inner-one');

    const outerSha = await deriveRootCommitSha(outer);
    const innerSha = await deriveRootCommitSha(inner);
    expect(outerSha).toBeDefined();
    expect(innerSha).toBeDefined();
    expect(outerSha).not.toBe(innerSha);

    await fsPromises.rm(outer, { recursive: true, force: true });
    await fsPromises.rm(inner, { recursive: true, force: true });
  });

  it('OMITS for a real shallow clone', async () => {
    const origin = await initRepo();
    await commit(origin, 'one');
    await commit(origin, 'two');
    await commit(origin, 'three');

    const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prov-shallow-'));
    const clone = path.join(parent, 'shallow');
    await run('git', ['clone', '-q', '--depth', '1', `file://${origin}`, clone]);

    // The boundary commit a shallow clone reports has no parents and is NOT a
    // root. Emitting it would publish a value a full clone disagrees with.
    expect(await deriveRootCommitSha(clone)).toBeUndefined();
    // And it is genuinely reachable via rev-list, so the shallow probe is what
    // stops it — not an accident of the repository being empty.
    const boundary = (
      await git(clone, 'rev-list', '--max-parents=0', '--first-parent', 'HEAD')
    ).trim();
    expect(boundary).toMatch(/^[0-9a-f]{40}$/);

    await fsPromises.rm(origin, { recursive: true, force: true });
    await fsPromises.rm(parent, { recursive: true, force: true });
  });

  it('OMITS in a directory that is not a git repository', async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prov-nogit-'));
    expect(await deriveRootCommitSha(dir)).toBeUndefined();
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('OMITS for a directory that does not exist, without throwing', async () => {
    await expect(
      deriveRootCommitSha(path.join(os.tmpdir(), 'prov-does-not-exist-9f3a')),
    ).resolves.toBeUndefined();
  });
});
