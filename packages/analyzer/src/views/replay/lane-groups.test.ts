/**
 * Tests for lane-groups.ts.
 */

import { describe, it, expect } from 'vitest';
import { buildLaneLayout } from './lane-groups.js';
import type { AmbiguousReconstruction } from './engine-core.js';

const CONCURRENT: AmbiguousReconstruction = {
  kind: 'concurrent',
  branches: [],
  divergence: { contributorKeys: ['alice', 'bob'], detail: 'Two lineages are live and unordered.' },
};

const UNKNOWN: AmbiguousReconstruction = {
  kind: 'unknown',
  reason: 'event_outside_ordering',
  detail: 'An event of this file is not in the ordering’s scope.',
};

function activeFiles(pairs: Array<[string, string | null]>): ReadonlyMap<string, string | null> {
  return new Map(pairs);
}

describe('buildLaneLayout', () => {
  it('returns no cells and no rail for no contributors', () => {
    const layout = buildLaneLayout([], activeFiles([]), new Map(), 3);
    expect(layout).toEqual({ cells: [], railKeys: [] });
  });

  it('gives a solo contributor with no activity an idle cell', () => {
    const layout = buildLaneLayout(
      [{ key: 'alice' }],
      activeFiles([['alice', null]]),
      new Map(),
      3,
    );
    expect(layout.cells).toEqual([{ kind: 'idle', contributorKeys: ['alice'], filePath: null }]);
    expect(layout.railKeys).toEqual([]);
  });

  it('gives a solo contributor with an active determinate file a single cell', () => {
    const layout = buildLaneLayout(
      [{ key: 'alice' }],
      activeFiles([['alice', 'a.py']]),
      new Map(),
      3,
    );
    expect(layout.cells).toEqual([
      { kind: 'single', contributorKeys: ['alice'], filePath: 'a.py' },
    ]);
  });

  it('treats a contributor missing from activeFileByContributor as idle', () => {
    const layout = buildLaneLayout([{ key: 'alice' }], activeFiles([]), new Map(), 3);
    expect(layout.cells).toEqual([{ kind: 'idle', contributorKeys: ['alice'], filePath: null }]);
  });

  it('groups two contributors on the same determinate file into one converged cell', () => {
    const layout = buildLaneLayout(
      [{ key: 'alice' }, { key: 'bob' }],
      activeFiles([
        ['alice', 'a.py'],
        ['bob', 'a.py'],
      ]),
      new Map(),
      3,
    );
    expect(layout.cells).toEqual([
      { kind: 'converged', contributorKeys: ['alice', 'bob'], filePath: 'a.py' },
    ]);
  });

  it('never groups two contributors that are each idle (null is never merged)', () => {
    const layout = buildLaneLayout(
      [{ key: 'alice' }, { key: 'bob' }],
      activeFiles([
        ['alice', null],
        ['bob', null],
      ]),
      new Map(),
      3,
    );
    expect(layout.cells).toEqual([
      { kind: 'idle', contributorKeys: ['alice'], filePath: null },
      { kind: 'idle', contributorKeys: ['bob'], filePath: null },
    ]);
  });

  it('gives distinct files their own single cells, in first-appearance order', () => {
    const layout = buildLaneLayout(
      [{ key: 'alice' }, { key: 'bob' }],
      activeFiles([
        ['alice', 'a.py'],
        ['bob', 'b.py'],
      ]),
      new Map(),
      3,
    );
    expect(layout.cells).toEqual([
      { kind: 'single', contributorKeys: ['alice'], filePath: 'a.py' },
      { kind: 'single', contributorKeys: ['bob'], filePath: 'b.py' },
    ]);
  });

  it('overrides a single-contributor cell with concurrent when fileAmbiguity has an entry', () => {
    const layout = buildLaneLayout(
      [{ key: 'alice' }],
      activeFiles([['alice', 'a.py']]),
      new Map([['a.py', CONCURRENT]]),
      3,
    );
    expect(layout.cells).toEqual([
      { kind: 'concurrent', contributorKeys: ['alice'], filePath: 'a.py', ambiguity: CONCURRENT },
    ]);
  });

  it('overrides a converged cell with unknown when fileAmbiguity says unknown', () => {
    const layout = buildLaneLayout(
      [{ key: 'alice' }, { key: 'bob' }],
      activeFiles([
        ['alice', 'a.py'],
        ['bob', 'a.py'],
      ]),
      new Map([['a.py', UNKNOWN]]),
      3,
    );
    expect(layout.cells).toEqual([
      { kind: 'unknown', contributorKeys: ['alice', 'bob'], filePath: 'a.py', ambiguity: UNKNOWN },
    ]);
  });

  it('carries the ambiguity value through unmodified (branches not filtered to the group)', () => {
    const ambiguityWithExtraBranchOwner: AmbiguousReconstruction = {
      kind: 'concurrent',
      branches: [],
      divergence: { contributorKeys: ['alice', 'carol'], detail: 'carol has a live branch too' },
    };
    const layout = buildLaneLayout(
      [{ key: 'alice' }],
      activeFiles([['alice', 'a.py']]),
      new Map([['a.py', ambiguityWithExtraBranchOwner]]),
      3,
    );
    expect(layout.cells[0]).toMatchObject({
      ambiguity: ambiguityWithExtraBranchOwner,
    });
  });

  it('only lanes the first maxCodeLanes contributors; the rest go to the rail in order', () => {
    const layout = buildLaneLayout(
      [{ key: 'alice' }, { key: 'bob' }, { key: 'carol' }, { key: 'dave' }],
      activeFiles([
        ['alice', 'a.py'],
        ['bob', 'b.py'],
        ['carol', 'c.py'],
        ['dave', 'd.py'],
      ]),
      new Map(),
      2,
    );
    expect(layout.cells).toEqual([
      { kind: 'single', contributorKeys: ['alice'], filePath: 'a.py' },
      { kind: 'single', contributorKeys: ['bob'], filePath: 'b.py' },
    ]);
    expect(layout.railKeys).toEqual(['carol', 'dave']);
  });

  it('drops nothing: every contributor is either in a cell or on the rail', () => {
    const contributors = [{ key: 'alice' }, { key: 'bob' }, { key: 'carol' }];
    const layout = buildLaneLayout(
      contributors,
      activeFiles([
        ['alice', 'a.py'],
        ['bob', 'a.py'],
        ['carol', 'c.py'],
      ]),
      new Map(),
      2,
    );
    const laned = layout.cells.flatMap((c) => c.contributorKeys);
    expect([...laned, ...layout.railKeys].sort()).toEqual(['alice', 'bob', 'carol'].sort());
  });

  it('treats zero maxCodeLanes as no lanes, everyone on the rail', () => {
    const layout = buildLaneLayout(
      [{ key: 'alice' }, { key: 'bob' }],
      activeFiles([
        ['alice', 'a.py'],
        ['bob', 'b.py'],
      ]),
      new Map(),
      0,
    );
    expect(layout.cells).toEqual([]);
    expect(layout.railKeys).toEqual(['alice', 'bob']);
  });

  it('clamps a negative maxCodeLanes to zero rather than throwing', () => {
    const layout = buildLaneLayout(
      [{ key: 'alice' }],
      activeFiles([['alice', 'a.py']]),
      new Map(),
      -1,
    );
    expect(layout.cells).toEqual([]);
    expect(layout.railKeys).toEqual(['alice']);
  });

  it('orders a converged cell by the lowest contributor index, letting a later column collapse into it', () => {
    // bob (index 1) and carol (index 2) converge on b.py; alice (index 0) is
    // on her own file. Expected order: alice's cell, then the converged cell
    // at "index 1" position — carol's own column disappears.
    const layout = buildLaneLayout(
      [{ key: 'alice' }, { key: 'bob' }, { key: 'carol' }],
      activeFiles([
        ['alice', 'a.py'],
        ['bob', 'b.py'],
        ['carol', 'b.py'],
      ]),
      new Map(),
      3,
    );
    expect(layout.cells).toEqual([
      { kind: 'single', contributorKeys: ['alice'], filePath: 'a.py' },
      { kind: 'converged', contributorKeys: ['bob', 'carol'], filePath: 'b.py' },
    ]);
  });

  it('preserves contributor-appearance order within a converged group (not sorted)', () => {
    const layout = buildLaneLayout(
      [{ key: 'zed' }, { key: 'alice' }],
      activeFiles([
        ['zed', 'a.py'],
        ['alice', 'a.py'],
      ]),
      new Map(),
      3,
    );
    const cell = layout.cells[0];
    expect(cell?.contributorKeys).toEqual(['zed', 'alice']);
  });
});
