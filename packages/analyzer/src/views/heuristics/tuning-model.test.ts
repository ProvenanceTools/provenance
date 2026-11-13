import { describe, it, expect } from 'vitest';
import type { HeuristicConfigBody } from '@provenance/shared/api-schemas';
import {
  candidateKey,
  changedMovers,
  flagSetting,
  humanizeId,
  impactSummary,
  isFlagModified,
  modifiedIds,
  reEnabledIds,
  resetFlag,
  updateFlag,
  type DryRunDiffBody,
  type TopMover,
} from './tuning-model.js';

function config(perFlag: HeuristicConfigBody['per_flag']): HeuristicConfigBody {
  return {
    per_flag: perFlag,
    severity_weights: { info: 0, low: 1, medium: 3, high: 8 },
    config_format_version: 1,
  };
}

const IDS = ['a_flag', 'b_flag', 'c_flag'];

function mover(old_score: number, new_score: number, n = 0): TopMover {
  return {
    submission_id: `aa000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    student: null,
    contributors: [],
    assignment: { assignment_id_str: 'hw1', label: null },
    old_score,
    new_score,
    old_tier: null,
    new_tier: null,
  };
}

function diff(tier: number, movers: TopMover[]): DryRunDiffBody {
  return {
    submissions_with_tier_change: tier,
    top_movers: movers,
    score_histogram_old: [],
    score_histogram_new: [],
    score_histogram_upper_bound: 10,
  };
}

describe('tuning-model', () => {
  const active = config({
    a_flag: { enabled: true, weight: 1 },
    b_flag: { enabled: false, weight: 1 },
  });

  it('defaults a missing entry to enabled at weight 1.0', () => {
    expect(flagSetting(active, 'c_flag')).toEqual({ enabled: true, weight: 1 });
  });

  it('detects weight and enabled changes, tolerating float noise', () => {
    expect(
      isFlagModified(active, updateFlag(active, 'a_flag', { weight: 1 + 1e-12 }), 'a_flag'),
    ).toBe(false);
    expect(isFlagModified(active, updateFlag(active, 'a_flag', { weight: 1.1 }), 'a_flag')).toBe(
      true,
    );
    expect(isFlagModified(active, updateFlag(active, 'b_flag', { enabled: true }), 'b_flag')).toBe(
      true,
    );
    // A missing entry and an explicit default entry are the same setting.
    expect(isFlagModified(active, updateFlag(active, 'c_flag', {}), 'c_flag')).toBe(false);
  });

  it('lists modified ids in display order and finds off → on transitions only', () => {
    let cand = updateFlag(active, 'b_flag', { enabled: true });
    cand = updateFlag(cand, 'a_flag', { enabled: false });
    expect(modifiedIds(IDS, active, cand)).toEqual(['a_flag', 'b_flag']);
    expect(reEnabledIds(IDS, active, cand)).toEqual(['b_flag']);
    // Turning something off and changing weights is never a re-enable.
    expect(reEnabledIds(IDS, active, updateFlag(active, 'a_flag', { weight: 2 }))).toEqual([]);
  });

  it('keys candidates by their tunable settings only', () => {
    const a = updateFlag(active, 'a_flag', { weight: 1.5 });
    const b = updateFlag(active, 'a_flag', { weight: 1.5 });
    expect(candidateKey(IDS, a)).toBe(candidateKey(IDS, b));
    expect(candidateKey(IDS, a)).not.toBe(candidateKey(IDS, active));
  });

  it('resetFlag copies the active setting back, or drops an entry the active lacks', () => {
    const cand = updateFlag(updateFlag(active, 'a_flag', { weight: 2 }), 'c_flag', { weight: 0 });
    const resetA = resetFlag(active, cand, 'a_flag');
    expect(resetA.per_flag['a_flag']).toEqual({ enabled: true, weight: 1 });
    expect(resetA.per_flag['c_flag']).toEqual({ enabled: true, weight: 0 });
    const resetC = resetFlag(active, cand, 'c_flag');
    expect('c_flag' in resetC.per_flag).toBe(false);
    // The input candidate is not mutated.
    expect(cand.per_flag['a_flag']!.weight).toBe(2);
  });

  it('humanizes ids', () => {
    expect(humanizeId('large_paste')).toBe('Large paste');
    expect(humanizeId('extension_hash_mismatch')).toBe('Extension hash mismatch');
  });

  it('changedMovers drops rows whose score does not move', () => {
    const movers = [mover(3, 5, 1), mover(0, 0, 2), mover(1, 1.004, 3), mover(2, 1.9, 4)];
    expect(changedMovers(movers).map((m) => m.new_score)).toEqual([5, 1.9]);
  });

  describe('impactSummary', () => {
    it('counts movers beyond 0.05 exactly when the list is not saturated', () => {
      expect(impactSummary(diff(14, [mover(1, 2), mover(1, 1.5), mover(1, 1.01)]))).toBe(
        '14 submissions change tier · 2 scores move by more than 0.05',
      );
      expect(impactSummary(diff(1, [mover(1, 2)]))).toBe(
        '1 submission changes tier · 1 score moves by more than 0.05',
      );
    });

    it('says so when nothing moves', () => {
      expect(impactSummary(diff(0, [mover(0, 0)]))).toBe(
        '0 submissions change tier · no scores move by more than 0.05',
      );
    });

    it('reports 20+ when every slot of a full mover list clears the threshold', () => {
      const full = Array.from({ length: 20 }, (_, i) => mover(0, 1, i));
      expect(impactSummary(diff(3, full))).toBe(
        '3 submissions change tier · 20+ scores move by more than 0.05',
      );
    });
  });
});
