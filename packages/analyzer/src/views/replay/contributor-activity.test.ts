/**
 * Tests for contributor-activity.ts.
 */

import { describe, it, expect } from 'vitest';
import { buildContributorActivity } from './contributor-activity.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { SessionContributor } from '@provenance/analysis-core/identity/types.js';

const BASE = Date.parse('2026-01-01T00:00:00.000Z');

let _g = 0;
function reset(): void {
  _g = 0;
}

function ev(sessionId: string, offsetMs: number, wall?: string): IndexedEvent {
  const globalIdx = _g++;
  return {
    sessionId,
    seq: globalIdx,
    globalIdx,
    wall: wall ?? new Date(BASE + offsetMs).toISOString(),
    t: offsetMs,
    kind: 'doc.change',
    payload: {},
  };
}

function contributor(sessionId: string, key: string): SessionContributor {
  return {
    kind: 'attributed',
    sessionId,
    contributorKey: key,
    studentRef: key,
    identityVersion: '2.1',
    scope: 'institution',
    scopeId: 'inst1',
    studentPubkey: 'pk',
    certWindow: { in_window: true },
    credentialWindow: { in_window: true },
  };
}

function bySession(
  ...pairs: Array<[sessionId: string, key: string]>
): Map<string, SessionContributor> {
  return new Map(pairs.map(([sessionId, key]) => [sessionId, contributor(sessionId, key)]));
}

describe('buildContributorActivity — runs', () => {
  it('builds one run for one contributor with no idle gaps', () => {
    reset();
    const events = [ev('s1', 0), ev('s1', 1_000), ev('s1', 2_000)];
    const { runs, overlaps } = buildContributorActivity(events, bySession(['s1', 'alice']), {
      idleGapMs: 60_000,
    });
    expect(runs.get('alice')).toEqual([
      { contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 2, idle: false },
    ]);
    expect(overlaps).toEqual([]);
  });

  it('splits a run at a wall gap exceeding idleGapMs', () => {
    reset();
    const events = [ev('s1', 0), ev('s1', 100_000)]; // gap 100s > 60s threshold
    const { runs } = buildContributorActivity(events, bySession(['s1', 'alice']), {
      idleGapMs: 60_000,
    });
    expect(runs.get('alice')).toEqual([
      { contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 0, idle: false },
      { contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 1, idle: true },
      { contributorKey: 'alice', startGlobalIdx: 1, endGlobalIdx: 1, idle: false },
    ]);
  });

  it('does not split when the gap is exactly at the threshold (strictly greater required)', () => {
    reset();
    const events = [ev('s1', 0), ev('s1', 60_000)];
    const { runs } = buildContributorActivity(events, bySession(['s1', 'alice']), {
      idleGapMs: 60_000,
    });
    expect(runs.get('alice')).toEqual([
      { contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 1, idle: false },
    ]);
  });

  it('produces a zero-width active segment between two consecutive idle gaps', () => {
    reset();
    const events = [ev('s1', 0), ev('s1', 100_000), ev('s1', 200_000)];
    const { runs } = buildContributorActivity(events, bySession(['s1', 'alice']), {
      idleGapMs: 60_000,
    });
    expect(runs.get('alice')).toEqual([
      { contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 0, idle: false },
      { contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 1, idle: true },
      { contributorKey: 'alice', startGlobalIdx: 1, endGlobalIdx: 1, idle: false },
      { contributorKey: 'alice', startGlobalIdx: 1, endGlobalIdx: 2, idle: true },
      { contributorKey: 'alice', startGlobalIdx: 2, endGlobalIdx: 2, idle: false },
    ]);
  });

  it('treats an unparseable wall timestamp as a zero gap (never idle)', () => {
    reset();
    const events = [ev('s1', 0, 'not-a-date'), ev('s1', 1_000, 'also-not-a-date')];
    const { runs } = buildContributorActivity(events, bySession(['s1', 'alice']), {
      idleGapMs: 0,
    });
    expect(runs.get('alice')).toEqual([
      { contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 1, idle: false },
    ]);
  });

  it('treats a gap with only ONE side unparseable as zero too (not just both-invalid)', () => {
    reset();
    const events = [ev('s1', 0), ev('s1', 1_000, 'not-a-date')];
    const { runs } = buildContributorActivity(events, bySession(['s1', 'alice']), {
      idleGapMs: 0,
    });
    expect(runs.get('alice')).toEqual([
      { contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 1, idle: false },
    ]);
  });

  it('breaks a run at an interleaved different-contributor event and appends the resumed run', () => {
    reset();
    const events = [ev('alice-sess', 0), ev('bob-sess', 1_000), ev('alice-sess', 2_000)];
    const map = bySession(['alice-sess', 'alice'], ['bob-sess', 'bob']);
    const { runs } = buildContributorActivity(events, map, { idleGapMs: 999_999 });
    expect(runs.get('alice')).toEqual([
      { contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 0, idle: false },
      { contributorKey: 'alice', startGlobalIdx: 2, endGlobalIdx: 2, idle: false },
    ]);
    expect(runs.get('bob')).toEqual([
      { contributorKey: 'bob', startGlobalIdx: 1, endGlobalIdx: 1, idle: false },
    ]);
  });

  it('supports a contributor spanning two sessions as one contiguous run', () => {
    reset();
    const events = [ev('laptop', 0), ev('laptop', 1_000)];
    const map = bySession(['laptop', 'alice'], ['desktop', 'alice']);
    const { runs } = buildContributorActivity(events, map, { idleGapMs: 60_000 });
    expect(runs.get('alice')).toEqual([
      { contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 1, idle: false },
    ]);
  });

  it('skips events from a session absent from contributorBySession without crashing or inventing a key', () => {
    reset();
    const events = [ev('alice-sess', 0), ev('ghost-sess', 1_000), ev('alice-sess', 2_000)];
    const map = bySession(['alice-sess', 'alice']); // ghost-sess intentionally absent
    const { runs } = buildContributorActivity(events, map, { idleGapMs: 999_999 });
    expect(runs.get('alice')).toEqual([
      { contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 0, idle: false },
      { contributorKey: 'alice', startGlobalIdx: 2, endGlobalIdx: 2, idle: false },
    ]);
    expect(runs.size).toBe(1);
    expect([...runs.keys()]).not.toContain('ghost');
  });

  it('returns an empty runs map and no overlaps for an empty event stream', () => {
    reset();
    const { runs, overlaps } = buildContributorActivity([], bySession(['s1', 'alice']), {
      idleGapMs: 1_000,
    });
    expect(runs.size).toBe(0);
    expect(overlaps).toEqual([]);
  });
});

describe('buildContributorActivity — overlaps', () => {
  it('returns no overlap for a single contributor', () => {
    reset();
    const events = [ev('s1', 0), ev('s1', 1_000)];
    const { overlaps } = buildContributorActivity(events, bySession(['s1', 'alice']), {
      idleGapMs: 1_000,
    });
    expect(overlaps).toEqual([]);
  });

  it('finds the overlap interval where two contributors envelopes intersect', () => {
    reset();
    // alice: idx0, idx2 (envelope [0,2]); bob: idx1, idx3 (envelope [1,3])
    const events = [ev('a', 0), ev('b', 1_000), ev('a', 2_000), ev('b', 3_000)];
    const map = bySession(['a', 'alice'], ['b', 'bob']);
    const { overlaps } = buildContributorActivity(events, map, { idleGapMs: 999_999 });
    expect(overlaps).toEqual([
      { startGlobalIdx: 1, endGlobalIdx: 2, contributorKeys: ['alice', 'bob'] },
    ]);
  });

  it('does not register overlap for envelopes that only touch at a boundary', () => {
    reset();
    // alice: idx0-1; bob: idx2-3 — no interleaving, adjacent but disjoint envelopes.
    const events = [ev('a', 0), ev('a', 1_000), ev('b', 2_000), ev('b', 3_000)];
    const map = bySession(['a', 'alice'], ['b', 'bob']);
    const { overlaps } = buildContributorActivity(events, map, { idleGapMs: 999_999 });
    expect(overlaps).toEqual([]);
  });

  it('produces distinct overlap intervals as the active contributor set changes', () => {
    reset();
    // alice appears at idx {0,2,5}; bob at idx {1,4}; carol at idx {3,6,7}.
    // Envelopes: alice[0,5], bob[1,4], carol[3,7].
    const events = [
      ev('a', 0),
      ev('b', 1_000),
      ev('a', 2_000),
      ev('c', 3_000),
      ev('b', 4_000),
      ev('a', 5_000),
      ev('c', 6_000),
      ev('c', 7_000),
    ];
    const map = bySession(['a', 'alice'], ['b', 'bob'], ['c', 'carol']);
    const { overlaps } = buildContributorActivity(events, map, { idleGapMs: 999_999 });
    expect(overlaps).toEqual([
      { startGlobalIdx: 1, endGlobalIdx: 2, contributorKeys: ['alice', 'bob'] },
      { startGlobalIdx: 3, endGlobalIdx: 4, contributorKeys: ['alice', 'bob', 'carol'] },
      { startGlobalIdx: 5, endGlobalIdx: 5, contributorKeys: ['alice', 'carol'] },
    ]);
  });
});
