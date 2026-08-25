/**
 * contributor-active-file — "which file was THIS CONTRIBUTOR last in, as of the
 * playhead?" (design §4: `activeFile(c, T)`, the input the lane grid groups by).
 *
 * Design spec: `docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md`.
 *
 * ## One predicate, not two
 *
 * `focus-and-follow.ts`'s `currentEditedFile` already answers "the path of the
 * most recent file-bearing event (`doc.change` / `paste` / `doc.save` /
 * `doc.open`) at or before the playhead" for the whole stream. A per-contributor
 * version of that question is the SAME predicate restricted to one
 * contributor's sessions — not a second definition of "this event names a
 * file". Inventing a parallel predicate here would eventually drift from the
 * single-stream one (a new file-bearing event kind added to one and not the
 * other, for instance) with no test able to catch it.
 *
 * So `currentEditedFile` was given an optional `sessionIds` filter (see its
 * header) and this module is a two-line delegation: it exists as its own file
 * only because it is a distinct call shape (a session-id SET, not the implicit
 * "whole stream") with its own name at the call sites that need it
 * (`lane-groups.ts` / the lane grid wiring in a later phase).
 */

import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import { currentEditedFile } from './focus-and-follow.js';

/**
 * The path named by the most recent file-bearing event at or before
 * `globalIdx` belonging to any session in `sessionIds`. `null` when this
 * contributor has no such event yet (including when `sessionIds` is empty —
 * a contributor with no sessions has, by definition, no activity to show).
 *
 * `events` must be chronologically ordered (ascending `globalIdx`), as
 * `EventIndex.ordered` is.
 */
export function activeFileAt(
  events: readonly IndexedEvent[],
  sessionIds: ReadonlySet<string>,
  globalIdx: number,
): string | null {
  return currentEditedFile(events, globalIdx, sessionIds);
}
