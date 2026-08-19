/**
 * Pure nearest-ancestor ownership resolution (spec Design §3, Locked decision 5:
 * "A file belongs to the session of the nearest ancestor directory that has a
 * verified manifest"). No VS Code imports — testable in complete isolation.
 *
 * This is the single source of truth "given a path, which assignment root owns
 * it?" answer that every wiring module (doc, fs-watcher, terminal, git) consults
 * to build its own isOwnedByThisRoot filter (plan decision 2).
 */

import * as path from 'node:path';

/**
 * Resolve which of `assignmentRoots` is the nearest ancestor of `filePath`, or
 * null if none of them contain it.
 *
 * "Nearest ancestor" = the longest matching root path (a root nested inside
 * another root wins for paths beneath it, per spec Locked decision 5).
 *
 * A path equal to a root itself is considered owned by that root (path.relative
 * returns '' in that case).
 */
export function resolveOwnerRoot(
  filePath: string,
  assignmentRoots: readonly string[],
): string | null {
  let best: string | null = null;

  for (const root of assignmentRoots) {
    if (!containsOrEquals(root, filePath)) continue;

    if (best === null || root.length > best.length) {
      best = root;
    }
  }

  return best;
}

/**
 * True when `dir` is `p` itself or an ancestor directory of `p`.
 *
 * Shared by {@link resolveOwnerRoot} (which asks "does this root contain the
 * file?") and {@link isRepoOwnedByRoot} (which also has to ask the opposite
 * question).
 */
function containsOrEquals(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Does the git repository rooted at `repoRoot` belong to the session recording
 * `assignmentRoot`?
 *
 * WHY THIS IS NOT `resolveOwnerRoot`. `resolveOwnerRoot` is a *containment*
 * predicate written for FILES: it answers "which assignment root contains this
 * path?". A repository root is, in the standard course layout, an ANCESTOR of
 * the assignment root — one repo at `/repo`, one `.provenance/` per assignment
 * under `/repo/proj2`. No assignment root contains `/repo`, so
 * `resolveOwnerRoot('/repo', ['/repo/proj2'])` is `null`, the equality check
 * against the session's own root fails, and every `git.event` for that session
 * is dropped. That is git-collaboration spec §3 S14(a): the commit-graph
 * programme is 100% dark for every nested-assignment layout, silently, and it is
 * a free evasion — put the manifest one directory down and no git activity is
 * ever recorded.
 *
 * The relationship that actually matters for a repository is "these two paths
 * are on the same branch of the filesystem tree", in either direction:
 *
 *  - **repo above the assignment** (`/repo` owns `/repo/proj2`) — the nested
 *    layout the manifest-discovery work exists to support. This is the case that
 *    was broken.
 *  - **repo at or below the assignment** (`/repo/proj2/lib`, a submodule) —
 *    already worked, via the nearest-ancestor rule, and is preserved verbatim so
 *    that a repository nested inside a *nested* assignment root still routes to
 *    the nearest root rather than to its parent.
 *
 * Anything else — a sibling repository, an unrelated folder elsewhere in a
 * multi-root workspace — is NOT owned, which is the case the original check
 * exists to defend and which stays defended.
 *
 * Deliberately NOT implemented here: the spec's further refinement that only the
 * *nearest* containing repository should win when several are visible
 * (submodules). Narrowing to the nearest would REMOVE the descendant case that
 * is captured today, and a scope observing more than one repository is unsound
 * until the `git.event` repository discriminator is decided (spec §8.6, an open
 * product question). Recording from both is the fail-toward-more-evidence
 * direction; deduplicating them is the analyzer's job once §8.6 is answered.
 *
 * @param repoRoot             Absolute fsPath of the git repository root.
 * @param assignmentRoot       Absolute fsPath of THIS session's assignment root.
 * @param allAssignmentRoots   Every assignment root currently recording, so the
 *                             nearest-ancestor rule still applies below.
 */
export function isRepoOwnedByRoot(
  repoRoot: string,
  assignmentRoot: string,
  allAssignmentRoots: readonly string[],
): boolean {
  // Repository at or below an assignment root: nearest root wins (unchanged).
  if (resolveOwnerRoot(repoRoot, allAssignmentRoots) === assignmentRoot) return true;
  // Repository above the assignment root: the case `resolveOwnerRoot` can never
  // express, because a containment test cannot match an ancestor.
  return containsOrEquals(repoRoot, assignmentRoot);
}
