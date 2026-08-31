/**
 * The cases here are the ones where a wrong answer would be INVISIBLE: an
 * off-by-one lands the playhead on a neighbouring event and still renders a
 * plausible file, so nothing about the UI would look broken. Every boundary the
 * binary search can get wrong therefore has an explicit test.
 */

import { describe, it, expect } from 'vitest';
import { resolveWallToGlobalIdx, localInputToIso } from './seek-to-time.js';
import type { TimedEvent } from './seek-to-time.js';

/** Wall-ascending events at 10:00, 10:05, 10:10, 10:20. */
const EVENTS: TimedEvent[] = [
  { globalIdx: 0, wall: '2026-09-01T10:00:00.000Z' },
  { globalIdx: 1, wall: '2026-09-01T10:05:00.000Z' },
  { globalIdx: 2, wall: '2026-09-01T10:10:00.000Z' },
  { globalIdx: 3, wall: '2026-09-01T10:20:00.000Z' },
];

describe('resolveWallToGlobalIdx', () => {
  it('reports empty for a bundle with no events', () => {
    expect(resolveWallToGlobalIdx([], '2026-09-01T10:00:00.000Z')).toEqual({ kind: 'empty' });
  });

  it('reports before_start when the target precedes every event', () => {
    const r = resolveWallToGlobalIdx(EVENTS, '2026-09-01T09:30:00.000Z');
    expect(r).toEqual({
      kind: 'before_start',
      firstWall: '2026-09-01T10:00:00.000Z',
      gapMs: 30 * 60_000,
    });
  });

  it('lands on the event itself when the target is exactly its wall', () => {
    const r = resolveWallToGlobalIdx(EVENTS, '2026-09-01T10:05:00.000Z');
    expect(r).toMatchObject({ kind: 'found', globalIdx: 1, gapMs: 0 });
  });

  it('lands on the EARLIER event when the target falls between two', () => {
    const r = resolveWallToGlobalIdx(EVENTS, '2026-09-01T10:07:30.000Z');
    expect(r).toMatchObject({ kind: 'found', globalIdx: 1, gapMs: 150_000 });
  });

  it('lands on the first event when the target is exactly the start', () => {
    const r = resolveWallToGlobalIdx(EVENTS, '2026-09-01T10:00:00.000Z');
    expect(r).toMatchObject({ kind: 'found', globalIdx: 0, gapMs: 0 });
  });

  it('reports after_end when the target follows the last event', () => {
    const r = resolveWallToGlobalIdx(EVENTS, '2026-09-01T11:00:00.000Z');
    expect(r).toMatchObject({ kind: 'after_end', globalIdx: 3, gapMs: 40 * 60_000 });
  });

  it('reports after_end when the target is exactly the last event', () => {
    // Nothing was recorded afterwards, which is the fact the caller must state;
    // "found" would let the UI imply the recording continued past this point.
    const r = resolveWallToGlobalIdx(EVENTS, '2026-09-01T10:20:00.000Z');
    expect(r).toMatchObject({ kind: 'after_end', globalIdx: 3, gapMs: 0 });
  });

  it('picks the LAST of several events sharing the target instant', () => {
    // A position before the final one would reproduce a file state that existed
    // only part-way through that millisecond.
    const tied: TimedEvent[] = [
      { globalIdx: 0, wall: '2026-09-01T10:00:00.000Z' },
      { globalIdx: 1, wall: '2026-09-01T10:05:00.000Z' },
      { globalIdx: 2, wall: '2026-09-01T10:05:00.000Z' },
      { globalIdx: 3, wall: '2026-09-01T10:05:00.000Z' },
      { globalIdx: 4, wall: '2026-09-01T10:09:00.000Z' },
    ];
    expect(resolveWallToGlobalIdx(tied, '2026-09-01T10:05:00.000Z')).toMatchObject({
      globalIdx: 3,
    });
  });

  it('handles a single-event bundle at every boundary', () => {
    const one: TimedEvent[] = [{ globalIdx: 7, wall: '2026-09-01T10:00:00.000Z' }];
    expect(resolveWallToGlobalIdx(one, '2026-09-01T09:00:00.000Z')).toMatchObject({
      kind: 'before_start',
    });
    expect(resolveWallToGlobalIdx(one, '2026-09-01T10:00:00.000Z')).toMatchObject({
      kind: 'after_end',
      globalIdx: 7,
    });
    expect(resolveWallToGlobalIdx(one, '2026-09-01T11:00:00.000Z')).toMatchObject({
      kind: 'after_end',
      globalIdx: 7,
    });
  });

  it('returns the same answer as a linear scan across every position', () => {
    // Guards the binary search's bias-up / hi = mid - 1 pairing, where an
    // off-by-one is silent.
    const many: TimedEvent[] = Array.from({ length: 50 }, (_, i) => ({
      globalIdx: i,
      wall: new Date(Date.UTC(2026, 8, 1, 10, 0, 0) + i * 60_000).toISOString(),
    }));
    for (let probe = -1; probe <= 51; probe++) {
      const target = new Date(Date.UTC(2026, 8, 1, 10, 0, 30) + probe * 60_000).toISOString();
      let expected = -1;
      for (const e of many) {
        if (e.wall <= target) expected = e.globalIdx;
      }
      const r = resolveWallToGlobalIdx(many, target);
      if (expected === -1) {
        expect(r.kind).toBe('before_start');
      } else {
        expect(r).toMatchObject({ globalIdx: expected });
      }
    }
  });

  it('never reports a negative gap', () => {
    const r = resolveWallToGlobalIdx(EVENTS, '2026-09-01T10:05:00.000Z');
    expect(r).toMatchObject({ gapMs: 0 });
  });
});

describe('localInputToIso', () => {
  it('returns null for an empty or unparseable value', () => {
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('not-a-date')).toBeNull();
  });

  it('reads the value as LOCAL time, matching what the picker showed', () => {
    // The datetime-local control has no zone, so the browser's zone is the one
    // a grader typing a course deadline means.
    const iso = localInputToIso('2026-09-01T23:59');
    expect(iso).toBe(new Date(2026, 8, 1, 23, 59, 0, 0).toISOString());
  });
});
