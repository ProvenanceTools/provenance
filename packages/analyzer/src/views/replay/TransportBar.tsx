/**
 * TransportBar — play / pause / step / scrub controls for the replay view.
 *
 * Layout:
 *   [Step -1] [Play/Pause] [Step +1]  [scrub slider]  [event label]
 *   (optional, only when `ribbons` is non-empty: contributor ribbons, stacked
 *   directly beneath the slider)
 *
 * Scrub throttle:
 *   The slider's onValueChange fires on every pixel of drag. To avoid
 *   triggering a full reconstruct per pixel, we throttle via
 *   requestAnimationFrame: only the most recent value in a given animation
 *   frame is applied. This is sufficient for Phase 13's performance budget.
 *
 * Keyboard:
 *   Space → play/pause (on the play/pause button; handled by native button focus).
 *   Arrow keys → handled by Radix Slider natively.
 *
 * Contributor ribbons (optional, additive):
 *   `ribbons` / `overlaps` are optional props consumed by split-replay-lanes
 *   (design `docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md`
 *   §5). When omitted or empty, this component's render is byte-for-byte what
 *   it was before those props existed — that is a hard requirement, not a
 *   preference, because every caller that doesn't yet pass ribbons (and every
 *   existing test) must see no difference.
 *
 *   The seam ticks are `absolute top-1/2 -translate-y-1/2` inside their
 *   nearest `position: relative` ancestor — that ancestor's HEIGHT is what
 *   `top-1/2` centres against, so that div must stay sized to the slider
 *   alone. `track` (the `Slider` plus the seam ticks) is therefore built once
 *   and mounted by two different wrappers below: with no ribbons, `track`
 *   sits in exactly today's `<div className="relative flex-1">` — untouched.
 *   With ribbons, `track` gets its OWN `relative` box (sized only by the
 *   slider) nested inside a `flex-1` column, and `ContributorRibbons` is a
 *   SIBLING of that box, not a child of it — so the ticks' positioning
 *   context never includes the ribbons' height, and the ribbons block still
 *   shares the slider's exact width via the shared `flex-1` column. (An
 *   earlier revision mounted the ribbons block as an in-flow child of the
 *   ticks' own `relative flex-1` div; that grew the div's height and the
 *   ticks slid off the track onto the first ribbon row — see the regression
 *   test in `TransportBar.ribbons.test.tsx`.)
 */

import { useCallback, useRef } from 'react';
import { Slider } from '@/components/ui/slider.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.js';
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react';
import type { ReplayState } from './engine-core.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import { formatGap, type Seam } from './bundle-clock.js';
import { ContributorRibbons, type RibbonRow } from './ContributorRibbons.js';
import type { OverlapInterval } from './contributor-activity.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type TransportBarProps = {
  state: ReplayState;
  /**
   * The whole bundle's events, in chronological order. Position in this array
   * IS the event's `globalIdx` (event-index.ts guarantees
   * `ordered[i].globalIdx === i`), so the slider needs no translation — the
   * session-scoped transport used to require one.
   */
  events: readonly IndexedEvent[];
  /** Session boundaries, rendered as ticks. Empty for a single-session bundle. */
  seams?: readonly Seam[];
  /**
   * One ribbon row per contributor, rendered beneath the slider. Omitted or
   * empty renders nothing — see the header comment's "Contributor ribbons".
   */
  ribbons?: readonly RibbonRow[];
  /** Overlap intervals for the ribbon band. Ignored when `ribbons` is empty. */
  overlaps?: readonly OverlapInterval[];
  onPlay(): void;
  onPause(): void;
  onStep(n: number): void;
  onSeek(globalIdx: number): void;
};

// ---------------------------------------------------------------------------
// TransportBar
// ---------------------------------------------------------------------------

export function TransportBar({
  state,
  events,
  seams = [],
  ribbons,
  overlaps,
  onPlay,
  onPause,
  onStep,
  onSeek,
}: TransportBarProps) {
  const eventCount = events.length;

  // Position and globalIdx are the same number over the whole-bundle stream.
  const sliderMax = Math.max(0, eventCount - 1);
  const currentPos = state.currentGlobalIdx;
  const sliderValue = Math.max(0, currentPos);

  // requestAnimationFrame throttle for scrub.
  const rafRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<number | null>(null);

  const handleSliderChange = useCallback(
    (values: number[]) => {
      const target = values[0] ?? 0;
      pendingSeekRef.current = target;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          if (pendingSeekRef.current !== null) {
            onSeek(pendingSeekRef.current);
            pendingSeekRef.current = null;
          }
        });
      }
    },
    [onSeek],
  );

  const isPlaying = state.status === 'playing';
  const atStart = currentPos < 0;
  const atEnd = currentPos >= sliderMax;

  // Display: "event N of M" or "— of M" before first event.
  const eventLabel =
    eventCount === 0
      ? 'No events'
      : currentPos < 0
        ? `— of ${eventCount}`
        : `${currentPos + 1} of ${eventCount}`;

  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="flex items-center gap-3 px-4 py-2 border-t bg-background"
        data-testid="transport-bar"
      >
        {/* Step back */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-center h-8 w-8 rounded hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => onStep(-1)}
              disabled={atStart}
              aria-label="Step back"
            >
              <SkipBack className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Step back (−1 event)</TooltipContent>
        </Tooltip>

        {/* Play / Pause */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-center h-8 w-8 rounded hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={isPlaying ? onPause : onPlay}
              disabled={eventCount === 0}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{isPlaying ? 'Pause' : 'Play'}</TooltipContent>
        </Tooltip>

        {/* Step forward */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-center h-8 w-8 rounded hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => onStep(1)}
              disabled={atEnd || eventCount === 0}
              aria-label="Step forward"
            >
              <SkipForward className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Step forward (+1 event)</TooltipContent>
        </Tooltip>

        {/* Scrub slider, with a tick per session boundary. `track` is shared
            by both wrappers below so the slider + seam ticks are defined
            once — see the header comment's "Contributor ribbons" for why the
            two wrappers exist at all (the ticks' positioning context must
            never include the ribbons' height). */}
        {(() => {
          const track = (
            <>
              <Slider
                min={0}
                max={sliderMax}
                step={1}
                value={[sliderValue]}
                onValueChange={handleSliderChange}
                disabled={eventCount === 0}
                aria-label="Scrub timeline"
              />
              {sliderMax > 0 &&
                seams.map((seam) => (
                  <span
                    key={seam.atGlobalIdx}
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2 bg-amber-500/70"
                    style={{ left: `${(seam.atGlobalIdx / sliderMax) * 100}%` }}
                    data-testid={`seam-tick-${seam.atGlobalIdx}`}
                    title={`Session boundary — ${formatGap(seam.realGapMs)} offline`}
                  />
                ))}
            </>
          );

          if (ribbons !== undefined && ribbons.length > 0) {
            return (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="relative w-full">{track}</div>
                <ContributorRibbons
                  rows={ribbons}
                  overlaps={overlaps ?? []}
                  sliderMax={sliderMax}
                />
              </div>
            );
          }
          return <div className="relative flex-1">{track}</div>;
        })()}

        {/* Event label */}
        <span className="text-xs text-muted-foreground tabular-nums min-w-[80px] text-right">
          {eventLabel}
        </span>
      </div>
    </TooltipProvider>
  );
}
