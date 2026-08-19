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
  | 'manifest_downgrade'
  /**
   * NOT one of the eight, for the same reason as `manifest_downgrade` — see
   * `verify-log-bytes.ts`. Enforces the signed manifest's `slog_sha256` /
   * `meta_sha256` commitment to each session's log file bytes, which nothing
   * read until 2026-08.
   */
  | 'log_bytes_match'
  /**
   * NOT one of the eight — see `verify-checkpoint-chain.ts`. Verifies the
   * PRD §4.6 signed `(seq, hash)` checkpoints in `.slog.meta`, which nothing
   * verified until 2026-08.
   */
  | 'checkpoint_chain_valid';

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
  /** The PRD §5.4 eight, in spec order. ALWAYS exactly 8 — see above. */
  checks: ValidationCheck[];
  /**
   * Bundle-level tamper detections that are deliberately NOT among the eight.
   *
   * The eight are a frozen, persisted contract: the server has eight
   * `check_N_status` columns and `runAndStoreValidation` throws unless
   * `checks.length === 8`. These detections post-date that contract, so they
   * ride here instead, and `heuristics/integrity-flags.ts` turns each failing
   * one into a `Flag` exactly as it does for a failing check.
   *
   * Deliberately NOT folded into `overall`: `overall` is persisted and is
   * derived from the eight, and widening it would silently change the stored
   * validation verdict of every bundle.
   *
   * Optional because a `ValidationReport` reconstructed from the stored
   * `validation_results` row carries only the eight columns. That is safe for
   * flag production: both paths that produce flags — ingest and recompute —
   * call `runValidation` against the freshly parsed bundle, so these are
   * always recomputed and never resurrected from a row that never held them.
   */
  bundleDetections?: ValidationCheck[];
  overall: 'pass' | 'warn' | 'fail';
};
