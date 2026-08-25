/**
 * ReplayLanes — the split-lane grid, one cell per §4 group, on one shared
 * playhead.
 *
 * Design spec: `docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md`
 * §4 ("The lane grid is a grid of files, keyed by who is in them") and §5's
 * lane-hue rule. Plan: `docs/superpowers/plans/2026-08-24-split-replay-lanes.md`
 * Phase 3.
 *
 * ## This component owns layout and chrome; it does NOT own the editor
 *
 * `ReplayLanes` calls `buildLaneLayout` (Phase 1) and lays the result out as a
 * CSS grid, renders lane headers, file strips, the converged caption, the
 * `concurrent`/`unknown` refusal panel, the idle message, and the rail. What
 * it never does is mount Monaco. That is `renderPane`'s job, supplied by the
 * caller (`ReplayInner`, Phase 4) — keeping Monaco out of this file is what
 * keeps this file testable with `@testing-library/react` and no Monaco mock.
 * A `single` or `converged` cell calls `renderPane({ cell, ownsCaret })`, once,
 * for its one shared content pane; `concurrent`, `unknown`, and `idle` cells
 * never call it — there is no single content pane to hand back for any of the
 * three (a refusal, a refusal, or nothing recorded yet).
 *
 * ## Lane hue vs. tone: two different jobs, never blurred
 *
 * A lane's hue (`contributor-palette.ts`) answers "whose content is this",
 * nothing more — it is assigned by first-appearance array position and cycles
 * through six hues chosen specifically to share no family with the badge
 * chrome below. A lane's TONE badge (`contributor-labels.ts`'s `TONE_CHROME`,
 * the same table `BranchedFileView` uses) answers "does this contributor's
 * identity carry a finding" — emerald/slate/amber. The two are rendered next
 * to each other in a `single` lane's header specifically so they never merge
 * into one signal: painting a lane amber because a lane happened to be
 * contributor #3 would make ordinary co-authorship read as a failed identity
 * check, which is the one thing `contributor-palette.ts`'s header explicitly
 * rules out. Hue never carries a verdict; tone never carries an identity.
 *
 * ## Promotion is local, unordered-preserving state — not a second sort
 *
 * `buildLaneLayout` lanes strictly the first `maxCodeLanes` of the contributor
 * array it is given (Phase 1, by design — lane order is never activity-
 * ranked). Promoting a rail contributor must not become a second ranking
 * either, so promotion is implemented as a REORDER, not a new cap-selection
 * rule: the contributors already laned keep their front position, promoted
 * rail members are spliced in immediately after them (in their own original
 * relative order), the rest of the rail keeps its original order after that,
 * and `maxCodeLanes` is widened by exactly the number promoted so nobody who
 * was already laned gets bumped back to the rail. `lane-groups.ts` itself is
 * untouched — every ordering guarantee it already tests for a plain array
 * still holds, because promotion only changes what array this component
 * builds before calling it.
 *
 * Promoted keys live in local `useState`, not the URL. Design §11 defers
 * URL persistence explicitly: a shared link always shows the first three
 * contributors' lanes. Worth revisiting if that surprises anyone in practice.
 */

import { useMemo, useState, type ReactNode } from 'react';
import type { Contributor } from '@provenance/analysis-core/identity/types.js';
import { buildLaneLayout, type LaneCell } from './lane-groups.js';
import type { AmbiguousReconstruction } from './engine-core.js';
import type { LaneHue } from './contributor-palette.js';
import { labelContributor, TONE_CHROME } from './contributor-labels.js';
import { AmbiguousFilePanel } from './BranchedFileView.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type ReplayLanesProps = {
  /** `BundleContributors.contributors` — stable, first-appearance order. */
  readonly contributors: readonly Contributor[];
  /** `activeFileAt(...)` per contributor key, at the current playhead. */
  readonly activeFileByContributor: ReadonlyMap<string, string | null>;
  /** The engine's `fileAmbiguity()` map, unmodified, keyed by file path. */
  readonly fileAmbiguity: ReadonlyMap<string, AmbiguousReconstruction>;
  /** `contributor-palette.ts`'s output — lane hue, indexed off array position. */
  readonly palette: ReadonlyMap<string, LaneHue>;
  /** Contributor whose session the playhead is inside, or null. Owns the caret. */
  readonly activeContributorKey: string | null;
  /** How many contributors, in order, get a code lane before promotion. */
  readonly maxCodeLanes?: number;
  /** Renders the one content pane a `single`/`converged` cell shows. No Monaco here. */
  readonly renderPane: (args: { cell: LaneCell; ownsCaret: boolean }) => ReactNode;
};

const DEFAULT_MAX_CODE_LANES = 3;

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/** Last path segment, for compact display — same trivial rule `FileTabs` uses. */
function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

/** Neutral fallback swatch for a key the palette has no entry for (defensive only —
 *  `palette` is expected to cover every contributor passed in). */
const FALLBACK_HUE = 'rgba(148, 163, 184, 0.9)'; // slate-400, deliberately outside the cycle

type ChipProps = {
  readonly contributorKey: string;
  readonly contributor: Contributor | undefined;
  readonly hue: LaneHue | undefined;
};

/**
 * Hue swatch + short label. This is the "contributor chip" the design calls
 * for in both the converged-cell header and the rail — one visual unit, used
 * both places, so a rail chip and a converged-header chip for the same person
 * always look identical.
 */
function ContributorChip({ contributorKey, contributor, hue }: ChipProps) {
  const label = contributor !== undefined ? labelContributor(contributor).short : contributorKey;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5"
      data-testid={`replay-lane-chip-${contributorKey}`}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: hue?.hue ?? FALLBACK_HUE }}
      />
      <span className="min-w-0 truncate text-xs font-medium text-foreground">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ReplayLanes
// ---------------------------------------------------------------------------

export function ReplayLanes({
  contributors,
  activeFileByContributor,
  fileAmbiguity,
  palette,
  activeContributorKey,
  maxCodeLanes = DEFAULT_MAX_CODE_LANES,
  renderPane,
}: ReplayLanesProps) {
  const contributorsByKey = useMemo(() => {
    const map = new Map<string, Contributor>();
    for (const c of contributors) map.set(c.key, c);
    return map;
  }, [contributors]);

  // Promotion state — see the module header, "Promotion is local,
  // order-preserving state". Never persisted to the URL in v1 (design §11).
  const [promotedKeys, setPromotedKeys] = useState<ReadonlySet<string>>(() => new Set());

  const layout = useMemo(() => {
    const laneCount = Math.max(0, Math.min(maxCodeLanes, contributors.length));
    const alreadyLaned = contributors.slice(0, laneCount);
    const rail = contributors.slice(laneCount);
    const promoted = rail.filter((c) => promotedKeys.has(c.key));
    const stillRail = rail.filter((c) => !promotedKeys.has(c.key));

    // Reorder so the already-laned prefix and the promoted members keep their
    // OWN relative order, then widen the cap by exactly how many were
    // promoted. `buildLaneLayout` is otherwise called exactly as Phase 1 left
    // it — no signature change, no new behaviour inside it.
    const reordered = [...alreadyLaned, ...promoted, ...stillRail];
    return buildLaneLayout(
      reordered,
      activeFileByContributor,
      fileAmbiguity,
      laneCount + promoted.length,
    );
  }, [contributors, activeFileByContributor, fileAmbiguity, maxCodeLanes, promotedKeys]);

  const laneColumnCount = contributors.length - layout.railKeys.length;

  function promote(key: string): void {
    setPromotedKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  function ownsCaret(cell: LaneCell): boolean {
    return activeContributorKey !== null && cell.contributorKeys.includes(activeContributorKey);
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="replay-lanes">
      <div
        className="grid min-h-0 flex-1 gap-2 overflow-hidden p-2"
        data-testid="replay-lanes-grid"
        style={{ gridTemplateColumns: `repeat(${Math.max(laneColumnCount, 1)}, minmax(0, 1fr))` }}
      >
        {layout.cells.map((cell) => {
          const span = cell.contributorKeys.length;
          const style = { gridColumn: `span ${span} / span ${span}` };
          const key = cell.contributorKeys.join('+');

          return (
            <div
              key={key}
              className="flex min-w-0 flex-col overflow-hidden rounded-md border bg-background"
              data-testid="replay-lane"
              data-kind={cell.kind}
              data-contributor-keys={cell.contributorKeys.join(',')}
              data-span={span}
              style={style}
            >
              <LaneBody
                cell={cell}
                contributorsByKey={contributorsByKey}
                palette={palette}
                ownsCaret={ownsCaret(cell)}
                renderPane={renderPane}
              />
            </div>
          );
        })}
      </div>

      {layout.railKeys.length > 0 && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-background px-2 py-1.5"
          data-testid="replay-rails"
          aria-label={`${layout.railKeys.length} more contributor${layout.railKeys.length === 1 ? '' : 's'}, off-lane`}
        >
          {layout.railKeys.map((railKey) => (
            <div
              key={railKey}
              className="flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-1"
              data-testid={`replay-rail-${railKey}`}
            >
              <ContributorChip
                contributorKey={railKey}
                contributor={contributorsByKey.get(railKey)}
                hue={palette.get(railKey)}
              />
              <button
                type="button"
                className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
                data-testid={`replay-rail-promote-${railKey}`}
                onClick={() => promote(railKey)}
              >
                Show lane
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LaneBody — the per-kind rendering the design table (§4) spells out
// ---------------------------------------------------------------------------

type LaneBodyProps = {
  readonly cell: LaneCell;
  readonly contributorsByKey: ReadonlyMap<string, Contributor>;
  readonly palette: ReadonlyMap<string, LaneHue>;
  readonly ownsCaret: boolean;
  readonly renderPane: (args: { cell: LaneCell; ownsCaret: boolean }) => ReactNode;
};

function LaneBody({ cell, contributorsByKey, palette, ownsCaret, renderPane }: LaneBodyProps) {
  switch (cell.kind) {
    // -----------------------------------------------------------------------
    // concurrent / unknown — the refusal surface. Not this component's copy:
    // it is `AmbiguousFilePanel`'s, unmodified, passed the engine's
    // `AmbiguousReconstruction` exactly as `lane-groups.ts` carried it
    // through — NOT filtered to this cell's `contributorKeys`. A concurrent
    // file's branch list belongs to the file, and can include a contributor
    // who edited earlier and has since moved to another file entirely (design
    // §4, last paragraph).
    // -----------------------------------------------------------------------
    case 'concurrent':
    case 'unknown':
      return <AmbiguousFilePanel filePath={cell.filePath} ambiguity={cell.ambiguity} />;

    // -----------------------------------------------------------------------
    // idle — neutral, not an error. This contributor's first event is later
    // than the playhead; there is nothing to blame and nothing to warn about.
    // -----------------------------------------------------------------------
    case 'idle': {
      const key = cell.contributorKeys[0];
      return (
        <>
          <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
            <ContributorChip
              contributorKey={key}
              contributor={contributorsByKey.get(key)}
              hue={palette.get(key)}
            />
          </header>
          <div
            className="flex min-h-0 flex-1 items-center justify-center px-3 py-6 text-center text-xs text-muted-foreground"
            data-testid="replay-lane-caption"
          >
            No recorded activity yet
          </div>
        </>
      );
    }

    // -----------------------------------------------------------------------
    // single — the ordinary lane: identity, tone, hue, the active file, and
    // the one content pane the caller supplies.
    // -----------------------------------------------------------------------
    case 'single': {
      const key = cell.contributorKeys[0];
      const contributor = contributorsByKey.get(key);
      const tone = contributor !== undefined ? labelContributor(contributor).tone : null;
      const chrome = tone !== null ? TONE_CHROME[tone] : null;

      return (
        <>
          <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
            <ContributorChip
              contributorKey={key}
              contributor={contributor}
              hue={palette.get(key)}
            />
            {chrome !== null && (
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${chrome.badge}`}
                data-testid="replay-lane-tone"
              >
                {chrome.label}
              </span>
            )}
          </header>
          <div
            className="shrink-0 truncate border-b px-3 py-1 text-[11px] text-muted-foreground"
            data-testid="replay-lane-file"
            title={cell.filePath}
          >
            {basename(cell.filePath)}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden" data-testid="replay-lane-pane">
            {renderPane({ cell, ownsCaret })}
          </div>
        </>
      );
    }

    // -----------------------------------------------------------------------
    // converged — the case §4 exists for. Two or more contributors are both,
    // right now, inside the SAME determinate file: one recorded truth, so one
    // pane, headed by every contributor's chip rather than one lane's worth
    // of identity chrome. No tone badge here deliberately — a converged
    // header names who is present, not any one of their individual identity
    // verdicts, and stacking N tone badges next to N chips would crowd a
    // caption whose entire point is "this is not N separate things".
    // -----------------------------------------------------------------------
    case 'converged':
      return (
        <>
          <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2">
            {cell.contributorKeys.map((key) => (
              <ContributorChip
                key={key}
                contributorKey={key}
                contributor={contributorsByKey.get(key)}
                hue={palette.get(key)}
              />
            ))}
          </header>
          <div
            className="shrink-0 truncate border-b px-3 py-1 text-[11px] text-muted-foreground"
            data-testid="replay-lane-file"
            title={cell.filePath}
          >
            {basename(cell.filePath)}
          </div>
          <p
            className="shrink-0 border-b px-3 py-1 text-[11px] text-muted-foreground"
            data-testid="replay-lane-caption"
          >
            One file, one recorded truth.
          </p>
          <div className="min-h-0 flex-1 overflow-hidden" data-testid="replay-lane-pane">
            {renderPane({ cell, ownsCaret })}
          </div>
        </>
      );
  }
}
