/**
 * gap_in_heartbeats heuristic (Phase 17; suspend-aware revision 2026-07).
 *
 * PRD §7.4 integrity: "Consecutive heartbeats more than 5 minutes apart with
 * no session end/start pair between them — suggests the recorder may have been
 * paused or the log file altered."
 *
 * Logic:
 *   For each session, iterate consecutive pairs of `session.heartbeat` events
 *   (ordered by seq). Compute the wall-time gap between each pair. A gap is
 *   flagged only when ALL of the following hold:
 *     1. The gap exceeds `gapThresholdMs` (default: 5 minutes).
 *     2. No `session.end` sits between the two heartbeats (see below).
 *     3. At least one event of ANY kind exists in the same session with `seq`
 *        strictly between the two heartbeats' `seq`.
 *
 * Why condition 3: when a laptop sleeps, the OS suspends the extension host.
 * No timer fires, so the 30s heartbeat (and other periodic writers, e.g. the
 * 5-min `ext.snapshot`) simply stop — but the extension is never deactivated,
 * so no `session.end` is written either. On wake, everything resumes as if
 * nothing happened. That gap is indistinguishable from misconduct by wall-time
 * alone, but it has one reliable signature: nothing was recorded during it,
 * because nothing was running. If the recorder process had merely been
 * stalled (log writes suppressed while other work continued), *other* event
 * kinds recorded by other handlers would still land between the two
 * heartbeats. So an empty gap (zero intervening events, of any kind) is
 * machine suspend, not a paused/tampered recorder, and is not flagged. A gap
 * containing at least one other event demonstrates the process was executing
 * and yet failed to heartbeat — that is still flagged.
 *
 * "No session.end between them" is determined by checking whether any
 * `session.end` event exists in the same session with `seq` between the two
 * heartbeats. Because heartbeat events are single-session, cross-session
 * boundaries cannot occur between two heartbeats of the same session.
 *
 * Wall-time comparison: heartbeat `wall` field (ISO 8601 string). We use
 * Date.parse() for the diff — this is safe because we are not injecting into
 * any log (this is read-only analysis). Non-parseable wall strings produce NaN,
 * which comparison guards handle by skipping.
 *
 * Severity: 'medium'. Confidence: 0.75.
 * (Gaps can be legitimate even when flagged — the student may have worked
 * with the recorder stalled for an innocuous reason. But an empty gap window
 * is affirmatively suspend, not a candidate for staff review at all.)
 *
 * One flag per gap (not per session). Multiple gaps in one session → multiple
 * flags, each pointing to the two bounding heartbeat events.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import { bundleHeartbeatIntervalMs } from '../manifest/bundle-manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionId: string, heartbeatASeq: number, heartbeatBSeq: number): string {
  return `gap_in_heartbeats-${sessionId}-${heartbeatASeq}-${heartbeatBSeq}`;
}

function wallToMs(wall: string): number {
  return Date.parse(wall);
}

/**
 * How far inside a gap an event's wall clock must sit before it counts as
 * evidence the recorder was executing during that gap.
 *
 * On wake, every timer that came due while the machine was suspended fires in
 * one batch, so unrelated periodic events land within a millisecond or two of
 * the heartbeat bounding the gap. Those are wake artifacts, not activity.
 * 1s is far wider than the observed batch spread (median 1ms) and far narrower
 * than any real recording cadence, so it separates the two cleanly.
 */
const WAKE_BATCH_EPSILON_MS = 1_000;

/**
 * How many expected heartbeat intervals may elapse before a gap is suspicious.
 *
 * `heartbeat_interval_ms` is a per-course knob in Manifest 2.0 (clamped to
 * [5s, 120s]), so a threshold expressed as a fixed number of minutes silently
 * changes meaning between courses: the 5-minute default is ten missed beats at
 * the 30s cadence a 1.x recorder used, but only two and a half at a 120s
 * cadence — which would make a course that turned the cadence down get flagged
 * for gaps a 30s course would never see.
 *
 * 10 is exactly `DEFAULT gapThresholdMs / DEFAULT heartbeat_interval_ms`
 * (300_000 / 30_000), so a 1.x bundle — and any 2.0 bundle recorded at the
 * default cadence — gets a byte-for-byte unchanged threshold.
 */
const GAP_INTERVAL_MULTIPLIER = 10;

/**
 * The gap threshold actually applied: whichever of the configured floor and the
 * interval-derived value is LARGER.
 *
 * Taking the max rather than replacing the configured value means a course that
 * *shortens* the cadence (down to the 5s clamp) does not get a 50s threshold
 * and a flood of flags; the configured floor still governs. Only lengthening
 * the cadence moves the threshold, and it moves it in the direction that avoids
 * false positives.
 */
export function effectiveGapThresholdMs(configuredMs: number, heartbeatIntervalMs: number): number {
  return Math.max(configuredMs, heartbeatIntervalMs * GAP_INTERVAL_MULTIPLIER);
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[] {
  const gapThresholdMs = effectiveGapThresholdMs(
    config.gapInHeartbeats.gapThresholdMs,
    bundleHeartbeatIntervalMs(bundle),
  );
  const flags: Flag[] = [];

  for (const [sessionId, sessionEvents] of index.bySessionId) {
    // Collect heartbeat events in seq order (already sorted in sessionEvents).
    const heartbeats = sessionEvents.filter((e) => e.kind === 'session.heartbeat');
    if (heartbeats.length < 2) continue;

    // Build a Set of seqs at which session.end events occur in this session.
    // This lets us quickly check if a session ended between two heartbeats.
    const sessionEndSeqs = new Set<number>(
      sessionEvents.filter((e) => e.kind === 'session.end').map((e) => e.seq),
    );

    for (let i = 0; i < heartbeats.length - 1; i++) {
      const hA = heartbeats[i]!;
      const hB = heartbeats[i + 1]!;

      const wallA = wallToMs(hA.wall);
      const wallB = wallToMs(hB.wall);

      if (Number.isNaN(wallA) || Number.isNaN(wallB)) continue;

      const gapMs = wallB - wallA;
      if (gapMs <= gapThresholdMs) continue;

      // Check if a session.end exists between these two heartbeats (by seq).
      // If so, the gap is expected — the session ended and hasn't restarted yet.
      const hasSessionEndInGap = [...sessionEndSeqs].some((seq) => seq > hA.seq && seq < hB.seq);
      if (hasSessionEndInGap) continue;

      // Suspend guard: only flag if the recorder was demonstrably still
      // running during the gap, i.e. at least one event of any kind (not
      // just heartbeats — they're consecutive by construction) was recorded
      // with seq strictly between the two heartbeats. A gap with zero
      // intervening events means nothing executed — machine sleep, not a
      // stalled or tampered recorder.
      //
      // The `seq` range alone is not sufficient. When the machine wakes, every
      // timer that came due while suspended fires in a single batch at the
      // wake instant, so an `ext.snapshot` tick lands microseconds after the
      // heartbeat that bounds the gap. By `seq` it looks like it happened
      // "during" the gap; by wall clock it is part of the wake batch and
      // proves nothing about the intervening hours. Measured on a real
      // 4-session bundle, 69 of 74 seq-qualifying gaps had every intervening
      // event within 1s of a boundary (median distance: 1ms).
      //
      // So an event only counts as evidence the recorder ran if its wall clock
      // is strictly inside the gap by more than WAKE_BATCH_EPSILON_MS.
      const hasEventInGap = sessionEvents.some((e) => {
        if (e.seq <= hA.seq || e.seq >= hB.seq) return false;
        const w = wallToMs(e.wall);
        if (Number.isNaN(w)) return false;
        return w > wallA + WAKE_BATCH_EPSILON_MS && w < wallB - WAKE_BATCH_EPSILON_MS;
      });
      if (!hasEventInGap) continue;

      flags.push({
        id: flagId(sessionId, hA.seq, hB.seq),
        heuristic: 'gap_in_heartbeats',
        title: `Heartbeat gap of ${Math.round(gapMs / 60_000)}min in session ${sessionId.slice(0, 8)}…`,
        severity: 'medium',
        confidence: 0.75,
        supportingSeqs: [`${hA.sessionId}:${hA.seq}`, `${hB.sessionId}:${hB.seq}`],
        description:
          `A gap of ${Math.round(gapMs / 60_000)} minutes was found between consecutive ` +
          `heartbeat events (seqs ${hA.seq}→${hB.seq}) with no session.end between them, ` +
          `and other events were recorded during the gap — so the recorder was running ` +
          `but did not heartbeat. This may indicate the recorder was paused, the log file ` +
          `was modified, or the student worked offline without the recorder running.`,
        detail: {
          sessionId,
          heartbeatASeq: hA.seq,
          heartbeatBSeq: hB.seq,
          heartbeatAWall: hA.wall,
          heartbeatBWall: hB.wall,
          gapMs,
          /**
           * The threshold actually applied, and the recorded heartbeat cadence
           * it was derived from. Surfaced so staff reading a flag from a course
           * that retuned the cadence can see which number was used.
           */
          thresholdMs: gapThresholdMs,
        },
      });
    }
  }

  return flags;
}

export const gapInHeartbeatsHeuristic: Heuristic = {
  id: 'gap_in_heartbeats',
  label: 'Unexplained heartbeat gap (>5 min without session end)',
  run,
};
