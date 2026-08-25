/**
 * Tests for contributor-palette.ts.
 */

import { describe, it, expect } from 'vitest';
import { buildContributorPalette } from './contributor-palette.js';

// The three forbidden families this module's header commits to staying clear
// of: paste orange, external red, and the emerald/slate/amber ContributorTone
// chrome (all from globals.css / BranchedFileView.tsx TONE_CHROME).
const FORBIDDEN_HUE_FRAGMENTS = [
  '251, 146, 60', // paste orange
  '239, 68, 68', // external red
  '16, 185, 129', // emerald-500 (attributed tone)
  '100, 116, 139', // slate-500 (unattributed / not-checked tone)
  '245, 158, 11', // amber-500 (identity_check_failed tone)
];

describe('buildContributorPalette', () => {
  it('returns an empty map for no contributors', () => {
    expect(buildContributorPalette([])).toEqual(new Map());
  });

  it('assigns index 0 and the first hue to a single contributor', () => {
    const palette = buildContributorPalette([{ key: 'alice' }]);
    const entry = palette.get('alice');
    expect(entry).toMatchObject({ key: 'alice', index: 0 });
    expect(entry?.hue).toBeDefined();
    expect(entry?.soft).toBeDefined();
  });

  it('indexes off array position, not sorted order', () => {
    // "zed" appears first even though it would sort last alphabetically.
    const palette = buildContributorPalette([{ key: 'zed' }, { key: 'alice' }]);
    expect(palette.get('zed')?.index).toBe(0);
    expect(palette.get('alice')?.index).toBe(1);
  });

  it('assigns a distinct hue to each of the first six contributors', () => {
    const contributors = Array.from({ length: 6 }, (_, i) => ({ key: `c${i}` }));
    const palette = buildContributorPalette(contributors);
    const hues = contributors.map((c) => palette.get(c.key)!.hue);
    expect(new Set(hues).size).toBe(6);
  });

  it('cycles back to the first hue for a 7th contributor', () => {
    const contributors = Array.from({ length: 7 }, (_, i) => ({ key: `c${i}` }));
    const palette = buildContributorPalette(contributors);
    expect(palette.get('c6')?.hue).toBe(palette.get('c0')?.hue);
    expect(palette.get('c6')?.soft).toBe(palette.get('c0')?.soft);
    expect(palette.get('c6')?.index).toBe(6);
  });

  it('never assigns a hue from a forbidden semantic-colour family', () => {
    const contributors = Array.from({ length: 6 }, (_, i) => ({ key: `c${i}` }));
    const palette = buildContributorPalette(contributors);
    for (const entry of palette.values()) {
      for (const forbidden of FORBIDDEN_HUE_FRAGMENTS) {
        expect(entry.hue).not.toContain(forbidden);
        expect(entry.soft).not.toContain(forbidden);
      }
    }
  });

  it('keys the map by contributorKey, one entry per contributor', () => {
    const palette = buildContributorPalette([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
    expect([...palette.keys()]).toEqual(['a', 'b', 'c']);
  });
});
