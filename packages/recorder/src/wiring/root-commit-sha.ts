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

const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

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
  run: GitRunner = defaultGitRunner,
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
