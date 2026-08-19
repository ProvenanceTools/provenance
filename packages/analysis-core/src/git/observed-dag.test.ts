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
// Repository scoping — the stated, tested limitation
// ---------------------------------------------------------------------------

describe('the single-repository assumption', () => {
  const dag = buildObservedDag(source({ s1: [gitEvent({ seq: 1, sha: A, parents: [] })] }));

  it('says in the API that the scope is ASSUMED single, not proven single', () => {
    expect(dag.repositoryScope.kind).toBe('assumed_single');
  });

  it('reports that no discriminator was recorded, because the format has none yet', () => {
    // §8.6: root-commit sha is the chosen discriminator; it is not emitted yet.
    // This flag is the single bit that flips when it lands.
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

  it('KNOWN LIMITATION: two repositories in one scope are merged into one sha space', () => {
    // Today an outer repo and a submodule both emit git.events with no
    // discriminator, so their unrelated sha spaces fold together. This test
    // pins the unsound behaviour deliberately: when §8.6 lands and
    // readRepositoryDiscriminator starts returning a root-commit sha, THIS test
    // must be rewritten to assert two repositories and no cross-repo ordering.
    const twoRepos = buildObservedDag(
      source({
        // Outer repo lineage.
        s1: [gitEvent({ seq: 1, sha: A, parents: [] }), gitEvent({ seq: 2, sha: B, parents: [A] })],
        // Submodule lineage, unrelated sha space, and it happens to name B.
        s2: [gitEvent({ seq: 1, sha: D, parents: [B] })],
      }),
    );
    expect(twoRepos.repositoryScope.repositories).toEqual([ASSUMED_SINGLE_REPOSITORY]);
    // The unsound consequence, stated out loud: an ordering across two
    // repositories that the evidence does not actually support.
    expect(compareCommits(twoRepos, A, D)).toBe('before');
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
