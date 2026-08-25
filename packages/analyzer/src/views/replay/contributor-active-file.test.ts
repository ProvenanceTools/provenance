/**
 * Tests for contributor-active-file.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  activeFileAt,
  activeFileFromTimeline,
  activeFilesAt,
  buildActiveFileTimelines,
} from './contributor-active-file.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';

let _g = 0;
function ev(sessionId: string, kind: EventKind, file?: string): IndexedEvent {
  const globalIdx = _g++;
  return {
    sessionId,
    seq: globalIdx,
    globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind,
    payload: {},
    ...(file !== undefined ? { file } : {}),
  };
}

function reset(): void {
  _g = 0;
}

describe('activeFileAt', () => {
  it('returns null before the first event', () => {
    reset();
    const events = [ev('s1', 'doc.change', 'a.py')];
    expect(activeFileAt(events, new Set(['s1']), -1)).toBeNull();
  });

  it('returns the file of the most recent file-bearing event for that session set', () => {
    reset();
    const events = [ev('s1', 'doc.change', 'a.py'), ev('s1', 'doc.change', 'b.py')];
    expect(activeFileAt(events, new Set(['s1']), 1)).toBe('b.py');
  });

  it('ignores events from sessions outside the set', () => {
    reset();
    const events = [
      ev('alice', 'doc.change', 'a.py'),
      ev('bob', 'doc.change', 'b.py'),
      ev('alice', 'doc.change', 'a2.py'),
    ];
    // Bob's event (idx 1) is the most recent overall, but not in alice's set.
    expect(activeFileAt(events, new Set(['alice']), 1)).toBe('a.py');
    expect(activeFileAt(events, new Set(['alice']), 2)).toBe('a2.py');
    expect(activeFileAt(events, new Set(['bob']), 1)).toBe('b.py');
  });

  it('returns null for a contributor whose sessions have no events yet at this playhead', () => {
    reset();
    const events = [ev('alice', 'doc.change', 'a.py')];
    expect(activeFileAt(events, new Set(['bob']), 0)).toBeNull();
  });

  it('returns null for an empty session-id set', () => {
    reset();
    const events = [ev('alice', 'doc.change', 'a.py')];
    expect(activeFileAt(events, new Set(), 0)).toBeNull();
  });

  it('supports a contributor spanning multiple sessions (two machines)', () => {
    reset();
    const events = [
      ev('laptop', 'doc.change', 'a.py'),
      ev('desktop', 'doc.change', 'b.py'),
      ev('laptop', 'doc.change', 'a2.py'),
    ];
    const sessionIds = new Set(['laptop', 'desktop']);
    expect(activeFileAt(events, sessionIds, 2)).toBe('a2.py');
  });

  it('ignores non-file-bearing events (e.g. focus.change) within the session set', () => {
    reset();
    const events = [ev('s1', 'doc.change', 'a.py'), ev('s1', 'focus.change')];
    expect(activeFileAt(events, new Set(['s1']), 1)).toBe('a.py');
  });
});

// ---------------------------------------------------------------------------
// The precomputed timeline. The contract is not "these are the right answers"
// — `activeFileAt` above already pins that — it is "the index agrees with the
// scan at EVERY index". So most of these assert equivalence rather than
// re-deriving expected paths by hand.
// ---------------------------------------------------------------------------

describe('buildActiveFileTimelines', () => {
  it('records only TRANSITIONS, not one point per event', () => {
    reset();
    const events = [
      ev('s1', 'doc.change', 'a.py'),
      ev('s1', 'doc.change', 'a.py'),
      ev('s1', 'doc.change', 'a.py'),
      ev('s1', 'doc.change', 'b.py'),
    ];
    const timelines = buildActiveFileTimelines(events, new Map([['alice', new Set(['s1'])]]));
    expect(timelines.get('alice')).toEqual([
      { atGlobalIdx: 0, filePath: 'a.py' },
      { atGlobalIdx: 3, filePath: 'b.py' },
    ]);
  });

  it('gives every contributor an entry, empty when they have no file-bearing event', () => {
    reset();
    const events = [ev('s1', 'doc.change', 'a.py')];
    const timelines = buildActiveFileTimelines(
      events,
      new Map([
        ['alice', new Set(['s1'])],
        ['bob', new Set(['s2'])],
      ]),
    );
    expect(timelines.get('bob')).toEqual([]);
    // "has no activity yet" must be distinguishable from "is not a contributor".
    expect(timelines.has('bob')).toBe(true);
  });

  it('skips events whose session belongs to no contributor', () => {
    reset();
    const events = [ev('stranger', 'doc.change', 'x.py'), ev('s1', 'doc.change', 'a.py')];
    const timelines = buildActiveFileTimelines(events, new Map([['alice', new Set(['s1'])]]));
    expect(timelines.get('alice')).toEqual([{ atGlobalIdx: 1, filePath: 'a.py' }]);
  });

  it('ignores non-file-bearing events', () => {
    reset();
    const events = [ev('s1', 'doc.change', 'a.py'), ev('s1', 'focus.change')];
    const timelines = buildActiveFileTimelines(events, new Map([['alice', new Set(['s1'])]]));
    expect(timelines.get('alice')).toEqual([{ atGlobalIdx: 0, filePath: 'a.py' }]);
  });

  it('merges a contributor spanning two sessions into one timeline', () => {
    reset();
    const events = [
      ev('laptop', 'doc.change', 'a.py'),
      ev('desktop', 'doc.change', 'b.py'),
      ev('laptop', 'doc.change', 'a.py'),
    ];
    const timelines = buildActiveFileTimelines(
      events,
      new Map([['alice', new Set(['laptop', 'desktop'])]]),
    );
    // b.py at 1 IS a transition for alice (both machines are hers), and the
    // return to a.py at 2 is another one.
    expect(timelines.get('alice')).toEqual([
      { atGlobalIdx: 0, filePath: 'a.py' },
      { atGlobalIdx: 1, filePath: 'b.py' },
      { atGlobalIdx: 2, filePath: 'a.py' },
    ]);
  });
});

describe('activeFileFromTimeline', () => {
  it('returns null for an empty timeline, at any index', () => {
    expect(activeFileFromTimeline([], -1)).toBeNull();
    expect(activeFileFromTimeline([], 0)).toBeNull();
    expect(activeFileFromTimeline([], 9999)).toBeNull();
  });

  it('returns null before the first change point', () => {
    const points = [{ atGlobalIdx: 5, filePath: 'a.py' }];
    expect(activeFileFromTimeline(points, 4)).toBeNull();
    expect(activeFileFromTimeline(points, 5)).toBe('a.py');
  });

  it('is inclusive of the change point index and holds until the next one', () => {
    const points = [
      { atGlobalIdx: 0, filePath: 'a.py' },
      { atGlobalIdx: 10, filePath: 'b.py' },
    ];
    expect(activeFileFromTimeline(points, 0)).toBe('a.py');
    expect(activeFileFromTimeline(points, 9)).toBe('a.py');
    expect(activeFileFromTimeline(points, 10)).toBe('b.py');
    expect(activeFileFromTimeline(points, 1_000)).toBe('b.py');
  });
});

describe('the timeline and the linear scan agree', () => {
  /**
   * The equivalence that makes the index safe to substitute for the scan. If
   * these ever diverge, the lane grid is showing a contributor in a file the
   * single-pane auto-follow would not put them in.
   */
  it('at every index, for every contributor, on an interleaved multi-file stream', () => {
    reset();
    const events = [
      ev('alice-1', 'doc.open', 'a.py'),
      ev('bob-1', 'doc.change', 'b.py'),
      ev('alice-1', 'doc.change', 'a.py'),
      ev('alice-1', 'focus.change'),
      ev('bob-1', 'paste', 'shared.py'),
      ev('alice-2', 'doc.save', 'shared.py'),
      ev('bob-1', 'doc.change', 'b.py'),
      ev('alice-2', 'doc.change', 'shared.py'),
    ];
    const sessionsByContributor = new Map<string, ReadonlySet<string>>([
      ['alice', new Set(['alice-1', 'alice-2'])],
      ['bob', new Set(['bob-1'])],
      ['carol', new Set(['carol-1'])],
    ]);
    const timelines = buildActiveFileTimelines(events, sessionsByContributor);

    for (let idx = -1; idx <= events.length; idx++) {
      const viaIndex = activeFilesAt(timelines, idx);
      for (const [contributorKey, sessionIds] of sessionsByContributor) {
        expect(viaIndex.get(contributorKey) ?? null).toBe(activeFileAt(events, sessionIds, idx));
      }
    }
  });
});

describe('activeFilesAt', () => {
  it('is total over the timelines it was given, with null for the not-yet-started', () => {
    reset();
    const events = [ev('s1', 'doc.change', 'a.py')];
    const timelines = buildActiveFileTimelines(
      events,
      new Map([
        ['alice', new Set(['s1'])],
        ['bob', new Set(['s2'])],
      ]),
    );
    const at0 = activeFilesAt(timelines, 0);
    expect([...at0.keys()].sort()).toEqual(['alice', 'bob']);
    expect(at0.get('alice')).toBe('a.py');
    expect(at0.get('bob')).toBeNull();
  });
});
