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
import { classifyInternalMoves } from './internal-move.js';
import { iterateCandidatePastes } from './candidate-pastes.js';
import { resolveBundleCapturePolicy } from '../manifest/bundle-manifest.js';
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
// doc.open / doc.close are FLOOR — there is no knob to disable them
// ---------------------------------------------------------------------------

describe('doc.open is on the floor', () => {
  /**
   * `doc_open_close` was briefly a `policy.capture` key and was removed:
   * `DocOpenPayload.content` is the reconstruction seed, so disabling it would
   * break reconstruction, replay, and the Source tab for a whole cohort. The
   * floor is drawn by what reconstruction and validation DEPEND on, not by
   * privacy sensitivity.
   *
   * These two heuristics used to return not-applicable under that knob. The
   * gates are gone, so the property to pin is the opposite one: a course that
   * turns every knob it still has off - and even one that writes the retired
   * key, which resolves as an unknown key - cannot switch these heuristics off.
   */
  const ALL_KNOBS_OFF: CapturePolicyBlock = {
    capture: {
      selection_change: false,
      focus_change: false,
      terminal: false,
      // Retired keys, deliberately present: an unknown key must be ignored, not
      // resurrect the gate. `doc_open_close` was removed because doc.open is the
      // reconstruction seed; `inline_content` because internal_move needs paste
      // content to DOWNGRADE large_paste, so stripping it made the system more
      // likely to falsely accuse a student relocating their own code.
      doc_open_close: false,
      inline_content: false,
    } as NonNullable<CapturePolicyBlock['capture']>,
  };

  it('time_to_first_save_anomaly: still flags under a policy with every knob off', async () => {
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
    const { legacy, gated } = await buildPair(sessions, ALL_KNOBS_OFF);

    const legacyFlags = timeToFirstSaveAnomalyHeuristic.run(legacy.index, legacy.bundle, config);
    expect(legacyFlags.length).toBeGreaterThan(0);
    // Byte-identical verdict: no policy input reaches this heuristic any more.
    expect(timeToFirstSaveAnomalyHeuristic.run(gated.index, gated.bundle, config)).toHaveLength(
      legacyFlags.length,
    );
  });

  it('inter_session_external_change: still flags under a policy with every knob off', async () => {
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
    const { legacy, gated } = await buildPair(sessions, ALL_KNOBS_OFF);

    const legacyFlags = interSessionExternalChangeHeuristic.run(
      legacy.index,
      legacy.bundle,
      config,
    );
    expect(legacyFlags.length).toBeGreaterThan(0);
    expect(interSessionExternalChangeHeuristic.run(gated.index, gated.bundle, config)).toHaveLength(
      legacyFlags.length,
    );
  });

  /**
   * low_typing_high_output reads doc.open and was never gated - see the audit
   * note in its module docstring. `doc.open.content` is both the startLength
   * anchor and the reconstruction seed, so its absence cancels out of
   * `finalLength - startLength` instead of inflating it. This pins that
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
// Paste content is on the floor — there is no inline_content knob
// ---------------------------------------------------------------------------

describe('paste content is on the floor', () => {
  /**
   * `inline_content` was briefly a `policy.capture` key and was removed.
   *
   * It is the mirror image of the usual gating case, and that is exactly why it
   * had to go. Every other knob makes the system see LESS evidence against a
   * student; this one made it see less evidence FOR one. `internal_move` reads
   * the paste's inline content to match it against the student's own prior typed
   * code, and a match DOWNGRADES `large_paste` — it is how the system recognises
   * a student cutting their own helper out of one file and pasting it into
   * another, which is entirely legitimate. Strip the content and the exculpatory
   * check cannot run, so `internal_move` falls back to `unknown`, which callers
   * treat as a full-severity external paste.
   *
   * A course must not be able to configure the system into falsely accusing its
   * own students, so this is not a knob. The key resolves as an unknown key.
   */
  const RETIRED_INLINE_CONTENT: CapturePolicyBlock = {
    capture: { inline_content: false } as NonNullable<CapturePolicyBlock['capture']>,
  };

  /** A 5-line, >40-char block: the thing being relocated. */
  const BLOCK = [
    'def helper(values):',
    '    total = 0',
    '    for v in values:',
    '        total += v',
    '    return total',
    '',
  ].join('\n');

  /** Type BLOCK into utils.py, then paste it into hw.py — a textbook internal move. */
  const moveSessions: SessionSpec[] = [
    {
      events: [
        { kind: 'doc.open', data: { path: '/t/utils.py', content: '' } },
        {
          kind: 'doc.change',
          data: {
            path: '/t/utils.py',
            source: 'typed',
            deltas: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                text: BLOCK,
              },
            ],
          },
        },
        { kind: 'doc.open', data: { path: '/t/hw.py', content: '' } },
        {
          kind: 'paste',
          data: {
            path: '/t/hw.py',
            content: BLOCK,
            length: BLOCK.length,
            sha256: 'inline',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          },
        },
      ],
    },
  ];

  it('internal_move still exculpates under a policy carrying the retired key', async () => {
    const { legacy, gated } = await buildPair(moveSessions, RETIRED_INLINE_CONTENT);

    for (const [label, built] of [
      ['1.x', legacy],
      ['2.0 + retired key', gated],
    ] as const) {
      const results = classifyInternalMoves(built.index, config);
      const [candidate] = [...iterateCandidatePastes(built.index)];
      expect(candidate, label).toBeDefined();
      const verdict = results.get(candidate!.ordinal);
      expect(verdict?.classification, label).toBe('internal_move');
      expect(verdict?.sourcePath, label).toBe('/t/utils.py');
    }
  });

  it('reports no disabled signal for the retired key', async () => {
    const { gated } = await buildPair(moveSessions, RETIRED_INLINE_CONTENT);
    // An unknown key is ignored, so nothing is reported as switched off — the
    // analyzer must not tell staff a signal was disabled when it was not.
    expect(resolveBundleCapturePolicy(gated.bundle).disabledSignals).toEqual([]);
    expect(resolveBundleCapturePolicy(gated.bundle).source).toBe('manifest_2_0');
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

  it('ignores a retired signal name that no longer exists in the policy', () => {
    // `inline_content` was removed from CapturePolicy, so resolveBundleCapturePolicy
    // can never report it. If one reaches this heuristic anyway — a hand-edited
    // feature blob, a stale caller — it must not distort the kind-stream verdict,
    // because it never removed a kind from the stream in the first place.
    const flags = editingPatternCloneHeuristic.run(
      [features('A', shared, ['inline_content']), features('B', shared, ['inline_content'])],
      DEFAULT_CROSS_HEURISTIC_CONFIG,
    );
    expect(flags).toHaveLength(1);
  });
});
