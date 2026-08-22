/**
 * useServerScope — the reconstruction scope for a SERVER-BACKED submission view.
 *
 * `/local` parses a ZIP, so it can call `reconstructionScopeFor(bundle, index)`
 * and get the relation, the contributor stamp and everything downstream. The
 * server-backed tabs page `EventRow`s and never see a bundle, so until now they
 * had no scope at all. Both surfaces that reason about order paid for it:
 *
 *  - **Replay** mounted `ReplayInner` with no scope, so `useReplayEngine` took
 *    `soloReconstructionScope` and reconstructed two partners' concurrent work
 *    as one linear keystroke sequence, with the contributor switcher and the
 *    branched view unreachable.
 *  - **Timeline** passed no scope, so `orderTimelineEvents` returned the index's
 *    own `globalIdx` order — which is WALL-derived, and across two machines can
 *    contradict proven happens-before — with no break markers.
 *
 * Both were the same missing input, and this is the one place that supplies it.
 * Two hooks would be two chances to disagree about who recorded what for the
 * same submission, on two tabs a grader flips between.
 *
 * ## What it is built from
 *
 * The index (already paged) plus `SubmissionSummary.contributor_stamp` (the
 * server's own `establishBundleContributors` verdict, projected onto the wire).
 * Nothing else: `sessionsFromIndex` recovers the per-session event shape the
 * observed DAG and the happens-before relation read, and neither reads a hash.
 *
 * ## Cost
 *
 * `buildReconstructionScopeFromSessions` builds NOTHING for a scope without two
 * provably different contributors — no DAG, no reachability closure — and
 * returns the `ordering: null` scope, which is exactly the solo scope this
 * replaces. Every existing solo submission is therefore unaffected in behaviour
 * and in cost. A missing stamp (an older server) reads as unstamped and lands in
 * the same place, which fails toward today's behaviour rather than toward a
 * refusal to answer.
 */

import { useMemo } from 'react';
import { sessionsFromIndex } from '@provenance/analysis-core/index/build-index.js';
import { buildReconstructionScopeFromSessions } from '@provenance/analysis-core/index/reconstruct-segments.js';
import { fromWireBundleContributors } from '@provenance/analysis-core/identity/wire.js';
import type { ReconstructionScope } from '@provenance/analysis-core/index/reconstruct-segments.js';
import type { BundleContributors } from '@provenance/analysis-core/identity/types.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { SubmissionSummary } from '@provenance/shared/api-schemas';

export type ServerScope = {
  /** Structurally satisfies `TimelineOrderScope` as well — one object, both tabs. */
  scope: ReconstructionScope;
  /**
   * The bundle-level stamp, for the contributor switcher. `null` when the
   * server sent none — an older deployment, or a bundle with no stamp. Rendered
   * as "no switcher", never as "no contributors".
   */
  contributors: BundleContributors | null;
};

/**
 * @param index   The whole-submission index, or `null` while it loads.
 * @param summary The submission summary, or `undefined` while it loads. Only
 *                `contributor_stamp` is read.
 */
export function useServerScope(
  index: EventIndex | null,
  summary: SubmissionSummary | undefined,
): ServerScope | null {
  // Read through a local so the memo depends on the stamp rather than on the
  // whole summary object, which changes identity on every refetch and would
  // rebuild the relation for a submission whose events did not move.
  const stamp = summary?.contributor_stamp;

  return useMemo(() => {
    if (index === null) return null;
    const contributors: BundleContributors | null =
      stamp === undefined ? null : fromWireBundleContributors(stamp);
    return {
      scope: buildReconstructionScopeFromSessions(
        sessionsFromIndex(index),
        contributors?.bySession ?? new Map(),
        index,
      ),
      contributors,
    };
  }, [index, stamp]);
}
