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
 *     `monotonic_wall_regression`, `submitted_code_match` — plus three
 *     BUNDLE-LEVEL detections that deliberately sit outside the frozen eight
 *     and ride on `ValidationReport.bundleDetections` instead:
 *     `log_bytes_match`, `checkpoint_chain_valid`, `manifest_downgrade`.
 *     The distinction matters to `validation/check-types.ts` and to the
 *     server's eight `check_N_status` columns, but not here: all nine reach
 *     staff through the same adapter and are the same kind of row. These are not
 *     "heuristics" in the traditional sense (integrity-flags.ts's own
 *     comment: "an adapter, not a heuristic") — no event-stream analysis, no
 *     tunable thresholds — but they ARE ordinary `Flag` rows once produced,
 *     so course staff can still weight or disable them like any other flag.
 *   - `CROSS_HEURISTIC_REGISTRY` (cross/run-cross-heuristics.ts): heuristics
 *     that compare multiple bundles (today only
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
 * Ids the engine USED to produce and no longer does.
 *
 * Not part of `ALL_FLAG_IDS`: nothing emits them, so nothing should offer to
 * tune them. They are listed because stored data outlives a heuristic —
 * semester configs written while one existed still carry a `per_flag` entry for
 * it, and the server's config validator must accept that entry back on a PUT
 * rather than reject every existing semester's config as "unknown id".
 *
 *   - `editing_pattern_clone` (retired 2026-09). Jaccard over the SET of
 *     event-kind 3-grams. With ~20 event kinds the set saturates for anyone who
 *     works long enough, so the score measured session length, not
 *     collaboration: it fired on 94% of all student pairs in the 2026 summer
 *     pilot (11,320 of 12,090), and on the ~7.7k-submission fall semester its
 *     ~5.9M same-assignment pairs exhausted the worker heap on every attempt. No
 *     threshold or cap fixes that — either keeps the pairs with the LONGEST
 *     logs, which accuses the most diligent students first.
 */
export const RETIRED_FLAG_IDS: readonly string[] = ['editing_pattern_clone'];

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
