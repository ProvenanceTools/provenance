/**
 * Tests for the terminal_active_during_external_change heuristic (Phase 17).
 */

import { describe, it, expect } from 'vitest';
import { terminalActiveDuringExternalChangeHeuristic } from './terminal-active-during-external-change.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle, type EventSpec } from '../test-support/build-test-bundle.js';
import { mergeConfig } from './config.js';
import { externalChangeClassificationFor } from '../index/classify-external-changes.js';
import {
  buildCollabScope,
  collabPartnerSession,
  collabPullerSession,
  COLLAB_ALICE,
  COLLAB_BOB,
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

const defaultConfig = mergeConfig();

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

describe('terminal_active_during_external_change — negative', () => {
  it('produces no flags when no fs.external_change events', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/zsh', shell_integration: true },
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when fs.external_change occurs but no terminal is open', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                old_hash: 'a'.repeat(64),
                new_hash: 'b'.repeat(64),
                diff_size: 100,
              },
              t: 1000,
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when terminal opens AFTER the external change', async () => {
    // terminal.open at t=2000, external change at t=1000 → terminal not yet open
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                old_hash: 'a'.repeat(64),
                new_hash: 'b'.repeat(64),
                diff_size: 100,
              },
              t: 1000,
            },
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/zsh', shell_integration: true },
              t: 2000,
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('terminal_active_during_external_change — positive', () => {
  it('flags when terminal is open before fs.external_change', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/zsh', shell_integration: true },
              t: 500,
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/hw.py',
                old_hash: 'a'.repeat(64),
                new_hash: 'b'.repeat(64),
                diff_size: 200,
              },
              t: 1500,
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('terminal_active_during_external_change');
    expect(flags[0]!.severity).toBe('info');
    expect(flags[0]!.confidence).toBe(0.6);
    expect(flags[0]!.detail!['filePath']).toBe('/test/hw.py');
    expect(flags[0]!.detail!['diffSize']).toBe(200);
  });

  it('flags at exact same t (terminal open t === change t)', async () => {
    // Same t: terminal opens at t=1000, change at t=1000 → open.t <= change.t → flag
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/bash', shell_integration: true },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                old_hash: 'a'.repeat(64),
                new_hash: 'b'.repeat(64),
                diff_size: 50,
              },
              t: 1000,
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
  });

  it('emits one flag per external change event (not per terminal)', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-1', shell: '/bin/zsh', shell_integration: true },
              t: 100,
            },
            {
              kind: 'terminal.open',
              data: { terminal_id: 'term-2', shell: '/bin/bash', shell_integration: true },
              t: 200,
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                old_hash: 'a'.repeat(64),
                new_hash: 'b'.repeat(64),
                diff_size: 50,
              },
              t: 1000,
            },
          ],
        },
      ],
    });
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    // Two terminals open, one external change → one flag (per change, not per terminal)
    expect(flags).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tier 3.1 — content-based reclassification
// ---------------------------------------------------------------------------

describe('terminal_active_during_external_change — Tier 3.1 reclassification', () => {
  const PARTNER_WORK = 'def solve(n):\n    return n * 2\n';
  const NOBODY_RECORDED = 'def solve(n):\n    return magic(n)\n';

  /** The student ran `git pull` in the integrated terminal — the census case. */
  const terminalOpen: EventSpec = {
    kind: 'terminal.open',
    data: { terminal_id: 't1', shell: 'zsh', shell_integration: true },
  };

  function pullFromTerminal(content: string): EventSpec[] {
    return collabPullerSession(content, { before: [terminalOpen] });
  }

  it("raises NO flag when the pull delivered the partner's recorded work", async () => {
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(PARTNER_WORK) },
      { who: { studentRef: COLLAB_ALICE }, events: pullFromTerminal(PARTNER_WORK) },
    ]);
    expect(
      terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig),
    ).toHaveLength(0);

    // R1: the event is still in the index and still classified.
    const events = index.byKind.get('fs.external_change') ?? [];
    expect(events).toHaveLength(1);
    expect(
      externalChangeClassificationFor(bundle, index).byGlobalIdx.get(events[0]!.globalIdx)!
        .classification,
    ).toBe('git_merge_in');
  });

  it('STILL flags when the pull delivered content nobody recorded', async () => {
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession('something else\n') },
      { who: { studentRef: COLLAB_ALICE }, events: pullFromTerminal(NOBODY_RECORDED) },
    ]);
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    const f = flags[0]!;
    expect(f.severity).toBe('info');
    expect(f.confidence).toBeCloseTo(0.6);
    expect(f.detail!['externalChangeClass']).toBe('git_unrecorded_in');
    expect(f.description).toContain('git_unrecorded_in');
  });

  it('R3 — a solo bundle carries no classification fields at all', async () => {
    const solo = await buildCollabScope([
      { who: { studentRef: COLLAB_ALICE }, events: pullFromTerminal(PARTNER_WORK) },
    ]);
    const flags = terminalActiveDuringExternalChangeHeuristic.run(
      solo.index,
      solo.bundle,
      defaultConfig,
    );
    expect(flags).toHaveLength(1);
    const f = flags[0]!;
    expect(f.detail!['externalChangeClass']).toBeUndefined();
    expect(f.description.endsWith('was responsible for the file change.')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D16 — the recorder's tag was never consulted here, and still is not
// ---------------------------------------------------------------------------

describe('terminal_active_during_external_change — D16 does not reach this heuristic', () => {
  const PARTNER_WORK = 'def solve(n):\n    return n * 2\n';
  const NOBODY_RECORDED = 'def solve(n):\n    return magic(n)\n';

  const terminalOpen: EventSpec = {
    kind: 'terminal.open',
    data: { terminal_id: 't1', shell: 'zsh', shell_integration: true },
  };

  /** `git pull` run in the integrated terminal, with the recorder's timing tag. */
  const taggedPullFromTerminal = (content: string): EventSpec[] =>
    collabPullerSession(content, { before: [terminalOpen], explanation: 'git' });

  it('flags a tagged git_unrecorded_in — as it always did, tag or no tag', async () => {
    // This heuristic has never read `explanation` (see its docstring: filtering
    // on the tag was considered as a noise mitigation and deliberately rejected
    // in favour of the content classification). D16 therefore changes nothing
    // here, and adding a tag test for "consistency" would undo that decision.
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession('something else\n') },
      { who: { studentRef: COLLAB_ALICE }, events: taggedPullFromTerminal(NOBODY_RECORDED) },
    ]);
    const flags = terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('info');
    expect(flags[0]!.detail!['externalChangeClass']).toBe('git_unrecorded_in');
  });

  it('a tagged git_merge_in is still suppressed — by content, not by the tag', async () => {
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(PARTNER_WORK) },
      { who: { studentRef: COLLAB_ALICE }, events: taggedPullFromTerminal(PARTNER_WORK) },
    ]);
    expect(
      terminalActiveDuringExternalChangeHeuristic.run(index, bundle, defaultConfig),
    ).toHaveLength(0);
    const events = index.byKind.get('fs.external_change') ?? [];
    expect(
      externalChangeClassificationFor(bundle, index).byGlobalIdx.get(events[0]!.globalIdx)!
        .classification,
    ).toBe('git_merge_in');
  });
});
