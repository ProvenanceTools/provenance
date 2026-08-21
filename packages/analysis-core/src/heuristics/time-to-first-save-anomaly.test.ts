/**
 * Tests for the time_to_first_save_anomaly heuristic (Phase 16).
 */

import { describe, it, expect } from 'vitest';
import { timeToFirstSaveAnomalyHeuristic } from './time-to-first-save-anomaly.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import {
  buildCollabScope,
  collabDocOpen,
  collabDocSave,
  collabPartnerSession,
  collabPullerSession,
  COLLAB_ALICE,
  COLLAB_BOB,
  COLLAB_FILE,
} from '../test-support/build-collab-scope.js';
import type { EventSpec } from '../test-support/build-test-bundle.js';

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
// t=1000ms = 1s per event step in explicit events.

// ---------------------------------------------------------------------------
// Positive: open → save in <30s with >500 chars
// ---------------------------------------------------------------------------

describe('time_to_first_save_anomaly — positive', () => {
  it('flags a save that arrives <30s after doc.open with >500 chars', async () => {
    // Build: doc.open at t=0 (seq 1) → paste 600 chars → doc.save at t=5000 (5s)
    const content = 'x'.repeat(600);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 0,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content,
                length: content.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 2000,
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) },
              t: 5000, // 5 seconds after open → anomalous
            },
          ],
        },
      ],
    });

    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags.length).toBeGreaterThanOrEqual(1);

    const flag = flags[0]!;
    expect(flag.heuristic).toBe('time_to_first_save_anomaly');
    expect(flag.severity).toBe('high');
    expect(flag.confidence).toBe(0.8);
    expect(flag.detail!['elapsedMs']).toBe(5000);
    expect(flag.detail!['contentLength'] as number).toBeGreaterThan(500);
    // Both open and save are in supportingSeqs
    expect(flag.supportingSeqs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Negative: does not flag when elapsed ≥30s or content ≤500 chars
// ---------------------------------------------------------------------------

describe('time_to_first_save_anomaly — negative', () => {
  it('does not flag when elapsed time is ≥30s', async () => {
    const content = 'x'.repeat(600);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 0,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content,
                length: content.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 5000,
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) },
              t: 35000, // 35s → not anomalous
            },
          ],
        },
      ],
    });

    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'time_to_first_save_anomaly')).toHaveLength(0);
  });

  it('does not flag when content ≤500 chars even if fast', async () => {
    // Only 300 chars — below minChars=500
    const content = 'x'.repeat(300);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 0,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content,
                length: content.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 2000,
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) },
              t: 5000,
            },
          ],
        },
      ],
    });

    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'time_to_first_save_anomaly')).toHaveLength(0);
  });

  it('does not flag when there is no doc.save in the same session after doc.open', async () => {
    const content = 'x'.repeat(600);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 0,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content,
                length: content.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 2000,
            },
            // No doc.save
          ],
        },
      ],
    });

    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'time_to_first_save_anomaly')).toHaveLength(0);
  });

  it('produces no flags for a normal session with no file events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('does not flag a quick save of a large file the student only edited slightly', async () => {
    // Regression: opening an existing 15k-char file (content seeded by doc.open,
    // all of it `preexisting`), typing a single newline, then saving 9s later
    // used to flag because the heuristic counted TOTAL reconstructed chars.
    // PRD §7.4 gates on >500 chars of *new* code.
    const preexisting = 'x'.repeat(15000);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: '/hw/cats.py',
                content: preexisting,
                sha256: 'a'.repeat(64),
                line_count: 1,
              },
              t: 0,
            },
            {
              kind: 'doc.change',
              data: {
                path: '/hw/cats.py',
                deltas: [
                  {
                    range: {
                      start: { line: 0, character: 7000 },
                      end: { line: 0, character: 7000 },
                    },
                    text: '\n',
                  },
                ],
              },
              t: 4000,
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/cats.py', sha256: 'c'.repeat(64) },
              t: 9000, // 9s after open — fast, but only 1 new char
            },
          ],
        },
      ],
    });

    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'time_to_first_save_anomaly')).toHaveLength(0);
  });

  it('still flags a large paste into an existing file within the window', async () => {
    // Counterpart to the regression above: the preexisting bulk must not mask a
    // genuinely fast injection of new code either.
    const preexisting = 'x'.repeat(15000);
    const pasted = 'y'.repeat(600);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: '/hw/cats.py',
                content: preexisting,
                sha256: 'a'.repeat(64),
                line_count: 1,
              },
              t: 0,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/cats.py',
                content: pasted,
                length: pasted.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 4000,
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/cats.py', sha256: 'c'.repeat(64) },
              t: 9000,
            },
          ],
        },
      ],
    });

    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['newChars']).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// Tier 3.1 — a `git pull` inside the window did not type anything
// ---------------------------------------------------------------------------
//
// Open the starter, run `git pull` in the terminal, save. Ten seconds, 1000+
// chars of "new content", HIGH severity — on a student who typed nothing
// because there was nothing for her to type. Found while fixing the same shape
// in low_typing_high_output; this heuristic never consulted Tier 3.1 either.

describe('time_to_first_save_anomaly — Tier 3.1 (a pull is not typing)', () => {
  const IMPLEMENTATION =
    Array.from(
      { length: 24 },
      (_, i) => `def helper_${i}(value):\n    return value * ${i} + 1`,
    ).join('\n') + '\n';

  function pullThenSave(after: EventSpec[] = []) {
    return [
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(IMPLEMENTATION) },
      {
        who: { studentRef: COLLAB_ALICE },
        events: collabPullerSession(IMPLEMENTATION, {
          merge: true,
          before: [collabDocOpen('# starter\n')],
          after: [...after, collabDocSave(IMPLEMENTATION)],
        }),
      },
    ] satisfies Parameters<typeof buildCollabScope>[0];
  }

  it('does not fire when the content in the window arrived by `git pull`', async () => {
    const { bundle, index } = await buildCollabScope(pullThenSave());
    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(
      flags,
      'time_to_first_save_anomaly fired on an honest pull: opening a file and pulling a ' +
        "partner's recorded work seconds later is not 1000 characters of typing. Do not " +
        'relax this assertion.',
    ).toHaveLength(0);
  });

  it('the same events WITHOUT a contributor verdict still fire — the zero above is the gate', async () => {
    const { bundle, index } = await buildCollabScope(pullThenSave(), { stamp: false });
    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]!.severity).toBe('high');
  });

  it('still fires when the student pastes 500+ chars in the same window', async () => {
    const pasted = 'q'.repeat(800);
    const { bundle, index } = await buildCollabScope(
      pullThenSave([
        {
          kind: 'paste',
          data: {
            path: COLLAB_FILE,
            content: pasted,
            length: pasted.length,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          },
        },
      ]),
    );
    const flags = timeToFirstSaveAnomalyHeuristic.run(index, bundle, cfg);
    expect(
      flags,
      'the discount covers only what git delivered. 800 pasted chars inside the window are ' +
        'still 800 chars this heuristic is meant to see.',
    ).toHaveLength(1);
    expect(flags[0]!.detail!['newChars']).toBe(pasted.length);
  });
});
