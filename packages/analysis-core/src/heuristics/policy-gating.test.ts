/**
 * The absence-vs-disabled audit (program spec §4).
 *
 * Every case here is the same pair: build a bundle whose events DO trip the
 * heuristic under a 1.x manifest, then build the byte-identical event stream
 * under a 2.0 manifest whose course switched the relevant capture signal off.
 * The first must flag; the second must return nothing.
 *
 * The stakes: a heuristic that reads "no terminal events" or "no doc.open" as
 * evidence will manufacture accusations against every student in a course that
 * turned that signal off, in a system whose output is used in academic-integrity
 * proceedings. The 1.x half of each pair is equally load-bearing — it is the
 * regression test that archived submissions keep behaving exactly as they did.
 */

import { describe, it, expect } from 'vitest';
import type { CapturePolicyBlock } from '@provenance/log-core';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import {
  buildTrustChainKeys,
  buildManifest2,
  sessionStart2,
} from '../test-support/build-manifest-2.js';
import { mergeConfig } from './config.js';
import { lowTypingHighOutputHeuristic } from './low-typing-high-output.js';
import { timeToFirstSaveAnomalyHeuristic } from './time-to-first-save-anomaly.js';
import { interSessionExternalChangeHeuristic } from './inter-session-external-change.js';
import { noIntermediateErrorsHeuristic } from './no-intermediate-errors.js';
import { shellIntegrationDisabledHeuristic } from './shell-integration-disabled.js';
import { terminalActiveDuringExternalChangeHeuristic } from './terminal-active-during-external-change.js';
import { gapInHeartbeatsHeuristic, effectiveGapThresholdMs } from './gap-in-heartbeats.js';
import { editingPatternCloneHeuristic } from './cross/editing-pattern-clone.js';
import { DEFAULT_CROSS_HEURISTIC_CONFIG } from './cross/types.js';
import type { CrossSubmissionFeatures } from './cross/types.js';

const config = mergeConfig();

type BuildOpts = NonNullable<Parameters<typeof buildTestBundle>[0]>;
type SessionSpec = NonNullable<BuildOpts['sessions']>[number];

/**
 * Build the same sessions twice: once as a 1.x bundle, once under a 2.0
 * manifest carrying `policy`.
 */
async function buildPair(sessions: SessionSpec[], policy: CapturePolicyBlock) {
  const legacy = await buildAndIndex(sessions);

  const keys = await buildTrustChainKeys();
  const manifest = await buildManifest2({ keys, policy });
  const start = sessionStart2(manifest);
  const gated = await buildAndIndex(
    sessions.map((s) => ({ ...s, sessionStart: { ...(s.sessionStart ?? {}), ...start } })),
  );

  return { legacy, gated };
}

async function buildAndIndex(sessions: SessionSpec[]) {
  const { zipBuffer } = await buildTestBundle({ sessions });
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

// ---------------------------------------------------------------------------
// doc_open_close
// ---------------------------------------------------------------------------

describe('doc_open_close disabled', () => {
  /**
   * The gated half of each pair keeps the doc.open events in the stream. That
   * is the point: the SIGNED policy is what decides, not what happens to be in
   * the log. A recorder that emits a gated event anyway - or a hand-edited
   * stream - must not be able to re-enable a heuristic the course turned off.
   */
  it('time_to_first_save_anomaly: not-applicable with doc.open off', async () => {
    const sessions: SessionSpec[] = [
      {
        events: [
          {
            kind: 'doc.open',
            data: { path: 'hw.py', sha256: 'a'.repeat(64), line_count: 1, content: '' },
            t: 0,
          },
          {
            kind: 'doc.change',
            data: {
              path: 'hw.py',
              source: 'typed',
              deltas: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  text: 'z'.repeat(900),
                },
              ],
            },
            t: 1_000,
          },
          { kind: 'doc.save', data: { path: 'hw.py', sha256: 'b'.repeat(64) }, t: 2_000 },
        ],
      },
    ];
    const { legacy, gated } = await buildPair(sessions, { capture: { doc_open_close: false } });

    expect(
      timeToFirstSaveAnomalyHeuristic.run(legacy.index, legacy.bundle, config).length,
    ).toBeGreaterThan(0);
    expect(timeToFirstSaveAnomalyHeuristic.run(gated.index, gated.bundle, config)).toEqual([]);
  });

  it('inter_session_external_change: not-applicable with doc.open off', async () => {
    const sessions: SessionSpec[] = [
      {
        events: [
          {
            kind: 'doc.open',
            data: { path: 'hw.py', sha256: 'a'.repeat(64), line_count: 1, content: 'start\n' },
          },
          {
            kind: 'doc.change',
            data: {
              path: 'hw.py',
              source: 'typed',
              deltas: [
                {
                  range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
                  text: 'typed by me\n',
                },
              ],
            },
          },
        ],
      },
      {
        events: [
          {
            kind: 'doc.open',
            data: {
              path: 'hw.py',
              sha256: 'c'.repeat(64),
              line_count: 40,
              content: 'someone elses solution\n'.repeat(40),
            },
          },
        ],
      },
    ];
    const { legacy, gated } = await buildPair(sessions, { capture: { doc_open_close: false } });

    expect(
      interSessionExternalChangeHeuristic.run(legacy.index, legacy.bundle, config).length,
    ).toBeGreaterThan(0);
    expect(interSessionExternalChangeHeuristic.run(gated.index, gated.bundle, config)).toEqual([]);
  });

  /**
   * low_typing_high_output reads doc.open and is deliberately NOT gated - see
   * the audit note in its module docstring. `doc.open.content` is both the
   * startLength anchor and the reconstruction seed, so its absence cancels out
   * of `finalLength - startLength` instead of inflating it. This pins that
   * reasoning: strip every doc.open and the verdict does not move.
   */
  it('low_typing_high_output: dropping doc.open does not inflate the ratio', async () => {
    const skeleton = 'x'.repeat(600);
    const typed = {
      kind: 'doc.change',
      data: {
        path: 'hw.py',
        source: 'typed',
        deltas: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            text: 'y'.repeat(10),
          },
        ],
      },
    };
    const withOpen = await buildAndIndex([
      {
        events: [
          {
            kind: 'doc.open',
            data: { path: 'hw.py', sha256: 'a'.repeat(64), line_count: 1, content: skeleton },
          },
          typed,
          { kind: 'doc.save', data: { path: 'hw.py', sha256: 'b'.repeat(64) } },
        ],
      },
    ]);
    const withoutOpen = await buildAndIndex([
      {
        events: [typed, { kind: 'doc.save', data: { path: 'hw.py', sha256: 'b'.repeat(64) } }],
      },
    ]);

    expect(lowTypingHighOutputHeuristic.run(withOpen.index, withOpen.bundle, config)).toEqual([]);
    expect(lowTypingHighOutputHeuristic.run(withoutOpen.index, withoutOpen.bundle, config)).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// terminal
// ---------------------------------------------------------------------------

describe('terminal disabled', () => {
  const terminalSessions: SessionSpec[] = [
    {
      events: [
        {
          kind: 'terminal.open',
          data: { terminal_id: 't1', shell: '/bin/zsh', shell_integration: false },
          t: 0,
        },
        {
          kind: 'doc.change',
          data: {
            path: 'hw.py',
            source: 'typed',
            deltas: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                text: 'print(1)\n',
              },
            ],
          },
          t: 1_000,
        },
        {
          kind: 'fs.external_change',
          data: {
            path: 'hw.py',
            old_hash: 'a'.repeat(64),
            new_hash: 'b'.repeat(64),
            diff_size: 200,
          },
          t: 2_000,
        },
      ],
    },
  ];

  it('shell_integration_disabled: not-applicable with terminal off', async () => {
    const { legacy, gated } = await buildPair(terminalSessions, { capture: { terminal: false } });
    expect(
      shellIntegrationDisabledHeuristic.run(legacy.index, legacy.bundle, config).length,
    ).toBeGreaterThan(0);
    expect(shellIntegrationDisabledHeuristic.run(gated.index, gated.bundle, config)).toEqual([]);
  });

  it('no_intermediate_errors: not-applicable with terminal off', async () => {
    const { legacy, gated } = await buildPair(terminalSessions, { capture: { terminal: false } });
    // 1.x emits the "shell integration disabled, cannot check" info flag.
    expect(
      noIntermediateErrorsHeuristic.run(legacy.index, legacy.bundle, config).length,
    ).toBeGreaterThan(0);
    expect(noIntermediateErrorsHeuristic.run(gated.index, gated.bundle, config)).toEqual([]);
  });

  it('terminal_active_during_external_change: not-applicable with terminal off', async () => {
    const { legacy, gated } = await buildPair(terminalSessions, { capture: { terminal: false } });
    expect(
      terminalActiveDuringExternalChangeHeuristic.run(legacy.index, legacy.bundle, config).length,
    ).toBeGreaterThan(0);
    expect(
      terminalActiveDuringExternalChangeHeuristic.run(gated.index, gated.bundle, config),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// heartbeat_interval_ms
// ---------------------------------------------------------------------------

describe('gap_in_heartbeats derives its threshold from the recorded cadence', () => {
  it('is unchanged at the 1.x/default 30s cadence', () => {
    expect(effectiveGapThresholdMs(300_000, 30_000)).toBe(300_000);
  });

  it('scales up when the course lengthened the cadence', () => {
    expect(effectiveGapThresholdMs(300_000, 120_000)).toBe(1_200_000);
  });

  it('does not scale DOWN when the course shortened the cadence', () => {
    expect(effectiveGapThresholdMs(300_000, 5_000)).toBe(300_000);
  });

  /**
   * A 6-minute gap with an intervening event. At the 30s cadence that is 12
   * missed beats and genuinely odd; at the 120s cadence it is three, i.e. well
   * inside ordinary jitter, and flagging it would punish the course for its
   * capture settings.
   */
  const gapSessions: SessionSpec[] = [
    {
      events: [
        { kind: 'session.heartbeat', data: { focused: true, active_file: null, idle_since_ms: 0 } },
        {
          kind: 'doc.change',
          data: {
            path: 'hw.py',
            source: 'typed',
            deltas: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                text: 'a',
              },
            ],
          },
          wall: '2026-01-01T00:03:00.000Z',
          t: 180_000,
        },
        {
          kind: 'session.heartbeat',
          data: { focused: true, active_file: null, idle_since_ms: 0 },
          wall: '2026-01-01T00:06:00.000Z',
          t: 360_000,
        },
      ],
    },
  ];

  it('flags the gap at the default cadence and not at a 120s cadence', async () => {
    const { legacy, gated } = await buildPair(gapSessions, {
      capture: { heartbeat_interval_ms: 120_000 },
    });

    const legacyFlags = gapInHeartbeatsHeuristic.run(legacy.index, legacy.bundle, config);
    expect(legacyFlags).toHaveLength(1);
    expect(legacyFlags[0]!.detail?.['thresholdMs']).toBe(300_000);

    expect(gapInHeartbeatsHeuristic.run(gated.index, gated.bundle, config)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// editing_pattern_clone (cross)
// ---------------------------------------------------------------------------

describe('editing_pattern_clone', () => {
  function features(
    bundleId: string,
    ngrams: string[],
    disabled?: readonly string[],
  ): CrossSubmissionFeatures {
    return {
      bundleId,
      sourceFilename: `${bundleId}.zip`,
      pastes: [],
      kindNgrams: new Set(ngrams),
      eventCount: 100,
      representativeSeqKeys: [`${bundleId}:0`],
      ...(disabled === undefined ? {} : { disabledCaptureSignals: disabled }),
    };
  }

  const shared = ['a|b|c', 'b|c|d', 'c|d|e'];

  it('flags identical fingerprints when no capture signal was disabled', () => {
    const flags = editingPatternCloneHeuristic.run(
      [features('A', shared), features('B', shared)],
      DEFAULT_CROSS_HEURISTIC_CONFIG,
    );
    expect(flags).toHaveLength(1);
  });

  it('treats an empty disabled list exactly like a 1.x submission', () => {
    const flags = editingPatternCloneHeuristic.run(
      [features('A', shared, []), features('B', shared, [])],
      DEFAULT_CROSS_HEURISTIC_CONFIG,
    );
    expect(flags).toHaveLength(1);
  });

  it('is not-applicable when either side had a kind-stream signal disabled', () => {
    const flags = editingPatternCloneHeuristic.run(
      [features('A', shared, ['terminal']), features('B', shared)],
      DEFAULT_CROSS_HEURISTIC_CONFIG,
    );
    expect(flags).toEqual([]);
  });

  it('still runs when only inline_content was disabled — the kind stream is intact', () => {
    const flags = editingPatternCloneHeuristic.run(
      [features('A', shared, ['inline_content']), features('B', shared, ['inline_content'])],
      DEFAULT_CROSS_HEURISTIC_CONFIG,
    );
    expect(flags).toHaveLength(1);
  });
});
