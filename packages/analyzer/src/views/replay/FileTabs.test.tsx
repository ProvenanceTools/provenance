/**
 * Tests for FileTabs' whole-bundle behavior.
 *
 * The tab strip lists every file in the submission, so it must distinguish
 * "being edited right now" from "last touched two sessions ago" — otherwise a
 * stale tab looks like active work.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileTabs } from './FileTabs.js';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';

function ev(globalIdx: number, sessionId: string, file: string, wall: string): IndexedEvent {
  return {
    globalIdx,
    sessionId,
    seq: globalIdx,
    wall,
    t: globalIdx * 100,
    kind: 'doc.change',
    payload: null,
    file,
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
    byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
    if (e.file) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    bySessionId.set(e.sessionId, [...(bySessionId.get(e.sessionId) ?? []), e]);
  }
  return { bySeq, byKind, byFile, bySessionId, ordered };
}

// hw1.py lives in sess-a only; hw2.py in sess-b only.
const INDEX = buildIndex([
  ev(0, 'sess-a', 'hw1.py', '2026-01-01T00:00:00.000Z'),
  ev(1, 'sess-b', 'hw2.py', '2026-01-02T00:00:00.000Z'),
  ev(2, 'sess-b', 'hw2.py', '2026-01-02T00:02:00.000Z'),
]);

const FILES = ['hw1.py', 'hw2.py'];

// test-setup.ts reports EVERY element as 800px wide, which makes each measured
// tab as wide as the whole row. Give the off-screen measuring spans (the ones
// carrying data-path) a realistic tab width; the row keeps its 800px, or
// whatever a test sets via ROW_WIDTH.
const TAB_WIDTH = 80;
let ROW_WIDTH = 800;
let restore: (() => void) | null = null;
beforeEach(() => {
  ROW_WIDTH = 800;
  const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
  const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset['path'] !== undefined ? TAB_WIDTH : 800;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return ROW_WIDTH;
    },
  });
  restore = () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offset);
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', client);
  };
});
afterEach(() => restore?.());

function renderTabs(currentGlobalIdx: number, currentSessionId: string, activeFile = 'hw2.py') {
  const onFileChange = vi.fn();
  render(
    <FileTabs
      files={FILES}
      activeFile={activeFile}
      onFileChange={onFileChange}
      index={INDEX}
      currentGlobalIdx={currentGlobalIdx}
      currentSessionId={currentSessionId}
    />,
  );
  return { onFileChange };
}

describe('FileTabs', () => {
  it('renders a tab for a file touched only in an earlier session', () => {
    renderTabs(2, 'sess-b');
    // hw1.py has no events in sess-b at all, but must still be listed.
    expect(screen.getByTestId('file-tab-hw1.py')).toBeInTheDocument();
    expect(screen.getByTestId('file-tab-hw2.py')).toBeInTheDocument();
  });

  it('dims a file with no event in the current session', () => {
    renderTabs(2, 'sess-b');
    expect(screen.getByTestId('file-tab-hw1.py')).toHaveAttribute('data-stale', 'true');
    expect(screen.getByTestId('file-tab-hw2.py')).not.toHaveAttribute('data-stale');
  });

  it('shows a session-distance badge for an earlier-session file', () => {
    renderTabs(2, 'sess-b');
    expect(screen.getByTestId('file-tab-recency-hw1.py')).toHaveTextContent('1 session ago');
  });

  it('shows an elapsed-time badge for a current-session file', () => {
    // Playhead at 2 (00:02:00); hw2.py was also edited at 1 (00:00:00) — but the
    // last edit at or before the playhead IS event 2, so "now".
    renderTabs(2, 'sess-b');
    expect(screen.getByTestId('file-tab-recency-hw2.py')).toHaveTextContent('now');
  });

  it('reports elapsed time when the current-session file was edited earlier', () => {
    // Playhead at 2, but ask about hw2.py's state from the playhead at 1's view.
    render(
      <FileTabs
        files={FILES}
        activeFile="hw2.py"
        onFileChange={vi.fn()}
        index={buildIndex([
          ev(0, 'sess-b', 'hw2.py', '2026-01-02T00:00:00.000Z'),
          ev(1, 'sess-b', 'other.py', '2026-01-02T00:02:00.000Z'),
        ])}
        currentGlobalIdx={1}
        currentSessionId="sess-b"
      />,
    );
    expect(screen.getByTestId('file-tab-recency-hw2.py')).toHaveTextContent('2m ago');
  });

  it('omits the badge for a file untouched at this playhead', () => {
    // Playhead at 0 (sess-a); hw2.py's first event is at globalIdx 1.
    renderTabs(0, 'sess-a', 'hw1.py');
    expect(screen.queryByTestId('file-tab-recency-hw2.py')).toBeNull();
    expect(screen.getByTestId('file-tab-hw2.py')).toHaveAttribute('data-stale', 'true');
  });

  it('renders plain tabs without recency when no index is supplied', () => {
    render(<FileTabs files={FILES} activeFile="hw1.py" onFileChange={vi.fn()} />);
    expect(screen.getByTestId('file-tab-hw1.py')).toBeInTheDocument();
    expect(screen.queryByTestId('file-tab-recency-hw1.py')).toBeNull();
  });

  it('shows the empty state when there are no files', () => {
    render(<FileTabs files={[]} activeFile={null} onFileChange={vi.fn()} />);
    expect(screen.getByTestId('file-tabs-empty')).toBeInTheDocument();
  });

  describe('overflow', () => {
    // 12 files × (80 + 4 gap) = 1008px; a 400px row fits the most relevant few.
    const MANY = Array.from({ length: 12 }, (_, i) => `src/f${String(i).padStart(2, '0')}.c`);
    const MANY_INDEX = buildIndex([
      ev(0, 'sess-a', 'src/f00.c', '2026-01-01T00:00:00.000Z'),
      ev(1, 'sess-b', 'src/f07.c', '2026-01-02T00:00:00.000Z'),
      ev(2, 'sess-b', 'src/f09.c', '2026-01-02T00:01:00.000Z'),
    ]);

    function renderMany(activeFile: string) {
      ROW_WIDTH = 400;
      const onFileChange = vi.fn();
      render(
        <FileTabs
          files={MANY}
          activeFile={activeFile}
          onFileChange={onFileChange}
          index={MANY_INDEX}
          currentGlobalIdx={2}
          currentSessionId="sess-b"
        />,
      );
      return { onFileChange };
    }

    it('keeps one row: shows what fits and counts the rest in a "+N files" button', () => {
      renderMany('src/f11.c');
      // budget 400 - 104 = 296 → three 84px tabs.
      const shown = MANY.filter((f) => screen.queryByTestId(`file-tab-${f}`) !== null);
      expect(shown).toHaveLength(3);
      expect(screen.getByTestId('file-tabs-more')).toHaveTextContent('+9 files');
    });

    it('prioritises the active file, then files edited this session', () => {
      renderMany('src/f11.c');
      expect(screen.getByTestId('file-tab-src/f11.c')).toBeInTheDocument(); // active
      expect(screen.getByTestId('file-tab-src/f09.c')).toBeInTheDocument(); // edited now
      expect(screen.getByTestId('file-tab-src/f07.c')).toBeInTheDocument(); // edited this session
      expect(screen.queryByTestId('file-tab-src/f00.c')).toBeNull(); // earlier session
    });

    it('shows visible tabs in bundle order, not relevance order', () => {
      renderMany('src/f11.c');
      const order = screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'));
      expect(order).toEqual(['src/f07.c', 'src/f09.c', 'src/f11.c']);
    });

    it('picks a file from the overflow menu', () => {
      const { onFileChange } = renderMany('src/f11.c');
      // Radix opens on keyboard in jsdom (pointer events need real layout).
      fireEvent.keyDown(screen.getByTestId('file-tabs-more'), { key: 'Enter' });
      fireEvent.click(screen.getByTestId('file-menu-item-src/f00.c'));
      expect(onFileChange).toHaveBeenCalledWith('src/f00.c');
    });

    it('shows every tab and no overflow button when they all fit', () => {
      ROW_WIDTH = 2000;
      render(<FileTabs files={MANY} activeFile="src/f00.c" onFileChange={vi.fn()} />);
      expect(screen.getAllByRole('tab')).toHaveLength(12);
      expect(screen.queryByTestId('file-tabs-more')).toBeNull();
    });
  });
});
