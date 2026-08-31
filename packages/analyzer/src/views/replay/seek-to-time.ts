/**
 * seek-to-time — resolve a wall-clock instant to a replay position.
 *
 * The question this answers is "what did the code look like at time T", which
 * is really "which event is the last one at or before T" — the playhead there
 * reproduces the file state as of that instant.
 *
 * ## Why the search compares ISO strings, not epoch milliseconds
 *
 * `index.ordered` is sorted by `build-index.ts` on `(wall, sessionId, seq)`
 * with `wall` compared as a LEXICOGRAPHIC string. A binary search is only
 * correct if it uses the same predicate the array was sorted with. Comparing
 * `Date.parse` values instead would agree with that order for the ISO 8601 UTC
 * timestamps `IndexedEvent.wall` is documented to hold, and disagree silently
 * for anything else — a wrong answer with no error, which is the worst shape a
 * bug can take on a surface a grader might rely on. So the search compares
 * strings and only the reported `gapMs` parses.
 *
 * ## Why the gap is part of the result
 *
 * A caller that only learns "position 4812" will present it as "the code at the
 * deadline". If the last recorded event was three hours before the deadline,
 * that reading is false: the snapshot is three hours old and the student may
 * have worked afterwards without the recorder running. `gapMs` exists so the UI
 * is able to say so, and `after_end` / `before_start` exist so it can
 * distinguish "the recording had not started" and "the recording had already
 * ended" from an ordinary hit in the middle.
 */

/** The minimum an event must expose to be positioned in time. */
export type TimedEvent = {
  globalIdx: number;
  wall: string;
};

export type SeekToTimeResult =
  /** The bundle has no events at all — nothing to seek to. */
  | { kind: 'empty' }
  /**
   * The target precedes every recorded event. There is no file state to show:
   * at that instant the recording had not begun.
   *
   * `gapMs` is how long AFTER the target the recording starts.
   */
  | { kind: 'before_start'; firstWall: string; gapMs: number }
  /**
   * An event at or before the target exists, and so does at least one after it.
   *
   * `gapMs` is how long BEFORE the target that event happened — 0 when the
   * target lands exactly on it.
   */
  | { kind: 'found'; globalIdx: number; wall: string; gapMs: number }
  /**
   * The resolved event is the last in the bundle: the target is at or after the
   * end of the recording, so nothing more was ever recorded.
   *
   * `gapMs` is how long BEFORE the target the recording ended.
   */
  | { kind: 'after_end'; globalIdx: number; wall: string; gapMs: number };

/**
 * Find the last event at or before `targetIso`.
 *
 * When several events share the target instant, the LAST of them wins: they all
 * happened at that time, and a position before the final one would reproduce a
 * file state that existed only mid-instant.
 *
 * @param ordered wall-ascending events, as `EventIndex.ordered` is.
 * @param targetIso the instant to resolve, as an ISO 8601 UTC string.
 */
export function resolveWallToGlobalIdx(
  ordered: readonly TimedEvent[],
  targetIso: string,
): SeekToTimeResult {
  if (ordered.length === 0) return { kind: 'empty' };

  const targetMs = Date.parse(targetIso);
  const first = ordered[0]!;

  if (first.wall > targetIso) {
    return {
      kind: 'before_start',
      firstWall: first.wall,
      gapMs: Math.max(0, Date.parse(first.wall) - targetMs),
    };
  }

  // Largest index whose wall is <= targetIso. `first` already satisfies the
  // predicate, so `lo` is a real answer at every step and the loop cannot fail
  // to find one.
  let lo = 0;
  let hi = ordered.length - 1;
  while (lo < hi) {
    // Bias up, so `lo = mid` makes progress and the loop terminates.
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (ordered[mid]!.wall <= targetIso) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const hit = ordered[lo]!;
  const gapMs = Math.max(0, targetMs - Date.parse(hit.wall));
  const isLast = lo === ordered.length - 1;

  return isLast
    ? { kind: 'after_end', globalIdx: hit.globalIdx, wall: hit.wall, gapMs }
    : { kind: 'found', globalIdx: hit.globalIdx, wall: hit.wall, gapMs };
}

/**
 * Convert the value of an `<input type="datetime-local">` (a local-time string
 * with no zone, e.g. `2026-09-01T23:59`) to an ISO 8601 UTC string suitable for
 * {@link resolveWallToGlobalIdx}.
 *
 * Returns null when the input is empty or unparseable, so the caller can keep
 * the control inert rather than seeking to the epoch.
 */
export function localInputToIso(value: string): string | null {
  if (value === '') return null;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}
