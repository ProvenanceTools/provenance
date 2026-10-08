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
import { readSubmittedShas, stripSubmittedShas } from '../ingest/submitted-shas.js';
import type { SubmittedShas } from '../ingest/submitted-shas.js';

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

  // The stored check-8 entry also carries the persisted submitted shas
  // (services/ingest/submitted-shas.ts). They are internal evidence for
  // re-running check 8, not part of this response — strip them here, since
  // the checks are otherwise passed through verbatim and nothing downstream
  // narrows the shape.
  const checks = Array.isArray(r.detail)
    ? stripSubmittedShas(r.detail as ValidationCheckRow[])
    : [];

  return {
    overall: r.overall as 'pass' | 'warn' | 'fail',
    checks,
    validated_at: r.validated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Stored check-8 gate (Source tab)
// ---------------------------------------------------------------------------

/**
 * The stored evidence the Source tab's per-file Check 8 verdicts need: the
 * ingest-time `chain_integrity` verdict, and the persisted submitted shas.
 *
 * CHAIN INTEGRITY. The per-file verdicts are gated on "is the hash chain
 * intact?". That question already has a stored answer, and the Validation tab
 * shows it. The Source tab used to re-derive it with its own live
 * `runValidation(bundle)` — so one page load could show a stored PASS beside
 * badges computed under a live FAIL, the page contradicting itself about a fact
 * it had already recorded. Reading the stored row makes both surfaces quote the
 * same answer. `check_3_status` is chain_integrity: `runAndStoreValidation`
 * asserts the 8 checks arrive in PRD §5.4 spec order before writing these
 * columns, so the column-to-id mapping is enforced at write time.
 *
 * SUBMITTED SHAS. The stored bundle is source-stripped, so the verdicts need
 * the shas ingest recorded from the submitted bytes to reproduce the stored
 * check-8 verdict (services/ingest/submitted-shas.ts). Absent for rows ingested
 * before they were recorded; check 8 then says `unknown` wherever the stripped
 * bundle cannot establish what was submitted.
 *
 * With no validation row at all, `chainIntact` is `false` — a defensive branch
 * (every ingested submission gets one) that degrades the Source badges to
 * `unknown`, the honest reading of "we have no recorded chain verdict".
 */
export async function getStoredSourceGate(
  db: DrizzleDb,
  submissionId: string,
): Promise<{ chainIntact: boolean; submittedShas?: SubmittedShas }> {
  const rows = await db
    .select({ chain: validation_results.check_3_status, detail: validation_results.detail })
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId))
    .limit(1);

  const row = rows[0];
  const submittedShas = row === undefined ? undefined : readSubmittedShas(row.detail);
  return {
    chainIntact: row?.chain === 'pass',
    ...(submittedShas !== undefined ? { submittedShas } : {}),
  };
}
