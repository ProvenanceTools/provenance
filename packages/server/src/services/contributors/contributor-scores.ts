/**
 * Per-contributor scoring — D14.
 *
 * "Group scoring is per-contributor AND per-scope." The scope roll-up already
 * exists and is untouched: `submissions.score_total` / `score_max_severity` /
 * `flag_counts` keep their exact present meaning and still back the cohort
 * list. This module adds the other half — the same three values computed for
 * ONE contributor — because that is the only shape in which a grader can act on
 * one partner without implicating the other.
 *
 * ## The rule, and why the single-contributor case is special
 *
 * A flag carries `contributor_key`: the contributor it is charged to, or `''`
 * for SCOPE-LEVEL (§6 Rule 2 — a finding names a person only when the evidence
 * is established for that person; a flag whose supporting events span two
 * contributors, or none, names neither).
 *
 *  - **N > 1 contributors** — a contributor is charged exactly the flags
 *    bearing their key. Scope-level flags are charged to NOBODY. This is the
 *    load-bearing property: a flag earned by one partner must never score
 *    against the other.
 *
 *  - **exactly 1 contributor** — that contributor is charged EVERY flag,
 *    scope-level ones included, so their score equals the scope score exactly.
 *
 * The special case is not a convenience. It is what makes a solo submission
 * read identically to how it read before the cut-over: the students rollup sums
 * per-contributor scores, and if a solo student's per-contributor total omitted
 * the scope-level flags it would silently drop below their `score_total` and
 * every existing rollup number would move. It is also honest on its own terms —
 * with one contributor there is no innocent partner to protect, so "the scope"
 * and "the contributor" denote the same person.
 *
 * ## Zero contributors
 *
 * Legal (a bundle with no identity and no roster match). Nothing is charged to
 * anyone; the scope score still stands on `submissions`. Findings are not lost,
 * they are simply not attributed — which is the honest answer.
 */

import { and, eq } from 'drizzle-orm';
import { flags, submission_contributors } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { computeScore } from '../scoring/compute.js';
import { computeFlagCounts, type FlagCounts } from '../scoring/denorm.js';
import type { Severity } from '@provenance/analysis-core/heuristics/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The minimum a flag must expose to be scored. */
export interface ScorableFlag {
  heuristic_id: string;
  severity: string;
  confidence: number;
  score_contribution: number;
  /** `''` means scope-level — charged to no individual. */
  contributor_key: string;
}

export interface ContributorScore {
  contributor_key: string;
  score_total: number;
  score_max_severity: Severity;
  flag_counts: FlagCounts;
}

// ---------------------------------------------------------------------------
// The one definition
// ---------------------------------------------------------------------------

/**
 * Score each contributor from the submission's flags.
 *
 * Pure and total: every key in `contributorKeys` gets exactly one entry, in the
 * order given, including contributors charged nothing (a partner with no
 * findings must appear with a zero, not be absent — absence reads as "not a
 * contributor", which is a different and false claim).
 */
export function scoreContributors(
  contributorKeys: readonly string[],
  submissionFlags: readonly ScorableFlag[],
): ContributorScore[] {
  // The single-contributor case takes the whole scope score. See the header —
  // this is what keeps solo submissions byte-identical across the cut-over.
  const soleOwner = contributorKeys.length === 1;

  return contributorKeys.map((key) => {
    const owned = soleOwner
      ? submissionFlags
      : submissionFlags.filter((f) => f.contributor_key === key);

    const { score_total, score_max_severity } = computeScore(
      owned.map((f) => ({ severity: f.severity, score_contribution: f.score_contribution })),
    );

    return {
      contributor_key: key,
      score_total,
      score_max_severity,
      flag_counts: computeFlagCounts(
        owned.map((f) => ({
          heuristic_id: f.heuristic_id,
          severity: f.severity,
          confidence: f.confidence,
        })),
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Recompute and write every contributor's score for one submission.
 *
 * Reads the `flags` rows already persisted for the submission, so it is the
 * same input the scope score was computed from and the two cannot drift.
 * Idempotent — running it twice writes the same values.
 *
 * Call AFTER both `runAndStoreHeuristics` (which writes the flags) and
 * `storeContributors` (which writes the rows this updates).
 */
export async function applyContributorScores(
  db: DrizzleDb,
  submissionId: string,
): Promise<ContributorScore[]> {
  const contributorRows = await db
    .select({ contributor_key: submission_contributors.contributor_key })
    .from(submission_contributors)
    .where(eq(submission_contributors.submission_id, submissionId));

  if (contributorRows.length === 0) return [];

  const flagRows = await db
    .select({
      heuristic_id: flags.heuristic_id,
      severity: flags.severity,
      confidence: flags.confidence,
      score_contribution: flags.score_contribution,
      contributor_key: flags.contributor_key,
    })
    .from(flags)
    .where(eq(flags.submission_id, submissionId));

  const scores = scoreContributors(
    contributorRows.map((r) => r.contributor_key),
    flagRows,
  );

  // One UPDATE per contributor. A group is 2–4 people in practice and a solo
  // submission is one row, so this is not worth a CASE-expression bulk update
  // that would be considerably harder to read and to prove correct.
  for (const score of scores) {
    await db
      .update(submission_contributors)
      .set({
        score_total: score.score_total,
        score_max_severity: score.score_max_severity,
        flag_counts: score.flag_counts,
      })
      .where(
        and(
          eq(submission_contributors.submission_id, submissionId),
          eq(submission_contributors.contributor_key, score.contributor_key),
        ),
      );
  }

  return scores;
}
