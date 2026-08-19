/**
 * integrity-flags adapter (Phase 4 + Phase 17).
 *
 * Converts failing ValidationReport checks into Flag objects.
 *
 * Checks surfaced:
 *   - check 1 (manifest_sig): signature verification failure → 'high'
 *   - check 2 (session_binding): session-to-manifest linkage failure → 'high'
 *   - check 3 (chain_integrity): hash chain break → 'high'
 *   - check 5 (monotonic_t): t-regression in events → 'medium'
 *   - check 6 (monotonic_wall): wall-time regression → 'medium'
 *   - check 8 (submitted_code_match): submitted file mismatch → 'high' (1.1+ bundles)
 *
 * Bundle-level detections surfaced (NOT among the PRD §5.4 eight — they arrive
 * on `ValidationReport.bundleDetections`, see check-types.ts):
 *   - log_bytes_match: .slog/.slog.meta bytes differ from the digests the
 *     SIGNED manifest commits to → 'high'
 *   - checkpoint_chain_valid: a signed PRD §4.6 checkpoint is forged, or is
 *     contradicted by the log it commits to → 'high'
 *   - manifest_downgrade: a 1.x assignment manifest carrying Manifest 2.0-only
 *     fields → 'high'
 *
 * Checks NOT surfaced here:
 *   - check 4 (seq_gaps): surfaced if needed; not in PRD §7.4 flag list.
 *   - check 7 (doc_save_hashes): surfaced separately.
 *
 * This is an adapter, not a heuristic in the traditional sense — it does not
 * re-analyze the event stream. It converts the validation pipeline's output
 * into the same Flag shape so the dashboard can display them uniformly.
 *
 * The `runHeuristics` orchestrator calls this separately (it takes a
 * ValidationReport argument) and merges the result into the overall flag list.
 */

import type { ValidationCheckId, ValidationReport } from '../validation/check-types.js';
import type { Flag } from './types.js';
import type { Severity } from './types.js';

// ---------------------------------------------------------------------------
// Check metadata table
// ---------------------------------------------------------------------------

type CheckMeta = {
  heuristic: string;
  title: string;
  severity: Severity;
  confidence: number;
  fallbackDescription: string;
};

// Exported so known-flag-ids.ts can derive the canonical integrity-flag id
// list from it, rather than a hand-maintained duplicate.
export const CHECK_META: Partial<Record<ValidationCheckId, CheckMeta>> = {
  manifest_sig: {
    heuristic: 'manifest_sig_invalid',
    title: 'Manifest signature verification failed',
    severity: 'high',
    confidence: 1.0,
    fallbackDescription:
      'The bundle manifest signature failed ed25519 verification. The manifest may have been tampered with after sealing.',
  },
  session_binding: {
    heuristic: 'session_binding_invalid',
    title: 'Session binding verification failed',
    severity: 'high',
    confidence: 1.0,
    fallbackDescription:
      'One or more sessions failed the manifest-to-session binding check. The bundle mixes sessions with mismatched manifest signatures (different assignment manifests).',
  },
  chain_integrity: {
    heuristic: 'chain_broken',
    title: 'Hash chain integrity failure',
    severity: 'high',
    confidence: 1.0,
    fallbackDescription:
      'The hash chain failed validation. One or more log entries have been tampered with.',
  },
  monotonic_t: {
    heuristic: 'monotonic_t_regression',
    title: 'Monotonic t regression detected',
    severity: 'medium',
    confidence: 1.0,
    fallbackDescription:
      'One or more events have a t value smaller than a preceding event in the same session. The recorder clock may have been manipulated.',
  },
  monotonic_wall: {
    heuristic: 'monotonic_wall_regression',
    title: 'Monotonic wall-clock regression detected',
    severity: 'medium',
    confidence: 1.0,
    fallbackDescription:
      'One or more events have a wall timestamp earlier than a preceding event in the same session. The system clock may have been adjusted backwards.',
  },
  submitted_code_match: {
    heuristic: 'submitted_code_match',
    title: 'Submitted code does not match the recording',
    severity: 'high',
    confidence: 1.0,
    fallbackDescription: 'The submitted file differs from the last recorded on-disk state.',
  },

  // -------------------------------------------------------------------------
  // Bundle-level detections. Same Flag shape, same table, but sourced from
  // `report.bundleDetections` rather than `report.checks` — see the module
  // docstring and `validation/check-types.ts`.
  //
  // All three are severity 'high' at confidence 1.0, and that is a deliberate
  // choice rather than a default. Each is a CRYPTOGRAPHIC contradiction, not a
  // behavioural inference: a digest that a signed manifest fixed at seal time
  // does not match; a checkpoint signed by the session key is refuted by the
  // log; a signed 1.x manifest carries fields no 1.x signer can emit. None has
  // a benign explanation, none has a threshold to tune, and none can fire by
  // accident — every "cannot evaluate" path in the three verifiers returns
  // `skipped`, so a flag here only ever exists because evidence was present and
  // contradicted. A log-bytes mismatch in particular is the single strongest
  // signal the system can produce, and grading it below 'high' would rank
  // proof-of-tampering under heuristics that are merely suggestive.
  // -------------------------------------------------------------------------
  log_bytes_match: {
    heuristic: 'log_bytes_match',
    title: 'Session log bytes do not match the signed manifest',
    severity: 'high',
    confidence: 1.0,
    fallbackDescription:
      'A session .slog or .slog.meta file does not hash to the value the signed bundle manifest commits to. The log was modified after the bundle was sealed.',
  },
  checkpoint_chain_valid: {
    heuristic: 'checkpoint_chain_valid',
    title: 'Signed session checkpoint contradicts the log',
    severity: 'high',
    confidence: 1.0,
    fallbackDescription:
      'A signed seq/hash checkpoint in .slog.meta failed verification, or names an entry the log no longer contains or no longer matches. The log was rewritten or truncated after that checkpoint was signed.',
  },
  manifest_downgrade: {
    heuristic: 'manifest_downgrade',
    title: 'Assignment manifest carries fields its signature does not cover',
    severity: 'high',
    confidence: 1.0,
    fallbackDescription:
      'A sub-2.0 embedded assignment manifest carries Manifest 2.0-only fields, which no 1.x signer emits. The manifest was modified after it was signed, even though the modification granted nothing.',
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert failing ValidationReport checks (1, 2, 3, 5, 6, 8) into Flag objects.
 *
 * The check's `supportingSeqs` field contains `{ sessionId, seq }` pairs
 * that identify the exact entries where failures were detected. We convert
 * them to `${sessionId}:${seq}` strings (EventIndex.bySeq key format) for
 * UI deep-linking.
 */
export function integrityFlagsFromReport(report: ValidationReport): Flag[] {
  const flags: Flag[] = [];

  // The eight, then the bundle-level detections. Both are `ValidationCheck`s
  // and both route through CHECK_META, so the mapping below is shared; only
  // the source array differs. `bundleDetections` is optional because a report
  // rebuilt from the stored eight-column row has none — an absent array yields
  // no flags, which is correct: it means nobody evaluated them, not that they
  // passed.
  for (const check of [...report.checks, ...(report.bundleDetections ?? [])]) {
    if (check.status !== 'fail') continue;

    const meta = CHECK_META[check.id];
    if (meta === undefined) continue;

    const rawSeqs = check.supportingSeqs ?? [];
    const supportingSeqs = rawSeqs.map((s) => `${s.sessionId}:${s.seq}`);

    // Deterministic flag id: derived from the first supporting seq (or the
    // check id alone if no seqs are available).
    const seqKey0 = supportingSeqs[0] ?? 'no-seq';
    const id = `${meta.heuristic}-${seqKey0}`;

    flags.push({
      id,
      heuristic: meta.heuristic,
      title: meta.title,
      severity: meta.severity,
      confidence: meta.confidence,
      supportingSeqs,
      description: check.detail ?? meta.fallbackDescription,
      detail: {
        checkId: check.id,
        checkLabel: check.label,
        entryCount: rawSeqs.length,
      },
    });
  }

  return flags;
}
