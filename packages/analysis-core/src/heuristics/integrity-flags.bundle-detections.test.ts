/**
 * Tests for the integrity-flags adapter's handling of BUNDLE-LEVEL detections.
 *
 * These three ids — `log_bytes_match`, `checkpoint_chain_valid` and
 * `manifest_downgrade` — are NOT among the PRD §5.4 eight. They ride on
 * `ValidationReport.bundleDetections` because the eight are a frozen persisted
 * contract (eight `check_N_status` columns, `checks.length === 8` asserted at
 * ingest).
 *
 * That makes this adapter the ONLY thing standing between "the detection
 * computed a correct verdict" and "a staff member ever sees it". A regression
 * here is silent in the worst way: every verifier still returns the right
 * answer, every verifier unit test still passes, and the finding simply never
 * becomes a Flag. A mutation that made the adapter read only `report.checks`
 * was caught by nothing until this file existed.
 *
 * Kept separate from `integrity-flags.test.ts` so the Phase 4 fixtures there
 * stay untouched.
 */

import { describe, it, expect } from 'vitest';
import { integrityFlagsFromReport } from './integrity-flags.js';
import type { ValidationReport } from '../validation/check-types.js';

const BUNDLE_DETECTION_IDS = [
  'log_bytes_match',
  'checkpoint_chain_valid',
  'manifest_downgrade',
] as const;

type DetectionId = (typeof BUNDLE_DETECTION_IDS)[number];

/** All eight passing — so anything produced below comes from bundleDetections. */
function eightPassing(): ValidationReport['checks'] {
  return [
    { id: 'manifest_sig', label: 'Manifest signature', status: 'pass' },
    { id: 'session_binding', label: 'Session binding', status: 'pass' },
    { id: 'chain_integrity', label: 'Hash chain integrity', status: 'pass' },
    { id: 'seq_gaps', label: 'Sequence gaps', status: 'pass' },
    { id: 'monotonic_t', label: 'Monotonic t', status: 'pass' },
    { id: 'monotonic_wall', label: 'Monotonic wall', status: 'pass' },
    { id: 'doc_save_hashes', label: 'Doc save hashes', status: 'pass' },
    { id: 'submitted_code_match', label: 'Submitted code match', status: 'pass' },
  ];
}

function withBundleDetections(
  statuses: Record<DetectionId, 'pass' | 'fail' | 'skipped'>,
): ValidationReport {
  return {
    overall: 'pass',
    checks: eightPassing(),
    bundleDetections: BUNDLE_DETECTION_IDS.map((id) =>
      statuses[id] === 'fail'
        ? {
            id,
            label: `detection ${id}`,
            status: statuses[id],
            detail: `${id} detail`,
            supportingSeqs: [{ sessionId: 'sess-1', seq: 0 }],
          }
        : { id, label: `detection ${id}`, status: statuses[id], detail: `${id} detail` },
    ),
  };
}

describe('integrityFlagsFromReport — bundle-level detections', () => {
  it('turns each FAILING bundle detection into a staff-visible Flag', () => {
    const flags = integrityFlagsFromReport(
      withBundleDetections({
        log_bytes_match: 'fail',
        checkpoint_chain_valid: 'fail',
        manifest_downgrade: 'fail',
      }),
    );

    for (const id of BUNDLE_DETECTION_IDS) {
      const flag = flags.find((f) => f.heuristic === id);
      expect(flag, `expected a Flag for ${id}`).toBeDefined();
      // All three are cryptographic contradictions, not inferences.
      expect(flag!.severity).toBe('high');
      expect(flag!.confidence).toBe(1.0);
      // The verifier's own prose reaches staff, not the generic fallback.
      expect(flag!.description).toBe(`${id} detail`);
      expect(flag!.supportingSeqs).toEqual(['sess-1:0']);
    }
  });

  it('produces NO flag for a passing or skipped bundle detection', () => {
    // "Cannot evaluate" must never reach a student's record as a finding.
    const flags = integrityFlagsFromReport(
      withBundleDetections({
        log_bytes_match: 'pass',
        checkpoint_chain_valid: 'skipped',
        manifest_downgrade: 'skipped',
      }),
    );

    for (const id of BUNDLE_DETECTION_IDS) {
      expect(flags.find((f) => f.heuristic === id)).toBeUndefined();
    }
    expect(flags).toEqual([]);
  });

  it('surfaces bundle detections ALONGSIDE the eight, not instead of them', () => {
    const report: ValidationReport = {
      overall: 'fail',
      checks: eightPassing().map((c) =>
        c.id === 'chain_integrity'
          ? {
              ...c,
              status: 'fail' as const,
              detail: 'Chain broken.',
              supportingSeqs: [{ sessionId: 'abc', seq: 5 }],
            }
          : c,
      ),
      bundleDetections: [
        {
          id: 'log_bytes_match',
          label: 'log bytes',
          status: 'fail',
          detail: 'bytes moved',
          supportingSeqs: [{ sessionId: 'abc', seq: 0 }],
        },
      ],
    };

    const flags = integrityFlagsFromReport(report);
    expect(flags.find((f) => f.heuristic === 'chain_broken')).toBeDefined();
    expect(flags.find((f) => f.heuristic === 'log_bytes_match')).toBeDefined();
  });

  it('produces no bundle-detection flags when the field is absent', () => {
    // A report rebuilt from the stored eight-column row carries no
    // bundleDetections. Absent means "nobody evaluated them", not "they
    // passed" — and it must not throw.
    const report: ValidationReport = { overall: 'pass', checks: eightPassing() };
    expect(report.bundleDetections).toBeUndefined();
    expect(integrityFlagsFromReport(report)).toEqual([]);
  });

  it('gives each bundle detection a distinct, deterministic flag id', () => {
    const report = withBundleDetections({
      log_bytes_match: 'fail',
      checkpoint_chain_valid: 'fail',
      manifest_downgrade: 'fail',
    });

    const first = integrityFlagsFromReport(report);
    const second = integrityFlagsFromReport(report);

    expect(first.map((f) => f.id)).toEqual(second.map((f) => f.id));
    expect(new Set(first.map((f) => f.id)).size).toBe(first.length);
  });
});
