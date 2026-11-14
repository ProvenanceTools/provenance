import { describe, expect, it } from 'vitest';
import { byRelevance, relevanceRank, splitTabs } from './tab-overflow.js';
import type { FileRecency } from './file-recency.js';

describe('relevanceRank', () => {
  it('ranks active < current session < earlier session < untouched', () => {
    const cur: FileRecency = { state: 'current-session', agoMs: 5000 };
    const earlier: FileRecency = { state: 'earlier-session', sessionsAgo: 1 };
    expect(relevanceRank('a', 'a', earlier)[0]).toBe(0);
    expect(relevanceRank('a', null, cur)[0]).toBe(1);
    expect(relevanceRank('a', null, earlier)[0]).toBe(2);
    expect(relevanceRank('a', null, { state: 'untouched' })[0]).toBe(3);
    expect(relevanceRank('a', null, null)[0]).toBe(3);
  });
});

describe('byRelevance', () => {
  const recency: Record<string, FileRecency> = {
    old: { state: 'earlier-session', sessionsAgo: 2 },
    older: { state: 'earlier-session', sessionsAgo: 5 },
    recent: { state: 'current-session', agoMs: 1000 },
    lessRecent: { state: 'current-session', agoMs: 60000 },
    never: { state: 'untouched' },
  };
  const of = (f: string) => recency[f] ?? null;

  it('orders by tier, then recency within a tier', () => {
    expect(byRelevance(['never', 'older', 'lessRecent', 'old', 'recent'], null, of)).toEqual([
      'recent',
      'lessRecent',
      'old',
      'older',
      'never',
    ]);
  });

  it('puts the active file first regardless of recency', () => {
    expect(byRelevance(['recent', 'never'], 'never', of)[0]).toBe('never');
  });

  it('keeps bundle order for ties', () => {
    expect(byRelevance(['b', 'a', 'c'], null, () => null)).toEqual(['b', 'a', 'c']);
  });
});

describe('splitTabs', () => {
  const files = ['a', 'b', 'c', 'd', 'e'];

  it('shows every tab when they all fit', () => {
    expect(splitTabs(files, files, () => 50, 250, 80)).toEqual({
      visible: files,
      overflow: [],
    });
  });

  it('shows every tab when nothing is measured (jsdom)', () => {
    expect(splitTabs(files, files, () => 0, 0, 80).overflow).toEqual([]);
  });

  it('shows every tab when the row itself has no width yet', () => {
    expect(splitTabs(files, files, () => 50, 0, 80).overflow).toEqual([]);
  });

  it('keeps the most relevant that fit, reserving room for the overflow button', () => {
    // 250px of tabs > 240 available; minus 80 for "+N files" → 160 → three.
    const ranked = ['e', 'c', 'a', 'd', 'b'];
    const { visible, overflow } = splitTabs(files, ranked, () => 50, 240, 80);
    expect(visible).toEqual(['a', 'c', 'e']); // bundle order, not rank order
    expect(overflow).toEqual(['d', 'b']);
  });

  it('lists overflow most relevant first', () => {
    const ranked = ['a', 'e', 'd', 'c', 'b'];
    const { overflow } = splitTabs(files, ranked, () => 100, 300, 80);
    expect(overflow).toEqual(['d', 'c', 'b']);
  });

  it('lets a narrower, less relevant tab take leftover space', () => {
    const widths: Record<string, number> = { a: 100, b: 150, c: 40 };
    const { visible } = splitTabs(['a', 'b', 'c'], ['a', 'b', 'c'], (f) => widths[f]!, 230, 80);
    // budget 150: a (100) fits, b (150) does not, c (40) does.
    expect(visible).toEqual(['a', 'c']);
  });

  it('always shows the most relevant tab, even if it alone overflows', () => {
    const { visible } = splitTabs(
      files,
      ['c', ...files.filter((f) => f !== 'c')],
      () => 500,
      300,
      80,
    );
    expect(visible).toEqual(['c']);
  });
});
