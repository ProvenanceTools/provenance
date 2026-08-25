/**
 * Phase 8 of the per-file ingest pipeline: run v2 validation and store results
 * (PRD §9.3, §5.4, §11.3).
 *
 * Wraps v2's pure runValidation(bundle) → ValidationReport and persists one
 * row per submission into validation_results. Also updates
 * submissions.validation_status to reflect the overall result.
 *
 * Idempotent via ON CONFLICT DO UPDATE on the PK (submission_id). Re-running
 * against the same bundle produces the same final row.
 *
 * Transaction: callers wrap this in a transaction for atomicity with other
 * ingest phases. This function does NOT open its own transaction.
 *
 * Check ordering assumption:
 *   v2's runValidation returns checks in the exact PRD §5.4 spec order:
 *     [0] manifest_sig          → check_1_status
 *     [1] session_binding       → check_2_status
 *     [2] chain_integrity       → check_3_status
 *     [3] seq_gaps              → check_4_status
 *     [4] monotonic_t           → check_5_status
 *     [5] monotonic_wall        → check_6_status
 *     [6] doc_save_hashes       → check_7_status
 *     [7] submitted_code_match  → check_8_status
 *   This is enforced at runtime by the 8-check assertion and verified by
 *   run-validation.test.ts in the analyzer package. If v2 ever drifts from
 *   spec order, the assertion will catch it loudly.
 */

import { runValidation } from '@provenance/analysis-core/validation/run-validation.js';
import type { ValidationOptions } from '@provenance/analysis-core/validation/run-validation.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { ValidationReport } from '@provenance/analysis-core/validation/check-types.js';
import { validation_results, submissions } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/client.js';

const EXPECTED_CHECK_COUNT = 8;

/**
 * Run v2 validation, persist results, and return the ValidationReport.
 *
 * The caller (ingest worker) passes the returned report to
 * runAndStoreHeuristics so that integrity flags (chain_broken etc.) from the
 * validation report can be surfaced as heuristic flags without re-running
 * runValidation a second time.
 */
export async function runAndStoreValidation(
  db: DrizzleDb,
  submissionId: string,
  bundle: Bundle,
  /**
   * Carries the Manifest 2.0 ROOT public key into check 2. Defaults to empty so
   * unit tests that drive this directly need no config; production call sites
   * pass `configuredValidationOptions()`.
   */
  options: ValidationOptions = {},
): Promise<ValidationReport> {
  const report = await runValidation(bundle, options);

  // Defensive assertion: v2 must return exactly 8 checks in spec order.
  // If this fires, runValidation has drifted from the PRD contract — stop loudly.
  if (report.checks.length !== EXPECTED_CHECK_COUNT) {
    throw new Error(
      `runAndStoreValidation: expected ${EXPECTED_CHECK_COUNT} checks from runValidation, got ${report.checks.length}`,
    );
  }

  const [c1, c2, c3, c4, c5, c6, c7, c8] = report.checks;

  await db
    .insert(validation_results)
    .values({
      submission_id: submissionId,
      check_1_status: c1!.status,
      check_2_status: c2!.status,
      check_3_status: c3!.status,
      check_4_status: c4!.status,
      check_5_status: c5!.status,
      check_6_status: c6!.status,
      check_7_status: c7!.status,
      check_8_status: c8!.status,
      overall: report.overall,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: jsonb accepts JSON-serializable value
      detail: report.checks as any,
    })
    .onConflictDoUpdate({
      target: validation_results.submission_id,
      set: {
        check_1_status: sql`EXCLUDED.check_1_status`,
        check_2_status: sql`EXCLUDED.check_2_status`,
        check_3_status: sql`EXCLUDED.check_3_status`,
        check_4_status: sql`EXCLUDED.check_4_status`,
        check_5_status: sql`EXCLUDED.check_5_status`,
        check_6_status: sql`EXCLUDED.check_6_status`,
        check_7_status: sql`EXCLUDED.check_7_status`,
        check_8_status: sql`EXCLUDED.check_8_status`,
        overall: sql`EXCLUDED.overall`,
        detail: sql`EXCLUDED.detail`,
        validated_at: sql`now()`,
      },
    });

  // Update submissions.validation_status to reflect the overall result.
  // This is intentionally outside the validation_results upsert so that the
  // submissions row reflects the latest validation outcome.
  await db
    .update(submissions)
    .set({ validation_status: report.overall })
    .where(eq(submissions.id, submissionId));

  return report;
}
