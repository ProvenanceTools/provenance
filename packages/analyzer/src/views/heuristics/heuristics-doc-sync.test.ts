/**
 * heuristics-doc-sync.test.ts
 *
 * Regression guard for a 2026-08 audit finding: the analyzer's TuningView
 * heuristic list and docs/heuristics.md had independently drifted from the
 * real heuristic set — each was missing a different id (TuningView omitted
 * `inter_session_external_change`; the docs omitted `submitted_code_match`),
 * so each still looked internally self-consistent ("25 heuristics" in both
 * places) even though the true union was 26.
 *
 * `@provenance/analysis-core/heuristics/known-flag-ids.js` is now the single
 * source of truth (`ALL_FLAG_IDS`, derived directly from the runtime
 * registries — see that module's doc comment). This test asserts:
 *   1. Every id documented in docs/heuristics.md's heuristic tables is a
 *      real, known id (no stale/typo'd entries).
 *   2. Every real id is documented somewhere in docs/heuristics.md (nothing
 *      missing).
 *
 * TuningView.tsx itself imports ALL_FLAG_IDS directly (no parallel list to
 * drift), so its coverage is asserted separately in TuningView.test.tsx by
 * rendering the view and checking the row count.
 *
 * The doc is read through Vite's `?raw` import rather than `node:fs`: the
 * analyzer package bans `node:*` imports (ESLint `no-restricted-imports`,
 * to keep every module browser-safe) and that rule covers test files too —
 * same pattern as the architecture page's nodes.coverage.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { ALL_FLAG_IDS } from '@provenance/analysis-core/heuristics/known-flag-ids.js';
import heuristicsDoc from '../../../../../docs/heuristics.md?raw';

/**
 * Every `` `snake_case_id` `` that opens a markdown table row in
 * docs/heuristics.md, i.e. lines matching `| \`some_id\` | ...`. This
 * pattern is used consistently for every heuristic/flag-id table in the
 * doc (process-shape, environment, integrity, bundle-validation-flags,
 * cross-submission) as well as the capture-policy-gating table, which only
 * ever names ids that are already real heuristics.
 */
function documentedIds(doc: string): Set<string> {
  const out = new Set<string>();
  const re = /^\|\s*`([a-z][a-z0-9_]*)`/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) out.add(m[1]!);
  return out;
}

describe('docs/heuristics.md heuristic-id sync', () => {
  const documented = documentedIds(heuristicsDoc);
  const known = new Set(ALL_FLAG_IDS);

  it('documents at least one heuristic id (sanity — regex still matches the doc)', () => {
    expect(documented.size).toBeGreaterThan(0);
  });

  it('has no documented id that is not a real, known flag id', () => {
    const stale = [...documented].filter((id) => !known.has(id));
    expect(stale).toEqual([]);
  });

  it('documents every real, known flag id (nothing missing)', () => {
    const missing = [...known].filter((id) => !documented.has(id));
    expect(missing).toEqual([]);
  });

  it('the true heuristic/flag count is 29', () => {
    expect(ALL_FLAG_IDS).toHaveLength(29);
  });
});
