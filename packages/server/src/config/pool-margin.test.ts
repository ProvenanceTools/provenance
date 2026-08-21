import { describe, it, expect } from 'vitest';
import { checkPoolMargin, type PoolMarginConfig } from './pool-margin.js';

function cfg(overrides: Partial<PoolMarginConfig> = {}): PoolMarginConfig {
  return {
    DATABASE_POOL_MAX: 10,
    INGEST_CONCURRENCY: 4,
    INGEST_STAGE_CONCURRENCY: 1,
    RECOMPUTE_MAX_PARALLEL: 4,
    ...overrides,
  };
}

describe('checkPoolMargin', () => {
  it('flags the shipped defaults (sum 9 of 10) as thin', () => {
    const result = checkPoolMargin(cfg());
    expect(result.concurrencySum).toBe(9);
    expect(result.margin).toBe(1);
    expect(result.minMargin).toBe(3);
    expect(result.thin).toBe(true);
  });

  it('is not thin once the margin clears the 25%-of-pool floor', () => {
    // POOL_MAX=20, sum=9 → margin=11, minMargin=max(3, ceil(20*0.25))=5 → not thin.
    const result = checkPoolMargin(cfg({ DATABASE_POOL_MAX: 20 }));
    expect(result.margin).toBe(11);
    expect(result.minMargin).toBe(5);
    expect(result.thin).toBe(false);
  });

  it('the fixed floor of 3 still applies to a small pool where 25% would be looser', () => {
    // POOL_MAX=8, sum=4 → margin=4. 25% of 8 is 2, but the floor is max(3, 2)=3, so
    // a margin of 4 clears it — not thin. Lower the pool further to trip the floor.
    const generous = checkPoolMargin(
      cfg({
        DATABASE_POOL_MAX: 8,
        INGEST_CONCURRENCY: 2,
        INGEST_STAGE_CONCURRENCY: 1,
        RECOMPUTE_MAX_PARALLEL: 1,
      }),
    );
    expect(generous.minMargin).toBe(3);
    expect(generous.margin).toBe(4);
    expect(generous.thin).toBe(false);

    const tight = checkPoolMargin(
      cfg({
        DATABASE_POOL_MAX: 8,
        INGEST_CONCURRENCY: 3,
        INGEST_STAGE_CONCURRENCY: 1,
        RECOMPUTE_MAX_PARALLEL: 2,
      }),
    );
    expect(tight.minMargin).toBe(3);
    expect(tight.margin).toBe(2);
    expect(tight.thin).toBe(true);
  });

  it('scales the 25% floor up for a large deployment pool', () => {
    // POOL_MAX=100, sum=20 → margin=80, minMargin=max(3, ceil(25))=25 → not thin.
    const notThin = checkPoolMargin(
      cfg({
        DATABASE_POOL_MAX: 100,
        INGEST_CONCURRENCY: 8,
        INGEST_STAGE_CONCURRENCY: 4,
        RECOMPUTE_MAX_PARALLEL: 8,
      }),
    );
    expect(notThin.minMargin).toBe(25);
    expect(notThin.thin).toBe(false);

    // Same pool, but the knobs were raised right alongside it (as §2.6 warns
    // against doing without also raising the margin) — sum=90, margin=10 < 25.
    const thin = checkPoolMargin(
      cfg({
        DATABASE_POOL_MAX: 100,
        INGEST_CONCURRENCY: 40,
        INGEST_STAGE_CONCURRENCY: 10,
        RECOMPUTE_MAX_PARALLEL: 40,
      }),
    );
    expect(thin.margin).toBe(10);
    expect(thin.thin).toBe(true);
  });

  it('reports a negative margin (sum exceeds the pool) as thin', () => {
    const result = checkPoolMargin(
      cfg({
        DATABASE_POOL_MAX: 5,
        INGEST_CONCURRENCY: 4,
        INGEST_STAGE_CONCURRENCY: 1,
        RECOMPUTE_MAX_PARALLEL: 4,
      }),
    );
    expect(result.concurrencySum).toBe(9);
    expect(result.margin).toBe(-4);
    expect(result.thin).toBe(true);
  });

  it('never throws — this check only ever produces a value, never an error', () => {
    expect(() => checkPoolMargin(cfg({ DATABASE_POOL_MAX: 0 }))).not.toThrow();
    expect(() =>
      checkPoolMargin(
        cfg({ INGEST_CONCURRENCY: 0, INGEST_STAGE_CONCURRENCY: 0, RECOMPUTE_MAX_PARALLEL: 0 }),
      ),
    ).not.toThrow();
  });
});
