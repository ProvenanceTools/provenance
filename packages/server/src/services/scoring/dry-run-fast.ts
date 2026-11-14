/**
 * dry-run fast path — re-score stored flag rows instead of re-running
 * heuristics.
 *
 * ## Why
 *
 * The full dry run (`recomputeSubmission(simulate=true)` per submission)
 * fetches and unzips every stored bundle, re-runs validation, and re-runs the
 * whole heuristic suite, sequentially, in the API process. Since events left
 * Postgres that is seconds on seed data and minutes on a real semester, and
 * the Tuning page fires one per adjustment.
 *
 * But the Tuning UI only changes weights and enabled flags, and a flag's score
 * contribution is
 *
 *     severity_weights[severity] × confidence × per_flag[id].weight
 *
 * (recompute-submission.ts `buildFlagRows`). Every enabled flag is stored with
 * its severity and confidence, so for a submission whose stored flags reflect
 * the active config, a weight / severity-weight change or a disable can be
 * scored EXACTLY from those rows — no bundle, no heuristics.
 *
 * ## When it is not exact (and the caller must take the full path)
 *
 * - A heuristic goes disabled → enabled: disabled flags are never stored, so
 *   there is nothing to re-weight (`fastPathConfigEligible` → false).
 * - Any `thresholds` change: thresholds change what is DETECTED, not how it
 *   is weighted (`fastPathConfigEligible` → false).
 * - A submission whose stored flags were not computed under the active config
 *   — stale / recomputing / errored, or ingested before the active config and
 *   never recomputed since (`isScoredUnderActive` → false).
 *
 * What the fast path deliberately does NOT show is analysis-core code drift
 * (a heuristic changed since a submission was scored). Its "before" is the
 * stored score and its "after" is the stored detections re-weighted, so the
 * diff is the effect of the config change alone. Committing still runs a real
 * recompute.
 *
 * Pure functions; no I/O.
 */

import { computeScore } from './compute.js';
import { resolvePerFlag, type ServerHeuristicConfig } from '../heuristics/config.js';
import type { Severity } from '@provenance/analysis-core/heuristics/types.js';

// ---------------------------------------------------------------------------
// Config eligibility
// ---------------------------------------------------------------------------

/**
 * Stable JSON for deep-equality of the opaque `thresholds` objects: object
 * keys sorted, so key order does not count as a change.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** A missing thresholds object and an empty one mean the same: no overrides. */
function thresholdsKey(t: Record<string, unknown> | undefined): string {
  return t === undefined ? '{}' : stableJson(t);
}

/**
 * Can `candidate` be previewed from flags stored under `active`?
 *
 * True iff no heuristic goes disabled → enabled and no thresholds differ.
 */
export function fastPathConfigEligible(
  active: ServerHeuristicConfig,
  candidate: ServerHeuristicConfig,
): boolean {
  const ids = new Set([...Object.keys(active.per_flag), ...Object.keys(candidate.per_flag)]);
  for (const id of ids) {
    const a = resolvePerFlag(active, id);
    const c = resolvePerFlag(candidate, id);
    if (c.enabled && !a.enabled) return false;
    if (thresholdsKey(a.thresholds) !== thresholdsKey(c.thresholds)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-submission eligibility
// ---------------------------------------------------------------------------

export type SubmissionScoringState = {
  recompute_status: string;
  heuristic_config_version: number;
  ingested_at: Date;
};

export type ActiveConfigStamp = {
  /** Active config version; 0 when the semester has no config row. */
  version: number;
  /** When the active config was set; null when there is no config row. */
  set_at: Date | null;
};

/**
 * Were this submission's stored flags computed under the active config?
 *
 * Two ways to know, because the two write paths stamp differently:
 * - recompute sets `submissions.heuristic_config_version` to the version it
 *   scored under;
 * - ingest leaves that column at its default (0) but reads the active config
 *   AFTER inserting the row, so a row with `ingested_at >= set_at` was scored
 *   under it. (The race goes the safe way: a config committed between insert
 *   and scoring makes `ingested_at < set_at`, which only sends the row down
 *   the exact full path.)
 *
 * Only `fresh` rows qualify: `stale`/`recomputing` mean a recompute is pending
 * or in flight and the stored flags may be about to change; `error` means the
 * last recompute failed and the flags may not match anything.
 */
export function isScoredUnderActive(
  sub: SubmissionScoringState,
  active: ActiveConfigStamp,
): boolean {
  if (sub.recompute_status !== 'fresh') return false;
  if (sub.heuristic_config_version === active.version) return true;
  if (active.set_at === null) return true;
  return sub.ingested_at.getTime() >= active.set_at.getTime();
}

// ---------------------------------------------------------------------------
// Re-scoring
// ---------------------------------------------------------------------------

export type StoredFlag = {
  heuristic_id: string;
  severity: string;
  confidence: number;
};

/**
 * Score a submission's stored flags under `candidate`, with the same formula
 * and the same disabled-flag rule as recompute-submission.ts `buildFlagRows`
 * (disabled → dropped entirely, so it no longer counts toward the tier).
 */
export function rescoreFromStoredFlags(
  storedFlags: readonly StoredFlag[],
  candidate: ServerHeuristicConfig,
): { score_total: number; score_max_severity: Severity } {
  const inputs: Array<{ severity: string; score_contribution: number }> = [];
  for (const f of storedFlags) {
    const perFlag = resolvePerFlag(candidate, f.heuristic_id);
    if (!perFlag.enabled) continue;
    const severityWeight =
      candidate.severity_weights[f.severity as keyof typeof candidate.severity_weights] ?? 0;
    inputs.push({
      severity: f.severity,
      score_contribution: severityWeight * f.confidence * perFlag.weight,
    });
  }
  return computeScore(inputs);
}
