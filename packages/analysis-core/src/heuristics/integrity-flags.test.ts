/**
 * Tests for the integrity-flags adapter (Phase 4).
 */

import { describe, it, expect } from 'vitest';
import { integrityFlagsFromReport } from './integrity-flags.js';
import type { ValidationReport } from '../validation/check-types.js';

// ---------------------------------------------------------------------------
// Helpers to build ValidationReport fixtures
// ---------------------------------------------------------------------------

function makePassReport(): ValidationReport {
  return {
    overall: 'pass',
    checks: [
      { id: 'manifest_sig', label: 'Manifest signature', status: 'pass' },
      { id: 'session_binding', label: 'Session binding', status: 'pass' },
      { id: 'chain_integrity', label: 'Hash chain integrity', status: 'pass' },
      { id: 'seq_gaps', label: 'Sequence gaps', status: 'pass' },
      { id: 'monotonic_t', label: 'Monotonic t', status: 'pass' },
      { id: 'monotonic_wall', label: 'Monotonic wall', status: 'pass' },
      { id: 'doc_save_hashes', label: 'Doc save hashes', status: 'pass' },
      {
        id: 'submitted_code_match',
        label: 'Submitted code match',
        status: 'skipped',
        detail: 'v1 skip',
      },
    ],
  };
}

function makeChainFailReport(
  supportingSeqs?: Array<{ sessionId: string; seq: number }>,
): ValidationReport {
  const base = makePassReport();
  return {
    overall: 'fail',
    checks: base.checks.map((c) =>
      c.id === 'chain_integrity'
        ? {
            id: 'chain_integrity',
            label: 'Hash chain integrity',
            status: 'fail',
            detail: 'Chain broken at entry 5 of session abc.',
            supportingSeqs: supportingSeqs ?? [{ sessionId: 'abc', seq: 5 }],
          }
        : c,
    ),
  };
}

// ---------------------------------------------------------------------------
// Negative: no fail on chain_integrity → no flags
// ---------------------------------------------------------------------------

describe('integrityFlagsFromReport — negative', () => {
  it('produces no flags when all checks pass', () => {
    const report = makePassReport();
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when only unhandled checks fail (e.g. seq_gaps, doc_save_hashes)', () => {
    // seq_gaps and doc_save_hashes are NOT in the CHECK_META table → no flags.
    const report: ValidationReport = {
      overall: 'fail',
      checks: makePassReport().checks.map((c) =>
        c.id === 'seq_gaps' ? { ...c, status: 'fail', detail: 'Gap found' } : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when chain_integrity is skipped', () => {
    const report: ValidationReport = {
      overall: 'warn',
      checks: makePassReport().checks.map((c) =>
        c.id === 'chain_integrity' ? { ...c, status: 'skipped' } : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive: chain_integrity fail → one Flag
// ---------------------------------------------------------------------------

describe('integrityFlagsFromReport — positive', () => {
  it('produces one Flag when chain_integrity fails', () => {
    const report = makeChainFailReport([{ sessionId: 'abc', seq: 5 }]);
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(1);
  });

  it('sets heuristic to "chain_broken"', () => {
    const report = makeChainFailReport();
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.heuristic).toBe('chain_broken');
  });

  it('sets severity to "high"', () => {
    const report = makeChainFailReport();
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.severity).toBe('high');
  });

  it('sets confidence to 1.0', () => {
    const report = makeChainFailReport();
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.confidence).toBe(1.0);
  });

  it('copies the check detail as the flag description', () => {
    const report = makeChainFailReport([{ sessionId: 'abc', seq: 5 }]);
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.description).toBe('Chain broken at entry 5 of session abc.');
  });

  it('converts supportingSeqs to ${sessionId}:${seq} format', () => {
    const report = makeChainFailReport([
      { sessionId: 'session-abc', seq: 5 },
      { sessionId: 'session-abc', seq: 6 },
    ]);
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.supportingSeqs).toEqual(['session-abc:5', 'session-abc:6']);
  });

  it('produces a deterministic id from the first seq', () => {
    const report = makeChainFailReport([{ sessionId: 'ses', seq: 7 }]);
    const flags1 = integrityFlagsFromReport(report);
    const flags2 = integrityFlagsFromReport(report);
    expect(flags1[0]!.id).toBe(flags2[0]!.id);
    expect(flags1[0]!.id).toBe('chain_broken-ses:7');
  });

  it('uses "no-seq" in id when supportingSeqs is empty', () => {
    const report = makeChainFailReport([]);
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.id).toBe('chain_broken-no-seq');
    expect(flags[0]!.supportingSeqs).toHaveLength(0);
  });

  it('uses a fallback description when check.detail is absent', () => {
    const report: ValidationReport = {
      overall: 'fail',
      checks: makePassReport().checks.map((c) =>
        c.id === 'chain_integrity'
          ? { id: 'chain_integrity', label: 'Hash chain integrity', status: 'fail' }
          : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.description).toContain('tampered');
  });

  it('includes check metadata in detail', () => {
    const report = makeChainFailReport([{ sessionId: 'abc', seq: 5 }]);
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.detail!['checkId']).toBe('chain_integrity');
    expect(flags[0]!.detail!['entryCount']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 17: checks 1, 2, 5, 6
// ---------------------------------------------------------------------------

describe('integrityFlagsFromReport — Phase 17 extended checks', () => {
  it('surfaces manifest_sig failure as manifest_sig_invalid flag (high)', () => {
    const report: ValidationReport = {
      overall: 'fail',
      checks: makePassReport().checks.map((c) =>
        c.id === 'manifest_sig'
          ? {
              id: 'manifest_sig',
              label: 'Manifest signature',
              status: 'fail',
              detail: 'ed25519 verify returned false',
            }
          : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('manifest_sig_invalid');
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.confidence).toBe(1.0);
    expect(flags[0]!.description).toBe('ed25519 verify returned false');
  });

  it('surfaces session_binding failure as session_binding_invalid flag (high)', () => {
    const report: ValidationReport = {
      overall: 'fail',
      checks: makePassReport().checks.map((c) =>
        c.id === 'session_binding'
          ? {
              id: 'session_binding',
              label: 'Session binding',
              status: 'fail',
              detail: 'Session sig does not match manifest_sig',
              supportingSeqs: [{ sessionId: 'sess-1', seq: 0 }],
            }
          : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('session_binding_invalid');
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.supportingSeqs).toEqual(['sess-1:0']);
  });

  it('surfaces monotonic_t failure as monotonic_t_regression flag (medium)', () => {
    const report: ValidationReport = {
      overall: 'fail',
      checks: makePassReport().checks.map((c) =>
        c.id === 'monotonic_t'
          ? {
              id: 'monotonic_t',
              label: 'Monotonic t',
              status: 'fail',
              detail: 't went backwards at seq 7',
              supportingSeqs: [{ sessionId: 'sess-A', seq: 7 }],
            }
          : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('monotonic_t_regression');
    expect(flags[0]!.severity).toBe('medium');
    expect(flags[0]!.id).toBe('monotonic_t_regression-sess-A:7');
  });

  it('surfaces monotonic_wall failure as monotonic_wall_regression flag (medium)', () => {
    const report: ValidationReport = {
      overall: 'fail',
      checks: makePassReport().checks.map((c) =>
        c.id === 'monotonic_wall'
          ? {
              id: 'monotonic_wall',
              label: 'Monotonic wall',
              status: 'fail',
              supportingSeqs: [{ sessionId: 'sess-B', seq: 3 }],
            }
          : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('monotonic_wall_regression');
    expect(flags[0]!.severity).toBe('medium');
    // Uses fallback description when detail is absent
    expect(flags[0]!.description).toContain('wall');
  });

  it('emits multiple flags when multiple checks fail', () => {
    const report: ValidationReport = {
      overall: 'fail',
      checks: makePassReport().checks.map((c) => {
        if (c.id === 'manifest_sig') return { ...c, status: 'fail' };
        if (c.id === 'chain_integrity')
          return { ...c, status: 'fail', supportingSeqs: [{ sessionId: 'x', seq: 1 }] };
        return c;
      }),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(2);
    const heuristics = flags.map((f) => f.heuristic);
    expect(heuristics).toContain('manifest_sig_invalid');
    expect(heuristics).toContain('chain_broken');
  });

  it('uses fallback description when check.detail is absent for new checks', () => {
    const report: ValidationReport = {
      overall: 'fail',
      checks: makePassReport().checks.map((c) =>
        c.id === 'manifest_sig' ? { id: 'manifest_sig', label: 'Manifest sig', status: 'fail' } : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.description).toContain('tampered');
  });
});

// ---------------------------------------------------------------------------
// flagOverride — checkpoint_chain_valid's tail-ambiguous seq_absent
// ---------------------------------------------------------------------------

describe('integrityFlagsFromReport — flagOverride', () => {
  it('uses flagOverride severity/confidence/description instead of CHECK_META when present', () => {
    const report: ValidationReport = {
      ...makePassReport(),
      overall: 'fail',
      bundleDetections: [
        {
          id: 'checkpoint_chain_valid',
          label: 'Signed session checkpoints agree with the log',
          status: 'fail',
          detail: 'a validly signed checkpoint names seq 6, but no entry with that seq is present',
          supportingSeqs: [{ sessionId: 's1', seq: 6 }],
          flagOverride: {
            severity: 'low',
            confidence: 0.5,
            description: 'dual reading: honest crash or truncation, undecidable from the log',
          },
        },
      ],
    };

    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('checkpoint_chain_valid');
    // CHECK_META's table entry for checkpoint_chain_valid is 'high'/1.0 —
    // flagOverride must win over it, not merely append to it.
    expect(flags[0]!.severity).toBe('low');
    expect(flags[0]!.confidence).toBe(0.5);
    expect(flags[0]!.description).toBe(
      'dual reading: honest crash or truncation, undecidable from the log',
    );
  });

  it('falls back to CHECK_META when a checkpoint_chain_valid failure carries no flagOverride', () => {
    const report: ValidationReport = {
      ...makePassReport(),
      overall: 'fail',
      bundleDetections: [
        {
          id: 'checkpoint_chain_valid',
          label: 'Signed session checkpoints agree with the log',
          status: 'fail',
          detail:
            'a validly signed checkpoint swears the entry at seq 3 hashes to X, but it hashes to Y',
          supportingSeqs: [{ sessionId: 's1', seq: 3 }],
        },
      ],
    };

    const flags = integrityFlagsFromReport(report);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.confidence).toBe(1.0);
    expect(flags[0]!.description).toBe(
      'a validly signed checkpoint swears the entry at seq 3 hashes to X, but it hashes to Y',
    );
  });
});

// ---------------------------------------------------------------------------
// Check 8: submitted_code_match
// ---------------------------------------------------------------------------

describe('integrityFlagsFromReport — submitted_code_match', () => {
  it('emits a high-severity submitted_code_match flag when Check 8 fails', () => {
    const report = {
      overall: 'fail',
      checks: [
        {
          id: 'submitted_code_match',
          label: 'Submitted code matches recorded final state',
          status: 'fail',
          detail: 'mismatch',
          supportingSeqs: [{ sessionId: 's1', seq: 7 }],
        },
      ],
    } as ValidationReport;
    const flags = integrityFlagsFromReport(report);
    const f = flags.find((x) => x.heuristic === 'submitted_code_match')!;
    expect(f).toBeDefined();
    expect(f.severity).toBe('high');
    expect(f.confidence).toBe(1.0);
  });

  it('sets the flag id deterministically from the first seq', () => {
    const report = {
      overall: 'fail',
      checks: [
        {
          id: 'submitted_code_match',
          label: 'Submitted code matches recorded final state',
          status: 'fail',
          detail: 'mismatch',
          supportingSeqs: [{ sessionId: 's1', seq: 7 }],
        },
      ],
    } as ValidationReport;
    const flags = integrityFlagsFromReport(report);
    expect(flags[0]!.id).toBe('submitted_code_match-s1:7');
  });

  it('does not emit a flag when Check 8 passes', () => {
    const report: ValidationReport = {
      overall: 'pass',
      checks: makePassReport().checks.map((c) =>
        c.id === 'submitted_code_match' ? { ...c, status: 'pass' } : c,
      ),
    };
    const flags = integrityFlagsFromReport(report);
    expect(flags.find((f) => f.heuristic === 'submitted_code_match')).toBeUndefined();
  });

  it('does not emit a flag when Check 8 is skipped', () => {
    const report = makePassReport();
    const flags = integrityFlagsFromReport(report);
    expect(flags.find((f) => f.heuristic === 'submitted_code_match')).toBeUndefined();
  });
});
