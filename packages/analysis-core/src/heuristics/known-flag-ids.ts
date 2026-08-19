/**
 * known-flag-ids.ts — canonical enumeration of every `Flag.heuristic` /
 * `CrossFlag.heuristic` id the analysis-core engine can produce.
 *
 * A 2026-08 audit found two independent hand-maintained enumerations of "all
 * the heuristics" — the analyzer's TuningView and docs/heuristics.md — had
 * quietly drifted apart (each was missing a different id, so each still
 * looked internally consistent). This module exists so nothing has to
 * hand-maintain that list again: everything derives from the same three
 * registries the runtime actually uses.
 *
 * Ids come from exactly three places:
 *
 *   - `HEURISTIC_REGISTRY` (run-heuristics.ts): the per-submission
 *     event-stream heuristics. Each is a pure function over `EventIndex` +
 *     `Bundle`, lives in its own module with its own `.test.ts`, and has its
 *     own `HeuristicConfig` sub-section for threshold tuning.
 *   - `CHECK_META` (integrity-flags.ts): flags synthesized from a *failing*
 *     bundle-validation check (recorder PRD §5.4) — `manifest_sig_invalid`,
 *     `session_binding_invalid`, `chain_broken`, `monotonic_t_regression`,
 *     `monotonic_wall_regression`, `submitted_code_match`. These are not
 *     "heuristics" in the traditional sense (integrity-flags.ts's own
 *     comment: "an adapter, not a heuristic") — no event-stream analysis, no
 *     tunable thresholds — but they ARE ordinary `Flag` rows once produced,
 *     so course staff can still weight or disable them like any other flag.
 *   - `CROSS_HEURISTIC_REGISTRY` (cross/run-cross-heuristics.ts): heuristics
 *     that compare multiple bundles (`editing_pattern_clone`,
 *     `paste_shared_across_students`). Run through a separate entry point —
 *     only from the `/compare` view, never from `runHeuristics` — but still
 *     ordinary `Flag` rows once produced.
 *
 * Anything that needs to enumerate "all flag/heuristic ids" — the analyzer's
 * tuning UI (`TuningView.tsx`), `docs/heuristics.md` — should derive from
 * `ALL_FLAG_IDS` (or the individual category exports below) instead of
 * hand-maintaining a parallel list. See `known-flag-ids.test.ts` and the
 * analyzer's `heuristics-doc-sync.test.ts` for the regression guard.
 */

import { HEURISTIC_REGISTRY } from './run-heuristics.js';
import { CHECK_META } from './integrity-flags.js';
import { CROSS_HEURISTIC_REGISTRY } from './cross/run-cross-heuristics.js';

/** The per-submission event-stream heuristics run by `runHeuristics`. */
export const PER_SUBMISSION_HEURISTIC_IDS: readonly string[] = HEURISTIC_REGISTRY.map((h) => h.id);

/** The validation-report-derived integrity flags (`integrityFlagsFromReport`). */
export const INTEGRITY_FLAG_IDS: readonly string[] = Object.values(CHECK_META).map(
  (m) => m.heuristic,
);

/** The cross-submission heuristics run by `runCrossHeuristics` (only in `/compare`). */
export const CROSS_SUBMISSION_HEURISTIC_IDS: readonly string[] = CROSS_HEURISTIC_REGISTRY.map(
  (h) => h.id,
);

/**
 * Every flag/heuristic id the system can produce, across all three sources.
 * This is the single source of truth for "how many heuristics does
 * Provenance have" and for anything that must let staff tune every flag.
 */
export const ALL_FLAG_IDS: readonly string[] = [
  ...PER_SUBMISSION_HEURISTIC_IDS,
  ...INTEGRITY_FLAG_IDS,
  ...CROSS_SUBMISSION_HEURISTIC_IDS,
];
