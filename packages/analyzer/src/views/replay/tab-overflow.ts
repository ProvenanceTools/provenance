/**
 * tab-overflow — which replay file tabs get a slot in the single tab row, and
 * which go behind the "+N files" menu.
 *
 * The tab row never wraps: a bundle with twenty files used to wrap into six
 * rows and push the editor half off-screen. Instead tabs are ranked by how
 * relevant they are at the playhead, the most relevant that fit are shown, and
 * the rest are one click away in the overflow menu.
 *
 * Shown tabs keep the bundle's file order (not rank order) so a tab doesn't
 * jump sideways when another file's recency changes during playback.
 *
 * Pure: no React, no DOM.
 */

import type { FileRecency } from './file-recency.js';

/** Lower is more relevant. */
export function relevanceRank(
  filePath: string,
  activeFile: string | null,
  recency: FileRecency | null,
): [number, number] {
  if (filePath === activeFile) return [0, 0];
  if (recency === null) return [3, 0];
  switch (recency.state) {
    case 'current-session':
      return [1, recency.agoMs];
    case 'earlier-session':
      return [2, recency.sessionsAgo];
    case 'untouched':
      return [3, 0];
  }
}

/** `files` sorted most-relevant first; ties keep bundle order. */
export function byRelevance(
  files: readonly string[],
  activeFile: string | null,
  recencyOf: (filePath: string) => FileRecency | null,
): string[] {
  const keyed = files.map((f, i) => ({ f, i, r: relevanceRank(f, activeFile, recencyOf(f)) }));
  keyed.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i);
  return keyed.map((k) => k.f);
}

/**
 * Split `files` into the tabs that fit in `available` px and the overflow.
 *
 * @param files - Bundle order.
 * @param ranked - The same files, most relevant first (see `byRelevance`).
 * @param widthOf - Measured width of each file's tab, px, including its gap.
 * @param available - Width of the tab row, px.
 * @param moreWidth - Width reserved for the "+N files" button when anything overflows.
 *
 * Unmeasured layouts (every width 0, e.g. jsdom) show every tab. The most
 * relevant tab is always shown, even if it alone is wider than the row.
 */
export function splitTabs(
  files: readonly string[],
  ranked: readonly string[],
  widthOf: (filePath: string) => number,
  available: number,
  moreWidth: number,
): { visible: string[]; overflow: string[] } {
  const total = files.reduce((sum, f) => sum + widthOf(f), 0);
  // available <= 0: the row has not been laid out (or is hidden) — show all.
  if (available <= 0 || total <= available) return { visible: [...files], overflow: [] };

  const budget = available - moreWidth;
  const chosen = new Set<string>();
  let used = 0;
  for (const f of ranked) {
    const w = widthOf(f);
    if (chosen.size > 0 && used + w > budget) continue; // a narrower, less relevant tab may still fit
    chosen.add(f);
    used += w;
  }
  return {
    visible: files.filter((f) => chosen.has(f)),
    overflow: ranked.filter((f) => !chosen.has(f)),
  };
}
