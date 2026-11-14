import { describe, expect, it } from 'vitest';
import {
  fastPathConfigEligible,
  isScoredUnderActive,
  rescoreFromStoredFlags,
} from './dry-run-fast.js';
import { DEFAULT_SERVER_CONFIG, type ServerHeuristicConfig } from '../heuristics/config.js';

function cfg(mutate?: (c: ServerHeuristicConfig) => void): ServerHeuristicConfig {
  const c = JSON.parse(JSON.stringify(DEFAULT_SERVER_CONFIG)) as ServerHeuristicConfig;
  mutate?.(c);
  return c;
}

// ---------------------------------------------------------------------------
// fastPathConfigEligible
// ---------------------------------------------------------------------------

describe('fastPathConfigEligible', () => {
  it('is eligible for an identical config', () => {
    expect(fastPathConfigEligible(cfg(), cfg())).toBe(true);
  });

  it('is eligible for weight changes', () => {
    const candidate = cfg((c) => {
      c.per_flag['large_paste']!.weight = 1.7;
    });
    expect(fastPathConfigEligible(cfg(), candidate)).toBe(true);
  });

  it('is eligible for turning a heuristic OFF', () => {
    const candidate = cfg((c) => {
      c.per_flag['large_paste']!.enabled = false;
    });
    expect(fastPathConfigEligible(cfg(), candidate)).toBe(true);
  });

  it('is eligible for severity_weights changes', () => {
    const candidate = cfg((c) => {
      c.severity_weights.high = 9;
    });
    expect(fastPathConfigEligible(cfg(), candidate)).toBe(true);
  });

  it('is NOT eligible when a heuristic goes from disabled to enabled', () => {
    // Disabled flags are never stored, so there is nothing to re-weight.
    const active = cfg((c) => {
      c.per_flag['large_paste']!.enabled = false;
    });
    expect(fastPathConfigEligible(active, cfg())).toBe(false);
  });

  it('stays eligible when a heuristic is disabled in both', () => {
    const both = (c: ServerHeuristicConfig) => {
      c.per_flag['large_paste']!.enabled = false;
    };
    expect(fastPathConfigEligible(cfg(both), cfg(both))).toBe(true);
  });

  it('is NOT eligible when thresholds change', () => {
    const candidate = cfg((c) => {
      c.per_flag['large_paste']!.thresholds = { minChars: 300 };
    });
    expect(fastPathConfigEligible(cfg(), candidate)).toBe(false);
  });

  it('treats threshold objects with the same content in a different key order as equal', () => {
    const active = cfg((c) => {
      c.per_flag['large_paste']!.thresholds = { a: 1, b: { x: 1, y: 2 } };
    });
    const candidate = cfg((c) => {
      c.per_flag['large_paste']!.thresholds = { b: { y: 2, x: 1 }, a: 1 };
    });
    expect(fastPathConfigEligible(active, candidate)).toBe(true);
  });

  it('treats a missing thresholds object and an empty one as equal', () => {
    const candidate = cfg((c) => {
      c.per_flag['large_paste']!.thresholds = {};
    });
    expect(fastPathConfigEligible(cfg(), candidate)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isScoredUnderActive
// ---------------------------------------------------------------------------

describe('isScoredUnderActive', () => {
  const setAt = new Date('2026-10-01T00:00:00Z');
  const active = { version: 3, set_at: setAt };

  it('is true for a fresh submission recomputed at the active version', () => {
    expect(
      isScoredUnderActive(
        {
          recompute_status: 'fresh',
          heuristic_config_version: 3,
          ingested_at: new Date('2026-09-01T00:00:00Z'),
        },
        active,
      ),
    ).toBe(true);
  });

  it('is true for a fresh submission ingested after the active config was set', () => {
    // Ingest never stamps submissions.heuristic_config_version (it stays 0),
    // but ingest reads the active config after inserting the row, so a row
    // inserted at/after set_at was scored under it.
    expect(
      isScoredUnderActive(
        {
          recompute_status: 'fresh',
          heuristic_config_version: 0,
          ingested_at: new Date('2026-10-02T00:00:00Z'),
        },
        active,
      ),
    ).toBe(true);
  });

  it('is false for a submission ingested before the active config and never recomputed', () => {
    expect(
      isScoredUnderActive(
        {
          recompute_status: 'fresh',
          heuristic_config_version: 0,
          ingested_at: new Date('2026-09-01T00:00:00Z'),
        },
        active,
      ),
    ).toBe(false);
  });

  it('is false for any non-fresh submission, even at the active version', () => {
    for (const status of ['stale', 'recomputing', 'error']) {
      expect(
        isScoredUnderActive(
          {
            recompute_status: status,
            heuristic_config_version: 3,
            ingested_at: new Date('2026-10-02T00:00:00Z'),
          },
          active,
        ),
      ).toBe(false);
    }
  });

  it('with no active config row (version 0, never set), every fresh submission qualifies', () => {
    expect(
      isScoredUnderActive(
        {
          recompute_status: 'fresh',
          heuristic_config_version: 0,
          ingested_at: new Date('2020-01-01T00:00:00Z'),
        },
        { version: 0, set_at: null },
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rescoreFromStoredFlags
// ---------------------------------------------------------------------------

describe('rescoreFromStoredFlags', () => {
  // DEFAULT severity weights: see DEFAULT_SEVERITY_WEIGHTS.
  const sw = DEFAULT_SERVER_CONFIG.severity_weights;

  it('returns 0 / info for no flags', () => {
    expect(rescoreFromStoredFlags([], cfg())).toEqual({
      score_total: 0,
      score_max_severity: 'info',
    });
  });

  it('applies severity_weight × confidence × weight per flag', () => {
    const candidate = cfg((c) => {
      c.per_flag['large_paste']!.weight = 2;
      c.per_flag['external_edits']!.weight = 0.5;
    });
    const result = rescoreFromStoredFlags(
      [
        { heuristic_id: 'large_paste', severity: 'medium', confidence: 0.8 },
        { heuristic_id: 'external_edits', severity: 'high', confidence: 1 },
      ],
      candidate,
    );
    expect(result.score_total).toBeCloseTo(sw.medium * 0.8 * 2 + sw.high * 1 * 0.5, 10);
    expect(result.score_max_severity).toBe('high');
  });

  it('drops disabled heuristics from both the total and the max severity', () => {
    const candidate = cfg((c) => {
      c.per_flag['external_edits']!.enabled = false;
    });
    const result = rescoreFromStoredFlags(
      [
        { heuristic_id: 'large_paste', severity: 'low', confidence: 1 },
        { heuristic_id: 'external_edits', severity: 'high', confidence: 1 },
      ],
      candidate,
    );
    expect(result.score_total).toBeCloseTo(sw.low, 10);
    expect(result.score_max_severity).toBe('low');
  });

  it('keeps a weight-0 flag in the max severity (it is enabled, just worth 0)', () => {
    const candidate = cfg((c) => {
      c.per_flag['external_edits']!.weight = 0;
    });
    const result = rescoreFromStoredFlags(
      [{ heuristic_id: 'external_edits', severity: 'high', confidence: 1 }],
      candidate,
    );
    expect(result.score_total).toBe(0);
    expect(result.score_max_severity).toBe('high');
  });

  it('uses the candidate severity_weights', () => {
    const candidate = cfg((c) => {
      c.severity_weights.medium = 10;
    });
    const result = rescoreFromStoredFlags(
      [{ heuristic_id: 'large_paste', severity: 'medium', confidence: 0.5 }],
      candidate,
    );
    expect(result.score_total).toBeCloseTo(5, 10);
  });

  it('scores a stored flag whose id the config does not list at the default entry', () => {
    // resolvePerFlag semantics: a missing per_flag entry is the enabled
    // default, the same rule ingest and recompute apply.
    const result = rescoreFromStoredFlags(
      [{ heuristic_id: 'some_retired_heuristic', severity: 'low', confidence: 1 }],
      cfg(),
    );
    expect(result.score_total).toBeCloseTo(sw.low, 10);
  });
});
