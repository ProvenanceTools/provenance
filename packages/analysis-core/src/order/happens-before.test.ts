/**
 * Tier 2.1 — the `≺` happens-before relation.
 *
 * These tests are written against the FACTS the relation must keep apart rather
 * than against the implementation. Each one guards a place where a tidy answer
 * would be a fabricated claim about a student:
 *
 *  - concurrency is reported as concurrency, never linearized;
 *  - `'unknown'` (no record) never degrades into `'concurrent'` (genuine race);
 *  - wall clock generates nothing, so skew of any size changes no answer;
 *  - the presentation tiebreak cannot be mistaken for a happens-before claim;
 *  - the result is byte-identical across runs, which ingest retries depend on.
 */

import { describe, expect, it } from 'vitest';
import type { HashedEnvelope } from '@provenance/log-core';
import { buildObservedDag, type ObservedDagSource } from '../git/observed-dag.js';
import type { SessionContributor } from '../identity/types.js';
import {
  areConcurrent,
  buildEventOrdering,
  compareEventRefs,
  compareEvents,
  happensBefore,
  presentationSort,
  type EventOrdering,
  type EventRef,
} from './happens-before.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const MERGE = 'e'.repeat(40);

const S1 = 'session-1';
const S2 = 'session-2';
const S3 = 'session-3';

function gitEvent(
  seq: number,
  sha: string,
  parents?: readonly string[],
  wall = '2026-01-01T00:00:00.000Z',
): HashedEnvelope {
  const data: Record<string, unknown> = { operation: 'commit', sha };
  if (parents !== undefined) data['parents'] = [...parents];
  return {
    seq,
    t: seq,
    wall,
    kind: 'git.event',
    data,
    prev_hash: '0'.repeat(64),
    hash: '1'.repeat(64),
  } as HashedEnvelope;
}

function edit(seq: number, wall = '2026-01-01T00:00:00.000Z'): HashedEnvelope {
  return {
    seq,
    t: seq,
    wall,
    kind: 'doc.change',
    data: { path: 'hw.py', deltas: [], source: 'typed' },
    prev_hash: '0'.repeat(64),
    hash: '1'.repeat(64),
  } as HashedEnvelope;
}

function sessionStart(
  seq: number,
  sessionId: string,
  prevSessionId: string | null,
  wall = '2026-01-01T00:00:00.000Z',
): HashedEnvelope {
  return {
    seq,
    t: seq,
    wall,
    kind: 'session.start',
    data: {
      format_version: '2.0',
      session_id: sessionId,
      prev_session_id: prevSessionId,
      assignment: { id: 'hw1', semester: 'fa26' },
    },
    prev_hash: '0'.repeat(64),
    hash: '1'.repeat(64),
  } as HashedEnvelope;
}

type Sessions = Record<string, readonly HashedEnvelope[]>;

function build(sessions: Sessions, contributors?: ReadonlyMap<string, SessionContributor>) {
  const src: ObservedDagSource = {
    sessions: Object.entries(sessions).map(([sessionId, events]) => ({ sessionId, events })),
  };
  const dag = buildObservedDag(src);
  return buildEventOrdering({ source: src, dag, ...(contributors ? { contributors } : {}) });
}

function ref(sessionId: string, seq: number): EventRef {
  return { sessionId, seq };
}

function attributed(sessionId: string, studentRef: string): SessionContributor {
  return {
    kind: 'attributed',
    sessionId,
    contributorKey: `attributed:2.0:course:c1:${studentRef}`,
    studentRef,
    identityVersion: '2.0',
    scope: 'course',
    scopeId: 'c1',
    studentPubkey: 'pk',
    certWindow: { in_window: true },
    credentialWindow: { in_window: true },
  };
}

// ---------------------------------------------------------------------------
// L0 — the hash chain inside one session
// ---------------------------------------------------------------------------

describe('L0 — intra-session total order', () => {
  it('orders two events in one session by seq', () => {
    const o = build({ [S1]: [sessionStart(0, S1, null), edit(1), edit(2)] });
    expect(compareEvents(o, ref(S1, 1), ref(S1, 2))).toBe('before');
    expect(compareEvents(o, ref(S1, 2), ref(S1, 1))).toBe('after');
    expect(compareEvents(o, ref(S1, 1), ref(S1, 1))).toBe('same');
  });

  it('orders within a session even with no git.event anywhere in the bundle', () => {
    const o = build({
      [S1]: [sessionStart(0, S1, null), edit(1), edit(2), edit(3)],
      [S2]: [sessionStart(0, S2, null), edit(1), edit(2)],
    });
    expect(compareEvents(o, ref(S1, 1), ref(S1, 3))).toBe('before');
    expect(compareEvents(o, ref(S2, 1), ref(S2, 2))).toBe('before');
    // …and says nothing across the two unlinked sessions, which is correct.
    expect(compareEvents(o, ref(S1, 1), ref(S2, 1))).toBe('concurrent');
  });

  it('answers unknown — not concurrent — for an event nobody recorded', () => {
    const o = build({ [S1]: [sessionStart(0, S1, null), edit(1)] });
    expect(compareEvents(o, ref(S1, 1), ref(S1, 99))).toBe('unknown');
    expect(compareEvents(o, ref(S1, 1), ref('no-such-session', 0))).toBe('unknown');
    // The distinction is the whole point: "no record" is not "genuinely raced".
    expect(areConcurrent(o, ref(S1, 1), ref(S1, 99))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L1 — the contributor's session chain
// ---------------------------------------------------------------------------

describe('L1 — intra-contributor session chain', () => {
  it('orders every event of a session before every event of its successor', () => {
    const o = build({
      [S1]: [sessionStart(0, S1, null), edit(1), edit(2)],
      [S2]: [sessionStart(0, S2, S1), edit(1), edit(2)],
    });
    expect(compareEvents(o, ref(S1, 2), ref(S2, 0))).toBe('before');
    expect(compareEvents(o, ref(S1, 0), ref(S2, 2))).toBe('before');
    expect(compareEvents(o, ref(S2, 1), ref(S1, 1))).toBe('after');
  });

  it('is transitive across a three-session chain', () => {
    const o = build({
      [S1]: [sessionStart(0, S1, null), edit(1)],
      [S2]: [sessionStart(0, S2, S1), edit(1)],
      [S3]: [sessionStart(0, S3, S2), edit(1)],
    });
    expect(compareEvents(o, ref(S1, 1), ref(S3, 1))).toBe('before');
  });

  it('refuses the edge when the back-pointer names a different contributor', () => {
    const contributors = new Map<string, SessionContributor>([
      [S1, attributed(S1, 'alice')],
      [S2, attributed(S2, 'bob')],
    ]);
    const o = build(
      {
        [S1]: [sessionStart(0, S1, null), edit(1)],
        [S2]: [sessionStart(0, S2, S1), edit(1)],
      },
      contributors,
    );
    // Honouring it would hang Bob's chain off Alice's — laundering work onto
    // someone who did not do it.
    expect(compareEvents(o, ref(S1, 1), ref(S2, 1))).toBe('concurrent');
    expect(o.defects).toEqual([
      expect.objectContaining({
        kind: 'foreign_session_link',
        sessionId: S2,
        prevSessionId: S1,
      }),
    ]);
  });

  it('still links when contributors are merely unknown, and reports nothing', () => {
    // Pre-identity bundles are the entire existing corpus. Refusing to order one
    // student's own two sessions because nobody signed an identity block would
    // discard real, recorded ordering for every course shipped so far.
    const o = build({
      [S1]: [sessionStart(0, S1, null), edit(1)],
      [S2]: [sessionStart(0, S2, S1), edit(1)],
    });
    expect(compareEvents(o, ref(S1, 1), ref(S2, 1))).toBe('before');
    expect(o.defects).toEqual([]);
  });

  it('reports a back-pointer at a session outside the scope, and adds no edge', () => {
    const o = build({ [S2]: [sessionStart(0, S2, 'absent-session'), edit(1)] });
    expect(o.defects).toEqual([
      expect.objectContaining({ kind: 'dangling_session_link', prevSessionId: 'absent-session' }),
    ]);
  });

  it('reports a session-chain cycle and refuses to order the sessions in it', () => {
    const o = build({
      [S1]: [sessionStart(0, S1, S2), edit(1)],
      [S2]: [sessionStart(0, S2, S1), edit(1)],
    });
    expect(o.defects).toEqual([
      expect.objectContaining({ kind: 'session_chain_cycle', sessionIds: [S1, S2] }),
    ]);
    expect(compareEvents(o, ref(S1, 1), ref(S2, 1))).toBe('concurrent');
  });
});

// ---------------------------------------------------------------------------
// L2 — the observed commit DAG, the only cross-contributor relation
// ---------------------------------------------------------------------------

describe('L2 — the observed commit DAG', () => {
  it('orders across contributors through commit ancestry', () => {
    // Alice commits A; Bob commits B on top of A. Bob's post-B work therefore
    // happened after Alice's pre-A work.
    const o = build({
      [S1]: [sessionStart(0, S1, null), edit(1), gitEvent(2, A, [])],
      [S2]: [sessionStart(0, S2, null), gitEvent(1, B, [A]), edit(2)],
    });
    expect(compareEvents(o, ref(S1, 1), ref(S2, 2))).toBe('before');
    expect(compareEvents(o, ref(S2, 2), ref(S1, 1))).toBe('after');
  });

  it('leaves two partners on divergent branches unordered', () => {
    // A is the fork point. Alice commits C on A, Bob commits D on A. Neither
    // branch is an ancestor of the other, so their work genuinely raced.
    const o = build({
      [S1]: [sessionStart(0, S1, null), gitEvent(1, A, []), edit(2), gitEvent(3, C, [A])],
      [S2]: [sessionStart(0, S2, null), gitEvent(1, A, []), edit(2), gitEvent(3, D, [A])],
    });
    expect(compareEvents(o, ref(S1, 2), ref(S2, 2))).toBe('concurrent');
    expect(areConcurrent(o, ref(S1, 2), ref(S2, 2))).toBe(true);
    expect(happensBefore(o, ref(S1, 2), ref(S2, 2))).toBe(false);
    expect(happensBefore(o, ref(S2, 2), ref(S1, 2))).toBe(false);
  });

  it('orders both sides of a merge before the merge commit', () => {
    // Alice: A → C. Bob: A → D. Alice merges both into MERGE.
    const o = build({
      [S1]: [
        sessionStart(0, S1, null),
        gitEvent(1, A, []),
        edit(2),
        gitEvent(3, C, [A]),
        edit(4),
        gitEvent(5, MERGE, [C, D]),
        edit(6),
      ],
      [S2]: [sessionStart(0, S2, null), edit(1), gitEvent(2, D, [A]), edit(3)],
    });
    // Both branches precede post-merge work…
    expect(compareEvents(o, ref(S1, 2), ref(S1, 6))).toBe('before');
    expect(compareEvents(o, ref(S2, 1), ref(S1, 6))).toBe('before');
    // …while remaining concurrent with each other.
    expect(compareEvents(o, ref(S1, 4), ref(S2, 1))).toBe('concurrent');
  });

  it('does not order work recorded AFTER a contributor’s last observation', () => {
    // Alice: … commits A at seq 1, then keeps typing at seq 2-3.
    // Bob:   types at seq 1, commits B on top of A at seq 2, types at seq 3.
    const o = build({
      [S1]: [sessionStart(0, S1, null), gitEvent(1, A, []), edit(2), edit(3)],
      [S2]: [sessionStart(0, S2, null), edit(1), gitEvent(2, B, [A]), edit(3)],
    });

    // Alice's work BEFORE she committed A is proven to precede Bob's work after
    // he built on A. That is the DAG doing its job.
    expect(compareEvents(o, ref(S1, 0), ref(S2, 3))).toBe('before');

    // But Alice's typing AFTER A is a different matter: she may have kept working
    // for hours while Bob built on the commit she had already pushed. Nothing in
    // the evidence orders those, and inventing an order here is precisely how a
    // heuristic would later claim she copied work she in fact wrote first.
    expect(compareEvents(o, ref(S1, 2), ref(S2, 3))).toBe('concurrent');
    expect(compareEvents(o, ref(S1, 3), ref(S2, 3))).toBe('concurrent');

    // Symmetrically, Bob's typing before he observed anything is unordered
    // against Alice's post-commit typing.
    expect(compareEvents(o, ref(S2, 1), ref(S1, 2))).toBe('concurrent');
  });
});

// ---------------------------------------------------------------------------
// L3 — wall clock is not an ordering authority
// ---------------------------------------------------------------------------

describe('L3 — wall clock generates nothing', () => {
  it('gives identical answers under arbitrary clock skew between two machines', () => {
    const makeSessions = (skewedWall: string): Sessions => ({
      [S1]: [
        sessionStart(0, S1, null),
        edit(1, '2026-01-01T10:00:00.000Z'),
        gitEvent(2, A, [], '2026-01-01T10:01:00.000Z'),
      ],
      [S2]: [
        sessionStart(0, S2, null, skewedWall),
        gitEvent(1, B, [A], skewedWall),
        edit(2, skewedWall),
      ],
    });

    // Bob's machine is a YEAR behind Alice's. The commit DAG still proves his
    // work came after hers, and the relation must not budge.
    const honest = build(makeSessions('2026-01-01T10:02:00.000Z'));
    const skewed = build(makeSessions('2025-01-01T00:00:00.000Z'));

    for (const o of [honest, skewed]) {
      expect(compareEvents(o, ref(S1, 1), ref(S2, 2))).toBe('before');
      expect(compareEvents(o, ref(S2, 2), ref(S1, 1))).toBe('after');
    }
    // …and the presentation order is unchanged too, because its tiebreak is
    // (sessionId, seq) rather than the clock.
    expect(orderKeys(honest, allRefs(makeSessions('2026-01-01T10:02:00.000Z')))).toEqual(
      orderKeys(skewed, allRefs(makeSessions('2025-01-01T00:00:00.000Z'))),
    );
  });

  it('does not read the clock even when it runs backwards inside one session', () => {
    const o = build({
      [S1]: [
        sessionStart(0, S1, null),
        edit(1, '2026-01-01T10:00:00.000Z'),
        edit(2, '1999-01-01T00:00:00.000Z'),
      ],
    });
    // seq wins; the hash chain is the evidence, the clock is decoration.
    expect(compareEvents(o, ref(S1, 1), ref(S1, 2))).toBe('before');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

function allRefs(sessions: Sessions): EventRef[] {
  const out: EventRef[] = [];
  for (const [sessionId, events] of Object.entries(sessions)) {
    for (const e of events) out.push({ sessionId, seq: e.seq });
  }
  return out;
}

function orderKeys(o: EventOrdering, refs: readonly EventRef[]): string[] {
  return presentationSort(o, refs).map((r) => `${r.sessionId}:${r.seq}`);
}

/** A full pairwise dump of the relation — the strongest determinism witness. */
function relationDump(o: EventOrdering, refs: readonly EventRef[]): string {
  const sorted = [...refs].sort(compareEventRefs);
  const lines: string[] = [];
  for (const a of sorted) {
    for (const b of sorted) {
      lines.push(`${a.sessionId}:${a.seq}|${b.sessionId}:${b.seq}=${compareEvents(o, a, b)}`);
    }
  }
  lines.push(`defects=${JSON.stringify(o.defects)}`);
  lines.push(`sessions=${o.sessionIds.join(',')}`);
  return lines.join('\n');
}

describe('determinism', () => {
  const sessions: Sessions = {
    [S1]: [sessionStart(0, S1, null), gitEvent(1, A, []), edit(2), gitEvent(3, C, [A])],
    [S2]: [sessionStart(0, S2, null), edit(1), gitEvent(2, D, [A]), edit(3)],
    [S3]: [sessionStart(0, S3, S1), gitEvent(1, MERGE, [C, D]), edit(2)],
  };

  it('produces byte-identical results across two runs', () => {
    const first = relationDump(build(sessions), allRefs(sessions));
    const second = relationDump(build(sessions), allRefs(sessions));
    expect(second).toBe(first);
  });

  it('is invariant to the order the sessions are supplied in', () => {
    const forward = build(sessions);
    const reversed = build(Object.fromEntries(Object.entries(sessions).reverse()));
    expect(relationDump(reversed, allRefs(sessions))).toBe(
      relationDump(forward, allRefs(sessions)),
    );
  });

  it('is invariant to the order the events are supplied to presentationSort', () => {
    const o = build(sessions);
    const refs = allRefs(sessions);
    const shuffled = [...refs].reverse();
    expect(orderKeys(o, shuffled)).toEqual(orderKeys(o, refs));
  });
});

// ---------------------------------------------------------------------------
// Presentation vs. happens-before — the confusion that must be impossible
// ---------------------------------------------------------------------------

describe('presentation is not an ordering claim', () => {
  it('emits concurrent events adjacently while still reporting them concurrent', () => {
    const sessions: Sessions = {
      [S1]: [sessionStart(0, S1, null), gitEvent(1, A, []), edit(2), gitEvent(3, C, [A])],
      [S2]: [sessionStart(0, S2, null), edit(1), gitEvent(2, D, [A])],
    };
    const o = build(sessions);
    const listed = presentationSort(o, allRefs(sessions));
    // The list is total — it has to be, a list is a list…
    expect(listed).toHaveLength(allRefs(sessions).length);
    // …but adjacency in it proves nothing, and the relation still says so.
    expect(compareEvents(o, ref(S1, 2), ref(S2, 1))).toBe('concurrent');
  });

  it('never contradicts `≺` — every listed pair that is ordered appears in that order', () => {
    const sessions: Sessions = {
      [S1]: [sessionStart(0, S1, null), edit(1), gitEvent(2, A, []), edit(3)],
      [S2]: [sessionStart(0, S2, null), gitEvent(1, B, [A]), edit(2)],
      [S3]: [sessionStart(0, S3, null), gitEvent(1, D, [A]), edit(2)],
    };
    const o = build(sessions);
    const listed = presentationSort(o, allRefs(sessions));
    for (let i = 0; i < listed.length; i++) {
      for (let j = i + 1; j < listed.length; j++) {
        // Nothing later in the list may happen-before something earlier.
        expect(compareEvents(o, listed[j]!, listed[i]!)).not.toBe('before');
      }
    }
  });

  it('exposes the tiebreak as a separate, clock-free function', () => {
    expect(compareEventRefs(ref(S1, 1), ref(S1, 2))).toBeLessThan(0);
    expect(compareEventRefs(ref(S2, 0), ref(S1, 999))).toBeGreaterThan(0);
    expect(compareEventRefs(ref(S1, 5), ref(S1, 5))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

describe('performance', () => {
  /**
   * The shape that matters: event count is large, `git.event` count is not.
   * `≺` is factored through the commit observations precisely so that the
   * expensive structure scales with commits (tens–hundreds) rather than with
   * keystrokes (tens of thousands). If a future change reintroduces a pass that
   * is quadratic in EVENTS, this is where it shows up.
   */
  function bigScope(eventsPerSession: number, commitsPerSession: number): Sessions {
    const sessions: Sessions = {};
    let prevSha: string | null = null;
    for (const sid of [S1, S2, S3]) {
      const events: HashedEnvelope[] = [sessionStart(0, sid, null)];
      const commitEvery = Math.floor(eventsPerSession / commitsPerSession);
      for (let i = 1; i <= eventsPerSession; i++) {
        if (i % commitEvery === 0) {
          const sha = `${sid}-${i}`.padEnd(40, '0');
          events.push(gitEvent(i, sha, prevSha === null ? [] : [prevSha]));
          prevSha = sha;
        } else {
          events.push(edit(i));
        }
      }
      sessions[sid] = events;
    }
    return sessions;
  }

  it('builds and queries a 30k-event / 300-commit scope well inside budget', () => {
    const sessions = bigScope(10_000, 100);
    const totalEvents = Object.values(sessions).reduce((n, e) => n + e.length, 0);
    expect(totalEvents).toBeGreaterThan(30_000);

    const buildStart = performance.now();
    const o = build(sessions);
    const buildMs = performance.now() - buildStart;

    // 10k pairwise queries, to show the query path is O(1) and not a search.
    const refs = allRefs(sessions);
    const queryStart = performance.now();
    for (let i = 0; i < 10_000; i++) {
      compareEvents(o, refs[i % refs.length]!, refs[(i * 7919) % refs.length]!);
    }
    const queryMs = performance.now() - queryStart;

    const sortStart = performance.now();
    presentationSort(o, refs);
    const sortMs = performance.now() - sortStart;

    // Generous ceilings — these are CI-tolerance guard rails against an
    // accidental O(n²)-in-events pass, not a benchmark. A quadratic regression
    // blows through them by orders of magnitude.
    expect(buildMs).toBeLessThan(2000);
    expect(queryMs).toBeLessThan(500);
    expect(sortMs).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// The regression that protects every existing course
// ---------------------------------------------------------------------------

describe('single-contributor bundles are unaffected', () => {
  it('lists a one-session bundle in exactly seq order', () => {
    const sessions: Sessions = {
      [S1]: [sessionStart(0, S1, null), edit(1), gitEvent(2, A, []), edit(3), edit(4)],
    };
    const o = build(sessions);
    expect(orderKeys(o, allRefs(sessions))).toEqual([
      `${S1}:0`,
      `${S1}:1`,
      `${S1}:2`,
      `${S1}:3`,
      `${S1}:4`,
    ]);
  });

  it('lists a chained multi-session bundle in session-chain then seq order', () => {
    const sessions: Sessions = {
      [S2]: [sessionStart(0, S2, S1), edit(1)],
      [S1]: [sessionStart(0, S1, null), edit(1)],
      [S3]: [sessionStart(0, S3, S2), edit(1)],
    };
    const o = build(sessions);
    expect(orderKeys(o, allRefs(sessions))).toEqual([
      `${S1}:0`,
      `${S1}:1`,
      `${S2}:0`,
      `${S2}:1`,
      `${S3}:0`,
      `${S3}:1`,
    ]);
  });
});
