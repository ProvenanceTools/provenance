/**
 * Regression test: the seam ticks' positioning context must never include
 * the ribbons block.
 *
 * WHY THIS EXISTS: seam ticks are `absolute top-1/2 -translate-y-1/2` inside
 * their nearest `position: relative` ancestor, and that centring math
 * resolves against THAT ancestor's height, not the slider's. An earlier
 * version of this file mounted `ContributorRibbons` as an in-flow sibling
 * inside the SAME `relative flex-1` div the seam ticks use as their
 * positioning context. That grows the div's height (slider height + ribbons
 * height), so with ribbons on, the ticks centre on the combined box and
 * visually slide off the slider track onto the first ribbon row. jsdom does
 * no real layout, so no percentage-based geometry assertion (`left`, `width`)
 * would ever catch this — it's a structural bug, not an arithmetic one. This
 * test instead asserts the structural fact that makes the bug possible in
 * the first place: the ribbons block must live outside the seam ticks'
 * positioned ancestor.
 *
 * Do not "fix" a future failure of this test by giving ribbons its own
 * `relative` wrapper INSIDE the ticks' ancestor — that reintroduces the same
 * shared-height trap under a different div.
 *
 * This file is separate from `TransportBar.test.tsx`, which stays untouched
 * per the "identical when ribbons are off" requirement — this test only
 * exercises the ribbons-on path.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TransportBar } from './TransportBar.js';
import type { Seam } from './bundle-clock.js';
import type { ReplayState } from './engine-core.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { RibbonRow } from './ContributorRibbons.js';

function ev(globalIdx: number, sessionId = 'sess-a'): IndexedEvent {
  return {
    globalIdx,
    sessionId,
    seq: globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind: 'doc.change',
    payload: null,
  };
}

function seamAt(atGlobalIdx: number, realGapMs: number): Seam {
  return {
    atGlobalIdx,
    prevSessionId: 'sess-a',
    nextSessionId: 'sess-b',
    realGapMs,
    collapsedGapMs: 5_000,
  };
}

function state(currentGlobalIdx: number): ReplayState {
  return {
    status: 'paused',
    currentGlobalIdx,
    speed: 1,
    sessionId: 'sess-a',
    virtualT: 0,
    skipIdle: false,
  };
}

describe('TransportBar — seam-tick positioning context, with ribbons on', () => {
  it('does not nest the contributor-ribbons block inside the seam ticks positioned ancestor', () => {
    const events = Array.from({ length: 21 }, (_, i) => ev(i));
    const ribbons: RibbonRow[] = [
      {
        key: 'alice',
        label: 'Alice',
        hue: 'rgba(59, 130, 246, 0.9)',
        soft: 'rgba(59, 130, 246, 0.16)',
        runs: [{ contributorKey: 'alice', startGlobalIdx: 0, endGlobalIdx: 20, idle: false }],
      },
    ];

    render(
      <TransportBar
        state={state(0)}
        events={events}
        seams={[seamAt(5, 60_000)]}
        ribbons={ribbons}
        onPlay={() => {}}
        onPause={() => {}}
        onStep={() => {}}
        onSeek={() => {}}
      />,
    );

    const tick = screen.getByTestId('seam-tick-5');
    const ribbonsBlock = screen.getByTestId('contributor-ribbons');

    // The tick's positioning context is its nearest `position: relative`
    // ancestor. That ancestor must size itself off the slider track alone —
    // if the ribbons block is inside it, the ancestor's height (and thus the
    // tick's top-1/2 centring) is contaminated by the ribbons' height too.
    const positioningContext = tick.closest('.relative');
    expect(positioningContext).not.toBeNull();
    expect(positioningContext).not.toContainElement(ribbonsBlock);
  });
});
