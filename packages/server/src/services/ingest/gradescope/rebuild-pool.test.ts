import { describe, it, expect } from 'vitest';
import {
  buildBundleZipFromFiles,
  selectBundleEntries,
  type BundleEntry,
} from '@provenance/analysis-core/scopes/select-entries.js';
import { createRebuildPool } from './rebuild-pool.js';

const enc = new TextEncoder();

function sampleFiles(seed: string): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ['.provenance/manifest.json', enc.encode(`{"format_version":"1.1","seed":"${seed}"}`)],
    ['.provenance/manifest.sig', enc.encode('ab'.repeat(32))],
    ['.provenance/session-1.slog', enc.encode(`slog ${seed}\n`.repeat(2000))],
    ['.provenance/session-1.slog.meta', enc.encode('{"s":1}')],
    ['.DS_Store', enc.encode('junk')], // must be dropped by selection
  ]);
}

async function entriesFor(seed: string): Promise<BundleEntry[]> {
  const sel = selectBundleEntries(sampleFiles(seed));
  if (!sel.ok) throw new Error('expected a manifest');
  return sel.entries;
}

describe('createRebuildPool', () => {
  it('produces bytes identical to in-process buildBundleZipFromFiles (dedup-safe)', async () => {
    const pool = createRebuildPool(2);
    try {
      for (const seed of ['a', 'bb', 'ccc']) {
        const reference = await buildBundleZipFromFiles(sampleFiles(seed));
        expect(reference.ok).toBe(true);
        if (!reference.ok) return;
        const viaPool = await pool.zip(await entriesFor(seed));
        expect(viaPool).toEqual(new Uint8Array(reference.data));
      }
    } finally {
      await pool.dispose();
    }
  });

  it('handles many concurrent rebuilds across the pool', async () => {
    const pool = createRebuildPool(3);
    try {
      const seeds = Array.from({ length: 20 }, (_, i) => `seed-${i}`);
      const results = await Promise.all(
        seeds.map(async (s) => {
          const ref = await buildBundleZipFromFiles(sampleFiles(s));
          if (!ref.ok) throw new Error('no manifest');
          const got = await pool.zip(await entriesFor(s));
          return got.length === new Uint8Array(ref.data).length;
        }),
      );
      expect(results.every(Boolean)).toBe(true);
    } finally {
      await pool.dispose();
    }
  });

  it('rejects zip() after dispose', async () => {
    const pool = createRebuildPool(1);
    await pool.dispose();
    await expect(pool.zip(await entriesFor('x'))).rejects.toThrow(/disposed/);
  });
});
