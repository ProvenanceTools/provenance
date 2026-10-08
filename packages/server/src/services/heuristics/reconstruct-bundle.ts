/**
 * reconstructBundleFromDb — load a submission's Bundle + EventIndex +
 * ValidationReport for per-submission recompute and cross-heuristics.
 *
 * The Bundle + EventIndex now come from the stored (provenance-only) bundle blob
 * via `loadSubmissionIndex` — the Postgres `events` table has been removed. The
 * blob's signed manifest carries the real `extension_hash`, so the old
 * extension-hash sentinel/recovery hack (needed when only events were persisted)
 * is gone: recompute/cross see the exact same manifest the original ingest did.
 *
 * The ValidationReport is reconstructed from the persisted `validation_results`
 * row; nothing here re-runs validation. (Per-submission recompute does re-run
 * it, against the stripped bundle plus the submitted shas ingest persisted —
 * see recompute-submission.ts and services/ingest/submitted-shas.ts.) The
 * persisted shas are stripped from the rebuilt checks: they are storage-side
 * evidence, not part of a `ValidationCheck`.
 *
 * Used by:
 *   - reconstruction.ts (file replay)
 *   - recompute-submission.ts (per-submission recompute)
 *   - run-cross.ts (cross-heuristics; via extract-cross-features)
 */

import { eq } from 'drizzle-orm';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type {
  ValidationReport,
  ValidationCheck,
} from '@provenance/analysis-core/validation/check-types.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import { validation_results } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { loadSubmissionIndex } from '../bundle/load-index.js';
import { stripSubmittedShas } from '../ingest/submitted-shas.js';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export type ReconstructedBundle = {
  bundle: Bundle;
  index: EventIndex;
  validationReport: ValidationReport;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a submission's real Bundle + EventIndex from its stored blob, plus its
 * ValidationReport from `validation_results`.
 *
 * This is a read-only operation; it makes no writes to any table.
 *
 * @param db           - Drizzle DB handle.
 * @param storage      - Object-storage client.
 * @param submissionId - UUID of the submission.
 */
export async function reconstructBundleFromDb(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
): Promise<ReconstructedBundle> {
  const { bundle, index } = await loadSubmissionIndex(db, storage, submissionId);
  const validationReport = await reconstructValidationReport(db, submissionId);
  return { bundle, index, validationReport };
}

// ---------------------------------------------------------------------------
// Internal: reconstruct ValidationReport from DB
// ---------------------------------------------------------------------------

/**
 * Reconstruct a ValidationReport from the DB validation_results row.
 *
 * If no row exists, returns a default "all-skipped" report (integrity flags
 * will not fire). This is conservative — in practice all ingested submissions
 * should have a validation_results row (written by Phase 11).
 */
async function reconstructValidationReport(
  db: DrizzleDb,
  submissionId: string,
): Promise<ValidationReport> {
  const rows = await db
    .select({
      check_1_status: validation_results.check_1_status,
      check_2_status: validation_results.check_2_status,
      check_3_status: validation_results.check_3_status,
      check_4_status: validation_results.check_4_status,
      check_5_status: validation_results.check_5_status,
      check_6_status: validation_results.check_6_status,
      check_7_status: validation_results.check_7_status,
      check_8_status: validation_results.check_8_status,
      overall: validation_results.overall,
      detail: validation_results.detail,
    })
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId))
    .limit(1);

  if (rows.length === 0) {
    return {
      overall: 'warn',
      checks: [
        { id: 'manifest_sig', label: 'Manifest signature', status: 'skipped' },
        { id: 'session_binding', label: 'Session binding', status: 'skipped' },
        { id: 'chain_integrity', label: 'Hash chain integrity', status: 'skipped' },
        { id: 'seq_gaps', label: 'Sequence gaps', status: 'skipped' },
        { id: 'monotonic_t', label: 'Monotonic t', status: 'skipped' },
        { id: 'monotonic_wall', label: 'Monotonic wall', status: 'skipped' },
        { id: 'doc_save_hashes', label: 'Doc save hashes', status: 'skipped' },
        {
          id: 'submitted_code_match',
          label: 'Submitted code match',
          status: 'skipped',
          detail: 'v1 skip',
        },
      ],
    };
  }

  const row = rows[0]!;

  // The `detail` column stores the full checks array as jsonb.
  const detailChecks = Array.isArray(row.detail) ? (row.detail as ValidationCheck[]) : null;

  if (detailChecks && detailChecks.length === 8) {
    return {
      overall: row.overall as ValidationReport['overall'],
      checks: stripSubmittedShas(detailChecks),
    };
  }

  // Fallback: reconstruct from individual status columns.
  const checkIds = [
    'manifest_sig',
    'session_binding',
    'chain_integrity',
    'seq_gaps',
    'monotonic_t',
    'monotonic_wall',
    'doc_save_hashes',
    'submitted_code_match',
  ] as const;

  const statusValues = [
    row.check_1_status,
    row.check_2_status,
    row.check_3_status,
    row.check_4_status,
    row.check_5_status,
    row.check_6_status,
    row.check_7_status,
    row.check_8_status,
  ] as const;

  const checks: ValidationCheck[] = checkIds.map((id, i) => ({
    id,
    label: id,
    status: (statusValues[i] ?? 'skipped') as ValidationCheck['status'],
  }));

  return {
    overall: row.overall as ValidationReport['overall'],
    checks,
  };
}
