/**
 * Tests for TimelineInner — the route-agnostic events browser.
 *
 * The point of this component is that it works against ANY EventIndex, whether
 * built in-browser from a .zip (/local) or paged from the server API (the
 * submission Timeline tab). These tests build the index the server way, via
 * buildIndexFromEventRows, so they cover the path the server tab uses.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TimelineInner } from './TimelineInner.js';
import {
  buildIndexFromEventRows,
  type ServerEventRow,
} from '@provenance/analysis-core/index/build-index.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { HashedEnvelope } from '@provenance/log-core';
import type { SessionContributor } from '@provenance/analysis-core/identity/types.js';
import { buildObservedDag } from '@provenance/analysis-core/git/observed-dag.js';
import { buildEventOrdering } from '@provenance/analysis-core/order/happens-before.js';
import type { TimelineOrderScope } from './presentation-order.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Two sessions: `sess-a` (3 events) then `sess-b` (2 events), four hours later.
 * hw1.py is touched only in session a; hw2.py only in session b.
 */
function twoSessionRows(): ServerEventRow[] {
  return [
    {
      seq: 0,
      kind: 'session.start',
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      session_id: 'sess-a',
      payload: { session_id: 'sess-a' },
    },
    {
      seq: 1,
      kind: 'doc.change',
      t: 100,
      wall: '2026-01-01T00:00:00.100Z',
      session_id: 'sess-a',
      payload: { path: 'hw1.py', deltas: [] },
    },
    {
      seq: 2,
      kind: 'doc.save',
      t: 200,
      wall: '2026-01-01T00:00:00.200Z',
      session_id: 'sess-a',
      payload: { path: 'hw1.py' },
    },
    {
      seq: 0,
      kind: 'session.start',
      t: 0,
      wall: '2026-01-01T04:00:00.000Z',
      session_id: 'sess-b',
      payload: { session_id: 'sess-b' },
    },
    {
      seq: 1,
      kind: 'doc.change',
      t: 50,
      wall: '2026-01-01T04:00:00.050Z',
      session_id: 'sess-b',
      payload: { path: 'hw2.py', deltas: [] },
    },
  ];
}

/**
 * The same two sessions, numbered the way the events API actually numbers them:
 * `seq` is the global chronological index, unique across the whole submission.
 * sess-a holds seqs 0–2, sess-b holds 3–4.
 */
function globallyNumberedRows(): ServerEventRow[] {
  return twoSessionRows().map((row, i) => ({ ...row, seq: i }));
}

function renderInner(
  rows: ServerEventRow[] | null,
  onJumpToReplay?: (event: IndexedEvent) => void,
  initialEntries: string[] = ['/'],
  scope: TimelineOrderScope | null = null,
) {
  const index = rows === null ? null : buildIndexFromEventRows(rows);
  return {
    index,
    ...render(
      <MemoryRouter initialEntries={initialEntries}>
        <div style={{ height: '600px', width: '800px' }}>
          <TimelineInner index={index} onJumpToReplay={onJumpToReplay} scope={scope} />
        </div>
      </MemoryRouter>,
    ),
  };
}

// ---------------------------------------------------------------------------
// A concurrent two-contributor scope
//
// `twoSessionRows()` above is ONE student's two sessions four hours apart. This
// is two DIFFERENT verified contributors whose logs nothing connects — no
// `git.event`, so no shared commit, so `≺` orders no cross-session pair. It is
// the case the wall-clock list silently linearized.
// ---------------------------------------------------------------------------

const ALICE = 'sess-alice';
const BOB = 'sess-bob';

function envelope(seq: number, sessionId: string, wall: string): HashedEnvelope {
  return {
    seq,
    t: seq,
    wall,
    kind: seq === 0 ? 'session.start' : 'doc.change',
    data:
      seq === 0
        ? { format_version: '2.0', session_id: sessionId, prev_session_id: null }
        : { path: 'hw.py', deltas: [] },
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

/** Interleaved wall clocks — exactly what `buildIndex` turns into one sequence. */
const CONCURRENT_WALLS: Record<string, [string, string]> = {
  [ALICE]: ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z'],
  [BOB]: ['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:03.000Z'],
};

function concurrentRows(): ServerEventRow[] {
  const rows: ServerEventRow[] = [];
  for (const sessionId of [ALICE, BOB]) {
    const walls = CONCURRENT_WALLS[sessionId]!;
    rows.push({
      seq: 0,
      kind: 'session.start',
      t: 0,
      wall: walls[0],
      session_id: sessionId,
      payload: { session_id: sessionId },
    });
    rows.push({
      seq: 1,
      kind: 'doc.change',
      t: 1,
      wall: walls[1],
      session_id: sessionId,
      payload: { path: 'hw.py', deltas: [] },
    });
  }
  return rows;
}

function concurrentScope(): TimelineOrderScope {
  const sessions = [ALICE, BOB].map((sessionId) => ({
    sessionId,
    events: CONCURRENT_WALLS[sessionId]!.map((wall, seq) => envelope(seq, sessionId, wall)),
  }));
  const contributorBySession = new Map<string, SessionContributor>([
    [ALICE, attributed(ALICE, 'ref-alice')],
    [BOB, attributed(BOB, 'ref-bob')],
  ]);
  return {
    ordering: buildEventOrdering({
      source: { sessions },
      dag: buildObservedDag({ sessions }),
      contributors: contributorBySession,
    }),
    contributorBySession,
  };
}

/** The same two sessions, but both belonging to ONE student — so, solo. */
function soloScope(): TimelineOrderScope {
  return {
    ordering: null,
    contributorBySession: new Map<string, SessionContributor>([
      [ALICE, attributed(ALICE, 'ref-alice')],
      [BOB, attributed(BOB, 'ref-alice')],
    ]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TimelineInner', () => {
  it('counts every event across all sessions', () => {
    renderInner(twoSessionRows());
    expect(screen.getByTestId('event-count-label')).toHaveTextContent('5 events');
  });

  it('renders rows for events from both sessions', () => {
    renderInner(twoSessionRows());
    const rows = screen.getAllByTestId(/^event-row-/);
    expect(rows.length).toBe(5);
  });

  it('renders events from both sessions, not just the first', () => {
    // The session chip on each row carries sessionId.slice(0, 6). Asserting both
    // appear proves the list spans sessions. (The session *filter* dropdown is a
    // Radix menu that only mounts its options once opened, which needs real
    // pointer events; its contents are Radix's behavior, not this component's.)
    renderInner(twoSessionRows());
    const chips = screen.getAllByTestId(/^session-chip-/).map((el) => el.textContent);
    expect(new Set(chips)).toEqual(new Set(['sess-a', 'sess-b']));
  });

  it('invokes onJumpToReplay with the clicked event', () => {
    const onJumpToReplay = vi.fn();
    const { index } = renderInner(twoSessionRows(), onJumpToReplay);

    fireEvent.click(screen.getByTestId('replay-btn-0'));

    expect(onJumpToReplay).toHaveBeenCalledTimes(1);
    expect(onJumpToReplay).toHaveBeenCalledWith(index!.ordered[0]);
  });

  it('omits the replay button when no callback is supplied', () => {
    renderInner(twoSessionRows());
    expect(screen.queryByTestId('replay-btn-0')).toBeNull();
  });

  it('renders an empty timeline when the index is null', () => {
    renderInner(null);
    expect(screen.getByTestId('event-count-label')).toHaveTextContent('0 events');
  });

  it('selects the deep-linked event from ?seq=sessionId:seq', () => {
    renderInner(twoSessionRows(), undefined, ['/?seq=sess-b:1']);
    // EventDetail shows the selected event's session id.
    expect(screen.getByTestId('detail-session-id')).toHaveTextContent('sess-b');
  });

  // -------------------------------------------------------------------------
  // Bare global-seq deep link
  //
  // The API numbers events globally (`seq` on an events-endpoint row IS the
  // globalIdx), so a single number identifies an event across the whole
  // submission. The flag drawer relies on that: a flag's supporting_seqs name
  // events without naming sessions, and for a flag whose evidence spans
  // sessions there is no single session to name.
  //
  // twoSessionRows() numbers per-session (0,1,2 / 0,1) which the real API never
  // does, so these use a globally-numbered fixture.
  // -------------------------------------------------------------------------

  it('selects the deep-linked event from a bare ?seq=<globalIdx>', () => {
    renderInner(globallyNumberedRows(), undefined, ['/?seq=4']);
    expect(screen.getByTestId('detail-session-id')).toHaveTextContent('sess-b');
  });

  it('resolves a bare seq into the session that actually holds it', () => {
    // seq 1 lives in sess-a and seq 3 in sess-b. Resolving by number alone has
    // to land in the right one — picking the first session would be wrong for
    // every piece of evidence outside it.
    renderInner(globallyNumberedRows(), undefined, ['/?seq=1']);
    expect(screen.getByTestId('detail-session-id')).toHaveTextContent('sess-a');
  });

  it('ignores a bare ?seq= that names no event', () => {
    renderInner(globallyNumberedRows(), undefined, ['/?seq=999']);
    expect(screen.queryByTestId('detail-session-id')).toBeNull();
  });

  it('ignores a non-numeric ?seq=', () => {
    renderInner(globallyNumberedRows(), undefined, ['/?seq=not-a-number']);
    expect(screen.queryByTestId('detail-session-id')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Concurrency (spec §6 Rule 4 — presentation never linearizes concurrency)
  // -------------------------------------------------------------------------

  describe('concurrent contributors', () => {
    it('does not present two contributors as one asserted sequence', () => {
      renderInner(concurrentRows(), undefined, ['/'], concurrentScope());
      // The list still shows every event — refusing to order is not refusing to
      // show — but it no longer reads top-to-bottom as one history.
      expect(screen.getAllByTestId(/^event-row-/).length).toBe(4);
      expect(screen.getAllByTestId(/^order-break-/).length).toBeGreaterThan(0);
    });

    it('says so in plain language, above the list', () => {
      renderInner(concurrentRows(), undefined, ['/'], concurrentScope());
      const notice = screen.getByTestId('timeline-order-notice');
      expect(notice.textContent).toMatch(/not a single sequence/i);
      expect(notice.textContent).toMatch(/not comparable between machines/i);
    });

    it('calls the refusal concurrent, never unknown', () => {
      renderInner(concurrentRows(), undefined, ['/'], concurrentScope());
      for (const el of screen.getAllByTestId(/^order-break-/)) {
        expect(el.getAttribute('data-order-break-reason')).toBe('concurrent');
      }
    });

    it('marks a break only where the list crosses between contributors', () => {
      renderInner(concurrentRows(), undefined, ['/'], concurrentScope());
      const rows = screen.getAllByTestId(/^event-row-/);
      const chips = screen.getAllByTestId(/^session-chip-/).map((el) => el.textContent);
      const broken = new Set(
        screen
          .getAllByTestId(/^order-break-/)
          .map((el) => el.getAttribute('data-testid')!.replace('order-break-', '')),
      );
      for (let i = 1; i < rows.length; i++) {
        const crosses = chips[i] !== chips[i - 1];
        const globalIdx = rows[i]!.getAttribute('data-global-idx')!;
        expect(broken.has(globalIdx)).toBe(crosses);
      }
    });

    it('names both contributors on the break, so a grader knows whose is whose', () => {
      renderInner(concurrentRows(), undefined, ['/'], concurrentScope());
      const text = screen.getAllByTestId(/^order-break-/)[0]!.textContent ?? '';
      expect(text).toContain('ref-alic');
      expect(text).toContain('ref-bob');
    });

    it('leaves every row addressable by its own globalIdx', () => {
      // `globalIdx` is what `flags.supporting_seqs` persists and what the replay
      // deep-link carries. Re-ordering the DISPLAY must not move it.
      const onJumpToReplay = vi.fn();
      const { index } = renderInner(concurrentRows(), onJumpToReplay, ['/'], concurrentScope());
      for (const event of index!.ordered) {
        expect(screen.getByTestId(`event-row-${event.globalIdx}`)).toBeTruthy();
      }
      fireEvent.click(screen.getByTestId('replay-btn-3'));
      expect(onJumpToReplay).toHaveBeenCalledWith(index!.ordered.find((e) => e.globalIdx === 3));
    });
  });

  // -------------------------------------------------------------------------
  // The regression risk: every existing course is solo.
  // -------------------------------------------------------------------------

  describe('a solo scope renders exactly as it did before', () => {
    it('shows no break and no notice, with or without a scope', () => {
      for (const scope of [null, soloScope()]) {
        const { unmount } = renderInner(concurrentRows(), undefined, ['/'], scope);
        expect(screen.queryAllByTestId(/^order-break-/).length).toBe(0);
        expect(screen.queryByTestId('timeline-order-notice')).toBeNull();
        expect(screen.getAllByTestId(/^event-row-/).length).toBe(4);
        unmount();
      }
    });

    it('lists rows in exactly index.ordered order', () => {
      const { index } = renderInner(twoSessionRows(), undefined, ['/'], soloScope());
      const shown = screen
        .getAllByTestId(/^event-row-/)
        .map((el) => Number(el.getAttribute('data-global-idx')));
      expect(shown).toEqual(index!.ordered.map((e) => e.globalIdx));
    });
  });
});
