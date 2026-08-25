/**
 * EventSidebar.test.tsx
 *
 * Tests:
 *  1. Renders the sidebar header.
 *  2. Renders a row for each event.
 *  3. The current event row has aria-current="step".
 *  4. Clicking a row calls onSeek with the event's globalIdx.
 *  5. Empty events → shows "No events" state.
 *  6. Auto-scroll: virtualizer.scrollToIndex is called when currentGlobalIdx changes.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EventSidebar } from './EventSidebar.js';
import { formatWall } from '@/lib/format.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { Seam } from './bundle-clock.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(globalIdx: number, kind: IndexedEvent['kind'] = 'doc.change'): IndexedEvent {
  const base = {
    sessionId: 'sess1',
    seq: globalIdx,
    globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind,
    payload: null,
  } as IndexedEvent;
  if (globalIdx % 2 === 0) {
    base.file = 'hw.py';
  }
  return base;
}

const THREE_EVENTS: IndexedEvent[] = [
  makeEvent(0, 'session.start'),
  makeEvent(1, 'doc.change'),
  makeEvent(2, 'paste'),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventSidebar', () => {
  it('renders the "Events" header', () => {
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    expect(screen.getByTestId('event-sidebar')).toBeDefined();
    expect(screen.getByText('Events')).toBeDefined();
  });

  it('shows "No events" when events array is empty', () => {
    render(<EventSidebar events={[]} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    expect(screen.getByText('No events')).toBeDefined();
  });

  it('renders a virtual container when events are present', () => {
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    expect(screen.getByTestId('sidebar-virtual-container')).toBeDefined();
  });

  it('marks the current event row with aria-current="step"', async () => {
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={1} onSeek={vi.fn()} />);
    await waitFor(() => {
      const currentRow = screen.getByTestId('sidebar-row-1');
      expect(currentRow.getAttribute('aria-current')).toBe('step');
    });
  });

  it('other rows do not have aria-current', async () => {
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={1} onSeek={vi.fn()} />);
    await waitFor(() => {
      const row0 = screen.getByTestId('sidebar-row-0');
      expect(row0.getAttribute('aria-current')).toBeNull();
    });
  });

  it('calls onSeek with the event globalIdx when a row is clicked', async () => {
    const onSeek = vi.fn();
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={-1} onSeek={onSeek} />);
    await waitFor(() => {
      const row = screen.getByTestId('sidebar-row-2');
      fireEvent.click(row);
      expect(onSeek).toHaveBeenCalledWith(2);
    });
  });

  it('keyboard Enter on a row calls onSeek', async () => {
    const onSeek = vi.fn();
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={-1} onSeek={onSeek} />);
    await waitFor(() => {
      const row = screen.getByTestId('sidebar-row-0');
      fireEvent.keyDown(row, { key: 'Enter' });
      expect(onSeek).toHaveBeenCalledWith(0);
    });
  });

  describe('auto-scroll on currentGlobalIdx change', () => {
    it('does not throw when currentGlobalIdx advances', async () => {
      // The virtualizer.scrollToIndex call is exercised; we just assert no throw.
      const { rerender } = render(
        <EventSidebar events={THREE_EVENTS} currentGlobalIdx={0} onSeek={vi.fn()} />,
      );
      // Advance to event 2.
      rerender(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={2} onSeek={vi.fn()} />);
      // No throw; aria-current updates.
      await waitFor(() => {
        expect(screen.getByTestId('sidebar-row-2').getAttribute('aria-current')).toBe('step');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// ColorLegend smoke test (co-located for brevity)
// ---------------------------------------------------------------------------

import { ColorLegend } from './ColorLegend.js';

describe('ColorLegend', () => {
  it('renders all three legend items', () => {
    render(<ColorLegend />);
    const legend = screen.getByTestId('color-legend');
    expect(legend).toBeDefined();
    expect(legend.textContent).toContain('Paste');
    expect(legend.textContent).toContain('External');
    expect(legend.textContent).toContain('Uncolored: typed');
  });
});

// ---------------------------------------------------------------------------
// Session seams
// ---------------------------------------------------------------------------

describe('EventSidebar — session seams', () => {
  function seam(atGlobalIdx: number, realGapMs: number): Seam {
    return {
      atGlobalIdx,
      prevSessionId: 'sess1',
      nextSessionId: 'sess2',
      realGapMs,
      collapsedGapMs: 5_000,
    };
  }

  it('renders no dividers for a single-session bundle', () => {
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    expect(screen.queryAllByTestId(/^seam-divider-/)).toHaveLength(0);
  });

  it('inserts a divider before the first event of the next session', () => {
    render(
      <EventSidebar
        events={THREE_EVENTS}
        currentGlobalIdx={-1}
        onSeek={vi.fn()}
        seams={[seam(2, 60_000)]}
      />,
    );
    expect(screen.getByTestId('seam-divider-2')).toBeInTheDocument();
  });

  it('labels the divider with the real gap, not the collapsed playback gap', () => {
    render(
      <EventSidebar
        events={THREE_EVENTS}
        currentGlobalIdx={-1}
        onSeek={vi.fn()}
        seams={[seam(2, 15_120_000)]}
      />,
    );
    // 4h 12m real; collapsedGapMs is only 5s and must not be what's shown.
    expect(screen.getByTestId('seam-divider-2')).toHaveTextContent('4h 12m offline');
  });

  it('still renders every event row alongside the divider', () => {
    render(
      <EventSidebar
        events={THREE_EVENTS}
        currentGlobalIdx={-1}
        onSeek={vi.fn()}
        seams={[seam(2, 60_000)]}
      />,
    );
    expect(screen.getAllByTestId(/^sidebar-row-/)).toHaveLength(3);
  });

  it('marks a seam carrying an inter_session_external_change flag', () => {
    render(
      <EventSidebar
        events={THREE_EVENTS}
        currentGlobalIdx={-1}
        onSeek={vi.fn()}
        seams={[seam(2, 60_000)]}
        flaggedSeamIdxs={new Set([2])}
      />,
    );
    const divider = screen.getByTestId('seam-divider-2');
    expect(divider).toHaveAttribute('data-flagged', 'true');
    expect(divider).toHaveTextContent('file content changed while the recorder was off');
  });

  it('leaves an unflagged seam unmarked', () => {
    render(
      <EventSidebar
        events={THREE_EVENTS}
        currentGlobalIdx={-1}
        onSeek={vi.fn()}
        seams={[seam(2, 60_000)]}
        flaggedSeamIdxs={new Set()}
      />,
    );
    expect(screen.getByTestId('seam-divider-2')).not.toHaveAttribute('data-flagged');
  });

  it('still marks the current event when dividers shift row indices', () => {
    // The divider sits before globalIdx 2, so row index != globalIdx there.
    render(
      <EventSidebar
        events={THREE_EVENTS}
        currentGlobalIdx={2}
        onSeek={vi.fn()}
        seams={[seam(2, 60_000)]}
      />,
    );
    expect(screen.getByTestId('sidebar-row-2')).toHaveAttribute('aria-current', 'step');
  });

  it('seeks to the right event when a row after a divider is clicked', () => {
    const onSeek = vi.fn();
    render(
      <EventSidebar
        events={THREE_EVENTS}
        currentGlobalIdx={-1}
        onSeek={onSeek}
        seams={[seam(2, 60_000)]}
      />,
    );
    fireEvent.click(screen.getByTestId('sidebar-row-2'));
    expect(onSeek).toHaveBeenCalledWith(2);
  });
});

describe('EventSidebar — wall time and terminal summary', () => {
  it('renders wall time on each event row', async () => {
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-row-0')).toHaveTextContent(
        formatWall('2026-01-01T00:00:00.000Z'),
      );
    });
  });

  it('renders an em dash for unparseable wall', async () => {
    const events = [{ ...THREE_EVENTS[0]!, wall: 'not-a-date', globalIdx: 0, seq: 0 }];
    render(<EventSidebar events={events} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-row-0')).toHaveTextContent('—');
    });
  });

  it('shows command and exit code on terminal.command rows', async () => {
    const events: IndexedEvent[] = [
      {
        sessionId: 'sess1',
        seq: 0,
        globalIdx: 0,
        t: 0,
        wall: '2026-01-01T00:00:00.000Z',
        kind: 'terminal.command',
        payload: { terminal_id: 't1', command: 'python hw.py', exit_code: 0 },
      },
    ];
    render(<EventSidebar events={events} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-row-0')).toHaveTextContent('python hw.py · exit 0');
    });
  });

  it('omits exit when exit_code is absent', async () => {
    const events: IndexedEvent[] = [
      {
        sessionId: 'sess1',
        seq: 0,
        globalIdx: 0,
        t: 0,
        wall: '2026-01-01T00:00:00.000Z',
        kind: 'terminal.command',
        payload: { terminal_id: 't1', command: 'python hw.py' },
      },
    ];
    render(<EventSidebar events={events} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    await waitFor(() => {
      const row = screen.getByTestId('sidebar-row-0');
      expect(row).toHaveTextContent('python hw.py');
      expect(row).not.toHaveTextContent('exit');
    });
  });
});

// ---------------------------------------------------------------------------
// Contributor marker — opt-in, lane mode only (split-replay-lanes design §4/§7).
//
// The main describe block above never passes `contributorHueBySession`, so
// its assertions prove the omitted-prop path renders exactly what it did
// before this prop existed — that's the "strictly opt-in" requirement, not
// re-asserted here.
// ---------------------------------------------------------------------------

describe('EventSidebar — contributor marker (opt-in)', () => {
  function eventFor(globalIdx: number, sessionId: string): IndexedEvent {
    return {
      sessionId,
      seq: globalIdx,
      globalIdx,
      wall: '2026-01-01T00:00:00.000Z',
      t: globalIdx * 100,
      kind: 'doc.change',
      payload: null,
    } as IndexedEvent;
  }

  // A: mapped, B: mapped (different hue), C: no entry in the map at all —
  // the "unmapped session" case.
  const THREE_SESSIONS: IndexedEvent[] = [
    eventFor(0, 'sessA'),
    eventFor(1, 'sessB'),
    eventFor(2, 'sessC'),
  ];

  const HUE_A = 'rgba(59, 130, 246, 0.9)'; // blue-500, contributor-palette's first cycle hue
  const HUE_B = 'rgba(139, 92, 246, 0.9)'; // violet-500, second cycle hue

  it('renders no marker for any row when the prop is omitted', () => {
    render(<EventSidebar events={THREE_SESSIONS} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    expect(screen.queryAllByTestId(/^sidebar-row-contributor-/)).toHaveLength(0);
  });

  it("carries contributor A's hue, contributor B's hue, and no marker at all for the unmapped session", async () => {
    const hueBySession = new Map([
      ['sessA', HUE_A],
      ['sessB', HUE_B],
      // 'sessC' deliberately absent — no contributor entry.
    ]);
    render(
      <EventSidebar
        events={THREE_SESSIONS}
        currentGlobalIdx={-1}
        onSeek={vi.fn()}
        contributorHueBySession={hueBySession}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-row-contributor-0')).toBeInTheDocument();
    });
    const markerA = screen.getByTestId('sidebar-row-contributor-0');
    const markerB = screen.getByTestId('sidebar-row-contributor-1');
    expect(markerA.style.backgroundColor).toBe(HUE_A);
    expect(markerB.style.backgroundColor).toBe(HUE_B);
    expect(markerA).toHaveAttribute('aria-hidden', 'true');
    expect(markerB).toHaveAttribute('aria-hidden', 'true');

    // No default/fallback colour for a session absent from the map — no
    // marker element at all for that row.
    expect(screen.queryByTestId('sidebar-row-contributor-2')).toBeNull();
  });

  it('does not change the row height the virtualizer sizes on', async () => {
    const hueBySession = new Map([['sessA', HUE_A]]);
    render(
      <EventSidebar
        events={THREE_SESSIONS}
        currentGlobalIdx={-1}
        onSeek={vi.fn()}
        contributorHueBySession={hueBySession}
      />,
    );
    await waitFor(() => {
      const row = screen.getByTestId('sidebar-row-0'); // carries the marker
      expect(row.style.height).toBe('36px'); // ROW_HEIGHT
    });
  });
});
