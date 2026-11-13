/**
 * HeuristicRow — one tunable heuristic on the Tuning page.
 *
 * Name (humanized, with the raw id beneath), a 0.0–2.0 weight slider with its
 * value, an on/off switch, and — only when the row differs from the active
 * config — a "modified" dot and a per-row reset button.
 *
 * The switch is a real checkbox (visually restyled), so it keeps native
 * keyboard and form semantics. Accessible names stay keyed to the raw id
 * (`large_paste`, `Enable large_paste`) so each control is uniquely named.
 */

import { RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { humanizeId, type FlagSetting } from './tuning-model.js';

export interface HeuristicRowProps {
  id: string;
  setting: FlagSetting;
  modified: boolean;
  /** Cross-submission: weight does not apply (cross flags feed no score). */
  weightDisabled?: boolean;
  /** Neither control has any effect (e.g. no corpus source exists). */
  inert?: boolean;
  onWeightChange: (weight: number) => void;
  onEnabledChange: (enabled: boolean) => void;
  onReset: () => void;
}

export function HeuristicRow({
  id,
  setting,
  modified,
  weightDisabled = false,
  inert = false,
  onWeightChange,
  onEnabledChange,
  onReset,
}: HeuristicRowProps) {
  const name = humanizeId(id);
  const labelId = `tuning-label-${id}`;
  const weightNoteId = `tuning-weight-note-${id}`;
  const inertNoteId = `tuning-inert-note-${id}`;
  const sliderDisabled = weightDisabled || inert;

  return (
    <div
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 px-5 py-3',
        'md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto]',
        modified && 'bg-berkeley-50',
      )}
      data-testid={`heuristic-row-${id}`}
    >
      {/* Name, with the "modified" dot */}
      <div className="flex min-w-0 items-center gap-2">
        {modified ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-berkeley-600"
            title="Modified"
            data-testid={`modified-${id}`}
          >
            <span className="sr-only">Modified</span>
          </span>
        ) : (
          <span aria-hidden="true" className="h-2 w-2 shrink-0" />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-900">{name}</p>
          <p id={labelId} className="truncate font-mono text-xs text-muted-foreground">
            {id}
          </p>
        </div>
      </div>

      {/* Switch + reset: right of the name on mobile, the last column on desktop. */}
      <div className="flex items-center justify-end gap-2 md:col-start-3 md:row-start-1">
        <label
          className={cn(
            'flex select-none items-center gap-2',
            inert ? 'cursor-not-allowed' : 'cursor-pointer',
          )}
        >
          <input
            type="checkbox"
            checked={setting.enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            className="peer sr-only"
            data-testid={`toggle-${id}`}
            aria-label={`Enable ${id}`}
            disabled={inert}
            aria-describedby={inert ? inertNoteId : undefined}
          />
          <span
            aria-hidden="true"
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-gray-300 transition-colors',
              'peer-checked:bg-berkeley-700 peer-disabled:opacity-50',
              'peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2',
              "after:absolute after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-transform after:content-['']",
              'peer-checked:after:translate-x-4',
            )}
          />
          <span className="w-6 text-xs text-muted-foreground">
            {setting.enabled ? 'On' : 'Off'}
          </span>
        </label>
        {/* Fixed-width slot so rows stay aligned whether or not reset shows. */}
        <div className="flex w-8 justify-end">
          {modified && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Reset ${name} to the active setting`}
              title="Reset to the active setting"
              data-testid={`reset-${id}`}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Weight: full width on mobile, the wide middle column on desktop. */}
      <div className="col-span-2 flex items-center gap-3 md:col-span-1 md:col-start-2 md:row-start-1">
        <input
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={setting.weight}
          onChange={(e) => onWeightChange(parseFloat(e.target.value))}
          disabled={sliderDisabled}
          className="h-1.5 flex-1 cursor-pointer accent-berkeley-700 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={`slider-${id}`}
          aria-labelledby={labelId}
          aria-valuetext={`${setting.weight.toFixed(1)} weight`}
          aria-describedby={weightDisabled ? weightNoteId : inert ? inertNoteId : undefined}
        />
        <span
          className={cn(
            'w-8 text-right font-mono text-sm tabular-nums',
            sliderDisabled ? 'text-muted-foreground' : 'text-gray-900',
          )}
        >
          {setting.weight.toFixed(1)}
        </span>
      </div>

      {weightDisabled && (
        <p
          id={weightNoteId}
          className="col-span-2 pl-4 text-xs text-muted-foreground md:col-start-2 md:pl-0"
          data-testid={`weight-note-${id}`}
        >
          Cross-submission flags are surfaced, not scored. Weight does not apply.
        </p>
      )}
      {inert && (
        <p
          id={inertNoteId}
          className="col-span-2 pl-4 text-xs text-muted-foreground md:col-start-2 md:pl-0"
          data-testid={`inert-note-${id}`}
        >
          No corpus source exists yet — this heuristic can never fire. Enable and weight have no
          effect.
        </p>
      )}
    </div>
  );
}
