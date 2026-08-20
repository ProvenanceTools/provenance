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
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
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

function typed(text: string) {
  return {
    kind: 'doc.change',
    data: {
      path: FILE,
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
 */
async function buildScope(
  specs: Array<{ who: { studentRef: string } | 'anonymous'; text: string }>,
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const k = await keys();
  const sessions = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const sk = await seededKeypair(0xa0 + i);
    sessions.push({
      events: [typed(spec.text)],
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

function renderReplay(bundle: Bundle | null, index: EventIndex) {
  const firstSession = [...index.bySessionId.keys()][0]!;
  const lastIdx = index.ordered.length - 1;
  return render(
    <MemoryRouter initialEntries={[`/local/replay/${firstSession}?event=${lastIdx}`]}>
      <ReplayInner
        sessionId={firstSession}
        index={index}
        flags={[]}
        sourceFilename="test.zip"
        showHeader={false}
        bundle={bundle}
      />
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

  it('is unchanged when no bundle is supplied at all — the server-backed tab', async () => {
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
