/**
 * ReplayView.concurrent.test — the headline case, end to end.
 *
 * Two partners on divergent branches, driven through a REAL bundle: real
 * identities, real contributor resolution, the real observed DAG, the real
 * happens-before relation and the real segmented reconstruction. Nothing about
 * the concurrency is stubbed, so this fails if any layer starts linearizing.
 *
 * The counterpart assertion — that a solo bundle renders exactly as it did
 * before any of this existed — is at the bottom and is the one that proves the
 * feature is gated rather than merely usually-inactive.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import {
  buildIndex,
  buildIndexFromEventRows,
  sessionsFromIndex,
  type ServerEventRow,
} from '@provenance/analysis-core/index/build-index.js';
import {
  buildReconstructionScopeFromSessions,
  reconstructionScopeFor,
  type ReconstructionScope,
} from '@provenance/analysis-core/index/reconstruct-segments.js';
import {
  fromWireBundleContributors,
  toWireBundleContributors,
} from '@provenance/analysis-core/identity/wire.js';
import type { BundleContributors } from '@provenance/analysis-core/identity/types.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
} from '@provenance/analysis-core/test-support/build-identity.js';
import type { IdentityTestKeys } from '@provenance/analysis-core/test-support/build-identity.js';
import { establishBundleContributors } from '@provenance/analysis-core/identity/resolve-contributors.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import { ReplayInner } from './ReplayView.js';

// ---------------------------------------------------------------------------
// Monaco mock — same shape as ReplayView.test.tsx.
//
// `revealSpies` is module-level so every Monaco instance mounted (up to three
// in lane mode) shares the same two spies, letting a test ask "which reveal
// METHOD got called" without needing to pick a single editor instance out of
// several. That is exactly the defect-2 wiring question: does the caller pass
// `verticalOnly` (→ `revealLineInCenterIfOutsideViewport`, no column) or not
// (→ `revealPositionInCenterIfOutsideViewport`, column and all).
// ---------------------------------------------------------------------------

const revealSpies = {
  position: vi.fn(),
  line: vi.fn(),
};

vi.mock('@monaco-editor/react', () => ({
  default: ({
    value,
    onMount,
  }: {
    value: string;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) => {
    const editor = {
      deltaDecorations: (_o: string[], n: unknown[]) => n.map((_, i) => `id-${i}`),
      revealPositionInCenterIfOutsideViewport: (...args: unknown[]) =>
        revealSpies.position(...args),
      revealLineInCenterIfOutsideViewport: (...args: unknown[]) => revealSpies.line(...args),
      getModel: () => null,
    };
    const monaco = { languages: { registerHoverProvider: () => ({ dispose: () => {} }) } };
    const mounted = React.useRef(false);
    React.useEffect(() => {
      if (mounted.current) return;
      mounted.current = true;
      onMount?.(editor, monaco);
    }, []);
    return <div data-testid="monaco-editor" data-value={value} />;
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILE = 'hw1.py';

let cachedKeys: IdentityTestKeys | null = null;
async function keys(): Promise<IdentityTestKeys> {
  cachedKeys ??= await buildIdentityKeys();
  return cachedKeys;
}

function typed(text: string, file: string = FILE) {
  return {
    kind: 'doc.change',
    data: {
      path: file,
      deltas: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text },
      ],
      source: 'typed',
    },
  };
}

/** A `focus.change` losing focus — recorder PRD §4.4. */
function focusLost(reason: string) {
  return { kind: 'focus.change', data: { gained: false, reason } };
}

/** A `selection.change` at a bare cursor (no selection) — recorder PRD §4.2. */
function cursorAt(line: number, character: number, file: string = FILE) {
  return {
    kind: 'selection.change',
    data: {
      path: file,
      range: { start: { line, character }, end: { line, character } },
      was_selection: false,
    },
  };
}

/**
 * A bundle of N sessions, each attributed to the named student, each typing one
 * distinctive string into the same file.
 *
 * No `git.event` and no `prev_session_id`, so the observed DAG and the session
 * chains give the relation nothing to order these two by — which is the honest
 * answer for two partners on branches that never met, and is precisely the
 * `concurrent` case.
 *
 * `file` is optional and defaults to the shared {@link FILE} — pass it to put
 * two partners in DIFFERENT files, which is the determinate side of the lane
 * grid (§4: two contributors, two files, two ordinary lanes) rather than the
 * refusal side. Same fixture, same cached keypairs; only the path moves.
 *
 * `focusAwayReason` is optional — pass it to append a `focus.change`
 * (gained: false) as that contributor's SECOND event, chronologically after
 * their typed edit. Used by the focus-away-overlay lane-scoping tests below;
 * omitted (the default) every existing caller sees the same one-event session
 * it always has.
 *
 * `selectionAfter` is likewise optional — appends a `selection.change` (a bare
 * cursor, no selection) as that contributor's last event. Used by the
 * follow-cursor lane-wiring test: it is what gives `FollowCursor` a non-null
 * target to reveal.
 */
async function buildScope(
  specs: Array<{
    who: { studentRef: string } | 'anonymous';
    text: string;
    file?: string;
    focusAwayReason?: string;
    selectionAfter?: { line: number; character: number };
  }>,
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const k = await keys();
  const sessions = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const sk = await seededKeypair(0xa0 + i);
    sessions.push({
      events: [
        typed(spec.text, spec.file ?? FILE),
        ...(spec.focusAwayReason !== undefined ? [focusLost(spec.focusAwayReason)] : []),
        ...(spec.selectionAfter !== undefined
          ? [cursorAt(spec.selectionAfter.line, spec.selectionAfter.character, spec.file ?? FILE)]
          : []),
      ],
      sessionStart: {
        session_pubkey: sk.pubkeyHex,
        ...(spec.who === 'anonymous'
          ? {}
          : {
              identity: await buildInstitutionIdentity({
                keys: k,
                sessionPubkeyHex: sk.pubkeyHex,
                studentRef: spec.who.studentRef,
              }),
            }),
      },
    });
  }
  const { zipBuffer } = await buildTestBundle({ sessions });
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`load failed: ${JSON.stringify(result.error)}`);
  await establishBundleContributors(result.value, k.root.pubkeyHex);
  return { bundle: result.value, index: buildIndex(result.value) };
}

/**
 * Render the way the `/local` route does: a parsed bundle in hand, so the scope
 * and the stamp come straight off it.
 */
function renderReplay(bundle: Bundle | null, index: EventIndex, extraSearch = '') {
  return renderWith(
    index,
    bundle === null ? null : reconstructionScopeFor(bundle, index),
    bundle?.contributors ?? null,
    extraSearch,
  );
}

/**
 * Render the way the SERVER-BACKED tab does.
 *
 * This is the path the defect lived on and the reason it survived: this file
 * only ever pinned `bundle={null}` under a SOLO fixture, so "no bundle" was
 * tested and "no bundle, two contributors" — the deployed group-work case — was
 * not. The tab has no `Bundle`; it pages `EventRow`s and reads the contributor
 * stamp off the summary. Both are reproduced exactly here: the index is rebuilt
 * from server-shape rows, and the stamp makes the round trip through the wire
 * projection, so nothing about the server's data shape is assumed away.
 */
function renderServerBackedReplay(bundle: Bundle, index: EventIndex) {
  const rows: ServerEventRow[] = [];
  for (const session of bundle.sessions) {
    for (const e of session.events) {
      rows.push({
        seq: e.seq,
        kind: e.kind,
        t: e.t,
        wall: e.wall,
        session_id: session.sessionId,
        payload: e.data,
      });
    }
  }
  rows.sort((a, b) => (a.wall !== b.wall ? (a.wall < b.wall ? -1 : 1) : a.seq - b.seq));

  const serverIndex = buildIndexFromEventRows(rows);
  const contributors =
    bundle.contributors === undefined
      ? null
      : fromWireBundleContributors(toWireBundleContributors(bundle.contributors));
  const scope = buildReconstructionScopeFromSessions(
    sessionsFromIndex(serverIndex),
    contributors?.bySession ?? new Map(),
    serverIndex,
  );
  // `index` is only used for the entry anchor; the tab replays `serverIndex`.
  void index;
  return renderWith(serverIndex, scope, contributors);
}

/** Renders the router's current query string so the split tests can read it. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-probe">{location.search}</span>;
}

function renderWith(
  index: EventIndex,
  scope: ReconstructionScope | null,
  contributors: BundleContributors | null,
  extraSearch = '',
) {
  const firstSession = [...index.bySessionId.keys()][0]!;
  const lastIdx = index.ordered.length - 1;
  return render(
    <MemoryRouter initialEntries={[`/local/replay/${firstSession}?event=${lastIdx}${extraSearch}`]}>
      <ReplayInner
        sessionId={firstSession}
        index={index}
        flags={[]}
        sourceFilename="test.zip"
        showHeader={false}
        scope={scope}
        contributors={contributors}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Two partners on divergent branches
// ---------------------------------------------------------------------------

describe('two partners on divergent branches', () => {
  it('renders as concurrent, with both branches shown and neither chosen', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderReplay(bundle, index);

    // Concurrent, not unknown.
    const pane = await screen.findByTestId('replay-ambiguous');
    expect(pane.getAttribute('data-ambiguity-kind')).toBe('concurrent');

    // Both branches, labelled by contributor.
    const names = screen.getAllByTestId('replay-branch-contributor').map((e) => e.textContent);
    expect(names.sort()).toEqual(['alice', 'bob']);

    // Both contents present, each in its own pane.
    expect(screen.getByText(/ALICE_LINE/)).toBeInTheDocument();
    expect(screen.getByText(/BOB_LINE/)).toBeInTheDocument();

    // Neither chosen: the ordinary editor is not rendered at all, so no branch
    // can be mistaken for "the file".
    expect(screen.queryByTestId('monaco-editor')).toBeNull();
  });

  it('offers a contributor switcher naming both partners', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderReplay(bundle, index);

    const select = await screen.findByTestId('replay-contributor-select');
    const options = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toContain('alice');
    expect(options).toContain('bob');
  });

  it('never puts an interleaving of the two branches on screen', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderReplay(bundle, index);
    await screen.findByTestId('replay-ambiguous');

    for (const pane of screen.getAllByTestId('replay-branch-content')) {
      const text = pane.textContent ?? '';
      expect(text.includes('ALICE_LINE') && text.includes('BOB_LINE')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The same two partners, through the SERVER-BACKED path
// ---------------------------------------------------------------------------

/**
 * The deployed analyzer. Everything above proved `/local` behaves; none of it
 * touched the path a grader on provenance.eecs.berkeley.edu actually uses, and
 * that path had no scope at all — it took `soloReconstructionScope`, which says
 * the submission has one contributor, and therefore replayed both partners'
 * edits as one linear keystroke sequence.
 */
describe('two partners, on the server-backed path', () => {
  it('renders as concurrent with both branches — parity with /local, not a linearization', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderServerBackedReplay(bundle, index);

    const pane = await screen.findByTestId('replay-ambiguous');
    expect(pane.getAttribute('data-ambiguity-kind')).toBe('concurrent');

    const names = screen.getAllByTestId('replay-branch-contributor').map((e) => e.textContent);
    expect(names.sort()).toEqual(['alice', 'bob']);

    // Neither branch is presented as "the file".
    expect(screen.queryByTestId('monaco-editor')).toBeNull();
  });

  it('offers the contributor switcher, which the server-backed tab never had', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderServerBackedReplay(bundle, index);

    const select = await screen.findByTestId('replay-contributor-select');
    const options = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toContain('alice');
    expect(options).toContain('bob');
  });

  it('never puts an interleaving of the two branches on screen', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderServerBackedReplay(bundle, index);
    await screen.findByTestId('replay-ambiguous');

    for (const pane of screen.getAllByTestId('replay-branch-content')) {
      const text = pane.textContent ?? '';
      expect(text.includes('ALICE_LINE') && text.includes('BOB_LINE')).toBe(false);
    }
  });

  /**
   * The gate, on the path that matters. A solo submission on the deployed
   * analyzer must render exactly as it did before any of this — the editor, with
   * content, and no switcher.
   */
  it('leaves a solo submission exactly as it was', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
    ]);

    renderServerBackedReplay(bundle, index);

    const editor = await screen.findByTestId('monaco-editor');
    expect(editor.getAttribute('data-value')).toContain('ALICE_LINE');
    expect(screen.queryByTestId('replay-ambiguous')).toBeNull();
    expect(screen.queryByTestId('replay-contributor-switcher')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The solo control
// ---------------------------------------------------------------------------

describe('a solo bundle', () => {
  it('renders exactly as it did before any of this — editor, no branches', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
    ]);

    renderReplay(bundle, index);

    // The ordinary replay editor, with content.
    const editor = await screen.findByTestId('monaco-editor');
    expect(editor.getAttribute('data-value')).toContain('ALICE_LINE');

    // No branch UI, no contributor switcher, no coverage panel.
    expect(screen.queryByTestId('replay-ambiguous')).toBeNull();
    expect(screen.queryByTestId('replay-branches')).toBeNull();
    expect(screen.queryByTestId('replay-contributor-switcher')).toBeNull();
    expect(screen.queryByTestId('replay-coverage-panel')).toBeNull();
  });

  /**
   * No scope at all is what a client talking to a server that predates the
   * contributor stamp gets. It must fail toward today's behaviour — the ordinary
   * editor — rather than toward a refusal to answer.
   */
  it('is unchanged when no scope is supplied at all — an older server', async () => {
    const { index } = await buildScope([{ who: { studentRef: 'alice' }, text: 'ALICE_LINE' }]);

    renderReplay(null, index);

    const editor = await screen.findByTestId('monaco-editor');
    expect(editor.getAttribute('data-value')).toContain('ALICE_LINE');
    expect(screen.queryByTestId('replay-contributor-switcher')).toBeNull();
    expect(screen.queryByTestId('replay-coverage-panel')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unattributed partners
// ---------------------------------------------------------------------------

describe('two unattributed sessions', () => {
  it('are not treated as two different contributors, so replay stays linear', async () => {
    const { bundle, index } = await buildScope([
      { who: 'anonymous', text: 'ONE' },
      { who: 'anonymous', text: 'TWO' },
    ]);

    renderReplay(bundle, index);

    // `compareContributors` answers 'unknown' for any pair involving an
    // unattributed session, so there is no PROVEN divergence to represent and
    // reconstruction takes the untouched linear path. Rendering these as two
    // branches would assert two people from the absence of identity.
    const editor = await screen.findByTestId('monaco-editor');
    expect(editor).toBeInTheDocument();
    expect(screen.queryByTestId('replay-branches')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Split lanes, wired into ReplayInner (design §7)
//
// Everything above this line was written before lanes existed and still holds
// with them ON by default, which is the point: lanes ADD a contributor to the
// view and never remove one, so the refusal, the branch labels and the
// no-interleaving guarantee are the same facts in a lane cell as they were
// full-pane.
// ---------------------------------------------------------------------------

describe('split lanes', () => {
  it('are on by default for a two-contributor bundle', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderReplay(bundle, index);

    expect(await screen.findByTestId('replay-lanes')).toBeInTheDocument();
    // The toggle is present and reads as on, so the default is legible and
    // reversible rather than a silent mode.
    const toggle = screen.getByTestId('split-lanes-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('data-lane-count')).toBe('2');
  });

  it('renders the concurrent refusal INSIDE a lane cell, not as the full pane', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderReplay(bundle, index);

    const pane = await screen.findByTestId('replay-ambiguous');
    const lane = pane.closest('[data-testid="replay-lane"]');
    expect(lane).not.toBeNull();
    // Both partners are in the same file, so §4 groups them into ONE cell
    // spanning both columns — not two cells each restating the refusal.
    expect(lane?.getAttribute('data-kind')).toBe('concurrent');
    expect(lane?.getAttribute('data-span')).toBe('2');
    expect(screen.getAllByTestId('replay-lane')).toHaveLength(1);

    // The refusal's own testids keep their meaning inside the cell.
    const names = screen.getAllByTestId('replay-branch-contributor').map((e) => e.textContent);
    expect(names.sort()).toEqual(['alice', 'bob']);
  });

  it('gives two partners in two different files two ordinary lanes', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE', file: 'alice.py' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE', file: 'bob.py' },
    ]);

    renderReplay(bundle, index);

    await screen.findByTestId('replay-lanes');
    const lanes = screen.getAllByTestId('replay-lane');
    expect(lanes).toHaveLength(2);
    expect(lanes.map((l) => l.getAttribute('data-kind'))).toEqual(['single', 'single']);
    // Each lane names its own file and mounts its own editor.
    expect(
      screen
        .getAllByTestId('replay-lane-file')
        .map((e) => e.textContent)
        .sort(),
    ).toEqual(['alice.py', 'bob.py']);
    expect(screen.getAllByTestId('monaco-editor')).toHaveLength(2);
  });

  it('puts contributor ribbons in the transport, one row per partner', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderReplay(bundle, index);

    const ribbons = await screen.findByTestId('contributor-ribbons');
    expect(ribbons.querySelectorAll('[data-testid^="ribbon-row-"]')).toHaveLength(2);
    // Ribbons live inside the transport, not somewhere of their own.
    expect(ribbons.closest('[data-testid="transport-bar"]')).not.toBeNull();
  });

  it('shows no ribbons when lanes are off', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderReplay(bundle, index, '&split=0');

    await screen.findByTestId('replay-ambiguous');
    expect(screen.queryByTestId('contributor-ribbons')).toBeNull();
  });

  /**
   * Design §7's hard requirement, on the surface it is easiest to break: with
   * `?split=0` the pane is the one this file's first three tests describe —
   * a full-pane refusal, the global file tabs, no grid.
   *
   * The toggle itself DOES stay visible here, and must: a two-contributor
   * submission that opted out is the only place a reader can opt back IN, and
   * `SplitLanesToggle` hides itself entirely for the solo case (covered below),
   * which is the case §7's "must not notice this feature exists" is about.
   */
  it('?split=0 restores today’s single-pane markup', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderReplay(bundle, index, '&split=0');

    const pane = await screen.findByTestId('replay-ambiguous');
    expect(pane.closest('[data-testid="replay-lane"]')).toBeNull();
    expect(screen.queryByTestId('replay-lanes')).toBeNull();
    // The global file tabs are back — in lane mode each lane names its own file.
    expect(screen.getByTestId('file-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('split-lanes-toggle').getAttribute('aria-checked')).toBe('false');
  });

  it('writes an EXPLICIT ?split=0 when a human turns lanes off', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderReplay(bundle, index);

    // Default-on, and the URL says nothing yet — a link shared before this
    // change inherits the new default rather than being rewritten by it.
    await screen.findByTestId('replay-lanes');
    expect(screen.getByTestId('location-probe').textContent ?? '').not.toContain('split=');

    fireEvent.click(screen.getByTestId('split-lanes-toggle'));

    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent ?? '').toContain('split=0');
    });
    expect(screen.queryByTestId('replay-lanes')).toBeNull();
  });

  it('writes an EXPLICIT ?split=1 when a human turns them back on', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE' },
    ]);

    renderReplay(bundle, index, '&split=0');

    const toggle = await screen.findByTestId('split-lanes-toggle');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent ?? '').toContain('split=1');
    });
    expect(screen.getByTestId('replay-lanes')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Manual-QA defect 1: the focus-away overlay must not wash the whole grid.
//
// It is driven by the playhead's own session, so it must be scoped to the
// lane whose contributor owns that session — the same `ownsCaret` gate
// `ReplayLanes` already computes for the caret and follow-cursor. A lane that
// does not own the playhead gets neither the wash nor the banner, and the
// banner must never sit over another lane's header (which is where it would
// obscure that lane's contributor name and tone badge — the manual-QA repro).
// ---------------------------------------------------------------------------

describe('focus-away overlay, scoped to the lane that owns the playhead (defect 1)', () => {
  it('paints the wash and banner only inside the owning lane, never over the other lane', async () => {
    // bob first (session index 0, earlier) so alice (session index 1) is
    // chronologically LAST — her focus-lost event becomes the bundle's final
    // event, so the default (last-index) playhead lands inside HER session.
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'bob' }, text: 'BOB_LINE', file: 'bob.py' },
      {
        who: { studentRef: 'alice' },
        text: 'ALICE_LINE',
        file: 'alice.py',
        focusAwayReason: 'window',
      },
    ]);

    renderReplay(bundle, index);

    await screen.findByTestId('replay-lanes');
    const lanes = screen.getAllByTestId('replay-lane');
    expect(lanes).toHaveLength(2);

    // Exactly one overlay on screen — not zero, and not one per lane.
    const overlay = await screen.findByTestId('focus-away-overlay');
    expect(screen.getAllByTestId('focus-away-overlay')).toHaveLength(1);

    // It lives inside a lane, not as a sibling of the whole grid.
    const owningLane = overlay.closest('[data-testid="replay-lane"]');
    expect(owningLane).not.toBeNull();

    // It belongs to ALICE's lane — the contributor who actually tabbed away
    // and whose session owns the playhead — not bob's.
    const owningFile = within(owningLane as HTMLElement).getByTestId('replay-lane-file');
    expect(owningFile.textContent).toBe('alice.py');

    // Bob's lane is untouched: no overlay inside it, and the overlay is
    // neither its sibling nor its ancestor.
    const bobLane = lanes.find((l) => l !== owningLane)!;
    expect(within(bobLane).queryByTestId('focus-away-overlay')).toBeNull();
    expect(bobLane.contains(overlay)).toBe(false);
    expect(overlay.contains(bobLane)).toBe(false);

    // Confined to the content pane, below the header and file strip — the
    // overlay must never be a descendant of the lane's own header.
    expect(overlay.closest('[data-testid="replay-lane-pane"]')).not.toBeNull();
    const header = owningLane!.querySelector('header');
    expect(header !== null && header.contains(overlay)).toBe(false);
    // And the contributor chip + tone badge in that header stay visible —
    // the overlay isn't drawn over them.
    const chip = within(header as HTMLElement).getByTestId(/replay-lane-chip-/);
    expect(chip).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Follow-up on defect 1: `currentFocusAwaySpan` itself scans the WHOLE bundle
// unfiltered, so before this fix ANY contributor's `focus.change` could set or
// clear the away state a lane shows. The defect-1 fix above only chose WHICH
// lane may show an overlay (the caret-owning one) — it did not stop that
// lane's overlay from being driven by a DIFFERENT contributor's evidence.
//
// This is worse than the original defect: an un-attributed whole-grid wash
// was vague and wrong, but an overlay drawn inside one NAMED contributor's
// lane, driven by someone else's `focus.change`, is a specific false
// accusation against a person the evidence never implicated — exactly the
// failure class this feature exists to prevent (see `ContributorSelect.tsx`'s
// header comment).
//
// The fix: `laneFocusAway` (`ReplayView.tsx`) filters `currentFocusAwaySpan`
// to the OWNING contributor's own session IDs. The single-pane path is
// deliberately untouched — see the comment at that render site.
// ---------------------------------------------------------------------------

describe("focus-away overlay must not leak across contributors' lanes", () => {
  it("shows bob's own lane the overlay at his own focus-lost event, but never leaks it into alice's lane once she owns the caret and never regains focus for him", async () => {
    // bob (session index 0, chronologically first) tabs away and never
    // regains focus. alice (session index 1, chronologically LAST) is still
    // actively editing — no focus events of her own at all — so the default
    // playhead (this bundle's very last event) lands inside HER session.
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'bob' },
        text: 'BOB_LINE',
        file: 'bob.py',
        focusAwayReason: 'window',
      },
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE', file: 'alice.py' },
    ]);

    const scope = reconstructionScopeFor(bundle, index);
    const firstSession = [...index.bySessionId.keys()][0]!;
    const bobFocusLostIdx = index.ordered.find((e) => e.kind === 'focus.change')!.globalIdx;
    const lastIdx = index.ordered.length - 1;

    function renderAt(eventIdx: number) {
      return render(
        <MemoryRouter initialEntries={[`/local/replay/${firstSession}?event=${eventIdx}`]}>
          <ReplayInner
            sessionId={firstSession}
            index={index}
            flags={[]}
            sourceFilename="test.zip"
            showHeader={false}
            scope={scope}
            contributors={bundle.contributors ?? null}
          />
        </MemoryRouter>,
      );
    }

    // 1. At bob's own focus-lost event, HE owns the caret and his OWN lane
    //    correctly shows the overlay — the correctly-attributed case, which
    //    must keep working.
    const first = renderAt(bobFocusLostIdx);
    await screen.findByTestId('replay-lanes');
    const overlayAtBob = await screen.findByTestId('focus-away-overlay');
    const bobLane = overlayAtBob.closest('[data-testid="replay-lane"]');
    expect(bobLane).not.toBeNull();
    expect(within(bobLane as HTMLElement).getByTestId('replay-lane-file').textContent).toBe(
      'bob.py',
    );
    first.unmount();

    // 2. Later, alice's own session owns the caret. Bob's away state was
    //    NEVER cleared (no regain event anywhere in the bundle), so an
    //    unfiltered scan would still report "away" — and, per the defect-1
    //    fix, would paint that inside ALICE's named lane. It must not: the
    //    evidence is bob's, not hers.
    renderAt(lastIdx);
    await screen.findByTestId('replay-lanes');
    expect(screen.queryByTestId('focus-away-overlay')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manual-QA defect 2: lane panes must follow the caret vertically only.
//
// A lane pane is a fraction of the single pane's width, so centering
// horizontally on the caret's column (`revealPositionInCenterIfOutsideViewport`)
// can scroll every line's start off-screen. Monaco isn't exercisable in
// jsdom, so what's tested is the WIRING: which reveal method gets called —
// `revealLineInCenterIfOutsideViewport` (line only, never a column) for a lane
// pane, `revealPositionInCenterIfOutsideViewport` (unchanged) for the single
// pane.
// ---------------------------------------------------------------------------

describe('follow-cursor reveal: lane vs. single pane (defect 2)', () => {
  it('a lane pane reveals the caret via the LINE-only method, never the column one', async () => {
    revealSpies.position.mockClear();
    revealSpies.line.mockClear();

    // Same shape as the defect-1 fixture: alice's session is chronologically
    // last, so the default playhead lands inside her session and only HER
    // lane owns the caret.
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'bob' }, text: 'BOB_LINE', file: 'bob.py' },
      {
        who: { studentRef: 'alice' },
        text: 'ALICE_LINE',
        file: 'alice.py',
        selectionAfter: { line: 0, character: 40 },
      },
    ]);

    renderReplay(bundle, index);
    await screen.findByTestId('replay-lanes');

    await waitFor(() => {
      expect(revealSpies.line).toHaveBeenCalled();
    });
    expect(revealSpies.position).not.toHaveBeenCalled();
    // Line-only: the first (and only) argument is a bare line number, never
    // a `{ lineNumber, column }` object.
    expect(revealSpies.line.mock.calls[0]![0]).toBe(1); // 0-based line 0 -> Monaco line 1
  });

  it('the single pane still reveals the caret via the column-aware method (unchanged)', async () => {
    revealSpies.position.mockClear();
    revealSpies.line.mockClear();

    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        text: 'ALICE_LINE',
        selectionAfter: { line: 0, character: 40 },
      },
    ]);

    renderReplay(bundle, index);
    await screen.findByTestId('monaco-editor');

    await waitFor(() => {
      expect(revealSpies.position).toHaveBeenCalled();
    });
    expect(revealSpies.line).not.toHaveBeenCalled();
    expect(revealSpies.position.mock.calls[0]![0]).toEqual({ lineNumber: 1, column: 41 });
  });
});

// ---------------------------------------------------------------------------
// The solo gate, again — this time against an explicit opt-IN
// ---------------------------------------------------------------------------

describe('a solo bundle asked for lanes explicitly', () => {
  /**
   * `?split=1` is a URL anyone can type or copy from a group submission. A solo
   * submission has nothing to split into lanes, so it must render exactly as it
   * always has — and, per §7, must not be able to tell this feature exists at
   * all: no grid, no ribbons, and no toggle offering something meaningless.
   */
  it('still renders no lanes, no ribbons and no toggle', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE' },
    ]);

    renderReplay(bundle, index, '&split=1');

    const editor = await screen.findByTestId('monaco-editor');
    expect(editor.getAttribute('data-value')).toContain('ALICE_LINE');
    expect(screen.queryByTestId('replay-lanes')).toBeNull();
    expect(screen.queryByTestId('contributor-ribbons')).toBeNull();
    expect(screen.queryByTestId('split-lanes-toggle')).toBeNull();
    expect(screen.getByTestId('file-tabs')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The split default must track the bundle ACTUALLY ON SCREEN
//
// `/local` renders `ReplayInner` with `selectedBundle?.contributors`, and the
// bundle selector can change that prop on an already-mounted view. A default
// captured once at mount would then describe a bundle the reader has left —
// switch from a solo submission to a two-contributor one and lanes would stay
// off with nothing on screen explaining why.
//
// Both tests below RERENDER the same mounted component rather than mounting
// twice. That distinction is the whole point: two separate mounts pass whether
// the default is derived per render or captured once, and so would prove
// nothing.
// ---------------------------------------------------------------------------

describe('the split default, when the contributors prop changes under a mounted view', () => {
  /** The `/local` element tree, parameterised by which bundle is selected. */
  function localView(selected: { bundle: Bundle; index: EventIndex }) {
    const firstSession = [...selected.index.bySessionId.keys()][0]!;
    const lastIdx = selected.index.ordered.length - 1;
    return (
      <MemoryRouter initialEntries={[`/local/replay/${firstSession}?event=${lastIdx}`]}>
        <ReplayInner
          sessionId={firstSession}
          index={selected.index}
          flags={[]}
          sourceFilename="test.zip"
          showHeader={false}
          scope={reconstructionScopeFor(selected.bundle, selected.index)}
          contributors={selected.bundle.contributors ?? null}
        />
      </MemoryRouter>
    );
  }

  it('turns lanes ON when a solo bundle is swapped for a two-contributor one', async () => {
    const solo = await buildScope([{ who: { studentRef: 'alice' }, text: 'ALICE_LINE' }]);
    const group = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE', file: 'alice.py' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE', file: 'bob.py' },
    ]);

    const { rerender } = render(localView(solo));

    await screen.findByTestId('monaco-editor');
    expect(screen.queryByTestId('replay-lanes')).toBeNull();
    expect(screen.queryByTestId('split-lanes-toggle')).toBeNull();

    rerender(localView(group));

    await waitFor(() => {
      expect(screen.getByTestId('replay-lanes')).toBeInTheDocument();
    });
    expect(screen.getByTestId('split-lanes-toggle').getAttribute('aria-checked')).toBe('true');
  });

  it('turns lanes OFF again when the view goes back to a solo bundle', async () => {
    const solo = await buildScope([{ who: { studentRef: 'alice' }, text: 'ALICE_LINE' }]);
    const group = await buildScope([
      { who: { studentRef: 'alice' }, text: 'ALICE_LINE', file: 'alice.py' },
      { who: { studentRef: 'bob' }, text: 'BOB_LINE', file: 'bob.py' },
    ]);

    const { rerender } = render(localView(group));
    await screen.findByTestId('replay-lanes');

    rerender(localView(solo));

    await waitFor(() => {
      expect(screen.queryByTestId('replay-lanes')).toBeNull();
    });
    expect(screen.queryByTestId('split-lanes-toggle')).toBeNull();
    expect(screen.getByTestId('file-tabs')).toBeInTheDocument();
  });
});
