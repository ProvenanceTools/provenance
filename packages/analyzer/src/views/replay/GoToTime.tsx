/**
 * GoToTime — move the replay playhead to a wall-clock instant.
 *
 * The motivating question is the one a grade dispute asks: "what did this file
 * look like at the deadline?" Scrubbing to a timestamp by hand is guesswork, so
 * this takes the instant directly and seeks to the last event at or before it.
 *
 * ## The resolution line is the point of this component
 *
 * Seeking is the easy half. The half that matters is saying HOW WELL the
 * request was met, because "the code at 23:59" is a claim the evidence often
 * cannot support: if the last recorded event was hours earlier, the playhead
 * shows a file from hours earlier, and a reader who is not told that will
 * reasonably believe the work was in that state at the deadline. So every
 * resolution renders its gap, and the two degenerate cases — the recording had
 * not started, the recording had already ended — say so in their own words
 * rather than being flattened into an ordinary hit.
 *
 * The input is a native `<input type="datetime-local">`: it has no timezone, so
 * it reads in the reader's own zone, which is the zone a course deadline is
 * written in.
 */

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button.js';
import { formatDuration, formatWall, formatWallTitle } from '@/lib/format.js';
import { localInputToIso, resolveWallToGlobalIdx } from './seek-to-time.js';
import type { SeekToTimeResult, TimedEvent } from './seek-to-time.js';

type GoToTimeProps = {
  /** Wall-ascending events for the whole bundle (`index.ordered`). */
  events: readonly TimedEvent[];
  /** Seek the playhead. Called only for a resolution that has a position. */
  onSeek(globalIdx: number): void;
};

/**
 * The sentence shown under the input for each resolution shape.
 *
 * Exported for tests: the wording IS the feature, so it is asserted directly
 * rather than through the rendered tree.
 */
export function resolutionMessage(result: SeekToTimeResult): string {
  switch (result.kind) {
    case 'empty':
      return 'This bundle has no events to seek through.';
    case 'before_start':
      return `Nothing had been recorded yet — the recording starts ${formatDuration(
        result.gapMs,
      )} later, at ${formatWall(result.firstWall)}.`;
    case 'found':
      return result.gapMs === 0
        ? `Exact match: an event at ${formatWall(result.wall)}.`
        : `Nearest event at or before that time: ${formatWall(result.wall)} — ${formatDuration(
            result.gapMs,
          )} earlier.`;
    case 'after_end':
      return result.gapMs === 0
        ? `That is the last recorded event (${formatWall(result.wall)}); nothing was recorded after it.`
        : `The recording ends ${formatDuration(result.gapMs)} before that time, at ${formatWall(
            result.wall,
          )}. Nothing was recorded afterwards.`;
  }
}

/** A resolution the reader should look at twice before trusting the pane. */
function isWeak(result: SeekToTimeResult): boolean {
  return result.kind === 'empty' || result.kind === 'before_start' || result.gapMs > 0;
}

export function GoToTime({ events, onSeek }: GoToTimeProps) {
  const [value, setValue] = useState('');
  const [result, setResult] = useState<SeekToTimeResult | null>(null);

  const handleGo = useCallback(() => {
    const iso = localInputToIso(value);
    if (iso === null) {
      setResult(null);
      return;
    }
    const resolved = resolveWallToGlobalIdx(events, iso);
    setResult(resolved);
    if (resolved.kind === 'found' || resolved.kind === 'after_end') {
      onSeek(resolved.globalIdx);
    }
  }, [value, events, onSeek]);

  return (
    <div className="flex flex-col gap-1" data-testid="go-to-time">
      <div className="flex items-center gap-2">
        <label htmlFor="go-to-time-input" className="text-xs text-muted-foreground">
          Go to time
        </label>
        <input
          id="go-to-time-input"
          type="datetime-local"
          step="1"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleGo();
            }
          }}
          className="h-7 rounded border bg-background px-2 font-mono text-xs"
          data-testid="go-to-time-input"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7"
          onClick={handleGo}
          disabled={localInputToIso(value) === null}
          data-testid="go-to-time-go"
        >
          Go
        </Button>
      </div>

      {result !== null && (
        <p
          role="status"
          data-testid="go-to-time-result"
          data-resolution={result.kind}
          title={
            result.kind === 'before_start'
              ? formatWallTitle(result.firstWall)
              : result.kind === 'empty'
                ? undefined
                : formatWallTitle(result.wall)
          }
          className={`text-xs ${isWeak(result) ? 'text-amber-700' : 'text-muted-foreground'}`}
        >
          {resolutionMessage(result)}
        </p>
      )}
    </div>
  );
}
