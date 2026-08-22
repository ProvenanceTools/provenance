/**
 * Tests for the timeline's ordering and its refusals.
 *
 * The two things that must hold, in priority order:
 *
 *  1. A concurrent two-contributor scope does NOT render as one asserted
 *     sequence — every adjacency the relation does not establish is marked.
 *  2. A solo scope is unchanged, BY REFERENCE, not merely by value. That is the
 *     regression risk: every existing course is solo.
 */

import { describe, it, expect } from 'vitest';
import type { HashedEnvelope } from '@provenance/log-core';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { SessionContributor } from '@provenance/analysis-core/identity/types.js';
import { buildObservedDag } from '@provenance/analysis-core/git/observed-dag.js';
import { buildEventOrdering } from '@provenance/analysis-core/order/happens-before.js';
import {
  computeOrderBreaks,
  contributorLabel,
  orderTimelineEvents,
  type TimelineOrderScope,
} from './presentation-order.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE = 'sess-alice';
const BOB = 'sess-bob';

function sessionStart(sessionId: string, wall: string): HashedEnvelope {
  return {
    seq: 0,
    t: 0,
    wall,
    kind: 'session.start',
    data: { format_version: '2.0', session_id: sessionId, prev_session_id: null },
    prev_hash: '0'.repeat(64),
    hash: '1'.repeat(64),
  } as HashedEnvelope;
}

function edit(seq: number, wall: string): HashedEnvelope {
  return {
    seq,
    t: seq,
    wall,
    kind: 'doc.change',
    data: { path: 'hw.py', deltas: [] },
    prev_hash: '0'.repeat(64),
    hash: '1'.repeat(64),
  } as HashedEnvelope;
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

/**
 * An `IndexedEvent` as `buildIndex` would produce it: `globalIdx` is the
 * position in the wall-sorted array, which is exactly the numbering
 * `flags.supporting_seqs` persists.
 */
function indexed(sessionId: string, seq: number, globalIdx: number, wall: string): IndexedEvent {
  return {
    sessionId,
    seq,
    globalIdx,
    wall,
    t: seq,
    kind: seq === 0 ? 'session.start' : 'doc.change',
    payload: {},
  };
}

/**
 * Alice and Bob, two verified contributors, editing at overlapping wall times
 * with NO git observation anywhere — so nothing connects their chains and every
 * cross-session pair is genuinely concurrent.
 *
 * The wall clocks are deliberately interleaved (A, B, A, B), which is exactly
 * what `buildIndex` would produce and exactly the sequence the timeline
 * presented as fact.
 */
function concurrentScope(): { scope: TimelineOrderScope; events: IndexedEvent[] } {
  const sessions = [
    {
      sessionId: ALICE,
      events: [
        sessionStart(ALICE, '2026-01-01T00:00:00.000Z'),
        edit(1, '2026-01-01T00:00:02.000Z'),
      ],
    },
    {
      sessionId: BOB,
      events: [sessionStart(BOB, '2026-01-01T00:00:01.000Z'), edit(1, '2026-01-01T00:00:03.000Z')],
    },
  ];
  const contributorBySession = new Map<string, SessionContributor>([
    [ALICE, attributed(ALICE, 'ref-alice')],
    [BOB, attributed(BOB, 'ref-bob')],
  ]);
  const ordering = buildEventOrdering({
    source: { sessions },
    dag: buildObservedDag({ sessions }),
    contributors: contributorBySession,
  });
  // Wall order: alice#0, bob#0, alice#1, bob#1 → globalIdx 0..3.
  const events = [
    indexed(ALICE, 0, 0, '2026-01-01T00:00:00.000Z'),
    indexed(BOB, 0, 1, '2026-01-01T00:00:01.000Z'),
    indexed(ALICE, 1, 2, '2026-01-01T00:00:02.000Z'),
    indexed(BOB, 1, 3, '2026-01-01T00:00:03.000Z'),
  ];
  return { scope: { ordering, contributorBySession }, events };
}

/** One student, two sessions. `hasTwoDifferentContributors` is false → no relation. */
function soloScope(): { scope: TimelineOrderScope; events: IndexedEvent[] } {
  const contributorBySession = new Map<string, SessionContributor>([
    [ALICE, attributed(ALICE, 'ref-alice')],
  ]);
  const events = [
    indexed(ALICE, 0, 0, '2026-01-01T00:00:00.000Z'),
    indexed(ALICE, 1, 1, '2026-01-01T00:00:01.000Z'),
    indexed(ALICE, 2, 2, '2026-01-01T00:00:02.000Z'),
  ];
  return { scope: { ordering: null, contributorBySession }, events };
}

// ---------------------------------------------------------------------------
// The solo guarantee
// ---------------------------------------------------------------------------

describe('solo / no-relation scopes are untouched', () => {
  it('returns the caller’s own array, by reference', () => {
    const { scope, events } = soloScope();
    expect(orderTimelineEvents(events, scope)).toBe(events);
    expect(orderTimelineEvents(events, null)).toBe(events);
  });

  it('marks no breaks at all', () => {
    const { scope, events } = soloScope();
    expect(computeOrderBreaks(events, scope).size).toBe(0);
    expect(computeOrderBreaks(events, null).size).toBe(0);
  });

  it('hands back the same empty map every time, so nothing re-renders on it', () => {
    const { scope, events } = soloScope();
    expect(computeOrderBreaks(events, scope)).toBe(computeOrderBreaks(events, null));
  });
});

// ---------------------------------------------------------------------------
// The fabrication
// ---------------------------------------------------------------------------

describe('a concurrent two-contributor scope is not presented as one sequence', () => {
  it('marks every adjacency the relation does not establish', () => {
    const { scope, events } = concurrentScope();
    const ordered = orderTimelineEvents(events, scope);
    const breaks = computeOrderBreaks(ordered, scope);

    // Four events, two contributors, nothing connecting them: the list contains
    // exactly one adjacency that crosses from one contributor to the other, and
    // it is marked. Anything less would leave part of the list asserting an
    // order the recording does not support.
    let crossings = 0;
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i - 1]!.sessionId !== ordered[i]!.sessionId) crossings += 1;
    }
    expect(crossings).toBeGreaterThan(0);
    expect(breaks.size).toBe(crossings);
    for (let i = 1; i < ordered.length; i++) {
      const crosses = ordered[i - 1]!.sessionId !== ordered[i]!.sessionId;
      expect(breaks.has(ordered[i]!.globalIdx)).toBe(crosses);
    }
  });

  it('calls the refusal `concurrent`, not `unknown`', () => {
    // Two recorded branches that raced, versus no record at all, lead a grader
    // to opposite conclusions. Collapsing them is the bug.
    const { scope, events } = concurrentScope();
    const breaks = computeOrderBreaks(orderTimelineEvents(events, scope), scope);
    for (const info of breaks.values()) expect(info.reason).toBe('concurrent');
  });

  it('names both sides of every break', () => {
    const { scope, events } = concurrentScope();
    const breaks = computeOrderBreaks(orderTimelineEvents(events, scope), scope);
    for (const info of breaks.values()) {
      expect(info.above).not.toBe(info.below);
      expect(info.above).toMatch(/contributor|session/);
      expect(info.below).toMatch(/contributor|session/);
    }
  });

  it('keeps each contributor’s own events in their own chain order', () => {
    // The intra-session hash chain IS a total order and is the strongest
    // evidence in the system. Refusing to order across contributors must not
    // cost us the order we do have.
    const { scope, events } = concurrentScope();
    const ordered = orderTimelineEvents(events, scope);
    for (const sid of [ALICE, BOB]) {
      const seqs = ordered.filter((e) => e.sessionId === sid).map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
  });

  it('does not renumber, drop, or duplicate a single event', () => {
    // `globalIdx` is persisted as `flags.supporting_seqs`. Re-ordering a display
    // array must leave every event object — and therefore every stored piece of
    // evidence pointing at it — exactly as it was.
    const { scope, events } = concurrentScope();
    const before = events.map((e) => ({ ...e }));
    const ordered = orderTimelineEvents(events, scope);
    expect(ordered.length).toBe(events.length);
    expect([...ordered].sort((a, b) => a.globalIdx - b.globalIdx)).toEqual(before);
    for (const e of ordered) expect(before.some((b) => b.globalIdx === e.globalIdx)).toBe(true);
  });

  it('is clock-free: moving one machine a year forward changes nothing', () => {
    const { scope, events } = concurrentScope();
    const baseline = orderTimelineEvents(events, scope).map((e) => `${e.sessionId}:${e.seq}`);
    const skewed = events.map((e) =>
      e.sessionId === BOB ? { ...e, wall: '2027-06-01T00:00:00.000Z' } : e,
    );
    const after = orderTimelineEvents(skewed, scope).map((e) => `${e.sessionId}:${e.seq}`);
    expect(after).toEqual(baseline);
  });
});

// ---------------------------------------------------------------------------
// Composition with the filter bar
// ---------------------------------------------------------------------------

describe('breaks compose with filtering', () => {
  it('does not invent a break when an intermediate event is filtered out', () => {
    // `≺` is transitive, so dropping a middle event of one session leaves the
    // surviving pair proven.
    const sessions = [
      {
        sessionId: ALICE,
        events: [
          sessionStart(ALICE, '2026-01-01T00:00:00.000Z'),
          edit(1, '2026-01-01T00:00:01.000Z'),
          edit(2, '2026-01-01T00:00:02.000Z'),
        ],
      },
    ];
    const contributorBySession = new Map<string, SessionContributor>([
      [ALICE, attributed(ALICE, 'ref-alice')],
      [BOB, attributed(BOB, 'ref-bob')],
    ]);
    const scope: TimelineOrderScope = {
      ordering: buildEventOrdering({
        source: { sessions },
        dag: buildObservedDag({ sessions }),
        contributors: contributorBySession,
      }),
      contributorBySession,
    };
    const kept = [
      indexed(ALICE, 0, 0, '2026-01-01T00:00:00.000Z'),
      indexed(ALICE, 2, 2, '2026-01-01T00:00:02.000Z'),
    ];
    expect(computeOrderBreaks(kept, scope).size).toBe(0);
  });

  it('reports `unknown` — not `concurrent` — for an event outside the relation', () => {
    // "We have no record" is a different fact from "two records raced".
    const sessions = [
      { sessionId: ALICE, events: [sessionStart(ALICE, '2026-01-01T00:00:00.000Z')] },
    ];
    const contributorBySession = new Map<string, SessionContributor>([
      [ALICE, attributed(ALICE, 'ref-alice')],
      [BOB, attributed(BOB, 'ref-bob')],
    ]);
    const scope: TimelineOrderScope = {
      ordering: buildEventOrdering({
        source: { sessions },
        dag: buildObservedDag({ sessions }),
        contributors: contributorBySession,
      }),
      contributorBySession,
    };
    const events = [
      indexed(ALICE, 0, 0, '2026-01-01T00:00:00.000Z'),
      // Not in the ordering's scope at all.
      indexed('sess-elsewhere', 0, 1, '2026-01-01T00:00:01.000Z'),
    ];
    const breaks = computeOrderBreaks(events, scope);
    expect([...breaks.values()].map((b) => b.reason)).toEqual(['unknown']);
  });
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('contributorLabel', () => {
  it('never names the contributor an unverifiable block claimed', () => {
    const scope: TimelineOrderScope = {
      ordering: null,
      contributorBySession: new Map<string, SessionContributor>([
        [
          BOB,
          {
            kind: 'unverifiable',
            sessionId: BOB,
            contributorKey: `unverifiable:${BOB}`,
            claimedStudentRef: 'ref-alice',
            claimedScopeId: 'c1',
            claimedIdentityVersion: '2.0',
            reason: {
              kind: 'chain_failed',
              error: { kind: 'unsupported_identity_version', format_version: '9.9' },
              detail: 'walk failed',
            },
          } satisfies SessionContributor,
        ],
      ]),
    };
    const label = contributorLabel(scope, BOB);
    expect(label).not.toContain('ref-alice');
    expect(label).toContain('not verified');
  });

  it('describes an unattributed session without implying a finding', () => {
    const scope: TimelineOrderScope = {
      ordering: null,
      contributorBySession: new Map<string, SessionContributor>([
        [
          ALICE,
          { kind: 'unattributed', sessionId: ALICE, contributorKey: `unattributed:${ALICE}` },
        ],
      ]),
    };
    expect(contributorLabel(scope, ALICE)).toContain('not identified');
  });
});
