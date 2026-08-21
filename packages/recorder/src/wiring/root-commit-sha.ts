/**
 * root-commit-sha.ts — THE REPOSITORY DISCRIMINATOR, write side (decision D12,
 * collaboration spec S14(b)).
 *
 * A scope can observe more than one repository: a submodule, or a repository
 * nested inside the one that owns the assignment root. Their sha spaces are
 * unrelated, so a reader that keys observed commits by sha alone merges two
 * graphs that have nothing to do with each other. `git.event.root_commit_sha` is
 * what lets the reader key on `(repository, sha)` for real.
 *
 * The reader half is `log-core/git-event.ts`'s `readRepositoryDiscriminator` and
 * `analysis-core/git/observed-dag.ts`. The writer contract this module
 * implements is pinned in
 * `docs/superpowers/specs/2026-08-19-program-decision-log.md`, "The writer
 * contract for `root_commit_sha`". The reader is correct whatever the writer
 * picks — the value is opaque and compared only for equality — so the contract
 * exists to make three recorders derive the SAME value, which is the only thing
 * that makes correlation work at all.
 *
 * ## The value
 *
 * `git rev-list --max-parents=0 --first-parent HEAD` — the root of HEAD's
 * FIRST-PARENT lineage. First-parent because that lineage stays on the mainline
 * when an imported history is merged in, which is what keeps two partners
 * agreeing. If it yields more than one root — an orphan branch, a squashed
 * import; ORDINARY, and never a finding — the lexicographically smallest is
 * taken, so two partners with the same history agree.
 *
 * ## Absence is a legal, permanent, blameless answer
 *
 * The field is OMITTED — never `null` — when the repository is shallow, when git
 * fails, times out, or is missing, and when the value that comes back is not a
 * commit sha. Omission and `null` canonicalize differently and therefore chain to
 * different hashes; readers accept `null` as absence so a nonconforming log still
 * parses, but a writer that emits it is nonconforming.
 *
 * A **shallow clone** is the case worth naming: its boundary commit has no
 * parents and is NOT a root, so emitting it would publish a value a full clone of
 * the same repository disagrees with — a silent failure to correlate, dressed as
 * a successful one. `--is-shallow-repository` is checked first and anything other
 * than a definite `false` omits.
 *
 * ## No identity, ever
 *
 * This is a repository identifier and nothing else. It is deliberately NOT the
 * repository path (arguably an identifier, certainly noisy) and NOT a remote URL
 * (which embeds the org and frequently the student's own username) — S14(b). No
 * author name, no author email, no commit message is read here or anywhere in
 * the recorder; `git-wiring.ts`'s local `GitCommit` type makes those fields
 * unreachable rather than merely unused, and this module runs two read-only
 * plumbing commands that cannot surface them.
 *
 * The shape check is enforced through log-core's OWN reader
 * ({@link readRepositoryDiscriminator}), not a private regex, so a writer can
 * never emit a value its reader rejects. That is the one place a path or a URL
 * would be stopped before reaching a staff-facing UI, and running it on the
 * write side means such a value is never written down at all.
 *
 * ## No network (PRD NG2)
 *
 * `rev-parse` and `rev-list` are local object-database reads. Nothing here
 * fetches, and nothing consults a remote.
 *
 * ## Finding git at all — writer correction 8
 *
 * Spawning a bare `git` requires git on the `PATH` the editor inherited, which
 * on Windows is frequently NOT the PATH a GUI-launched application has. VS Code
 * ships a `git.path` setting for exactly that reason, and its own git extension
 * publishes the binary it resolved as `api.git.path`. So the recorder can fail
 * to find a git that VS Code, in the same process, is happily using.
 *
 * {@link resolveGitPathCandidates} turns what VS Code knows into an ORDERED
 * candidate list and {@link createGitRunner} walks it, and the ordering is the
 * whole design:
 *
 *  1. `api.git.path` — the binary VS Code actually resolved. It already honours
 *     the setting, so it is the most specific answer available.
 *  2. the `git.path` setting, which is a string OR an array of candidate paths
 *     (the setting's own documented shape) — the fallback for a git extension
 *     that is present but does not publish `git.path`.
 *  3. bare `'git'`, i.e. the PATH lookup, which is what shipped before this and
 *     is right on every machine where it was already right.
 *
 * A candidate that cannot be STARTED (`ENOENT`: not there; `EACCES`/`EPERM`: not
 * runnable; `ENOTDIR`/`EINVAL`: not a program) falls through to the next one. A
 * candidate that DID start and then failed — a non-zero exit, a timeout — does
 * NOT: git was found and answered, and re-running a different binary would only
 * spend the 5s budget twice to be told the same thing.
 *
 * Still no shell (`execFile`), so a path containing spaces —
 * `C:\Program Files\Git\cmd\git.exe`, the Windows default — needs no quoting
 * and behaves identically on every platform. The corollary is that a `.cmd` or
 * `.bat` git wrapper cannot be launched: Node refuses it without a shell, which
 * lands in the fall-through and finally in an omission. Reintroducing a shell to
 * support one would buy back every cross-platform quoting difference `execFile`
 * exists to avoid.
 *
 * Every rung of that ladder still ends at OMISSION. Resolution can only ever
 * find a git that would otherwise have been missed; it can never invent a value.
 */

import { execFile } from 'node:child_process';
import { readRepositoryDiscriminator, REPOSITORY_DISCRIMINATOR_FIELD } from '@provenance/log-core';

/**
 * Runs a `git` subcommand in `cwd` and resolves its stdout.
 *
 * Injected so the unit tests can drive the derivation rules without a git
 * binary, and so a failure mode (non-zero exit, timeout, missing binary) is
 * expressible as a rejection in a test.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/** How long either command may take before the field is simply omitted. */
const GIT_TIMEOUT_MS = 5_000;

/** 1 MiB. A root-commit listing is a handful of lines; anything larger is wrong. */
const GIT_MAX_BUFFER = 1024 * 1024;

/**
 * Spawns ONE git executable. The seam beneath {@link GitRunner}, so the
 * candidate-fall-through logic can be tested without a git binary and without a
 * process.
 */
export type GitSpawn = (
  file: string,
  args: readonly string[],
  cwd: string,
) => Promise<string>;

/** The PATH lookup — what shipped before `git.path` was consulted. */
export const BARE_GIT_COMMAND = 'git';

/**
 * What VS Code knows about where git lives.
 *
 * Both fields are `unknown` on purpose: one comes from an extension's untyped
 * `exports`, the other from a user-editable settings file. Neither is trusted to
 * be a string, and neither is trusted to exist.
 */
export type GitPathHints = {
  /** `api.git.path` from the vscode.git extension's API v1. */
  readonly extensionApiGitPath?: unknown;
  /** The `git.path` setting: a string, an ARRAY of candidate paths, or absent. */
  readonly configuredGitPath?: unknown;
};

/** True for a string worth spawning: present, and not blank. */
function isSpawnableCandidate(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The ordered list of git executables to try, most specific first, always ending
 * at the bare PATH lookup.
 *
 * Pure, and deliberately so: this is the half of the resolution that has to be
 * right on a platform none of us can run here, so it is unit-testable against
 * Windows-shaped inputs without spawning anything.
 *
 * Candidates are kept VERBATIM — never trimmed, never quoted, never split. A
 * path containing spaces is a path containing spaces; `execFile` passes it to
 * the OS as one argument, and trimming it would corrupt the one platform where
 * a trailing space in a filename is legal. A blank entry is dropped because it
 * cannot name anything; a non-string entry is dropped because it cannot either.
 *
 * The result is never empty: {@link BARE_GIT_COMMAND} is always last, so a
 * machine where nothing is configured behaves exactly as it did before this
 * function existed.
 */
export function resolveGitPathCandidates(hints: GitPathHints = {}): readonly string[] {
  const ordered: string[] = [];

  const push = (value: unknown): void => {
    if (!isSpawnableCandidate(value)) return;
    // De-duplicated exactly, not case-insensitively: Windows paths are
    // case-insensitive but POSIX ones are not, and dropping a genuinely
    // distinct candidate is worse than spawning a duplicate once at setup.
    if (!ordered.includes(value)) ordered.push(value);
  };

  // 1. VS Code's own resolved binary. It already accounts for the setting.
  push(hints.extensionApiGitPath);

  // 2. The setting itself, string or array — both shapes are documented by the
  //    setting, and an array is tried in order, which is what VS Code does.
  const configured = hints.configuredGitPath;
  if (Array.isArray(configured)) {
    for (const entry of configured as readonly unknown[]) push(entry);
  } else {
    push(configured);
  }

  // 3. The PATH lookup, always, as the last resort.
  push(BARE_GIT_COMMAND);

  return ordered;
}

/**
 * `error.code` values that mean the candidate never STARTED, so the next
 * candidate deserves a turn.
 *
 * A candidate that started and then failed is absent from this list on purpose:
 * a non-zero exit ("not a git repository") and a timeout are answers, and
 * re-asking a different binary spends the budget again to hear the same thing.
 */
const CANDIDATE_UNUSABLE_CODES: ReadonlySet<string> = new Set([
  'ENOENT', // no such executable — the case `git.path` exists for
  'ENOTDIR', // a path component is not a directory
  'EACCES', // present but not executable
  'EPERM', // present, executable, refused by policy
  'EINVAL', // not a launchable program (e.g. a .cmd/.bat wrapper, no shell)
]);

function isCandidateUnusable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && CANDIDATE_UNUSABLE_CODES.has(code);
}

/** Spawns one git via `execFile`: no shell, hidden window, bounded time and output. */
const execFileSpawn: GitSpawn = (file, args, cwd) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

/**
 * A {@link GitRunner} that tries each candidate in order until one STARTS.
 *
 * The rejection it finally propagates is the LAST candidate's, and every
 * rejection means the same thing to {@link deriveRootCommitSha}: omit. This
 * function can therefore only ever turn a missing-git omission into a value; it
 * has no path that turns a value into something else.
 */
export function createGitRunner(
  candidates: readonly string[] = [BARE_GIT_COMMAND],
  spawn: GitSpawn = execFileSpawn,
): GitRunner {
  const ladder = candidates.length > 0 ? candidates : [BARE_GIT_COMMAND];
  return async (args, cwd) => {
    let lastError: unknown;
    for (const file of ladder) {
      try {
        return await spawn(file, args, cwd);
      } catch (e) {
        if (!isCandidateUnusable(e)) throw e;
        lastError = e;
      }
    }
    throw lastError;
  };
}

/**
 * True iff `value` is what every reader accepts as a repository discriminator.
 *
 * Deliberately delegates to log-core's reader rather than restating its regex:
 * one narrowing, four consumers (this monorepo's analyzer and server through
 * `analysis-core`, plus the two sibling recorder repos). A rename of the field
 * is a compile error here rather than a silent cross-repository disagreement.
 */
function isUsableDiscriminator(value: string): boolean {
  return (
    readRepositoryDiscriminator({ [REPOSITORY_DISCRIMINATOR_FIELD]: value }).kind === 'recorded'
  );
}

/**
 * Derive the repository discriminator for one repository, or `undefined` to
 * OMIT the field.
 *
 * Called ONCE per repository at git-wiring setup — never per event. It cannot
 * change for the life of a repository, and the event path must not pay for it.
 *
 * Never throws and never rejects: every failure is an omission.
 */
export async function deriveRootCommitSha(
  repoRootFsPath: string,
  run: GitRunner = createGitRunner(),
): Promise<string | undefined> {
  try {
    // A shallow clone's boundary commit has no parents and is NOT a root.
    // Anything but a definite `false` omits — an older git that does not know
    // the flag errors out and lands in the catch below, which is also an
    // omission.
    const shallow = (await run(['rev-parse', '--is-shallow-repository'], repoRootFsPath)).trim();
    if (shallow !== 'false') return undefined;

    const out = await run(
      ['rev-list', '--max-parents=0', '--first-parent', 'HEAD'],
      repoRootFsPath,
    );

    const roots = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter(isUsableDiscriminator);

    if (roots.length === 0) return undefined;

    // Several roots is ORDINARY and never a finding. Lexicographically smallest
    // is deterministic, which is what makes two partners agree.
    roots.sort();
    return roots[0];
  } catch {
    // git missing, not a repository, timed out, empty repository (`HEAD` does
    // not resolve), permission denied — all the same answer. Guessing is worse
    // than silence, and silence costs only correlation.
    return undefined;
  }
}
