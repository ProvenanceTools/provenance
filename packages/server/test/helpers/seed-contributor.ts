/**
 * Shared test helper: give a seeded submission the contributor row that every
 * real submission has.
 *
 * ## Why a fixture without one is testing an impossible state
 *
 * Since migration 0029 a submission is linked to the people it is attributable
 * to through `submission_contributors`, and EVERY submission in a real database
 * has at least one row there:
 *
 *  - rows that predate 0029 were given exactly one by the migration's backfill,
 *    naming their `student_id` and carrying their own score;
 *  - rows created since are written by `finalizeContributors`, inside the same
 *    transaction as the submission itself, on all three write paths (ingest,
 *    recompute, manual attach). If it fails, the submission does not exist
 *    either.
 *
 * So a test that inserts a `submissions` row directly and stops there is
 * describing a state production cannot reach — and the read paths that go
 * through the join table (the students rollup, the cohort list's student
 * filter, the assignment stats' distinct-student count) correctly return
 * nothing for it.
 *
 * Call this immediately after seeding a submission whenever the test exercises
 * one of those paths. It is deliberately NOT folded into every local
 * `seedSubmission` helper: a fixture that wants a submission with NO
 * contributors — the "no single owning student, nobody nameable" shape — is a
 * legitimate thing to build, and it should have to say so by not calling this.
 */

import { submission_contributors } from '../../src/db/schema.js';
import type { DrizzleDb } from '../../src/db/client.js';

export interface SeedContributorOptions {
  /**
   * The contributor's own score. Defaults to zero.
   *
   * For a SOLE contributor this should mirror the submission's own
   * `score_total` / `score_max_severity`, because that is what both the 0029
   * backfill and `scoreContributors` produce: with one contributor there is no
   * partner to protect, so they own the whole scope score. A fixture that
   * leaves them at zero while the submission scores 8 is internally
   * inconsistent, and the students rollup will read the zero.
   */
  score?: { total: number; maxSeverity: string };
  /** Defaults to true — the roster side named them. */
  isSubmitter?: boolean;
}

/**
 * Insert the `'roster'` contributor for `rosterEntryId`, exactly as the 0029
 * backfill writes it.
 *
 * The key spelling is duplicated from `rosterContributorKey` on purpose: this
 * helper lives in `test/` and asserting the string here means a change to the
 * production spelling shows up as a test failure rather than being carried
 * silently into every fixture.
 */
export async function seedContributor(
  db: DrizzleDb,
  submissionId: string,
  semesterId: string,
  rosterEntryId: string,
  options: SeedContributorOptions = {},
): Promise<void> {
  await db.insert(submission_contributors).values({
    submission_id: submissionId,
    semester_id: semesterId,
    contributor_key: `roster:${rosterEntryId}`,
    kind: 'roster',
    roster_entry_id: rosterEntryId,
    is_submitter: options.isSubmitter ?? true,
    score_total: options.score?.total ?? 0,
    score_max_severity: options.score?.maxSeverity ?? 'info',
  });
}
