/**
 * Regression test for buildTestBundle's reproducibility knobs.
 *
 * tools/export-conformance-vectors.ts uses buildTestBundle to build the golden
 * bundle fixture consumed (as committed .json/.zip files) by the JetBrains and
 * Neovim recorder repos' conformance suites. Before sessionPrivkeyHex and
 * zipFileDate existed, buildTestBundle minted a fresh ed25519 keypair
 * (ed.utils.randomSecretKey()) and let JSZip stamp each file with `new Date()`
 * on every call, so re-running the exporter to regenerate vectors produced
 * spurious byte-for-byte churn in exactly the golden bundle's two output files
 * — nothing else about the fixture set actually changed, but this one had to
 * be noticed and reverted by hand every time.
 *
 * This file pins that reproducibility as a real assertion (fails before the
 * fix — a fresh keypair every call — and passes after it), and separately
 * confirms every other caller's existing behavior (a fresh random keypair by
 * default) is unchanged, since dozens of other tests build multiple bundles
 * per test and rely on them carrying distinct pubkeys.
 */

import { describe, it, expect } from 'vitest';
import { buildTestBundle } from './build-test-bundle.js';

describe('buildTestBundle reproducibility', () => {
  it('is byte-for-byte reproducible when sessionPrivkeyHex + zipFileDate are pinned', async () => {
    const opts = {
      assignmentId: 'golden-hw',
      semester: 'fa26',
      sessions: [{ eventCount: 8, appendDocSave: true }],
      sessionPrivkeyHex: '08'.repeat(32),
      zipFileDate: new Date('2026-01-01T00:00:00.000Z'),
    };

    const first = await buildTestBundle(opts);
    const second = await buildTestBundle(opts);

    expect(second.sessionPrivkeyHex).toBe(first.sessionPrivkeyHex);
    expect(second.manifest).toEqual(first.manifest);
    expect(Buffer.from(second.zipBuffer).equals(Buffer.from(first.zipBuffer))).toBe(true);
  });

  it('uses the pinned key, not a random one', async () => {
    const seed = '08'.repeat(32);
    const { sessionPrivkeyHex } = await buildTestBundle({ sessionPrivkeyHex: seed });
    expect(sessionPrivkeyHex).toBe(seed);
  });

  it('still mints a fresh random keypair per call when sessionPrivkeyHex is omitted', async () => {
    // Existing behavior for every other caller (dozens of test files build
    // multiple bundles per test and rely on distinct pubkeys) must be
    // unaffected by sessionPrivkeyHex being opt-in.
    const first = await buildTestBundle({ sessions: [{}] });
    const second = await buildTestBundle({ sessions: [{}] });

    expect(second.sessionPrivkeyHex).not.toBe(first.sessionPrivkeyHex);
  });

  it('still stamps a fresh zip-entry date per call when zipFileDate is omitted', async () => {
    // Without a pinned zipFileDate the manifest content can still be pinned via
    // sessionPrivkeyHex, but the zip bytes must not be — JSZip's default
    // `new Date()`-per-file behavior must survive untouched for every existing
    // caller that never passes zipFileDate.
    const opts = { sessionPrivkeyHex: '08'.repeat(32) };
    const first = await buildTestBundle(opts);
    // A real clock tick between builds is what would actually distinguish the
    // embedded mtimes; JSZip's DOS date field has 2-second resolution, so this
    // assertion only has teeth if the two calls straddle that boundary — which
    // is exactly why the golden bundle needs zipFileDate pinned rather than
    // relying on tests happening to run fast enough to dodge the nondeterminism.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const second = await buildTestBundle(opts);

    expect(Buffer.from(second.zipBuffer).equals(Buffer.from(first.zipBuffer))).toBe(false);
  });
});
