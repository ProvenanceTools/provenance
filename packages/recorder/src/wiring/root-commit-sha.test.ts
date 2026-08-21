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
import {
  BARE_GIT_COMMAND,
  createGitRunner,
  deriveRootCommitSha,
  resolveGitPathCandidates,
} from './root-commit-sha.js';
import type { GitRunner, GitSpawn } from './root-commit-sha.js';

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
    const sha = await deriveRootCommitSha('/ws/proj', stubRunner({ revList: `${B}\n${A}\n` }));
    expect(sha).toBe(A);

    const reversed = await deriveRootCommitSha('/ws/proj', stubRunner({ revList: `${A}\n${B}\n` }));
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
      expect(
        await deriveRootCommitSha('/ws/p', stubRunner({ revList: `${bad}\n` })),
      ).toBeUndefined();
    }
  });

  it('rejects an uppercased or abbreviated sha rather than folding it', async () => {
    expect(
      await deriveRootCommitSha('/ws/p', stubRunner({ revList: `${'A'.repeat(40)}\n` })),
    ).toBeUndefined();
    expect(
      await deriveRootCommitSha('/ws/p', stubRunner({ revList: '9abcdef\n' })),
    ).toBeUndefined();
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
    await git(
      dir,
      'merge',
      '-q',
      '--no-gpg-sign',
      '--allow-unrelated-histories',
      '-m',
      'merge',
      'imported',
    );

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

// ---------------------------------------------------------------------------
// Finding git at all — writer correction 8
//
// This half has only ever RUN on macOS, and most of the machines it has to work
// on are not macOS. The resolution and the output parsing are therefore pinned
// against Windows- and Linux-shaped inputs through the injectable seams, since
// no Windows machine is available to run them on. What is NOT proved here is
// stated plainly rather than papered over: no assertion below claims a real
// Windows process was ever started.
// ---------------------------------------------------------------------------

/** The Windows default install location — and the reason spaces matter. */
const WINDOWS_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const WINDOWS_GIT_BIN = 'C:\\Program Files\\Git\\bin\\git.exe';
const LINUX_GIT = '/usr/bin/git';

/** An error shaped like the one `execFile` produces for the named condition. */
function spawnFailure(code: unknown, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`git: ${String(code)}`), { code, ...extra });
}

/** Records every (file, args, cwd) a runner asks for, answering from a script. */
function recordingSpawn(answers: ReadonlyMap<string, string | Error>): {
  spawn: GitSpawn;
  calls: Array<{ file: string; args: readonly string[]; cwd: string }>;
} {
  const calls: Array<{ file: string; args: readonly string[]; cwd: string }> = [];
  const spawn: GitSpawn = async (file, args, cwd) => {
    calls.push({ file, args, cwd });
    const answer = answers.get(file);
    if (answer === undefined) throw spawnFailure('ENOENT');
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { spawn, calls };
}

describe('resolveGitPathCandidates — which git to spawn', () => {
  it('is the bare PATH lookup when VS Code knows nothing, exactly as before', () => {
    // The pre-existing behaviour, preserved on every machine where it was
    // already right.
    expect(resolveGitPathCandidates()).toEqual([BARE_GIT_COMMAND]);
    expect(resolveGitPathCandidates({})).toEqual([BARE_GIT_COMMAND]);
    expect(
      resolveGitPathCandidates({ extensionApiGitPath: undefined, configuredGitPath: undefined }),
    ).toEqual(['git']);
  });

  it('prefers the git extension’s OWN resolved binary, then the setting, then PATH', () => {
    // MUTATION GUARD: ignoring `git.path` and always spawning bare `git` — the
    // behaviour this change exists to fix — returns ['git'] here.
    expect(
      resolveGitPathCandidates({
        extensionApiGitPath: WINDOWS_GIT,
        configuredGitPath: WINDOWS_GIT_BIN,
      }),
    ).toEqual([WINDOWS_GIT, WINDOWS_GIT_BIN, 'git']);
  });

  it('keeps a Windows path containing SPACES verbatim — no quoting, no splitting', () => {
    // `execFile` takes an argv, not a command line, so the space needs no
    // treatment at all. Quoting it here would produce a path with literal quote
    // characters in it, which is the classic cross-platform spawn bug.
    const candidates = resolveGitPathCandidates({ extensionApiGitPath: WINDOWS_GIT });
    expect(candidates[0]).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(candidates[0]).not.toContain('"');
    expect(candidates).toHaveLength(2);
  });

  it('accepts an ARRAY-valued git.path and keeps the candidates in order', () => {
    // The setting is documented as a string OR an array of paths to look up. A
    // port that assumes a string gets `undefined` — or worse, an array coerced
    // to "a,b", a path that exists nowhere.
    //
    // MUTATION GUARD: mishandling the array — `String(configured)`, taking only
    // `[0]`, or dropping it as "not a string" — fails here.
    expect(
      resolveGitPathCandidates({ configuredGitPath: [WINDOWS_GIT, WINDOWS_GIT_BIN, LINUX_GIT] }),
    ).toEqual([WINDOWS_GIT, WINDOWS_GIT_BIN, LINUX_GIT, 'git']);
  });

  it('drops array entries that cannot name an executable, keeping the rest in order', () => {
    expect(
      resolveGitPathCandidates({
        configuredGitPath: ['', '   ', null, 42, { path: LINUX_GIT }, WINDOWS_GIT, LINUX_GIT],
      }),
    ).toEqual([WINDOWS_GIT, LINUX_GIT, 'git']);
  });

  it('ignores a git.path that is neither a string nor an array', () => {
    for (const configuredGitPath of [42, true, null, { path: LINUX_GIT }, '', '  \t ']) {
      expect(resolveGitPathCandidates({ configuredGitPath })).toEqual(['git']);
    }
  });

  it('ignores an api.git.path that is not a usable string', () => {
    // Another extension's untyped `exports`. It is not trusted to be a string.
    for (const extensionApiGitPath of [42, true, null, {}, [], '', '   ']) {
      expect(resolveGitPathCandidates({ extensionApiGitPath })).toEqual(['git']);
    }
  });

  it('always ends at the bare PATH lookup, and is never empty', () => {
    // The fallback is what makes this change incapable of losing a machine that
    // already worked.
    for (const hints of [
      {},
      { extensionApiGitPath: WINDOWS_GIT },
      { configuredGitPath: [LINUX_GIT] },
      { extensionApiGitPath: 42, configuredGitPath: [null] },
    ]) {
      const candidates = resolveGitPathCandidates(hints);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[candidates.length - 1]).toBe('git');
    }
  });

  it('de-duplicates, so a setting that merely repeats the API answer costs nothing', () => {
    expect(
      resolveGitPathCandidates({
        extensionApiGitPath: WINDOWS_GIT,
        configuredGitPath: [WINDOWS_GIT, WINDOWS_GIT, LINUX_GIT],
      }),
    ).toEqual([WINDOWS_GIT, LINUX_GIT, 'git']);

    // …including when the bare fallback is itself what was configured: once,
    // and last is where it already is.
    expect(resolveGitPathCandidates({ configuredGitPath: 'git' })).toEqual(['git']);
  });

  it('preserves drive letters, UNC paths and non-ASCII directories verbatim', () => {
    const unc = '\\\\build-server\\tools\\Git\\cmd\\git.exe';
    const nonAscii = '/home/étudiant/outils/git';
    expect(
      resolveGitPathCandidates({ configuredGitPath: [unc, 'D:\\git\\git.exe', nonAscii] }),
    ).toEqual([unc, 'D:\\git\\git.exe', nonAscii, 'git']);
  });
});

describe('createGitRunner — walking the candidate ladder', () => {
  it('falls through to the next candidate when one is NOT THERE (ENOENT)', async () => {
    // The whole point: a stale `git.path`, or a git the inherited PATH lacks.
    const { spawn, calls } = recordingSpawn(new Map([['git', `${A}\n`]]));
    const run = createGitRunner([WINDOWS_GIT, 'git'], spawn);

    expect(await run(['rev-parse', '--is-shallow-repository'], '/ws/p')).toBe(`${A}\n`);
    expect(calls.map((c) => c.file)).toEqual([WINDOWS_GIT, 'git']);
  });

  it('falls through for a candidate that is present but cannot be RUN', async () => {
    // EACCES / EPERM: there, not runnable. ENOTDIR: a path component is a file.
    // EINVAL: not a launchable program — a .cmd/.bat git wrapper, which Node
    // refuses without a shell, and a shell is exactly what we will not add.
    for (const code of ['EACCES', 'EPERM', 'ENOTDIR', 'EINVAL']) {
      const { spawn, calls } = recordingSpawn(
        new Map<string, string | Error>([
          [WINDOWS_GIT, spawnFailure(code)],
          ['git', `${B}\n`],
        ]),
      );
      const run = createGitRunner([WINDOWS_GIT, 'git'], spawn);
      expect(await run(['rev-list'], '/ws/p')).toBe(`${B}\n`);
      expect(calls).toHaveLength(2);
    }
  });

  it('does NOT fall through on a non-zero exit — git was found and it ANSWERED', async () => {
    // "not a git repository" is an answer, not a failed launch. Re-asking a
    // different binary in the same directory can only hear the same thing.
    const { spawn, calls } = recordingSpawn(
      new Map<string, string | Error>([
        [WINDOWS_GIT, spawnFailure(128, { stderr: 'fatal: not a git repository' })],
        ['git', `${A}\n`],
      ]),
    );
    const run = createGitRunner([WINDOWS_GIT, 'git'], spawn);

    await expect(run(['rev-parse'], '/ws/p')).rejects.toThrow();
    expect(calls.map((c) => c.file)).toEqual([WINDOWS_GIT]);
  });

  it('does NOT fall through on a TIMEOUT — the 5s budget is spent once, not per candidate', async () => {
    // execFile's timeout kill: `killed`, a signal, and no string `code`. Three
    // candidates laddering here would put a 15s stall in front of activation.
    const timedOut = spawnFailure(null, { killed: true, signal: 'SIGTERM' });
    const { spawn, calls } = recordingSpawn(
      new Map<string, string | Error>([
        [WINDOWS_GIT, timedOut],
        [WINDOWS_GIT_BIN, `${A}\n`],
        ['git', `${A}\n`],
      ]),
    );
    const run = createGitRunner([WINDOWS_GIT, WINDOWS_GIT_BIN, 'git'], spawn);

    await expect(run(['rev-parse'], '/ws/p')).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('rejects when NO candidate can start, and that reaches the same OMISSION', async () => {
    // ENOENT from a missing binary, a non-zero exit and a timeout all land in
    // deriveRootCommitSha's single catch. The field is omitted; nothing is
    // invented, and nothing is reported as a defect.
    //
    // MUTATION GUARD: treating a missing binary as a FINDING rather than an
    // omission — throwing, or returning a sentinel such as 'git-unavailable' —
    // fails on the `toBeUndefined()` below.
    const { spawn, calls } = recordingSpawn(new Map());
    const run = createGitRunner([WINDOWS_GIT, LINUX_GIT, 'git'], spawn);

    await expect(run(['rev-parse'], '/ws/p')).rejects.toThrow();
    expect(calls).toHaveLength(3);
    await expect(deriveRootCommitSha('/ws/p', run)).resolves.toBeUndefined();
  });

  it('passes args and cwd through VERBATIM to whichever executable it chose', async () => {
    // No shell means no quoting, on any platform. A cwd with spaces, a drive
    // letter, or non-ASCII is handed over exactly as given.
    const cwd = 'C:\\Users\\Student\\CS 61B\\proj2';
    const { spawn, calls } = recordingSpawn(new Map([[WINDOWS_GIT, 'false\r\n']]));
    const run = createGitRunner([WINDOWS_GIT, 'git'], spawn);

    await run(['rev-list', '--max-parents=0', '--first-parent', 'HEAD'], cwd);
    expect(calls).toEqual([
      { file: WINDOWS_GIT, args: ['rev-list', '--max-parents=0', '--first-parent', 'HEAD'], cwd },
    ]);
  });

  it('falls back to the bare PATH lookup when handed an empty candidate list', async () => {
    const { spawn, calls } = recordingSpawn(new Map([['git', `${A}\n`]]));
    expect(await createGitRunner([], spawn)(['rev-parse'], '/ws/p')).toBe(`${A}\n`);
    expect(calls.map((c) => c.file)).toEqual(['git']);
  });
});

describe('command output shapes — Windows line endings and odd working directories', () => {
  it('reads a CRLF shallow probe as NOT shallow', async () => {
    // MUTATION GUARD: dropping the trim on the shallow probe makes
    // 'false\r\n' !== 'false', so every Windows repository silently omits the
    // field — a whole platform failing to correlate, with no error anywhere.
    expect(
      await deriveRootCommitSha('/ws/p', stubRunner({ shallow: 'false\r\n', revList: `${A}\r\n` })),
    ).toBe(A);
  });

  it('still OMITS for a CRLF shallow repository', async () => {
    expect(
      await deriveRootCommitSha('/ws/p', stubRunner({ shallow: 'true\r\n', revList: `${A}\r\n` })),
    ).toBeUndefined();
  });

  it('parses a CRLF root listing — the trim is applied PER LINE, not once at the end', async () => {
    // A trailing `\r` is not lowercase hex, so log-core's reader rejects the
    // whole value: without the per-line trim the field is omitted on Windows
    // even though git answered correctly.
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ revList: `${A}\r\n` }))).toBe(A);
    // …and the tie-break still compares real shas, not `\r`-suffixed ones.
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ revList: `${B}\r\n${A}\r\n` }))).toBe(A);
  });

  it('treats blank and bare-CR lines as nothing, never as a phantom root', async () => {
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ revList: '\r\n\r\n' }))).toBeUndefined();
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ revList: '\r' }))).toBeUndefined();
    expect(await deriveRootCommitSha('/ws/p', stubRunner({ revList: `\r\n${A}\r\n\r\n` }))).toBe(A);
  });

  it('never emits a Windows path or a UNC share, however git got confused', async () => {
    for (const bad of [
      'C:\\Users\\Student\\CS 61B\\proj2',
      '\\\\build-server\\share\\proj2',
      'D:/repos/proj2',
    ]) {
      expect(
        await deriveRootCommitSha('/ws/p', stubRunner({ revList: `${bad}\r\n` })),
      ).toBeUndefined();
    }
  });

  it('hands the repository root to BOTH commands exactly as given', async () => {
    // Absolute POSIX, a Windows absolute path with spaces, a UNC share, a
    // non-ASCII directory, and a relative path (which the OS resolves against
    // the process cwd — the recorder always passes `repo.rootUri.fsPath`, which
    // is absolute, but nothing here mangles one that is not).
    for (const cwd of [
      '/Users/student/cs61b/proj2',
      'C:\\Users\\Student\\CS 61B\\proj2',
      '\\\\build-server\\share\\proj2',
      '/Users/étudiant/projet ✓/proj2',
      './proj2',
    ]) {
      const seen: string[] = [];
      const sha = await deriveRootCommitSha(
        cwd,
        stubRunner({ revList: `${A}\n`, onCall: (_args, got) => seen.push(got) }),
      );
      expect(sha).toBe(A);
      expect(seen).toEqual([cwd, cwd]);
    }
  });
});

describe('against a REAL git repository — odd paths and candidate fall-through', () => {
  it('derives in a repository whose path contains SPACES and non-ASCII', async () => {
    // Only provable on this machine's filesystem, but it exercises the same
    // argv path Windows takes: no shell, one argument, no quoting.
    const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prov-odd-'));
    const dir = path.join(parent, 'CS 61B — projet ✓');
    await fsPromises.mkdir(dir);
    await git(dir, 'init', '-q', '-b', 'main');
    const root = await commit(dir, 'one');
    await commit(dir, 'two');

    expect(await deriveRootCommitSha(dir)).toBe(root);
    await fsPromises.rm(parent, { recursive: true, force: true });
  });

  it('falls through a configured git that is NOT THERE to the real one on PATH', async () => {
    // The end-to-end shape of the Windows fix, with a real spawn: a stale
    // `git.path` costs one failed launch and nothing else.
    const dir = await initRepo();
    const root = await commit(dir, 'one');

    const missing = path.join(os.tmpdir(), 'prov-no-such-git-4b1c', 'git');
    const candidates = resolveGitPathCandidates({
      extensionApiGitPath: missing,
      configuredGitPath: ['', `${missing}.exe`],
    });
    expect(candidates[candidates.length - 1]).toBe('git');

    expect(await deriveRootCommitSha(dir, createGitRunner(candidates))).toBe(root);
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('does not ladder past a real git that answered — a non-repo omits after ONE launch', async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prov-nogit2-'));
    const launched: string[] = [];
    const countingSpawn: GitSpawn = async (file, args, cwd) => {
      launched.push(file);
      const { stdout } = await run(file, [...args], { cwd });
      return stdout;
    };

    const derived = await deriveRootCommitSha(
      dir,
      createGitRunner(['git', path.join(os.tmpdir(), 'prov-no-such-git-4b1c')], countingSpawn),
    );
    expect(derived).toBeUndefined();
    // `rev-parse --is-shallow-repository` exits non-zero outside a repository:
    // an answer, so the second candidate is never tried.
    expect(launched).toEqual(['git']);

    await fsPromises.rm(dir, { recursive: true, force: true });
  });
});
