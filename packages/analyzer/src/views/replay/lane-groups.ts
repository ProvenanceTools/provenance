/**
 * lane-groups — the §4 grouping: contributors + each one's active file +
 * `fileAmbiguity` → the ordered list of cells the lane grid renders.
 *
 * Design spec: `docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md`
 * §4, "The lane grid is a grid of files, keyed by who is in them".
 *
 * ## Keyed by file, not by person
 *
 * Two contributors who are both, right now, in the same DETERMINATE file do
 * not get two panes of identical content — that would visually claim two
 * versions where there is only ever one recorded truth. They get ONE
 * `converged` cell, headed by both their chips. This is why the grouping pass
 * below buckets contributors by `activeFile` first and decides a cell KIND from
 * the bucket, rather than building one cell per contributor and merging later.
 *
 * `null` (no activity yet) is the one active-file value that is NEVER grouped:
 * two contributors who have each not started yet are not "together" in any
 * file, so each gets its own `idle` cell even though they'd bucket identically
 * on a naive key.
 *
 * ## `fileAmbiguity` overrides the file-population-count kind
 *
 * A bucket's PRELIMINARY kind is `single` (one contributor) or `converged`
 * (two or more) — but if that bucket's file path has an entry in
 * `fileAmbiguity`, the cell becomes `concurrent` or `unknown` instead, no
 * matter how many contributors are in the group. A `concurrent`/`unknown`
 * file's branch list belongs to the FILE (from the engine), not to the group of
 * contributors currently active in it — a contributor who edited earlier and
 * has since moved to another file can still have a live, unordered branch here.
 * This module does not filter that list; it passes the engine's
 * `AmbiguousReconstruction` through unchanged, exactly as `BranchedFileView`
 * already expects it.
 *
 * ## Rails, and why column order can move
 *
 * Only the first `maxCodeLanes` contributors (by `BundleContributors.contributors`
 * order — first-appearance, never re-sorted, per design §3) get a cell at all;
 * the rest become `railKeys` in that same order, dropping nothing.
 *
 * Among the laned contributors, cells are ordered by the LOWEST contributor
 * index in their group — so a cell's screen position is "where its earliest
 * member would have appeared alone". When two contributors converge on one
 * file, the LATER one's column collapses into the earlier one's position; the
 * later contributor's individual slot in the row disappears for as long as the
 * convergence lasts. That is intended, not a bug: the grid has exactly as many
 * cells as there are distinct (file-or-idle) states among the laned
 * contributors, not one cell per contributor.
 */

import type { AmbiguousReconstruction } from './engine-core.js';

export type LaneCell =
  | { kind: 'idle'; contributorKeys: readonly [string]; filePath: null }
  | { kind: 'single'; contributorKeys: readonly [string]; filePath: string }
  | { kind: 'converged'; contributorKeys: readonly string[]; filePath: string }
  | {
      kind: 'concurrent';
      contributorKeys: readonly string[];
      filePath: string;
      ambiguity: AmbiguousReconstruction;
    }
  | {
      kind: 'unknown';
      contributorKeys: readonly string[];
      filePath: string;
      ambiguity: AmbiguousReconstruction;
    };

export type LaneLayout = {
  readonly cells: readonly LaneCell[];
  readonly railKeys: readonly string[];
};

type Group = {
  readonly firstIndex: number;
  readonly filePath: string | null;
  readonly keys: string[];
};

/**
 * Build the lane layout for one playhead position.
 *
 * @param contributors             `BundleContributors.contributors` order —
 *                                  first appearance, never sorted here.
 * @param activeFileByContributor  `activeFileAt(...)`'s result per contributor
 *                                  key (`contributor-active-file.ts`). A
 *                                  contributor missing from the map is treated
 *                                  as `null` (no activity yet).
 * @param fileAmbiguity            The engine's `fileAmbiguity()` map, keyed by
 *                                  file path — unmodified, unfiltered.
 * @param maxCodeLanes             How many contributors, in order, get a code
 *                                  lane. Negative or zero yields no cells and
 *                                  every contributor on the rail.
 */
export function buildLaneLayout(
  contributors: readonly { readonly key: string }[],
  activeFileByContributor: ReadonlyMap<string, string | null>,
  fileAmbiguity: ReadonlyMap<string, AmbiguousReconstruction>,
  maxCodeLanes: number,
): LaneLayout {
  const laneCount = Math.max(0, Math.min(maxCodeLanes, contributors.length));
  const laned = contributors.slice(0, laneCount);
  const railKeys = contributors.slice(laneCount).map((c) => c.key);

  const groupsByFile = new Map<string, Group>();
  const provisional: Group[] = [];

  laned.forEach((c, index) => {
    const filePath = activeFileByContributor.get(c.key) ?? null;

    if (filePath === null) {
      // Never grouped — see the module header.
      provisional.push({ firstIndex: index, filePath: null, keys: [c.key] });
      return;
    }

    const existing = groupsByFile.get(filePath);
    if (existing === undefined) {
      const group: Group = { firstIndex: index, filePath, keys: [c.key] };
      groupsByFile.set(filePath, group);
      provisional.push(group);
    } else {
      existing.keys.push(c.key);
    }
  });

  provisional.sort((a, b) => a.firstIndex - b.firstIndex);

  const cells: LaneCell[] = provisional.map((group): LaneCell => {
    if (group.filePath === null) {
      return { kind: 'idle', contributorKeys: [group.keys[0]!], filePath: null };
    }

    const ambiguity = fileAmbiguity.get(group.filePath);
    if (ambiguity !== undefined) {
      if (ambiguity.kind === 'concurrent') {
        return {
          kind: 'concurrent',
          contributorKeys: group.keys,
          filePath: group.filePath,
          ambiguity,
        };
      }
      return {
        kind: 'unknown',
        contributorKeys: group.keys,
        filePath: group.filePath,
        ambiguity,
      };
    }

    if (group.keys.length === 1) {
      return { kind: 'single', contributorKeys: [group.keys[0]!], filePath: group.filePath };
    }
    return { kind: 'converged', contributorKeys: group.keys, filePath: group.filePath };
  });

  return { cells, railKeys };
}
