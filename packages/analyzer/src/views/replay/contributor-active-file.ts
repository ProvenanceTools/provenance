/**
 * contributor-active-file — "which file was THIS CONTRIBUTOR last in, as of the
 * playhead?" (design §4: `activeFile(c, T)`, the input the lane grid groups by).
 *
 * Design spec: `docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md`.
 *
 * ## One predicate, not two
 *
 * `focus-and-follow.ts`'s `currentEditedFile` already answers "the path of the
 * most recent file-bearing event (`doc.change` / `paste` / `doc.save` /
 * `doc.open`) at or before the playhead" for the whole stream. A per-contributor
 * version of that question is the SAME predicate restricted to one
 * contributor's sessions — not a second definition of "this event names a
 * file". Inventing a parallel predicate here would eventually drift from the
 * single-stream one (a new file-bearing event kind added to one and not the
 * other, for instance) with no test able to catch it.
 *
 * So `currentEditedFile` was given an optional `sessionIds` filter (see its
 * header) and this module is a two-line delegation: it exists as its own file
 * only because it is a distinct call shape (a session-id SET, not the implicit
 * "whole stream") with its own name at the call sites that need it
 * (`lane-groups.ts` / the lane grid wiring in a later phase).
 *
 * ## Why there is also a precomputed timeline
 *
 * {@link activeFileAt} is a LINEAR scan of the whole stream, and the lane grid
 * needs one answer PER CONTRIBUTOR on every frame of playback. That is
 * `O(events × contributors)` per tick — quadratic in the length of the
 * submission over a playthrough, on the one tab that already carries the
 * heaviest render in the app (up to three Monaco instances).
 * {@link buildActiveFileTimelines} does the scan ONCE, keeping only the indices
 * at which some contributor's active file CHANGES, and
 * {@link activeFilesAt} binary-searches those change points at the playhead.
 * Per frame that is `O(contributors × log changes)` and allocates one small
 * map.
 *
 * Both live here on purpose. `activeFileAt` stays the readable definition and
 * the thing the unit tests pin the SEMANTICS against; the timeline is an index
 * over the same predicate (`isFileBearingEvent`, imported — not re-declared),
 * and its tests assert it agrees with `activeFileAt` at every index rather than
 * re-deriving what the right answer is.
 */

import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import { currentEditedFile, isFileBearingEvent } from './focus-and-follow.js';

/**
 * The path named by the most recent file-bearing event at or before
 * `globalIdx` belonging to any session in `sessionIds`. `null` when this
 * contributor has no such event yet (including when `sessionIds` is empty —
 * a contributor with no sessions has, by definition, no activity to show).
 *
 * `events` must be chronologically ordered (ascending `globalIdx`), as
 * `EventIndex.ordered` is.
 */
export function activeFileAt(
  events: readonly IndexedEvent[],
  sessionIds: ReadonlySet<string>,
  globalIdx: number,
): string | null {
  return currentEditedFile(events, globalIdx, sessionIds);
}

// ---------------------------------------------------------------------------
// Precomputed timeline — same answers as activeFileAt, without the per-frame
// scan. See the module header, "Why there is also a precomputed timeline".
// ---------------------------------------------------------------------------

/** "From `atGlobalIdx` onwards, this contributor's active file is `filePath`." */
export type FileChangePoint = {
  readonly atGlobalIdx: number;
  readonly filePath: string;
};

/** Change points per contributor key, each list ascending in `atGlobalIdx`. */
export type ActiveFileTimelines = ReadonlyMap<string, readonly FileChangePoint[]>;

/**
 * Precompute every contributor's file-change points in a single pass.
 *
 * Only TRANSITIONS are stored: a contributor typing 4000 characters into one
 * file contributes exactly one change point, not 4000. Every key in
 * `sessionIdsByContributor` gets an entry (empty when that contributor has no
 * file-bearing event at all), so callers can iterate the result rather than
 * having to reconcile it against the contributor list.
 *
 * `events` must be chronologically ordered (ascending `globalIdx`), as
 * `EventIndex.ordered` is.
 */
export function buildActiveFileTimelines(
  events: readonly IndexedEvent[],
  sessionIdsByContributor: ReadonlyMap<string, ReadonlySet<string>>,
): ActiveFileTimelines {
  const timelines = new Map<string, FileChangePoint[]>();
  // Reverse index so each event is attributed in O(1) rather than by asking
  // every contributor's set whether it owns the session.
  const keyBySession = new Map<string, string>();
  for (const [contributorKey, sessionIds] of sessionIdsByContributor) {
    timelines.set(contributorKey, []);
    for (const sessionId of sessionIds) {
      // A session belongs to exactly one contributor (`bySession` is a map), so
      // a later write here can only ever be the same key.
      keyBySession.set(sessionId, contributorKey);
    }
  }

  const currentFile = new Map<string, string>();
  for (const e of events) {
    if (!isFileBearingEvent(e)) continue;
    const contributorKey = keyBySession.get(e.sessionId);
    if (contributorKey === undefined) continue;
    if (currentFile.get(contributorKey) === e.file) continue;
    currentFile.set(contributorKey, e.file);
    // `timelines` has an entry for every key in `sessionIdsByContributor`, and
    // `keyBySession` only ever yields such a key.
    timelines.get(contributorKey)?.push({ atGlobalIdx: e.globalIdx, filePath: e.file });
  }

  return timelines;
}

/**
 * The active file at `globalIdx` for one contributor's change points: the last
 * point at or before `globalIdx`, or `null` when there is none.
 *
 * Binary search over an ascending list — `points` comes from
 * {@link buildActiveFileTimelines}, which appends in stream order.
 */
export function activeFileFromTimeline(
  points: readonly FileChangePoint[],
  globalIdx: number,
): string | null {
  let lo = 0;
  let hi = points.length - 1;
  let found: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = points[mid]!;
    if (point.atGlobalIdx <= globalIdx) {
      found = point.filePath;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Every contributor's active file at `globalIdx` — the map shape the lane grid
 * (`lane-groups.ts` / `ReplayLanes.tsx`) consumes. Total over the timelines'
 * keys, with `null` for a contributor who has not started yet.
 */
export function activeFilesAt(
  timelines: ActiveFileTimelines,
  globalIdx: number,
): ReadonlyMap<string, string | null> {
  const byContributor = new Map<string, string | null>();
  for (const [contributorKey, points] of timelines) {
    byContributor.set(contributorKey, activeFileFromTimeline(points, globalIdx));
  }
  return byContributor;
}
