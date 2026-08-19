/**
 * runCrossHeuristics — orchestrator for Phase 18 cross-bundle heuristics.
 *
 * Called by BundleContext after all bundles are loaded when bundles.length >= 2.
 * Pure synchronous function — no async, no I/O.
 *
 * Returns CrossFlag[] sorted:
 *   1. Severity descending (high → medium → low → info).
 *   2. Confidence descending.
 *   3. bundleIds[0] lexicographic ascending (stable tie-break).
 *   4. id lexicographic ascending.
 *
 * When bundles.length < 2, returns [] immediately (no cross-bundle work possible).
 */

import type {
  CrossFlag,
  CrossHeuristic,
  CrossHeuristicConfig,
  CrossSubmissionFeatures,
} from './types.js';
import { DEFAULT_CROSS_HEURISTIC_CONFIG } from './types.js';
import { pasteSharedAcrossStudentsHeuristic } from './paste-shared-across-students.js';
import { editingPatternCloneHeuristic } from './editing-pattern-clone.js';

// ---------------------------------------------------------------------------
// Registry
//
// Exported so known-flag-ids.ts can derive the canonical cross-submission
// heuristic id list from it, rather than a hand-maintained duplicate.
// ---------------------------------------------------------------------------

export const CROSS_HEURISTIC_REGISTRY: CrossHeuristic[] = [
  pasteSharedAcrossStudentsHeuristic,
  editingPatternCloneHeuristic,
];

// ---------------------------------------------------------------------------
// Severity sort order (mirrors per-bundle run-heuristics.ts)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

function severityRank(flag: CrossFlag): number {
  return SEVERITY_ORDER[flag.severity] ?? 99;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all cross-bundle heuristics and return a sorted CrossFlag list.
 *
 * @param features       - Per-submission cross features (must be >= 2 to produce any flags).
 * @param configOverride - Optional partial config override.
 */
export function runCrossHeuristics(
  features: CrossSubmissionFeatures[],
  configOverride?: Partial<CrossHeuristicConfig>,
): CrossFlag[] {
  if (features.length < 2) return [];

  const config: CrossHeuristicConfig = {
    ...DEFAULT_CROSS_HEURISTIC_CONFIG,
    ...configOverride,
  };

  const allFlags: CrossFlag[] = [];

  for (const heuristic of CROSS_HEURISTIC_REGISTRY) {
    const flags = heuristic.run(features, config);
    // Use a for-of append rather than `allFlags.push(...flags)` — spread-into-push
    // passes every element as a separate argument, which overflows the call stack
    // when a single heuristic returns tens of thousands of candidate flags
    // (observed on semesters with many overlapping paste-heavy submissions).
    for (const f of flags) allFlags.push(f);
  }

  // Sort: severity desc → confidence desc → bundleIds[0] lex asc → id lex asc.
  allFlags.sort((a, b) => {
    const sevDiff = severityRank(a) - severityRank(b);
    if (sevDiff !== 0) return sevDiff;

    const confDiff = b.confidence - a.confidence;
    if (confDiff !== 0) return confDiff;

    const bIdA = a.bundleIds[0] ?? '';
    const bIdB = b.bundleIds[0] ?? '';
    if (bIdA < bIdB) return -1;
    if (bIdA > bIdB) return 1;

    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return allFlags;
}
