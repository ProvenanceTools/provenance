import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { isRepoOwnedByRoot, resolveOwnerRoot } from './session-router.js';

describe('resolveOwnerRoot', () => {
  const cats = path.join('/ws', '61a', 'cats');
  const hog = path.join('/ws', '61a', 'hog');
  const roots = [cats, hog];

  it('routes a file under one root to that root only', () => {
    expect(resolveOwnerRoot(path.join(cats, 'x.py'), roots)).toBe(cats);
  });

  it('routes a file under a sibling root to that root, not the first one', () => {
    expect(resolveOwnerRoot(path.join(hog, 'y.py'), roots)).toBe(hog);
  });

  it('returns null for a file owned by no root', () => {
    expect(resolveOwnerRoot(path.join('/ws', '61a', 'notes.md'), roots)).toBeNull();
  });

  it('does not treat a sibling with a shared string prefix as owned', () => {
    // "cats-extra" starts with the string "cats" but is not inside the cats/ directory.
    const catsExtra = path.join('/ws', '61a', 'cats-extra');
    expect(resolveOwnerRoot(path.join(catsExtra, 'z.py'), roots)).toBeNull();
  });

  it('nearest-enclosing manifest wins for a nested case', () => {
    const catsNested = path.join(cats, 'subproj');
    const nestedRoots = [cats, catsNested];
    expect(resolveOwnerRoot(path.join(catsNested, 'a.py'), nestedRoots)).toBe(catsNested);
    expect(resolveOwnerRoot(path.join(cats, 'b.py'), nestedRoots)).toBe(cats);
  });

  it('a path equal to the root itself is owned by that root', () => {
    expect(resolveOwnerRoot(cats, roots)).toBe(cats);
  });

  it('returns null when there are no roots at all', () => {
    expect(resolveOwnerRoot(path.join(cats, 'x.py'), [])).toBeNull();
  });
});

describe('isRepoOwnedByRoot', () => {
  const repo = path.join('/ws', 'repo');
  const proj1 = path.join(repo, 'proj1');
  const proj2 = path.join(repo, 'proj2');

  it('owns a repository whose root CONTAINS the assignment root', () => {
    // The 61B/61C layout: one git repo, one `.provenance/` per assignment
    // beneath it. This is the case that was 100% dark — `resolveOwnerRoot` is a
    // containment predicate and no assignment root contains the repo root, so it
    // returned null and every git.event was dropped (spec §3 S14(a)).
    expect(isRepoOwnedByRoot(repo, proj2, [proj1, proj2])).toBe(true);
  });

  it('is exactly the case the old containment predicate could not express', () => {
    // Pinning the defect itself: the predicate the wiring used cannot answer
    // "does this repository contain me?" — it can only answer the reverse.
    expect(resolveOwnerRoot(repo, [proj1, proj2])).toBeNull();
  });

  it('routes one containing repository to EVERY assignment recording beneath it', () => {
    // Concurrent multi-assignment recording under a single repo: the repo's
    // history is genuinely evidence for both scopes, and each session must hold
    // its own copy inside its own signed chain.
    expect(isRepoOwnedByRoot(repo, proj1, [proj1, proj2])).toBe(true);
    expect(isRepoOwnedByRoot(repo, proj2, [proj1, proj2])).toBe(true);
  });

  it('owns a repository rooted AT the assignment root', () => {
    expect(isRepoOwnedByRoot(proj2, proj2, [proj2])).toBe(true);
  });

  it('still owns a repository nested inside the assignment root', () => {
    // Preserved verbatim from the old behaviour — narrowing to "nearest
    // containing repo only" would REMOVE evidence that is captured today.
    const submodule = path.join(proj2, 'lib');
    expect(isRepoOwnedByRoot(submodule, proj2, [proj2])).toBe(true);
  });

  it('routes a nested repository to the NEAREST assignment root, not its parent', () => {
    const nested = path.join(proj2, 'part-b');
    const submodule = path.join(nested, 'lib');
    expect(isRepoOwnedByRoot(submodule, nested, [proj2, nested])).toBe(true);
    // proj2 would still own it by the ancestor rule (it contains proj2? no —
    // submodule is BELOW proj2, so only the nearest-root rule applies).
    expect(isRepoOwnedByRoot(submodule, proj2, [proj2, nested])).toBe(false);
  });

  it('does NOT own an unrelated repository elsewhere in a multi-root workspace', () => {
    // The genuine case the check exists for, and it stays defended.
    const elsewhere = path.join('/ws', 'other-repo');
    expect(isRepoOwnedByRoot(elsewhere, proj2, [proj2])).toBe(false);
  });

  it('does NOT own a sibling repository that merely shares a string prefix', () => {
    expect(isRepoOwnedByRoot(path.join('/ws', 'repo-extra'), proj2, [proj2])).toBe(false);
  });

  it('does NOT own a sibling assignment folder that happens to be a repo', () => {
    expect(isRepoOwnedByRoot(proj1, proj2, [proj1, proj2])).toBe(false);
  });
});
