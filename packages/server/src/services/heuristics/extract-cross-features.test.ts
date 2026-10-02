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
  ASSUMED_SINGLE_REPOSITORY,
  commitNodeKey,
} from '@provenance/analysis-core/git/observed-dag.js';
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

    // Chronological order: seq0 (idx0), seq2 (idx1), seq1 (idx2). The paste is
    // seq 2 but globalIdx 1 — a seq-order assignment would give 2.
    expect(globalIdxBySeqKey.get(`${SESSION}:2`)).toBe(1);
    // Only events a cross-flag can reference are mapped, and those are the
    // pastes (editing_pattern_clone's leading "representatives" were retired).
    expect([...globalIdxBySeqKey.keys()]).toEqual([`${SESSION}:2`]);

    // Paste payload reduced to the fields the heuristic needs.
    expect(features.pastes).toHaveLength(1);
    expect(features.pastes[0]).toMatchObject({
      seqKey: `${SESSION}:2`,
      sha256: 'sha-xyz',
      content,
      length: 120,
    });
  });

  it('produces no pastes and an empty globalIdx map for a paste-free submission', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ sessionId: SESSION, eventCount: 0 }],
    });

    const parsed = await loadBundle(zipBuffer, 'b.zip');
    if (!parsed.ok) throw new Error(`bundle parse failed: ${parsed.error.kind}`);
    const index = buildIndex(parsed.value);

    const { features, globalIdxBySeqKey } = extractCrossFeaturesFromIndex(
      index,
      'sub-1',
      'bundle-1',
    );

    expect(features.pastes).toHaveLength(0);
    expect(globalIdxBySeqKey.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The same-scope exclusion key (spec S20)
//
// The server builds CrossSubmissionFeatures on its own path, so it has to
// produce the same `observedCommitKeys` the browser does — otherwise a
// git-native group submission is correctly excluded under `/local` and still
// accused on the server.
// ---------------------------------------------------------------------------

describe('extractCrossFeaturesFromIndex — observed commit keys', () => {
  const SHA = 'ab'.repeat(20);

  it("carries the bundle's observed commits as (repository, sha) node keys", async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          sessionId: SESSION,
          events: [
            {
              kind: 'git.event',
              data: { operation: 'commit', sha: SHA, commit_sha: SHA, parents: [], branch: 'main' },
            },
          ],
        },
      ],
    });
    const parsed = await loadBundle(zipBuffer, 'b.zip');
    if (!parsed.ok) throw new Error(`bundle parse failed: ${parsed.error.kind}`);

    const { features } = extractCrossFeaturesFromIndex(
      buildIndex(parsed.value),
      'sub-1',
      'bundle-1',
      parsed.value,
    );
    // Identical to what the browser's extractCrossFeatures produces — the same
    // `observedCommitKeysOf` is imported, not reimplemented.
    expect(features.observedCommitKeys).toEqual([commitNodeKey(ASSUMED_SINGLE_REPOSITORY, SHA)]);
  });

  it('is an empty list, not undefined, when nothing was recorded', async () => {
    // Empty and absent are different claims: empty is "we looked and there were
    // none", absent is "nobody computed it". Both suppress nothing, but only the
    // first is a statement about this bundle.
    const { zipBuffer } = await buildTestBundle({ sessions: [{ sessionId: SESSION }] });
    const parsed = await loadBundle(zipBuffer, 'b.zip');
    if (!parsed.ok) throw new Error(`bundle parse failed: ${parsed.error.kind}`);

    const { features } = extractCrossFeaturesFromIndex(
      buildIndex(parsed.value),
      'sub-1',
      'bundle-1',
      parsed.value,
    );
    expect(features.observedCommitKeys).toEqual([]);
  });

  it('is undefined when no bundle is passed — never computed, so nothing is excluded', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ sessionId: SESSION }] });
    const parsed = await loadBundle(zipBuffer, 'b.zip');
    if (!parsed.ok) throw new Error(`bundle parse failed: ${parsed.error.kind}`);

    const { features } = extractCrossFeaturesFromIndex(
      buildIndex(parsed.value),
      'sub-1',
      'bundle-1',
    );
    expect(features.observedCommitKeys).toBeUndefined();
  });
});
