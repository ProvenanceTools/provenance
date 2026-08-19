/**
 * runHeuristics — orchestrator for the v1 + v2 heuristics suite (Phases 4, 16, 17).
 *
 * Runs each registered heuristic in a fixed order (registry list), collects
 * all flags, adds integrity flags from the validation report, then sorts the
 * combined result:
 *   1. Severity descending (high → medium → low → info).
 *   2. Confidence descending.
 *   3. supportingSeqs[0] lexicographic ascending (stable tie-break for snapshot
 *      tests and flag export — deterministic across runs).
 *
 * All heuristics are pure synchronous functions; the orchestrator is also
 * synchronous. No async, no I/O, no side effects.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { ValidationReport } from '../validation/check-types.js';
import type { Flag, Heuristic } from './types.js';
import { mergeConfig } from './config.js';
import type { HeuristicConfig } from './config.js';
import { largePasteHeuristic } from './large-paste.js';
import { externalEditsHeuristic } from './external-edits.js';
import { lowTypingHighOutputHeuristic } from './low-typing-high-output.js';
import { integrityFlagsFromReport } from './integrity-flags.js';
import { pasteIsSolutionHeuristic } from './paste-is-solution.js';
import { massExternalReplacementHeuristic } from './mass-external-replacement.js';
import { timeToFirstSaveAnomalyHeuristic } from './time-to-first-save-anomaly.js';
import { idleThenCompleteHeuristic } from './idle-then-complete.js';
import { noIntermediateErrorsHeuristic } from './no-intermediate-errors.js';
import { pasteMatchesKnownSourceHeuristic } from './paste-matches-known-source.js';
// Phase 17 — environment + integrity heuristics
import { aiExtensionActiveHeuristic } from './ai-extension-active.js';
import { shellIntegrationDisabledHeuristic } from './shell-integration-disabled.js';
import { extensionSetChangedMidAssignmentHeuristic } from './extension-set-changed-mid-assignment.js';
import { terminalActiveDuringExternalChangeHeuristic } from './terminal-active-during-external-change.js';
import { clockJumpsHeuristic } from './clock-jumps.js';
import { gapInHeartbeatsHeuristic } from './gap-in-heartbeats.js';
import { multipleSessionsOverlapHeuristic } from './multiple-sessions-overlap.js';
import { extensionHashMismatchHeuristic } from './extension-hash-mismatch.js';
import { interSessionExternalChangeHeuristic } from './inter-session-external-change.js';

// ---------------------------------------------------------------------------
// Registry
//
// The registry order is the documented evaluation order. Phase 17 heuristics
// follow Phase 16 in the registry (environment before integrity ordering).
//
// Exported (not just used locally) so known-flag-ids.ts can derive the
// canonical per-submission heuristic id list from it, rather than a
// hand-maintained duplicate — see known-flag-ids.ts.
// ---------------------------------------------------------------------------

export const HEURISTIC_REGISTRY: Heuristic[] = [
  // Phase 4 — v1 core
  largePasteHeuristic,
  externalEditsHeuristic,
  interSessionExternalChangeHeuristic,
  lowTypingHighOutputHeuristic,
  // Phase 16 — process-shape
  pasteIsSolutionHeuristic,
  massExternalReplacementHeuristic,
  timeToFirstSaveAnomalyHeuristic,
  idleThenCompleteHeuristic,
  noIntermediateErrorsHeuristic,
  pasteMatchesKnownSourceHeuristic,
  // Phase 17 — environment
  aiExtensionActiveHeuristic,
  shellIntegrationDisabledHeuristic,
  extensionSetChangedMidAssignmentHeuristic,
  terminalActiveDuringExternalChangeHeuristic,
  // Phase 17 — integrity
  clockJumpsHeuristic,
  gapInHeartbeatsHeuristic,
  multipleSessionsOverlapHeuristic,
  extensionHashMismatchHeuristic,
];

// ---------------------------------------------------------------------------
// Severity sort order (high → medium → low → info)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

function severityRank(flag: Flag): number {
  return SEVERITY_ORDER[flag.severity] ?? 99;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full v1 + v2 heuristic suite and return a sorted flag list.
 *
 * @param index          - EventIndex built from the bundle (from buildIndex).
 * @param bundle         - The fully-loaded bundle.
 * @param validationReport - Output of runValidation; used by the integrity
 *                         adapter (integrity-flags.ts) to surface chain breaks.
 * @param configOverride - Optional partial config override. Missing fields fall
 *                         back to DEFAULT_HEURISTIC_CONFIG.
 */
export function runHeuristics(
  index: EventIndex,
  bundle: Bundle,
  validationReport: ValidationReport,
  configOverride?: Partial<HeuristicConfig>,
): Flag[] {
  const config = mergeConfig(configOverride);

  const allFlags: Flag[] = [];

  // Run each registered heuristic in fixed registry order.
  for (const heuristic of HEURISTIC_REGISTRY) {
    const flags = heuristic.run(index, bundle, config);
    allFlags.push(...flags);
  }

  // Add integrity flags from the validation report.
  const integrityFlags = integrityFlagsFromReport(validationReport);
  allFlags.push(...integrityFlags);

  // Sort: severity desc → confidence desc → supportingSeqs[0] lex asc → id lex asc.
  allFlags.sort((a, b) => {
    const sevDiff = severityRank(a) - severityRank(b);
    if (sevDiff !== 0) return sevDiff;

    const confDiff = b.confidence - a.confidence;
    if (confDiff !== 0) return confDiff;

    const seqA = a.supportingSeqs[0] ?? '';
    const seqB = b.supportingSeqs[0] ?? '';
    if (seqA < seqB) return -1;
    if (seqA > seqB) return 1;

    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return allFlags;
}
