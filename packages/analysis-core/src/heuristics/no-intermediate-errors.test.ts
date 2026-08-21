/**
 * Tests for the no_intermediate_errors heuristic (Phase 16).
 */

import { describe, it, expect } from 'vitest';
import { noIntermediateErrorsHeuristic } from './no-intermediate-errors.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import type { Flag } from './types.js';

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

const openTerm = (shell_integration = true) => ({
  kind: 'terminal.open' as const,
  data: { terminal_id: 'term-1', shell: '/bin/bash', shell_integration },
});
/** A terminal.command; omit `exit_code` to model a command that never reported one. */
const cmd = (exit_code?: number) => ({
  kind: 'terminal.command' as const,
  data: {
    terminal_id: 'term-1',
    command: 'python3 test.py',
    ...(exit_code === undefined ? {} : { exit_code }),
  },
});
const saveFile = {
  kind: 'doc.save' as const,
  data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64) },
};
/** Enough clean reported exits to clear minCommandsWithExitCode. */
const cleanRuns = (n = cfg.noIntermediateErrors.minCommandsWithExitCode) =>
  Array.from({ length: n }, () => cmd(0));

function positives(flags: Flag[]): Flag[] {
  return flags.filter((f) => f.heuristic === 'no_intermediate_errors' && f.severity === 'medium');
}

// ---------------------------------------------------------------------------
// Degraded: shell_integration: false → skipped info flag
// ---------------------------------------------------------------------------

describe('no_intermediate_errors — shell integration disabled', () => {
  it('emits an info skipped flag when terminal.open has shell_integration: false', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: {
                terminal_id: 'term-1',
                shell: '/bin/bash',
                shell_integration: false, // disabled
              },
            },
            {
              kind: 'terminal.command',
              data: { terminal_id: 'term-1', command: 'python3 hw1.py', exit_code: 0 },
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    expect(flags.length).toBeGreaterThanOrEqual(1);

    const flag = flags[0]!;
    expect(flag.heuristic).toBe('no_intermediate_errors');
    expect(flag.severity).toBe('info');
    expect(flag.detail!['reason']).toBe('shell_integration_disabled');
  });

  it('does not emit a skipped flag when shell_integration: true', async () => {
    // shell_integration: true AND all exits 0 → medium flag (not skipped)
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: {
                terminal_id: 'term-1',
                shell: '/bin/bash',
                shell_integration: true,
              },
            },
            {
              kind: 'terminal.command',
              data: { terminal_id: 'term-1', command: 'python3 hw1.py', exit_code: 0 },
            },
            {
              kind: 'doc.save',
              data: { path: '/hw/hw1.py', sha256: 'a'.repeat(64) },
            },
          ],
        },
      ],
    });

    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    const infoFlags = flags.filter(
      (f) => f.severity === 'info' && f.detail!['reason'] === 'shell_integration_disabled',
    );
    expect(infoFlags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive: all commands exit 0 (no intermediate errors)
// ---------------------------------------------------------------------------

describe('no_intermediate_errors — positive (all exits succeed)', () => {
  it('flags a submission where every reported exit code is 0', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [{ events: [openTerm(), ...cleanRuns(6), saveFile] }],
    });

    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    const mediumFlags = positives(flags);
    expect(mediumFlags).toHaveLength(1);
    expect(mediumFlags[0]!.confidence).toBe(0.65);
    expect(mediumFlags[0]!.detail!['commandsWithExitCode']).toBe(6);
    expect(mediumFlags[0]!.supportingSeqs).toHaveLength(6);
  });

  it('emits ONE flag for the submission, not one per session', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: [openTerm(), ...cleanRuns(3), saveFile] },
        { events: [openTerm(), ...cleanRuns(3), saveFile] },
      ],
    });
    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    expect(positives(flags)).toHaveLength(1);
    // ...and the floor is met by the two sessions together.
    expect(positives(flags)[0]!.detail!['commandsWithExitCode']).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Preconditions. Each "does not fire" case is paired with the same fixture
// made to fire, so the heuristic is narrowed rather than switched off.
// ---------------------------------------------------------------------------

describe('no_intermediate_errors — preconditions', () => {
  it('does not flag a later clean session when an earlier one had failures', async () => {
    // The single most ordinary honest workflow: fight failing tests in one
    // sitting, come back and do a clean run in the next. Evaluated per session
    // this raised `medium` "No terminal errors detected" against a log with
    // three failures in it.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: [openTerm(), cmd(1), cmd(1), cmd(2), cmd(0), saveFile] },
        { events: [openTerm(), ...cleanRuns(6), saveFile] },
      ],
    });
    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    expect(positives(flags)).toHaveLength(0);
  });

  it('still flags when the same two sessions are both clean', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: [openTerm(), ...cleanRuns(4), saveFile] },
        { events: [openTerm(), ...cleanRuns(6), saveFile] },
      ],
    });
    expect(positives(noIntermediateErrorsHeuristic.run(index, bundle, cfg))).toHaveLength(1);
  });

  it('does not flag when no command reported an exit code', async () => {
    // Absence of capture is not evidence of success. This used to fire,
    // describing six commands as having "exited with code 0".
    const { index, bundle } = await buildAndIndex({
      sessions: [{ events: [openTerm(), cmd(), cmd(), cmd(), cmd(), cmd(), cmd(), saveFile] }],
    });
    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    expect(positives(flags)).toHaveLength(0);
  });

  it('counts only reported exit codes toward the floor, and says how many it ignored', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [{ events: [openTerm(), ...cleanRuns(5), cmd(), cmd(), saveFile] }],
    });
    const flags = positives(noIntermediateErrorsHeuristic.run(index, bundle, cfg));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['commandsWithExitCode']).toBe(5);
    expect(flags[0]!.detail!['commandsWithoutExitCode']).toBe(2);
    expect(flags[0]!.description).toContain('2 reported no exit code');
  });

  it('does not flag one trivial command and one keystroke', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            openTerm(),
            {
              kind: 'terminal.command',
              data: { terminal_id: 'term-1', command: 'ls', exit_code: 0 },
            },
            {
              kind: 'doc.change',
              data: {
                path: '/hw/hw1.py',
                source: 'typed',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'x',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(positives(noIntermediateErrorsHeuristic.run(index, bundle, cfg))).toHaveLength(0);
  });

  it('pins the floor from both sides', async () => {
    const floor = cfg.noIntermediateErrors.minCommandsWithExitCode;
    const below = await buildAndIndex({
      sessions: [{ events: [openTerm(), ...cleanRuns(floor - 1), saveFile] }],
    });
    expect(
      positives(noIntermediateErrorsHeuristic.run(below.index, below.bundle, cfg)),
    ).toHaveLength(0);

    const at = await buildAndIndex({
      sessions: [{ events: [openTerm(), ...cleanRuns(floor), saveFile] }],
    });
    expect(positives(noIntermediateErrorsHeuristic.run(at.index, at.bundle, cfg))).toHaveLength(1);
  });

  it('does not flag a clean run with no file activity', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [{ events: [openTerm(), ...cleanRuns(6)] }],
    });
    expect(positives(noIntermediateErrorsHeuristic.run(index, bundle, cfg))).toHaveLength(0);
  });

  it('suppresses the submission flag when any session had shell integration off', async () => {
    // Errors in that session would have been invisible, so "no errors were
    // seen" across the submission is unsupportable. The info flag still stands.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: [openTerm(false), cmd(0), saveFile] },
        { events: [openTerm(), ...cleanRuns(6), saveFile] },
      ],
    });
    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    expect(positives(flags)).toHaveLength(0);
    expect(flags.filter((f) => f.detail!['reason'] === 'shell_integration_disabled')).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Negative: at least one command exits non-zero → no flag
// ---------------------------------------------------------------------------

describe('no_intermediate_errors — negative (has errors)', () => {
  it('does not flag a session where at least one command exits non-zero', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [{ events: [openTerm(), cmd(1), ...cleanRuns(6), saveFile] }],
    });

    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    expect(positives(flags)).toHaveLength(0);
  });

  it('does not flag a session with no terminal activity', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = noIntermediateErrorsHeuristic.run(index, bundle, cfg);
    const anyNoErrorFlags = flags.filter((f) => f.heuristic === 'no_intermediate_errors');
    expect(anyNoErrorFlags).toHaveLength(0);
  });
});
