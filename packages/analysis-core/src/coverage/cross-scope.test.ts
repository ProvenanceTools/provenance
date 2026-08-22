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
import { partitionCrossScopes, sameRepositoryLineage, sessionNodeKey } from './cross-scope.js';
import type { CrossSubmissionFeatures } from '../heuristics/cross/types.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const ROOT_ONE = '1'.repeat(40);
const ROOT_TWO = '2'.repeat(40);

function features(
  bundleId: string,
  observedCommitKeys?: readonly string[],
  recordedSessionKeys?: readonly string[],
): CrossSubmissionFeatures {
  return {
    bundleId,
    sourceFilename: `${bundleId}.zip`,
    pastes: [],
    kindNgrams: new Set<string>(),
    eventCount: 0,
    representativeSeqKeys: [],
    ...(observedCommitKeys === undefined ? {} : { observedCommitKeys }),
    ...(recordedSessionKeys === undefined ? {} : { recordedSessionKeys }),
  };
}

/** A session key for a session signed by `pubkey`. */
const sk = (pubkey: string, sessionId: string) => sessionNodeKey(pubkey, sessionId);

/** One submission carrying the given sessions and no git observation at all. */
function sessionOnly(bundleId: string, ...sessionKeys: string[]): CrossSubmissionFeatures {
  return features(bundleId, undefined, sessionKeys);
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

describe('partitionCrossScopes — the SESSION key, for a scope with no observed git', () => {
  // The commit key is a proxy for "each archive holds the other's logs", and
  // git observation is an optional capability, so the proxy is simply absent
  // for an honest pair on a host with no git integration, on a shared folder,
  // or committing from a terminal. Before this key those pairs fired
  // paste_shared_across_students at high / 0.95.
  const ALICE_KEY = 'aa'.repeat(32);
  const BOB_KEY = 'bb'.repeat(32);
  const S1 = '11111111-1111-4111-8111-111111111111';
  const S2 = '22222222-2222-4222-8222-222222222222';

  it('puts two partners who both carry one signed session in ONE lineage', () => {
    // Both archives hold BOTH logs — the add-only `.provenance/` shape, reached
    // here without a single git.event.
    const p = partitionCrossScopes([
      sessionOnly('alice', sk(ALICE_KEY, S1), sk(BOB_KEY, S2)),
      sessionOnly('bob', sk(ALICE_KEY, S1), sk(BOB_KEY, S2)),
    ]);
    expect(sameRepositoryLineage(p, 'alice', 'bob')).toBe(true);
  });

  it('reports it as shared_recording_scope, not as a repository lineage', () => {
    // The narrower claim, because no repository was demonstrated. Saying
    // "same repository" about two people who never ran git would be a claim the
    // record does not support, in the one place a grader reads the evidence.
    const p = partitionCrossScopes([
      sessionOnly('alice', sk(ALICE_KEY, S1)),
      sessionOnly('bob', sk(ALICE_KEY, S1)),
    ]);
    expect(p.exclusions).toHaveLength(1);
    const ex = p.exclusions[0]!;
    expect(ex.reason).toBe('shared_recording_scope');
    expect(ex.sharedCommits).toEqual([]);
    expect(ex.sharedSessions).toEqual([sk(ALICE_KEY, S1)]);
  });

  it('keeps two unrelated students in DIFFERENT lineages — the negative control', () => {
    const p = partitionCrossScopes([
      sessionOnly('carol', sk(ALICE_KEY, S1)),
      sessionOnly('dave', sk(BOB_KEY, S2)),
    ]);
    expect(sameRepositoryLineage(p, 'carol', 'dave')).toBe(false);
    expect(p.exclusions).toEqual([]);
  });

  it('does NOT union two sessions that share an ID but not a KEY', () => {
    // The reason the key is not a bare uuid. A recorder build that minted a
    // constant session id — or a fixture that does, which is the shape every
    // test bundle in this repo has — would otherwise union everything it
    // touched. Only the private half of the pair could have produced both.
    const p = partitionCrossScopes([
      sessionOnly('carol', sk(ALICE_KEY, S1)),
      sessionOnly('dave', sk(BOB_KEY, S1)),
    ]);
    expect(sameRepositoryLineage(p, 'carol', 'dave')).toBe(false);
  });

  it('does NOT union scopes whose session lists were never computed', () => {
    // Absent is "never computed", not "no sessions" — it must fail toward
    // comparing, exactly as the commit field does.
    const p = partitionCrossScopes([features('alice'), features('bob')]);
    expect(sameRepositoryLineage(p, 'alice', 'bob')).toBe(false);
  });

  it('does not treat ONE submission carrying a session twice as two holders', () => {
    const p = partitionCrossScopes([
      sessionOnly('alice', sk(ALICE_KEY, S1), sk(ALICE_KEY, S1)),
      sessionOnly('bob', sk(BOB_KEY, S2)),
    ]);
    expect(p.exclusions).toEqual([]);
  });

  it('prefers the repository reason when BOTH proofs exist', () => {
    // A lineage holding any shared commit is a repository lineage and says so;
    // the session proof is still listed, so the register never asserts a commit
    // it does not have and never hides one it does.
    const p = partitionCrossScopes([
      features('alice', unlabelled(A), [sk(ALICE_KEY, S1)]),
      features('bob', unlabelled(A), [sk(ALICE_KEY, S1)]),
    ]);
    expect(p.exclusions).toHaveLength(1);
    const ex = p.exclusions[0]!;
    expect(ex.reason).toBe('same_repository_lineage');
    expect(ex.sharedCommits).toEqual(unlabelled(A));
    expect(ex.sharedSessions).toEqual([sk(ALICE_KEY, S1)]);
  });
});

describe('partitionCrossScopes — the cohort-fraction ceiling', () => {
  const STAFF_KEY = 'ff'.repeat(32);
  const PAIR_KEY = 'ee'.repeat(32);
  const STARTER = '00000000-0000-4000-8000-00000000aaaa';
  const PAIRED = '00000000-0000-4000-8000-00000000bbbb';

  /** `n` submissions, every one of them carrying the staff starter session. */
  const cohortWithStarter = (n: number) =>
    Array.from({ length: n }, (_, i) => sessionOnly(`s${i}`, sk(STAFF_KEY, STARTER)));

  it('does NOT let a starter session shared by the whole cohort union anything', () => {
    // The failure this guard exists for, and it is worse than the bug: staff
    // prepare the skeleton with the recorder running, commit `.provenance/`,
    // and one union pass switches cross-submission detection off course-wide.
    const p = partitionCrossScopes(cohortWithStarter(6));
    expect(p.exclusions).toEqual([]);
    expect(sameRepositoryLineage(p, 's0', 's1')).toBe(false);
  });

  it('admits a strict-minority pair inside that same cohort', () => {
    // The guard must reject the starter WITHOUT rejecting the partnership that
    // shares the pool with it.
    const pool = cohortWithStarter(6);
    pool[0] = sessionOnly('s0', sk(STAFF_KEY, STARTER), sk(PAIR_KEY, PAIRED));
    pool[1] = sessionOnly('s1', sk(STAFF_KEY, STARTER), sk(PAIR_KEY, PAIRED));

    const p = partitionCrossScopes(pool);
    expect(sameRepositoryLineage(p, 's0', 's1')).toBe(true);
    expect(sameRepositoryLineage(p, 's2', 's3')).toBe(false);
    expect(p.exclusions).toHaveLength(1);
    expect(p.exclusions[0]!.bundleIds).toEqual(['s0', 's1']);
  });

  it('REJECTS an exact even split — the ambiguous boundary fails toward comparing', () => {
    // 3 of 6. Half the pool is not a group, and this is the single most
    // ambiguous shape the evidence can take.
    const pool = Array.from({ length: 6 }, (_, i) => sessionOnly(`s${i}`));
    for (let i = 0; i < 3; i++) pool[i] = sessionOnly(`s${i}`, sk(PAIR_KEY, PAIRED));
    const p = partitionCrossScopes(pool);
    expect(p.exclusions).toEqual([]);
  });

  it('admits one below that boundary in a pool one larger', () => {
    // 3 of 7 is a strict minority and unions; the same k in a pool of 6 did
    // not. The rule is the fraction, not the count.
    const pool = Array.from({ length: 7 }, (_, i) => sessionOnly(`s${i}`));
    for (let i = 0; i < 3; i++) pool[i] = sessionOnly(`s${i}`, sk(PAIR_KEY, PAIRED));
    const p = partitionCrossScopes(pool);
    expect(p.exclusions).toHaveLength(1);
    expect(p.exclusions[0]!.bundleIds).toEqual(['s0', 's1', 's2']);
  });

  it('is INERT on a pool too small for the rule to admit any partnership', () => {
    // `/local/compare`: a grader drops two partners' zips on the page. The
    // ceiling can only say yes to k=2 from n=5 up, so applying it here would
    // not narrow the key — it would disable it, and show the grader exactly the
    // false accusation this module removes. There is no cohort at n=2 to lose.
    const p = partitionCrossScopes([
      sessionOnly('alice', sk(PAIR_KEY, PAIRED)),
      sessionOnly('bob', sk(PAIR_KEY, PAIRED)),
    ]);
    expect(sameRepositoryLineage(p, 'alice', 'bob')).toBe(true);
  });

  it('never lets ONE session key move a majority of the pool', () => {
    // The invariant the ceiling buys, stated as a property rather than as a
    // case: whatever k is, the largest lineage a single key can produce is a
    // strict minority, so the majority of any pool is always still compared.
    for (let n = 5; n <= 24; n++) {
      for (let k = 2; k <= n; k++) {
        const pool = Array.from({ length: n }, (_, i) => sessionOnly(`s${i}`));
        for (let i = 0; i < k; i++) pool[i] = sessionOnly(`s${i}`, sk(PAIR_KEY, PAIRED));
        const p = partitionCrossScopes(pool);
        const largest = Math.max(
          ...[...p.lineageOf.values()].reduce((counts: number[], id) => {
            counts[id] = (counts[id] ?? 0) + 1;
            return counts;
          }, []),
        );
        // Strict minority: 2 * largest < n. Holds both when the key was
        // admitted (largest === k, and k*2 < n is exactly what admitted it) and
        // when it was rejected (largest === 1).
        expect(largest * 2, `n=${n} k=${k}`).toBeLessThan(n);
      }
    }
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
