/**
 * Tests for the external_edits heuristic (Phase 4).
 */

import { describe, it, expect } from 'vitest';
import { externalEditsHeuristic } from './external-edits.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import { externalChangeClassificationFor } from '../index/classify-external-changes.js';
import {
  buildCollabScope,
  collabDocOpen,
  collabExternalChange,
  collabGitEvent,
  collabPartnerSession,
  collabPullerSession,
  COLLAB_ALICE,
  COLLAB_BOB,
  COLLAB_C0,
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
// Negative: no external change events
// ---------------------------------------------------------------------------

describe('external_edits — negative', () => {
  it('produces no flags when there are no fs.external_change events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when all external changes have formatter explanation', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                explanation: 'formatter',
                diff_size: 50,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when all external changes have git explanation', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                explanation: 'git',
                diff_size: 200,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive: unexplained external changes
// ---------------------------------------------------------------------------

describe('external_edits — positive', () => {
  it('flags a single unexplained fs.external_change as medium severity', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                diff_size: 50, // below highSeverityCharsChanged (100)
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('external_edits');
    expect(flags[0]!.severity).toBe('medium');
    expect(flags[0]!.confidence).toBe(0.9);
  });

  it('flags an unexplained external change with diff_size > 100 as high severity', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                diff_size: 101,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
  });

  it('flags an unexplained external change with diff_size exactly 100 as medium', async () => {
    // Boundary: highSeverityCharsChanged is 100, so > 100 is high.
    // Exactly 100 should be medium.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                diff_size: 100,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('medium');
  });

  it('flags an external change with no explanation field', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                // No explanation field
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
  });

  it('does not flag an external change with explanation: "formatter" even with large diff', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                explanation: 'formatter',
                diff_size: 9999,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Coalescing: consecutive events within 2s window → single flag
// ---------------------------------------------------------------------------

describe('external_edits — coalescing', () => {
  it('coalesces 5 external changes within 2s on the same file into 1 flag', async () => {
    // All events at t=1000, 1500, 1800, 2000, 2900ms — within 2000ms of each other.
    // BUT coalescing is per consecutive pair. Let's ensure all are within 2s apart.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 2000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 3000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 4000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 5000,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    // All consecutive pairs are 1000ms apart (< 2000ms window) → 1 flag
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['eventCount']).toBe(5);
  });

  it('splits into 2 flags when a burst spans > 2s gap', async () => {
    // Events at t=1000, 2000, 5000 (gap of 3000ms between 2nd and 3rd)
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 2000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 5001, // 3001ms gap from previous → new group
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(2);
    const counts = flags.map((f) => f.detail!['eventCount'] as number);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('does not coalesce events on different files', async () => {
    // Two simultaneous external changes on different files → 2 flags
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/a.py', diff_size: 10 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/b.py', diff_size: 10 },
              t: 1000,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(2);
  });

  it('does not coalesce events across sessions (t is session-local)', async () => {
    // Two events on the same file, both at t=1000 but in different sessions.
    // They cannot be coalesced because t is session-local.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
          ],
        },
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    // Different sessions → 2 flags
    expect(flags).toHaveLength(2);
  });

  it('uses maximum diff_size for severity when coalescing', async () => {
    // Two events within 2s: one small, one large
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 200 },
              t: 2000,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    // maxDiffSize is 200 > 100 → high
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.detail!['maxDiffSize']).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// supportingSeqs format
// ---------------------------------------------------------------------------

describe('external_edits — supportingSeqs', () => {
  it('includes all event seqs in a coalesced group', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 10 },
              t: 1500,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    // Both seq keys should be present
    expect(flags[0]!.supportingSeqs).toHaveLength(2);
    // Both should follow the ${sessionId}:${seq} format
    for (const key of flags[0]!.supportingSeqs) {
      expect(key).toMatch(/^[0-9a-f-]+:\d+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed: some explained, some not
// ---------------------------------------------------------------------------

describe('external_edits — mixed explained/unexplained', () => {
  it('only flags unexplained events when mix is present', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', explanation: 'formatter', diff_size: 50 },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: { path: '/test/file.py', diff_size: 50 },
              t: 2000,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Operation-aware description (recorder v1.3+)
// ---------------------------------------------------------------------------

describe('external_edits — operation discriminator', () => {
  it('delete operation: description reads "was deleted"', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                operation: 'delete',
                old_hash: 'aaa',
                new_hash: '',
                diff_size: 50,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.description).toContain('was deleted outside VS Code');
    expect((flags[0]!.detail as { operations: string[] }).operations).toEqual(['delete']);
  });

  it('create operation: description reads "was created"', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/fresh.py',
                operation: 'create',
                old_hash: '',
                new_hash: 'bbb',
                diff_size: 30,
                new_content: 'def fresh(): pass\n',
                new_content_size: 18,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.description).toContain('was created outside VS Code');
  });

  it('modify operation (default): description reads "was modified"', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                operation: 'modify',
                diff_size: 50,
              },
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.description).toContain('was modified outside VS Code');
  });

  it('mixed delete+create in the same coalesce window: description lists both', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                operation: 'delete',
                old_hash: 'aaa',
                new_hash: '',
                diff_size: 50,
              },
              t: 1000,
            },
            {
              kind: 'fs.external_change',
              data: {
                path: '/test/file.py',
                operation: 'create',
                old_hash: '',
                new_hash: 'bbb',
                diff_size: 80,
                new_content: 'rewritten\n',
                new_content_size: 10,
              },
              t: 1500,
            },
          ],
        },
      ],
    });
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.description).toContain('was affected (create, delete) outside VS Code');
  });
});

// ---------------------------------------------------------------------------
// Tier 3.1 — content-based reclassification
// ---------------------------------------------------------------------------

describe('external_edits — Tier 3.1 reclassification', () => {
  const PARTNER_WORK = 'def solve(n):\n    return n * 2\n';
  const NOBODY_RECORDED = 'def solve(n):\n    return magic(n)\n';

  /** The identical external change, in a scope that is not collaborative. */
  async function soloBaseline(content: string) {
    const solo = await buildCollabScope([
      { who: { studentRef: COLLAB_ALICE }, events: collabPullerSession(content) },
    ]);
    const flags = externalEditsHeuristic.run(solo.index, solo.bundle, cfg);
    expect(flags).toHaveLength(1);
    return flags[0]!;
  }

  it("raises NO flag when a pull delivered the partner's recorded work", async () => {
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(PARTNER_WORK) },
      { who: { studentRef: COLLAB_ALICE }, events: collabPullerSession(PARTNER_WORK) },
    ]);
    expect(externalEditsHeuristic.run(index, bundle, cfg)).toHaveLength(0);
  });

  it('R1 — the un-flagged event is still in the index, and still classified', async () => {
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(PARTNER_WORK) },
      { who: { studentRef: COLLAB_ALICE }, events: collabPullerSession(PARTNER_WORK) },
    ]);
    const events = index.byKind.get('fs.external_change') ?? [];
    expect(events).toHaveLength(1);
    const c = externalChangeClassificationFor(bundle, index);
    expect(c.byGlobalIdx.get(events[0]!.globalIdx)!.classification).toBe('git_merge_in');
    expect(c.counts.git_merge_in).toBe(1);
  });

  it('STILL flags a pull that delivered content nobody recorded, at unchanged severity', async () => {
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession('something else\n') },
      { who: { studentRef: COLLAB_ALICE }, events: collabPullerSession(NOBODY_RECORDED) },
    ]);
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    const f = flags[0]!;

    // git_unrecorded_in is NOT innocent: same severity, same confidence, same
    // supporting evidence as the pre-3.1 flag for the identical change.
    const baseline = await soloBaseline(NOBODY_RECORDED);
    expect(f.severity).toBe(baseline.severity);
    expect(f.confidence).toBe(baseline.confidence);
    expect(f.detail!['maxDiffSize']).toBe(baseline.detail!['maxDiffSize']);

    // ...and the classification is named, in the description and in the detail.
    expect(f.detail!['externalChangeClass']).toBe('git_unrecorded_in');
    expect(f.description).toContain('git_unrecorded_in');
    expect(f.description.startsWith(baseline.description)).toBe(true);
  });

  it('STILL flags an out-of-editor paste, with the byte-identical pre-3.1 description', async () => {
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession('something else\n') },
      {
        who: { studentRef: COLLAB_ALICE },
        events: [
          collabGitEvent(COLLAB_C0),
          collabDocOpen('start\n'),
          collabExternalChange(NOBODY_RECORDED),
        ],
      },
    ]);
    const flags = externalEditsHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    const f = flags[0]!;
    expect(f.detail!['externalChangeClass']).toBe('external');
    // `external` adds no clause.
    expect(f.description).toBe((await soloBaseline(NOBODY_RECORDED)).description);
  });

  it('R3 — a solo bundle carries no classification fields at all', async () => {
    const f = await soloBaseline(NOBODY_RECORDED);
    expect(f.detail!['externalChangeClass']).toBeUndefined();
    expect(f.detail!['externalChangeReason']).toBeUndefined();
    expect(f.detail!['externalChangeDetail']).toBeUndefined();
    expect(f.description).toBe(
      'hw1.py was modified outside VS Code (1 unexplained event) ' +
        `(max ±${NOBODY_RECORDED.length} chars).`,
    );
  });
});
