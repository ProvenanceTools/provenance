/**
 * focus-and-follow.ts — pure helpers for two replay behaviors:
 *
 *   1. The "focused away" overlay: detect whether the student was focused away
 *      from the VS Code window at the current playhead position.
 *   2. Auto-follow: determine which file is being edited at the current playhead
 *      so the editor can switch to it.
 *
 * Both functions are pure (no side effects, no React) and operate on a session's
 * chronologically-ordered events plus the playhead `currentGlobalIdx`.
 *
 * `currentEditedFile` and `currentFocusAwaySpan` both take an optional
 * `sessionIds` filter, added for the split-lanes feature
 * (`docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md` §4/§7):
 * "the file/focus-state a CONTRIBUTOR is in" is the same predicate as "the
 * file/focus-state the playhead is in", restricted to that contributor's
 * sessions. Rather than a second file-bearing-event predicate in
 * `contributor-active-file.ts`, that module delegates to `currentEditedFile`
 * — see its header for why. The optional third parameter on both functions is
 * additive: every existing call site and test passes two arguments and sees
 * byte-identical behavior.
 *
 * `currentFocusAwaySpan`'s filter exists to fix a real misattribution, not
 * just for symmetry: unfiltered, the "most recent focus.change across the
 * WHOLE bundle" is one contributor's evidence bleeding into another's lane —
 * or, in single-pane view, into whichever session the playhead currently
 * happens to sit in. See that function's header for the full story and how
 * each call site scopes the filter.
 *
 * Recorder PRD §4.4 (focus.change), §4.2 (doc events).
 */

import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { FocusChangePayload } from '@provenance/log-core';

/** File-bearing event kinds that indicate where the student is working. */
const FILE_EVENT_KINDS = new Set(['doc.change', 'paste', 'doc.save', 'doc.open']);

/**
 * Does this event name the file the student is working in?
 *
 * Exported so `contributor-active-file.ts` can precompute a per-contributor
 * file-change timeline in ONE pass and binary-search it at the playhead,
 * instead of re-scanning the whole stream per contributor per frame. Exporting
 * the predicate rather than copying the kind list is the point: a file-bearing
 * kind added to `FILE_EVENT_KINDS` and not to a parallel list elsewhere would
 * make the lane grid and the single-pane auto-follow disagree about where a
 * contributor is, with no test positioned to notice.
 */
export function isFileBearingEvent(e: IndexedEvent): e is IndexedEvent & { file: string } {
  return e.file != null && FILE_EVENT_KINDS.has(e.kind);
}

/** Active "focused away" state at the playhead, or null when focused (or before any event). */
export type FocusAwayState = { reason: string | null } | null;

/**
 * Whether the student is currently focused away from the window at the playhead.
 *
 * The student is "away" iff the most recent `focus.change` event at-or-before the
 * playhead has `gained: false` (and no later `gained: true` has occurred yet). When
 * away, returns the event's `reason` (or null when none was recorded).
 *
 * `events` must be chronologically ordered (ascending `globalIdx`), as the per-
 * session event lists from the EventIndex are.
 *
 * `sessionIds`, when passed, restricts the scan to events whose `sessionId` is
 * in the set — "was THIS CONTRIBUTOR focused away", for a split-lane's
 * overlay, or "was THIS SESSION focused away", for the single-pane overlay
 * (scoped to just the session the playhead is currently inside). Omitted
 * (the default), this scans the whole bundle unfiltered — no remaining call
 * site does this; every caller now filters.
 *
 * The filter matters more here than it does for `currentEditedFile`: an
 * unfiltered scan doesn't just answer a slightly-too-broad question, it can
 * name the WRONG PERSON. In lane mode the overlay is drawn inside one
 * contributor's lane with their identity in the header right above it, and in
 * single-pane mode a grader reads the overlay as being about the work
 * currently on screen — if the away state came from a DIFFERENT contributor's
 * `focus.change`, that reads as an accusation the evidence never implicated
 * them in, which is the exact false-attribution failure this feature exists
 * to prevent (see `ContributorSelect.tsx`'s header comment). The overlay must
 * only ever be driven by the session(s) it is actually being shown against.
 */
export function currentFocusAwaySpan(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
  sessionIds?: ReadonlySet<string>,
): FocusAwayState {
  let away: FocusAwayState = null;
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx) break;
    if (sessionIds !== undefined && !sessionIds.has(e.sessionId)) continue;
    if (e.kind !== 'focus.change') continue;
    const p = e.payload as FocusChangePayload;
    away = p.gained ? null : { reason: p.reason ?? null };
  }
  return away;
}

/**
 * The file being edited at the playhead = the path of the most recent file-bearing
 * event (`doc.change` / `paste` / `doc.save` / `doc.open`) at-or-before the playhead.
 * Returns null when no such event has occurred yet.
 *
 * `events` must be chronologically ordered (ascending `globalIdx`).
 *
 * `sessionIds`, when passed, restricts the predicate to events whose
 * `sessionId` is in the set — "the file THIS CONTRIBUTOR is in", for the
 * split-lanes grid (`contributor-active-file.ts`). Omitted (the default), this
 * is exactly today's whole-stream "the file being edited" and every existing
 * caller/test is unaffected.
 */
export function currentEditedFile(
  events: readonly IndexedEvent[],
  currentGlobalIdx: number,
  sessionIds?: ReadonlySet<string>,
): string | null {
  let file: string | null = null;
  for (const e of events) {
    if (e.globalIdx > currentGlobalIdx) break;
    if (sessionIds !== undefined && !sessionIds.has(e.sessionId)) continue;
    if (isFileBearingEvent(e)) {
      file = e.file;
    }
  }
  return file;
}
