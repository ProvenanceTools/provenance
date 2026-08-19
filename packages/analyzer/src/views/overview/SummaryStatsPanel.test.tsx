/**
 * SummaryStatsPanel tests.
 *
 * Tests:
 * - Session count, assignment id, active/idle time rendered.
 * - File list rendered with file paths.
 * - Character activity numbers rendered.
 * - No-files case renders the empty message.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import { SummaryStatsPanel } from './SummaryStatsPanel.js';
import { makeMinimalBundle, makeMinimalIndex } from './test-fixtures.js';

function renderPanel(opts?: { emptyFiles?: boolean }) {
  const bundle = makeMinimalBundle();
  let index = makeMinimalIndex();

  if (opts?.emptyFiles) {
    index = { ...index, byFile: new Map(), ordered: [] } as typeof index;
  }

  render(
    <MemoryRouter>
      <SummaryStatsPanel index={index} bundle={bundle} />
    </MemoryRouter>,
  );
}

// Echoes the current location so navigation from clicks can be asserted.
function LocationDisplay() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

/** A minimal two-session bundle, chronological (sess-a before sess-b). */
function makeTwoSessionBundle(): Bundle {
  const base = makeMinimalBundle();
  const mkSession = (id: string, wall: string) => ({
    sessionId: id,
    events: [],
    meta: {} as never,
    slogSha256: 'a'.repeat(64),
    metaSha256: 'b'.repeat(64),
    firstEvent: {
      seq: 0,
      kind: 'session.start',
      t: 0,
      wall,
      hash: 'h',
      prevHash: '0'.repeat(64),
      data: { session_id: id },
    } as never,
  });
  return {
    ...base,
    sessions: [
      mkSession('sess-a', '2026-01-01T00:00:00.000Z'),
      mkSession('sess-b', '2026-01-01T02:00:00.000Z'),
    ],
  };
}

/** An index whose bySessionId carries per-session event counts. */
function makeTwoSessionIndex(): EventIndex {
  const index = makeMinimalIndex();
  return {
    ...index,
    bySessionId: new Map([
      ['sess-a', new Array(3).fill(null)],
      ['sess-b', new Array(2).fill(null)],
    ]),
  } as EventIndex;
}

function renderMultiSession() {
  render(
    <MemoryRouter>
      <SummaryStatsPanel index={makeTwoSessionIndex()} bundle={makeTwoSessionBundle()} />
      <LocationDisplay />
    </MemoryRouter>,
  );
}

describe('SummaryStatsPanel', () => {
  it('renders the panel', () => {
    renderPanel();
    expect(screen.getByTestId('summary-stats-panel')).toBeInTheDocument();
  });

  it('shows session count', () => {
    renderPanel();
    // bundle has 1 session
    expect(screen.getByTestId('stat-sessions').textContent).toBe('1');
  });

  it('shows assignment id', () => {
    renderPanel();
    expect(screen.getByTestId('stat-assignment').textContent).toBe('hw1');
  });

  it('shows active time', () => {
    renderPanel();
    // ordered has 4 events spanning 30s total (3 x 10s gaps, all < 60s threshold)
    expect(screen.getByTestId('stat-active-time')).toBeInTheDocument();
    // "30s" of active time (three 10s gaps)
    expect(screen.getByTestId('stat-active-time').textContent).toBe('30s');
  });

  it('shows idle time (0s when all gaps are small)', () => {
    renderPanel();
    expect(screen.getByTestId('stat-idle-time').textContent).toBe('0s');
  });

  it('renders the file list with hw1.py', () => {
    renderPanel();
    expect(screen.getByTestId('file-list')).toBeInTheDocument();
    expect(screen.getByTestId('file-row-hw1.py')).toBeInTheDocument();
  });

  it('shows chars-added stat (typed + pasted)', () => {
    renderPanel();
    // charsTyped from 'hello' = 5, charsPasted from paste event = 300, total = 305
    const el = screen.getByTestId('stat-chars-added');
    expect(el.textContent).toBe('305');
  });

  it('renders no-files message when index has no files', () => {
    renderPanel({ emptyFiles: true });
    expect(screen.getByTestId('no-files-message')).toBeInTheDocument();
    expect(screen.queryByTestId('file-list')).not.toBeInTheDocument();
  });

  describe('session list (multi-session bundles)', () => {
    it('does not render a session list for a single-session bundle', () => {
      renderPanel();
      expect(screen.queryByTestId('session-list')).not.toBeInTheDocument();
    });

    it('renders one clickable row per session with event counts', () => {
      renderMultiSession();
      expect(screen.getByTestId('session-list')).toBeInTheDocument();
      const rowA = screen.getByTestId('session-row-sess-a');
      const rowB = screen.getByTestId('session-row-sess-b');
      expect(rowA.textContent).toContain('Session 1');
      expect(rowA.textContent).toContain('3 events');
      expect(rowB.textContent).toContain('Session 2');
      expect(rowB.textContent).toContain('2 events');
    });

    it('clicking a session row navigates to its replay route', () => {
      renderMultiSession();
      fireEvent.click(screen.getByTestId('session-row-sess-b'));
      expect(screen.getByTestId('location').textContent).toBe('/local/replay/sess-b');
    });
  });
});
