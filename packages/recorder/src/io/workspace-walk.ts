/**
 * The shared workspace walk, used by both seals.
 *
 * `commands/seal.ts` (the classic seal, run once at `provenance.
 * prepareSubmissionBundle`) and `io/rolling-seal-writer.ts` (the rolling seal,
 * rewritten on every checkpoint for a git-submitted assignment) both need to
 * enumerate every file under the workspace and assign it a role via
 * {@link resolvePathRole} from `@provenance/log-core`. Two copies of a
 * directory walk that must agree about hard exclusions is exactly the
 * divergence path-scope exists to avoid — a course scoped to `src/` must not
 * get one seal that lists it and another that lists nothing — so this module
 * is the ONE walk both seals import.
 *
 * `hasHardExcludedSegment` is exported alongside `walkWorkspace` because an
 * EXACT `track` entry read directly by string (never discovered by the walk,
 * so never pruned by it) must be checked against the same rule before it is
 * read — see the docstring below and each seal's own exact-entry loop.
 */

import * as fsPromises from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { isHardExcluded } from '@provenance/log-core';

/**
 * True if any path SEGMENT of `relPath` is exactly `.git` or `.provenance`.
 *
 * Shared by `walkWorkspace` (which prunes at the directory level, so it only
 * ever needs to check one segment at a time) and each seal's own exact-entry
 * loop, which reads a manifest-supplied path directly and so never passes
 * through the walk's own pruning at all — an EXACT entry naming a path inside
 * a nested `.git/`/`.provenance/` must be caught here too (fix round 2,
 * Important 2), the same leak `walkWorkspace`'s docstring describes.
 */
export function hasHardExcludedSegment(relPath: string): boolean {
  return relPath.split('/').some((seg) => seg === '.git' || seg === '.provenance');
}

/** Result of walking one subtree: the files found, and whether any directory in it refused to list. */
export type WalkResult = { paths: string[]; hadUnreadableDir: boolean };

/**
 * Every file under `root`, as workspace-relative forward-slash paths.
 *
 * Hard-excluded directories are skipped at the DIRECTORY level rather than
 * filtered afterwards: `.git/` in a real assignment holds thousands of objects,
 * and walking them to throw them away is the difference between a seal that
 * feels instant and one that does not.
 *
 * The skip is by SEGMENT NAME (`d.name === '.git' || d.name === '.provenance'`),
 * not `isHardExcluded`'s root-anchored prefix check. `isHardExcluded` only
 * matches a path that STARTS WITH `.git/` or `.provenance/`, so it says nothing
 * about `vendor/lib/.git/` (a submodule) or, worse, a SIBLING assignment's
 * `.provenance/` under this repo's nested/concurrent multi-assignment
 * recording (spec `2026-08-18-multicourse-program-architecture.md`) — a rule
 * entry like `*.json` would otherwise walk into `hw3/.provenance/` and seal
 * that assignment's signed manifest into THIS bundle, leaking one student's
 * provenance into another's evidence. `isHardExcluded` is deliberately NOT
 * changed to do this itself: it is pinned by `tools/path-scope-vectors.json`
 * and re-implemented by hand in the JetBrains and Neovim recorders, so its root
 * semantics stay put and this walk-local rule covers the deeper case instead.
 * The `isHardExcluded` call is kept alongside as a second, redundant check —
 * cheap insurance if the hard-excluded prefix list ever grows past this pair.
 * This pruning only protects paths the WALK produces. An EXACT `track` entry
 * naming a nested `.git/`/`.provenance/` path reads directly by string and
 * never passes through here, so each seal's own exact-entry loop applies the
 * same `hasHardExcludedSegment` check again, itself, against the manifest
 * string.
 *
 * `Dirent.isDirectory()` / `isFile()` do not follow symlinks (they classify the
 * directory ENTRY itself, `lstat`-flavoured) — see `should not recurse into a
 * symlinked directory` in `seal.test.ts`. A symlinked directory is therefore
 * neither traversed nor walked into, so this cannot cycle on a self-referential
 * link or walk outside the workspace through one. A symlinked FILE is likewise
 * not reported as `isFile()` here and so never appears in the walk's output; an
 * EXACT `track` entry naming one is still resolved correctly by each seal's own
 * read step, because that step reads it directly, which does follow the link.
 *
 * A directory this function cannot `readdir` (most often a permissions
 * problem) is not silently treated as empty: `hadUnreadableDir` bubbles that up
 * so the caller can warn rather than let the subtree's files vanish from the
 * bundle without a trace.
 */
export async function walkWorkspace(root: string, rel = ''): Promise<WalkResult> {
  let dirents: Dirent[];
  try {
    dirents = await fsPromises.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return { paths: [], hadUnreadableDir: true };
  }
  const out: string[] = [];
  let hadUnreadableDir = false;
  for (const d of dirents) {
    const childRel = rel === '' ? d.name : `${rel}/${d.name}`;
    if (d.isDirectory()) {
      if (hasHardExcludedSegment(d.name) || isHardExcluded(`${childRel}/`)) {
        continue;
      }
      const child = await walkWorkspace(root, childRel);
      out.push(...child.paths);
      if (child.hadUnreadableDir) hadUnreadableDir = true;
    } else if (d.isFile()) {
      out.push(childRel);
    }
  }
  return { paths: out, hadUnreadableDir };
}
