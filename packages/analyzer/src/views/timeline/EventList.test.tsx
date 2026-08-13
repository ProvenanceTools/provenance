/**
 * Tests for EventList and payloadSummary.
 *
 * - payloadSummary: parameterized per kind.
 * - Virtualized list renders bounded DOM nodes for 10k events.
 * - Click row → onSelect called.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EventList, payloadSummary } from './EventList.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<IndexedEvent>): IndexedEvent {
  return {
    sessionId: 'session-abc',
    seq: 0,
    globalIdx: 0,
    wall: '2026-01-01T00:00:00.000Z',
    t: 0,
    kind: 'doc.change',
    payload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// payloadSummary — parameterized
// ---------------------------------------------------------------------------

describe('payloadSummary', () => {
  it('doc.change: counts inserts from deltas', () => {
    const event = makeEvent({
      kind: 'doc.change',
      payload: {
        path: 'hw1.py',
        deltas: [
          {
            text: 'hello',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          },
          {
            text: ' world',
            range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
          },
        ],
      },
    });
    const result = payloadSummary(event);
    expect(result).toContain('insert');
  });

  it('doc.change: empty deltas returns empty string', () => {
    const event = makeEvent({
      kind: 'doc.change',
      payload: { path: 'hw1.py', deltas: [] },
    });
    expect(payloadSummary(event)).toBe('');
  });

  it('paste: shows length and content head', () => {
    const event = makeEvent({
      kind: 'paste',
      payload: {
        path: 'hw1.py',
        length: 500,
        content_head: 'def foo():',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        sha256: 'abc',
      },
    });
    const result = payloadSummary(event);
    expect(result).toContain('500 chars');
    expect(result).toContain('def foo():');
  });

  it('paste: shows length without head when no content_head', () => {
    const event = makeEvent({
      kind: 'paste',
      payload: {
        path: 'hw1.py',
        length: 100,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        sha256: 'abc',
      },
    });
    const result = payloadSummary(event);
    expect(result).toBe('100 chars');
  });

  it('paste: truncates content_head at 40 chars', () => {
    const event = makeEvent({
      kind: 'paste',
      payload: {
        path: 'hw1.py',
        length: 300,
        content_head: 'a'.repeat(50),
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        sha256: 'abc',
      },
    });
    const result = payloadSummary(event);
    expect(result).toContain('…');
    expect(result.length).toBeLessThan(100);
  });

  it('doc.save: shows path', () => {
    const event = makeEvent({
      kind: 'doc.save',
      payload: { path: 'hw1.py', sha256: 'abc123' },
    });
    expect(payloadSummary(event)).toBe('hw1.py');
  });

  it('fs.external_change: shows hash prefix and diff_size', () => {
    const event = makeEvent({
      kind: 'fs.external_change',
      payload: {
        path: 'hw1.py',
        old_hash: 'aabbccdd11223344',
        new_hash: 'eeff00112233aabb',
        diff_size: 42,
      },
    });
    const result = payloadSummary(event);
    expect(result).toContain('aabbccdd');
    expect(result).toContain('eeff0011');
    expect(result).toContain('diff_size 42');
  });

  it('terminal.command: shows command', () => {
    const event = makeEvent({
      kind: 'terminal.command',
      payload: { terminal_id: 'term-1', command: 'python hw1.py' },
    });
    expect(payloadSummary(event)).toBe('python hw1.py');
  });

  it('terminal.command: appends exit code when present', () => {
    const event = makeEvent({
      kind: 'terminal.command',
      payload: { terminal_id: 'term-1', command: 'python hw1.py', exit_code: 0 },
    });
    expect(payloadSummary(event)).toBe('python hw1.py · exit 0');
  });

  it('terminal.command: truncates long commands at 60 chars', () => {
    const cmd = 'python ' + 'x'.repeat(70);
    const event = makeEvent({
      kind: 'terminal.command',
      payload: { terminal_id: 'term-1', command: cmd },
    });
    const result = payloadSummary(event);
    expect(result.length).toBeLessThanOrEqual(63); // 60 + '…'
    expect(result).toContain('…');
  });

  it('session.start: shows session prefix', () => {
    const event = makeEvent({
      kind: 'session.start',
      payload: {
        session_id: 'abc123def456',
        format_version: '1.0',
        prev_session_id: null,
        assignment: { id: 'hw1', semester: 'sp26' },
        manifest_sig: 'sig',
        machine_id: 'test',
        vscode: { version: '1.0', commit: '', platform: 'darwin' },
        recorder: { version: '0.1', extension_id: 'provenance' },
        session_pubkey: 'key',
      },
    });
    const result = payloadSummary(event);
    expect(result).toContain('abc123de');
  });

  it('session.end: shows reason', () => {
    const event = makeEvent({
      kind: 'session.end',
      payload: { reason: 'window closed' },
    });
    expect(payloadSummary(event)).toBe('window closed');
  });

  it('paste.anomaly: shows intercepted count', () => {
    const event = makeEvent({
      kind: 'paste.anomaly',
      payload: { intercepted_count: 5, large_insert_count: 2 },
    });
    expect(payloadSummary(event)).toContain('5 intercepted');
  });

  it('git.event: shows operation', () => {
    const event = makeEvent({
      kind: 'git.event',
      payload: { operation: 'commit', commit_sha: 'abc' },
    });
    expect(payloadSummary(event)).toBe('commit');
  });

  it('session.heartbeat: returns empty string (default)', () => {
    const event = makeEvent({
      kind: 'session.heartbeat',
      payload: { focused: true, active_file: null, idle_since_ms: 0 },
    });
    // heartbeat is not in the switch — falls to default
    expect(payloadSummary(event)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// EventList rendering
// ---------------------------------------------------------------------------

describe('EventList', () => {
  function renderList(
    events: IndexedEvent[],
    {
      onSelect = vi.fn(),
      selectedKey = null,
      scrollToKey = null,
      onJumpToReplay,
    }: {
      onSelect?: (e: IndexedEvent) => void;
      selectedKey?: string | null;
      scrollToKey?: string | null;
      onJumpToReplay?: (e: IndexedEvent) => void;
    } = {},
  ) {
    // jsdom doesn't do layout, so we need a fixed height container.
    return render(
      <MemoryRouter>
        <div style={{ height: '600px', width: '800px' }}>
          <EventList
            events={events}
            onSelect={onSelect}
            selectedKey={selectedKey}
            scrollToKey={scrollToKey}
            onJumpToReplay={onJumpToReplay}
          />
        </div>
      </MemoryRouter>,
    );
  }

  it('calls onJumpToReplay with the event when the replay button is clicked', () => {
    const onJumpToReplay = vi.fn();
    const events = [makeEvent({ globalIdx: 0, seq: 0 })];
    renderList(events, { onJumpToReplay });

    fireEvent.click(screen.getByTestId('replay-btn-0'));

    expect(onJumpToReplay).toHaveBeenCalledTimes(1);
    expect(onJumpToReplay).toHaveBeenCalledWith(events[0]);
  });

  it('does not fire onSelect when the replay button is clicked', () => {
    const onSelect = vi.fn();
    const onJumpToReplay = vi.fn();
    renderList([makeEvent({ globalIdx: 0, seq: 0 })], { onSelect, onJumpToReplay });

    fireEvent.click(screen.getByTestId('replay-btn-0'));

    expect(onJumpToReplay).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not render the replay button when onJumpToReplay is omitted', () => {
    renderList([makeEvent({ globalIdx: 0, seq: 0 })]);
    expect(screen.queryByTestId('replay-btn-0')).toBeNull();
  });

  it('shows empty state when no events', () => {
    renderList([]);
    expect(screen.getByText('No events match the current filters.')).toBeInTheDocument();
  });

  it('renders rows for a small event list', () => {
    const events = Array.from({ length: 5 }, (_, i) => makeEvent({ globalIdx: i, seq: i }));
    renderList(events);
    // At least one row rendered
    expect(screen.getAllByTestId(/^event-row-/).length).toBeGreaterThan(0);
  });

  it('calls onSelect when a row is clicked', () => {
    const onSelect = vi.fn();
    const events = [makeEvent({ globalIdx: 0, seq: 0 })];
    renderList(events, { onSelect });
    const row = screen.getByTestId('event-row-0');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(events[0]);
  });

  it('calls onSelect on Enter key press', () => {
    const onSelect = vi.fn();
    const events = [makeEvent({ globalIdx: 0, seq: 0 })];
    renderList(events, { onSelect });
    const row = screen.getByTestId('event-row-0');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('marks selected row with bg-accent', () => {
    const events = [makeEvent({ globalIdx: 0, seq: 0, sessionId: 'sid' })];
    renderList(events, { selectedKey: 'sid:0' });
    const row = screen.getByTestId('event-row-0');
    expect(row.className).toContain('bg-accent');
  });

  it('virtualization: 10k events renders far fewer than 10k DOM nodes', () => {
    const events = Array.from({ length: 10000 }, (_, i) => makeEvent({ globalIdx: i, seq: i }));
    const { container } = renderList(events);
    const rows = container.querySelectorAll('[data-testid^="event-row-"]');
    // jsdom doesn't do layout so virtualizer may render 0 or overscan items;
    // the key assertion is < 200 (not all 10k).
    expect(rows.length).toBeLessThan(200);
  });

  it('shows session chip on each row', () => {
    const events = [makeEvent({ globalIdx: 0, seq: 0, sessionId: 'abc123def456' })];
    renderList(events);
    const chip = screen.getByTestId('session-chip-0');
    expect(chip.textContent).toBe('abc123'); // first 6 chars
  });
});
