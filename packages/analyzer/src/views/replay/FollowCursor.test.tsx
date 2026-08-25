/**
 * FollowCursor.test.tsx — verifies the headless component keeps the student's
 * caret in view by driving editor.revealPositionInCenterIfOutsideViewport.
 *
 * The component returns null, so we assert via a fake editor whose reveal
 * method is a spy (real Monaco isn't available in jsdom), mirroring
 * CursorMarker.test.tsx.
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { FollowCursor } from './FollowCursor.js';
import type { ReplaySelection } from './cursor-position.js';
import type { editor as MonacoEditorNS } from 'monaco-editor';

function fakeEditor() {
  const revealPositionInCenterIfOutsideViewport = vi.fn();
  const revealLineInCenterIfOutsideViewport = vi.fn();
  return {
    revealPositionInCenterIfOutsideViewport,
    revealLineInCenterIfOutsideViewport,
  } as unknown as MonacoEditorNS.IStandaloneCodeEditor & {
    revealPositionInCenterIfOutsideViewport: ReturnType<typeof vi.fn>;
    revealLineInCenterIfOutsideViewport: ReturnType<typeof vi.fn>;
  };
}

const sel = (range: ReplaySelection['range'], wasSelection: boolean): ReplaySelection => ({
  range,
  wasSelection,
});

const cursorAt = (line: number, character: number) =>
  sel({ start: { line, character }, end: { line, character } }, false);

describe('FollowCursor', () => {
  it('reveals the caret position on mount', () => {
    const ed = fakeEditor();
    render(<FollowCursor editor={ed} selection={cursorAt(9, 2)} content="x" />);
    expect(ed.revealPositionInCenterIfOutsideViewport).toHaveBeenCalledTimes(1);
    // 0-based (9,2) → Monaco 1-based (10,3)
    expect(ed.revealPositionInCenterIfOutsideViewport.mock.calls[0]![0]).toEqual({
      lineNumber: 10,
      column: 3,
    });
  });

  it('reveals the END of a selection, matching the painted caret', () => {
    const ed = fakeEditor();
    render(
      <FollowCursor
        editor={ed}
        selection={sel({ start: { line: 1, character: 0 }, end: { line: 40, character: 5 } }, true)}
        content="x"
      />,
    );
    expect(ed.revealPositionInCenterIfOutsideViewport.mock.calls[0]![0]).toEqual({
      lineNumber: 41,
      column: 6,
    });
  });

  it('re-reveals when the selection moves', () => {
    const ed = fakeEditor();
    const { rerender } = render(
      <FollowCursor editor={ed} selection={cursorAt(0, 0)} content="x" />,
    );
    rerender(<FollowCursor editor={ed} selection={cursorAt(120, 0)} content="x" />);
    expect(ed.revealPositionInCenterIfOutsideViewport).toHaveBeenCalledTimes(2);
    expect(ed.revealPositionInCenterIfOutsideViewport.mock.calls[1]![0]).toEqual({
      lineNumber: 121,
      column: 1,
    });
  });

  it('re-reveals when the file content changes at a constant selection', () => {
    // File-tab switch: @monaco-editor/react calls setValue(), which resets the
    // viewport to the top. We must re-reveal after the new content lands, even
    // though the caret coordinates happen to be identical.
    const ed = fakeEditor();
    const selection = cursorAt(80, 0);
    const { rerender } = render(
      <FollowCursor editor={ed} selection={selection} content="old file" />,
    );
    rerender(<FollowCursor editor={ed} selection={selection} content="new file" />);
    expect(ed.revealPositionInCenterIfOutsideViewport).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the editor is not yet mounted', () => {
    expect(() =>
      render(<FollowCursor editor={null} selection={cursorAt(1, 1)} content="x" />),
    ).not.toThrow();
  });

  it('does not scroll when there is no selection yet', () => {
    const ed = fakeEditor();
    render(<FollowCursor editor={ed} selection={null} content="x" />);
    expect(ed.revealPositionInCenterIfOutsideViewport).not.toHaveBeenCalled();
  });

  it('reveals the external change instead of the caret while one holds the viewport', () => {
    const ed = fakeEditor();
    render(
      <FollowCursor
        editor={ed}
        selection={cursorAt(9, 2)}
        externalChange={{ lineNumber: 300, column: 1 }}
        content="x"
      />,
    );
    expect(ed.revealPositionInCenterIfOutsideViewport.mock.calls[0]![0]).toEqual({
      lineNumber: 300,
      column: 1,
    });
  });

  it('returns to the caret when the external change stops holding the viewport', () => {
    // The jump-and-return: the reveal is driven by whichever target is active,
    // so dropping back to the caret is itself a target change and re-reveals.
    const ed = fakeEditor();
    const selection = cursorAt(9, 2);
    const { rerender } = render(
      <FollowCursor
        editor={ed}
        selection={selection}
        externalChange={{ lineNumber: 300, column: 1 }}
        content="x"
      />,
    );
    rerender(<FollowCursor editor={ed} selection={selection} externalChange={null} content="x" />);

    expect(ed.revealPositionInCenterIfOutsideViewport).toHaveBeenCalledTimes(2);
    expect(ed.revealPositionInCenterIfOutsideViewport.mock.calls[1]![0]).toEqual({
      lineNumber: 10,
      column: 3,
    });
  });

  it('reveals the external change even when there is no caret yet', () => {
    // An external write can land before the student has moved the cursor in
    // this file — there is still something worth looking at.
    const ed = fakeEditor();
    render(
      <FollowCursor
        editor={ed}
        selection={null}
        externalChange={{ lineNumber: 12, column: 4 }}
        content="x"
      />,
    );
    expect(ed.revealPositionInCenterIfOutsideViewport).toHaveBeenCalledTimes(1);
    expect(ed.revealPositionInCenterIfOutsideViewport.mock.calls[0]![0]).toEqual({
      lineNumber: 12,
      column: 4,
    });
  });

  it('does not re-reveal when the caret lands on the same coordinates', () => {
    // A fresh selection object each render must not fight a reviewer who has
    // scrolled away while paused.
    const ed = fakeEditor();
    const { rerender } = render(
      <FollowCursor editor={ed} selection={cursorAt(9, 2)} content="x" />,
    );
    rerender(<FollowCursor editor={ed} selection={cursorAt(9, 2)} content="x" />);
    expect(ed.revealPositionInCenterIfOutsideViewport).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // verticalOnly (split-lanes defect 2): a lane pane is a fraction of the
  // single pane's width, so centering horizontally on the caret's column can
  // scroll a narrow pane far enough right that every line starts off-screen.
  // `verticalOnly` switches the reveal call to a LINE-only Monaco API that has
  // no column argument to pass, so it cannot itself introduce horizontal
  // scroll.
  // ---------------------------------------------------------------------------

  describe('verticalOnly', () => {
    it('reveals via revealLineInCenterIfOutsideViewport, not the column-aware method', () => {
      const ed = fakeEditor();
      render(<FollowCursor editor={ed} selection={cursorAt(9, 40)} content="x" verticalOnly />);
      expect(ed.revealLineInCenterIfOutsideViewport).toHaveBeenCalledTimes(1);
      // 0-based line 9 -> Monaco line 10. No column argument at all.
      expect(ed.revealLineInCenterIfOutsideViewport.mock.calls[0]).toEqual([10, 1]);
      expect(ed.revealPositionInCenterIfOutsideViewport).not.toHaveBeenCalled();
    });

    it('defaults to the column-aware method when verticalOnly is omitted', () => {
      // Unchanged behaviour for every existing caller (the single pane).
      const ed = fakeEditor();
      render(<FollowCursor editor={ed} selection={cursorAt(9, 40)} content="x" />);
      expect(ed.revealPositionInCenterIfOutsideViewport).toHaveBeenCalledTimes(1);
      expect(ed.revealLineInCenterIfOutsideViewport).not.toHaveBeenCalled();
    });

    it('still reveals the END of a selection under verticalOnly, matching the painted caret', () => {
      const ed = fakeEditor();
      render(
        <FollowCursor
          editor={ed}
          selection={sel(
            { start: { line: 1, character: 0 }, end: { line: 40, character: 5 } },
            true,
          )}
          content="x"
          verticalOnly
        />,
      );
      expect(ed.revealLineInCenterIfOutsideViewport.mock.calls[0]![0]).toBe(41);
    });

    it('re-reveals vertically when the selection moves, same as the column-aware path', () => {
      const ed = fakeEditor();
      const { rerender } = render(
        <FollowCursor editor={ed} selection={cursorAt(0, 0)} content="x" verticalOnly />,
      );
      rerender(<FollowCursor editor={ed} selection={cursorAt(120, 0)} content="x" verticalOnly />);
      expect(ed.revealLineInCenterIfOutsideViewport).toHaveBeenCalledTimes(2);
      expect(ed.revealLineInCenterIfOutsideViewport.mock.calls[1]![0]).toBe(121);
    });
  });
});
