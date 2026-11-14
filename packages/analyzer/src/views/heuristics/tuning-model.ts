/**
 * tuning-model.ts — pure helpers behind the Tuning page.
 *
 * Everything here compares a candidate heuristic config against the active
 * one: which rows differ, whether any heuristic goes from disabled to enabled
 * (the one edit the server cannot dry-run on its fast path), a stable key that
 * identifies a candidate so a dry-run result can be matched back to the
 * config it was computed for, and the honest one-line impact summary.
 */

import type { DryRunDiff, HeuristicConfigBody } from '@provenance/shared/api-schemas';

export type FlagSetting = HeuristicConfigBody['per_flag'][string];
export type DryRunDiffBody = DryRunDiff['diff'];
export type TopMover = DryRunDiffBody['top_movers'][number];

/** A config with no entry for an id runs it enabled at weight 1.0. */
export const DEFAULT_FLAG_SETTING: FlagSetting = { enabled: true, weight: 1.0 };

/** Weights travel through a 0.1-step range input; compare with a tolerance. */
const WEIGHT_EPSILON = 1e-9;

/** Movers whose score moves by no more than this are "unchanged" (display rounds to 0.1). */
export const MOVER_DELTA_EPSILON = 0.005;

/** The summary's "scores move" count uses a coarser threshold than the table. */
export const SUMMARY_DELTA_THRESHOLD = 0.05;

/** The server returns at most this many top movers (services/scoring/dry-run.ts). */
export const MAX_TOP_MOVERS = 20;

export function flagSetting(config: HeuristicConfigBody, id: string): FlagSetting {
  return config.per_flag[id] ?? DEFAULT_FLAG_SETTING;
}

export function isFlagModified(
  active: HeuristicConfigBody,
  candidate: HeuristicConfigBody,
  id: string,
): boolean {
  const a = flagSetting(active, id);
  const c = flagSetting(candidate, id);
  return a.enabled !== c.enabled || Math.abs(a.weight - c.weight) > WEIGHT_EPSILON;
}

/** The shown ids whose setting differs from the active config, in display order. */
export function modifiedIds(
  ids: readonly string[],
  active: HeuristicConfigBody,
  candidate: HeuristicConfigBody,
): string[] {
  return ids.filter((id) => isFlagModified(active, candidate, id));
}

/**
 * Ids that are disabled in the active config and enabled in the candidate.
 * Any of these forces the server's slow path (a full heuristics re-run over
 * every submission), so the page never dry-runs such a candidate unasked.
 */
export function reEnabledIds(
  ids: readonly string[],
  active: HeuristicConfigBody,
  candidate: HeuristicConfigBody,
): string[] {
  return ids.filter((id) => !flagSetting(active, id).enabled && flagSetting(candidate, id).enabled);
}

/**
 * A deterministic key for a candidate over the shown ids. Two candidates with
 * the same key send the same tunable settings, so a dry-run result is only
 * ever displayed for the candidate whose key it was requested under.
 */
export function candidateKey(ids: readonly string[], candidate: HeuristicConfigBody): string {
  return ids
    .map((id) => {
      const s = flagSetting(candidate, id);
      return `${id}:${s.enabled ? 1 : 0}:${s.weight.toFixed(4)}`;
    })
    .join('|');
}

/** Copy the active setting for `id` back onto the candidate (or drop it if the active has none). */
export function resetFlag(
  active: HeuristicConfigBody,
  candidate: HeuristicConfigBody,
  id: string,
): HeuristicConfigBody {
  const perFlag = { ...candidate.per_flag };
  const activeSetting = active.per_flag[id];
  if (activeSetting) perFlag[id] = { ...activeSetting };
  else delete perFlag[id];
  return { ...candidate, per_flag: perFlag };
}

export function updateFlag(
  candidate: HeuristicConfigBody,
  id: string,
  patch: Partial<FlagSetting>,
): HeuristicConfigBody {
  return {
    ...candidate,
    per_flag: { ...candidate.per_flag, [id]: { ...flagSetting(candidate, id), ...patch } },
  };
}

/** `large_paste` → `Large paste`. */
export function humanizeId(id: string): string {
  const spaced = id.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Movers whose score actually changes — the server also lists 0.0 → 0.0 rows. */
export function changedMovers(movers: readonly TopMover[]): TopMover[] {
  return movers.filter((m) => Math.abs(m.new_score - m.old_score) > MOVER_DELTA_EPSILON);
}

/**
 * The footer's one-line impact summary.
 *
 * The API returns only the top movers by |Δ|, not every submission, so the
 * "scores move" count is exact only when it is below what the list can show.
 * Movers arrive sorted by |Δ| descending, so if fewer than all listed movers
 * clear the threshold, nothing beyond the list can either; if every slot of a
 * full list clears it, there may be more, and the summary says "20+".
 */
export function impactSummary(diff: DryRunDiffBody): string {
  const tier = diff.submissions_with_tier_change;
  const tierPart = `${tier} ${tier === 1 ? 'submission changes' : 'submissions change'} tier`;
  const listed = diff.top_movers.length;
  const moved = diff.top_movers.filter(
    (m) => Math.abs(m.new_score - m.old_score) > SUMMARY_DELTA_THRESHOLD,
  ).length;
  let movePart: string;
  if (moved === 0) {
    movePart = 'no scores move by more than 0.05';
  } else if (moved === listed && listed >= MAX_TOP_MOVERS) {
    movePart = `${MAX_TOP_MOVERS}+ scores move by more than 0.05`;
  } else {
    movePart = `${moved} ${moved === 1 ? 'score moves' : 'scores move'} by more than 0.05`;
  }
  return `${tierPart} · ${movePart}`;
}
