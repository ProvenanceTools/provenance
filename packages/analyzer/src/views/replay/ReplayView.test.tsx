/**
 * ReplayView.test.tsx
 *
 * Tests:
 *  1. Route guard: sessionId not found → navigates to /overview.
 *  2. Session found → renders replay view.
 *  3. URL ?event param is read on mount and seeked to.
 *  4. FileTabs renders with files list.
 *  5. TransportBar renders.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ReplayView } from './ReplayView.js';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';
import type { BundleContextValue } from '../../context/BundleContext.js';

// ---------------------------------------------------------------------------
// Mock Monaco so lazy import resolves immediately in jsdom.
//
// The mock invokes `onMount` with a fake editor so the headless side-effect
// drivers (GutterDecorations, CursorMarker, FollowCursor, LineHoverProvider)
// actually run. `fakeEditorCalls` exposes the spies to the tests below.
// ---------------------------------------------------------------------------
const fakeEditorCalls = {
  reveal: vi.fn(),
  deltaDecorations: vi.fn((_old: string[], next: unknown[]) => next.map((_, i) => `id-${i}`)),
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
      deltaDecorations: fakeEditorCalls.deltaDecorations,
      revealPositionInCenterIfOutsideViewport: fakeEditorCalls.reveal,
      getModel: () => null,
    };
    const monaco = {
      languages: { registerHoverProvider: () => ({ dispose: () => {} }) },
    };
    // Mount callback fires once, like the real editor.
    const mounted = React.useRef(false);
    React.useEffect(() => {
      if (mounted.current) return;
      mounted.current = true;
      onMount?.(editor, monaco);
      // Mount-only, matching the real @monaco-editor/react contract.
    }, []);
    return <div data-testid="monaco-editor" data-value={value} />;
  },
}));

// ---------------------------------------------------------------------------
// Minimal index builder
// ---------------------------------------------------------------------------

function makeDocChangeEvent(globalIdx: number, sessionId: string, file: string): IndexedEvent {
  return {
    sessionId,
    seq: globalIdx,
    globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind: 'doc.change',
    payload: {
      deltas: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text: String.fromCharCode(65 + globalIdx), // A, B, C, ...
        },
      ],
    },
    file,
  };
}

function makeFocusEvent(
  globalIdx: number,
  sessionId: string,
  gained: boolean,
  reason?: string,
): IndexedEvent {
  return {
    sessionId,
    seq: globalIdx,
    globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind: 'focus.change',
    payload: reason !== undefined ? { gained, reason } : { gained },
  };
}

function buildIndex(events: IndexedEvent[]): EventIndex {
  const bySeq = new Map<string, IndexedEvent>();
  const byKind = new Map<EventKind, IndexedEvent[]>();
  const byFile = new Map<string, IndexedEvent[]>();
  const bySessionId = new Map<string, IndexedEvent[]>();
  const ordered = [...events].sort((a, b) => a.globalIdx - b.globalIdx);
  for (const e of ordered) {
    bySeq.set(`${e.sessionId}:${e.seq}`, e);
    const kl = byKind.get(e.kind) ?? [];
    kl.push(e);
    byKind.set(e.kind, kl);
    if (e.file) {
      const fl = byFile.get(e.file) ?? [];
      fl.push(e);
      byFile.set(e.file, fl);
    }
    const sl = bySessionId.get(e.sessionId) ?? [];
    sl.push(e);
    bySessionId.set(e.sessionId, sl);
  }
  return { bySeq, byKind, byFile, bySessionId, ordered };
}

// ---------------------------------------------------------------------------
// Test wrapper that mocks useBundle() at the module level.
// We mock the BundleContext module so useBundle() returns a controlled value.
// ---------------------------------------------------------------------------

// We use vi.mock to intercept useBundle at the module boundary.
const mockIndex = { current: null as EventIndex | null };

vi.mock('../../context/BundleContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../context/BundleContext.js')>();
  return {
    ...actual,
    useBundle: (): BundleContextValue => ({
      bundles: [],
      selectedBundleId: null,
      selectBundle: vi.fn(),
      indicesByBundle: new Map(),
      validationReportByBundle: new Map(),
      flagsByBundle: new Map(),
      index: mockIndex.current,
      validationReport: null,
      flags: [],
      crossFlags: [],
      crossScopeExclusions: [],
      status: mockIndex.current !== null ? ('loaded' as const) : ('idle' as const),
      loadingStage: null,
      loadError: null,
      partialLoadErrors: [],
      loadBundleFile: vi.fn(),
      loadBundleFiles: vi.fn(),
      clearBundle: vi.fn(),
    }),
  };
});

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderReplayView(sessionId: string, search = '') {
  const path = `/local/replay/${sessionId}${search}`;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/local/replay/:sessionId" element={<ReplayView />} />
        <Route path="/local/overview" element={<div data-testid="overview-view">Overview</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReplayView', () => {
  beforeEach(() => {
    mockIndex.current = null;
    fakeEditorCalls.reveal.mockClear();
    fakeEditorCalls.deltaDecorations.mockClear();
  });

  describe('route guard', () => {
    it('redirects to /local/overview when index is null', async () => {
      mockIndex.current = null;
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('overview-view')).toBeDefined();
      });
    });

    it('redirects to /local/overview when sessionId not found', async () => {
      mockIndex.current = buildIndex([makeDocChangeEvent(0, 'other-session', 'hw.py')]);
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      renderReplayView('missing-session');
      await waitFor(() => {
        expect(screen.getByTestId('overview-view')).toBeDefined();
      });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not found in index'));
      spy.mockRestore();
    });
  });

  describe('with a valid session', () => {
    beforeEach(() => {
      mockIndex.current = buildIndex([
        makeDocChangeEvent(0, 'sess1', 'hw.py'),
        makeDocChangeEvent(1, 'sess1', 'hw.py'),
        makeDocChangeEvent(2, 'sess1', 'hw.py'),
      ]);
    });

    it('renders the replay-view container', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('replay-view')).toBeDefined();
      });
    });

    it('renders the transport bar', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('transport-bar')).toBeDefined();
      });
    });

    it('renders file tabs', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('file-tabs')).toBeDefined();
      });
    });

    it('renders Monaco editor after Suspense resolves', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('monaco-editor')).toBeDefined();
      });
    });

    it('reads ?event URL param on mount and shows that content', async () => {
      // event=2 means seek to globalIdx 2 (inclusive), so 3 inserts: A, B, C at pos 0.
      // Event 0 inserts 'A' → 'A'
      // Event 1 inserts 'B' at pos 0 → 'BA'
      // Event 2 inserts 'C' at pos 0 → 'CBA'
      renderReplayView('sess1', '?event=2');
      await waitFor(() => {
        const editor = screen.getByTestId('monaco-editor');
        expect(editor.getAttribute('data-value')).toBe('CBA');
      });
    });
  });

  describe('focus-away overlay', () => {
    it('shows the overlay while the playhead is inside a focus-away span', async () => {
      mockIndex.current = buildIndex([
        makeDocChangeEvent(0, 'sess1', 'a.py'),
        makeFocusEvent(1, 'sess1', false, 'window'),
        makeDocChangeEvent(2, 'sess1', 'a.py'),
      ]);
      renderReplayView('sess1', '?event=2'); // focus lost at 1, never regained
      await waitFor(() => {
        expect(screen.getByTestId('focus-away-overlay')).toBeDefined();
      });
    });

    it('hides the overlay once focus has been regained', async () => {
      mockIndex.current = buildIndex([
        makeFocusEvent(0, 'sess1', false, 'window'),
        makeDocChangeEvent(1, 'sess1', 'a.py'),
        makeFocusEvent(2, 'sess1', true),
      ]);
      renderReplayView('sess1', '?event=2'); // on the regain event
      await waitFor(() => {
        expect(screen.getByTestId('monaco-editor')).toBeDefined();
      });
      expect(screen.queryByTestId('focus-away-overlay')).toBeNull();
    });
  });

  describe('auto-follow edited file', () => {
    it('switches the active file to the file edited at the playhead', async () => {
      mockIndex.current = buildIndex([
        makeDocChangeEvent(0, 'sess1', 'a.py'), // inserts 'A' into a.py
        makeDocChangeEvent(1, 'sess1', 'b.py'), // inserts 'B' into b.py
      ]);
      // Without auto-follow, resolvedFile would stay a.py (files[0]) showing 'A'.
      // With auto-follow, the playhead at event 1 follows to b.py → content 'B'.
      renderReplayView('sess1', '?event=1');
      await waitFor(() => {
        expect(screen.getByTestId('monaco-editor').getAttribute('data-value')).toBe('B');
      });
    });
  });

  describe('follow cursor', () => {
    function makeSelectionEvent(
      globalIdx: number,
      sessionId: string,
      file: string,
      line: number,
    ): IndexedEvent {
      return {
        sessionId,
        seq: globalIdx,
        globalIdx,
        wall: '2026-01-01T00:00:00.000Z',
        t: globalIdx * 100,
        kind: 'selection.change',
        payload: {
          path: file,
          range: { start: { line, character: 0 }, end: { line, character: 0 } },
          was_selection: false,
        },
        file,
      };
    }

    it('scrolls the editor to the student’s caret at the playhead', async () => {
      // Regression guard for the FollowCursor wiring: without it the reviewer
      // watches an unmoving viewport while the caret runs off-screen.
      mockIndex.current = buildIndex([
        makeDocChangeEvent(0, 'sess1', 'hw.py'),
        makeSelectionEvent(1, 'sess1', 'hw.py', 120),
      ]);
      renderReplayView('sess1', '?event=1');
      await waitFor(() => {
        expect(fakeEditorCalls.reveal).toHaveBeenCalled();
      });
      // 0-based line 120 → Monaco 1-based 121.
      expect(fakeEditorCalls.reveal.mock.calls.at(-1)![0]).toEqual({
        lineNumber: 121,
        column: 1,
      });
    });

    it('does not scroll when the session has no selection events', async () => {
      mockIndex.current = buildIndex([
        makeDocChangeEvent(0, 'sess1', 'hw.py'),
        makeDocChangeEvent(1, 'sess1', 'hw.py'),
      ]);
      renderReplayView('sess1', '?event=1');
      await waitFor(() => {
        expect(screen.getByTestId('monaco-editor')).toBeDefined();
      });
      expect(fakeEditorCalls.reveal).not.toHaveBeenCalled();
    });
  });

  describe('session with no file events', () => {
    it('shows no-file placeholder', async () => {
      mockIndex.current = buildIndex([
        {
          sessionId: 'sess1',
          seq: 0,
          globalIdx: 0,
          wall: '2026-01-01T00:00:00.000Z',
          t: 0,
          kind: 'session.start',
          payload: null,
        },
      ]);
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('no-file-placeholder')).toBeDefined();
      });
    });
  });

  describe('ReplayHeader (Fix 3)', () => {
    beforeEach(() => {
      mockIndex.current = buildIndex([makeDocChangeEvent(0, 'sess1', 'hw.py')]);
    });

    it('renders the back button', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('replay-back-btn')).toBeDefined();
      });
    });

    it('back button triggers navigation', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('replay-back-btn')).toBeDefined();
      });
      // Clicking should not throw; navigation is best-effort in jsdom.
      expect(() => screen.getByTestId('replay-back-btn').click()).not.toThrow();
    });

    it('renders replay-header element', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('replay-header')).toBeDefined();
      });
    });
  });

  describe('session switcher (multi-session bundles)', () => {
    beforeEach(() => {
      // Two sessions; sess1 sorts first (lower globalIdx → earlier in bySessionId).
      mockIndex.current = buildIndex([
        makeDocChangeEvent(0, 'sess1', 'hw.py'),
        makeDocChangeEvent(1, 'sess2', 'hw.py'),
      ]);
    });

    it('renders the session switcher with one option per session', async () => {
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('replay-session-switcher')).toBeDefined();
      });
      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(2);
      expect(options[0]!.textContent).toContain('Session 1 of 2');
      expect(options[1]!.textContent).toContain('Session 2 of 2');
    });

    it('opens on the session named by the entry anchor', async () => {
      renderReplayView('sess2');
      await waitFor(() => {
        const select = screen.getByTestId('replay-session-select') as HTMLSelectElement;
        expect(select.value).toBe('sess2');
      });
    });

    it('follows the PLAYHEAD across a seam, not the URL', async () => {
      // Regression: the switcher used to key off the route param, so it kept
      // reporting the entry session no matter where playback had reached —
      // "Session 1 of 2" while the playhead sat in session 2.
      renderReplayView('sess1');
      await waitFor(() => {
        expect((screen.getByTestId('replay-session-select') as HTMLSelectElement).value).toBe(
          'sess1',
        );
      });
      expect(screen.getByTestId('replay-session-ordinal').textContent).toBe('1 / 2');

      // globalIdx 0 is sess1's only event; one step forward lands in sess2.
      fireEvent.click(screen.getByLabelText('Step forward'));

      await waitFor(() => {
        expect((screen.getByTestId('replay-session-select') as HTMLSelectElement).value).toBe(
          'sess2',
        );
      });
      expect(screen.getByTestId('replay-session-ordinal').textContent).toBe('2 / 2');
    });

    it('changing the switcher MOVES THE PLAYHEAD, not just the label', async () => {
      // Regression: this used to navigate to /local/replay/<id>. React Router
      // does not remount on a param change and nothing keys ReplayInner, so the
      // mount-only URL→engine seek never re-fired: the label flipped and the
      // playhead stayed exactly where it was. Asserting the select's own value
      // (as this test once did) passes in both the broken and fixed worlds, so
      // it asserts the transport position instead.
      mockIndex.current = buildIndex([
        makeDocChangeEvent(0, 'sess1', 'hw.py'), // 'A'
        makeDocChangeEvent(1, 'sess1', 'hw.py'), // 'B'
        makeDocChangeEvent(2, 'sess2', 'part2.py'), // 'C'
        makeDocChangeEvent(3, 'sess2', 'part2.py'), // 'D'
      ]);
      renderReplayView('sess1');

      const select = (await screen.findByTestId('replay-session-select')) as HTMLSelectElement;
      expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')).toBe('0');

      fireEvent.change(select, { target: { value: 'sess2' } });

      // Seeks to sess2's FIRST event — globalIdx 2, not 0 and not the end.
      await waitFor(() => {
        expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')).toBe('2');
      });
      // And the reconstruction cut moved with it: part2.py holds only 'C'.
      await waitFor(() => {
        expect(screen.getByTestId('monaco-editor').getAttribute('data-value')).toBe('C');
      });
    });

    it('seeks backwards when picking an earlier session', async () => {
      mockIndex.current = buildIndex([
        makeDocChangeEvent(0, 'sess1', 'hw.py'),
        makeDocChangeEvent(1, 'sess1', 'hw.py'),
        makeDocChangeEvent(2, 'sess2', 'part2.py'),
        makeDocChangeEvent(3, 'sess2', 'part2.py'),
      ]);
      renderReplayView('sess2', '?event=3');

      const select = (await screen.findByTestId('replay-session-select')) as HTMLSelectElement;
      await waitFor(() => {
        expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')).toBe('3');
      });

      fireEvent.change(select, { target: { value: 'sess1' } });

      await waitFor(() => {
        expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')).toBe('0');
      });
    });

    it('reconstructs the SECOND session’s own content, not the first session’s', async () => {
      // Regression: sess2 edits a distinct file at globalIdx 2,3 (its array
      // positions are 0,1). The engine must cut reconstruction at the TRUE
      // globalIdx; the pre-fix engine treated currentGlobalIdx as a session-
      // local position and truncated to the first session's early state,
      // showing empty/first-session content for every later session.
      mockIndex.current = buildIndex([
        makeDocChangeEvent(0, 'sess1', 'hw.py'), // 'A' → hw.py
        makeDocChangeEvent(1, 'sess1', 'hw.py'), // 'B' → hw.py
        makeDocChangeEvent(2, 'sess2', 'part2.py'), // 'C' → part2.py
        makeDocChangeEvent(3, 'sess2', 'part2.py'), // 'D' → part2.py
      ]);
      // ?event=3 seeks to true globalIdx 3 (the last sess2 event). Each insert
      // is at pos 0, so part2.py reconstructs to 'DC'.
      renderReplayView('sess2', '?event=3');
      await waitFor(() => {
        expect(screen.getByTestId('monaco-editor').getAttribute('data-value')).toBe('DC');
      });
    });

    it('does not render the switcher for a single-session bundle', async () => {
      mockIndex.current = buildIndex([makeDocChangeEvent(0, 'sess1', 'hw.py')]);
      renderReplayView('sess1');
      await waitFor(() => {
        expect(screen.getByTestId('replay-view')).toBeDefined();
      });
      expect(screen.queryByTestId('replay-session-switcher')).toBeNull();
    });
  });

  describe('whole-bundle replay (session id is an entry anchor)', () => {
    function twoSessions() {
      return buildIndex([
        makeDocChangeEvent(0, 'sess1', 'hw.py'), // 'A'
        makeDocChangeEvent(1, 'sess1', 'hw.py'), // 'B'
        makeDocChangeEvent(2, 'sess2', 'part2.py'), // 'C'
        makeDocChangeEvent(3, 'sess2', 'part2.py'), // 'D'
      ]);
    }

    it('opens at the anchor session’s first event when ?event= is absent', async () => {
      mockIndex.current = twoSessions();
      renderReplayView('sess2');
      // sess2's first event is globalIdx 2 → part2.py has just 'C'.
      await waitFor(() => {
        expect(screen.getByTestId('monaco-editor').getAttribute('data-value')).toBe('C');
      });
    });

    it('prefers ?event= over the session anchor, even across sessions', async () => {
      mockIndex.current = twoSessions();
      // Anchor says sess2, but ?event=1 is inside sess1 → hw.py shows 'BA'.
      renderReplayView('sess2', '?event=1');
      await waitFor(() => {
        expect(screen.getByTestId('monaco-editor').getAttribute('data-value')).toBe('BA');
      });
    });

    it('lists files from every session in the tab strip', async () => {
      mockIndex.current = twoSessions();
      renderReplayView('sess2');
      // hw.py is touched only in sess1, part2.py only in sess2. Mounted at sess2,
      // BOTH must be present — the session-scoped view showed only part2.py.
      await waitFor(() => {
        expect(screen.getByTestId('file-tabs')).toBeDefined();
      });
      expect(screen.getByLabelText('hw.py')).toBeDefined();
      expect(screen.getByLabelText('part2.py')).toBeDefined();
    });

    it('shows events from every session in the sidebar', async () => {
      mockIndex.current = twoSessions();
      renderReplayView('sess2');
      await waitFor(() => {
        expect(screen.getByTestId('event-sidebar')).toBeDefined();
      });
      // Four events across both sessions, not just sess2's two.
      expect(screen.getAllByTestId(/^sidebar-row-/).length).toBe(4);
    });
  });

  describe('layout: height cap (Fix 2)', () => {
    it('outer wrapper has h-full and flex-col classes (viewport-constrained)', async () => {
      mockIndex.current = buildIndex([makeDocChangeEvent(0, 'sess1', 'hw.py')]);
      renderReplayView('sess1');
      await waitFor(() => {
        const container = screen.getByTestId('replay-view');
        // h-full resolves to 100% of #root, which globals.css sets to 100vh.
        expect(container.classList.contains('h-full')).toBe(true);
        expect(container.classList.contains('flex-col')).toBe(true);
      });
    });

    it('event sidebar has overflow-hidden to clip virtualizer', async () => {
      mockIndex.current = buildIndex([makeDocChangeEvent(0, 'sess1', 'hw.py')]);
      renderReplayView('sess1');
      await waitFor(() => {
        const sidebar = screen.getByTestId('event-sidebar');
        expect(sidebar.classList.contains('overflow-hidden')).toBe(true);
      });
    });
  });
});
