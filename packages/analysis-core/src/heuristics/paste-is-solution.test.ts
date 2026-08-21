/**
 * Tests for the paste_is_solution heuristic (Phase 16).
 */

import { describe, it, expect } from 'vitest';
import { pasteIsSolutionHeuristic } from './paste-is-solution.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG, mergeConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

const cfg = DEFAULT_HEURISTIC_CONFIG;

// ---------------------------------------------------------------------------
// Positive: paste that covers ≥80% of the final file's lines
// ---------------------------------------------------------------------------

describe('paste_is_solution — positive', () => {
  it('flags a paste whose content is 100% of the final file', async () => {
    // Build a session where: (a) we paste the whole file, (b) save it.
    // No other edits → the paste IS the final content.
    // 12 lines: comfortably over pasteIsSolution.minSharedLines, and realistic
    // for a submitted solution file.
    const pasteContent = [
      'def solve(data):',
      '    result = []',
      '    for row in data:',
      '        if row is None:',
      '            continue',
      '        result.append(row * 2)',
      '    return result',
      '',
      'def main():',
      '    print(solve([1, 2, 3]))',
      '',
      'main()',
    ].join('\n');

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            // doc.open
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
            },
            // paste the full solution
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: pasteContent,
                length: pasteContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            // save
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags.length).toBeGreaterThanOrEqual(1);

    const flag = flags[0]!;
    expect(flag.heuristic).toBe('paste_is_solution');
    expect(flag.severity).toBe('high');
    expect(flag.confidence).toBe(0.85);
    expect(flag.detail!['coverageRatio']).toBe(1);
    expect(flag.detail!['sharedLines']).toBe(12);
    expect(flag.supportingSeqs).toHaveLength(1);
  });

  it('flags a paste covering exactly 80% of the final file (at threshold boundary)', async () => {
    // Final file is 15 lines; 12 of them came from the paste → coverage 12/15 = 0.80,
    // exactly at pasteIsSolution.finalFileCoverage, and 12 ≥ minSharedLines.
    const sharedLines = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n');
    const extraLines = '\nfinal13\nfinal14\nfinal15';
    const finalContent = sharedLines + extraLines; // 15 lines total in final
    // paste is the 12 shared lines plus 2 lines the student later removed
    const pasteContent = sharedLines + '\npaste_only_1\npaste_only_2'; // 14 lines

    // Build: paste → doc.change (add extra lines) → save
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: pasteContent,
                length: pasteContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            // Replace paste-only lines with the real extra lines via doc.change.
            // Simulating that student edited the paste.
            // For this test we build the final content directly via multiple pastes
            // to keep it simple. Let's use a second paste to set the final state.
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: finalContent,
                length: finalContent.length,
                sha256: 'd'.repeat(64),
                // clamped to EOF — replaces the whole first paste
                range: { start: { line: 0, character: 0 }, end: { line: 14, character: 0 } },
              },
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'e'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    // The first paste covers 12/15 = exactly 80% of finalContent.
    const boundaryFlag = flags.find((f) => (f.detail!['sharedLines'] as number) === 12);
    expect(boundaryFlag, 'the exactly-80%-coverage paste should still flag').toBeDefined();
    expect(boundaryFlag!.detail!['coverageRatio']).toBe(0.8);
    expect(boundaryFlag!.detail!['finalFileLines']).toBe(15);
    expect(boundaryFlag!.severity).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Negative: paste covering <80% of the final file, or no inline content
// ---------------------------------------------------------------------------

describe('paste_is_solution — negative', () => {
  it('does not flag a big paste that covers only part of the final file', async () => {
    // A 12-line block is pasted, survives intact, and the student then types
    // 18 more lines. Coverage is 12/30 = 40% → no flag.
    //
    // This is the defect the coverage gate exists for: survival
    // (sharedLines/pasteLines) is 1.0 here, so the OLD ratio raised `high` on
    // a student who wrote 60% of the file by hand.
    const helper = Array.from({ length: 12 }, (_, i) => `def helper_${i}(): pass`).join('\n');
    const typed = '\n' + Array.from({ length: 18 }, (_, i) => `typed_line_${i} = ${i}`).join('\n');

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0, content: '' },
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: helper,
                length: helper.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            // The student types the rest of the file by hand.
            {
              kind: 'doc.change',
              data: {
                path: '/hw/hw1.py',
                source: 'typed',
                deltas: [
                  {
                    // clamped to EOF
                    range: { start: { line: 99, character: 0 }, end: { line: 99, character: 0 } },
                    text: typed,
                  },
                ],
              },
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'd'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'paste_is_solution')).toHaveLength(0);
  });

  it('does not flag a paste with no inline content field', async () => {
    // Large paste > 4KB — only length/sha256 recorded, no content.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                length: 5000,
                sha256: 'b'.repeat(64),
                // No 'content' field
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });

    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'paste_is_solution')).toHaveLength(0);
  });

  it('produces no flags when there are no paste events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('does not flag when the final file content is empty (tainted by external change)', async () => {
    // fs.external_change clears content → final is empty → cannot flag
    const pasteContent = 'def solve():\n    return 42\n';

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: pasteContent,
                length: pasteContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
            // External change clears reconstructed content
            {
              kind: 'fs.external_change',
              data: {
                path: '/hw/hw1.py',
                old_hash: 'b'.repeat(64),
                new_hash: 'c'.repeat(64),
                diff_size: 0,
              },
            },
          ],
        },
      ],
    });

    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'paste_is_solution')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sizing: the flag must not be reachable by small honest pastes, and must
// still be reachable by the thing it exists to catch. Every "does not fire"
// case below is paired with a "still fires on the real thing" case.
// ---------------------------------------------------------------------------

/** Builds a bundle where `typed` is hand-typed and `pasted` is then pasted on top. */
async function typedThenPasted(typed: string, pasted: string) {
  return buildAndIndex({
    sessions: [
      {
        events: [
          {
            kind: 'doc.open' as const,
            data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0, content: '' },
          },
          ...(typed.length > 0
            ? [
                {
                  kind: 'doc.change' as const,
                  data: {
                    path: '/hw/hw1.py',
                    source: 'typed',
                    deltas: [
                      {
                        range: {
                          start: { line: 0, character: 0 },
                          end: { line: 0, character: 0 },
                        },
                        text: typed,
                      },
                    ],
                  },
                },
              ]
            : []),
          {
            kind: 'paste' as const,
            data: {
              path: '/hw/hw1.py',
              content: pasted,
              length: pasted.length,
              sha256: 'b'.repeat(64),
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            },
          },
          { kind: 'doc.save' as const, data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) } },
        ],
      },
    ],
  });
}

describe('paste_is_solution — sizing', () => {
  const IMPORTS = 'import sys\nimport os\nfrom collections import defaultdict\n';
  const HAND_TYPED_60 = Array.from({ length: 60 }, (_, i) => `line_${i} = ${i}`).join('\n');

  it('does not flag a 3-line import block pasted onto a hand-typed file', async () => {
    // The regression this heuristic's coverage gate exists for. Survival is
    // 1.0 (nobody deleted the imports), which used to raise `high` — the most
    // damning flag in the catalogue — against a student who typed the file.
    const { index, bundle } = await typedThenPasted(HAND_TYPED_60, IMPORTS);
    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('still flags high when the whole 60-line file arrives as one paste', async () => {
    // Same file, but pasted rather than typed. This is the behaviour the whole
    // system exists to detect and it must survive the sizing gates.
    const { index, bundle } = await typedThenPasted('', HAND_TYPED_60);
    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.confidence).toBe(0.85);
    expect(flags[0]!.detail!['coverageRatio']).toBe(1);
    expect(flags[0]!.detail!['sharedLines']).toBe(60);
  });

  it('does not flag a whole-file paste below the minSharedLines floor', async () => {
    // 100% coverage, but only 6 lines. large_paste declines to raise even
    // `medium` under 10 lines; this flag raises `high`, so it must not be
    // reachable below the same floor.
    const tiny = Array.from({ length: 6 }, (_, i) => `tiny_${i} = ${i}`).join('\n');
    const { index, bundle } = await typedThenPasted('', tiny);
    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('flags the same whole-file paste once it clears the floor', async () => {
    const enough = Array.from({ length: 10 }, (_, i) => `tiny_${i} = ${i}`).join('\n');
    const { index, bundle } = await typedThenPasted('', enough);
    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.detail!['sharedLines']).toBe(10);
  });

  it('reports survival alongside coverage, and gates on coverage', async () => {
    // 20 pasted lines all survive (survival 1.0) into a 100-line file.
    const typed = Array.from({ length: 80 }, (_, i) => `typed_${i} = ${i}`).join('\n');
    const pasted = Array.from({ length: 20 }, (_, i) => `pasted_${i} = ${i}`).join('\n') + '\n';
    const { index, bundle } = await typedThenPasted(typed, pasted);
    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    // Coverage 20/100 = 0.2 → no flag, despite survival 1.0.
    expect(flags).toHaveLength(0);

    // And with the coverage threshold lowered, the flag carries both numbers.
    const loose = mergeConfig({ pasteIsSolution: { finalFileCoverage: 0.1, minSharedLines: 10 } });
    const looseFlags = pasteIsSolutionHeuristic.run(index, bundle, loose);
    expect(looseFlags).toHaveLength(1);
    expect(looseFlags[0]!.detail!['coverageRatio']).toBeCloseTo(0.2, 5);
    expect(looseFlags[0]!.detail!['survivalRatio']).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// Recorder v1.2: paste-shaped doc.change should also be evaluated
// ---------------------------------------------------------------------------

describe('paste_is_solution — paste-shaped doc.change (recorder v1.2)', () => {
  it('flags a doc.change with source=paste_likely whose delta text matches the final file', async () => {
    // Bundle: doc.open seeds the file as empty, then a paste_likely
    // doc.change inserts the entire "solution". Final file content equals
    // the inserted text → full coverage → flag.
    const solution =
      'def square(x):\n    return x * x\n\n' +
      'def cube(x):\n    return x * x * x\n\n' +
      'def quad(x):\n    return x ** 4\n\n' +
      'def quint(x):\n    return x ** 5\n\n' +
      'def hexp(x):\n    return x ** 6\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: 'hw.py',
                sha256: 'a'.repeat(64),
                line_count: 1,
                content: '',
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: 'hw.py',
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                    text: solution,
                  },
                ],
                source: 'paste_likely',
              },
            },
          ],
        },
      ],
    });
    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['origin']).toBe('doc.change');
    expect(flags[0]!.detail!['coverageRatio']).toBeGreaterThanOrEqual(
      cfg.pasteIsSolution.finalFileCoverage,
    );
  });
});

// ---------------------------------------------------------------------------
// Internal-move downgrade
// ---------------------------------------------------------------------------

describe('paste_is_solution — internal move downgrade', () => {
  // Sized past pasteIsSolution.minSharedLines (10) so the flag is reachable at
  // all: these tests are about the internal-move classification, not about
  // size, and a 5-shared-line "solution" is a test artefact, not a submission.
  const SOLUTION_LINES = [
    'def solve(data):',
    '    result = []',
    '    for row in data:',
    '        if row is None:',
    '            continue',
    '        result.append(row * 2)',
    '    return result',
    '',
    'def main():',
    '    values = [1, 2, 3, 4]',
    '    print(solve(values))',
    '',
    'main()',
    '',
  ];
  const SOLUTION = SOLUTION_LINES.join('\n');
  /** Last line index of SOLUTION — the cut range end that removes all of it. */
  const SOLUTION_END_LINE = SOLUTION_LINES.length - 1;

  /** Type the solution, cut it out, paste it back — pure reorganisation. */
  const cutAndPasteBack = {
    sessions: [
      {
        events: [
          { kind: 'doc.open' as const, data: { path: '/t/hw.py', content: '' } },
          {
            kind: 'doc.change' as const,
            data: {
              path: '/t/hw.py',
              source: 'typed',
              deltas: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  text: SOLUTION,
                },
              ],
            },
          },
          {
            kind: 'doc.change' as const,
            data: {
              path: '/t/hw.py',
              source: 'typed',
              deltas: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: SOLUTION_END_LINE, character: 0 },
                  },
                  text: '',
                },
              ],
            },
          },
          {
            kind: 'paste' as const,
            data: {
              path: '/t/hw.py',
              content: SOLUTION,
              length: SOLUTION.length,
              sha256: 'inline',
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            },
          },
        ],
      },
    ],
  };

  it('downgrades to info when the student typed the solution then moved it', async () => {
    const { index, bundle } = await buildAndIndex(cutAndPasteBack);
    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('info');
    expect(flags[0]!.heuristic).toBe('paste_is_solution');
    expect(flags[0]!.title).toContain('Code moved');
    const detail = flags[0]!.detail as { internalMove?: { via?: string } };
    expect(detail.internalMove?.via).toBe('cut');
  });

  it('keeps high severity when internalMove is disabled', async () => {
    const { index, bundle } = await buildAndIndex(cutAndPasteBack);
    const disabled = mergeConfig({ internalMove: { ...cfg.internalMove, enabled: false } });
    const flags = pasteIsSolutionHeuristic.run(index, bundle, disabled);

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.title).toContain('Paste matches solution');
  });

  it('keeps high severity for a solution pasted in from outside', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'doc.open' as const, data: { path: '/t/hw.py', content: '' } },
            {
              kind: 'paste' as const,
              data: {
                path: '/t/hw.py',
                content: SOLUTION,
                length: SOLUTION.length,
                sha256: 'inline',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            },
          ],
        },
      ],
    });
    const flags = pasteIsSolutionHeuristic.run(index, bundle, cfg);

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
  });
});
