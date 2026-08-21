/**
 * Tests for paste_shared_across_students cross-heuristic (Phase 18).
 */

import { describe, it, expect } from 'vitest';
import { pasteSharedAcrossStudentsHeuristic as realPasteSharedAcrossStudentsHeuristic } from './paste-shared-across-students.js';
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
const pasteSharedAcrossStudentsHeuristic = {
  ...realPasteSharedAcrossStudentsHeuristic,
  run: (features: CrossSubmissionFeatures[], config: CrossHeuristicConfig) =>
    realPasteSharedAcrossStudentsHeuristic.run(features, config, partitionCrossScopes(features)),
};
import { DEFAULT_CROSS_HEURISTIC_CONFIG } from './types.js';
import { extractCrossFeatures } from './features.js';
import type { Bundle } from '../../loader/types.js';
import type { EventIndex, IndexedEvent } from '../../index/event-index.js';

/** Convert test Bundle+EventIndex stubs into the cross-feature input. */
function toFeatures(bundles: Bundle[], indices: Map<string, EventIndex>) {
  return bundles.map((b) => extractCrossFeatures(b, indices.get(b.id)!));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal Bundle stub with an id. */
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
 * Build a minimal EventIndex that contains only paste events.
 * Each paste is specified as { sessionId, seq, sha256?, content?, length }.
 */
function makeIndexWithPastes(
  pastes: Array<{
    sessionId: string;
    seq: number;
    sha256?: string;
    content?: string;
    length: number;
  }>,
): EventIndex {
  const pasteEvents: IndexedEvent[] = pastes.map((p, i) => ({
    sessionId: p.sessionId,
    seq: p.seq,
    globalIdx: i,
    wall: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    t: i * 1000,
    kind: 'paste' as const,
    payload: {
      path: 'hw1.py',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      length: p.length,
      sha256: p.sha256 ?? 'a'.repeat(64),
      ...(p.content !== undefined ? { content: p.content } : {}),
    },
  }));

  const byKind = new Map();
  byKind.set('paste', pasteEvents);

  return {
    bySeq: new Map(pasteEvents.map((e) => [`${e.sessionId}:${e.seq}`, e])),
    byKind,
    byFile: new Map(),
    bySessionId: new Map(),
    ordered: pasteEvents,
  };
}

const cfg = DEFAULT_CROSS_HEURISTIC_CONFIG;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('paste_shared_across_students', () => {
  describe('positive cases — flag fires', () => {
    it('fires when two bundles share the same sha256 paste', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      const sharedSha256 = 'd'.repeat(64);
      const indexA = makeIndexWithPastes([
        { sessionId: 'sess-a', seq: 1, sha256: sharedSha256, length: 200 },
      ]);
      const indexB = makeIndexWithPastes([
        { sessionId: 'sess-b', seq: 1, sha256: sharedSha256, length: 200 },
      ]);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = pasteSharedAcrossStudentsHeuristic.run(
        toFeatures([bundleA, bundleB], indices),
        cfg,
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]!.heuristic).toBe('paste_shared_across_students');
      expect(flags[0]!.severity).toBe('high');
      expect(flags[0]!.confidence).toBe(0.95);
      expect(flags[0]!.bundleIds).toContain(bundleA.id);
      expect(flags[0]!.bundleIds).toContain(bundleB.id);
      expect(flags[0]!.eventsPerBundle[bundleA.id]).toEqual(['sess-a:1']);
      expect(flags[0]!.eventsPerBundle[bundleB.id]).toEqual(['sess-b:1']);
    });

    it('fires for three bundles sharing the same paste (three-way share)', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');
      const bundleC = makeBundle('bundle-c');

      const sharedSha256 = 'e'.repeat(64);
      const makeIdx = (sessionId: string) =>
        makeIndexWithPastes([{ sessionId, seq: 1, sha256: sharedSha256, length: 300 }]);

      const indices = new Map([
        [bundleA.id, makeIdx('sess-a')],
        [bundleB.id, makeIdx('sess-b')],
        [bundleC.id, makeIdx('sess-c')],
      ]);

      const flags = pasteSharedAcrossStudentsHeuristic.run(
        toFeatures([bundleA, bundleB, bundleC], indices),
        cfg,
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]!.bundleIds).toHaveLength(3);
    });

    it('fires with lower confidence (0.8) when match is fuzzy-only', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      // Two pastes with unique sha256 but very similar content (>90% overlap).
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i}: def solve(): return ${i}`);
      const contentA = lines.join('\n');
      // Change only the last line to keep overlap > 90% (19/20 = 95%).
      const contentB = [...lines.slice(0, 19), 'line 19: different ending'].join('\n');

      const indexA = makeIndexWithPastes([
        { sessionId: 'sess-a', seq: 1, sha256: 'f'.repeat(64), content: contentA, length: 400 },
      ]);
      const indexB = makeIndexWithPastes([
        { sessionId: 'sess-b', seq: 1, sha256: 'g'.repeat(64), content: contentB, length: 400 },
      ]);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = pasteSharedAcrossStudentsHeuristic.run(
        toFeatures([bundleA, bundleB], indices),
        cfg,
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]!.confidence).toBe(0.8);
      expect(flags[0]!.detail?.['matchKind']).toBe('fuzzy_and_or_exact');
    });

    it('groups multiple pastes from same bundles into one flag per shared group', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      const sha1 = '1'.repeat(64);
      const sha2 = '2'.repeat(64);

      const indexA = makeIndexWithPastes([
        { sessionId: 'sess-a', seq: 1, sha256: sha1, length: 150 },
        { sessionId: 'sess-a', seq: 2, sha256: sha2, length: 200 },
      ]);
      const indexB = makeIndexWithPastes([
        { sessionId: 'sess-b', seq: 1, sha256: sha1, length: 150 },
        { sessionId: 'sess-b', seq: 2, sha256: sha2, length: 200 },
      ]);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = pasteSharedAcrossStudentsHeuristic.run(
        toFeatures([bundleA, bundleB], indices),
        cfg,
      );
      // Two distinct groups (sha1 and sha2 are different) → 2 flags.
      expect(flags).toHaveLength(2);
    });
  });

  describe('negative cases — no flag fires', () => {
    it('no flag when only one bundle loaded', () => {
      const bundleA = makeBundle('bundle-a');
      const indexA = makeIndexWithPastes([
        { sessionId: 'sess-a', seq: 1, sha256: 'h'.repeat(64), length: 200 },
      ]);

      const indices = new Map([[bundleA.id, indexA]]);
      const flags = pasteSharedAcrossStudentsHeuristic.run(toFeatures([bundleA], indices), cfg);
      expect(flags).toHaveLength(0);
    });

    it('no flag when pastes are short (below minLength)', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      const sha = 'i'.repeat(64);
      const indexA = makeIndexWithPastes([
        { sessionId: 'sess-a', seq: 1, sha256: sha, length: 50 },
      ]);
      const indexB = makeIndexWithPastes([
        { sessionId: 'sess-b', seq: 1, sha256: sha, length: 50 },
      ]);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = pasteSharedAcrossStudentsHeuristic.run(
        toFeatures([bundleA, bundleB], indices),
        cfg,
      );
      // Both pastes are below the 100-char minimum.
      expect(flags).toHaveLength(0);
    });

    it('no flag when two bundles have pastes with different sha256 and no content', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      const indexA = makeIndexWithPastes([
        { sessionId: 'sess-a', seq: 1, sha256: 'j'.repeat(64), length: 200 },
      ]);
      const indexB = makeIndexWithPastes([
        { sessionId: 'sess-b', seq: 1, sha256: 'k'.repeat(64), length: 200 },
      ]);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = pasteSharedAcrossStudentsHeuristic.run(
        toFeatures([bundleA, bundleB], indices),
        cfg,
      );
      expect(flags).toHaveLength(0);
    });

    it('no flag when content overlap is below fuzzyThreshold (90%)', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      // 20-line content: only 10 lines shared (50% overlap — below 90%).
      const linesA = Array.from({ length: 20 }, (_, i) => `lineA_${i}: code here`);
      const linesB = [
        ...linesA.slice(0, 10), // 10 shared lines
        ...Array.from({ length: 10 }, (_, i) => `lineB_${i}: entirely different content`),
      ];

      const indexA = makeIndexWithPastes([
        {
          sessionId: 'sess-a',
          seq: 1,
          sha256: 'l'.repeat(64),
          content: linesA.join('\n'),
          length: 500,
        },
      ]);
      const indexB = makeIndexWithPastes([
        {
          sessionId: 'sess-b',
          seq: 1,
          sha256: 'm'.repeat(64),
          content: linesB.join('\n'),
          length: 500,
        },
      ]);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = pasteSharedAcrossStudentsHeuristic.run(
        toFeatures([bundleA, bundleB], indices),
        cfg,
      );
      expect(flags).toHaveLength(0);
    });

    it('no flag when no paste events exist', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      const emptyIndex: EventIndex = {
        bySeq: new Map(),
        byKind: new Map(),
        byFile: new Map(),
        bySessionId: new Map(),
        ordered: [],
      };

      const indices = new Map([
        [bundleA.id, emptyIndex],
        [bundleB.id, emptyIndex],
      ]);

      const flags = pasteSharedAcrossStudentsHeuristic.run(
        toFeatures([bundleA, bundleB], indices),
        cfg,
      );
      expect(flags).toHaveLength(0);
    });
  });

  describe('supporting structure', () => {
    it('flag id is deterministic and unique per group', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      const sha1 = '1'.repeat(64);
      const sha2 = '2'.repeat(64);

      const indexA = makeIndexWithPastes([
        { sessionId: 'sess-a', seq: 1, sha256: sha1, length: 150 },
        { sessionId: 'sess-a', seq: 2, sha256: sha2, length: 150 },
      ]);
      const indexB = makeIndexWithPastes([
        { sessionId: 'sess-b', seq: 1, sha256: sha1, length: 150 },
        { sessionId: 'sess-b', seq: 2, sha256: sha2, length: 150 },
      ]);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = pasteSharedAcrossStudentsHeuristic.run(
        toFeatures([bundleA, bundleB], indices),
        cfg,
      );
      const ids = flags.map((f) => f.id);
      // All ids must be unique.
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('eventsPerBundle contains correct seqKeys for all pastes in the group', () => {
      const bundleA = makeBundle('bundle-a');
      const bundleB = makeBundle('bundle-b');

      const sha = 'n'.repeat(64);
      // Two pastes in bundle A with same sha256 → both in same group.
      const indexA = makeIndexWithPastes([
        { sessionId: 'sess-a', seq: 1, sha256: sha, length: 200 },
        { sessionId: 'sess-a', seq: 3, sha256: sha, length: 200 },
      ]);
      const indexB = makeIndexWithPastes([
        { sessionId: 'sess-b', seq: 2, sha256: sha, length: 200 },
      ]);

      const indices = new Map([
        [bundleA.id, indexA],
        [bundleB.id, indexB],
      ]);

      const flags = pasteSharedAcrossStudentsHeuristic.run(
        toFeatures([bundleA, bundleB], indices),
        cfg,
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]!.eventsPerBundle[bundleA.id]).toHaveLength(2);
      expect(flags[0]!.eventsPerBundle[bundleA.id]).toContain('sess-a:1');
      expect(flags[0]!.eventsPerBundle[bundleA.id]).toContain('sess-a:3');
      expect(flags[0]!.eventsPerBundle[bundleB.id]).toHaveLength(1);
      expect(flags[0]!.eventsPerBundle[bundleB.id]).toContain('sess-b:2');
    });
  });
});
