/**
 * Tests for the idle_then_complete heuristic (Phase 16).
 */

import { describe, it, expect } from 'vitest';
import { idleThenCompleteHeuristic } from './idle-then-complete.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import {
  buildCollabScope,
  collabDocOpen,
  collabDocSave,
  collabExternalChange,
  collabGitEvent,
  collabPartnerSession,
  COLLAB_ALICE,
  COLLAB_BOB,
  COLLAB_C0,
  COLLAB_C1,
  COLLAB_C2,
  COLLAB_FILE,
} from '../test-support/build-collab-scope.js';

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
// idleGapMs default = 600000 (10min)

// ---------------------------------------------------------------------------
// Positive: idle gap > 10min followed by save bringing file from skeleton to final
// ---------------------------------------------------------------------------

describe('idle_then_complete — positive', () => {
  it('flags a save that completes a skeleton file after a 10min+ idle gap', async () => {
    // Build:
    //   t=0: session.heartbeat
    //   t=1000: doc.open, paste 50 chars (skeleton = <50% of final 500 chars)
    //   t=2000: doc.save (50 chars — small)
    //   t=3000: session.heartbeat
    //   t=615000: session.heartbeat (gap = 612000ms > 600000 = idle)
    //   t=620000: paste 500 chars total (full solution)
    //   t=621000: doc.save (final save = sha256 of final content)
    //
    // After the idle gap, the save brings file from 50→500 chars, and this
    // save's sha256 matches the final save hash → flag.

    const skeletonContent = 'x'.repeat(50);
    const finalContent = 'y'.repeat(500);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              t: 0,
            },
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 1000,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: skeletonContent,
                length: skeletonContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 1500,
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) }, t: 2000 },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: '/hw/hw1.py', idle_since_ms: 0 },
              t: 3000,
            },
            // Large idle gap: next heartbeat at t=615000 (gap = 612000ms > 600000ms)
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: '/hw/hw1.py', idle_since_ms: 612000 },
              t: 615000,
            },
            // Post-idle: paste the full solution content (replaces skeleton)
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: finalContent,
                length: finalContent.length,
                sha256: 'd'.repeat(64),
                // Replace entire skeleton range
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: skeletonContent.length },
                },
              },
              t: 616000,
            },
            // Final save (this is the last save → finalSaveHash for this file)
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'e'.repeat(64) }, t: 617000 },
          ],
        },
      ],
    });

    const flags = idleThenCompleteHeuristic.run(index, bundle, cfg);
    expect(flags.length).toBeGreaterThanOrEqual(1);

    const flag = flags[0]!;
    expect(flag.heuristic).toBe('idle_then_complete');
    expect(flag.severity).toBe('high');
    expect(flag.confidence).toBe(0.8);
    expect(flag.detail!['finalLength']).toBe(finalContent.length);
  });
});

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

describe('idle_then_complete — negative', () => {
  it('does not flag when the idle gap is shorter than 10 minutes', async () => {
    // Gap = 5 minutes (300000ms) < 600000ms → no idle detection
    const skeletonContent = 'x'.repeat(50);
    const finalContent = 'y'.repeat(500);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              t: 0,
            },
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 1000,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: skeletonContent,
                length: skeletonContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 1500,
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) }, t: 2000 },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: '/hw/hw1.py', idle_since_ms: 0 },
              t: 3000,
            },
            // Short gap: 300s = 5 minutes (below 600000ms threshold)
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: '/hw/hw1.py', idle_since_ms: 300000 },
              t: 303000,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: finalContent,
                length: finalContent.length,
                sha256: 'd'.repeat(64),
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: skeletonContent.length },
                },
              },
              t: 304000,
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'e'.repeat(64) }, t: 305000 },
          ],
        },
      ],
    });

    const flags = idleThenCompleteHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'idle_then_complete')).toHaveLength(0);
  });

  it('does not flag when the pre-save content is already ≥50% of final size (not a skeleton)', async () => {
    // pre = 300 chars, final = 500 chars → 300/500 = 60% ≥ sizeRatio=50% → not skeleton
    const preContent = 'x'.repeat(300);
    // finalContent is implicitly built by the paste events below (300 + 200 chars)
    const extraContent = 'y'.repeat(200);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              t: 0,
            },
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 1000,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: preContent,
                length: preContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 1500,
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) }, t: 2000 },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: '/hw/hw1.py', idle_since_ms: 0 },
              t: 3000,
            },
            // Idle gap > 10min
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: '/hw/hw1.py', idle_since_ms: 612000 },
              t: 615000,
            },
            // Add more content (not replacing, extending)
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: extraContent,
                length: extraContent.length,
                sha256: 'd'.repeat(64),
                range: {
                  start: { line: 0, character: preContent.length },
                  end: { line: 0, character: preContent.length },
                },
              },
              t: 616000,
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'e'.repeat(64) }, t: 617000 },
          ],
        },
      ],
    });

    const flags = idleThenCompleteHeuristic.run(index, bundle, cfg);
    // pre = 300 ≥ 50% of 500 → not a skeleton → no flag
    expect(flags.filter((f) => f.heuristic === 'idle_then_complete')).toHaveLength(0);
  });

  it('does not flag when there are no heartbeat events (cannot detect idle gaps)', async () => {
    const skeletonContent = 'x'.repeat(50);
    const finalContent = 'y'.repeat(500);

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
                content: skeletonContent,
                length: skeletonContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 1000,
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) }, t: 2000 },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: finalContent,
                length: finalContent.length,
                sha256: 'd'.repeat(64),
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: skeletonContent.length },
                },
              },
              t: 620000,
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'e'.repeat(64) }, t: 621000 },
            // No heartbeat events → cannot detect idle gap
          ],
        },
      ],
    });

    const flags = idleThenCompleteHeuristic.run(index, bundle, cfg);
    expect(flags.filter((f) => f.heuristic === 'idle_then_complete')).toHaveLength(0);
  });

  it('produces no flags for a session with no doc.save events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = idleThenCompleteHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('respects custom postIdleWindowMs configuration', async () => {
    // Build: idle gap followed by a save at t=gapEndT + 90s.
    // With default postIdleWindowMs=60s: save at +90s is outside window → no flag.
    // With custom postIdleWindowMs=120s: same save is inside window → flag fires.

    const skeletonContent = 'x'.repeat(50);
    const finalContent = 'y'.repeat(500);

    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              t: 0,
            },
            {
              kind: 'doc.open',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64), line_count: 0 },
              t: 1000,
            },
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: skeletonContent,
                length: skeletonContent.length,
                sha256: 'b'.repeat(64),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
              t: 1500,
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'c'.repeat(64) }, t: 2000 },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: '/hw/hw1.py', idle_since_ms: 0 },
              t: 3000,
            },
            // Idle gap > 10min
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: '/hw/hw1.py', idle_since_ms: 612000 },
              t: 615000,
            },
            // Save at t=615000 + 90000 = 705000ms (90s after gap end)
            {
              kind: 'paste',
              data: {
                path: '/hw/hw1.py',
                content: finalContent,
                length: finalContent.length,
                sha256: 'd'.repeat(64),
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: skeletonContent.length },
                },
              },
              t: 704000,
            },
            { kind: 'doc.save', data: { path: '/hw/hw1.py', sha256: 'e'.repeat(64) }, t: 705000 },
          ],
        },
      ],
    });

    // With default config (postIdleWindowMs=60000): save at 705000 is 90000ms after
    // gapEndT=615000 → outside 60s window → no flag
    const flagsDefault = idleThenCompleteHeuristic.run(index, bundle, cfg);
    expect(flagsDefault.filter((f) => f.heuristic === 'idle_then_complete')).toHaveLength(0);

    // With custom config (postIdleWindowMs=120000): save at 705000 is 90000ms after
    // gapEndT → inside 120s window → flag fires
    const customConfig = {
      ...cfg,
      idleThenComplete: {
        ...cfg.idleThenComplete,
        postIdleWindowMs: 120_000, // 120 seconds
      },
    };
    const flagsCustom = idleThenCompleteHeuristic.run(index, bundle, customConfig);
    expect(flagsCustom.filter((f) => f.heuristic === 'idle_then_complete')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tier 3.1 — a file completed by a `git pull` was not completed by the student
// ---------------------------------------------------------------------------
//
// Alice opens the starter, pulls Bob's work onto a descendant commit, goes to
// lunch, and the pulled content reaches the editor through the save-time
// compare when she comes back. Skeleton before the gap, complete file after —
// the exact shape this heuristic looks for, at HIGH severity, for going to
// lunch. Found while fixing the same shape in low_typing_high_output; this
// heuristic never consulted Tier 3.1 either.
//
// Two things about the fixture are load-bearing:
//
//  - **Alice's session sorts first.** That is what leaves the pre-gap cut
//    reconstructible (Bob's events are past it), and it is the ordinary case
//    when the puller started work first — so the accusation is reachable, not
//    hypothetical. With Bob first, the pre-gap cut is `concurrent` and Tier 2.2
//    skips the file for an unrelated reason.
//  - **Alice edits a second file in the same session**, whose post-idle content
//    matches nothing any contributor recorded. It fires, in the same run, on the
//    same student. That is the control: it shows the zero on `hw1.py` is the
//    content test doing its job and not the heuristic having gone quiet.
//    (The usual `stamp: false` control does not work here — unstamped, the
//    reconstruction falls back to globalIdx order, Bob's empty `doc.open` lands
//    last and zeroes the file, so the heuristic skips for a third unrelated
//    reason.)

describe('idle_then_complete — Tier 3.1 (a pull is not a completion)', () => {
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

  const OTHER_FILE = 'notes.py';

  function heartbeat(t: number) {
    return {
      kind: 'session.heartbeat' as const,
      data: { focused: true, active_file: COLLAB_FILE, idle_since_ms: 0 },
      t,
    };
  }

  async function lunchThenPull() {
    return buildCollabScope([
      {
        who: { studentRef: COLLAB_ALICE },
        events: [
          { ...collabGitEvent(COLLAB_C0), t: 500 },
          { ...collabDocOpen('# starter\n'), t: 1_000 },
          { ...collabDocOpen('# notes\n', OTHER_FILE), t: 1_200 },
          { ...collabGitEvent(COLLAB_C1, [COLLAB_C0]), t: 2_000 },
          { ...collabGitEvent(COLLAB_C2, [COLLAB_C1]), t: 2_500 },
          heartbeat(3_000),
          heartbeat(700_000),
          collabExternalChange(IMPLEMENTATION, { t: 701_000 }),
          { ...collabDocSave(IMPLEMENTATION), t: 702_000 },
          collabExternalChange(ELSEWHERE, { path: OTHER_FILE, t: 701_200 }),
          { ...collabDocSave(ELSEWHERE, OTHER_FILE), t: 702_200 },
        ],
      },
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(IMPLEMENTATION) },
    ]);
  }

  it('does not fire when the post-idle content is a partner’s recorded work', async () => {
    const { bundle, index } = await lunchThenPull();
    const flags = idleThenCompleteHeuristic.run(index, bundle, cfg);
    expect(
      flags.filter((f) => f.detail!['filePath'] === COLLAB_FILE),
      'idle_then_complete fired on an honest pull: the file was completed by Bob, whose ' +
        'recorder recorded these exact bytes, not by Alice going to lunch. Do not relax ' +
        'this assertion.',
    ).toHaveLength(0);
  });

  it('still fires, in the same run, on content no verified contributor recorded', async () => {
    const { bundle, index } = await lunchThenPull();
    const flags = idleThenCompleteHeuristic.run(index, bundle, cfg);
    const other = flags.filter((f) => f.detail!['filePath'] === OTHER_FILE);
    expect(
      other,
      'a file that filled itself over an idle gap with content no verified contributor ever ' +
        'recorded is exactly what this heuristic exists to surface. A fix that silences the ' +
        'heuristic is worse than the false positive it was fixing.',
    ).toHaveLength(1);
    expect(other[0]!.severity).toBe('high');
    expect(other[0]!.detail!['mergedInChars']).toBe(0);
  });
});
