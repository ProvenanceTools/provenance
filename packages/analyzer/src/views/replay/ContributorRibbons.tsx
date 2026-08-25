/**
 * ContributorRibbons — one horizontal activity row per contributor, rendered
 * under the scrub slider in `TransportBar`, plus an overlap band spanning
 * every row.
 *
 * Design spec: `docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md`
 * §5, "Ribbons, and one correction to the mock".
 *
 * ## Index space, matching the seam ticks exactly
 *
 * Runs and the overlap band are positioned with the SAME geometry
 * `TransportBar.tsx` already uses for its seam ticks:
 * `left% = startGlobalIdx / sliderMax * 100`, and width from the span between
 * `startGlobalIdx` and `endGlobalIdx`. This is not a coincidental match — it is
 * what lets a ribbon run visually line up with the scrubber position it
 * describes. `contributor-activity.ts` already produces runs in this index
 * space; this component does no unit conversion of its own.
 *
 * ## "both recording", never "unordered"
 *
 * The mock this feature started from labelled the overlap band "unordered —
 * 6 min". That claim is not available here and must never be reintroduced:
 * whether two contributors' edits are genuinely unordered is a per-FILE,
 * per-PLAYHEAD question answered by reconstruction (`reconstruct-segments.ts`'s
 * `resolve()`), not something derivable from two contributors merely having
 * activity in the same stretch of the timeline. What the overlap band actually
 * shows — two or more contributors' activity ENVELOPES intersecting — is a
 * coarser, honest, cheaply-known fact: they were both recording across this
 * stretch. So the band is labelled "both recording" / "N recording", and must
 * never say "unordered", "concurrent", or "conflict" — those are claims about
 * ordering that this data cannot back. See `contributor-activity.ts`'s header
 * for the full derivation.
 *
 * ## Minimum run width
 *
 * A run spanning exactly one event (`startGlobalIdx === endGlobalIdx`, which
 * happens routinely — see the "zero-width active segment" case in
 * `contributor-activity.ts`) computes to 0% width and would otherwise be
 * invisible. Every run and the overlap band carry a CSS `minWidth` floor so a
 * single-event run still renders as a visible sliver rather than vanishing.
 *
 * ## Accessibility
 *
 * The run spans and the overlap band are purely decorative restatements of
 * data available elsewhere (the event stream, the contributor list) — they
 * carry no information a screen reader user could act on individually, and
 * marking dozens of small spans as separately-announced content would be
 * noise. Each is `aria-hidden` + `pointer-events-none`, the same treatment
 * `TransportBar`'s seam ticks already use. The one meaningful summary lives on
 * the outer container's `aria-label`.
 */

import type { ActivityRun, OverlapInterval } from './contributor-activity.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type RibbonRow = {
  readonly key: string; // contributorKey
  readonly label: string; // short label, supplied by the caller
  readonly hue: string; // from contributor-palette — solid, active runs
  readonly soft: string; // from contributor-palette — translucent, idle runs
  readonly runs: readonly ActivityRun[];
};

export type ContributorRibbonsProps = {
  readonly rows: readonly RibbonRow[];
  readonly overlaps: readonly OverlapInterval[];
  readonly sliderMax: number;
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Same index-space math as TransportBar's seam ticks: value / sliderMax * 100. */
function pct(value: number, sliderMax: number): number {
  return (value / sliderMax) * 100;
}

/**
 * Rendered floor so a one-event-wide run (start === end, 0% computed width)
 * still shows as a visible sliver instead of collapsing to nothing.
 */
const MIN_RUN_WIDTH_PX = 3;

/** Neutral hatch — deliberately NOT any contributor's hue, since the band can
 *  cover more than two contributors and must not read as belonging to one. */
const OVERLAP_HATCH =
  'repeating-linear-gradient(45deg, rgba(87, 83, 78, 0.5) 0px, rgba(87, 83, 78, 0.5) 3px, transparent 3px, transparent 7px)';
const OVERLAP_WASH = 'rgba(87, 83, 78, 0.12)';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * "both recording" for exactly two contributors, "N recording" for more.
 * Never "unordered" / "concurrent" / "conflict" — see the module header.
 */
function overlapLabel(contributorCount: number): string {
  return contributorCount === 2 ? 'both recording' : `${contributorCount} recording`;
}

function containerLabel(rows: readonly RibbonRow[], overlaps: readonly OverlapInterval[]): string {
  const names = rows.map((row) => row.label).join(', ');
  const overlapNote =
    overlaps.length > 0
      ? `; ${overlaps.length} stretch${overlaps.length === 1 ? '' : 'es'} where more than one contributor was recording`
      : '';
  return `Contributor recording activity for ${names}${overlapNote}`;
}

// ---------------------------------------------------------------------------
// ContributorRibbons
// ---------------------------------------------------------------------------

export function ContributorRibbons({ rows, overlaps, sliderMax }: ContributorRibbonsProps) {
  // Matches the seam ticks' own guard: sliderMax <= 0 means the proportional
  // position math (value / sliderMax) would divide by zero.
  if (sliderMax <= 0) return null;

  return (
    <div
      data-testid="contributor-ribbons"
      aria-label={containerLabel(rows, overlaps)}
      className="relative mt-1 flex flex-col gap-0.5"
    >
      {rows.map((row) => (
        <div
          key={row.key}
          data-testid={`ribbon-row-${row.key}`}
          className="relative h-1.5"
          title={row.label}
        >
          {row.runs.map((run) => {
            const left = pct(run.startGlobalIdx, sliderMax);
            const width = pct(run.endGlobalIdx - run.startGlobalIdx, sliderMax);
            return (
              <span
                key={`${row.key}-${run.startGlobalIdx}`}
                aria-hidden="true"
                data-testid={`ribbon-run-${row.key}-${run.startGlobalIdx}`}
                className="pointer-events-none absolute top-0 h-full rounded-sm"
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  minWidth: `${MIN_RUN_WIDTH_PX}px`,
                  // idle runs render fainter (soft) than active ones (hue) so
                  // "recording but idle" reads differently from "actively
                  // editing" at a glance — see the module header.
                  backgroundColor: run.idle ? row.soft : row.hue,
                }}
              />
            );
          })}
        </div>
      ))}

      {overlaps.map((overlap) => {
        const left = pct(overlap.startGlobalIdx, sliderMax);
        const width = pct(overlap.endGlobalIdx - overlap.startGlobalIdx, sliderMax);
        return (
          <span
            key={overlap.startGlobalIdx}
            aria-hidden="true"
            data-testid={`ribbon-overlap-${overlap.startGlobalIdx}`}
            className="pointer-events-none absolute inset-y-0 rounded-sm"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              minWidth: `${MIN_RUN_WIDTH_PX}px`,
              backgroundColor: OVERLAP_WASH,
              backgroundImage: OVERLAP_HATCH,
            }}
            title={overlapLabel(overlap.contributorKeys.length)}
          />
        );
      })}
    </div>
  );
}
