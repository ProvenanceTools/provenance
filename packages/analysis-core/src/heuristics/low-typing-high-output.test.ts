/**
 * Tests for the low_typing_high_output heuristic (Phase 4).
 */

import { describe, it, expect } from 'vitest';
import { lowTypingHighOutputHeuristic } from './low-typing-high-output.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import {
  buildCollabScope,
  collabDocSave,
  collabPartnerSession,
  collabPullerSession,
  COLLAB_ALICE,
  COLLAB_BOB,
  COLLAB_FILE,
} from '../test-support/build-collab-scope.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

const cfg = DEFAULT_HEURISTIC_CONFIG;

// ---------------------------------------------------------------------------
// Negative: no flags when ratio is below threshold
// ---------------------------------------------------------------------------

describe('low_typing_high_output — negative', () => {
  it('produces no flags when there are no file events', async () => {
    // A bundle with only session.start and doc.change events on a file
    // where typed == final content (ratio = 1)
    // Build a bundle where charsTyped == content length.
    // Default bundle: inserts 'x1' then 'x2' ... 'x5' → content = 'x5x4x3x2x1'
    // charsTyped = 2+2+2+2+2 = 10, content = 'x5x4x3x2x1' = 10 chars → ratio = 1
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 5 }] });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when the final content is empty', async () => {
    // Only session.start and doc.change that add then delete content
    // (content = '' at end). reconstructFile will give empty string.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'hello',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                    text: '',
                  },
                ],
                source: 'typed',
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    // Final content = '' → no flag
    expect(flags).toHaveLength(0);
  });

  it('produces no flags for a tainted file (fs.external_change)', async () => {
    // A file with a doc.change and then an fs.external_change taints reconstruction.
    // The heuristic should skip tainted files entirely.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
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
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 5000 },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive: ratio >= minRatio
// ---------------------------------------------------------------------------

describe('low_typing_high_output — positive', () => {
  it('flags a file where typed 1 char but final content has 3 chars (ratio=3)', async () => {
    // Type 'a' (1 char inserted), but use a paste to add 'bc' so final = 'abc' (3 chars).
    // ratio = 3 / 1 = 3.0 exactly → should flag (>= minRatio).
    //
    // Construct events: doc.change inserts 'a', then paste inserts 'bc' (small inline paste).
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
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
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: 'bc',
                length: 2,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('low_typing_high_output');
    expect(flags[0]!.detail!['ratio']).toBeDefined();
    const ratio = flags[0]!.detail!['ratio'] as number;
    expect(ratio).toBeCloseTo(3.0, 1);
  });

  it('flags with medium severity when ratio is in [3, 5)', async () => {
    // Type 1 char, final = 4 chars → ratio 4 (medium bracket)
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
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
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: 'bcd',
                length: 3,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('medium');
  });

  it('flags with high severity when ratio >= 5', async () => {
    // Type 1 char, final = 5 chars → ratio 5 (high boundary)
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
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
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: 'bcde',
                length: 4,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
  });

  it('does not flag when ratio is exactly below minRatio (< 3)', async () => {
    // Type 2 chars, final = 5 chars → ratio 2.5 (below 3)
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'ab',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: 'cde',
                length: 3,
                range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge: charsTyped = 0, final content non-empty → infinite ratio
// ---------------------------------------------------------------------------

describe('low_typing_high_output — infinite ratio (zero typing)', () => {
  it('flags with high severity when nothing was typed but file has content (via paste)', async () => {
    // No doc.change events, only a paste → charsTyped = 0, but file has content
    const content = 'a'.repeat(10); // small paste, not tainted
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
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    // ratio is null/Infinity → detail.ratio is null
    expect(flags[0]!.detail!['ratio']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Confidence scaling
// ---------------------------------------------------------------------------

describe('low_typing_high_output — confidence', () => {
  it('has lower confidence when charsTyped < minCharsForConfidence', async () => {
    // Type 1 char out of 500 → confidence = 1/500 = 0.002
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
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
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: 'bcde',
                length: 4,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    // charsTyped = 1, minCharsForConfidence = 500 → confidence = 1/500 = 0.002
    expect(flags[0]!.confidence).toBeCloseTo(1 / 500, 4);
  });

  it('caps confidence at 1.0 when charsTyped >= minCharsForConfidence', async () => {
    // Type 500 chars, final = 2000 chars → ratio 4, confidence capped at 1.0
    const typedContent = 'a'.repeat(500);
    const pastedContent = 'b'.repeat(1500);
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: typedContent,
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: pastedContent,
                length: pastedContent.length,
                range: {
                  start: { line: 0, character: typedContent.length },
                  end: { line: 0, character: typedContent.length },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.confidence).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Per-file scope: separate files get separate flags
// ---------------------------------------------------------------------------

describe('low_typing_high_output — per-file scope', () => {
  it('emits one flag per offending file', async () => {
    // Two files: both have high ratio
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            // File A: type 1 char, paste 4 more → ratio 5
            {
              kind: 'doc.change',
              data: {
                path: '/test/a.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'a',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/a.py',
                content: 'bcde',
                length: 4,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
            // File B: type 1 char, paste 4 more → ratio 5
            {
              kind: 'doc.change',
              data: {
                path: '/test/b.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'x',
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/b.py',
                content: 'yzwv',
                length: 4,
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(2);
    const files = flags.map((f) => f.detail!['filePath'] as string).sort();
    expect(files).toEqual(['/test/a.py', '/test/b.py']);
  });
});

// ---------------------------------------------------------------------------
// Net-delta semantics: "output" is finalLength - startLength, not finalLength
// ---------------------------------------------------------------------------

describe('low_typing_high_output — net-delta semantics', () => {
  it('does NOT flag a student who opened a large skeleton and made small edits', async () => {
    // Skeleton (500 chars) opens; student adds 50 chars on top → final 550.
    // Old absolute-size heuristic: 550/50 = 11× (HIGH FLAG, false positive).
    // New net-delta heuristic: (550-500)/50 = 1× (no flag). This is the
    // exact false positive the PRD §7.6.3 example calls out.
    const skeleton = 'x'.repeat(500);
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: '/test/file.py',
                sha256: 'a'.repeat(64),
                line_count: 1,
                content: skeleton,
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 500 },
                      end: { line: 0, character: 500 },
                    },
                    text: 'y'.repeat(50),
                  },
                ],
                source: 'typed',
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('does NOT flag a refactor where the file shrank (deltaLength < 0)', async () => {
    // Student opens 100 chars of skeleton, types 5 chars, ends with 80 chars
    // (i.e. deleted 25 net). deltaLength = -20 → no flag.
    const skeleton = 'x'.repeat(100);
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: '/test/file.py',
                sha256: 'a'.repeat(64),
                line_count: 1,
                content: skeleton,
              },
            },
            // Delete 25 chars
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 25 },
                    },
                    text: '',
                  },
                ],
                source: 'typed',
              },
            },
            // Type 5 chars
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 0 },
                    },
                    text: 'hello',
                  },
                ],
                source: 'typed',
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('DOES flag when deltaLength is high relative to typing', async () => {
    // 100-char skeleton; student types 10 chars but file ends at 500 chars
    // (paste added 390). deltaLength = 400, ratio = 400/10 = 40 → high.
    const skeleton = 'x'.repeat(100);
    const pasted = 'p'.repeat(390);
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: '/test/file.py',
                sha256: 'a'.repeat(64),
                line_count: 1,
                content: skeleton,
              },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/test/file.py',
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 100 },
                      end: { line: 0, character: 100 },
                    },
                    text: 't'.repeat(10),
                  },
                ],
                source: 'typed',
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: pasted,
                length: pasted.length,
                range: {
                  start: { line: 0, character: 110 },
                  end: { line: 0, character: 110 },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.detail!['startLength']).toBe(100);
    expect(flags[0]!.detail!['finalLength']).toBe(500);
    expect(flags[0]!.detail!['deltaLength']).toBe(400);
    expect(flags[0]!.detail!['ratio']).toBe(40);
  });

  it('falls back to startLength=0 when doc.open has no content field (pre-v1.1 bundles)', async () => {
    // doc.open omits `content` (older recorder). Heuristic should treat
    // startLength as 0, matching legacy behavior. File grows to 100 chars
    // with 0 typed → infinite ratio, high severity.
    const pasted = 'p'.repeat(100);
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: '/test/file.py',
                sha256: 'a'.repeat(64),
                line_count: 1,
                // no `content` field
              },
            },
            {
              kind: 'paste',
              data: {
                path: '/test/file.py',
                content: pasted,
                length: pasted.length,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              },
            },
          ],
        },
      ],
    });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.detail!['startLength']).toBe(0);
    expect(flags[0]!.detail!['deltaLength']).toBe(100);
    expect(flags[0]!.detail!['ratio']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tier 3.1 — content a git merge delivered is not this student's output
// ---------------------------------------------------------------------------
//
// The false accusation this section exists to prevent: Alice pulls Bob's work
// onto a descendant commit, so the file re-anchors and Tier 2.2 answers
// `determinate`. She never had the file open, so `startLength = 0` and
// `charsTyped = 0`, and the ratio is infinite — HIGH severity, confidence 1.0,
// on a student who ran `git pull`. There is no way for her to avoid the shape.
//
// The fix subtracts the merged-in characters rather than skipping the file, so
// each case below has a partner: honest pull produces nothing, the same pull
// followed by real unexplained output still fires.

describe('low_typing_high_output — Tier 3.1 (git merge is not output)', () => {
  const IMPLEMENTATION =
    Array.from(
      { length: 24 },
      (_, i) => `def helper_${i}(value):\n    return value * ${i} + 1`,
    ).join('\n') + '\n';

  /** Content of the same size that NO contributor recorded. */
  const ELSEWHERE =
    Array.from({ length: 24 }, (_, i) => `def other_${i}(value):\n    return value - ${i}`).join(
      '\n',
    ) + '\n';

  function honestPull(opts: Parameters<typeof collabPullerSession>[1] = {}) {
    return [
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(IMPLEMENTATION) },
      {
        who: { studentRef: COLLAB_ALICE },
        events: collabPullerSession(IMPLEMENTATION, { merge: true, ...opts }),
      },
    ] satisfies Parameters<typeof buildCollabScope>[0];
  }

  it('does not fire on an honest `git pull` of a partner’s recorded work', async () => {
    const { bundle, index } = await buildCollabScope(honestPull());
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(
      flags,
      'low_typing_high_output fired on an honest pull. Two enrolled partners sharing one ' +
        'repository must not collect a high-severity finding for collaborating — this is the ' +
        '"no false accusations" row. Do not relax this assertion; find what stopped ' +
        'discounting the merged-in content.',
    ).toHaveLength(0);
  });

  it('the same events WITHOUT a contributor verdict still fire — the zero above is the gate', async () => {
    // An unstamped bundle is the ordinary 1.x / unenrolled / no-root-key state:
    // `compareContributors` answers `'unknown'`, nothing is `git_merge_in`, and
    // the heuristic behaves exactly as it did before Tier 3.1. Without this the
    // zero above would be satisfied by a heuristic that had simply stopped
    // working.
    const { bundle, index } = await buildCollabScope(honestPull(), { stamp: false });
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]!.severity).toBe('high');
  });

  it('still fires when the student pastes unexplained content after the pull', async () => {
    const pasted = 'z'.repeat(900);
    const { bundle, index } = await buildCollabScope(
      honestPull({
        after: [
          {
            kind: 'paste',
            data: {
              path: COLLAB_FILE,
              content: pasted,
              length: pasted.length,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            },
          },
          collabDocSave(pasted + IMPLEMENTATION),
        ],
      }),
    );
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(
      flags,
      'the discount must be limited to the characters git delivered. A pull followed by an ' +
        'unexplained 900-char paste is still unexplained output.',
    ).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.detail!['deltaLength']).toBe(pasted.length);
    expect(flags[0]!.detail!['mergedInChars']).toBe(IMPLEMENTATION.length);
  });

  it('D16: a recorder `explanation: git` tag does not discount content nobody recorded', async () => {
    // Same pull shape, same two-second timing tag — but the bytes match nothing
    // any contributor recorded, so the content test answers `git_unrecorded_in`
    // and the flag stands. This is the hole D16 closed for `external_edits`:
    // if a timing tag could silence the finding, a student could time an
    // out-of-editor paste right after any git command.
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(IMPLEMENTATION) },
      {
        who: { studentRef: COLLAB_ALICE },
        events: collabPullerSession(ELSEWHERE, { merge: true, explanation: 'git' }),
      },
    ]);
    const flags = lowTypingHighOutputHeuristic.run(index, bundle, cfg);
    expect(
      flags,
      'content that no verified contributor recorded must still be unexplained output, ' +
        'however it was tagged. Discounting on the tag is exactly the shape D16 rejected.',
    ).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.detail!['mergedInChars']).toBe(0);
  });
});
