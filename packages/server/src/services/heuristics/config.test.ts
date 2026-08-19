/**
 * Unit tests for validateConfig — Phase 13a.
 *
 * Tests are pure (no DB). Integration tests for getActiveConfig and
 * listConfigHistory are in heuristic-config-integration.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { ALL_FLAG_IDS } from '@provenance/analysis-core/heuristics/known-flag-ids.js';
import {
  validateConfig,
  KNOWN_HEURISTIC_IDS,
  DEFAULT_SERVER_CONFIG,
  DEFAULT_PER_FLAG_ENTRY,
  resolvePerFlag,
  normalizeStoredConfig,
} from './config.js';
import type { ServerHeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid candidate config from DEFAULT_SERVER_CONFIG for test mutation. */
function validCandidate(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_SERVER_CONFIG)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// validateConfig — positive
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  it('accepts a valid complete config', () => {
    const result = validateConfig(validCandidate());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.config_format_version).toBe(1);
      expect(Object.keys(result.config.per_flag)).toHaveLength(KNOWN_HEURISTIC_IDS.size);
      expect(result.config.severity_weights.high).toBe(8);
    }
  });

  it('accepts custom weights in range', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['weight'] = 5;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(true);
  });

  it('accepts weight = 0 (disabled-by-weight)', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['chain_broken'] as Record<string, unknown>)['weight'] = 0;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(true);
  });

  it('accepts weight = 100 (max)', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['weight'] = 100;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(true);
  });

  it('accepts config with optional thresholds field', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['thresholds'] = { minChars: 300 };
    const result = validateConfig(candidate);
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // validateConfig — wrong config_format_version
  // ---------------------------------------------------------------------------

  it('rejects config_format_version !== 1', () => {
    const candidate = validCandidate();
    candidate['config_format_version'] = 2;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('config_format_version'))).toBe(true);
    }
  });

  it('rejects missing config_format_version', () => {
    const candidate = validCandidate();
    delete candidate['config_format_version'];
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // validateConfig — missing heuristic ID
  // ---------------------------------------------------------------------------

  it('rejects config with a missing known heuristic ID', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    delete pf['large_paste'];
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('large_paste') && e.includes('missing'))).toBe(
        true,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // validateConfig — unknown heuristic ID
  // ---------------------------------------------------------------------------

  it('rejects config with an unknown heuristic ID', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    pf['super_fake_heuristic'] = { enabled: true, weight: 1.0 };
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.includes('super_fake_heuristic') && e.includes('unknown')),
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // validateConfig — weight out of range
  // ---------------------------------------------------------------------------

  it('rejects weight > 100', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['weight'] = 101;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('weight'))).toBe(true);
    }
  });

  it('rejects weight < 0', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['weight'] = -1;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
  });

  it('rejects non-finite weight (NaN)', () => {
    const candidate = validCandidate();
    const pf = candidate['per_flag'] as Record<string, unknown>;
    (pf['large_paste'] as Record<string, unknown>)['weight'] = NaN;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // validateConfig — severity_weights issues
  // ---------------------------------------------------------------------------

  it('rejects missing severity_weights key', () => {
    const candidate = validCandidate();
    const sw = candidate['severity_weights'] as Record<string, unknown>;
    delete sw['high'];
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('severity_weights.high'))).toBe(true);
    }
  });

  it('rejects negative severity weight', () => {
    const candidate = validCandidate();
    const sw = candidate['severity_weights'] as Record<string, unknown>;
    sw['medium'] = -1;
    const result = validateConfig(candidate);
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // validateConfig — non-object input
  // ---------------------------------------------------------------------------

  it('rejects null input', () => {
    const result = validateConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('object');
    }
  });

  it('rejects array input', () => {
    const result = validateConfig([]);
    expect(result.ok).toBe(false);
  });

  it('rejects string input', () => {
    const result = validateConfig('{"config_format_version":1}');
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // KNOWN_HEURISTIC_IDS completeness check
  // ---------------------------------------------------------------------------

  it('KNOWN_HEURISTIC_IDS is non-empty', () => {
    expect(KNOWN_HEURISTIC_IDS.size).toBeGreaterThan(0);
  });

  it('DEFAULT_SERVER_CONFIG has an entry for every known ID', () => {
    for (const id of KNOWN_HEURISTIC_IDS) {
      expect(DEFAULT_SERVER_CONFIG.per_flag[id]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Single source of truth: KNOWN_HEURISTIC_IDS is derived from analysis-core
// ---------------------------------------------------------------------------

describe('KNOWN_HEURISTIC_IDS vs analysis-core ALL_FLAG_IDS', () => {
  it('is exactly the set of ids analysis-core can emit (fails if either drifts)', () => {
    // Sorted-array comparison rather than set-size equality so a failure names
    // the drifted ids instead of just reporting two different numbers.
    expect([...KNOWN_HEURISTIC_IDS].sort()).toEqual([...ALL_FLAG_IDS].sort());
  });

  it('has no duplicate ids across the three analysis-core registries', () => {
    expect(KNOWN_HEURISTIC_IDS.size).toBe(ALL_FLAG_IDS.length);
  });

  it('includes the two ids the hand-maintained 24-entry set was missing', () => {
    // Regression guard for the drift found 2026-08: both fired and scored at
    // ingest, then were silently dropped by every recompute because they had
    // no per_flag entry and recompute read "missing" as "disabled".
    expect(KNOWN_HEURISTIC_IDS.has('inter_session_external_change')).toBe(true);
    expect(KNOWN_HEURISTIC_IDS.has('submitted_code_match')).toBe(true);
  });

  it('includes the three bundle-level tamper detections added 2026-08', () => {
    // log_bytes_match / checkpoint_chain_valid / manifest_downgrade are NOT
    // among the PRD §5.4 eight — they ride on ValidationReport.bundleDetections
    // — but they route through CHECK_META and are ordinary tunable Flag rows.
    // If they were missing here, validateConfig would 422 every staff PUT that
    // included them, and the tuning UI would offer a control the server
    // rejects.
    expect(KNOWN_HEURISTIC_IDS.has('log_bytes_match')).toBe(true);
    expect(KNOWN_HEURISTIC_IDS.has('checkpoint_chain_valid')).toBe(true);
    expect(KNOWN_HEURISTIC_IDS.has('manifest_downgrade')).toBe(true);
  });

  it('DEFAULT_SERVER_CONFIG covers every analysis-core flag id and nothing else', () => {
    for (const id of ALL_FLAG_IDS) {
      expect(DEFAULT_SERVER_CONFIG.per_flag[id]).toBeDefined();
    }
    expect(Object.keys(DEFAULT_SERVER_CONFIG.per_flag)).toHaveLength(ALL_FLAG_IDS.length);
  });
});

// ---------------------------------------------------------------------------
// resolvePerFlag — the ONE definition of "what does a missing entry mean"
// ---------------------------------------------------------------------------

/** A stored config in the pre-fix shape: the 24 ids migration 0010 backfilled. */
function legacy24Config(): ServerHeuristicConfig {
  const perFlag: ServerHeuristicConfig['per_flag'] = {};
  for (const id of ALL_FLAG_IDS) {
    if (id === 'inter_session_external_change' || id === 'submitted_code_match') continue;
    perFlag[id] = { enabled: true, weight: 1.0 };
  }
  return {
    per_flag: perFlag,
    severity_weights: { info: 0, low: 1, medium: 3, high: 8 },
    config_format_version: 1,
  };
}

describe('resolvePerFlag', () => {
  it('returns the stored entry when one exists', () => {
    const cfg = legacy24Config();
    cfg.per_flag['large_paste'] = { enabled: false, weight: 0.25 };
    expect(resolvePerFlag(cfg, 'large_paste')).toEqual({ enabled: false, weight: 0.25 });
  });

  it('treats a MISSING entry as enabled at weight 1.0', () => {
    const cfg = legacy24Config();
    expect(cfg.per_flag['submitted_code_match']).toBeUndefined();
    expect(resolvePerFlag(cfg, 'submitted_code_match')).toEqual(DEFAULT_PER_FLAG_ENTRY);
    expect(resolvePerFlag(cfg, 'submitted_code_match').enabled).toBe(true);
    expect(resolvePerFlag(cfg, 'inter_session_external_change').enabled).toBe(true);
  });

  it('an explicit enabled:false still disables (the default only fills absence)', () => {
    const cfg = legacy24Config();
    cfg.per_flag['chain_broken'] = { enabled: false, weight: 1.0 };
    expect(resolvePerFlag(cfg, 'chain_broken').enabled).toBe(false);
  });

  it('does not mutate the config it reads', () => {
    const cfg = legacy24Config();
    resolvePerFlag(cfg, 'submitted_code_match');
    expect(cfg.per_flag['submitted_code_match']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ingest and recompute must agree about the three new ids
// ---------------------------------------------------------------------------

/**
 * The exact failure this guards against already happened once, to
 * `submitted_code_match`: it fired and scored at ingest, then vanished on the
 * first recompute because the two paths disagreed about what a MISSING
 * `per_flag` entry means. Recompute runs on every config commit, so the flag
 * disappeared the moment any staff member touched any weight. Migration 0022
 * backfilled the rows; `resolvePerFlag` is what keeps it from recurring.
 *
 * Every stored `heuristic_configs` row written before today predates these
 * three ids, so all three are in exactly the position `submitted_code_match`
 * was in. These assertions pin the invariant that makes that safe: BOTH
 * `run-per-submission.ts` (ingest) and `recompute-submission.ts` (recompute)
 * resolve a per-flag entry through this one function, so a missing entry means
 * enabled-at-1.0 on both paths and cannot mean different things on each.
 */
describe('the three 2026-08 bundle-level detections survive a stale stored config', () => {
  const NEW_IDS = ['log_bytes_match', 'checkpoint_chain_valid', 'manifest_downgrade'] as const;

  /** A stored row written before the three ids existed. */
  function preDetectionConfig(): ServerHeuristicConfig {
    const perFlag: ServerHeuristicConfig['per_flag'] = {};
    for (const id of ALL_FLAG_IDS) {
      if ((NEW_IDS as readonly string[]).includes(id)) continue;
      perFlag[id] = { enabled: true, weight: 1.0 };
    }
    return {
      per_flag: perFlag,
      severity_weights: { info: 0, low: 1, medium: 3, high: 8 },
      config_format_version: 1,
    };
  }

  it('resolves each new id to enabled at weight 1.0, not dropped', () => {
    const cfg = preDetectionConfig();
    for (const id of NEW_IDS) {
      expect(cfg.per_flag[id]).toBeUndefined();
      expect(resolvePerFlag(cfg, id)).toEqual(DEFAULT_PER_FLAG_ENTRY);
      expect(resolvePerFlag(cfg, id).enabled).toBe(true);
      expect(resolvePerFlag(cfg, id).weight).toBe(1.0);
    }
  });

  it('resolves identically no matter how many times it is called (recompute is idempotent)', () => {
    const cfg = preDetectionConfig();
    for (const id of NEW_IDS) {
      const first = resolvePerFlag(cfg, id);
      const second = resolvePerFlag(cfg, id);
      const third = resolvePerFlag(cfg, id);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
      // And the stale row is still stale — nothing was written back.
      expect(cfg.per_flag[id]).toBeUndefined();
    }
  });

  it('normalizeStoredConfig materializes the three ids so a staff PUT round-trips', () => {
    // Without this the analyzer would GET a 26-entry config, PUT it back, and
    // validateConfig would 422 it for the three entries the row could not have
    // contained when it was written.
    const normalized = normalizeStoredConfig(preDetectionConfig());
    for (const id of NEW_IDS) {
      expect(normalized.per_flag[id]).toEqual(DEFAULT_PER_FLAG_ENTRY);
    }
    expect(validateConfig(normalized).ok).toBe(true);
  });

  it('an explicit staff disable is still honoured for the new ids', () => {
    const cfg = preDetectionConfig();
    cfg.per_flag['log_bytes_match'] = { enabled: false, weight: 1.0 };
    expect(resolvePerFlag(cfg, 'log_bytes_match').enabled).toBe(false);
    // ...and the other two are untouched.
    expect(resolvePerFlag(cfg, 'checkpoint_chain_valid').enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// normalizeStoredConfig — the upgrade path for pre-existing 24-entry rows
// ---------------------------------------------------------------------------

describe('normalizeStoredConfig', () => {
  it('fills every known id a stored row is missing, with the enabled default', () => {
    const normalized = normalizeStoredConfig(legacy24Config());

    expect(Object.keys(normalized.per_flag)).toHaveLength(ALL_FLAG_IDS.length);
    expect(normalized.per_flag['submitted_code_match']).toEqual(DEFAULT_PER_FLAG_ENTRY);
    expect(normalized.per_flag['inter_session_external_change']).toEqual(DEFAULT_PER_FLAG_ENTRY);
  });

  it('leaves entries that ARE present untouched, including disabled ones', () => {
    const stored = legacy24Config();
    stored.per_flag['large_paste'] = { enabled: false, weight: 0 };
    stored.per_flag['chain_broken'] = { enabled: true, weight: 2.5, thresholds: { a: 1 } };

    const normalized = normalizeStoredConfig(stored);
    expect(normalized.per_flag['large_paste']).toEqual({ enabled: false, weight: 0 });
    expect(normalized.per_flag['chain_broken']).toEqual({
      enabled: true,
      weight: 2.5,
      thresholds: { a: 1 },
    });
  });

  it('does not mutate its input', () => {
    const stored = legacy24Config();
    normalizeStoredConfig(stored);
    expect(stored.per_flag['submitted_code_match']).toBeUndefined();
    expect(Object.keys(stored.per_flag)).toHaveLength(ALL_FLAG_IDS.length - 2);
  });

  it('output of a legacy 24-entry row passes validateConfig (GET then PUT round-trip)', () => {
    // Without normalization the analyzer would GET a 24-entry config and PUT it
    // straight back, which the widened known set now 422s on.
    expect(validateConfig(legacy24Config()).ok).toBe(false);
    expect(validateConfig(normalizeStoredConfig(legacy24Config())).ok).toBe(true);
  });

  it('preserves unknown ids rather than dropping staff intent silently', () => {
    const stored = normalizeStoredConfig(legacy24Config());
    stored.per_flag['retired_heuristic'] = { enabled: false, weight: 0 };
    const normalized = normalizeStoredConfig(stored);
    expect(normalized.per_flag['retired_heuristic']).toEqual({ enabled: false, weight: 0 });
  });

  it('severity_weights and format version survive normalization', () => {
    const stored = legacy24Config();
    stored.severity_weights = { info: 1, low: 2, medium: 4, high: 9 };
    const normalized = normalizeStoredConfig(stored);
    expect(normalized.severity_weights).toEqual({ info: 1, low: 2, medium: 4, high: 9 });
    expect(normalized.config_format_version).toBe(1);
  });
});
