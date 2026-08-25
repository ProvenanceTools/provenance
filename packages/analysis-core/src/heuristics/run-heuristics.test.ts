/**
 * Tests for the runHeuristics orchestrator (Phase 4).
 *
 * Includes:
 *   - Sort order verification (severity desc, confidence desc, seq asc).
 *   - Config override propagation.
 *   - Snapshot test against a deterministic fixture with one of each trigger.
 *   - Empty-result cases.
 */

import { describe, it, expect } from 'vitest';
import { runHeuristics } from './run-heuristics.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import type { ValidationReport } from '../validation/check-types.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

function makePassReport(): ValidationReport {
  return {
    overall: 'warn', // check 8 is always skipped in v1 → 'warn'
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

function makeChainFailReport(sessionId: string, seq: number): ValidationReport {
  const base = makePassReport();
  return {
    overall: 'fail',
    checks: base.checks.map((c) =>
      c.id === 'chain_integrity'
        ? {
            id: 'chain_integrity',
            label: 'Hash chain integrity',
            status: 'fail',
            detail: `Chain broken at seq ${seq} in session ${sessionId}.`,
            supportingSeqs: [{ sessionId, seq }],
          }
        : c,
    ),
  };
}

// ---------------------------------------------------------------------------
// Empty case
// ---------------------------------------------------------------------------

// Phase 17 note: all test bundles use extension_hash='a'.repeat(64). The default
// known-good list (placeholder) doesn't include it, so extension_hash_mismatch would
// fire on every test. Tests that care about flag counts use SNAPSHOT_CONFIG_OVERRIDE
// defined near the snapshot test block. Tests that only check for specific heuristics
// use filter() to isolate results.

describe('runHeuristics — empty', () => {
  it('returns an empty array when there are no triggering events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    // Use SNAPSHOT_CONFIG_OVERRIDE to suppress extension_hash_mismatch on test bundles.
    // The constant is defined below near the snapshot tests but hoisted references work
    // here because the test runs after module load. We inline the override to avoid
    // forward-reference confusion in this test file.
    const flags = runHeuristics(index, bundle, makePassReport(), {
      extensionHashMismatch: { knownGoodHashes: ['a'.repeat(64)] },
    });
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

describe('runHeuristics — sort order', () => {
  it('sorts high before medium', async () => {
    // Create a chain_broken flag (high) and an external_edits flag (medium).
    // chain_broken is injected via the validation report; external_edits is below
    // highSeverityCharsChanged so it comes out medium.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 50 }, // medium (< 100)
            },
          ],
        },
      ],
    });
    const sessionId = bundle.sessions[0]!.sessionId;
    const report = makeChainFailReport(sessionId, 1);
    const flags = runHeuristics(index, bundle, report, {
      extensionHashMismatch: { knownGoodHashes: ['a'.repeat(64)] },
    });

    expect(flags.length).toBeGreaterThanOrEqual(2);
    // Verify all high flags come before all medium flags.
    let seenMedium = false;
    for (const f of flags) {
      if (f.severity === 'medium') seenMedium = true;
      if (seenMedium) {
        expect(f.severity).not.toBe('high');
      }
    }
  });

  it('sorts higher confidence before lower confidence within same severity', async () => {
    // chain_broken has confidence=1.0; a large paste in an anomaly window has 0.6.
    // Both are 'high' severity. chain_broken should sort first.
    const largePasteContent = 'a'.repeat(600); // high severity
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            // Large paste inside an anomaly window → confidence 0.6
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: largePasteContent,
                length: largePasteContent.length,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 1000,
            },
            {
              kind: 'paste.anomaly',
              data: { path: '/test/file.py', reason: 'no_selection_change' },
              t: 1500,
            },
          ],
        },
      ],
    });
    // First session id from the bundle
    const sessionId = bundle.sessions[0]!.sessionId;
    const chainFailReport = makeChainFailReport(sessionId, 1);
    const flags = runHeuristics(index, bundle, chainFailReport, {
      extensionHashMismatch: { knownGoodHashes: ['a'.repeat(64)] },
    });
    // chain_broken: high, 1.0. large_paste (in anomaly window): high, 0.6.
    const highFlags = flags.filter((f) => f.severity === 'high');
    expect(highFlags.length).toBeGreaterThanOrEqual(2);
    // chain_broken (confidence 1.0) should precede large_paste (confidence 0.6)
    const chainIdx = highFlags.findIndex((f) => f.heuristic === 'chain_broken');
    const pasteIdx = highFlags.findIndex((f) => f.heuristic === 'large_paste');
    expect(chainIdx).not.toBe(-1);
    expect(pasteIdx).not.toBe(-1);
    expect(chainIdx).toBeLessThan(pasteIdx);
  });
});

// ---------------------------------------------------------------------------
// Config override propagation
// ---------------------------------------------------------------------------

describe('runHeuristics — config override', () => {
  it('respects custom minChars override for large_paste', async () => {
    // 100 chars → normally below default 200 minChars, but above custom 50.
    // We use a large-paste-only payload (no content field) so reconstructFile
    // gets a tainted file and low_typing_high_output skips it, keeping the
    // flag count unambiguous.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                // No 'content' field, but length = 100 → checked by large_paste via length field.
                // reconstructFile taints this file (large paste no inline), so
                // low_typing_high_output skips it.
                length: 100,
                sha256: 'a'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });
    // With default config: no flag (100 < 200). Suppress extension_hash_mismatch on test bundles.
    const knownGoodHashOverride = { extensionHashMismatch: { knownGoodHashes: ['a'.repeat(64)] } };
    const defaultFlags = runHeuristics(index, bundle, makePassReport(), knownGoodHashOverride);
    const largePasteDefaultFlags = defaultFlags.filter((f) => f.heuristic === 'large_paste');
    expect(largePasteDefaultFlags).toHaveLength(0);

    // With custom config: flagged (100 >= 50)
    const customFlags = runHeuristics(index, bundle, makePassReport(), {
      largePaste: { ...DEFAULT_HEURISTIC_CONFIG.largePaste, minChars: 50 },
      ...knownGoodHashOverride,
    });
    const largePasteCustomFlags = customFlags.filter((f) => f.heuristic === 'large_paste');
    expect(largePasteCustomFlags).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// integrity flags included in output
// ---------------------------------------------------------------------------

describe('runHeuristics — integrity flags', () => {
  it('includes chain_broken flag when validation report has chain_integrity fail', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 2 }] });
    const sessionId = bundle.sessions[0]!.sessionId;
    const report = makeChainFailReport(sessionId, 3);
    const flags = runHeuristics(index, bundle, report);
    expect(flags.some((f) => f.heuristic === 'chain_broken')).toBe(true);
  });

  it('does not include chain_broken flag when validation passes', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 2 }] });
    const flags = runHeuristics(index, bundle, makePassReport());
    expect(flags.some((f) => f.heuristic === 'chain_broken')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot test: full suite against a deterministic fixture
//
// The fixture has one of each trigger kind:
//   1. One large paste (≥200 chars) → large_paste flag
//   2. One unexplained fs.external_change → external_edits flag
//   3. A high-ratio file (low typing, high output) → low_typing_high_output flag
//   4. A chain-break in the validation report → chain_broken flag
//
// The snapshot exercises the full pipeline in a single deterministic run.
// We assert structural shape, not exact string values, because the session IDs
// are randomized by the test helper (ed25519 keypair → random pubkey).
// Stable properties: heuristic names, severities, count.
//
// Phase 17 note: The snapshot config overrides `knownGoodHashes` to include
// the test bundle's extension_hash ('a'.repeat(64)), preventing
// extension_hash_mismatch from firing on the test fixture. Real deployments
// must populate known-good-extension-hashes.json before enabling this heuristic.
// ---------------------------------------------------------------------------

// The test bundle always uses 'a'.repeat(64) as extension_hash (see build-test-bundle.ts).
// Add it to the known-good list so extension_hash_mismatch does NOT fire in snapshots.
const SNAPSHOT_CONFIG_OVERRIDE = {
  extensionHashMismatch: { knownGoodHashes: ['a'.repeat(64)] },
};

describe('runHeuristics — snapshot fixture', () => {
  it('produces the expected flag set on a fixture with one of each trigger', async () => {
    // 619 chars over 20 lines. Multi-line deliberately: this stands in for a
    // pasted solution.py, and `paste_is_solution` measures coverage of the
    // final file in LINES with a 10-line floor, so a 600-char single line is
    // not a fixture for the thing this file claims to model.
    const largePasteContent = Array.from({ length: 20 }, () => 'x'.repeat(30)).join('\n');
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            // 1. large paste trigger (high severity)
            {
              kind: 'paste',
              data: {
                path: '/test/solution.py',
                content: largePasteContent,
                length: largePasteContent.length,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 1000,
            },
            // 2. external_edits trigger (medium, diff_size < 100)
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/helper.py',
                diff_size: 50,
                // no explanation → unexplained
              },
              t: 2000,
            },
            // 3. low_typing_high_output trigger:
            //    type 1 char in file.py, then paste 4 chars → ratio=5 (high)
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'a',
                  },
                ],
                source: 'typed',
              },
              t: 3000,
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: 'bcde',
                length: 4,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
              t: 3500,
            },
          ],
        },
      ],
    });

    // 4. chain-break in the validation report
    const sessionId = bundle.sessions[0]!.sessionId;
    const report = makeChainFailReport(sessionId, 2);

    // Phase 17: override knownGoodHashes to include test bundle's hash so
    // extension_hash_mismatch does not fire spuriously on this fixture.
    const flags = runHeuristics(index, bundle, report, SNAPSHOT_CONFIG_OVERRIDE);

    // Verify the expected heuristics fired
    const heuristicNames = flags.map((f) => f.heuristic);
    expect(heuristicNames).toContain('chain_broken');
    expect(heuristicNames).toContain('large_paste');
    expect(heuristicNames).toContain('external_edits');
    expect(heuristicNames).toContain('low_typing_high_output');

    // Verify sort order: high before medium
    const severities = flags.map((f) => f.severity);
    const highIdx = severities.lastIndexOf('high');
    const mediumIdx = severities.indexOf('medium');
    // All highs before any medium
    if (mediumIdx !== -1 && highIdx !== -1) {
      expect(highIdx).toBeLessThan(mediumIdx);
    }

    // Verify structural properties of each flag
    for (const flag of flags) {
      expect(flag.id).toBeTruthy();
      expect(flag.heuristic).toBeTruthy();
      expect(flag.title).toBeTruthy();
      expect(['info', 'low', 'medium', 'high']).toContain(flag.severity);
      expect(flag.confidence).toBeGreaterThanOrEqual(0);
      expect(flag.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(flag.supportingSeqs)).toBe(true);
      expect(flag.description).toBeTruthy();
    }

    // Snapshot: assert flag count and heuristic-severity pairs are stable.
    const summary = flags.map((f) => ({ heuristic: f.heuristic, severity: f.severity }));
    // The six flags this fixture produces, named. Asserted EXACTLY (sorted, so
    // this pins the set rather than `runHeuristics`'s sort order) rather than
    // through `arrayContaining` plus a bare `toHaveLength(6)`.
    //
    // That pairing is what let a wrong comment stand here for months: it
    // enumerated five flags against a count of six, claimed
    // `low_typing_high_output` fired on file.py only because "solution.py is
    // tainted by large paste", and `arrayContaining` is a SUBSET match so the
    // second one was invisible to it. solution.py is not tainted — the paste is
    // inline and under the recorder's cap, so it replays — and the heuristic
    // fires once per file, as it is documented to.
    //
    // - chain_broken(1): hash chain integrity failure
    // - large_paste(1): solution.py 619-char / 20-line paste
    // - external_edits(1): helper.py external change, unexplained
    // - low_typing_high_output(2): ONE PER FILE.
    //   file.py: typed 1 char, pasted 4 chars → ratio 5 → high.
    //   solution.py: the 619-char paste over an empty file → infinite ratio → high.
    // - paste_is_solution(1): solution.py paste covers 100% of the final content (20/20 lines)
    //
    // Phase 17 heuristics do not fire on this fixture (no AI tool events, no clock.skew,
    // no heartbeats, single session, extension_hash suppressed via config override above).
    //
    // The fixture is SINGLE-SESSION, so no contributor gate is reachable from it
    // and this count encodes nothing about collaboration. A multi-contributor
    // fixture must never carry a whole-suite count — see
    // `contributor-scope-boundary.test.ts`, which asserts per heuristic.
    const sortKey = (f: { heuristic: string; severity: string }): string =>
      `${f.heuristic}:${f.severity}`;
    expect([...summary].map(sortKey).sort()).toEqual(
      [
        { heuristic: 'chain_broken', severity: 'high' },
        { heuristic: 'external_edits', severity: 'medium' },
        { heuristic: 'large_paste', severity: 'high' },
        { heuristic: 'low_typing_high_output', severity: 'high' },
        { heuristic: 'low_typing_high_output', severity: 'high' },
        { heuristic: 'paste_is_solution', severity: 'high' },
      ]
        .map(sortKey)
        .sort(),
    );

    // IDs are all unique
    const ids = flags.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces identical results on a second run (deterministic)', async () => {
    const content = 'a'.repeat(200);
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content,
                length: content.length,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });
    const report = makePassReport();
    // Suppress extension_hash_mismatch so the test bundle passes the allowlist check.
    const flags1 = runHeuristics(index, bundle, report, SNAPSHOT_CONFIG_OVERRIDE);
    const flags2 = runHeuristics(index, bundle, report, SNAPSHOT_CONFIG_OVERRIDE);
    expect(flags1.map((f) => f.id)).toEqual(flags2.map((f) => f.id));
    expect(flags1.map((f) => f.heuristic)).toEqual(flags2.map((f) => f.heuristic));
  });
});
