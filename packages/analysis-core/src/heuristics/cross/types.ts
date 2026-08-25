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
import type { CrossScopePartition } from '../../coverage/cross-scope.js';

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
  /**
   * Every commit this submission's sessions were OBSERVED at, as
   * `commitNodeKey(repository, sha)` values — the `(repository, sha)` node keys
   * of `observedCommits(buildObservedDag(bundle))`.
   *
   * This is the same-scope exclusion key (spec S20, §5.2 L2). Two submissions
   * that share one of these are two views of the same repository: a git-native
   * submission's `.provenance/` is shared and add-only, so both partners' bundles
   * carry both partners' signed logs, and comparing them against each other
   * accuses the two people the course assigned to collaborate. See
   * `coverage/cross-scope.ts` for the decision, including why witnessed-only
   * commits are deliberately excluded from this list and why the
   * `ASSUMED_SINGLE_REPOSITORY` sentinel can never match on its own.
   *
   * Optional for the same reason `disabledCaptureSignals` is: this shape is
   * produced in two places and round-trips through plain JSON. **Absent means
   * "never computed", NOT "no commits"** — both read as no exclusion, so a
   * construction site that predates the field behaves exactly as it did before,
   * which fails toward comparing rather than toward silent suppression.
   */
  observedCommitKeys?: readonly string[];
  /**
   * Every session this submission's archive CARRIES, as
   * `sessionNodeKey(session_pubkey, session_id)` values.
   *
   * The second same-scope exclusion key, and the one that covers a shared
   * `.provenance/` whose recorders never observed a commit — git observation is
   * an optional capability, so the commit key is silently absent for a whole
   * class of honest partner pairs. Two submissions sharing one of these keys
   * physically contain one another's signed logs.
   *
   * Not a bare session id: the pubkey binds the key to something only that
   * session's private half could have produced, and unlike the log's sha256 it
   * is stable when a partner holds only a prefix of a still-growing file. See
   * `coverage/cross-scope.ts` for the rule, and for the cohort-fraction ceiling
   * that stops a staff-recorded starter session from unioning a whole cohort.
   *
   * Optional for the same reason the two fields above are, and read the same
   * way: **absent means "never computed", NOT "no sessions"**, which fails
   * toward comparing.
   */
  recordedSessionKeys?: readonly string[];
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
  /**
   * @param scopes - the repository-lineage partition, produced ONCE by
   *   `runCrossHeuristics` from `coverage/cross-scope.ts`. A heuristic may only
   *   ask it "are these two the same lineage?" — the class id is opaque, so no
   *   heuristic can re-derive, reinterpret or second-guess the suppression rule.
   *   Two submissions in one lineage are two views of ONE repository (a shared,
   *   add-only `.provenance/`), so comparing them against each other accuses the
   *   two people the course assigned to collaborate. See spec S20.
   */
  run(
    features: CrossSubmissionFeatures[],
    config: CrossHeuristicConfig,
    scopes: CrossScopePartition,
  ): CrossFlag[];
};
