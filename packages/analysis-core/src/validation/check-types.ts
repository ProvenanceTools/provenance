/**
 * Types for the validation pipeline (Phase 2).
 * PRD §5.4 — 8 checks in spec order.
 */

// ---------------------------------------------------------------------------
// Check ID enum
// ---------------------------------------------------------------------------

export type ValidationCheckId =
  | 'manifest_sig'
  | 'session_binding'
  | 'chain_integrity'
  | 'seq_gaps'
  | 'monotonic_t'
  | 'monotonic_wall'
  | 'doc_save_hashes'
  | 'submitted_code_match'
  /**
   * NOT one of the PRD §5.4 eight, and deliberately never in
   * {@link ValidationReport.checks} — see `verify-manifest-downgrade.ts`.
   *
   * The eight are a frozen, persisted contract: the server has eight
   * `check_N_status` columns, asserts `checks.length === 8` at ingest, and
   * reconstructs stored reports on the same assumption. This detection
   * post-dates that contract, so it is run straight off the bundle by the
   * integrity-flag adapter instead. It shares the `ValidationCheck` shape
   * because it IS one — same verdict vocabulary, same supporting seqs, same
   * route into a Flag through `CHECK_META`.
   */
  | 'manifest_downgrade';

// ---------------------------------------------------------------------------
// Single check result
// ---------------------------------------------------------------------------

export type ValidationCheck = {
  id: ValidationCheckId;
  /** Human-readable name for the check. */
  label: string;
  status: 'pass' | 'fail' | 'skipped';
  /** Optional prose detail: explains failure reason or skipped rationale. */
  detail?: string;
  /** Session-local seqs of entries that contributed to a failure. */
  supportingSeqs?: Array<{ sessionId: string; seq: number }>;
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Full validation report — always exactly 8 entries in PRD §5.4 spec order.
 *
 * `overall` rules:
 *   - Any 'fail' check → 'fail'.
 *   - No 'fail' but ≥1 'skipped' → 'warn'.
 *   - All 'pass' → 'pass'.
 *
 * NOTE: Check 8 (submitted_code_match) runs for 1.1 bundles (comparing each
 * submitted file to the recorder's last recorded on-disk hash), so a clean 1.1
 * bundle can score 'pass'. Legacy 1.0 bundles carry no submission files, so
 * Check 8 is 'skipped' there and the best they can score is 'warn'.
 */
export type ValidationReport = {
  checks: ValidationCheck[];
  overall: 'pass' | 'warn' | 'fail';
};
