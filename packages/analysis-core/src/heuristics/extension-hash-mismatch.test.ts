/**
 * Tests for the extension_hash_mismatch heuristic (Phase 17).
 */

import { describe, it, expect } from 'vitest';
import { extensionHashMismatchHeuristic } from './extension-hash-mismatch.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { mergeConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

// A valid 64-char lowercase hex hash (placeholder format)
const KNOWN_HASH = 'a'.repeat(64);
const UNKNOWN_HASH = 'b'.repeat(64);

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

describe('extension_hash_mismatch — negative', () => {
  it('produces no flags when bundle.manifest.extension_hash is in the known-good list', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 2 }] });

    // Patch the bundle manifest to use a known hash
    const patchedBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, extension_hash: KNOWN_HASH },
    };
    const config = mergeConfig({ extensionHashMismatch: { knownGoodHashes: [KNOWN_HASH] } });
    const flags = extensionHashMismatchHeuristic.run(index, patchedBundle, config);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when the known-good list contains multiple hashes including the bundle hash', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 2 }] });
    const patchedBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, extension_hash: KNOWN_HASH },
    };
    const config = mergeConfig({
      extensionHashMismatch: { knownGoodHashes: [UNKNOWN_HASH, KNOWN_HASH, 'c'.repeat(64)] },
    });
    const flags = extensionHashMismatchHeuristic.run(index, patchedBundle, config);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('extension_hash_mismatch — positive', () => {
  it('flags a bundle whose extension_hash is NOT in the known-good list', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 2 }] });
    const patchedBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, extension_hash: UNKNOWN_HASH },
    };
    const config = mergeConfig({ extensionHashMismatch: { knownGoodHashes: [KNOWN_HASH] } });
    const flags = extensionHashMismatchHeuristic.run(index, patchedBundle, config);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('extension_hash_mismatch');
    expect(flags[0]!.severity).toBe('medium');
    expect(flags[0]!.confidence).toBe(0.9);
    expect(flags[0]!.detail!['extensionHash']).toBe(UNKNOWN_HASH);
    expect(flags[0]!.supportingSeqs).toHaveLength(0);
  });

  it('flags when the known-good list is empty', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 2 }] });
    const patchedBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, extension_hash: UNKNOWN_HASH },
    };
    const config = mergeConfig({ extensionHashMismatch: { knownGoodHashes: [] } });
    const flags = extensionHashMismatchHeuristic.run(index, patchedBundle, config);
    expect(flags).toHaveLength(1);
  });

  it('flag ID includes the first 16 chars of the extension hash', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 2 }] });
    const patchedBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, extension_hash: UNKNOWN_HASH },
    };
    const config = mergeConfig({ extensionHashMismatch: { knownGoodHashes: [] } });
    const flags = extensionHashMismatchHeuristic.run(index, patchedBundle, config);
    expect(flags[0]!.id).toBe(`extension_hash_mismatch-${'b'.repeat(16)}`);
  });

  it('emits exactly one flag per bundle (not per session)', async () => {
    // Bundle with 2 sessions but still only 1 flag (bundle-level check)
    const { index, bundle } = await buildAndIndex({
      sessions: [{ eventCount: 2 }, { eventCount: 2 }],
    });
    const patchedBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, extension_hash: UNKNOWN_HASH },
    };
    const config = mergeConfig({ extensionHashMismatch: { knownGoodHashes: [KNOWN_HASH] } });
    const flags = extensionHashMismatchHeuristic.run(index, patchedBundle, config);
    expect(flags).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Rolling seals: one signed manifest per session, so a bundle can span
  // several recorder builds. Checking only the union manifest's single scalar
  // would leave the others unexamined.
  // -------------------------------------------------------------------------

  it('checks EVERY build a rolling-sealed bundle observed, not just the union scalar', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 2 }] });
    const other = 'c'.repeat(64);
    const patchedBundle = {
      ...bundle,
      // The scalar is a known-good build…
      manifest: { ...bundle.manifest, extension_hash: KNOWN_HASH },
      // …but an earlier session ran under something the course does not know.
      rollingSeal: {
        seals: [],
        defects: [],
        observedExtensionHashes: [KNOWN_HASH, other],
      },
    };
    const config = mergeConfig({ extensionHashMismatch: { knownGoodHashes: [KNOWN_HASH] } });
    const flags = extensionHashMismatchHeuristic.run(index, patchedBundle, config);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['extensionHash']).toBe(other);
  });

  it('stays silent when every observed build is known-good', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 2 }] });
    const second = 'c'.repeat(64);
    const patchedBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, extension_hash: second },
      rollingSeal: {
        seals: [],
        defects: [],
        observedExtensionHashes: [KNOWN_HASH, second],
      },
    };
    const config = mergeConfig({
      extensionHashMismatch: { knownGoodHashes: [KNOWN_HASH, second] },
    });
    expect(extensionHashMismatchHeuristic.run(index, patchedBundle, config)).toEqual([]);
  });

  it('reports one flag per distinct unrecognised build', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 2 }] });
    const a = 'c'.repeat(64);
    const b = 'd'.repeat(64);
    const patchedBundle = {
      ...bundle,
      manifest: { ...bundle.manifest, extension_hash: a },
      // The duplicate must not produce a duplicate flag.
      rollingSeal: { seals: [], defects: [], observedExtensionHashes: [a, a, b] },
    };
    const config = mergeConfig({ extensionHashMismatch: { knownGoodHashes: [KNOWN_HASH] } });
    const flags = extensionHashMismatchHeuristic.run(index, patchedBundle, config);
    expect(flags.map((f) => f.detail!['extensionHash'])).toEqual([a, b]);
  });
});
