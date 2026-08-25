/**
 * The raw timeline's ordering, and the places where it refuses to claim one.
 *
 * Spec: `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` §6
 * Rule 4 ("replay never linearizes concurrency") — which is a rule about
 * PRESENTATION, and the timeline is presentation.
 *
 * ## The fabrication this removes
 *
 * `EventIndex.ordered` is sorted by `(wall, sessionId, seq)` — wall clock
 * primary (`build-index.ts:249`) — and `globalIdx` is that array's dense index.
 * The timeline renders that array top to bottom, so every adjacency in the list
 * reads to a grader as "this happened, then this happened".
 *
 * Within one contributor that is fine: one machine, one clock. Across two
 * contributors it is a claim nothing supports. Two machines' clocks are worth
 * nothing relative to each other (spec S16, L3), so an interleaving derived from
 * them is not merely imprecise — it is invented, and it is invented in the one
 * view a grader reads when deciding what a named student did.
 *
 * ## What this module does instead
 *
 * Two steps, and they answer two DIFFERENT defects:
 *
 *  1. {@link orderTimelineEvents} — re-sorts the displayed list with
 *     `presentationSort`, whose output is a proven linear extension of `≺`. This
 *     fixes the list *contradicting* the evidence: with skewed clocks, wall
 *     order can put `f` above `e` when `e ≺ f` is proven, and that is a strictly
 *     worse error than an unsupported claim.
 *  2. {@link computeOrderBreaks} — marks every adjacency the relation does NOT
 *     establish. `presentationSort` alone is not enough and says so in its own
 *     doc comment: its output is a TOTAL order and therefore "says strictly more
 *     than the evidence does". It falls back to a `(sessionId, seq)` tiebreak
 *     purely so the list does not reshuffle between renders. Adopting it
 *     unaccompanied would swap one fabricated total order for another. The
 *     breaks are what stop it being a claim.
 *
 * After step 1, `compareEvents` on an adjacent pair can only answer `'before'`,
 * `'same'`, `'concurrent'` or `'unknown'` — never `'after'` — because the sort
 * is a linear extension. `'concurrent'` and `'unknown'` are different facts and
 * are reported as such: "two recorded branches raced" and "we have no record"
 * lead a grader to opposite conclusions.
 *
 * ## The solo guarantee
 *
 * A scope without two PROVABLY DIFFERENT contributors carries
 * `ReconstructionScope.ordering === null`, and both functions then return the
 * caller's own array by reference and a shared empty map. Not "the same result
 * recomputed" — the same object. There is no second sort to drift, no extra
 * DOM, and no way for a solo bundle (every existing course) to render
 * differently than it does today. That is the same gate
 * `reconstruct-segments.ts` uses, deliberately: two implementations of "is this
 * scope collaborative" is how one of them ends up reading unattributed sessions
 * as different people.
 *
 * ## `globalIdx` is not touched
 *
 * This module re-orders a DISPLAY ARRAY. It reads `globalIdx` (to key breaks and
 * to label rows) and writes nothing. `IndexedEvent.globalIdx` stays the index's
 * own wall-derived numbering, which is what `flags.supporting_seqs` and
 * `cross_flag_participants.supporting_seqs` persist as `int[]` in Postgres. A
 * row's identity, its deep link, its replay target and every stored finding that
 * points at it are unchanged; only the order rows appear in changes, and only
 * for a scope that has two contributors to disagree about.
 */

import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { SessionContributor } from '@provenance/analysis-core/identity/types.js';
import {
  compareEvents,
  presentationSort,
  type EventOrdering,
} from '@provenance/analysis-core/order/happens-before.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * What the timeline needs to speak about order at all.
 *
 * Structurally satisfied by `ReconstructionScope`, so `/local` passes the
 * memoized scope it already builds. `null` — and `ordering: null` inside it —
 * both mean "no relation available here", which stays the honest answer for a
 * solo submission or a bundle whose contributors cannot be established.
 *
 * The server-backed Timeline tab is NOT such a case any more. It builds its
 * index from event rows, but `useServerScope` reconstitutes the relation from
 * those rows plus `SubmissionSummary.contributor_stamp`: `buildObservedDag`
 * and `buildEventOrdering` read only `seq`, `kind`, `wall` and `data`, every
 * one of which an `EventRow` carries. Both routes therefore go through the
 * same hook, so the two tabs cannot disagree about who recorded what.
 */
export type TimelineOrderScope = {
  readonly ordering: EventOrdering | null;
  readonly contributorBySession: ReadonlyMap<string, SessionContributor>;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * One place in the displayed list where the order shown is NOT evidence.
 *
 * Keyed by the `globalIdx` of the event rendered immediately BELOW it, so the
 * list can look each row up in O(1) without knowing its own index.
 */
export type OrderBreak = {
  /** `globalIdx` of the event rendered directly below this break. */
  readonly belowGlobalIdx: number;
  /**
   * `concurrent` — the recording holds both, and orders neither way.
   * `unknown` — an event here is outside the relation's scope, so there is no
   * record to order by. A different fact, never merged into the first.
   */
  readonly reason: 'concurrent' | 'unknown';
  /** Who produced the run above the break. */
  readonly above: string;
  /** Who produced the run below the break. */
  readonly below: string;
};

/** The empty result. Shared so the solo path allocates nothing per render. */
const NO_BREAKS: ReadonlyMap<number, OrderBreak> = new Map();

// ---------------------------------------------------------------------------
// Step 1 — order
// ---------------------------------------------------------------------------

/**
 * The order the list is displayed in.
 *
 * Returns `events` ITSELF when there is no relation, so the solo and
 * server-backed paths are unchanged by identity rather than by reimplementation.
 * Otherwise a `presentationSort` linear extension of `≺` — clock-free, so no
 * amount of skew between two machines can move a row.
 *
 * Set-independent: the comparator ranks each event by its own position in the
 * graph and tiebreaks on `(sessionId, seq)`, so sorting before filtering and
 * sorting after filtering give the same relative order. That is what lets the
 * timeline sort once and let the filter hook preserve it.
 */
export function orderTimelineEvents(
  events: IndexedEvent[],
  scope: TimelineOrderScope | null,
): IndexedEvent[] {
  if (scope === null || scope.ordering === null) return events;
  return presentationSort(scope.ordering, events) as IndexedEvent[];
}

// ---------------------------------------------------------------------------
// Step 2 — mark what the order does not claim
// ---------------------------------------------------------------------------

/**
 * Every adjacency in `events` that `≺` does not establish.
 *
 * Call with the list as displayed — i.e. AFTER filtering. Filtering out an
 * intermediate event cannot manufacture a break: `≺` is transitive, so if
 * `a ≺ b ≺ c` and `b` is filtered away, `a ≺ c` still answers `'before'`.
 */
export function computeOrderBreaks(
  events: readonly IndexedEvent[],
  scope: TimelineOrderScope | null,
): ReadonlyMap<number, OrderBreak> {
  if (scope === null || scope.ordering === null) return NO_BREAKS;

  const breaks = new Map<number, OrderBreak>();
  for (let i = 1; i < events.length; i++) {
    const above = events[i - 1]!;
    const below = events[i]!;
    const order = compareEvents(scope.ordering, above, below);
    if (order === 'before' || order === 'same') continue;
    // `'after'` is unreachable: step 1 sorted into a linear extension of `≺`.
    // Were it ever reached it would mean the sort disagreed with the relation,
    // which is a break in the strongest possible sense — so it falls here too
    // rather than being silently skipped.
    breaks.set(below.globalIdx, {
      belowGlobalIdx: below.globalIdx,
      reason: order === 'unknown' ? 'unknown' : 'concurrent',
      above: contributorLabel(scope, above.sessionId),
      below: contributorLabel(scope, below.sessionId),
    });
  }
  return breaks.size === 0 ? NO_BREAKS : breaks;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * A grader-facing name for whoever produced a session.
 *
 * Never a real name: `studentRef` is the opaque attribution primitive and no
 * roster is available on the `/local` route. An `unverifiable` session is
 * labelled by its SESSION, never by the contributor its identity block claimed —
 * honouring an unverified claim is exactly how work gets laundered onto an
 * innocent student — and an `unattributed` session is described as unidentified,
 * which is an ordinary, blameless state and is worded so it does not read as a
 * finding.
 */
export function contributorLabel(scope: TimelineOrderScope, sessionId: string): string {
  const short = sessionId.slice(0, 8);
  const contributor = scope.contributorBySession.get(sessionId);
  if (contributor === undefined) return `session ${short}`;
  switch (contributor.kind) {
    case 'attributed':
      return `contributor ${contributor.studentRef.slice(0, 8)} (session ${short})`;
    case 'unverifiable':
      return `session ${short}, identity not verified`;
    case 'unattributed':
      return `session ${short}, contributor not identified`;
  }
}
