/**
 * Unit tests for translateFlagsToRows — the recompute-side Flag[] → flags-row
 * translation. Pure (no DB, no testcontainers).
 *
 * ## Why this file exists
 *
 * A 2026-08 audit found the server's hand-maintained KNOWN_HEURISTIC_IDS had
 * 24 entries while analysis-core emits 26 (`inter_session_external_change` and
 * `submitted_code_match` were missing). The two consumers of the config then
 * disagreed about what a MISSING per_flag entry meant:
 *
 *   - ingest (run-per-submission.ts): `?? { enabled: true, weight: 1.0 }`
 *   - recompute (this module):        `if (!perFlagCfg || !perFlagCfg.enabled) continue`
 *
 * So both flags fired and scored at ingest and were then silently dropped —
 * not merely un-tunable, but unscored and invisible — the first time any staff
 * member adjusted any weight and triggered a recompute. `submitted_code_match`
 * is the check-8 tamper-detection flag.
 *
 * Both paths now route the decision through `resolvePerFlag` in
 * services/heuristics/config.ts, which is the single definition of the
 * default. These tests pin that behaviour on the recompute side; the ingest
 * side is pinned in services/heuristics/run-per-submission.test.ts, and the
 * two are asserted to agree below.
 */

import { describe, it, expect } from 'vitest';
import { ALL_FLAG_IDS } from '@provenance/analysis-core/heuristics/known-flag-ids.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import { translateFlagsToRows } from './recompute-submission.js';
import { resolvePerFlag, DEFAULT_PER_FLAG_ENTRY } from '../heuristics/config.js';
import type { ServerHeuristicConfig } from '../heuristics/config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';
const SEMESTER_ID = '22222222-2222-4222-8222-222222222222';
const CONFIG_VERSION = 7;

/**
 * A stored config in the pre-fix shape: exactly the 24 ids migration 0010
 * backfilled, i.e. every analysis-core id EXCEPT the two that drifted.
 */
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

function makeFlag(heuristic: string, overrides: Partial<Flag> = {}): Flag {
  return {
    heuristic,
    severity: 'high',
    confidence: 0.5,
    title: `${heuristic} title`,
    description: `${heuristic} description`,
    supportingSeqs: [],
    detail: {},
    ...overrides,
  } as Flag;
}

/**
 * Minimal stand-in for the EventIndex translateFlagsToRows needs: it only ever
 * reads `index.bySeq`. Flags here carry no supporting seqs, so an empty map is
 * enough and keeps the test free of bundle-building machinery.
 */
function makeIndex(entries: Array<[string, number]> = []) {
  const bySeq = new Map(entries.map(([key, globalIdx]) => [key, { globalIdx }]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the one field this function reads
  return { bySeq } as any;
}

function translate(rawFlags: Flag[], config: ServerHeuristicConfig) {
  return translateFlagsToRows(
    rawFlags,
    makeIndex(),
    SUBMISSION_ID,
    SEMESTER_ID,
    config,
    CONFIG_VERSION,
  );
}

// ---------------------------------------------------------------------------
// The regression: a flag with no per_flag entry must survive a recompute
// ---------------------------------------------------------------------------

describe('translateFlagsToRows — missing per_flag entry', () => {
  it('keeps submitted_code_match when the stored config predates it', () => {
    const config = legacy24Config();
    expect(config.per_flag['submitted_code_match']).toBeUndefined();

    const { flagRows, scoreInputs } = translate([makeFlag('submitted_code_match')], config);

    // Before the fix this was [] — the check-8 tamper flag vanished from the
    // flags table, and from the score, on the first recompute.
    expect(flagRows).toHaveLength(1);
    expect(flagRows[0]!.heuristic_id).toBe('submitted_code_match');
    expect(flagRows[0]!.weight_at_compute).toBe(1.0);
    // severity_weights.high (8) * confidence (0.5) * weight (1.0)
    expect(flagRows[0]!.score_contribution).toBeCloseTo(4.0);
    expect(scoreInputs).toHaveLength(1);
    expect(scoreInputs[0]!.score_contribution).toBeCloseTo(4.0);
  });

  it('keeps inter_session_external_change when the stored config predates it', () => {
    const config = legacy24Config();
    const { flagRows } = translate(
      [makeFlag('inter_session_external_change', { severity: 'medium', confidence: 1 })],
      config,
    );

    expect(flagRows).toHaveLength(1);
    expect(flagRows[0]!.weight_at_compute).toBe(DEFAULT_PER_FLAG_ENTRY.weight);
    // severity_weights.medium (3) * confidence (1) * weight (1.0)
    expect(flagRows[0]!.score_contribution).toBeCloseTo(3.0);
  });

  it('keeps a flag whose id is not known to the server at all', () => {
    // Forward compatibility: a server running an older config than the
    // analysis-core it links against must still surface new evidence.
    const { flagRows } = translate([makeFlag('some_future_heuristic')], legacy24Config());
    expect(flagRows).toHaveLength(1);
    expect(flagRows[0]!.heuristic_id).toBe('some_future_heuristic');
  });

  it('still honours an explicit enabled:false', () => {
    const config = legacy24Config();
    config.per_flag['large_paste'] = { enabled: false, weight: 1.0 };
    const { flagRows, scoreInputs } = translate([makeFlag('large_paste')], config);
    expect(flagRows).toHaveLength(0);
    expect(scoreInputs).toHaveLength(0);
  });

  it('still honours an explicit weight', () => {
    const config = legacy24Config();
    config.per_flag['large_paste'] = { enabled: true, weight: 0.5 };
    const { flagRows } = translate([makeFlag('large_paste')], config);
    expect(flagRows[0]!.weight_at_compute).toBe(0.5);
    expect(flagRows[0]!.score_contribution).toBeCloseTo(2.0);
  });

  it('writes the supplied config version onto every row', () => {
    const { flagRows } = translate([makeFlag('submitted_code_match')], legacy24Config());
    expect(flagRows[0]!.heuristic_config_version).toBe(CONFIG_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Ingest / recompute parity
// ---------------------------------------------------------------------------

describe('ingest and recompute agree on enabled/disabled', () => {
  // Ingest (run-per-submission.ts) and recompute (this module) both call
  // resolvePerFlag. This asserts the recompute path's observable verdict — a
  // row emitted or not — matches resolvePerFlag's answer for every id
  // analysis-core can emit, under a config that is missing two of them.
  it('produces a row for exactly the ids resolvePerFlag reports as enabled', () => {
    const config = legacy24Config();
    config.per_flag['chain_broken'] = { enabled: false, weight: 1.0 };

    const rawFlags = ALL_FLAG_IDS.map((id) => makeFlag(id));
    const { flagRows } = translate(rawFlags, config);
    const emitted = new Set(flagRows.map((r) => r.heuristic_id));

    for (const id of ALL_FLAG_IDS) {
      expect(emitted.has(id)).toBe(resolvePerFlag(config, id).enabled);
    }
    // Sanity: the disabled one is the only omission, and the two ids with no
    // entry at all are present.
    expect(emitted.has('chain_broken')).toBe(false);
    expect(emitted.has('submitted_code_match')).toBe(true);
    expect(emitted.has('inter_session_external_change')).toBe(true);
    expect(flagRows).toHaveLength(ALL_FLAG_IDS.length - 1);
  });

  it('weights rows with exactly the weight resolvePerFlag reports', () => {
    const config = legacy24Config();
    config.per_flag['large_paste'] = { enabled: true, weight: 2.0 };

    const rawFlags = ALL_FLAG_IDS.map((id) => makeFlag(id));
    const { flagRows } = translate(rawFlags, config);

    for (const row of flagRows) {
      expect(row.weight_at_compute).toBe(resolvePerFlag(config, row.heuristic_id).weight);
    }
  });
});
