/**
 * The seek itself is covered by seek-to-time.test.ts. What these tests protect
 * is the WORDING and the refusal: a resolution that silently seeks somewhere
 * plausible, without telling the reader how far off the request it landed, is
 * the failure this component exists to prevent.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GoToTime, resolutionMessage } from './GoToTime.js';
import type { TimedEvent } from './seek-to-time.js';

/**
 * Walls built from LOCAL components, so the `datetime-local` strings the tests
 * type map onto them in whatever zone the suite runs in.
 */
function localWall(h: number, m: number): string {
  return new Date(2026, 8, 1, h, m, 0, 0).toISOString();
}

const EVENTS: TimedEvent[] = [
  { globalIdx: 0, wall: localWall(10, 0) },
  { globalIdx: 1, wall: localWall(10, 5) },
  { globalIdx: 2, wall: localWall(10, 20) },
];

function type(value: string) {
  fireEvent.change(screen.getByTestId('go-to-time-input'), { target: { value } });
}

describe('GoToTime', () => {
  it('keeps Go inert until the input holds a real instant', () => {
    render(<GoToTime events={EVENTS} onSeek={vi.fn()} />);
    expect(screen.getByTestId('go-to-time-go')).toBeDisabled();
    type('2026-09-01T10:07:00');
    expect(screen.getByTestId('go-to-time-go')).toBeEnabled();
  });

  it('seeks to the last event at or before the requested time', () => {
    const onSeek = vi.fn();
    render(<GoToTime events={EVENTS} onSeek={onSeek} />);
    type('2026-09-01T10:07:00');
    fireEvent.click(screen.getByTestId('go-to-time-go'));
    expect(onSeek).toHaveBeenCalledWith(1);
  });

  it('seeks on Enter as well as on the button', () => {
    const onSeek = vi.fn();
    render(<GoToTime events={EVENTS} onSeek={onSeek} />);
    type('2026-09-01T10:07:00');
    fireEvent.keyDown(screen.getByTestId('go-to-time-input'), { key: 'Enter' });
    expect(onSeek).toHaveBeenCalledWith(1);
  });

  it('states how far before the requested time the playhead actually landed', () => {
    render(<GoToTime events={EVENTS} onSeek={vi.fn()} />);
    type('2026-09-01T10:07:00');
    fireEvent.click(screen.getByTestId('go-to-time-go'));
    const msg = screen.getByTestId('go-to-time-result');
    expect(msg).toHaveAttribute('data-resolution', 'found');
    expect(msg.textContent).toContain('2m 0s earlier');
  });

  it('does not seek when the recording had not started yet', () => {
    const onSeek = vi.fn();
    render(<GoToTime events={EVENTS} onSeek={onSeek} />);
    type('2026-09-01T09:00:00');
    fireEvent.click(screen.getByTestId('go-to-time-go'));
    expect(onSeek).not.toHaveBeenCalled();
    expect(screen.getByTestId('go-to-time-result')).toHaveAttribute(
      'data-resolution',
      'before_start',
    );
  });

  it('says the recording had already ended when the target is past it', () => {
    const onSeek = vi.fn();
    render(<GoToTime events={EVENTS} onSeek={onSeek} />);
    type('2026-09-01T23:59:00');
    fireEvent.click(screen.getByTestId('go-to-time-go'));
    // It still seeks — the last event IS the answer to "what existed then" —
    // but the reader is told nothing was recorded afterwards.
    expect(onSeek).toHaveBeenCalledWith(2);
    const msg = screen.getByTestId('go-to-time-result');
    expect(msg).toHaveAttribute('data-resolution', 'after_end');
    expect(msg.textContent).toContain('Nothing was recorded afterwards');
  });
});

describe('resolutionMessage', () => {
  it('distinguishes an exact hit from a stale one', () => {
    expect(
      resolutionMessage({ kind: 'found', globalIdx: 1, wall: localWall(10, 5), gapMs: 0 }),
    ).toContain('Exact match');
    expect(
      resolutionMessage({ kind: 'found', globalIdx: 1, wall: localWall(10, 5), gapMs: 9_000_000 }),
    ).toContain('2h 30m earlier');
  });

  it('names the empty bundle rather than rendering a bare position', () => {
    expect(resolutionMessage({ kind: 'empty' })).toContain('no events');
  });
});
