import { describe, it, expect } from 'vitest';
import {
  ALL_FLAG_IDS,
  PER_SUBMISSION_HEURISTIC_IDS,
  INTEGRITY_FLAG_IDS,
  CROSS_SUBMISSION_HEURISTIC_IDS,
} from './known-flag-ids.js';

describe('known-flag-ids', () => {
  it('has 18 per-submission event-stream heuristics', () => {
    expect(PER_SUBMISSION_HEURISTIC_IDS).toHaveLength(18);
  });

  it('has 6 validation-derived integrity flags', () => {
    expect(INTEGRITY_FLAG_IDS).toHaveLength(6);
    // The two ids a 2026-08 audit found missing from one enumeration or the
    // other — regression guard for the specific bug that prompted this file.
    expect(INTEGRITY_FLAG_IDS).toContain('submitted_code_match');
  });

  it('has 2 cross-submission heuristics', () => {
    expect(CROSS_SUBMISSION_HEURISTIC_IDS).toHaveLength(2);
  });

  it('ALL_FLAG_IDS is the union of all three categories, 26 ids total', () => {
    expect(ALL_FLAG_IDS).toHaveLength(26);
    expect(ALL_FLAG_IDS).toEqual([
      ...PER_SUBMISSION_HEURISTIC_IDS,
      ...INTEGRITY_FLAG_IDS,
      ...CROSS_SUBMISSION_HEURISTIC_IDS,
    ]);
    // Regression guard: inter_session_external_change (a per-submission
    // heuristic) was missing from the analyzer's tuning UI list.
    expect(ALL_FLAG_IDS).toContain('inter_session_external_change');
    // Regression guard: submitted_code_match (an integrity flag) was missing
    // from docs/heuristics.md's bundle-validation-flags table.
    expect(ALL_FLAG_IDS).toContain('submitted_code_match');
  });

  it('every id is unique — no flag id appears in more than one category', () => {
    const seen = new Set<string>();
    for (const id of ALL_FLAG_IDS) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(ALL_FLAG_IDS.length);
  });

  it('every id is non-empty snake_case', () => {
    for (const id of ALL_FLAG_IDS) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
