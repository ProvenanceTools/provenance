/**
 * contributor-activity — per-contributor activity runs in INDEX space, plus
 * overlap intervals, for the transport ribbons (design §5).
 *
 * Design spec: `docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md`.
 *
 * ## Index space, matching the seam ticks
 *
 * A run is described in `globalIdx`, not wall time, so it can be positioned
 * with the exact geometry `TransportBar.tsx:159-181` already uses for seam
 * ticks (`left% = atGlobalIdx / sliderMax * 100`). The axis is uniform in
 * EVENTS, not in seconds — a long wall-clock gap does not get proportionally
 * more width than a short one. That is a deliberate, documented trade-off (see
 * "idle sub-runs" below), not an oversight.
 *
 * A run is a maximal span of CONSECUTIVE `EventIndex.ordered` entries whose
 * session belongs to one contributor. Because `ordered[i].globalIdx === i`
 * (`event-index.ts`), "consecutive array positions" and "consecutive globalIdx
 * integers" are the same statement — a run's bounds are just the first and
 * last globalIdx of an unbroken stretch of that contributor's own events, with
 * no OTHER contributor's event landing in between. Any such interruption ends
 * the run, even a single interleaved event: that fragmentation is intentional
 * (see "overlap", below) and is what lets the ribbon show two contributors
 * ping-ponging through a region rather than smearing it into one bar.
 *
 * ## Idle sub-runs
 *
 * Within one run, a WALL-clock gap between two adjacent events that exceeds
 * the injected `idleGapMs` splits the run at that pair: the events up to and
 * including the first stay in an `idle: false` run ending at that event's
 * globalIdx, a new `idle: true` run spans exactly that one index step (the gap
 * has no width of its own in index space — see "index space" above), and a new
 * `idle: false` run starts at the next event. `idleGapMs` is always the caller
 * argument; this module never reads a clock or hides a threshold constant.
 *
 * ## Overlap is NOT "unordered", and is computed on ENVELOPES, not sub-runs
 *
 * The mock this feature started from labelled a band "unordered — 6 min", and
 * §5 of the design explicitly retracts that: whether two contributors' edits
 * are genuinely unordered is a per-FILE, per-PLAYHEAD question answered by
 * `≺` (`reconstruct-segments.ts`'s `resolve()`), and re-deriving it for every
 * index across the whole timeline would mean re-running reconstruction at
 * every index — not "cheap", and not this module's job.
 *
 * What IS cheap and honest is **"both recording"**: two or more contributors
 * with activity somewhere in the same broad stretch of the timeline. Because a
 * single `globalIdx` can only ever belong to one contributor's one event (one
 * event, one session, one owner), overlap can never be found by looking for a
 * shared index between two contributors' fine-grained (idle-split) runs — by
 * construction those never coincide. So overlap here is computed on each
 * contributor's ENVELOPE — the span from their first event's globalIdx to
 * their last — and two contributors overlap over the index range where their
 * envelopes both cover. That is a coarser, honest claim ("both were recording
 * across this stretch"), not a claim about interleaving order, which is
 * exactly the claim this module must not make.
 *
 * ## Sessions absent from `contributorBySession`
 *
 * A session id with no entry (should not normally happen — `bySession` in
 * `BundleContributors` is total over the bundle's sessions — but this module
 * takes a bare map, not the stamp, so a caller can hand it a partial one) is
 * SKIPPED: its events contribute to no contributor's run, and — because a run
 * requires unbroken consecutive ownership — an unmapped event still ends
 * whatever run was open, exactly as an interleaved different-contributor event
 * would. Nothing is merged into a nearby contributor and no key is invented for
 * it; that would attribute activity to someone the evidence does not name.
 */

import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { SessionContributor } from '@provenance/analysis-core/identity/types.js';

/**
 * The wall-gap threshold the REPLAY RIBBONS use to shade a run as idle: two
 * minutes.
 *
 * ## This number is presentational, and must stay that way
 *
 * All it decides is whether a slice of one contributor's ribbon renders in the
 * translucent `soft` variant of their hue instead of the solid one. It makes no
 * claim, produces no flag, and appears in no export. Nothing downstream reads
 * it. `buildContributorActivity` deliberately takes `idleGapMs` as an argument
 * rather than importing this constant, so a caller that wants a different
 * shading (or a test that wants a deterministic one) never has to move it.
 *
 * ## Why two minutes, and why it must NOT be "aligned" with a heuristic
 *
 * Two neighbouring numbers exist in this codebase and this one is deliberately
 * neither of them:
 *
 *  - `engine-core.ts`'s `MAX_IDLE_GAP_MS` (5s) is a PLAYBACK PACING cap — the
 *    longest pause `skipIdle` will actually play through. At 5s the ribbon
 *    would be stippled with idle slivers for every ordinary pause to read a
 *    line, which says nothing.
 *  - `analysis-core/heuristics/config.ts`'s `idleGapMs` (10min) is a FINDING
 *    threshold — the pause length that, followed by the right kind of save,
 *    contributes to a flag against a student. Reusing it here would quietly
 *    make a ribbon's shading legible as "this is the flagged kind of gap",
 *    which is exactly the misreading `contributor-palette.ts`'s hue rules exist
 *    to prevent, and would also couple a cosmetic choice to a tuned product
 *    threshold so that changing either one silently changes the other.
 *
 * Two minutes sits between them on purpose: comfortably past ordinary
 * think-time and mid-line pauses (seconds to tens of seconds), short enough
 * that a genuine step-away shows up as a visible break in the ribbon. If it
 * ever looks wrong, change it here on presentational grounds alone — do not
 * reach for a heuristic's number to justify it.
 */
export const RIBBON_IDLE_GAP_MS = 120_000;

export type ActivityRun = {
  readonly contributorKey: string;
  readonly startGlobalIdx: number;
  readonly endGlobalIdx: number; // inclusive
  readonly idle: boolean;
};

export type OverlapInterval = {
  readonly startGlobalIdx: number;
  readonly endGlobalIdx: number; // inclusive
  readonly contributorKeys: readonly string[];
};

export type ContributorActivity = {
  readonly runs: ReadonlyMap<string, readonly ActivityRun[]>;
  readonly overlaps: readonly OverlapInterval[];
};

/**
 * Wall-clock gap between two ISO timestamps, in ms. `0` (never idle) when
 * either side fails to parse — clock skew or a malformed log entry must not
 * crash the ribbon, and treating an unparseable gap as "not idle" is the
 * conservative reading (it under- rather than over-claims a pause).
 */
function wallGapMs(fromWall: string, toWall: string): number {
  const from = Date.parse(fromWall);
  const to = Date.parse(toWall);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return to - from;
}

/**
 * Split one contributor's contiguous run of events into idle/active sub-runs.
 * `events` is always non-empty here — the only caller, `flush()` below, never
 * invokes this on an empty accumulation.
 */
function splitIdleSegments(
  contributorKey: string,
  events: readonly IndexedEvent[],
  idleGapMs: number,
): ActivityRun[] {
  const segments: ActivityRun[] = [];
  let segmentStart = events[0]!.globalIdx;
  let prev = events[0]!;

  for (let i = 1; i < events.length; i++) {
    const cur = events[i]!;
    if (wallGapMs(prev.wall, cur.wall) > idleGapMs) {
      segments.push({
        contributorKey,
        startGlobalIdx: segmentStart,
        endGlobalIdx: prev.globalIdx,
        idle: false,
      });
      segments.push({
        contributorKey,
        startGlobalIdx: prev.globalIdx,
        endGlobalIdx: cur.globalIdx,
        idle: true,
      });
      segmentStart = cur.globalIdx;
    }
    prev = cur;
  }

  segments.push({
    contributorKey,
    startGlobalIdx: segmentStart,
    endGlobalIdx: prev.globalIdx,
    idle: false,
  });
  return segments;
}

/**
 * Overlap intervals over each contributor's full activity ENVELOPE (first
 * event's globalIdx to last event's globalIdx, across all of that
 * contributor's runs — including idle sub-runs, since an idle gap is still
 * within that contributor's recording window). See the module header for why
 * this is envelope-based rather than fine-run-based.
 */
function computeOverlaps(
  runsByKey: ReadonlyMap<string, readonly ActivityRun[]>,
): OverlapInterval[] {
  const envelopes: { key: string; start: number; end: number }[] = [];
  for (const [key, runs] of runsByKey) {
    // `runs` is always non-empty: `flush()` in buildContributorActivity only
    // ever stores a key after `splitIdleSegments` produced at least one run.
    let start = runs[0]!.startGlobalIdx;
    let end = runs[0]!.endGlobalIdx;
    for (const run of runs) {
      if (run.startGlobalIdx < start) start = run.startGlobalIdx;
      if (run.endGlobalIdx > end) end = run.endGlobalIdx;
    }
    envelopes.push({ key, start, end });
  }
  if (envelopes.length < 2) return [];

  // Sweep over half-open [start, end+1) boundaries so two envelopes that only
  // touch at a shared index (e.g. [0,5] and [6,10]) never register as overlap.
  const points = new Set<number>();
  for (const e of envelopes) {
    points.add(e.start);
    points.add(e.end + 1);
  }
  const sorted = [...points].sort((a, b) => a - b);

  // Every boundary point is one specific envelope's own start or end+1, so it
  // always flips that envelope's membership in the active set — two segments
  // adjacent in `sorted` can therefore never carry the identical active-key
  // set (distinct contributors never share a key), and there is nothing to
  // merge: each qualifying segment below is already maximal.
  const overlaps: OverlapInterval[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const segStart = sorted[i]!;
    // `sorted` holds distinct ascending integers, so segEnd >= segStart always.
    const segEnd = sorted[i + 1]! - 1;
    const activeKeys = envelopes
      .filter((e) => e.start <= segStart && e.end >= segEnd)
      .map((e) => e.key)
      .sort();
    if (activeKeys.length >= 2) {
      overlaps.push({
        startGlobalIdx: segStart,
        endGlobalIdx: segEnd,
        contributorKeys: activeKeys,
      });
    }
  }
  return overlaps;
}

/**
 * Build per-contributor activity runs (index space, idle-split) and overlap
 * intervals, from the whole-bundle ordered event stream and the contributor
 * stamp.
 *
 * `ordered` must be chronologically ordered with `ordered[i].globalIdx === i`,
 * as `EventIndex.ordered` is. `idleGapMs` is the caller-supplied wall-gap
 * threshold — never a literal constant here.
 */
export function buildContributorActivity(
  ordered: readonly IndexedEvent[],
  contributorBySession: ReadonlyMap<string, SessionContributor>,
  options: { readonly idleGapMs: number },
): ContributorActivity {
  const { idleGapMs } = options;
  const runsByKey = new Map<string, ActivityRun[]>();

  let currentKey: string | null = null;
  let currentEvents: IndexedEvent[] = [];

  function flush(): void {
    if (currentKey === null || currentEvents.length === 0) return;
    const segments = splitIdleSegments(currentKey, currentEvents, idleGapMs);
    const existing = runsByKey.get(currentKey);
    if (existing === undefined) {
      runsByKey.set(currentKey, segments);
    } else {
      existing.push(...segments);
    }
  }

  for (const event of ordered) {
    const key = contributorBySession.get(event.sessionId)?.contributorKey;
    if (key === undefined) {
      // Unmapped session: skip the event, and end whatever run was open — see
      // the module header's "sessions absent from contributorBySession".
      flush();
      currentKey = null;
      currentEvents = [];
      continue;
    }
    if (key !== currentKey) {
      flush();
      currentKey = key;
      currentEvents = [event];
    } else {
      currentEvents.push(event);
    }
  }
  flush();

  return { runs: runsByKey, overlaps: computeOverlaps(runsByKey) };
}
