/**
 * Tier 1.2 — the observed commit DAG.
 *
 * These tests are written against the FACTS the DAG must keep apart, not against
 * an implementation: absent vs empty parents, parent order, who observed what,
 * conflicting claims, and pairs that are genuinely unordered. Each of those is a
 * place where a tidy-looking simplification becomes a fabricated claim about a
 * student, so each has its own test.
 */

import { describe, expect, it } from 'vitest';
import type { HashedEnvelope } from '@provenance/log-core';
import {
  ASSUMED_SINGLE_REPOSITORY,
  ancestorsOfCommit,
  buildObservedDag,
  commitNodeKey,
  compareCommits,
  dagCycles,
  descendantsOfCommit,
  getCommitNode,
  isCommitAncestor,
  observedCommits,
  repositoryKeyForRootCommit,
  sessionsObservingCommit,
  witnessedOnlyCommits,
  type ObservedDagSource,
} from './observed-dag.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Readable stand-ins for shas. Opaque to the module, which never parses them. */
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);
const M = 'f'.repeat(40);

type GitSpec = {
  seq: number;
  sha?: string;
  commit_sha?: string;
  /** Omit the key entirely to model an ABSENT parents field. */
  parents?: readonly string[];
  branch?: string;
  operation?: string;
  /** Deliberately malformed payloads for the defensive-read tests. */
  rawParents?: unknown;
  /**
   * The repository discriminator (D12). Omit the key entirely to model the
   * ABSENT field, which is what every recorder emits today.
   */
  rootCommitSha?: string;
  /** Deliberately malformed discriminators for the defensive-read tests. */
  rawRootCommitSha?: unknown;
  /** Wall clock. Deliberately hostile in several tests: it must change nothing. */
  wall?: string;
};

function gitEvent(spec: GitSpec): HashedEnvelope {
  const data: Record<string, unknown> = { operation: spec.operation ?? 'commit' };
  if (spec.sha !== undefined) data['sha'] = spec.sha;
  if (spec.commit_sha !== undefined) data['commit_sha'] = spec.commit_sha;
  if (spec.parents !== undefined) data['parents'] = [...spec.parents];
  if ('rawParents' in spec) data['parents'] = spec.rawParents;
  if (spec.branch !== undefined) data['branch'] = spec.branch;
  if (spec.rootCommitSha !== undefined) data['root_commit_sha'] = spec.rootCommitSha;
  if ('rawRootCommitSha' in spec) data['root_commit_sha'] = spec.rawRootCommitSha;
  return {
    seq: spec.seq,
    t: spec.seq,
    wall: spec.wall ?? '2026-01-01T00:00:00.000Z',
    kind: 'git.event',
    data,
    prev_hash: '0'.repeat(64),
    hash: '1'.repeat(64),
  } as HashedEnvelope;
}

/** A non-git event, to prove the builder ignores the rest of the firehose. */
function noise(seq: number): HashedEnvelope {
  return {
    seq,
    t: seq,
    wall: '2026-01-01T00:00:00.000Z',
    kind: 'doc.change',
    data: { path: 'a.py', deltas: [], source: 'typed' },
    prev_hash: '0'.repeat(64),
    hash: '1'.repeat(64),
  } as HashedEnvelope;
}

function source(sessions: Record<string, readonly HashedEnvelope[]>): ObservedDagSource {
  return {
    sessions: Object.entries(sessions).map(([sessionId, events]) => ({ sessionId, events })),
  };
}

// ---------------------------------------------------------------------------
// Empty scope
// ---------------------------------------------------------------------------

describe('an empty scope', () => {
  it('yields an empty DAG rather than throwing', () => {
    const dag = buildObservedDag({ sessions: [] });
    expect(dag.nodes.size).toBe(0);
    expect(dag.observations).toEqual([]);
    expect(dag.defects).toEqual([]);
    expect(dag.repositoryScope.repositories).toEqual([]);
    expect(dag.coverage.commits).toBe(0);
    expect(dag.coverage.sessionsObserving).toBe(0);
  });

  it('yields an empty DAG for sessions with no git.event at all', () => {
    const dag = buildObservedDag(source({ s1: [noise(0), noise(1)], s2: [noise(0)] }));
    expect(dag.nodes.size).toBe(0);
    expect(dag.coverage.observations).toBe(0);
    expect(dag.coverage.gitEventsWithoutSha).toBe(0);
  });

  it('answers every ordering question about an empty DAG with "unknown", never a guess', () => {
    const dag = buildObservedDag({ sessions: [] });
    expect(compareCommits(dag, A, B)).toBe('unknown');
    expect(getCommitNode(dag, A)).toBeUndefined();
    expect(isCommitAncestor(dag, A, B)).toBe(false);
    expect([...ancestorsOfCommit(dag, A)]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Linear history
// ---------------------------------------------------------------------------

describe('a linear history', () => {
  const dag = buildObservedDag(
    source({
      s1: [
        gitEvent({ seq: 1, sha: A, parents: [], branch: 'main' }),
        gitEvent({ seq: 2, sha: B, parents: [A], branch: 'main' }),
        gitEvent({ seq: 3, sha: C, parents: [B], branch: 'main' }),
      ],
    }),
  );

  it('records one node per commit', () => {
    expect(dag.nodes.size).toBe(3);
    expect(observedCommits(dag).map((n) => n.sha)).toEqual([A, B, C]);
    expect(witnessedOnlyCommits(dag)).toEqual([]);
  });

  it('orders ancestors transitively', () => {
    expect([...ancestorsOfCommit(dag, C)].sort()).toEqual([A, B].sort());
    expect(isCommitAncestor(dag, A, C)).toBe(true);
    expect(isCommitAncestor(dag, C, A)).toBe(false);
  });

  it('orders descendants transitively', () => {
    expect([...descendantsOfCommit(dag, A)].sort()).toEqual([B, C].sort());
  });

  it('answers before / after / same across the chain', () => {
    expect(compareCommits(dag, A, C)).toBe('before');
    expect(compareCommits(dag, C, A)).toBe('after');
    expect(compareCommits(dag, B, B)).toBe('same');
  });

  it('answers "unknown" for a sha nobody mentioned — never "unordered"', () => {
    expect(compareCommits(dag, A, D)).toBe('unknown');
  });

  it('reports no defects', () => {
    expect(dag.defects).toEqual([]);
    expect(dagCycles(dag)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Parent order — the merge's meaning
// ---------------------------------------------------------------------------

describe('a genuine merge', () => {
  //      A
  //     / \
  //    B   C
  //     \ /
  //      M     parents = [B, C]: B is the branch merged INTO.
  const dag = buildObservedDag(
    source({
      s1: [
        gitEvent({ seq: 1, sha: A, parents: [], branch: 'main' }),
        gitEvent({ seq: 2, sha: B, parents: [A], branch: 'main' }),
        gitEvent({ seq: 3, sha: C, parents: [A], branch: 'feature' }),
        gitEvent({ seq: 4, sha: M, parents: [B, C], branch: 'main' }),
      ],
    }),
  );

  it('preserves parent order exactly — parents[0] is the branch merged into', () => {
    const merge = getCommitNode(dag, M);
    expect(merge?.parents).toEqual([B, C]);
    // Order, not membership. A builder that sorted or normalized would still
    // satisfy a set comparison, so assert the array itself.
    expect(merge?.parents?.[0]).toBe(B);
    expect(merge?.parents?.[1]).toBe(C);
  });

  it('keeps parent order on the claim as recorded', () => {
    expect(getCommitNode(dag, M)?.parentsClaims).toEqual([
      { parents: [B, C], observations: [{ sessionId: 's1', seq: 4 }] },
    ]);
  });

  it('does not sort parents even when the recorded order is not lexicographic', () => {
    const flipped = buildObservedDag(
      source({ s1: [gitEvent({ seq: 1, sha: M, parents: [C, B] })] }),
    );
    expect(getCommitNode(flipped, M)?.parents).toEqual([C, B]);
  });

  it('makes both merged branches ancestors of the merge', () => {
    expect(compareCommits(dag, B, M)).toBe('before');
    expect(compareCommits(dag, C, M)).toBe('before');
    expect(compareCommits(dag, A, M)).toBe('before');
  });

  it('still reports the two merged branch tips as unordered with respect to each other', () => {
    expect(compareCommits(dag, B, C)).toBe('unordered');
    expect(compareCommits(dag, C, B)).toBe('unordered');
  });
});

// ---------------------------------------------------------------------------
// Two partners, divergent branches, then a merge
// ---------------------------------------------------------------------------

describe("two partners' divergent branches, then a merge", () => {
  //        A            (shared history, both saw it)
  //       / \
  //      B   D          B on partner-1's branch, D on partner-2's
  //      |   |
  //      C   E
  //       \ /
  //        M            partner-1 merged partner-2's branch in
  //
  // Wall clocks are deliberately hostile: partner-2's machine claims to be a
  // year EARLIER than partner-1's for the same work. Nothing here may change.
  const dag = buildObservedDag(
    source({
      's1-partner-one': [
        gitEvent({ seq: 1, sha: A, parents: [], branch: 'main', wall: '2026-03-01T10:00:00.000Z' }),
        gitEvent({
          seq: 2,
          sha: B,
          parents: [A],
          branch: 'alice',
          wall: '2026-03-01T11:00:00.000Z',
        }),
        gitEvent({
          seq: 3,
          sha: C,
          parents: [B],
          branch: 'alice',
          wall: '2026-03-01T12:00:00.000Z',
        }),
        gitEvent({
          seq: 4,
          sha: M,
          parents: [C, E],
          branch: 'main',
          wall: '2026-03-01T13:00:00.000Z',
        }),
      ],
      's2-partner-two': [
        gitEvent({ seq: 1, sha: A, parents: [], branch: 'main', wall: '2025-03-01T10:00:00.000Z' }),
        gitEvent({ seq: 2, sha: D, parents: [A], branch: 'bob', wall: '2025-03-01T11:00:00.000Z' }),
        gitEvent({ seq: 3, sha: E, parents: [D], branch: 'bob', wall: '2025-03-01T12:00:00.000Z' }),
      ],
    }),
  );

  it('reports every cross-branch pair as unordered — the pairs no clock may sequence', () => {
    for (const [x, y] of [
      [B, D],
      [B, E],
      [C, D],
      [C, E],
    ] as const) {
      expect(compareCommits(dag, x, y)).toBe('unordered');
      expect(compareCommits(dag, y, x)).toBe('unordered');
    }
  });

  it('is not swayed by the year of clock skew between the two machines', () => {
    // Partner two's whole branch claims to predate the shared root by a year.
    // The DAG says A is before D regardless, because the edge says so.
    expect(compareCommits(dag, A, D)).toBe('before');
    expect(compareCommits(dag, A, E)).toBe('before');
  });

  it('orders both lineages before the merge and the shared root before both', () => {
    expect(compareCommits(dag, C, M)).toBe('before');
    expect(compareCommits(dag, E, M)).toBe('before');
    expect(compareCommits(dag, A, M)).toBe('before');
    expect([...ancestorsOfCommit(dag, M)].sort()).toEqual([A, B, C, D, E].sort());
  });

  it('records both partners against the commit they both observed', () => {
    const root = getCommitNode(dag, A);
    expect(sessionsObservingCommit(root!)).toEqual(['s1-partner-one', 's2-partner-two']);
  });
});

// ---------------------------------------------------------------------------
// Unrecorded parents — a commit nobody recorded, and an absent parents field
// ---------------------------------------------------------------------------

describe('a commit whose parent nobody recorded', () => {
  const dag = buildObservedDag(
    source({ s1: [gitEvent({ seq: 1, sha: B, parents: [A], branch: 'main' })] }),
  );

  it('creates a witnessed-only node for the unrecorded parent', () => {
    const parent = getCommitNode(dag, A);
    expect(parent).toBeDefined();
    expect(parent!.presence).toBe('witnessed_only');
    expect(parent!.observations).toEqual([]);
    expect(sessionsObservingCommit(parent!)).toEqual([]);
    expect(witnessedOnlyCommits(dag).map((n) => n.sha)).toEqual([A]);
  });

  it('still orders the witnessed-only parent before the commit that named it', () => {
    expect(compareCommits(dag, A, B)).toBe('before');
  });

  it("leaves the witnessed-only parent's own in-edges unknown, never empty", () => {
    const parent = getCommitNode(dag, A)!;
    expect(parent.parentsState).toBe('unrecorded');
    expect(parent.parents).toBeNull();
    expect(parent.recordedRoot).toBe(false);
  });

  it('counts it as coverage, not as a defect', () => {
    expect(dag.defects).toEqual([]);
    expect(dag.coverage.witnessedOnlyCommits).toBe(1);
    expect(dag.coverage.observedCommits).toBe(1);
    expect(dag.coverage.commitsWithUnrecordedParents).toBe(1);
  });
});

describe('absent parents versus an empty parents array', () => {
  const dag = buildObservedDag(
    source({
      // A recorded parents: [] — a genuine root, as far as the recorder saw.
      s1: [gitEvent({ seq: 1, sha: A, parents: [], branch: 'main' })],
      // B omitted the field entirely — the recorder could not read them.
      s2: [gitEvent({ seq: 1, sha: B, branch: 'main' })],
    }),
  );

  it('reports the recorded empty list as recorded, with an empty parent list', () => {
    const root = getCommitNode(dag, A)!;
    expect(root.parentsState).toBe('recorded');
    expect(root.parents).toEqual([]);
    expect(root.recordedRoot).toBe(true);
  });

  it('reports the absent field as unrecorded, with NULL parents — never []', () => {
    const unknown = getCommitNode(dag, B)!;
    expect(unknown.parentsState).toBe('unrecorded');
    expect(unknown.parents).toBeNull();
    expect(unknown.parentsClaims).toEqual([]);
  });

  it('never calls the absent-parents commit a root', () => {
    expect(getCommitNode(dag, B)!.recordedRoot).toBe(false);
    expect(dag.coverage.recordedRoots).toBe(1);
    expect(dag.coverage.commitsWithUnrecordedParents).toBe(1);
  });

  it('keeps the two states distinguishable — they are different facts', () => {
    const root = getCommitNode(dag, A)!;
    const unknown = getCommitNode(dag, B)!;
    expect(root.parentsState).not.toBe(unknown.parentsState);
    expect(root.parents).not.toBe(unknown.parents);
  });
});

describe('a 1.x bundle carrying only { operation, commit_sha }', () => {
  const dag = buildObservedDag(
    source({
      s1: [
        gitEvent({ seq: 1, commit_sha: A, operation: 'state_change' }),
        gitEvent({ seq: 2, commit_sha: B, operation: 'state_change' }),
      ],
    }),
  );

  it('still yields nodes, from the deprecated commit_sha spelling', () => {
    expect(observedCommits(dag).map((n) => n.sha)).toEqual([A, B]);
  });

  it('yields no edges, so every pair is unordered rather than invented', () => {
    expect(compareCommits(dag, A, B)).toBe('unordered');
    expect(dag.coverage.commitsWithUnrecordedParents).toBe(2);
  });
});

describe('a git.event with no sha at all', () => {
  it('is counted, not treated as a defect and not turned into a node', () => {
    const dag = buildObservedDag(source({ s1: [gitEvent({ seq: 1, operation: 'state_change' })] }));
    expect(dag.nodes.size).toBe(0);
    expect(dag.coverage.gitEventsWithoutSha).toBe(1);
    expect(dag.defects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The same commit observed twice
// ---------------------------------------------------------------------------

describe('the same commit observed by two contributors', () => {
  const dag = buildObservedDag(
    source({
      's2-bob': [gitEvent({ seq: 7, sha: B, parents: [A], branch: 'main' })],
      's1-alice': [gitEvent({ seq: 4, sha: B, parents: [A], branch: 'main' })],
    }),
  );

  it('produces ONE node, not two', () => {
    expect(observedCommits(dag).map((n) => n.sha)).toEqual([B]);
  });

  it('keeps both observations, each carrying its own (sessionId, seq)', () => {
    const node = getCommitNode(dag, B)!;
    expect(node.observations.map((o) => [o.sessionId, o.seq])).toEqual([
      ['s1-alice', 4],
      ['s2-bob', 7],
    ]);
  });

  it('records agreement as a single claim backed by both observations', () => {
    expect(getCommitNode(dag, B)!.parentsClaims).toEqual([
      {
        parents: [A],
        observations: [
          { sessionId: 's1-alice', seq: 4 },
          { sessionId: 's2-bob', seq: 7 },
        ],
      },
    ]);
    expect(getCommitNode(dag, B)!.parentsState).toBe('recorded');
    expect(dag.defects).toEqual([]);
  });

  it('orders observations by (sessionId, seq), not by the order sessions appear', () => {
    // The source lists s2-bob first. The output must not depend on that, nor on
    // wall clock: the tiebreak is the clock-free (sessionId, seq).
    expect(dag.observations.map((o) => o.sessionId)).toEqual(['s1-alice', 's2-bob']);
  });
});

// ---------------------------------------------------------------------------
// Conflicting observations
// ---------------------------------------------------------------------------

describe('conflicting parent lists for one sha', () => {
  const dag = buildObservedDag(
    source({
      's1-alice': [gitEvent({ seq: 1, sha: C, parents: [A] })],
      's2-bob': [gitEvent({ seq: 1, sha: C, parents: [B] })],
    }),
  );

  it('marks the node conflicting and refuses to pick a winner', () => {
    const node = getCommitNode(dag, C)!;
    expect(node.parentsState).toBe('conflicting');
    expect(node.parents).toBeNull();
  });

  it('keeps every claim with the chain entry that made it', () => {
    expect(getCommitNode(dag, C)!.parentsClaims).toEqual([
      { parents: [A], observations: [{ sessionId: 's1-alice', seq: 1 }] },
      { parents: [B], observations: [{ sessionId: 's2-bob', seq: 1 }] },
    ]);
  });

  it('raises a defect naming both claims', () => {
    const conflicts = dag.defects.filter((d) => d.kind === 'conflicting_parents');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      kind: 'conflicting_parents',
      sha: C,
      claims: [
        { parents: [A], observations: [{ sessionId: 's1-alice', seq: 1 }] },
        { parents: [B], observations: [{ sessionId: 's2-bob', seq: 1 }] },
      ],
    });
    expect(dag.coverage.commitsWithConflictingParents).toBe(1);
  });

  it('asserts no in-edge at all, so nothing downstream inherits a guessed ordering', () => {
    expect(compareCommits(dag, A, C)).toBe('unordered');
    expect(compareCommits(dag, B, C)).toBe('unordered');
    expect([...ancestorsOfCommit(dag, C)]).toEqual([]);
  });

  it('still keeps both claimed parents as witnessed-only evidence', () => {
    expect(
      witnessedOnlyCommits(dag)
        .map((n) => n.sha)
        .sort(),
    ).toEqual([A, B].sort());
  });
});

describe('the same parents in a different order', () => {
  const dag = buildObservedDag(
    source({
      's1-alice': [gitEvent({ seq: 1, sha: M, parents: [A, B] })],
      's2-bob': [gitEvent({ seq: 1, sha: M, parents: [B, A] })],
    }),
  );

  it('is a CONFLICT, because parent order is the merge’s meaning', () => {
    const node = getCommitNode(dag, M)!;
    expect(node.parentsState).toBe('conflicting');
    expect(node.parentsClaims.map((c) => c.parents)).toEqual([
      [A, B],
      [B, A],
    ]);
    expect(dag.defects.filter((d) => d.kind === 'conflicting_parents')).toHaveLength(1);
  });
});

describe('a malformed parents field', () => {
  it('is a defect, and leaves the in-edges unknown rather than fabricating a root', () => {
    const dag = buildObservedDag(
      source({ s1: [gitEvent({ seq: 3, sha: A, rawParents: 'not-an-array' })] }),
    );
    expect(dag.defects).toEqual([
      {
        kind: 'unreadable_parents',
        repository: ASSUMED_SINGLE_REPOSITORY,
        sha: A,
        sessionId: 's1',
        seq: 3,
        reason: 'not_an_array',
      },
    ]);
    const node = getCommitNode(dag, A)!;
    expect(node.parentsState).toBe('unrecorded');
    expect(node.recordedRoot).toBe(false);
  });

  it('rejects a non-string entry the same way', () => {
    const dag = buildObservedDag(
      source({ s1: [gitEvent({ seq: 0, sha: A, rawParents: [B, 42] })] }),
    );
    expect(dag.defects).toHaveLength(1);
    expect(dag.defects[0]).toMatchObject({
      kind: 'unreadable_parents',
      reason: 'non_string_entry',
    });
    expect(getCommitNode(dag, A)!.parents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

describe('a cycle in the observed edges', () => {
  // Impossible in git; reachable by forgery. It must terminate and be reported.
  const dag = buildObservedDag(
    source({
      s1: [
        gitEvent({ seq: 1, sha: A, parents: [C] }),
        gitEvent({ seq: 2, sha: B, parents: [A] }),
        gitEvent({ seq: 3, sha: C, parents: [B] }),
      ],
    }),
  );

  it('is detected and reported rather than looping', () => {
    const cycles = dagCycles(dag);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0]!.shas].sort()).toEqual([A, B, C].sort());
    // Rotated to the lexicographically smallest sha, so the report is stable.
    expect(cycles[0]!.shas[0]).toBe(A);
  });

  it('lets ancestry terminate, reporting every commit reachable on the loop', () => {
    expect([...ancestorsOfCommit(dag, A)].sort()).toEqual([A, B, C].sort());
    expect([...descendantsOfCommit(dag, A)].sort()).toEqual([A, B, C].sort());
  });

  it('answers "unordered" for a mutually reachable pair, never picking a side', () => {
    expect(compareCommits(dag, A, B)).toBe('unordered');
    expect(compareCommits(dag, B, A)).toBe('unordered');
  });

  it('reports a self-loop too', () => {
    const selfLoop = buildObservedDag(source({ s1: [gitEvent({ seq: 1, sha: A, parents: [A] })] }));
    expect(dagCycles(selfLoop).map((c) => c.shas)).toEqual([[A]]);
    expect(compareCommits(selfLoop, A, A)).toBe('same');
  });

  it('does not report a diamond as a cycle', () => {
    const diamond = buildObservedDag(
      source({
        s1: [
          gitEvent({ seq: 1, sha: A, parents: [] }),
          gitEvent({ seq: 2, sha: B, parents: [A] }),
          gitEvent({ seq: 3, sha: C, parents: [A] }),
          gitEvent({ seq: 4, sha: M, parents: [B, C] }),
        ],
      }),
    );
    expect(dagCycles(diamond)).toEqual([]);
  });

  it('terminates on a long lineage without overflowing the stack', () => {
    const events: HashedEnvelope[] = [];
    const sha = (i: number): string => String(i).padStart(40, '0');
    events.push(gitEvent({ seq: 0, sha: sha(0), parents: [] }));
    for (let i = 1; i < 20_000; i += 1) {
      events.push(gitEvent({ seq: i, sha: sha(i), parents: [sha(i - 1)] }));
    }
    const long = buildObservedDag(source({ s1: events }));
    expect(dagCycles(long)).toEqual([]);
    expect(ancestorsOfCommit(long, sha(19_999)).size).toBe(19_999);
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe('observation provenance', () => {
  const dag = buildObservedDag(
    source({
      's1-alice': [noise(0), gitEvent({ seq: 11, sha: B, parents: [A], branch: 'main' })],
    }),
  );

  it('carries (sessionId, seq) on every observation, so every claim is traceable', () => {
    expect(dag.observations).toHaveLength(1);
    expect(dag.observations[0]).toMatchObject({ sessionId: 's1-alice', seq: 11 });
    expect(getCommitNode(dag, B)!.observations[0]).toMatchObject({
      sessionId: 's1-alice',
      seq: 11,
    });
  });

  it('carries (sessionId, seq) on every parents claim', () => {
    expect(getCommitNode(dag, B)!.parentsClaims[0]!.observations).toEqual([
      { sessionId: 's1-alice', seq: 11 },
    ]);
  });

  it('keeps branch and operation verbatim, and branch null when absent', () => {
    expect(dag.observations[0]!.branch).toBe('main');
    expect(dag.observations[0]!.operation).toBe('commit');
    const detached = buildObservedDag(
      source({ s1: [gitEvent({ seq: 1, sha: A, parents: [], operation: 'checkout' })] }),
    );
    expect(detached.observations[0]!.branch).toBeNull();
  });

  it('carries no git author identity of any kind', () => {
    // Out of protocol. Attribution runs through session.start.identity only.
    const keys = Object.keys(dag.observations[0]!);
    expect(keys).not.toContain('author');
    expect(keys).not.toContain('authorName');
    expect(keys).not.toContain('authorEmail');
    expect(keys.some((k) => k.toLowerCase().includes('author'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Repository scoping — an UNLABELLED scope, which is every bundle in existence
// ---------------------------------------------------------------------------

describe('the single-repository assumption', () => {
  const dag = buildObservedDag(source({ s1: [gitEvent({ seq: 1, sha: A, parents: [] })] }));

  it('says in the API that the scope is ASSUMED single, not proven single', () => {
    expect(dag.repositoryScope.kind).toBe('assumed_single');
  });

  it('reports that no discriminator was recorded, because this recorder emitted none', () => {
    // D12: the discriminator is the root-commit sha. The format carries it and
    // no recorder emits it yet (the writer half is deliberately outstanding), so
    // this is the state of every bundle recorded to date.
    expect(dag.repositoryScope.discriminatorRecorded).toBe(false);
  });

  it('folds every observation into the one sentinel repository', () => {
    expect(dag.repositoryScope.repositories).toEqual([ASSUMED_SINGLE_REPOSITORY]);
    expect(getCommitNode(dag, A)!.repository).toBe(ASSUMED_SINGLE_REPOSITORY);
    expect(dag.observations[0]!.repository).toBe(ASSUMED_SINGLE_REPOSITORY);
  });

  it('keys nodes on (repository, sha) so a discriminator threads in without redesign', () => {
    expect([...dag.nodes.keys()]).toEqual([commitNodeKey(ASSUMED_SINGLE_REPOSITORY, A)]);
    expect(commitNodeKey('root:1234', A)).not.toBe(commitNodeKey('root:5678', A));
  });

  it('isolates queries by repository, which is what makes a submodule separable later', () => {
    // Passing any other repository key finds nothing: the query is already
    // repository-scoped, so nothing here changes shape when §8.6 lands.
    expect(getCommitNode(dag, A, 'root:other')).toBeUndefined();
    expect(compareCommits(dag, A, A, 'root:other')).toBe('unknown');
  });

  it('reports an unlabelled scope as counting no unreadable discriminator either', () => {
    // Absence is not a problem and is never counted as one. This distinguishes
    // "the recorder said nothing" from "the recorder said something wrong".
    expect(dag.coverage.gitEventsWithUnreadableRepository).toBe(0);
  });

  it('was the KNOWN LIMITATION: two UNLABELLED repositories still merge, and say so', () => {
    // This is what the KNOWN LIMITATION test pinned before the discriminator
    // landed, and it is still the honest answer for a scope where nothing names
    // a repository — the recorders emit no discriminator yet, so it is also
    // still the answer for every bundle in existence. What has changed is that
    // it is no longer the ONLY answer available: see the discriminated-scope
    // tests below, where the same two lineages stay apart.
    const twoRepos = buildObservedDag(
      source({
        // Outer repo lineage.
        s1: [gitEvent({ seq: 1, sha: A, parents: [] }), gitEvent({ seq: 2, sha: B, parents: [A] })],
        // Submodule lineage, unrelated sha space, and it happens to name B.
        s2: [gitEvent({ seq: 1, sha: D, parents: [B] })],
      }),
    );
    expect(twoRepos.repositoryScope.kind).toBe('assumed_single');
    expect(twoRepos.repositoryScope.repositories).toEqual([ASSUMED_SINGLE_REPOSITORY]);
    expect(compareCommits(twoRepos, A, D)).toBe('before');
  });
});

// ---------------------------------------------------------------------------
// Repository scoping — a DISCRIMINATED scope. This is what the KNOWN LIMITATION
// test was waiting for: two repositories in one scope, kept apart.
// ---------------------------------------------------------------------------

/** Two root-commit shas: an outer repository and a submodule. */
const OUTER_ROOT = '1'.repeat(40);
const INNER_ROOT = '2'.repeat(40);
const OUTER = repositoryKeyForRootCommit(OUTER_ROOT);
const INNER = repositoryKeyForRootCommit(INNER_ROOT);

describe('two repositories in one scope', () => {
  // The exact shape the KNOWN LIMITATION test drove: an outer repo lineage
  // A → B, and a submodule lineage that names B as a parent. In git those two
  // Bs are unrelated values in unrelated sha spaces; only the discriminator can
  // tell a reader that.
  const dag = buildObservedDag(
    source({
      s1: [
        gitEvent({ seq: 1, sha: A, parents: [], rootCommitSha: OUTER_ROOT }),
        gitEvent({ seq: 2, sha: B, parents: [A], rootCommitSha: OUTER_ROOT }),
      ],
      s2: [gitEvent({ seq: 1, sha: D, parents: [B], rootCommitSha: INNER_ROOT })],
    }),
  );

  it('keeps them in separate sha spaces rather than merging them', () => {
    expect(dag.repositoryScope.kind).toBe('discriminated');
    expect(dag.repositoryScope.discriminatorRecorded).toBe(true);
    expect(dag.repositoryScope.repositories).toEqual([OUTER, INNER]);
    expect(dag.repositoryScope.repositories).not.toContain(ASSUMED_SINGLE_REPOSITORY);
  });

  it('gives one sha in two repositories two DISTINCT nodes', () => {
    // B is observed in the outer repo and witnessed as a parent in the inner
    // one. Two nodes, because they are two commits.
    const outerB = getCommitNode(dag, B, OUTER)!;
    const innerB = getCommitNode(dag, B, INNER)!;
    expect(outerB.presence).toBe('observed');
    expect(innerB.presence).toBe('witnessed_only');
    expect(outerB).not.toBe(innerB);
    expect(dag.nodes.size).toBe(4);
  });

  it('reports a cross-repository comparison as unknown, never as a relationship', () => {
    // The heart of it: A ≺ D was the fabricated ordering the old test pinned.
    // Neither sha is in the other's repository, so there is no basis for any
    // statement — and "unknown" is the answer for "not in this DAG", which is
    // deliberately NOT "unordered".
    expect(compareCommits(dag, A, D, OUTER)).toBe('unknown');
    expect(compareCommits(dag, A, D, INNER)).toBe('unknown');
    expect(compareCommits(dag, D, A, INNER)).toBe('unknown');
  });

  it('asserts no cross-repository ancestry, so no ≺ can be derived from one', () => {
    expect(isCommitAncestor(dag, A, D, OUTER)).toBe(false);
    expect(isCommitAncestor(dag, A, D, INNER)).toBe(false);
    expect([...ancestorsOfCommit(dag, D, INNER)]).toEqual([B]);
    expect([...ancestorsOfCommit(dag, D, OUTER)]).toEqual([]);
    // The inner B is a bare witnessed parent: it does NOT drag in the outer A.
    expect(ancestorsOfCommit(dag, D, INNER).has(A)).toBe(false);
  });

  it('still orders WITHIN a repository', () => {
    // Discrimination must not cost the ordering that does exist.
    expect(compareCommits(dag, A, B, OUTER)).toBe('before');
    expect(compareCommits(dag, B, A, OUTER)).toBe('after');
  });

  it('never lets a repository key be confused with a commit sha', () => {
    // Same shape, different id spaces — the confusion behind two live defects
    // in this system's history. The namespace prefix is what keeps them apart.
    expect(OUTER).not.toBe(OUTER_ROOT);
    expect(OUTER).toBe(`repository:${OUTER_ROOT}`);
    expect(OUTER).not.toBe(ASSUMED_SINGLE_REPOSITORY);
    expect(commitNodeKey(OUTER, B)).not.toBe(commitNodeKey(INNER, B));
  });
});

// ---------------------------------------------------------------------------
// Repository scoping — degradation. None of these may become a finding.
// ---------------------------------------------------------------------------

describe('a bundle that records no discriminator', () => {
  // The compatibility guarantee, asserted as an equality rather than described:
  // every bundle in existence is in this state, and it must behave EXACTLY as it
  // did before the field existed.
  const events = [
    gitEvent({ seq: 1, sha: A, parents: [] }),
    gitEvent({ seq: 2, sha: B, parents: [A] }),
    gitEvent({ seq: 3, sha: M, parents: [B, C] }),
  ];
  const dag = buildObservedDag(source({ s1: events }));

  it('produces one sentinel repository, exactly as it always did', () => {
    expect(dag.repositoryScope.kind).toBe('assumed_single');
    expect(dag.repositoryScope.discriminatorRecorded).toBe(false);
    expect(dag.repositoryScope.repositories).toEqual([ASSUMED_SINGLE_REPOSITORY]);
    expect([...dag.nodes.keys()].every((k) => k.startsWith(ASSUMED_SINGLE_REPOSITORY))).toBe(true);
  });

  it('answers every query through the default repository, with no defect', () => {
    expect(compareCommits(dag, A, M)).toBe('before');
    expect([...ancestorsOfCommit(dag, M)].sort()).toEqual([A, B, C].sort());
    expect(dag.defects).toEqual([]);
    expect(dag.coverage.gitEventsWithUnreadableRepository).toBe(0);
  });
});

describe('a shallow clone, whose root commit is not reachable', () => {
  // A shallow clone cannot name its root: the boundary commit it reports has no
  // parents but is not a root. The writer contract says OMIT the field, so a
  // shallow clone is simply an unlabelled scope.
  const dag = buildObservedDag(
    source({
      // The grafted boundary commit: parents recorded as empty, which is what
      // git reports, and NOT proof that history begins here (S15).
      s1: [gitEvent({ seq: 1, sha: A, parents: [] }), gitEvent({ seq: 2, sha: B, parents: [A] })],
    }),
  );

  it('degrades to the unlabelled repository with no defect and no finding', () => {
    expect(dag.repositoryScope.kind).toBe('assumed_single');
    expect(dag.defects).toEqual([]);
    expect(dag.coverage.gitEventsWithUnreadableRepository).toBe(0);
  });

  it('still orders the history it does have', () => {
    expect(compareCommits(dag, A, B)).toBe('before');
  });

  it('does not let recordedRoot become a claim about the repository', () => {
    // recordedRoot means root-or-truncated-lineage. A shallow clone is the
    // truncated case, and nothing here distinguishes them or needs to.
    expect(getCommitNode(dag, A)!.recordedRoot).toBe(true);
    expect(dag.coverage.recordedRoots).toBe(1);
  });
});

describe('a repository with several root commits', () => {
  // Orphan branches and squashed imports both produce more than one parentless
  // commit. Which one a recorder names is the WRITER's problem, pinned in the
  // writer contract; the reader's obligation is that neither answer, and neither
  // partner disagreeing about it, becomes a finding.
  const dag = buildObservedDag(
    source({
      s1: [
        gitEvent({ seq: 1, sha: A, parents: [], rootCommitSha: OUTER_ROOT }),
        gitEvent({ seq: 2, sha: C, parents: [], rootCommitSha: OUTER_ROOT }),
        gitEvent({ seq: 3, sha: M, parents: [A, C], rootCommitSha: OUTER_ROOT }),
      ],
    }),
  );

  it('accepts two recorded roots in one repository without a defect', () => {
    expect(dag.coverage.recordedRoots).toBe(2);
    expect(dag.defects).toEqual([]);
    expect(dag.repositoryScope.repositories).toEqual([OUTER]);
  });

  it('orders the merge that joined them', () => {
    expect(compareCommits(dag, A, M, OUTER)).toBe('before');
    expect(compareCommits(dag, C, M, OUTER)).toBe('before');
    expect(compareCommits(dag, A, C, OUTER)).toBe('unordered');
  });

  it('does not become a finding when two partners name DIFFERENT roots for it', () => {
    // The worst case for the writer rule: one partner's history reaches a second
    // root the other's does not, so the two label the SAME repository
    // differently. Both partners observed B; under one labelling that is
    // corroboration, under two it is two nodes.
    const disagreeing = buildObservedDag(
      source({
        s1: [
          gitEvent({ seq: 1, sha: A, parents: [], rootCommitSha: OUTER_ROOT }),
          gitEvent({ seq: 2, sha: B, parents: [A], rootCommitSha: OUTER_ROOT }),
        ],
        s2: [
          gitEvent({ seq: 1, sha: B, parents: [A], rootCommitSha: INNER_ROOT }),
          gitEvent({ seq: 2, sha: D, parents: [B], rootCommitSha: INNER_ROOT }),
        ],
      }),
    );

    // Not a defect and not counted as unreadable: both values are well formed.
    expect(disagreeing.defects).toEqual([]);
    expect(disagreeing.coverage.gitEventsWithUnreadableRepository).toBe(0);

    // The whole cost, and it is a LOSS of evidence, never a manufactured one:
    // the shared commit is two nodes, so the corroboration is not visible.
    expect(sessionsObservingCommit(getCommitNode(disagreeing, B, OUTER)!)).toEqual(['s1']);
    expect(sessionsObservingCommit(getCommitNode(disagreeing, B, INNER)!)).toEqual(['s2']);

    // Nothing is ordered across the two labellings.
    expect(compareCommits(disagreeing, A, D, OUTER)).toBe('unknown');
    expect(getCommitNode(disagreeing, D, OUTER)).toBeUndefined();

    // And each partner's own claims still order within their own labelling.
    expect(compareCommits(disagreeing, A, B, OUTER)).toBe('before');
    expect(compareCommits(disagreeing, B, D, INNER)).toBe('before');
  });
});

describe('a scope where only some observations name a repository', () => {
  // One partner on a newer recorder, or one on a shallow clone. The unlabelled
  // observations must NOT be assumed to belong to the named repository: that
  // assumption is the merge the discriminator exists to prevent.
  const dag = buildObservedDag(
    source({
      s1: [
        gitEvent({ seq: 1, sha: A, parents: [], rootCommitSha: OUTER_ROOT }),
        gitEvent({ seq: 2, sha: B, parents: [A], rootCommitSha: OUTER_ROOT }),
      ],
      s2: [gitEvent({ seq: 1, sha: D, parents: [B] })],
    }),
  );

  it('reports the scope as mixed rather than rounding it to either neighbour', () => {
    expect(dag.repositoryScope.kind).toBe('mixed');
    expect(dag.repositoryScope.discriminatorRecorded).toBe(true);
    expect(dag.repositoryScope.repositories).toEqual([OUTER, ASSUMED_SINGLE_REPOSITORY]);
  });

  it('does not correlate the unlabelled observations with the named repository', () => {
    expect(compareCommits(dag, A, D, OUTER)).toBe('unknown');
    expect(compareCommits(dag, A, D, ASSUMED_SINGLE_REPOSITORY)).toBe('unknown');
    expect(getCommitNode(dag, D, OUTER)).toBeUndefined();
  });

  it('is not a defect: an older recorder is not evidence of anything', () => {
    expect(dag.defects).toEqual([]);
    expect(dag.coverage.gitEventsWithUnreadableRepository).toBe(0);
  });
});

describe('a discriminator that is present and unusable', () => {
  // A nonconforming writer: a repository path, a remote URL, an empty string.
  // The value must never become a key — it would partition the graph on garbage
  // and would flow an identifier the format forbids into a staff-facing UI.
  const dag = buildObservedDag(
    source({
      s1: [
        gitEvent({ seq: 1, sha: A, parents: [], rawRootCommitSha: '/Users/student/cs61b' }),
        gitEvent({ seq: 2, sha: B, parents: [A], rawRootCommitSha: '' }),
        gitEvent({ seq: 3, sha: C, parents: [B], rawRootCommitSha: 42 }),
      ],
    }),
  );

  it('folds the observations in with the unlabelled ones', () => {
    expect(dag.repositoryScope.kind).toBe('assumed_single');
    expect(dag.repositoryScope.discriminatorRecorded).toBe(false);
    expect(dag.repositoryScope.repositories).toEqual([ASSUMED_SINGLE_REPOSITORY]);
  });

  it('counts what it could not read, so a nonconforming recorder stays visible', () => {
    expect(dag.coverage.gitEventsWithUnreadableRepository).toBe(3);
  });

  it('is not a defect and does not disturb the graph', () => {
    // A recorder that wrote something wrong is a fact about that recorder. It is
    // never a fact about the student it recorded.
    expect(dag.defects).toEqual([]);
    expect(compareCommits(dag, A, C)).toBe('before');
  });

  it('never lets the unusable value appear as a repository key', () => {
    expect([...dag.nodes.keys()].every((k) => k.startsWith(ASSUMED_SINGLE_REPOSITORY))).toBe(true);
    expect(dag.observations.every((o) => o.repository === ASSUMED_SINGLE_REPOSITORY)).toBe(true);
    expect(JSON.stringify(dag.repositoryScope)).not.toContain('cs61b');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces identical output regardless of session order in the source', () => {
    const eventsOne = [
      gitEvent({ seq: 1, sha: A, parents: [] }),
      gitEvent({ seq: 2, sha: B, parents: [A] }),
    ];
    const eventsTwo = [gitEvent({ seq: 1, sha: C, parents: [A] })];
    const forward = buildObservedDag(source({ 's1-a': eventsOne, 's2-b': eventsTwo }));
    const reversed = buildObservedDag(source({ 's2-b': eventsTwo, 's1-a': eventsOne }));
    expect(reversed.observations).toEqual(forward.observations);
    expect([...reversed.nodes.keys()]).toEqual([...forward.nodes.keys()]);
    expect(reversed.coverage).toEqual(forward.coverage);
  });

  it('produces identical output regardless of wall clock', () => {
    const early = buildObservedDag(
      source({
        s1: [
          gitEvent({ seq: 1, sha: A, parents: [], wall: '2020-01-01T00:00:00.000Z' }),
          gitEvent({ seq: 2, sha: B, parents: [A], wall: '2019-01-01T00:00:00.000Z' }),
        ],
      }),
    );
    expect(early.observations.map((o) => o.sha)).toEqual([A, B]);
    expect(compareCommits(early, A, B)).toBe('before');
  });
});
