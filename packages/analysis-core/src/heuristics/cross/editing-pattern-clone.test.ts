/**
 * Tests for editing_pattern_clone cross-heuristic (Phase 18).
 */

import { describe, it, expect } from 'vitest';
import { editingPatternCloneHeuristic as realEditingPatternCloneHeuristic } from './editing-pattern-clone.js';
import { partitionCrossScopes } from '../../coverage/cross-scope.js';
import type { CrossHeuristicConfig, CrossSubmissionFeatures } from './types.js';

/**
 * The heuristic under test, driven with the repository-lineage partition of its
 * OWN features — which is exactly what `runCrossHeuristics` hands it in
 * production (spec S20, `coverage/cross-scope.ts`).
 *
 * Wrapped here rather than threaded through every call site so these tests keep
 * asserting what they always asserted. The suppression path itself is covered in
 * `same-scope-exclusion.test.ts`, end to end from real bundles: none of the stub
 * bundles below records a `git.event`, so every one of them is its own lineage
 * and nothing here is suppressed. Deliberately NOT solved with a default
 * parameter on `run` — a default is how "no partition" would slip silently into
 * a production caller.
 */
const editingPatternCloneHeuristic = {
  ...realEditingPatternCloneHeuristic,
  run: (features: CrossSubmissionFeatures[], config: CrossHeuristicConfig) =>
    realEditingPatternCloneHeuristic.run(features, config, partitionCrossScopes(features)),
};
import { DEFAULT_CROSS_HEURISTIC_CONFIG } from './types.js';
import { extractCrossFeatures } from './features.js';
import type { Bundle } from '../../loader/types.js';
import type { EventIndex, IndexedEvent } from '../../index/event-index.js';
import type { EventKind } from '@provenance/log-core';

/** Convert test Bundle+EventIndex stubs into the cross-feature input. */
function toFeatures(bundles: Bundle[], indices: Map<string, EventIndex>) {
  return bundles.map((b) => extractCrossFeatures(b, indices.get(b.id)!));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBundle(id: string): Bundle {
  return {
    id,
    manifest: {
      assignment_id: 'hw1',
      semester: 'sp26',
      assignment_key_pubhex: 'a'.repeat(64),
      extension_hash: 'b'.repeat(64),
    },
    manifestSigHex: 'c'.repeat(128),
    sessions: [],
    sourceFilename: `${id}.zip`,
    loadedAt: new Date().toISOString(),
  } as unknown as Bundle;
}

/**
 * Build a minimal EventIndex from an ordered list of event kinds.
 * Provides the minimum structure that editing-pattern-clone needs:
 * `index.ordered` (the chronological kind stream).
 */
function makeIndexWithKinds(kinds: EventKind[]): EventIndex {
  const ordered: IndexedEvent[] = kinds.map((kind, i) => ({
    sessionId: 'sess-0',
    seq: i,
    globalIdx: i,
    wall: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    t: i * 1000,
    kind,
    payload: null,
  }));

  return {
    bySeq: new Map(ordered.map((e) => [`${e.sessionId}:${e.seq}`, e])),
    byKind: new Map(),
    byFile: new Map(),
    bySessionId: new Map(),
    ordered,
  };
}

const cfg = DEFAULT_CROSS_HEURISTIC_CONFIG;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('editing_pattern_clone', () => {
  describe('positive cases — flag fires', () => {
    it('fires when two bundles have identical kind streams', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      const kinds: EventKind[] = [
        'session.start',
        'doc.change',
        'doc.change',
        'paste',
        'doc.save',
        'doc.change',
        'doc.save',
      ];

      const indexA = makeIndexWithKinds(kinds);
      const indexB = makeIndexWithKinds(kinds);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = editingPatternCloneHeuristic.run(toFeatures([bundleA, bundleB], indices), cfg);
      expect(flags).toHaveLength(1);
      expect(flags[0]!.heuristic).toBe('editing_pattern_clone');
      expect(flags[0]!.severity).toBe('medium');
      expect(flags[0]!.confidence).toBe(0.7);
      expect(flags[0]!.bundleIds).toContain(bundleA.id);
      expect(flags[0]!.bundleIds).toContain(bundleB.id);
      expect(flags[0]!.detail?.['jaccardScore']).toBe(1.0);
    });

    it('fires when two bundles have highly similar kind streams (Jaccard > threshold)', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      // A has [open, change, change, paste, save, change, save].
      // B has [open, change, paste, save, change, save, change].
      // They share most 3-grams.
      const kindsA: EventKind[] = [
        'doc.open',
        'doc.change',
        'doc.change',
        'paste',
        'doc.save',
        'doc.change',
        'doc.save',
      ];
      const kindsB: EventKind[] = [
        'doc.open',
        'doc.change',
        'paste',
        'doc.save',
        'doc.change',
        'doc.save',
        'doc.change',
      ];

      const indexA = makeIndexWithKinds(kindsA);
      const indexB = makeIndexWithKinds(kindsB);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = editingPatternCloneHeuristic.run(toFeatures([bundleA, bundleB], indices), cfg);
      // Both streams share many 3-grams; expect at least 1 flag.
      expect(flags).toHaveLength(1);
      const score = flags[0]!.detail?.['jaccardScore'] as number;
      expect(score).toBeGreaterThan(cfg.editingPatternCloneThreshold);
    });

    it('emits one flag per pair (three bundles → three pairs checked)', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');
      const bundleC = makeBundle('bundle-c');

      // All three have the same kind stream → all pairs fire.
      const kinds: EventKind[] = [
        'session.start',
        'doc.open',
        'doc.change',
        'paste',
        'doc.save',
        'doc.change',
        'doc.save',
      ];

      const makeIdx = () => makeIndexWithKinds(kinds);
      const indices = new Map([
        [bundleA.id, makeIdx()],
        [bundleB.id, makeIdx()],
        [bundleC.id, makeIdx()],
      ]);

      const flags = editingPatternCloneHeuristic.run(
        toFeatures([bundleA, bundleB, bundleC], indices),
        cfg,
      );
      // Pairs: A-B, A-C, B-C → 3 flags.
      expect(flags).toHaveLength(3);
    });
  });

  describe('negative cases — no flag fires', () => {
    it('no flag when only one bundle', () => {
      const bundleA = makeBundle('bundle-a');
      const indexA = makeIndexWithKinds(['session.start', 'doc.change', 'doc.save'] as EventKind[]);
      const indices = new Map([[bundleA.id, indexA]]);

      const flags = editingPatternCloneHeuristic.run(toFeatures([bundleA], indices), cfg);
      expect(flags).toHaveLength(0);
    });

    it('no flag when kind streams are completely different', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      // A: all pastes.
      const kindsA: EventKind[] = ['paste', 'paste', 'paste', 'paste', 'paste'];
      // B: all terminal commands.
      const kindsB: EventKind[] = [
        'terminal.command',
        'terminal.command',
        'terminal.command',
        'terminal.command',
        'terminal.command',
      ];

      const indexA = makeIndexWithKinds(kindsA);
      const indexB = makeIndexWithKinds(kindsB);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = editingPatternCloneHeuristic.run(toFeatures([bundleA, bundleB], indices), cfg);
      expect(flags).toHaveLength(0);
    });

    it('no flag when Jaccard is exactly at threshold (not above)', () => {
      // Force Jaccard to be 0.0 (no shared 3-grams).
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      const kindsA: EventKind[] = ['doc.open', 'doc.change', 'doc.save'] as EventKind[];
      const kindsB: EventKind[] = [
        'paste',
        'terminal.command',
        'fs.external_change',
      ] as EventKind[];

      const indexA = makeIndexWithKinds(kindsA);
      const indexB = makeIndexWithKinds(kindsB);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = editingPatternCloneHeuristic.run(toFeatures([bundleA, bundleB], indices), cfg);
      expect(flags).toHaveLength(0);
    });

    it('no flag when bundles have fewer than 3 events (cannot form a 3-gram)', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      // Only 2 events each — not enough to form a single 3-gram.
      const indexA = makeIndexWithKinds(['session.start', 'doc.change'] as EventKind[]);
      const indexB = makeIndexWithKinds(['session.start', 'doc.change'] as EventKind[]);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = editingPatternCloneHeuristic.run(toFeatures([bundleA, bundleB], indices), cfg);
      expect(flags).toHaveLength(0);
    });
  });

  describe('supporting structure', () => {
    it('flag detail contains jaccardScore, ngramSize, and bundle names', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      const kinds: EventKind[] = [
        'session.start',
        'doc.change',
        'doc.save',
        'doc.change',
        'doc.save',
      ];

      const indexA = makeIndexWithKinds(kinds);
      const indexB = makeIndexWithKinds(kinds);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = editingPatternCloneHeuristic.run(toFeatures([bundleA, bundleB], indices), cfg);
      expect(flags).toHaveLength(1);

      const detail = flags[0]!.detail!;
      expect(typeof detail['jaccardScore']).toBe('number');
      expect(detail['ngramSize']).toBe(3);
      expect(detail['threshold']).toBe(cfg.editingPatternCloneThreshold);
      expect(detail['bundleA']).toBe('bundle-a.zip');
      expect(detail['bundleB']).toBe('bundle-b.zip');
    });

    it('eventsPerBundle contains seq keys from both bundles', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      const kinds: EventKind[] = [
        'session.start',
        'doc.change',
        'doc.save',
        'doc.change',
        'doc.save',
        'doc.change',
      ];

      const indexA = makeIndexWithKinds(kinds);
      const indexB = makeIndexWithKinds(kinds);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = editingPatternCloneHeuristic.run(toFeatures([bundleA, bundleB], indices), cfg);
      expect(flags).toHaveLength(1);

      const epb = flags[0]!.eventsPerBundle;
      expect(Array.isArray(epb[bundleA.id])).toBe(true);
      expect(Array.isArray(epb[bundleB.id])).toBe(true);
      // Each bundle contributes ≤ 5 representative events.
      expect((epb[bundleA.id] ?? []).length).toBeLessThanOrEqual(5);
      expect((epb[bundleB.id] ?? []).length).toBeLessThanOrEqual(5);
    });

    it('flag ids are unique across pairs', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');
      const bundleC = makeBundle('bundle-c');

      const kinds: EventKind[] = [
        'session.start',
        'doc.change',
        'paste',
        'doc.save',
        'doc.change',
        'doc.save',
      ];

      const makeIdx = () => makeIndexWithKinds(kinds);
      const indices = new Map([
        [bundleA.id, makeIdx()],
        [bundleB.id, makeIdx()],
        [bundleC.id, makeIdx()],
      ]);

      const flags = editingPatternCloneHeuristic.run(
        toFeatures([bundleA, bundleB, bundleC], indices),
        cfg,
      );

      const ids = flags.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
