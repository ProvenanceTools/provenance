/**
 * Per-submission validation service — PRD §8.9.
 *
 * GET /submissions/{submissionId}/validation
 *
 * Returns { overall, checks, validated_at }. The per-check rows come from the
 * `detail` jsonb column, which stores the full ValidationCheck[] produced by
 * runValidation at ingest. The flat check_N_status columns in the DB are a
 * storage artifact (used by cohort-list filtering) and are not surfaced here.
 */

import { eq } from 'drizzle-orm';
import { validation_results } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export type ValidationCheckRow = {
  id: string;
  /**
   * Human-readable check name ("Monotonic wall clock"). runAndStoreValidation
   * writes the full ValidationCheck[] verbatim, so this has always been present
   * in the stored jsonb — it was simply narrowed away here, leaving the
   * analyzer to print raw ids. Optional because rows are read back untyped.
   */
  label?: string;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  detail?: string;
};

export type SubmissionValidation = {
  overall: 'pass' | 'warn' | 'fail';
  checks: ValidationCheckRow[];
  validated_at: string;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function getSubmissionValidation(
  db: DrizzleDb,
  submissionId: string,
): Promise<SubmissionValidation | null> {
  const rows = await db
    .select({
      overall: validation_results.overall,
      detail: validation_results.detail,
      validated_at: validation_results.validated_at,
    })
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId))
    .limit(1);

  if (rows.length === 0) return null;
  const r = rows[0]!;

  const checks = Array.isArray(r.detail) ? (r.detail as ValidationCheckRow[]) : [];

  return {
    overall: r.overall as 'pass' | 'warn' | 'fail',
    checks,
    validated_at: r.validated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Stored chain-integrity gate (Source tab)
// ---------------------------------------------------------------------------

/**
 * The ingest-time `chain_integrity` verdict for a submission.
 *
 * The Source tab's per-file Check 8 verdicts are gated on "is the hash chain
 * intact?". That question already has a stored, ingest-time answer, and the
 * Validation tab shows it. The Source tab used to re-derive it with its own live
 * `runValidation(bundle)` — so one page load could show a stored PASS beside
 * badges computed under a live FAIL, the page contradicting itself about a fact
 * it had already recorded. Reading the stored row makes both surfaces quote the
 * same answer.
 *
 * `check_3_status` is chain_integrity: `runAndStoreValidation` asserts the 8
 * checks arrive in PRD §5.4 spec order before writing these columns, so the
 * column-to-id mapping is enforced at write time rather than assumed here.
 *
 * Returns `false` when there is no validation row at all. Every ingested
 * submission gets one, so this is a defensive branch; `false` degrades the
 * Source badges to `unknown`, which is the honest reading of "we have no
 * recorded chain verdict for this bundle".
 */
export async function getStoredChainIntact(
  db: DrizzleDb,
  submissionId: string,
): Promise<{ chainIntact: boolean }> {
  const rows = await db
    .select({ chain: validation_results.check_3_status })
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId))
    .limit(1);

  return { chainIntact: rows[0]?.chain === 'pass' };
}
