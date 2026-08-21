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
 *
 * Two more the sentinel-tolerant match adds, which pull in opposite directions
 * and are the whole difficulty of that rule:
 *
 *  6. A MIXED partner pair — one partner on a discriminator-emitting build, one
 *     on an older one — must NOT be compared. A staged rollout guarantees this
 *     shape, and without the bridge it is a live false accusation.
 *  7. Two DIFFERENT real repository keys sharing a sha must still be compared,
 *     including when an unlabelled third scope could bridge them in two hops.
 */

import { describe, expect, it } from 'vitest';
import { ASSUMED_SINGLE_REPOSITORY, commitNodeKey } from '../git/observed-dag.js';
import { partitionCrossScopes, sameRepositoryLineage } from './cross-scope.js';
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

  it('merges a MIXED-scope partner pair: one labelled build, one older one', () => {
    // The live false accusation. A staged recorder rollout puts one partner on a
    // build that emits the D12 root-commit discriminator and the other on a build
    // that does not, so the SAME commit gets two different node keys, one
    // observer each — no union, no exclusion, and the two people the course
    // assigned to collaborate get compared and flagged.
    const p = partitionCrossScopes([
      features('alice', labelled(ROOT_ONE, A)),
      features('bob', unlabelled(A)),
    ]);

    expect(p.lineageOf.get('alice')).toBe(p.lineageOf.get('bob'));
    expect(sameRepositoryLineage(p, 'alice', 'bob')).toBe(true);
    // Both participating keys are named. Claiming Bob observed
    // `repository:<root> <sha>` would be evidence the record does not contain.
    expect(p.exclusions).toHaveLength(1);
    expect(p.exclusions[0]!.sharedCommits).toEqual(
      [...labelled(ROOT_ONE, A), ...unlabelled(A)].sort(),
    );
  });

  it('does NOT bridge two DIFFERENT real repositories through the sentinel', () => {
    // The forbidden merge arrived at in two hops. Alice and carol hold two
    // different repositories that share a sha — legitimate for a submodule, a
    // fork, or a template-derived repo — and bob is unlabelled. Bridging bob to
    // both would transitively union alice with carol, which is exactly the
    // sha-space merge D12 exists to prevent. Ambiguity resolves toward comparing.
    const p = partitionCrossScopes([
      features('alice', labelled(ROOT_ONE, A)),
      features('bob', unlabelled(A)),
      features('carol', labelled(ROOT_TWO, A)),
    ]);

    expect(p.lineageOf.get('alice')).not.toBe(p.lineageOf.get('carol'));
    expect(p.lineageOf.get('alice')).not.toBe(p.lineageOf.get('bob'));
    expect(p.lineageOf.get('bob')).not.toBe(p.lineageOf.get('carol'));
    expect(p.exclusions).toEqual([]);
  });

  it('still bridges when the ONE real repository has several observers', () => {
    const p = partitionCrossScopes([
      features('alice', labelled(ROOT_ONE, A)),
      features('bob', labelled(ROOT_ONE, A)),
      features('cara', unlabelled(A)),
    ]);

    expect(p.exclusions).toHaveLength(1);
    expect(p.exclusions[0]!.bundleIds).toEqual(['alice', 'bob', 'cara']);
    expect(p.exclusions[0]!.excludedPairCount).toBe(3);
  });

  it('does not treat ONE mixed-scope submission as two observers of its own commit', () => {
    // A single bundle whose sessions are partly labelled observes the same sha
    // under both keys. That is one holder of one repository; it must not become
    // a lineage with carol, and must not become an exclusion on its own.
    const p = partitionCrossScopes([
      { ...features('alice'), observedCommitKeys: [...labelled(ROOT_ONE, A), ...unlabelled(A)] },
      features('carol', unlabelled(B)),
    ]);

    expect(p.lineageOf.get('alice')).not.toBe(p.lineageOf.get('carol'));
    expect(p.exclusions).toEqual([]);
  });

  it('is order-independent across a mixed-scope bridge', () => {
    const forward = partitionCrossScopes([
      features('alice', labelled(ROOT_ONE, A)),
      features('bob', unlabelled(A)),
    ]);
    const backward = partitionCrossScopes([
      features('bob', unlabelled(A)),
      features('alice', labelled(ROOT_ONE, A)),
    ]);

    expect(forward.exclusions).toEqual(backward.exclusions);
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
    // Deliberately shaped to exercise all three orderings at once, because each
    // is a separate place a Map's insertion order could leak into the output:
    //   - TWO lineages, so the exclusion list itself has an order;
    //   - TWO shared commits inside one lineage, listed in OPPOSITE order by its
    //     two members, so the proving-commit list has an order;
    //   - members whose filename order differs from their input order.
    // The register is read by a person and compared across runs; an order that
    // depends on which archive was uploaded first is a diff nobody can trust.
    const X = 'e'.repeat(40);
    const Y = 'f'.repeat(40);

    const zed = features('zed', unlabelled(X, Y));
    const abe = { ...features('abe'), observedCommitKeys: unlabelled(Y, X) };
    const bea = features('bea', unlabelled(A));
    const cal = features('cal', unlabelled(A));

    const forward = partitionCrossScopes([zed, abe, bea, cal]);
    const backward = partitionCrossScopes([cal, bea, abe, zed]);

    expect(forward.exclusions).toEqual(backward.exclusions);
    expect(forward.exclusions).toHaveLength(2);
    // Sorted by first bundle id: abe/zed (two shared commits) then bea/cal (one).
    expect(forward.exclusions[0]!.bundleIds).toEqual(['abe', 'zed']);
    expect(forward.exclusions[0]!.sharedCommits).toEqual(unlabelled(X, Y).sort());
    expect(forward.exclusions[1]!.bundleIds).toEqual(['bea', 'cal']);
    expect(forward.exclusions[1]!.sharedCommits).toEqual(unlabelled(A));
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

  it('never lists a one-sided commit among the commits that proved an exclusion', () => {
    // The visible half of the register is EVIDENCE, and a duplicate inside one
    // submission must not be laundered into it. Alice and Bob are one lineage
    // because of C; A appears twice but only in Alice's list, so naming A as
    // proof would be a claim nothing in the record supports.
    const p = partitionCrossScopes([
      { ...features('alice'), observedCommitKeys: [...unlabelled(A), ...unlabelled(A, C)] },
      features('bob', unlabelled(C)),
    ]);

    expect(p.exclusions).toHaveLength(1);
    expect(p.exclusions[0]!.sharedCommits).toEqual(unlabelled(C));
  });
});

describe('sameRepositoryLineage', () => {
  it('is false for a bundle the partition never saw', () => {
    // Suppression is the dangerous direction, so an id the partition does not
    // know is NOT proved to share anything with anyone. Failing toward
    // comparing means a stale or mismatched partition can only ever produce a
    // finding to review, never a silent exclusion nobody is told about.
    const p = partitionCrossScopes([features('alice', unlabelled(A))]);

    expect(sameRepositoryLineage(p, 'alice', 'nobody')).toBe(false);
    expect(sameRepositoryLineage(p, 'nobody', 'alice')).toBe(false);
    expect(sameRepositoryLineage(p, 'nobody', 'nobody-else')).toBe(false);
  });

  it('is true only for two members of one lineage', () => {
    const p = partitionCrossScopes([
      features('alice', unlabelled(A)),
      features('bob', unlabelled(A)),
      features('carol', unlabelled(B)),
    ]);

    expect(sameRepositoryLineage(p, 'alice', 'bob')).toBe(true);
    expect(sameRepositoryLineage(p, 'alice', 'carol')).toBe(false);
  });

  it('reports a singleton lineage as no exclusion at all', () => {
    const p = partitionCrossScopes([features('solo', unlabelled(A))]);
    expect(p.exclusions).toEqual([]);
  });
});
