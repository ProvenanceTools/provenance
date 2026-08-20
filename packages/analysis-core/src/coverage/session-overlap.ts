/**
 * session-overlap — the ONE place that decides which session pairs overlap and
 * which of those overlaps is proven collaboration.
 *
 * Spec: `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md`
 * §5.4 step 5 (compute coverage) and §3 S5 (the overlap accusation).
 *
 * ## Why this module exists
 *
 * `multiple_sessions_overlap` suppresses a pair whose two contributors are
 * PROVABLY different — two partners recording at once is the expected shape of
 * pair work, not evidence of forgery. The suppression used to be a bare
 * `continue` inside the heuristic, taken before any `detail` object existed, and
 * `run()` returns only `Flag[]`. So a suppressed overlap produced **no flag and
 * no fact**: the strongest positive evidence of legitimate collaboration in the
 * whole system was computed and thrown away, which is precisely the gap §6
 * Rule 3's coverage panel exists to close.
 *
 * The obvious fix — recompute the overlap wherever the fact is needed — was
 * taken once and was wrong. Two implementations of a subtle rule (crash
 * bounding, backwards-clock collapse, strict-`<` overlap, three-valued
 * contributor comparison) agree on the day they are written and drift after.
 * This repo has already paid for that twice ("26 vs 25 flags", "21 vs 25
 * tables").
 *
 * ## How drift is prevented STRUCTURALLY, not by a test
 *
 * There is exactly one enumeration ({@link partitionSessionOverlaps}) and
 * exactly one suppression decision, made at exactly one line inside it. The two
 * consumers do not each apply a rule and then get compared — they receive the
 * two halves of a partition produced by a single pass, and the type system makes
 * the other half unreachable:
 *
 *  - {@link JudgedOverlap.comparison} is typed `'same' | 'unknown'`. A
 *    `'different'` pair is **not representable** in what the heuristic consumes.
 *  - {@link CollaborationOverlap} carries `attributed` contributors, so an
 *    unattributed or unverifiable session is **not representable** in what the
 *    coverage stage consumes. That is not a stylistic nicety: it is the
 *    `unverifiable` ≠ `unattributed` distinction enforced by the compiler, so a
 *    coverage panel can never name an unproven claim as a verified partner.
 *
 * A future edit cannot make the two disagree about which pairs were suppressed
 * without first deleting the partition, which is a visible change to this file
 * rather than a silent divergence in two others.
 *
 * Nothing here is a Flag, contributes to a score, or fails a check. It computes
 * ranges and a partition; the heuristic decides what to accuse and the coverage
 * stage decides what to state.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import { contributorOf } from '../identity/resolve-contributors.js';
import { compareContributors, type SessionContributor } from '../identity/types.js';

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/** The wall-clock extent of one session, plus what bounded it. */
export type SessionRange = {
  sessionId: string;
  /** `Date.parse` of `session.start.wall`. */
  startWall: number;
  /**
   * `Date.parse` of `session.end.wall`, or — when the session has no
   * `session.end` (crash) — of its last recorded event's wall. Never
   * `+Infinity`: see {@link sessionRanges}.
   */
  endWall: number;
  /** `seq` of the `session.start` event, for a flag's supporting evidence. */
  startSeq: number;
  /** True when the session has no `session.end` event (crashed / killed). */
  openEnded: boolean;
};

/**
 * Wall-clock extent of every session in the index.
 *
 * The rules, each of which exists because breaking it manufactured a finding:
 *
 *  - A session with no `session.end` is bounded at its **last recorded event**,
 *    the last moment it demonstrably existed — never `+Infinity`. A missing
 *    `session.end` is the ordinary crash signature (the recorder only emits it
 *    from `deactivate()`, which the editor skips on a kill or a power cut).
 *    Extending such a range to infinity claimed one crash on day 1 overlapped
 *    every session for the rest of the assignment.
 *  - An unparseable or backwards end collapses the range to **zero length**
 *    rather than extending it. Clock damage has its own heuristic
 *    (`monotonic_wall_regression`) and must not leak into this one.
 *  - A session with no parseable `session.start` is skipped entirely.
 *
 * `index.bySessionId` is chronological, which is what makes "last recorded
 * event" the last element.
 */
export function sessionRanges(index: EventIndex): SessionRange[] {
  const ranges: SessionRange[] = [];

  for (const [sessionId, sessionEvents] of index.bySessionId) {
    const startEvent = sessionEvents.find((e) => e.kind === 'session.start');
    const endEvent = sessionEvents.find((e) => e.kind === 'session.end');

    if (startEvent === undefined) continue;

    const startWall = Date.parse(startEvent.wall);
    if (Number.isNaN(startWall)) continue;

    const openEnded = endEvent === undefined;
    const boundingEvent = endEvent ?? sessionEvents[sessionEvents.length - 1];
    const parsedEnd = boundingEvent !== undefined ? Date.parse(boundingEvent.wall) : NaN;
    const endWall = Number.isNaN(parsedEnd) ? startWall : Math.max(parsedEnd, startWall);

    ranges.push({ sessionId, startWall, endWall, startSeq: startEvent.seq, openEnded });
  }

  return ranges;
}

/**
 * Standard interval overlap, strict on both sides.
 *
 * Strict `<` means a zero-length range (a session whose only event is
 * `session.start`, or one whose end collapsed) never overlaps anything, and two
 * adjacent sessions (`a.end === b.start`) do not overlap. Both are correct:
 * neither demonstrably ran concurrently with anything.
 */
export function rangesOverlap(a: SessionRange, b: SessionRange): boolean {
  return a.startWall < b.endWall && b.startWall < a.endWall;
}

/** Milliseconds of genuine overlap, or `0` when the ranges do not overlap. */
export function overlapDurationMs(a: SessionRange, b: SessionRange): number {
  if (!rangesOverlap(a, b)) return 0;
  return Math.min(a.endWall, b.endWall) - Math.max(a.startWall, b.startWall);
}

// ---------------------------------------------------------------------------
// The partition
// ---------------------------------------------------------------------------

/** A `SessionContributor` narrowed to the attributed branch. */
export type AttributedContributor = Extract<SessionContributor, { kind: 'attributed' }>;

/**
 * An overlapping pair that is NOT proven collaboration, and is therefore judged
 * by `multiple_sessions_overlap`.
 *
 * `comparison` deliberately cannot be `'different'`. A pair the partition
 * suppressed is not representable here, so the heuristic cannot re-admit one by
 * accident.
 */
export type JudgedOverlap = {
  a: SessionRange;
  b: SessionRange;
  overlapMs: number;
  contributorA: SessionContributor;
  contributorB: SessionContributor;
  /**
   * `'same'` — one verified person recorded both; the original signal.
   * `'unknown'` — at least one side is `unattributed` or `unverifiable`, so
   * "two different people" is exactly what is NOT established.
   */
  comparison: 'same' | 'unknown';
};

/**
 * An overlapping pair recorded by two PROVABLY different verified contributors.
 *
 * Exculpatory context, never a finding. Both contributors are typed
 * `attributed`, so this shape cannot carry an unverifiable claim or an
 * unattributed session — the compiler enforces what the copy promises.
 */
export type CollaborationOverlap = {
  a: SessionRange;
  b: SessionRange;
  overlapMs: number;
  contributorA: AttributedContributor;
  contributorB: AttributedContributor;
};

/**
 * Every overlapping session pair, split into the two halves that must never
 * disagree.
 *
 * `judged ∪ collaboration` is exactly the set of overlapping pairs and
 * `judged ∩ collaboration` is empty, **by construction** — one loop, one
 * comparison, one `push` per pair.
 */
export type OverlapPartition = {
  /** Pairs `multiple_sessions_overlap` flags. */
  judged: readonly JudgedOverlap[];
  /** Pairs `multiple_sessions_overlap` suppresses, and the coverage stage states. */
  collaboration: readonly CollaborationOverlap[];
};

/**
 * The single enumeration of overlapping session pairs, and the single decision
 * about which of them are proven collaboration.
 *
 * The verdict is read through `contributorOf`, which answers `unattributed` for
 * a bundle no caller has stamped via `establishBundleContributors`. That is the
 * fail-toward-more-findings direction: an unstamped bundle produces an empty
 * `collaboration` half and a `judged` half identical to the pre-Tier-3.2
 * behaviour.
 *
 * Never compare `contributorKey` strings here. That reads "unproven" as
 * "different people" and would both suppress a real finding and manufacture a
 * false exculpation, because every unattributed session carries a per-session
 * singleton key.
 *
 * Pairs are enumerated `i < j` over `sessionRanges` order, so the output is
 * deterministic — required by the ingest-retry contract.
 */
export function partitionSessionOverlaps(bundle: Bundle, index: EventIndex): OverlapPartition {
  const ranges = sessionRanges(index);
  if (ranges.length < 2) return { judged: [], collaboration: [] };

  const judged: JudgedOverlap[] = [];
  const collaboration: CollaborationOverlap[] = [];

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]!;
      const b = ranges[j]!;

      if (!rangesOverlap(a, b)) continue;
      const overlapMs = overlapDurationMs(a, b);

      const contributorA = contributorOf(bundle, a.sessionId);
      const contributorB = contributorOf(bundle, b.sessionId);
      const comparison = compareContributors(contributorA, contributorB);

      // ---------------------------------------------------------------------
      // THE suppression decision. There is no second copy of this line.
      // `'different'` requires both sides attributed and verified, so the
      // narrowing below is total rather than defensive.
      // ---------------------------------------------------------------------
      if (
        comparison === 'different' &&
        contributorA.kind === 'attributed' &&
        contributorB.kind === 'attributed'
      ) {
        collaboration.push({ a, b, overlapMs, contributorA, contributorB });
        continue;
      }

      judged.push({
        a,
        b,
        overlapMs,
        contributorA,
        contributorB,
        // Unreachable for 'different' by the branch above; narrowing only.
        comparison: comparison === 'different' ? 'unknown' : comparison,
      });
    }
  }

  return { judged, collaboration };
}
