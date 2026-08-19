/**
 * CrossFlag — a heuristic finding that spans multiple bundles.
 *
 * Phase 18 introduces cross-bundle heuristics (paste_shared_across_students,
 * editing_pattern_clone). Unlike a per-bundle Flag (which references events in
 * one bundle), a CrossFlag names the involved bundles and, per bundle, the
 * supporting event seq keys.
 *
 * Shape choices (A59):
 *   - Separate type from Flag to keep Flag clean (no optional bundle fields
 *     that are always null for per-bundle heuristics).
 *   - `eventsPerBundle` is a plain object (Record<bundleId, seqKey[]>) rather
 *     than a Map so it round-trips through JSON and React state without issues.
 *   - Severity + confidence reuse the same Severity union from Flag so UI
 *     rendering components need no changes.
 */

import type { Severity } from '../types.js';

/**
 * A single cross-bundle heuristic finding.
 *
 * `id` — deterministic: `${heuristic}-${bundleIds.sort().join('|')}-${index}`
 *
 * `heuristic` — matches the registered cross-heuristic id
 *   (e.g. `paste_shared_across_students`, `editing_pattern_clone`).
 *
 * `bundleIds` — the Bundle.id values involved. Always length >= 2.
 *
 * `eventsPerBundle` — for each bundleId, an array of `${sessionId}:${seq}`
 *   keys (same format as Flag.supportingSeqs) for the supporting events in
 *   that bundle. Use to deep-link into each bundle's timeline.
 */
export type CrossFlag = {
  id: string;
  heuristic: string;
  title: string;
  severity: Severity;
  confidence: number; // 0..1
  bundleIds: string[]; // always >= 2
  eventsPerBundle: Record<string, string[]>; // bundleId → seqKey[]
  description: string;
  detail?: Record<string, unknown>;
};

/**
 * A single paste event reduced to the fields the paste_shared heuristic needs.
 * `length` is the paste size in characters; `seqKey` is `${sessionId}:${seq}`.
 */
export type CrossPasteFeature = {
  seqKey: string;
  sha256: string | undefined;
  content: string | undefined;
  length: number;
};

/**
 * The compact, memory-bounded representation of one submission that the
 * cross-heuristics consume in place of a full Bundle + EventIndex.
 *
 * See `features.ts` for extraction. `kindNgrams` is the editing-pattern
 * fingerprint (a Set whose size is bounded by the event-kind alphabet, not the
 * event count); `pastes` carry the paste-sharing inputs; `representativeSeqKeys`
 * are the first few events used as deep-link references in editing-pattern flags.
 */
export type CrossSubmissionFeatures = {
  bundleId: string;
  sourceFilename: string;
  pastes: CrossPasteFeature[];
  kindNgrams: Set<string>;
  /** Total event count (used to skip submissions with too few events to n-gram). */
  eventCount: number;
  representativeSeqKeys: string[];
  /**
   * Gated capture signals the course disabled for this submission (program spec
   * §4), e.g. `['terminal', 'selection_change']`. Empty or absent means nothing
   * was disabled — which is the truth for every 1.x bundle.
   *
   * `editing_pattern_clone` fingerprints the event-KIND stream, so a course that
   * switches a gated kind off shrinks the kind alphabet and inflates Jaccard
   * similarity between two unrelated students. The heuristic consults this and
   * returns not-applicable rather than flagging on a policy-distorted
   * fingerprint.
   *
   * Optional because this shape is produced in two places (the browser from a
   * Bundle, the server by streaming) and round-trips through plain JSON; absent
   * is read as "nothing disabled", which keeps every existing construction site
   * — and every 1.x submission — behaving exactly as before.
   */
  disabledCaptureSignals?: readonly string[];
};

/**
 * Interface for cross-bundle heuristics.
 *
 * `run` is a pure synchronous function: no async, no I/O, no side effects.
 * It receives the per-submission CrossSubmissionFeatures and config.
 * Returns CrossFlag[] (empty if no pattern found).
 *
 * Called by runCrossHeuristics only when features.length >= 2.
 */
export type CrossHeuristicConfig = {
  /** paste_shared_across_students: minimum paste length (chars) to consider. */
  pasteSharedMinLength: number;
  /** paste_shared_across_students: minimum diffLines ratio for fuzzy grouping. */
  pasteSharedFuzzyThreshold: number;
  /** editing_pattern_clone: 3-gram Jaccard threshold above which to flag. */
  editingPatternCloneThreshold: number;
};

export const DEFAULT_CROSS_HEURISTIC_CONFIG: CrossHeuristicConfig = {
  pasteSharedMinLength: 100,
  pasteSharedFuzzyThreshold: 0.9,
  editingPatternCloneThreshold: 0.3,
};

export type CrossHeuristic = {
  id: string;
  label: string;
  run(features: CrossSubmissionFeatures[], config: CrossHeuristicConfig): CrossFlag[];
};
