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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
// ---------------------------------------------------------------------------

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
      revealPositionInCenterIfOutsideViewport: () => {},
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
 */
async function buildScope(
  specs: Array<{ who: { studentRef: string } | 'anonymous'; text: string; file?: string }>,
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const k = await keys();
  const sessions = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const sk = await seededKeypair(0xa0 + i);
    sessions.push({
      events: [typed(spec.text, spec.file ?? FILE)],
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
