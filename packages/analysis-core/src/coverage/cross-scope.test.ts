/**
 * Same-repository-lineage exclusion for cross-submission comparison — spec S20.
 *
 * The five facts these tests hold the partition to are the five ways it can be
 * wrong, and four of the five make the system WORSE than the bug being fixed:
 *
 *  1. Two honest partners on one shared `.provenance/` must not be compared.
 *  2. Two unrelated students must still be compared. (Negative control.)
 *  3. Two UNLABELLED scopes must still be compared — the `ASSUMED_SINGLE_REPOSITORY`
 *     sentinel is not evidence of anything, and excluding on it would suppress
 *     genuine detection for every bundle recorded to date.
 *  4. A scope that observed no commits at all must still be compared.
 *  5. Every exclusion must be VISIBLE, with the commits that proved it.
 */

import { describe, expect, it } from 'vitest';
import { ASSUMED_SINGLE_REPOSITORY, commitNodeKey } from '../git/observed-dag.js';
import { partitionCrossScopes } from './cross-scope.js';
import type { CrossSubmissionFeatures } from '../heuristics/cross/types.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const ROOT_ONE = '1'.repeat(40);
const ROOT_TWO = '2'.repeat(40);

function features(
  bundleId: string,
  observedCommitKeys?: readonly string[],
): CrossSubmissionFeatures {
  return {
    bundleId,
    sourceFilename: `${bundleId}.zip`,
    pastes: [],
    kindNgrams: new Set<string>(),
    eventCount: 0,
    representativeSeqKeys: [],
    ...(observedCommitKeys === undefined ? {} : { observedCommitKeys }),
  };
}

/** Unlabelled: what every recorder emitting no `root_commit_sha` produces. */
function unlabelled(...shas: string[]): string[] {
  return shas.map((s) => commitNodeKey(ASSUMED_SINGLE_REPOSITORY, s));
}

function labelled(root: string, ...shas: string[]): string[] {
  return shas.map((s) => commitNodeKey(`repository:${root}`, s));
}

describe('partitionCrossScopes', () => {
  it('puts two partners who observed the same commit in one lineage', () => {
    const p = partitionCrossScopes([
      features('alice', unlabelled(A, B)),
      features('bob', unlabelled(B, C)),
    ]);

    expect(p.lineageOf.get('alice')).toBe(p.lineageOf.get('bob'));
  });

  it('keeps two unrelated students in DIFFERENT lineages — the negative control', () => {
    const p = partitionCrossScopes([
      features('alice', unlabelled(A)),
      features('carol', unlabelled(C)),
    ]);

    expect(p.lineageOf.get('alice')).not.toBe(p.lineageOf.get('carol'));
    expect(p.exclusions).toEqual([]);
  });

  it('does NOT merge two unlabelled scopes that share no commit', () => {
    // Both sides fold into ASSUMED_SINGLE_REPOSITORY, which is the honest answer
    // when nothing names a repository and is the state of every bundle recorded
    // to date. If the sentinel itself excluded, cross-detection would be off for
    // the entire corpus — strictly worse than the bug this fixes.
    const p = partitionCrossScopes([
      features('alice', unlabelled(A)),
      features('carol', unlabelled(B)),
    ]);

    expect(p.lineageOf.get('alice')).not.toBe(p.lineageOf.get('carol'));
  });

  it('does NOT merge two scopes that each observed nothing', () => {
    // "No commits" is an absence, not a shared commit. Two students who never
    // ran git are not partners.
    const p = partitionCrossScopes([features('alice', []), features('carol', [])]);

    expect(p.lineageOf.get('alice')).not.toBe(p.lineageOf.get('carol'));
    expect(p.exclusions).toEqual([]);
  });

  it('does NOT merge scopes whose commit lists were never computed', () => {
    // `observedCommitKeys` absent means the producer predates the field, not
    // that the scopes match. Absence must read as "no exclusion", so an older
    // construction site behaves exactly as it did before.
    const p = partitionCrossScopes([features('alice'), features('carol')]);

    expect(p.lineageOf.get('alice')).not.toBe(p.lineageOf.get('carol'));
  });

  it('does not merge the same sha observed under two DIFFERENT repository keys', () => {
    // A submodule's shas live in their own object space. `commitNodeKey` is the
    // one id rule in this codebase and this partition uses it unmodified.
    const p = partitionCrossScopes([
      features('alice', labelled(ROOT_ONE, A)),
      features('carol', labelled(ROOT_TWO, A)),
    ]);

    expect(p.lineageOf.get('alice')).not.toBe(p.lineageOf.get('carol'));
  });

  it('merges transitively: A~B and B~C puts all three in one lineage', () => {
    const p = partitionCrossScopes([
      features('a', unlabelled(A)),
      features('b', unlabelled(A, B)),
      features('c', unlabelled(B)),
    ]);

    expect(p.lineageOf.get('a')).toBe(p.lineageOf.get('b'));
    expect(p.lineageOf.get('b')).toBe(p.lineageOf.get('c'));
    expect(p.exclusions).toHaveLength(1);
    expect(p.exclusions[0]!.bundleIds).toEqual(['a', 'b', 'c']);
  });

  it('states each exclusion as a visible fact, naming the commits that proved it', () => {
    const p = partitionCrossScopes([
      features('alice', unlabelled(A, B)),
      features('bob', unlabelled(B, C)),
      features('carol', unlabelled('d'.repeat(40))),
    ]);

    expect(p.exclusions).toHaveLength(1);
    const ex = p.exclusions[0]!;
    expect(ex.reason).toBe('same_repository_lineage');
    expect(ex.bundleIds).toEqual(['alice', 'bob']);
    expect(ex.sourceFilenames).toEqual(['alice.zip', 'bob.zip']);
    // Only B is shared. A and C are one-sided and prove nothing.
    expect(ex.sharedCommits).toEqual(unlabelled(B));
    expect(ex.excludedPairCount).toBe(1);
    // Carol is not in any exclusion — she is comparable against both.
    expect(p.exclusions.flatMap((e) => e.bundleIds)).not.toContain('carol');
  });

  it('is deterministic and order-independent', () => {
    const fa = features('alice', unlabelled(A, B));
    const fb = features('bob', unlabelled(B, C));
    const fc = features('carol', unlabelled('d'.repeat(40)));

    const forward = partitionCrossScopes([fa, fb, fc]);
    const backward = partitionCrossScopes([fc, fb, fa]);

    expect(forward.exclusions).toEqual(backward.exclusions);
  });

  it('does not treat a repeated key inside ONE submission as two observers', () => {
    // `observedCommitKeysOf` never emits a duplicate, but this shape round-trips
    // through JSON from two producers and is hand-built in tests. One submission
    // naming a commit twice is corroboration, not a second holder of the
    // repository, and must not make that commit "proven shared".
    const p = partitionCrossScopes([
      { ...features('alice'), observedCommitKeys: [...unlabelled(A), ...unlabelled(A)] },
      features('carol', unlabelled(B)),
    ]);

    expect(p.lineageOf.get('alice')).not.toBe(p.lineageOf.get('carol'));
    expect(p.exclusions).toEqual([]);
  });

  it('reports a singleton lineage as no exclusion at all', () => {
    const p = partitionCrossScopes([features('solo', unlabelled(A))]);
    expect(p.exclusions).toEqual([]);
  });
});
