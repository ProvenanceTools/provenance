/**
 * ReplayLanes.test — design §4/§9. Builds real `Contributor` / `AmbiguousReconstruction`
 * fixtures and lets the component call `buildLaneLayout` itself, rather than
 * hand-building `LaneCell`s — that keeps this suite honest about what
 * `ReplayLanes` actually wires together, not just what it renders given a cell.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Contributor, SessionContributor } from '@provenance/analysis-core/identity/types.js';
import type { AmbiguousReconstruction } from './engine-core.js';
import type { LaneCell } from './lane-groups.js';
import { buildContributorPalette } from './contributor-palette.js';
import { ReplayLanes } from './ReplayLanes.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function contributor(ref: string): Contributor {
  return {
    key: `attributed:2.1:institution:inst1:${ref}`,
    kind: 'attributed',
    studentRef: ref,
    identityVersion: '2.1',
    scope: 'institution',
    scopeId: 'inst1',
    sessionIds: [`sess-${ref}`],
  };
}

function keyOf(ref: string): string {
  return `attributed:2.1:institution:inst1:${ref}`;
}

function sessionContributor(ref: string): SessionContributor {
  return {
    kind: 'attributed',
    sessionId: `sess-${ref}`,
    contributorKey: keyOf(ref),
    studentRef: ref,
    identityVersion: '2.1',
    scope: 'institution',
    scopeId: 'inst1',
    studentPubkey: 'pk',
    certWindow: { in_window: true },
    credentialWindow: { in_window: true },
  };
}

function activeFiles(pairs: Array<[string, string | null]>): ReadonlyMap<string, string | null> {
  return new Map(pairs);
}

/**
 * A `concurrent` verdict for `filePath`, with one branch per ref in
 * `branchRefs` — deliberately NOT restricted to whichever refs are the
 * group's own `contributorKeys`, so callers can construct the "branch owner
 * moved elsewhere" case the design (§4, last paragraph) requires.
 */
function concurrentAmbiguity(branchRefs: readonly string[]): AmbiguousReconstruction {
  return {
    kind: 'concurrent',
    branches: branchRefs.map((ref) => ({
      contributorKey: keyOf(ref),
      contributor: sessionContributor(ref),
      tip: { sessionId: `sess-${ref}`, seq: 3 },
      value: {
        content: `${ref}-content`,
        provenance: new Uint32Array(0),
        kindByGlobalIdx: new Map(),
        hashBySaveSeq: new Map(),
      },
      ambiguousAncestry: false,
    })),
    divergence: { contributorKeys: branchRefs.map(keyOf), detail: 'Two lineages are unordered.' },
  };
}

/** A renderPane spy that records every call and renders a locatable marker. */
function paneSpy() {
  const calls: Array<{ cell: LaneCell; ownsCaret: boolean }> = [];
  function renderPane(args: { cell: LaneCell; ownsCaret: boolean }) {
    calls.push(args);
    return (
      <div data-testid={`pane-${args.cell.contributorKeys.join('+')}`}>
        {args.cell.filePath ?? ''}/{args.ownsCaret ? 'owns-caret' : 'no-caret'}
      </div>
    );
  }
  return { renderPane, calls };
}

// ---------------------------------------------------------------------------
// 1 contributor
// ---------------------------------------------------------------------------

describe('one contributor', () => {
  it('renders an idle lane when there is no activity yet', () => {
    const alice = contributor('alice');
    const { renderPane } = paneSpy();
    render(
      <ReplayLanes
        contributors={[alice]}
        activeFileByContributor={activeFiles([])}
        fileAmbiguity={new Map()}
        palette={buildContributorPalette([alice])}
        activeContributorKey={null}
        renderPane={renderPane}
      />,
    );
    const lane = screen.getByTestId('replay-lane');
    expect(lane.dataset['kind']).toBe('idle');
    expect(screen.getByTestId('replay-lane-caption').textContent).toMatch(/no recorded activity/i);
    // Not styled as an error/warning — no amber/red class on the caption.
    expect(screen.getByTestId('replay-lane-caption').className).not.toMatch(/amber|red/);
  });

  it('renders a single lane with the active file and calls renderPane once', () => {
    const alice = contributor('alice');
    const { renderPane, calls } = paneSpy();
    render(
      <ReplayLanes
        contributors={[alice]}
        activeFileByContributor={activeFiles([[alice.key, 'a.py']])}
        fileAmbiguity={new Map()}
        palette={buildContributorPalette([alice])}
        activeContributorKey={alice.key}
        renderPane={renderPane}
      />,
    );
    expect(screen.getByTestId('replay-lane').dataset['kind']).toBe('single');
    expect(screen.getByTestId('replay-lane-file').textContent).toBe('a.py');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ownsCaret).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 contributors — converged is the case this feature exists for
// ---------------------------------------------------------------------------

describe('two contributors converged on the same determinate file', () => {
  it('produces ONE pane, not two, headed by both chips', () => {
    const alice = contributor('alice');
    const bob = contributor('bob');
    const { renderPane, calls } = paneSpy();
    render(
      <ReplayLanes
        contributors={[alice, bob]}
        activeFileByContributor={activeFiles([
          [alice.key, 'shared.py'],
          [bob.key, 'shared.py'],
        ])}
        fileAmbiguity={new Map()}
        palette={buildContributorPalette([alice, bob])}
        activeContributorKey={alice.key}
        renderPane={renderPane}
      />,
    );

    const lanes = screen.getAllByTestId('replay-lane');
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.dataset['kind']).toBe('converged');
    expect(lanes[0]?.dataset['span']).toBe('2');

    // One renderPane call for the group, not one per contributor.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cell.contributorKeys).toEqual([alice.key, bob.key]);

    // Both contributors' chips are present on the one header.
    expect(screen.getByTestId(`replay-lane-chip-${alice.key}`)).toBeInTheDocument();
    expect(screen.getByTestId(`replay-lane-chip-${bob.key}`)).toBeInTheDocument();

    expect(screen.getByTestId('replay-lane-caption').textContent).toBe(
      'One file, one recorded truth.',
    );
  });

  it('never renders a tone badge on a converged header (no single identity verdict to show)', () => {
    const alice = contributor('alice');
    const bob = contributor('bob');
    const { renderPane } = paneSpy();
    render(
      <ReplayLanes
        contributors={[alice, bob]}
        activeFileByContributor={activeFiles([
          [alice.key, 'shared.py'],
          [bob.key, 'shared.py'],
        ])}
        fileAmbiguity={new Map()}
        palette={buildContributorPalette([alice, bob])}
        activeContributorKey={null}
        renderPane={renderPane}
      />,
    );
    expect(screen.queryByTestId('replay-lane-tone')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// concurrent / unknown — the extracted refusal surface, unfiltered branches
// ---------------------------------------------------------------------------

describe('a concurrent file', () => {
  it('spans the group and renders the refusal panel, including a branch for a contributor outside the group', () => {
    const alice = contributor('alice');
    const bob = contributor('bob');
    const { renderPane, calls } = paneSpy();
    render(
      <ReplayLanes
        // Only alice is currently active on shared.py; carol has since moved
        // to another file (or was never one of the laned contributors at
        // all) but still owns a live, unordered branch on it — the branch
        // list belongs to the FILE, per design §4's last paragraph.
        contributors={[alice, bob]}
        activeFileByContributor={activeFiles([
          [alice.key, 'shared.py'],
          [bob.key, 'other.py'],
        ])}
        fileAmbiguity={new Map([['shared.py', concurrentAmbiguity(['alice', 'carol'])]])}
        palette={buildContributorPalette([alice, bob])}
        activeContributorKey={null}
        renderPane={renderPane}
      />,
    );

    const concurrentLane = screen
      .getAllByTestId('replay-lane')
      .find((el) => el.dataset['kind'] === 'concurrent');
    expect(concurrentLane).toBeDefined();
    // The cell's own group is just alice — bob is elsewhere.
    expect(concurrentLane?.dataset['contributorKeys']).toBe(alice.key);

    // But the rendered refusal panel shows BOTH branches, including carol's,
    // who is not in the cell's own contributorKeys.
    const branchNames = screen
      .getAllByTestId('replay-branch-contributor')
      .map((el) => el.textContent);
    expect(branchNames.sort()).toEqual(['alice', 'carol']);

    // The refusal surface never calls renderPane for ITS OWN cell — there is
    // no single content pane for a concurrent file. (bob's unrelated `other.py`
    // cell is a `single` lane and does call renderPane once, which is fine —
    // it just isn't this cell.)
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cell.contributorKeys).toEqual([bob.key]);
  });

  it('keeps the unknown arm distinct from concurrent, inside a lane cell', () => {
    const alice = contributor('alice');
    const { renderPane } = paneSpy();
    const unknown: AmbiguousReconstruction = {
      kind: 'unknown',
      reason: 'event_outside_ordering',
      detail: 'An event of this file is not in the ordering’s scope.',
    };
    render(
      <ReplayLanes
        contributors={[alice]}
        activeFileByContributor={activeFiles([[alice.key, 'a.py']])}
        fileAmbiguity={new Map([['a.py', unknown]])}
        palette={buildContributorPalette([alice])}
        activeContributorKey={null}
        renderPane={renderPane}
      />,
    );
    expect(screen.getByTestId('replay-lane').dataset['kind']).toBe('unknown');
    expect(screen.getByTestId('replay-ambiguous').getAttribute('data-ambiguity-kind')).toBe(
      'unknown',
    );
    expect(screen.queryAllByTestId('replay-branch')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3 contributors — exactly at the default cap, no rail
// ---------------------------------------------------------------------------

describe('three contributors at the default cap', () => {
  it('lanes all three, with no rail', () => {
    const [a, b, c] = ['alice', 'bob', 'carol'].map(contributor);
    const { renderPane } = paneSpy();
    render(
      <ReplayLanes
        contributors={[a!, b!, c!]}
        activeFileByContributor={activeFiles([
          [a!.key, 'a.py'],
          [b!.key, 'b.py'],
          [c!.key, 'c.py'],
        ])}
        fileAmbiguity={new Map()}
        palette={buildContributorPalette([a!, b!, c!])}
        activeContributorKey={null}
        renderPane={renderPane}
      />,
    );
    expect(screen.getAllByTestId('replay-lane')).toHaveLength(3);
    expect(screen.queryByTestId('replay-rails')).toBeNull();
    expect(screen.getByTestId('replay-lanes-grid').style.gridTemplateColumns).toBe(
      'repeat(3, minmax(0, 1fr))',
    );
  });
});

// ---------------------------------------------------------------------------
// 5 contributors — rails, and promotion
// ---------------------------------------------------------------------------

describe('five contributors, over the default cap of three', () => {
  const refs = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const people = refs.map(contributor);
  const files = new Map(people.map((p, i) => [p.key, `${refs[i]}.py`] as const));

  function renderFive(activeContributorKey: string | null = null) {
    const { renderPane, calls } = paneSpy();
    const utils = render(
      <ReplayLanes
        contributors={people}
        activeFileByContributor={files}
        fileAmbiguity={new Map()}
        palette={buildContributorPalette(people)}
        activeContributorKey={activeContributorKey}
        renderPane={renderPane}
      />,
    );
    return { ...utils, calls };
  }

  it('lanes the first three in order and rails the rest, dropping nobody', () => {
    renderFive();
    expect(screen.getAllByTestId('replay-lane')).toHaveLength(3);
    expect(screen.getByTestId('replay-rails')).toBeInTheDocument();
    expect(screen.getByTestId(`replay-rail-${keyOf('dave')}`)).toBeInTheDocument();
    expect(screen.getByTestId(`replay-rail-${keyOf('erin')}`)).toBeInTheDocument();
    // Every contributor appears somewhere: 3 lane chips + 2 rail chips, all
    // via the same `ContributorChip` (its testid never varies by container).
    expect(screen.getAllByTestId(/^replay-lane-chip-/)).toHaveLength(5);
  });

  it('promoting a rail contributor swaps them into a code lane, displacing the last-laned one — total lanes stay 3', () => {
    renderFive();
    fireEvent.click(screen.getByTestId(`replay-rail-promote-${keyOf('dave')}`));

    // dave now has his own lane. The cap never widens: the lane count stays
    // exactly 3, so someone had to give up their slot — the design's own
    // wording is "promoted, demoting another", not "and everyone keeps theirs".
    expect(screen.getAllByTestId('replay-lane')).toHaveLength(3);
    expect(screen.getByTestId('replay-lanes-grid').style.gridTemplateColumns).toBe(
      'repeat(3, minmax(0, 1fr))',
    );

    const daveLane = screen
      .getAllByTestId('replay-lane')
      .find((el) => el.dataset['contributorKeys'] === keyOf('dave'));
    expect(daveLane).toBeDefined();
    expect(daveLane?.dataset['kind']).toBe('single');
    expect(screen.queryByTestId(`replay-rail-${keyOf('dave')}`)).toBeNull();

    // carol — the third-in-order contributor, and so the one bumped when dave
    // took a front slot — is displaced back onto the rail. She is NOT hidden:
    // her rail chip is still on screen, which is the invariant that matters
    // (design: "the rest are ribbon-only rails that can be promoted, demoting
    // another" — demoted, never disappeared).
    const carolRail = screen.getByTestId(`replay-rail-${keyOf('carol')}`);
    expect(carolRail).toBeInTheDocument();
    expect(
      screen
        .getByTestId(`replay-lane-chip-${keyOf('carol')}`)
        .closest('[data-testid^="replay-rail-"]'),
    ).not.toBeNull();

    // alice and bob, who were never promoted and never displaced, keep their
    // original lanes.
    const lanedKeys = screen
      .getAllByTestId('replay-lane')
      .map((el) => el.dataset['contributorKeys']);
    expect(lanedKeys.sort()).toEqual([keyOf('alice'), keyOf('bob'), keyOf('dave')].sort());

    // erin, who was never promoted and never laned, is still on the rail too
    // — nobody vanished.
    expect(screen.getByTestId(`replay-rail-${keyOf('erin')}`)).toBeInTheDocument();
  });

  it('promoting a fourth distinct contributor evicts the least-recently-promoted one, not an arbitrary one', () => {
    renderFive();
    // Promote dave, then erin, then carol — the promoted list is now full at
    // maxCodeLanes (3): [carol, erin, dave], most-recent first.
    fireEvent.click(screen.getByTestId(`replay-rail-promote-${keyOf('dave')}`));
    fireEvent.click(screen.getByTestId(`replay-rail-promote-${keyOf('erin')}`));
    fireEvent.click(screen.getByTestId(`replay-rail-promote-${keyOf('carol')}`));

    // Promoting bob — a fourth DISTINCT contributor — must evict dave, the
    // least-recently-promoted of the three (promoted first, never re-promoted
    // since), not carol or erin, who were promoted more recently.
    fireEvent.click(screen.getByTestId(`replay-rail-promote-${keyOf('bob')}`));

    expect(screen.getAllByTestId('replay-lane')).toHaveLength(3);
    const lanedKeys = screen
      .getAllByTestId('replay-lane')
      .map((el) => el.dataset['contributorKeys']);
    expect(lanedKeys.sort()).toEqual([keyOf('bob'), keyOf('carol'), keyOf('erin')].sort());

    // dave — despite having been promoted earlier — is back on the rail.
    expect(screen.getByTestId(`replay-rail-${keyOf('dave')}`)).toBeInTheDocument();
    // alice, never promoted, is also still on the rail.
    expect(screen.getByTestId(`replay-rail-${keyOf('alice')}`)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Caret ownership
  // -------------------------------------------------------------------------

  it('gives renderPane ownsCaret:true only for the lane whose key matches activeContributorKey', () => {
    const { calls } = renderFive(keyOf('bob'));
    const owners = calls.filter((c) => c.ownsCaret).map((c) => c.cell.contributorKeys);
    expect(owners).toEqual([[keyOf('bob')]]);
    const nonOwners = calls.filter((c) => !c.ownsCaret).map((c) => c.cell.contributorKeys[0]);
    expect(nonOwners.sort()).toEqual([keyOf('alice'), keyOf('carol')].sort());
  });

  it('gives nobody the caret when activeContributorKey is null', () => {
    const { calls } = renderFive(null);
    expect(calls.every((c) => !c.ownsCaret)).toBe(true);
  });
});
