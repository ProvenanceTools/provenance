/**
 * Reading one workspace-relative path's on-disk state, shared by both seals.
 *
 * `commands/seal.ts` (the classic seal) and `io/rolling-seal-writer.ts` (the
 * rolling seal) each need to answer the exact same question for a candidate
 * path — present-with-hash, genuinely absent, unreadable, or resolved outside
 * the workspace — and answer it the exact same way, or the two seals of the
 * same session can disagree about a file's status. This module is the ONE
 * implementation; both seals import it rather than keeping their own copies.
 *
 * As of task 13's fix round 1, this is a straight extraction: `seal.ts`'s
 * `readReviewedFile` and `rolling-seal-writer.ts`'s (now-removed) local
 * `readTrackedFile` were statement-for-statement identical except for whether
 * the `present` case carried the raw bytes a ZIP needs — the classic seal
 * does, the rolling seal only ever needed the hash. `withBytes` is that one
 * difference, expressed as an option rather than as two copies of everything
 * else.
 *
 * ## Why `missing` is reachable from exactly ONE condition
 *
 * `missing` is an AFFIRMATIVE claim about the student — "this file was named
 * and is not there" — rendered to staff as "File listed in files_under_review
 * but absent on disk at seal time" and used in academic-integrity
 * proceedings. Emitting one about a file the student actually submitted is
 * the worst failure this system can produce (this cost four fix rounds on the
 * classic seal to close completely — see `commands/seal.ts`'s git history).
 * So `missing` may only be minted for the ONE errno that actually means "this
 * file does not exist": ENOENT, from either the containment check or the
 * final read. Every other outcome — a permission error, a directory where a
 * file was expected, a symlink cycle, too many open files, a non-regular file
 * (a FIFO would block `readFile` forever with no timeout anywhere in this
 * call stack) — is `unreadable` instead: the file's existence is either
 * known-true or simply undetermined, and reporting `missing` for any of those
 * would be a false claim.
 *
 * `out_of_workspace` is its own, third outcome, never folded into `missing`
 * either: a path that resolves — after following every symlink — outside the
 * workspace root is not "absent", it is "there, and we refuse to read it
 * because we cannot vouch for where it points". The overwhelmingly common way
 * to reach this is not an attack: a student's `ln -s ~/shared/data.csv
 * data.csv`, with `data.csv` an exact `track` entry. Minting `missing` for
 * that told staff "the student didn't submit it" about a file sitting on disk
 * and fully readable — the single worst output this system can produce, and
 * because every such warning was false, one the student was never even
 * shown.
 *
 * Callers (`commands/seal.ts` step 3, `rolling-seal-writer.ts`'s
 * `collectSubmissionFiles`) are responsible for the SECOND half of the
 * invariant: only an EXACT `scope.track` entry may ever turn a `missing`
 * result from here into a `SubmissionFileEntry` with `status: 'missing'` — a
 * rule entry (`src/`, `*.java`) asserts nothing about any particular file
 * existing, so a rule-matched path this module reports `missing` for (i.e.
 * vanished between the walk sighting it and the read here) must be DROPPED by
 * the caller, never recorded.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

/**
 * Where a candidate path really lives relative to the workspace root.
 *
 * `unresolved` carries the errno so the caller can classify it EXACTLY the way
 * the read attempt itself would have — see `resolveContainment`'s docstring
 * for why that equivalence is what makes failing closed free.
 */
export type Containment =
  | { kind: 'inside' }
  | { kind: 'outside' }
  | { kind: 'unresolved'; code: string | undefined };

/**
 * Where `absPath` really sits relative to `realRoot`, after resolving ALL
 * symlinks on BOTH sides.
 *
 * Both sides must be realpath'd, not just one: realpathing only `absPath`
 * would still miss the actual escape this exists for — a symlink INSIDE the
 * workspace (e.g. `out.txt`) whose target resolves OUTSIDE it — because a
 * lexically-inside symlink only reveals where it really points once ITS OWN
 * link is followed. And realpathing only `absPath` while comparing against the
 * LEXICAL root would reject every path in a perfectly ordinary macOS
 * workspace: `/var/folders/...` (Node's default `os.tmpdir()`, and this
 * module's own test fixtures) is itself a symlink to `/private/var/folders/...`,
 * so the root's own lexical and real forms already disagree before any
 * workspace file is considered.
 *
 * FAILS CLOSED. An earlier version of this check returned TRUE ("cannot prove
 * escape") whenever `realpath` threw, and let the read proceed against an
 * unverified path. That fail-open existed for exactly one reason: the
 * rejection branch used to mint a `missing` record, so rejecting an ordinary
 * in-workspace file that merely sat under an unreadable directory would have
 * produced a FALSE ACCUSATION. Once rejection stopped minting `missing` (see
 * this module's own docstring), that justification was gone, and a security
 * check should not default to "allow" on error.
 *
 * Failing closed costs nothing real, because of a syscall equivalence:
 * `realpath(p)` and `readFile(p)` walk the same path with the same resolution
 * rules and the same permission checks, so whenever `realpath` fails,
 * `readFile` fails with the identical errno. `unresolved` therefore carries
 * that errno up, and `readWorkspaceFile` classifies it EXACTLY as it would
 * have classified the read's own failure: ENOENT -> `missing` (the file
 * genuinely is not there, and there is no target outside the root to leak),
 * anything else -> `unreadable`. The outcome is byte-for-byte the same as
 * before for every non-escaping path; the only change is that a path we could
 * not verify is never opened.
 *
 * `realRoot` should be precomputed ONCE per seal call, not realpath'd again on
 * every call here — both seals bound how many files reach this check to
 * "in-scope files", not "everything under the root", so the per-call cost is
 * one `realpath` for `absPath` plus a string comparison.
 */
export async function resolveContainment(realRoot: string, absPath: string): Promise<Containment> {
  let realPath: string;
  try {
    realPath = await fsPromises.realpath(absPath);
  } catch (e) {
    return { kind: 'unresolved', code: (e as NodeJS.ErrnoException).code };
  }
  return realPath === realRoot || realPath.startsWith(realRoot + path.sep)
    ? { kind: 'inside' }
    : { kind: 'outside' };
}

// ---------------------------------------------------------------------------
// readWorkspaceFile
// ---------------------------------------------------------------------------

/** `readWorkspaceFile`'s result when the caller did not ask for raw bytes. */
export type WorkspaceFileReadResult =
  | { path: string; status: 'present'; sha256: string }
  | { path: string; status: 'missing'; sha256: null }
  | { path: string; status: 'unreadable' }
  | { path: string; status: 'out_of_workspace' };

/** `readWorkspaceFile`'s result when the caller asked for raw bytes (`withBytes: true`). */
export type WorkspaceFileReadResultWithBytes =
  | { path: string; status: 'present'; sha256: string; bytes: Uint8Array }
  | { path: string; status: 'missing'; sha256: null }
  | { path: string; status: 'unreadable' }
  | { path: string; status: 'out_of_workspace' };

/**
 * Read one workspace-relative path's on-disk state: present-with-hash,
 * missing (ENOENT only), unreadable (any other read failure), or
 * out-of-workspace (resolves, after following every symlink, outside the
 * workspace root). `relPath` is resolved against `workspaceRoot`;
 * `workspaceRealRoot` is `workspaceRoot` with all symlinks already resolved
 * (see `resolveContainment`).
 *
 * `withBytes: true` (the classic seal's ZIP step needs the raw bytes)
 * attaches them to the `present` case; omitted or `false` (the rolling seal
 * only ever needs the hash) does not. See this module's docstring for the
 * full "why `missing` is reachable from exactly one condition" reasoning.
 */
export async function readWorkspaceFile(
  workspaceRoot: string,
  workspaceRealRoot: string,
  relPath: string,
  opts: { withBytes: true },
): Promise<WorkspaceFileReadResultWithBytes>;
export async function readWorkspaceFile(
  workspaceRoot: string,
  workspaceRealRoot: string,
  relPath: string,
  opts?: { withBytes?: false },
): Promise<WorkspaceFileReadResult>;
export async function readWorkspaceFile(
  workspaceRoot: string,
  workspaceRealRoot: string,
  relPath: string,
  opts?: { withBytes?: boolean },
): Promise<WorkspaceFileReadResult | WorkspaceFileReadResultWithBytes> {
  const withBytes = opts?.withBytes === true;
  const abs = path.join(workspaceRoot, relPath);
  const containment = await resolveContainment(workspaceRealRoot, abs);
  if (containment.kind === 'outside') {
    // Never `missing` — see this module's docstring. A path the walk itself
    // produced can never trip this: it is always built from real (non-symlink)
    // directory entries under `workspaceRoot`, all the way down (see
    // `workspace-walk.ts`). Only a manifest-supplied EXACT entry, read
    // directly by string, can land here.
    return { path: relPath, status: 'out_of_workspace' };
  }
  if (containment.kind === 'unresolved') {
    // Fail closed: the path was NOT verified, so it is not opened. Classify it
    // exactly as the read itself would have — see `resolveContainment`'s
    // docstring for the syscall equivalence that makes this lossless.
    return containment.code === 'ENOENT'
      ? { path: relPath, status: 'missing', sha256: null }
      : { path: relPath, status: 'unreadable' };
  }
  // Only a REGULAR file may be read. `fsPromises.readFile` on a FIFO BLOCKS
  // FOREVER waiting for a writer, with no timeout anywhere in this call stack:
  // a student who does `rm Main.java && mkfifo Main.java` (`Main.java` being
  // an exact `track` entry, and FIFOs being invisible to the walk's `isFile()`
  // check) would hang the whole seal. `stat` never blocks on a FIFO — only
  // `open` does — so this gate is safe to take first. It also gives
  // directories (an ordinary staff manifest typo naming `src` instead of
  // `src/`) a cleaner home than catching EISDIR off the read, and covers
  // sockets, devices, and block specials for free. `stat` follows symlinks,
  // matching `readFile`'s own semantics, so a symlink to a regular file
  // inside the workspace still passes.
  let isRegularFile: boolean;
  try {
    isRegularFile = (await fsPromises.stat(abs)).isFile();
  } catch (e) {
    const statCode = (e as NodeJS.ErrnoException).code;
    return statCode === 'ENOENT'
      ? { path: relPath, status: 'missing', sha256: null }
      : { path: relPath, status: 'unreadable' };
  }
  if (!isRegularFile) {
    return { path: relPath, status: 'unreadable' };
  }
  try {
    const bytes = await fsPromises.readFile(abs);
    const hash = createHash('sha256');
    hash.update(bytes);
    return {
      path: relPath,
      status: 'present',
      sha256: hash.digest('hex'),
      ...(withBytes
        ? { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
        : {}),
    };
  } catch (e) {
    // `missing` may only be minted for the one errno that actually means
    // "this file does not exist": ENOENT. See this module's docstring.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { path: relPath, status: 'missing', sha256: null };
    }
    return { path: relPath, status: 'unreadable' };
  }
}
