/**
 * dry-run scoring service — Phase 13b (updated from 13a per V30).
 *
 * computeDryRunDiff: given (semesterId, candidateConfig), runs heuristics
 * against DB events for each non-superseded submission (via recomputeSubmission
 * with simulate=true) and returns a diff payload per PRD §8.11.
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
 * ## Performance
 *
 * O(n_submissions × heuristic_cost). PRD §10.5 budget: must complete within
 * 800ms server-side for ≤ 1000 submissions. Each simulate call is ~1ms p99
 * for typical bundles (no I/O beyond DB event read). For large semesters the
 * rate limit kicks in.
 */

import { eq, isNull, and } from 'drizzle-orm';
import { submissions, roster_entries, assignments } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { ServerHeuristicConfig } from '../heuristics/config.js';
import { recomputeSubmission } from './recompute-submission.js';
import { getStorageClient } from '../storage/default-client.js';
import { projectStudent } from '../protect.js';
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
 * V30 fix (Phase 13b): this now calls recomputeSubmission(simulate=true) per
 * submission, which re-runs heuristics from DB events. V46 closed the
 * remaining gap so that threshold changes in per_flag[id].thresholds are
 * forwarded to v2's HeuristicConfig — not just weight/enabled changes.
 *
 * @param db - Drizzle DB handle.
 * @param semesterId - UUID of the semester.
 * @param candidateConfig - Candidate PRD §10.2 config (already validated by caller).
 * @param candidateVersion - The version number this candidate would receive if committed.
 * @returns DryRunDiff per PRD §8.11.
 */
export async function computeDryRunDiff(
  db: DrizzleDb,
  semesterId: string,
  candidateConfig: ServerHeuristicConfig,
  candidateVersion: number,
  protectedMode: boolean = false,
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
  // Step 2: For each submission, run heuristics with simulate=true (no writes)
  // to get the prospective score under the candidate config.
  //
  // This is sequential (Promise.all would be fine for reads-only, but the
  // heuristic suite is CPU-bound; sequential avoids saturating the thread).
  // For ≤ 1000 submissions at ~1ms p99 each this stays within the 800ms budget.
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

  for (const sub of filteredSubmissions) {
    const { score_total: new_score, score_max_severity: new_tier } = await recomputeSubmission(
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
  const topMovers: TierMover[] = sorted.slice(0, 20).map((d) => ({
    submission_id: d.submission_id,
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
