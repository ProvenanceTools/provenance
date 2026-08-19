/**
 * editing_pattern_clone cross-heuristic (Phase 18).
 *
 * PRD §7.4 cross-submission heuristics.
 *
 * Measures the similarity of editing behaviour between pairs of bundles using
 * Jaccard similarity over 3-grams of the event-kind stream. When the similarity
 * of a pair exceeds the threshold (default 0.3), a CrossFlag is emitted.
 *
 * Algorithm (A61 — Jaccard 3-gram, pair-wise):
 *   1. For each bundle, build a "kind stream": the ordered sequence of event
 *      kinds (e.g. ["session.start", "doc.change", "paste", "doc.save", ...]).
 *      All events from all sessions are concatenated in chronological order.
 *   2. Compute the multiset of 3-grams of the kind stream. Each 3-gram is a
 *      `"${k0}|${k1}|${k2}"` string. Use Set (not multiset) for Jaccard
 *      computation — distinct 3-gram types, not counts.
 *   3. Jaccard(A, B) = |A ∩ B| / |A ∪ B|.
 *   4. For every pair of bundles (O(N²), fine for N ≤ 10), if Jaccard ≥ threshold,
 *      emit one CrossFlag.
 *
 * Why Jaccard over kind-stream 3-grams?
 *   - The kind stream is insensitive to content (no privacy concerns).
 *   - 3-grams capture local editing rhythm without requiring global alignment.
 *   - Jaccard over a type-set (not multiset) avoids rewarding repetition
 *     (e.g., 10,000 doc.change events generate the same 3-gram set as 100).
 *   - Fast: O(N_events) per bundle + O(G²) for set intersection.
 *
 * Severity: medium (confidence 0.7). Jaccard over kind-streams is a
 * coarse signal; it fires on structurally similar workflows which is
 * indicative but not conclusive.
 *
 * Supporting events: all events from both bundles are too many to list.
 * We pick the first 5 events from each bundle as representative references.
 * Course staff reviews the full bundles via /compare split-pane.
 */

import type {
  CrossFlag,
  CrossHeuristic,
  CrossHeuristicConfig,
  CrossSubmissionFeatures,
} from './types.js';
import { NGRAM_SIZE } from './features.js';

/**
 * Capture signals whose absence changes the event-KIND alphabet this heuristic
 * fingerprints.
 *
 * This is currently every gated signal there is — `inline_content` used to be the
 * one exception, because it stripped content fields without removing any event,
 * and it has since been removed from the policy entirely. The list stays explicit
 * rather than collapsing to "anything disabled" because what matters here is the
 * *reason* a signal counts: it removes kinds from the stream. A future knob that
 * only thins a payload would belong outside this list, not inside it.
 */
const KIND_STREAM_SIGNALS = ['selection_change', 'focus_change', 'terminal'];

/**
 * Does this submission's recorded capture policy distort the kind-stream
 * fingerprint?
 *
 * The absence-vs-disabled rule (program spec §4) bites hard here. Jaccard over
 * 3-grams of the event-kind stream measures similarity against the size of the
 * kind alphabet: switch `selection.change` and `terminal.*` off and the alphabet
 * shrinks, the 3-gram vocabulary collapses toward "type, save, type, save", and
 * two students who have never met start scoring above the threshold. Because a
 * whole course shares one policy, that inflation would hit every pair in the
 * cohort at once — a cross-submission flag storm manufactured entirely by the
 * professor's capture settings.
 *
 * Renormalising the threshold per alphabet is a tuning decision, not a coding
 * one, so this heuristic takes the conservative reading the rule prescribes and
 * returns not-applicable for the affected submissions instead.
 */
function fingerprintIsPolicyDistorted(features: CrossSubmissionFeatures): boolean {
  const disabled = features.disabledCaptureSignals;
  if (disabled === undefined) return false;
  return disabled.some((s) => KIND_STREAM_SIGNALS.includes(s));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity between two sets.
 * Returns 0 when both sets are empty to avoid 0/0.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

// ---------------------------------------------------------------------------
// Cross-heuristic implementation
// ---------------------------------------------------------------------------

function run(features: CrossSubmissionFeatures[], config: CrossHeuristicConfig): CrossFlag[] {
  const { editingPatternCloneThreshold: threshold } = config;

  if (features.length < 2) return [];

  // Keep only submissions with enough events to form at least one n-gram. The
  // n-gram set is precomputed (CrossSubmissionFeatures.kindNgrams).
  const eligible = features.filter((f) => f.eventCount >= NGRAM_SIZE);

  if (eligible.length < 2) return [];

  const flags: CrossFlag[] = [];
  let flagIndex = 0;

  // Pair-wise Jaccard comparison — O(N²) over submissions.
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const aEntry = eligible[i]!;
      const bEntry = eligible[j]!;

      // Absence-vs-disabled (program spec §4): one policy-distorted fingerprint
      // is enough to make the comparison meaningless in the false-positive
      // direction, so the whole pair is not-applicable.
      if (fingerprintIsPolicyDistorted(aEntry) || fingerprintIsPolicyDistorted(bEntry)) continue;

      const score = jaccard(aEntry.kindNgrams, bEntry.kindNgrams);
      if (score < threshold) continue;

      const bundleIds = [aEntry.bundleId, bEntry.bundleId].sort();

      // Representative supporting events: the first few seq keys of each submission.
      const eventsPerBundle: Record<string, string[]> = {
        [aEntry.bundleId]: aEntry.representativeSeqKeys,
        [bEntry.bundleId]: bEntry.representativeSeqKeys,
      };

      const id = `editing_pattern_clone-${bundleIds.join('|')}-${flagIndex++}`;

      flags.push({
        id,
        heuristic: 'editing_pattern_clone',
        title: `Editing-pattern clone detected (Jaccard ${(score * 100).toFixed(0)}%)`,
        severity: 'medium',
        confidence: 0.7,
        bundleIds,
        eventsPerBundle,
        description:
          `The editing event-kind streams of ${aEntry.sourceFilename} and ` +
          `${bEntry.sourceFilename} share ${(score * 100).toFixed(0)}% of their ` +
          `${NGRAM_SIZE}-gram vocabulary (Jaccard similarity = ${score.toFixed(3)}, ` +
          `threshold = ${threshold}). Structurally similar workflows may indicate ` +
          `collaboration or shared external tooling.`,
        detail: {
          jaccardScore: score,
          ngramSize: NGRAM_SIZE,
          threshold,
          aNgramCount: aEntry.kindNgrams.size,
          bNgramCount: bEntry.kindNgrams.size,
          bundleA: aEntry.sourceFilename,
          bundleB: bEntry.sourceFilename,
        },
      });
    }
  }

  return flags;
}

export const editingPatternCloneHeuristic: CrossHeuristic = {
  id: 'editing_pattern_clone',
  label: 'Editing-pattern clone',
  run,
};
