/**
 * Tests for contributor-active-file.ts.
 */

import { describe, it, expect } from 'vitest';
import { activeFileAt } from './contributor-active-file.js';
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
