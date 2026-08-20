/**
 * D14 per-contributor scoring — the rule that keeps one partner's finding off
 * the other partner.
 *
 * Pure tests, no database: `scoreContributors` is the single definition of what
 * a contributor is charged, and the property that matters is arithmetic, not
 * persistence.
 *
 * The claims defended here:
 *
 *  1. a flag charged to one contributor scores against THAT CONTRIBUTOR ONLY —
 *     this is the wrongful-accusation bar the whole programme is judged on;
 *  2. a SCOPE-LEVEL flag (evidence spanning contributors, or naming none) is
 *     charged to nobody when there is more than one contributor;
 *  3. a SOLE contributor is charged everything, scope-level flags included, so
 *     their total equals the submission's own score exactly — the property that
 *     keeps every existing solo submission's rollup unchanged;
 *  4. a contributor with no findings is still PRESENT with a zero. Absence
 *     would read as "not a contributor", which is a different and false claim.
 */

import { describe, it, expect } from 'vitest';
import { scoreContributors, type ScorableFlag } from './contributor-scores.js';

const ALICE = 'attributed:2.1:institution:berkeley:alice-ref';
const BOB = 'attributed:2.1:institution:berkeley:bob-ref';
const SCOPE = '';

function flag(contributor_key: string, severity: string, score: number): ScorableFlag {
  return {
    heuristic_id: `h_${severity}_${score}`,
    severity,
    confidence: 1,
    score_contribution: score,
    contributor_key,
  };
}

describe('scoreContributors — group (N > 1)', () => {
  it("charges a contributor's flag to that contributor and to NOBODY else", () => {
    const flags = [flag(ALICE, 'high', 8), flag(BOB, 'low', 1)];

    const [alice, bob] = scoreContributors([ALICE, BOB], flags);

    expect(alice!.score_total).toBe(8);
    expect(alice!.score_max_severity).toBe('high');
    expect(alice!.flag_counts).toEqual({ info: 0, low: 0, medium: 0, high: 1 });

    // The load-bearing assertion: Alice's high-severity finding contributes
    // NOTHING to Bob. If this ever passes with 9, an innocent partner is being
    // charged for their co-author's work.
    expect(bob!.score_total).toBe(1);
    expect(bob!.score_max_severity).toBe('low');
    expect(bob!.flag_counts).toEqual({ info: 0, low: 1, medium: 0, high: 0 });
  });

  it('charges a scope-level flag to nobody', () => {
    const flags = [flag(SCOPE, 'high', 8), flag(ALICE, 'low', 1)];

    const [alice, bob] = scoreContributors([ALICE, BOB], flags);

    // Alice gets only her own flag — the scope-level 8 is not added to her.
    expect(alice!.score_total).toBe(1);
    // Bob is untouched by a finding that names nobody.
    expect(bob!.score_total).toBe(0);
    expect(bob!.score_max_severity).toBe('info');
  });

  it('lists a contributor with no findings, at zero, rather than omitting them', () => {
    const scores = scoreContributors([ALICE, BOB], [flag(ALICE, 'medium', 3)]);

    expect(scores).toHaveLength(2);
    expect(scores.map((s) => s.contributor_key)).toEqual([ALICE, BOB]);
    expect(scores[1]!.score_total).toBe(0);
    expect(scores[1]!.flag_counts).toEqual({ info: 0, low: 0, medium: 0, high: 0 });
  });

  it('never lets the sum of contributor scores exceed the scope score', () => {
    const flags = [
      flag(ALICE, 'high', 8),
      flag(BOB, 'medium', 3),
      flag(SCOPE, 'low', 1),
      flag(SCOPE, 'info', 0),
    ];
    const scopeTotal = flags.reduce((n, f) => n + f.score_contribution, 0);

    const scores = scoreContributors([ALICE, BOB], flags);
    const summed = scores.reduce((n, s) => n + s.score_total, 0);

    // Strictly less, because the scope-level flags belong to no one. Equality
    // here would mean a scope-level finding had been charged to someone.
    expect(summed).toBeLessThan(scopeTotal);
    expect(summed).toBe(11);
  });
});

describe('scoreContributors — solo (exactly 1)', () => {
  it("charges the sole contributor EVERYTHING, so their total equals the scope's", () => {
    const flags = [flag(ALICE, 'high', 8), flag(SCOPE, 'medium', 3), flag(SCOPE, 'low', 1)];
    const scopeTotal = flags.reduce((n, f) => n + f.score_contribution, 0);

    const [only] = scoreContributors([ALICE], flags);

    // The property that keeps every pre-existing solo submission's rollup
    // byte-identical. If scope-level flags were excluded here, every solo
    // student's rollup score would silently drop the day this shipped.
    expect(only!.score_total).toBe(scopeTotal);
    expect(only!.score_max_severity).toBe('high');
    expect(only!.flag_counts).toEqual({ info: 0, low: 1, medium: 1, high: 1 });
  });

  it('charges a sole contributor scope-level flags even when NONE name them', () => {
    // The ordinary bundle today: no identity block anywhere, so every flag is
    // scope-level and the only contributor is the roster submitter.
    const flags = [flag(SCOPE, 'high', 8), flag(SCOPE, 'low', 1)];

    const [only] = scoreContributors(['roster:abc'], flags);

    expect(only!.score_total).toBe(9);
    expect(only!.score_max_severity).toBe('high');
  });
});

describe('scoreContributors — degenerate inputs', () => {
  it('returns nothing when there are no contributors', () => {
    expect(scoreContributors([], [flag(SCOPE, 'high', 8)])).toEqual([]);
  });

  it('zeroes every contributor when there are no flags', () => {
    const scores = scoreContributors([ALICE, BOB], []);
    expect(scores.map((s) => s.score_total)).toEqual([0, 0]);
    expect(scores.map((s) => s.score_max_severity)).toEqual(['info', 'info']);
  });

  it('is deterministic — same input, same output, in the order given', () => {
    const flags = [flag(BOB, 'high', 8), flag(ALICE, 'low', 1)];
    const a = scoreContributors([ALICE, BOB], flags);
    const b = scoreContributors([ALICE, BOB], flags);
    expect(a).toEqual(b);
    expect(a.map((s) => s.contributor_key)).toEqual([ALICE, BOB]);
  });
});
