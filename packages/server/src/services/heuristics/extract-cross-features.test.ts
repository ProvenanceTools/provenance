/**
 * Tests for extractCrossFeaturesFromIndex.
 *
 * The critical, easy-to-get-wrong property is that globalIdx is the position
 * after sorting events by (wall, sessionId, seq) — NOT the raw seq — so that
 * cross_flag_participants.supporting_seqs match the analyzer/replay's globalIdx.
 * We seed events whose wall order deliberately differs from their seq order and
 * assert the chronological assignment, plus the compact feature shape.
 *
 * This is now a pure function over an EventIndex (no DB/storage): we build a
 * self-consistent test bundle, parse + index it, then feed the index straight
 * into extractCrossFeaturesFromIndex.
 */

import { describe, it, expect } from 'vitest';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import {
  buildTrustChainKeys,
  buildManifest2,
  sessionStart2,
} from '@provenance/analysis-core/test-support/build-manifest-2.js';
import { extractCrossFeaturesFromIndex } from './extract-cross-features.js';

const SESSION = '11111111-1111-1111-1111-111111111111';

describe('extractCrossFeaturesFromIndex', () => {
  it('assigns globalIdx in chronological (wall) order, not seq order', async () => {
    const content = 'p'.repeat(120);

    // seq order: 0 (session.start), 1 (doc.change), 2 (paste) — but wall order
    // is 0, 2, 1, so chronological order is session.start (seq0) → paste (seq2)
    // → doc.change (seq1).
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          sessionId: SESSION,
          events: [
            {
              kind: 'doc.change',
              wall: '2026-01-01T00:00:02.000Z',
              data: {
                path: 'hw.py',
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
              wall: '2026-01-01T00:00:01.000Z',
              data: {
                path: 'hw.py',
                sha256: 'sha-xyz',
                content,
                length: content.length,
              },
            },
          ],
        },
      ],
    });

    const parsed = await loadBundle(zipBuffer, 'b.zip');
    if (!parsed.ok) throw new Error(`bundle parse failed: ${parsed.error.kind}`);
    const index = buildIndex(parsed.value);

    const { features, globalIdxBySeqKey } = extractCrossFeaturesFromIndex(
      index,
      'sub-1',
      'bundle-1',
    );

    expect(features.bundleId).toBe('bundle-1');
    expect(features.eventCount).toBe(3);

    // Chronological order: seq0 (idx0), seq2 (idx1), seq1 (idx2).
    expect(features.representativeSeqKeys).toEqual([
      `${SESSION}:0`,
      `${SESSION}:2`,
      `${SESSION}:1`,
    ]);
    expect(globalIdxBySeqKey.get(`${SESSION}:0`)).toBe(0);
    expect(globalIdxBySeqKey.get(`${SESSION}:2`)).toBe(1);
    expect(globalIdxBySeqKey.get(`${SESSION}:1`)).toBe(2);

    // n-gram fingerprint built from the chronological kind stream.
    expect([...features.kindNgrams]).toEqual(['session.start|paste|doc.change']);

    // Paste payload reduced to the fields the heuristic needs.
    expect(features.pastes).toHaveLength(1);
    expect(features.pastes[0]).toMatchObject({
      seqKey: `${SESSION}:2`,
      sha256: 'sha-xyz',
      content,
      length: 120,
    });
  });

  it('produces an empty n-gram set and no pastes for a sub-3-event submission', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ sessionId: SESSION, eventCount: 0 }],
    });

    const parsed = await loadBundle(zipBuffer, 'b.zip');
    if (!parsed.ok) throw new Error(`bundle parse failed: ${parsed.error.kind}`);
    const index = buildIndex(parsed.value);

    const { features } = extractCrossFeaturesFromIndex(index, 'sub-1', 'bundle-1');

    expect(features.eventCount).toBe(1);
    expect(features.kindNgrams.size).toBe(0);
    expect(features.pastes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Capture policy (program spec §4)
//
// editing_pattern_clone fingerprints the event-KIND stream, so a course that
// disables a gated kind shrinks the alphabet and inflates Jaccard similarity
// across the whole cohort. The features must carry the recorded policy for the
// heuristic to be able to decline the comparison.
// ---------------------------------------------------------------------------

describe('extractCrossFeaturesFromIndex — capture policy', () => {
  it('reports no disabled signals when the bundle is not passed (1.x default)', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ sessionId: SESSION }] });
    const parsed = await loadBundle(zipBuffer, 'b.zip');
    if (!parsed.ok) throw new Error(`bundle parse failed: ${parsed.error.kind}`);

    const { features } = extractCrossFeaturesFromIndex(
      buildIndex(parsed.value),
      'sub-1',
      'bundle-1',
    );
    expect(features.disabledCaptureSignals).toBeUndefined();
  });

  it('reports an empty list for a 1.x bundle passed explicitly', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ sessionId: SESSION }] });
    const parsed = await loadBundle(zipBuffer, 'b.zip');
    if (!parsed.ok) throw new Error(`bundle parse failed: ${parsed.error.kind}`);

    const { features } = extractCrossFeaturesFromIndex(
      buildIndex(parsed.value),
      'sub-1',
      'bundle-1',
      parsed.value,
    );
    expect(features.disabledCaptureSignals).toEqual([]);
  });

  it("carries a 2.0 bundle's disabled signals through to the cross-heuristics", async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys,
      policy: { capture: { terminal: false, focus_change: false } },
    });
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ sessionId: SESSION, sessionStart: sessionStart2(manifest) }],
    });
    const parsed = await loadBundle(zipBuffer, 'b.zip');
    if (!parsed.ok) throw new Error(`bundle parse failed: ${parsed.error.kind}`);

    const { features } = extractCrossFeaturesFromIndex(
      buildIndex(parsed.value),
      'sub-1',
      'bundle-1',
      parsed.value,
    );
    expect(features.disabledCaptureSignals).toEqual(['focus_change', 'terminal']);
  });
});
