/**
 * dry-run scoring service — Phase 13b (updated from 13a per V30).
 *
 * computeDryRunDiff: given (semesterId, candidateConfig), computes each
 * non-superseded submission's prospective score — from its stored flags where
 * that is exact, otherwise via recomputeSubmission(simulate=true) — and
 * returns a diff payload per PRD §8.11.
 *
 * ## V30 fix: re-runs heuristics from DB events instead of re-weighting flags
 *
 * Phase 13a's implementation re-weighted existing flag rows rather than
 * re-running heuristic functions. This was documented as a known limitation
 * (V30) because threshold changes were not reflected.
 *
 * Phase 13b fixes this by calling recomputeSubmission(simulate=true) per
 * submission, which reconstructs a Bundle stub from DB events and runs the
 * full heuristic suite. The result correctly reflects weight changes AND
 * (since V46) threshold changes: per_flag[id].thresholds are forwarded to
 * v2's HeuristicConfig via thresholdsToV2Override in recompute-submission.ts.
 *
 * The old recomputeScore helper (weight-only) is removed as dead code.
 *
 * ## Histogram bucketing
 *
 * Upper bound = max(max(old_scores), max(new_scores)). This ensures both
 * histograms share the same bucket boundaries for direct comparison. If all
 * scores are 0, the upper bound is 1.0 to avoid zero-width buckets.
 *
 * ## Performance — fast path first
 *
 * The full per-submission recompute above fetches, unzips and re-validates
 * every stored bundle and re-runs every heuristic, sequentially, in the API
 * process: seconds on seed data, minutes on a real semester. (The old "~1ms
 * per submission, 800ms budget" note here dated from when events were read
 * from Postgres and stopped being true when they left it.)
 *
 * So each submission is first offered to the fast path (dry-run-fast.ts):
 * when the candidate only changes weights / severity weights or turns
 * heuristics OFF, and the submission's stored flags were computed under the
 * active config, its new score is the stored flags re-weighted — exact, and a
 * single flags query for the whole semester. Only submissions that fail that
 * test (stale, errored, ingested before the active config and never
 * recomputed), or every submission when the candidate re-enables a heuristic
 * or changes thresholds, take the full recompute.
 */

import { eq, isNull, and } from 'drizzle-orm';
import { submissions, roster_entries, assignments, flags } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { ServerHeuristicConfig } from '../heuristics/config.js';
import { recomputeSubmission } from './recompute-submission.js';
import {
  fastPathConfigEligible,
  isScoredUnderActive,
  rescoreFromStoredFlags,
  type StoredFlag,
} from './dry-run-fast.js';
import { DEFAULT_SERVER_CONFIG } from '../heuristics/config.js';
import { getStorageClient } from '../storage/default-client.js';
import { projectStudent } from '../protect.js';
import { fetchContributorsFor } from '../contributors/fetch-contributors.js';
import type { SubmissionContributor } from '@provenance/shared/api-schemas';
import type { Severity } from '@provenance/analysis-core/heuristics/types.js';

// ---------------------------------------------------------------------------
// DryRunDiff — PRD §8.11 response shape
// ---------------------------------------------------------------------------

export type TierMover = {
  submission_id: string;
  /**
   * The submitter of record, or null when no single roster entry owns this
   * submission (D9). Mirrors `TopMoverSchema.student` in `@provenance/shared`.
   */
  student: { id: string; sid: string; display_name: string } | null;
  /**
   * Everyone this submission is attributable to (D9). A mover row says "this
   * score moves by N"; on a group submission the score is the SCOPE's, so
   * naming only the submitter of record charges the swing to one arbitrary
   * partner. Exactly one entry, equal to `student`, for every solo submission.
   */
  contributors: SubmissionContributor[];
  assignment: { id: string; assignment_id_str: string; label: string };
  old_score: number;
  new_score: number;
  old_tier: Severity;
  new_tier: Severity;
};

export type DryRunDiff = {
  candidate_version: number;
  diff: {
    submissions_with_tier_change: number;
    top_movers: TierMover[];
    score_histogram_old: number[];
    score_histogram_new: number[];
    /** Exclusive upper bound for the top bucket (bucket width = bound / 10). */
    score_histogram_upper_bound: number;
  };
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Number of buckets in the score histogram. */
const HISTOGRAM_BUCKETS = 10;

/**
 * Build a 10-bucket histogram over scores.
 *
 * @param scores - Array of scores to bucket.
 * @param upperBound - Exclusive upper bound for the last bucket.
 *   Scores at exactly upperBound are placed in the last bucket.
 */
function buildHistogram(scores: number[], upperBound: number): number[] {
  const buckets = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
  if (upperBound <= 0 || scores.length === 0) return buckets;

  const step = upperBound / HISTOGRAM_BUCKETS;
  for (const score of scores) {
    // Clamp to [0, upperBound]; place at max bucket index if score === upperBound.
    const idx = Math.min(Math.floor(score / step), HISTOGRAM_BUCKETS - 1);
    buckets[idx]! += 1;
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// computeDryRunDiff
// ---------------------------------------------------------------------------

/**
 * Compute the prospective score diff for a candidate heuristic config.
 *
 * Does NOT write any rows to the DB.
 *
 * Each submission is either re-scored from its stored flags (the fast path,
 * when that is exact — see dry-run-fast.ts) or recomputed with
 * recomputeSubmission(simulate=true), which re-runs heuristics on the stored
 * bundle (V30, Phase 13b). V46 closed the
 * remaining gap so that threshold changes in per_flag[id].thresholds are
 * forwarded to v2's HeuristicConfig — not just weight/enabled changes.
 *
 * @param db - Drizzle DB handle.
 * @param semesterId - UUID of the semester.
 * @param candidateConfig - Candidate PRD §10.2 config (already validated by caller).
 * @param candidateVersion - The version number this candidate would receive if committed.
 * @param options.active - The active config row (null: none — DEFAULT at v0).
 * @param options.protectedMode - Mask student identities in top_movers.
 * @returns DryRunDiff per PRD §8.11.
 */
export async function computeDryRunDiff(
  db: DrizzleDb,
  semesterId: string,
  candidateConfig: ServerHeuristicConfig,
  candidateVersion: number,
  {
    active,
    protectedMode = false,
  }: {
    /**
     * The semester's active config row, or null when it has none (ingest then
     * scores with DEFAULT_SERVER_CONFIG at version 0). Required, not
     * defaulted: treating a semester that HAS a config as if it had none
     * would silently re-weight against the wrong baseline.
     */
    active: { config: ServerHeuristicConfig; version: number; set_at: Date } | null;
    protectedMode?: boolean;
  },
): Promise<DryRunDiff> {
  // Storage client for reading the stored bundle blobs (recompute reads them).
  const storage = getStorageClient();

  // -------------------------------------------------------------------------
  // Step 1: Enumerate non-superseded submissions in the semester.
  // Join roster_entries (student) and assignments for top_movers payload.
  // -------------------------------------------------------------------------
  const filteredSubmissions = await db
    .select({
      id: submissions.id,
      score_total: submissions.score_total,
      score_max_severity: submissions.score_max_severity,
      recompute_status: submissions.recompute_status,
      heuristic_config_version: submissions.heuristic_config_version,
      ingested_at: submissions.ingested_at,
      student_id: submissions.student_id,
      assignment_id: submissions.assignment_id,
      student_sid: roster_entries.sid,
      student_display_name: roster_entries.display_name,
      student_protected_index: roster_entries.protected_index,
      assignment_id_str: assignments.assignment_id_str,
      assignment_label: assignments.label,
    })
    .from(submissions)
    // LEFT, not INNER (D9). An INNER join here silently EXCLUDES a submission
    // with no single owning roster entry from the dry run entirely — it is
    // never recomputed, so the diff under-reports the effect of the config
    // change. If every submission dropped out the route would answer "your
    // change does nothing", which is a plausible-looking wrong answer rather
    // than a visible failure.
    //
    // Still one row per submission: contributors are fetched separately, so a
    // group bundle is recomputed ONCE, not once per partner. `recomputeSubmission`
    // is CPU-bound and sequential here.
    .leftJoin(roster_entries, eq(submissions.student_id, roster_entries.id))
    .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
    .where(
      and(eq(submissions.semester_id, semesterId), isNull(submissions.superseded_by_submission_id)),
    );

  if (filteredSubmissions.length === 0) {
    return {
      candidate_version: candidateVersion,
      diff: {
        submissions_with_tier_change: 0,
        top_movers: [],
        score_histogram_old: new Array<number>(HISTOGRAM_BUCKETS).fill(0),
        score_histogram_new: new Array<number>(HISTOGRAM_BUCKETS).fill(0),
        score_histogram_upper_bound: 1.0,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: For each submission, the prospective score under the candidate:
  // re-weighted stored flags where exact (fast path), otherwise heuristics
  // re-run with simulate=true (no writes). The slow path is sequential: the
  // heuristic suite is CPU-bound and Promise.all would only saturate the
  // thread. See "Performance" in the header for when each path applies.
  // -------------------------------------------------------------------------
  type SubmissionDiff = {
    submission_id: string;
    /** Null when no single roster entry owns this submission (D9). */
    student_id: string | null;
    student_sid: string | null;
    student_display_name: string | null;
    student_protected_index: number | null;
    assignment_id: string;
    assignment_id_str: string;
    assignment_label: string;
    old_score: number;
    new_score: number;
    old_tier: Severity;
    new_tier: Severity;
  };

  const diffs: SubmissionDiff[] = [];

  // Fast path (dry-run-fast.ts): re-weight stored flags where that is exact.
  const activeConfig = active?.config ?? DEFAULT_SERVER_CONFIG;
  const activeStamp = { version: active?.version ?? 0, set_at: active?.set_at ?? null };
  const configEligible = fastPathConfigEligible(activeConfig, candidateConfig);
  const fastIds = new Set(
    configEligible
      ? filteredSubmissions.filter((s) => isScoredUnderActive(s, activeStamp)).map((s) => s.id)
      : [],
  );

  // One query for the whole semester's stored flags (flags_sem_* indexes),
  // filtered in memory to the fast submissions — not an IN list of hundreds.
  const storedBySubmission = new Map<string, StoredFlag[]>();
  if (fastIds.size > 0) {
    const rows = await db
      .select({
        submission_id: flags.submission_id,
        heuristic_id: flags.heuristic_id,
        severity: flags.severity,
        confidence: flags.confidence,
      })
      .from(flags)
      .where(eq(flags.semester_id, semesterId));
    for (const row of rows) {
      if (!fastIds.has(row.submission_id)) continue;
      const list = storedBySubmission.get(row.submission_id);
      if (list) list.push(row);
      else storedBySubmission.set(row.submission_id, [row]);
    }
  }

  for (const sub of filteredSubmissions) {
    const { score_total: new_score, score_max_severity: new_tier } = fastIds.has(sub.id)
      ? rescoreFromStoredFlags(storedBySubmission.get(sub.id) ?? [], candidateConfig)
      : await recomputeSubmission(
          db,
          storage,
          sub.id,
          semesterId,
          candidateConfig,
          candidateVersion,
          { simulate: true },
        );

    diffs.push({
      submission_id: sub.id,
      student_id: sub.student_id,
      student_sid: sub.student_sid,
      student_display_name: sub.student_display_name,
      student_protected_index: sub.student_protected_index,
      assignment_id: sub.assignment_id,
      assignment_id_str: sub.assignment_id_str,
      assignment_label: sub.assignment_label,
      old_score: sub.score_total,
      new_score,
      old_tier: sub.score_max_severity as Severity,
      new_tier,
    });
  }

  // -------------------------------------------------------------------------
  // Step 3: submissions_with_tier_change count.
  // -------------------------------------------------------------------------
  const withTierChange = diffs.filter((d) => d.old_tier !== d.new_tier).length;

  // -------------------------------------------------------------------------
  // Step 4: top_movers — top 20 by |new_score - old_score| descending.
  // -------------------------------------------------------------------------
  const sorted = [...diffs].sort(
    (a, b) => Math.abs(b.new_score - b.old_score) - Math.abs(a.new_score - a.old_score),
  );
  const movers = sorted.slice(0, 20);

  // Only the 20 rows that are actually returned — the dry run recomputes every
  // submission in the semester, and fetching contributors for all of them to
  // render 20 would cost the §10.5 latency budget for nothing.
  const contributorsBySubmission = await fetchContributorsFor(
    db,
    movers.map((d) => d.submission_id),
    protectedMode,
  );

  const topMovers: TierMover[] = movers.map((d) => ({
    submission_id: d.submission_id,
    contributors: contributorsBySubmission.get(d.submission_id) ?? [],
    student:
      d.student_id === null || d.student_sid === null || d.student_display_name === null
        ? null
        : projectStudent(
            {
              id: d.student_id,
              sid: d.student_sid,
              display_name: d.student_display_name,
              protected_index: d.student_protected_index,
            },
            protectedMode,
          ),
    assignment: {
      id: d.assignment_id,
      assignment_id_str: d.assignment_id_str,
      label: d.assignment_label,
    },
    old_score: d.old_score,
    new_score: d.new_score,
    old_tier: d.old_tier,
    new_tier: d.new_tier,
  }));

  // -------------------------------------------------------------------------
  // Step 5: Histograms.
  // Upper bound = max(max(old_scores), max(new_scores)), floor 1.0 for safety.
  // This shared upper bound ensures both histograms use identical bucket widths
  // for direct visual comparison in the UI.
  // -------------------------------------------------------------------------
  const oldScores = diffs.map((d) => d.old_score);
  const newScores = diffs.map((d) => d.new_score);

  const upperBound = Math.max(
    oldScores.length > 0 ? Math.max(...oldScores) : 0,
    newScores.length > 0 ? Math.max(...newScores) : 0,
    1.0, // floor to avoid zero-width buckets when all scores are 0
  );

  const scoreHistogramOld = buildHistogram(oldScores, upperBound);
  const scoreHistogramNew = buildHistogram(newScores, upperBound);

  return {
    candidate_version: candidateVersion,
    diff: {
      submissions_with_tier_change: withTierChange,
      top_movers: topMovers,
      score_histogram_old: scoreHistogramOld,
      score_histogram_new: scoreHistogramNew,
      score_histogram_upper_bound: upperBound,
    },
  };
}
