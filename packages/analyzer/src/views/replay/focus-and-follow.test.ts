/**
 * Tests for focus-and-follow.ts — pure helpers driving the replay
 * focus-away overlay and the auto-follow-edited-file behavior.
 */

import { describe, it, expect } from 'vitest';
import { currentFocusAwaySpan, currentEditedFile } from './focus-and-follow.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';

let _g = 0;
function ev(kind: EventKind, payload: unknown, file?: string, sessionId = 's1'): IndexedEvent {
  const globalIdx = _g++;
  return {
    sessionId,
    seq: globalIdx,
    globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind,
    payload,
    ...(file !== undefined ? { file } : {}),
  };
}

function reset(): void {
  _g = 0;
}

const focusLost = (reason?: string) =>
  ev('focus.change', reason !== undefined ? { gained: false, reason } : { gained: false });
const focusGained = () => ev('focus.change', { gained: true });
const docChange = (file: string) => ev('doc.change', { deltas: [] }, file);
const paste = (file: string) => ev('paste', { length: 10 }, file);
const docOpen = (file: string) => ev('doc.open', { sha256: 'x' }, file);
const docSave = (file: string) => ev('doc.save', { sha256: 'x' }, file);

// sessionId-carrying variants, for the `sessionIds` filter tests only —
// every event above stays on the default 's1' so the existing tests are
// unaffected.
const focusLostFor = (sessionId: string, reason?: string) =>
  ev(
    'focus.change',
    reason !== undefined ? { gained: false, reason } : { gained: false },
    undefined,
    sessionId,
  );
const focusGainedFor = (sessionId: string) =>
  ev('focus.change', { gained: true }, undefined, sessionId);
const docChangeFor = (sessionId: string, file: string) =>
  ev('doc.change', { deltas: [] }, file, sessionId);

describe('currentFocusAwaySpan', () => {
  it('returns null before the first event (playhead -1)', () => {
    reset();
    const events = [docChange('a.py'), focusLost()];
    expect(currentFocusAwaySpan(events, -1)).toBeNull();
  });

  it('reports away after a focus-lost with no later regain', () => {
    reset();
    const e = [docChange('a.py'), focusLost('window'), docChange('a.py')];
    // playhead on the focus-lost event
    expect(currentFocusAwaySpan(e, 1)).toEqual({ reason: 'window' });
    // playhead later, still no regain
    expect(currentFocusAwaySpan(e, 2)).toEqual({ reason: 'window' });
  });

  it('clears once the matching focus-gained is reached', () => {
    reset();
    const e = [focusLost('tab'), docChange('a.py'), focusGained(), docChange('a.py')];
    expect(currentFocusAwaySpan(e, 1)).toEqual({ reason: 'tab' });
    expect(currentFocusAwaySpan(e, 2)).toBeNull(); // on the regain event
    expect(currentFocusAwaySpan(e, 3)).toBeNull(); // after regain
  });

  it('persists to the end when focus is never regained', () => {
    reset();
    const e = [docChange('a.py'), focusLost(), docChange('a.py'), docChange('a.py')];
    expect(currentFocusAwaySpan(e, 3)).toEqual({ reason: null });
  });

  it('tracks the most recent toggle across multiple lost/regain cycles', () => {
    reset();
    const e = [focusLost('w1'), focusGained(), focusLost('w2')];
    expect(currentFocusAwaySpan(e, 0)).toEqual({ reason: 'w1' });
    expect(currentFocusAwaySpan(e, 1)).toBeNull();
    expect(currentFocusAwaySpan(e, 2)).toEqual({ reason: 'w2' });
  });

  it('uses null reason when the focus-lost event carries none', () => {
    reset();
    const e = [focusLost()];
    expect(currentFocusAwaySpan(e, 0)).toEqual({ reason: null });
  });

  it('ignores non-focus events', () => {
    reset();
    const e = [focusLost('window'), docChange('a.py'), paste('a.py')];
    expect(currentFocusAwaySpan(e, 2)).toEqual({ reason: 'window' });
  });
});

// ---------------------------------------------------------------------------
// `sessionIds` filter — split-lanes defect: this scan must NOT attribute one
// contributor's `focus.change` to a lane belonging to a different
// contributor. Mirrors `currentEditedFile`'s existing `sessionIds` shape.
// ---------------------------------------------------------------------------

describe('currentFocusAwaySpan — sessionIds filter', () => {
  it('omitted, behaves exactly as before (whole-stream scan, unaffected by session)', () => {
    reset();
    const e = [
      docChangeFor('sA', 'a.py'),
      focusLostFor('sB', 'window'),
      docChangeFor('sA', 'a.py'),
    ];
    expect(currentFocusAwaySpan(e, 2)).toEqual({ reason: 'window' });
  });

  it("ignores a DIFFERENT session's focus-lost — the false-attribution case", () => {
    reset();
    // sB tabs away; sA is still actively editing at the same playhead.
    const e = [
      docChangeFor('sA', 'a.py'),
      focusLostFor('sB', 'window'),
      docChangeFor('sA', 'a.py'),
    ];
    expect(currentFocusAwaySpan(e, 2, new Set(['sA']))).toBeNull();
    // The evidence is still there for the session it actually belongs to.
    expect(currentFocusAwaySpan(e, 2, new Set(['sB']))).toEqual({ reason: 'window' });
  });

  it("reports away from the filtered session's OWN focus-lost, ignoring a later event from elsewhere", () => {
    reset();
    const e = [focusLostFor('sA', 'tab'), docChangeFor('sB', 'b.py')];
    expect(currentFocusAwaySpan(e, 1, new Set(['sA']))).toEqual({ reason: 'tab' });
  });

  it("a DIFFERENT session's focus-gained does not clear the filtered session's away state", () => {
    reset();
    // sA tabs away and never itself regains; sB's own (unrelated) regain must
    // not be read as sA's.
    const e = [focusLostFor('sA', 'tab'), focusGainedFor('sB')];
    expect(currentFocusAwaySpan(e, 1, new Set(['sA']))).toEqual({ reason: 'tab' });
  });

  it('clears once the SAME session regains focus', () => {
    reset();
    const e = [focusLostFor('sA', 'tab'), focusGainedFor('sA')];
    expect(currentFocusAwaySpan(e, 1, new Set(['sA']))).toBeNull();
  });

  it('a session set with multiple ids still excludes sessions outside it', () => {
    reset();
    const e = [focusLostFor('sC', 'window')];
    expect(currentFocusAwaySpan(e, 0, new Set(['sA', 'sB']))).toBeNull();
  });
});

describe('currentEditedFile', () => {
  it('returns null before the first event', () => {
    reset();
    expect(currentEditedFile([docChange('a.py')], -1)).toBeNull();
  });

  it('returns the file of the most recent file-bearing event', () => {
    reset();
    const e = [docChange('a.py'), docChange('a.py'), docChange('b.py')];
    expect(currentEditedFile(e, 1)).toBe('a.py');
    expect(currentEditedFile(e, 2)).toBe('b.py');
  });

  it('skips non-file events (focus.change) and keeps the last edited file', () => {
    reset();
    const e = [docChange('a.py'), focusLost(), focusGained()];
    expect(currentEditedFile(e, 2)).toBe('a.py');
  });

  it('counts paste, doc.open and doc.save as file-bearing', () => {
    reset();
    const e = [docOpen('a.py'), paste('b.py'), docSave('c.py')];
    expect(currentEditedFile(e, 0)).toBe('a.py');
    expect(currentEditedFile(e, 1)).toBe('b.py');
    expect(currentEditedFile(e, 2)).toBe('c.py');
  });

  it('returns null when no file-bearing event has occurred yet', () => {
    reset();
    const e = [focusLost(), focusGained()];
    expect(currentEditedFile(e, 1)).toBeNull();
  });
});
