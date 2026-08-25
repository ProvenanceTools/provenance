/**
 * FollowCursor — keeps the point of interest in view as the replay plays.
 *
 * Headless component (returns null), mirroring CursorMarker and
 * GutterDecorations: it drives a side effect on the Monaco editor and renders
 * nothing.
 *
 * Behaviour: whenever the position of interest changes, scroll it back into view
 * and centre it — but ONLY if it has left the viewport. Typing inside the
 * visible window causes no scrolling at all, so there is no per-keystroke
 * jitter.
 *
 * The point of interest is normally the student's caret. While an
 * `fs.external_change` holds the viewport, it is that event's position instead
 * (see external-change-focus.ts): nothing moves the caret to an external write,
 * so without this the reviewer plays straight past it. Because the reveal is
 * driven by whichever target is active — not by a timer — the viewport returns
 * to the caret on the student's next edit or cursor move, and the return is
 * itself just another target change.
 *
 * Why no "follow on/off" toggle: the reveal fires only when the caret position
 * changes, which only happens when the playhead moves (play, step, scrub,
 * sidebar seek, jump-to-next-paste, file switch). A reviewer who scrolls away
 * while paused is therefore never yanked back until they move the playhead
 * themselves.
 *
 * `content` is a dependency, not just a prop we ignore: on a file-tab switch
 * @monaco-editor/react calls model.setValue(), which resets the viewport to the
 * top. Re-revealing when the content changes undoes that reset even when the
 * caret coordinates happen to be unchanged.
 *
 * ## `verticalOnly` — lane panes follow vertically, never horizontally
 *
 * A split-lane pane is a fraction of the single pane's width (up to three
 * lanes side by side). A caret at a column that sits comfortably inside the
 * single pane's ~full-width viewport can sit well past a narrow lane's right
 * edge, and `revealPositionInCenterIfOutsideViewport` centers on that COLUMN
 * as well as the line — scrolling the pane far enough right that every visible
 * line starts mid-statement, off the left edge. Manual QA on the split-lanes
 * feature caught exactly this (see the design doc's defect writeup).
 *
 * `verticalOnly` switches the reveal call to
 * `revealLineInCenterIfOutsideViewport(lineNumber, scrollType)` — a Monaco API
 * that takes a line number only, never a column, so it cannot itself introduce
 * horizontal scroll. It still reveals the line vertically "if outside the
 * viewport", so a caret genuinely off the bottom/top still scrolls into view;
 * what changes is that the horizontal scroll position is left exactly where
 * the reader (or the previous reveal) put it. Default `false`: the single pane
 * keeps `revealPositionInCenterIfOutsideViewport`, unchanged.
 */

import { useEffect } from 'react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import { caretPosition } from './cursor-position.js';
import type { MonacoPositionLiteral, ReplaySelection } from './cursor-position.js';

/**
 * monaco.editor.ScrollType.Immediate. Hard-coded rather than threaded through
 * as a second prop because the `monaco` namespace object is null for the first
 * render, which is exactly when the first reveal needs to happen. Immediate
 * (not Smooth) so fast playback doesn't queue scroll animations it can't keep
 * up with.
 */
const SCROLL_TYPE_IMMEDIATE = 1;

type FollowCursorProps = {
  /** The Monaco editor instance (null while the editor is loading). */
  editor: MonacoEditorNS.IStandaloneCodeEditor | null;
  /** The student's cursor/selection at the playhead, or null to leave the viewport alone. */
  selection: ReplaySelection | null;
  /**
   * Position of the `fs.external_change` holding the viewport, or null when none
   * is (the usual case). Takes precedence over the caret: an external write is
   * the higher-signal thing on screen, and it is the one thing the caret can
   * never lead the reviewer to.
   */
  externalChange?: MonacoPositionLiteral | null;
  /** Content of the shown file. A change means the model was replaced. */
  content: string;
  /**
   * Follow vertically only, leaving horizontal scroll alone unless the target
   * is outside the viewport entirely. See the module header. Default `false`
   * — the single pane's behaviour is unchanged.
   */
  verticalOnly?: boolean;
};

export function FollowCursor({
  editor,
  selection,
  externalChange = null,
  content,
  verticalOnly = false,
}: FollowCursorProps) {
  // Reveal whichever target is active. Deriving it here (rather than revealing
  // in two effects) is what makes the return trip work: when `externalChange`
  // goes back to null the target changes to the caret, which re-runs the effect.
  const target = externalChange ?? (selection === null ? null : caretPosition(selection));
  const lineNumber = target?.lineNumber ?? null;
  const column = target?.column ?? null;

  useEffect(() => {
    if (editor === null || lineNumber === null || column === null) return;
    if (verticalOnly) {
      // No column argument exists to pass — that is the point. See the
      // module header, "verticalOnly".
      editor.revealLineInCenterIfOutsideViewport(lineNumber, SCROLL_TYPE_IMMEDIATE);
    } else {
      editor.revealPositionInCenterIfOutsideViewport({ lineNumber, column }, SCROLL_TYPE_IMMEDIATE);
    }
    // Depend on the primitive coordinates, not the object: `selection` and
    // `externalChange` are freshly built each render, so an object dep would
    // re-reveal on every render and fight a reviewer scrolling while paused.
    // `content` is intentionally in the dep list: see the file header.
  }, [editor, lineNumber, column, content, verticalOnly]);

  return null;
}
