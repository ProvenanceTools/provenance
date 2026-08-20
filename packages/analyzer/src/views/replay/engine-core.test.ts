/**
 * engine-core.test.ts — pure engine state machine tests.
 *
 * Tests exercise advance-N-events-from-state-X → expected-state-Y pattern.
 * No React, no timers, no DOM.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEngine, MAX_IDLE_GAP_MS } from './engine-core.js';
import { buildBundleClock } from './bundle-clock.js';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';
import { buildObservedDag } from '@provenance/analysis-core/git/observed-dag.js';
import { buildEventOrdering } from '@provenance/analysis-core/order/happens-before.js';
import type { SessionContributor } from '@provenance/analysis-core/identity/types.js';
import type { ReconstructionScope } from '@provenance/analysis-core/index/reconstruct-segments.js';

// ---------------------------------------------------------------------------
// Minimal EventIndex builder for tests
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<IndexedEvent> & { kind: EventKind; globalIdx: number },
): IndexedEvent {
  const base: IndexedEvent = {
    sessionId: overrides.sessionId ?? 'sess1',
    seq: overrides.seq ?? overrides.globalIdx,
    globalIdx: overrides.globalIdx,
    wall: overrides.wall ?? '2026-01-01T00:00:00.000Z',
    t: overrides.t ?? overrides.globalIdx * 100,
    kind: overrides.kind,
    payload: overrides.payload ?? null,
  };
  if (overrides.file !== undefined) {
    base.file = overrides.file;
  }
  return base;
}

function makeDocChangeEvent(
  globalIdx: number,
  file: string,
  text: string,
  sessionId = 'sess1',
): IndexedEvent {
  return makeEvent({
    globalIdx,
    kind: 'doc.change' as const,
    file,
    sessionId,
    seq: globalIdx,
    payload: {
      deltas: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text,
        },
      ],
    },
  });
}

function buildIndex(events: IndexedEvent[]): EventIndex {
  const bySeq = new Map<string, IndexedEvent>();
  const byKind = new Map<EventKind, IndexedEvent[]>();
  const byFile = new Map<string, IndexedEvent[]>();
  const bySessionId = new Map<string, IndexedEvent[]>();
  const ordered = [...events].sort((a, b) => a.globalIdx - b.globalIdx);

  for (const e of ordered) {
    bySeq.set(`${e.sessionId}:${e.seq}`, e);

    const kindList = byKind.get(e.kind) ?? [];
    kindList.push(e);
    byKind.set(e.kind, kindList);

    if (e.file != null) {
      const fileList = byFile.get(e.file) ?? [];
      fileList.push(e);
      byFile.set(e.file, fileList);
    }

    const sessionList = bySessionId.get(e.sessionId) ?? [];
    sessionList.push(e);
    bySessionId.set(e.sessionId, sessionList);
  }

  return { bySeq, byKind, byFile, bySessionId, ordered };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createEngine', () => {
  describe('initial state', () => {
    it('starts paused at -1 with empty file states', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'x')];
      const index = buildIndex(events);
      const engine = createEngine(index);
      const state = engine.getState();

      expect(state.status).toBe('paused');
      expect(state.currentGlobalIdx).toBe(-1);
      expect(state.speed).toBe(1);
      expect(state.sessionId).toBe('sess1');
    });

    it('returns empty content for all files at -1', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'hello')];
      const index = buildIndex(events);
      const engine = createEngine(index);

      const fileStates = engine.getFileStates();
      expect(fileStates.get('hw.py')?.content).toBe('');
    });

    it('lists files under review', () => {
      const events = [
        makeDocChangeEvent(0, 'hw.py', 'a'),
        makeDocChangeEvent(1, 'utils.py', 'b'),
        makeDocChangeEvent(2, 'hw.py', 'c'),
      ];
      const index = buildIndex(events);
      const engine = createEngine(index);
      // files appear in order of first appearance
      expect(engine.getFiles()).toEqual(['hw.py', 'utils.py']);
    });

    it('returns 0 event count for an empty bundle', () => {
      const index = buildIndex([]);
      const engine = createEngine(index);
      expect(engine.eventCount()).toBe(0);
    });
  });

  describe('seek', () => {
    let engine: ReturnType<typeof createEngine>;

    beforeEach(() => {
      // 3 doc.change events inserting chars at position 0 in hw.py
      const events = [
        makeDocChangeEvent(0, 'hw.py', 'a'),
        makeDocChangeEvent(1, 'hw.py', 'b'),
        makeDocChangeEvent(2, 'hw.py', 'c'),
      ];
      const index = buildIndex(events);
      engine = createEngine(index);
    });

    it('seek(0) applies the first event (inclusive)', () => {
      const state = engine.seek(0);
      expect(state.currentGlobalIdx).toBe(0);
      const content = engine.getFileStates().get('hw.py')?.content;
      // event 0 inserts 'a' at pos 0 of empty string
      expect(content).toBe('a');
    });

    it('seek(1) applies events 0 and 1', () => {
      engine.seek(1);
      const content = engine.getFileStates().get('hw.py')?.content;
      // event 0 inserts 'a' at pos 0 → 'a'
      // event 1 inserts 'b' at pos 0 → 'ba'
      expect(content).toBe('ba');
    });

    it('seek(-1) resets to empty state', () => {
      engine.seek(2);
      engine.seek(-1);
      const state = engine.getState();
      expect(state.currentGlobalIdx).toBe(-1);
      expect(engine.getFileStates().get('hw.py')?.content).toBe('');
    });

    it('seek past end clamps to last event', () => {
      const state = engine.seek(999);
      expect(state.currentGlobalIdx).toBe(2); // events.length - 1
    });

    it('seek before -1 clamps to -1', () => {
      const state = engine.seek(-100);
      expect(state.currentGlobalIdx).toBe(-1);
    });

    it('status remains paused after seek', () => {
      const state = engine.seek(1);
      expect(state.status).toBe('paused');
    });
  });

  describe('step', () => {
    let engine: ReturnType<typeof createEngine>;

    beforeEach(() => {
      const events = [
        makeDocChangeEvent(0, 'hw.py', 'a'),
        makeDocChangeEvent(1, 'hw.py', 'b'),
        makeDocChangeEvent(2, 'hw.py', 'c'),
      ];
      const index = buildIndex(events);
      engine = createEngine(index);
    });

    it('step() with no arg advances by 1', () => {
      engine.step();
      expect(engine.getState().currentGlobalIdx).toBe(0);
    });

    it('step(2) advances by 2', () => {
      engine.step(2);
      expect(engine.getState().currentGlobalIdx).toBe(1);
    });

    it('step(-1) retreats by 1', () => {
      engine.seek(2);
      engine.step(-1);
      expect(engine.getState().currentGlobalIdx).toBe(1);
    });

    it('step clamped at end', () => {
      engine.seek(2);
      const state = engine.step(1);
      expect(state.currentGlobalIdx).toBe(2);
    });

    it('step clamped at start', () => {
      engine.seek(0);
      const state = engine.step(-1);
      expect(state.currentGlobalIdx).toBe(-1);
    });
  });

  describe('setPlaying / setPaused', () => {
    it('setPlaying sets status to playing', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'x')];
      const index = buildIndex(events);
      const engine = createEngine(index);
      const state = engine.setPlaying();
      expect(state.status).toBe('playing');
    });

    it('setPaused sets status to paused', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'x')];
      const index = buildIndex(events);
      const engine = createEngine(index);
      engine.setPlaying();
      const state = engine.setPaused();
      expect(state.status).toBe('paused');
    });

    it('seek does not change playing status', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'x'), makeDocChangeEvent(1, 'hw.py', 'y')];
      const index = buildIndex(events);
      const engine = createEngine(index);
      engine.setPlaying();
      const state = engine.seek(1);
      expect(state.status).toBe('playing');
    });
  });

  describe('setSpeed', () => {
    it('updates speed', () => {
      const index = buildIndex([makeDocChangeEvent(0, 'hw.py', 'x')]);
      const engine = createEngine(index);
      const state = engine.setSpeed(4);
      expect(state.speed).toBe(4);
    });
  });

  describe('eventCount', () => {
    it('returns total number of session events', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'a'), makeDocChangeEvent(1, 'hw.py', 'b')];
      const index = buildIndex(events);
      const engine = createEngine(index);
      expect(engine.eventCount()).toBe(2);
    });
  });

  describe('multi-file', () => {
    it('tracks file states independently', () => {
      const events = [
        makeDocChangeEvent(0, 'hw.py', 'hello'),
        makeDocChangeEvent(1, 'utils.py', 'world'),
        makeDocChangeEvent(2, 'hw.py', ' '),
      ];
      const index = buildIndex(events);
      const engine = createEngine(index);
      engine.seek(2);
      const fileStates = engine.getFileStates();
      // hw.py: event 0 inserts 'hello' then event 2 inserts ' ' at pos 0 → ' hello'
      expect(fileStates.get('hw.py')?.content).toBe(' hello');
      // utils.py: only event 1 → 'world'
      expect(fileStates.get('utils.py')?.content).toBe('world');
    });
  });

  describe('multi-session (whole-bundle engine)', () => {
    // Two sessions in one bundle. sess1 edits hw.py at globalIdx 0..2; sess2
    // edits a distinct file p2.py at globalIdx 3..5.
    //
    // The engine spans BOTH sessions. These tests previously asserted the
    // session-scoped behavior (files limited to the mounted session, stepping
    // from -1 landing on that session's first event, tick confined to it).
    // That behavior is intentionally changed, so they now assert the crossing.
    function buildTwoSessionIndex(): EventIndex {
      return buildIndex([
        makeDocChangeEvent(0, 'hw.py', 'a', 'sess1'),
        makeDocChangeEvent(1, 'hw.py', 'b', 'sess1'),
        makeDocChangeEvent(2, 'hw.py', 'c', 'sess1'),
        makeDocChangeEvent(3, 'p2.py', 'x', 'sess2'),
        makeDocChangeEvent(4, 'p2.py', 'y', 'sess2'),
        makeDocChangeEvent(5, 'p2.py', 'z', 'sess2'),
      ]);
    }

    it('lists files from every session, not just one', () => {
      const engine = createEngine(buildTwoSessionIndex());
      expect(engine.getFiles()).toEqual(['hw.py', 'p2.py']);
    });

    it('counts events across every session', () => {
      expect(createEngine(buildTwoSessionIndex()).eventCount()).toBe(6);
    });

    it('reports one seam for a two-session bundle', () => {
      const seams = createEngine(buildTwoSessionIndex()).seams();
      expect(seams).toHaveLength(1);
      expect(seams[0]).toMatchObject({
        atGlobalIdx: 3,
        prevSessionId: 'sess1',
        nextSessionId: 'sess2',
      });
    });

    it('seek to the last sess2 event reconstructs full sess2 content', () => {
      const engine = createEngine(buildTwoSessionIndex());
      const state = engine.seek(5);
      expect(state.currentGlobalIdx).toBe(5);
      // events 3,4,5 each insert one char at pos 0 → 'zyx'
      expect(engine.getFileStates().get('p2.py')?.content).toBe('zyx');
    });

    it('seek to the first sess2 event reconstructs only that event', () => {
      const engine = createEngine(buildTwoSessionIndex());
      const state = engine.seek(3);
      expect(state.currentGlobalIdx).toBe(3);
      expect(engine.getFileStates().get('p2.py')?.content).toBe('x');
    });

    it('keeps an earlier session’s file content visible from a later session', () => {
      // The whole point of the change: hw.py was last touched in sess1, but its
      // content must still be reconstructable while the playhead is in sess2.
      const engine = createEngine(buildTwoSessionIndex());
      engine.seek(5);
      expect(engine.getFileStates().get('hw.py')?.content).toBe('cba');
    });

    it('step from -1 advances to the first event of the BUNDLE', () => {
      const engine = createEngine(buildTwoSessionIndex());
      const state = engine.step(1);
      expect(state.currentGlobalIdx).toBe(0);
      expect(state.sessionId).toBe('sess1');
    });

    it('steps across the session boundary without stopping', () => {
      const engine = createEngine(buildTwoSessionIndex());
      engine.seek(2); // last event of sess1
      const state = engine.step(1);
      expect(state.currentGlobalIdx).toBe(3);
      expect(state.sessionId).toBe('sess2');
    });

    it('derives sessionId from the playhead position', () => {
      const engine = createEngine(buildTwoSessionIndex());
      expect(engine.seek(0).sessionId).toBe('sess1');
      expect(engine.seek(4).sessionId).toBe('sess2');
      // Back before the first event → first session.
      expect(engine.seek(-1).sessionId).toBe('sess1');
    });

    it('tick plays through the seam into the next session', () => {
      const engine = createEngine(buildTwoSessionIndex());
      // Within sess1, bundleT tracks t deltas: 0, 100, 200. The seam then adds a
      // collapsed gap, and sess2's own deltas follow. A large enough tick must
      // reach the end of the bundle rather than stalling at the boundary.
      const state = engine.tick(1_000_000);
      expect(state.currentGlobalIdx).toBe(5);
      expect(state.sessionId).toBe('sess2');
      expect(engine.getFileStates().get('p2.py')?.content).toBe('zyx');
    });

    it('endVirtualT spans the whole bundle including the seam gap', () => {
      const engine = createEngine(buildTwoSessionIndex());
      const { bundleT } = buildBundleClock(buildTwoSessionIndex().ordered);
      expect(engine.endVirtualT()).toBe(bundleT[bundleT.length - 1]);
      // Strictly greater than sess1's span alone, because the seam adds a gap.
      expect(engine.endVirtualT()).toBeGreaterThan(200);
    });
  });

  describe('empty session', () => {
    it('handles session with no events gracefully', () => {
      const index = buildIndex([]);
      const engine = createEngine(index);
      expect(engine.eventCount()).toBe(0);
      expect(engine.getFiles()).toEqual([]);
      const state = engine.step(1);
      expect(state.currentGlobalIdx).toBe(-1);
    });
  });

  describe('getFileStates returns a copy', () => {
    it('mutating returned map does not affect engine', () => {
      const events = [makeDocChangeEvent(0, 'hw.py', 'x')];
      const index = buildIndex(events);
      const engine = createEngine(index);
      engine.seek(0);
      const fileStates = engine.getFileStates();
      fileStates.delete('hw.py');
      // Engine's internal map still has hw.py
      expect(engine.getFileStates().has('hw.py')).toBe(true);
    });
  });

  describe('virtualT and tick (real-time playback)', () => {
    /**
     * Session with events at t=0, t=100, t=1000, t=5000.
     * makeEvent uses t = overrides.t ?? globalIdx * 100 by default,
     * so we override t explicitly here.
     */
    function makeTimedSession() {
      const events = [
        { ...makeDocChangeEvent(0, 'hw.py', 'a'), t: 0 },
        { ...makeDocChangeEvent(1, 'hw.py', 'b'), t: 100 },
        { ...makeDocChangeEvent(2, 'hw.py', 'c'), t: 1000 },
        { ...makeDocChangeEvent(3, 'hw.py', 'd'), t: 5000 },
      ];
      return { events, index: buildIndex(events) };
    }

    it('initializes virtualT to the first event t', () => {
      const { index } = makeTimedSession();
      const engine = createEngine(index);
      expect(engine.getState().virtualT).toBe(0);
    });

    it('endVirtualT returns the last event t', () => {
      const { index } = makeTimedSession();
      const engine = createEngine(index);
      expect(engine.endVirtualT()).toBe(5000);
    });

    it('endVirtualT returns 0 for empty session', () => {
      const index = buildIndex([]);
      const engine = createEngine(index);
      expect(engine.endVirtualT()).toBe(0);
    });

    it('tick(50): applies t=0 event (t=0 <= 50) but not t=100 event', () => {
      // Initial virtualT = first event's t = 0. tick(50) → newVirtualT = 50.
      // Events with t <= 50: t=0 (idx 0). t=100 is NOT included. t=1000, t=5000 neither.
      const { index } = makeTimedSession();
      const engine = createEngine(index);
      const state = engine.tick(50);
      expect(state.virtualT).toBe(50);
      expect(state.currentGlobalIdx).toBe(0); // t=0 event applied; t=100 not yet
    });

    it('tick(150) from start: applies events at t=0 and t=100, virtualT=150', () => {
      const { index } = makeTimedSession();
      const engine = createEngine(index);
      const state = engine.tick(150);
      expect(state.virtualT).toBe(150);
      expect(state.currentGlobalIdx).toBe(1); // events at t=0 and t=100 applied
    });

    it('tick(2000) from start: applies up to event at t=1000', () => {
      const { index } = makeTimedSession();
      const engine = createEngine(index);
      const state = engine.tick(2000);
      expect(state.virtualT).toBe(2000);
      expect(state.currentGlobalIdx).toBe(2); // event at t=1000 applied; t=5000 not yet
    });

    it('tick(10000) from start: applies all events, virtualT=10000', () => {
      const { index } = makeTimedSession();
      const engine = createEngine(index);
      const state = engine.tick(10000);
      expect(state.virtualT).toBe(10000);
      expect(state.currentGlobalIdx).toBe(3); // all events applied
    });

    it('idle gap: tick(10000) with events at t=0 and t=300000', () => {
      // 5-minute idle gap between first and second event.
      // Initial virtualT = 0 (first event's t). tick(10000) → newVirtualT = 10000.
      // t=0 event is applied (0 <= 10000). t=300000 is NOT reached.
      const events = [
        { ...makeDocChangeEvent(0, 'hw.py', 'a'), t: 0 },
        { ...makeDocChangeEvent(1, 'hw.py', 'b'), t: 300_000 },
      ];
      const index = buildIndex(events);
      const engine = createEngine(index);
      const state = engine.tick(10000);
      // virtualT advanced; t=0 event applied; t=300000 second event not reached.
      expect(state.virtualT).toBe(10000);
      expect(state.currentGlobalIdx).toBe(0); // first event applied, but not the second
    });

    it('idle gap: after first tick applies t=0, subsequent tick(10000) stays at idx=0', () => {
      // tick(0): newVirtualT = 0; t=0 event applied (0 <= 0).
      // tick(10000): newVirtualT = 10000; still before t=300000.
      const events = [
        { ...makeDocChangeEvent(0, 'hw.py', 'a'), t: 0 },
        { ...makeDocChangeEvent(1, 'hw.py', 'b'), t: 300_000 },
      ];
      const index = buildIndex(events);
      const engine = createEngine(index);
      // Apply t=0 event via tick(0)
      engine.tick(0);
      expect(engine.getState().currentGlobalIdx).toBe(0); // t=0 event applied
      // Then tick(10000): still before t=300000
      const state = engine.tick(10000);
      expect(state.virtualT).toBe(10000);
      expect(state.currentGlobalIdx).toBe(0); // second event not reached
    });

    it('tick does not advance past last event index', () => {
      const { index } = makeTimedSession();
      const engine = createEngine(index);
      engine.tick(10000); // apply all
      // Tick again: should not error or advance beyond last index.
      const state = engine.tick(5000);
      expect(state.currentGlobalIdx).toBe(3); // clamped at last
      expect(state.virtualT).toBe(15000); // virtualT continues advancing
    });

    it('seek syncs virtualT to the target event t', () => {
      const { index } = makeTimedSession();
      const engine = createEngine(index);
      engine.seek(2); // event at t=1000
      expect(engine.getState().virtualT).toBe(1000);
    });

    it('seek(-1) syncs virtualT to first event t', () => {
      const { index } = makeTimedSession();
      const engine = createEngine(index);
      engine.seek(3);
      engine.seek(-1);
      expect(engine.getState().virtualT).toBe(0); // reset to first event t
    });

    it('step syncs virtualT to the stepped-to event t', () => {
      const { index } = makeTimedSession();
      const engine = createEngine(index);
      engine.step(1); // → event 0 at t=0
      expect(engine.getState().virtualT).toBe(0);
      engine.step(1); // → event 1 at t=100
      expect(engine.getState().virtualT).toBe(100);
    });

    it('tick on empty session is a no-op', () => {
      const index = buildIndex([]);
      const engine = createEngine(index);
      const state = engine.tick(1000);
      expect(state.currentGlobalIdx).toBe(-1);
      expect(state.virtualT).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Idle-gap skipping
  // -------------------------------------------------------------------------
  describe('skipIdle (idle-gap compression)', () => {
    /** Events at t=0 and t=300000 — a 5-minute think pause between them. */
    function makeIdleGapIndex() {
      return buildIndex([
        { ...makeDocChangeEvent(0, 'hw.py', 'a'), t: 0 },
        { ...makeDocChangeEvent(1, 'hw.py', 'b'), t: 300_000 },
      ]);
    }

    it('defaults to off, preserving full-length idle playback', () => {
      const engine = createEngine(makeIdleGapIndex());
      expect(engine.getState().skipIdle).toBe(false);
      const state = engine.tick(10_000);
      expect(state.virtualT).toBe(10_000);
    });

    it('setSkipIdle(true) is reflected in state', () => {
      const engine = createEngine(makeIdleGapIndex());
      expect(engine.setSkipIdle(true).skipIdle).toBe(true);
      expect(engine.setSkipIdle(false).skipIdle).toBe(false);
    });

    it('compresses a long idle gap to MAX_IDLE_GAP_MS before the next event', () => {
      const engine = createEngine(makeIdleGapIndex());
      engine.setSkipIdle(true);
      // The first tick APPLIES the t=0 event, so it is paced normally: the
      // frame that reveals an event never compresses. virtualT = 10000.
      expect(engine.tick(10_000).virtualT).toBe(10_000);
      // The next frame finds no event in its window — that is the idle gap,
      // and 290s of dead air collapses to MAX_IDLE_GAP_MS of remaining pause.
      const state = engine.tick(16);
      expect(state.virtualT).toBe(300_000 - MAX_IDLE_GAP_MS);
      // The jump is pacing only — no event is applied early.
      expect(state.currentGlobalIdx).toBe(0);
    });

    it('still plays the residual pause, then reaches the event', () => {
      const engine = createEngine(makeIdleGapIndex());
      engine.setSkipIdle(true);
      engine.tick(10_000); // applies event 0
      engine.tick(16); // compresses the gap
      // A tick shorter than the residual pause does not reach the event.
      expect(engine.tick(MAX_IDLE_GAP_MS - 1).currentGlobalIdx).toBe(0);
      // One more closes it.
      expect(engine.tick(2).currentGlobalIdx).toBe(1);
    });

    it('leaves gaps shorter than MAX_IDLE_GAP_MS untouched', () => {
      const index = buildIndex([
        { ...makeDocChangeEvent(0, 'hw.py', 'a'), t: 0 },
        { ...makeDocChangeEvent(1, 'hw.py', 'b'), t: 3_000 },
      ]);
      const engine = createEngine(index);
      engine.setSkipIdle(true);
      const state = engine.tick(100);
      expect(state.virtualT).toBe(100);
    });

    it('never rewinds virtualT when already inside the residual window', () => {
      const engine = createEngine(makeIdleGapIndex());
      engine.setSkipIdle(true);
      // Land past nextT - MAX_IDLE_GAP_MS without reaching the event.
      const state = engine.tick(299_000);
      expect(state.virtualT).toBe(299_000);
      expect(state.currentGlobalIdx).toBe(0);
    });

    it('does not compress when events fall inside the tick window', () => {
      const engine = createEngine(makeIdleGapIndex());
      engine.setSkipIdle(true);
      const state = engine.tick(300_000);
      expect(state.virtualT).toBe(300_000);
      expect(state.currentGlobalIdx).toBe(1);
    });

    it('does not compress past the last event', () => {
      const engine = createEngine(makeIdleGapIndex());
      engine.setSkipIdle(true);
      engine.tick(300_000); // at the last event
      const state = engine.tick(10_000);
      expect(state.virtualT).toBe(310_000);
    });

    it('leaves collapsed inter-session seam gaps alone', () => {
      // bundle-clock already clamps seam gaps to <= SEAM_MAX_GAP_MS, which
      // equals MAX_IDLE_GAP_MS, so skipIdle finds nothing left to compress:
      // an overnight break between sessions still plays as its short pause.
      const index = buildIndex([
        { ...makeDocChangeEvent(0, 'hw.py', 'a', 'sess1'), t: 0, wall: '2026-01-01T00:00:00.000Z' },
        { ...makeDocChangeEvent(1, 'p2.py', 'x', 'sess2'), t: 0, wall: '2026-01-02T00:00:00.000Z' },
      ]);
      const engine = createEngine(index);
      const seam = engine.seams()[0];
      expect(seam).toBeDefined();
      expect(seam!.collapsedGapMs).toBe(MAX_IDLE_GAP_MS);

      engine.setSkipIdle(true);
      engine.tick(0); // apply the first event
      // The seam gap is exactly MAX_IDLE_GAP_MS, not greater, so no compression.
      const state = engine.tick(1);
      expect(state.virtualT).toBe(1);
      expect(state.currentGlobalIdx).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrency (Tier 2.2, spec §6 Rule 4)
// ---------------------------------------------------------------------------

describe('replay never linearizes concurrency', () => {
  function twoContributorScope(index: EventIndex): ReconstructionScope {
    const contributor = (sessionId: string, ref: string): SessionContributor => ({
      kind: 'attributed',
      sessionId,
      contributorKey: `attributed:2.0:course:c1:${ref}`,
      studentRef: ref,
      identityVersion: '2.0',
      scope: 'course',
      scopeId: 'c1',
      studentPubkey: 'pk',
      certWindow: { in_window: true },
      credentialWindow: { in_window: true },
    });
    const contributorBySession = new Map<string, SessionContributor>([
      ['sessA', contributor('sessA', 'alice')],
      ['sessB', contributor('sessB', 'bob')],
    ]);
    // No commit observations and no session link: the relation orders these two
    // neither way, which is the honest answer and exactly what replay must
    // refuse on.
    //
    // The events MUST be handed to the relation. An ordering built over empty
    // sessions answers `'unknown'` for every ref — "we have no record" — which
    // is a different fact from `'concurrent'` and would make this test pass for
    // the wrong reason.
    const source = {
      sessions: [...index.bySessionId].map(([sessionId, events]) => ({
        sessionId,
        events: events.map((e) => ({ seq: e.seq, kind: e.kind, data: e.payload })),
      })),
    } as unknown as Parameters<typeof buildObservedDag>[0];
    return {
      index,
      contributorBySession,
      ordering: buildEventOrdering({
        source,
        dag: buildObservedDag(source),
        contributors: contributorBySession,
      }),
    };
  }

  const divergent = () =>
    buildIndex([
      makeDocChangeEvent(0, 'hw.py', 'ALICE', 'sessA'),
      makeDocChangeEvent(1, 'hw.py', 'BOB', 'sessB'),
    ]);

  it('reports the file as ambiguous instead of picking a branch', () => {
    const index = divergent();
    const engine = createEngine(index, twoContributorScope(index));
    engine.seek(1);

    expect(engine.ambiguousFiles().get('hw.py')).toBe('concurrent');
  });

  it('serves empty content rather than one branch, or an interleaving of both', () => {
    const index = divergent();
    const engine = createEngine(index, twoContributorScope(index));
    engine.seek(1);

    const content = engine.getFileStates().get('hw.py')?.content ?? null;
    expect(content).toBe('');
    // The interleaving is what a wall-clock replay produces; it never existed.
    expect(content).not.toContain('ALICE');
    expect(content).not.toContain('BOB');
  });

  it('a single-contributor bundle reports nothing ambiguous', () => {
    const index = buildIndex([
      makeDocChangeEvent(0, 'hw.py', 'A', 'sess1'),
      makeDocChangeEvent(1, 'hw.py', 'B', 'sess1'),
    ]);
    const engine = createEngine(index);
    engine.seek(1);

    expect(engine.ambiguousFiles().size).toBe(0);
    expect(engine.getFileStates().get('hw.py')?.content).not.toBe('');
  });
});
