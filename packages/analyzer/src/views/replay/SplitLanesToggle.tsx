/**
 * SplitLanesToggle — the on/off control for split replay lanes.
 *
 * Design spec: `docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md`
 * §3 ("Default state") and §7 ("Wiring").
 *
 * ## Renders nothing for a solo submission
 *
 * This mirrors `ContributorSelect`'s own rule, verbatim in spirit — see that
 * file's header comment: "Nothing to choose between. One contributor is the
 * overwhelmingly common case (every solo submission), and it renders exactly
 * as it did before this control existed — no empty select, no '1 of 1'."
 * A submission with ≤1 contributor has nothing to split into lanes, and a
 * toggle that is always visible but sometimes inert would misstate what
 * today's Replay tab can show. `null` is the ordinary case too, not an error:
 * the server-backed Replay tab builds its index from API rows and has no
 * parsed Bundle, so it has no contributor stamp at all (same reasoning as
 * `ContributorSelect`'s `contributors: BundleContributors | null` prop).
 *
 * ## Presentational only
 *
 * This component does not read or write the `?split=` URL param, and does
 * not know whether lanes are on by default. Design §7 assigns "gains `split`
 * state ... toggling always writes an explicit value" to `ReplayInner`
 * (Phase 4, not this file). `SplitLanesToggle` is a controlled toggle:
 * `enabled` + `onToggle`. Its only independent decision is whether to render
 * at all, which is a property of `contributors`, not of `enabled`.
 */

import type { BundleContributors } from '@provenance/analysis-core/identity/types.js';

export type SplitLanesToggleProps = {
  /** The bundle's contributor stamp, or `null` — see the module header. */
  readonly contributors: BundleContributors | null;
  /** Whether split lanes are currently on. */
  readonly enabled: boolean;
  /** Called with the NEXT state when the control is activated. */
  readonly onToggle: (next: boolean) => void;
};

export function SplitLanesToggle({ contributors, enabled, onToggle }: SplitLanesToggleProps) {
  const laneCount = contributors?.contributors.length ?? 0;

  // Mirrors ContributorSelect's `options.length <= 1` guard — see module header.
  if (laneCount <= 1) return null;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      data-testid="split-lanes-toggle"
      data-enabled={enabled}
      data-lane-count={laneCount}
      onClick={() => onToggle(!enabled)}
      className="shrink-0 rounded-md border px-2 py-1 text-xs text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {`Split lanes · ${laneCount}`}
    </button>
  );
}
