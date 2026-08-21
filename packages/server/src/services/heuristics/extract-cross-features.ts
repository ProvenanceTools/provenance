/**
 * extractCrossFeaturesFromIndex — reduce one submission's EventIndex to the
 * compact CrossSubmissionFeatures the cross-heuristics need.
 *
 * The cross-heuristics only need a tiny per-submission slice (see
 * `@provenance/analysis-core/heuristics/cross/features.ts`): the paste events and
 * a bounded n-gram fingerprint of the event-kind stream. Extracting from the
 * already-parsed EventIndex keeps this pure and DB-free; run-cross.ts loads one
 * submission's bundle at a time (LRU-bounded) so peak memory stays bounded even
 * for large cohorts.
 *
 * ## globalIdx fidelity
 *
 * cross_flag_participants.supporting_seqs stores `globalIdx` values (the same
 * chronological index the analyzer/replay use). `EventIndex.ordered` is already
 * sorted by (wall, sessionId, seq) with `ordered[i].globalIdx === i`, so we read
 * globalIdx straight off the index and return a small seqKey→globalIdx map
 * covering only the events a cross-flag can reference (pastes + representatives).
 */

import {
  buildKindNgramSet,
  NGRAM_SIZE,
  observedCommitKeysOf,
  REPRESENTATIVE_EVENT_COUNT,
} from '@provenance/analysis-core/heuristics/cross/features.js';
import type {
  CrossSubmissionFeatures,
  CrossPasteFeature,
} from '@provenance/analysis-core/heuristics/cross/types.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import { resolveBundleCapturePolicy } from '@provenance/analysis-core/manifest/bundle-manifest.js';

export type ExtractedCrossFeatures = {
  features: CrossSubmissionFeatures;
  /**
   * Map from `${sessionId}:${seq}` to globalIdx, for exactly the events a
   * cross-flag may reference (all paste events + the leading representative
   * events). Used by run-cross.ts to translate eventsPerBundle seqKeys back to
   * supporting_seqs.
   */
  globalIdxBySeqKey: Map<string, number>;
};

/**
 * Reduce a parsed submission's EventIndex to CrossSubmissionFeatures.
 *
 * @param index        - The submission's EventIndex (from loadSubmissionIndex).
 * @param submissionId - UUID of the submission (used only for the display label).
 * @param bundleId     - Synthetic bundle id to tag the features with (caller keeps
 *                       the bundleId→submissionId mapping).
 */
export function extractCrossFeaturesFromIndex(
  index: EventIndex,
  submissionId: string,
  bundleId: string,
  /**
   * The parsed bundle the index came from, used only to read the recorded
   * capture policy. Optional so callers holding an index alone keep working;
   * absent means "nothing disabled", which is the truth for every 1.x bundle.
   *
   * editing_pattern_clone needs this: a course that switches a gated event kind
   * off shrinks the kind alphabet the fingerprint is built from, which inflates
   * Jaccard similarity across the whole cohort at once.
   *
   * It is also where the same-scope exclusion key comes from (spec S20): the
   * observed commit DAG is walked over the bundle's `git.event`s, which the
   * EventIndex alone does not carry the session grouping for. A caller with no
   * bundle therefore gets no `observedCommitKeys`, which reads as "never
   * computed" and suppresses nothing — the direction that fails toward
   * comparing rather than toward silence.
   */
  bundle?: Bundle,
): ExtractedCrossFeatures {
  const ordered = index.ordered;

  const kinds: string[] = new Array(ordered.length);
  const representativeSeqKeys: string[] = [];
  const globalIdxBySeqKey = new Map<string, number>();

  for (let i = 0; i < ordered.length; i++) {
    const ie = ordered[i]!;
    kinds[i] = ie.kind;
    const seqKey = `${ie.sessionId}:${ie.seq}`;
    if (i < REPRESENTATIVE_EVENT_COUNT) representativeSeqKeys.push(seqKey);
    // Only the events a cross-flag can reference need a globalIdx mapping:
    // the leading representatives (editing_pattern_clone) and pastes (paste_shared).
    if (ie.kind === 'paste' || i < REPRESENTATIVE_EVENT_COUNT) {
      globalIdxBySeqKey.set(seqKey, ie.globalIdx);
    }
  }

  const kindNgrams = buildKindNgramSet(kinds, NGRAM_SIZE);

  const pasteEvents = index.byKind.get('paste') ?? [];
  const pastes: CrossPasteFeature[] = pasteEvents.map((ie) => {
    const p =
      typeof ie.payload === 'object' && ie.payload !== null
        ? (ie.payload as Record<string, unknown>)
        : null;
    return {
      seqKey: `${ie.sessionId}:${ie.seq}`,
      sha256: p !== null && typeof p['sha256'] === 'string' ? (p['sha256'] as string) : undefined,
      content:
        p !== null && typeof p['content'] === 'string' ? (p['content'] as string) : undefined,
      length: p !== null && typeof p['length'] === 'number' ? (p['length'] as number) : 0,
    };
  });

  const features: CrossSubmissionFeatures = {
    bundleId,
    sourceFilename: `reconstruct-stub-${submissionId}`,
    pastes,
    kindNgrams,
    eventCount: ordered.length,
    representativeSeqKeys,
    ...(bundle === undefined
      ? {}
      : {
          disabledCaptureSignals: resolveBundleCapturePolicy(bundle).disabledSignals,
          // The SAME derivation the browser path uses — imported, never
          // reimplemented, so the two cannot drift into disagreeing about which
          // pairs are one repository.
          observedCommitKeys: observedCommitKeysOf(bundle),
        }),
  };

  return { features, globalIdxBySeqKey };
}
