/**
 * Content a git merge delivered from a partner's recorded work — Tier 3.1, for
 * the heuristics that reason about how much a FILE GREW rather than about an
 * `fs.external_change` event.
 *
 * ## Why this exists
 *
 * `external_edits`, `mass_external_replacement` and
 * `terminal_active_during_external_change` all report ON an external change, so
 * they consume `classification.gitMergeIn` by skipping the event. Three other
 * heuristics never look at the event at all — they look at the file's SIZE:
 *
 *  - `low_typing_high_output` divides the file's growth by chars typed;
 *  - `time_to_first_save_anomaly` counts chars written between open and save;
 *  - `idle_then_complete` compares the file before an idle gap to the file after.
 *
 * A `git pull` grows the file with nobody typing, so all three read an honest
 * pull as unexplained output. Measured on the honest-pair fixture in
 * `contributor-scope-boundary.test.ts`: whole-scope, with both partners'
 * enrolment chains verified, `low_typing_high_output` fired at **high** severity
 * with confidence 1.0 on the puller, and the other two fired at **high** on
 * neighbouring shapes of the same pull.
 *
 * ## The answer is subtraction, not suppression
 *
 * Skipping the file would blind the heuristic to everything else that happened
 * in it: pull once and the rest of the file is unexaminable. What is actually
 * true is narrower — *those particular characters* are not this student's
 * output. So the heuristics discount them and evaluate the remainder normally.
 * A student who pulls their partner's work and then pastes a solution into the
 * same file still fires, because the paste's characters are not merged-in.
 *
 * Per-character provenance makes the subtraction exact:
 * {@link FileReplayState.provenance} already holds, for every character of the
 * reconstructed content, the `globalIdx` of the event that last wrote it, and an
 * `fs.external_change` carrying `new_content` attributes every character of the
 * reseeded content to itself. Intersecting that with
 * `ExternalChangeClassification.gitMergeIn` is the whole mechanism.
 *
 * ## Why this cannot become decision D16's hole
 *
 * D16 removed a SUPPRESSION KEYED ON TIMING — the recorder's `explanation: 'git'`
 * tag, a ~2 s window a student could stand inside by pasting right after any git
 * command. Nothing here reads a clock or a tag. The only input is
 * `gitMergeIn`, whose membership test is: the post-change sha256 equals a sha256
 * that a **provably different, verified** contributor recorded on this path
 * (`classify-external-changes.ts`). A student's own bytes cannot satisfy it —
 * `compareContributors` must answer `'different'`, and a match against their own
 * other session or an `unattributed` / `unverifiable` one is reported as
 * `content_match_not_attributable` and NOT suppressed. To launder a paste
 * through a commit, a student would need a second enrolled student's recorder to
 * have recorded those exact bytes — at which point the finding lands on that
 * student's own timeline, where the content arrived unexplained. The evidence
 * moves; it does not evaporate.
 *
 * `git_unrecorded_in`, `external` and `unclassified` are NOT discounted here,
 * exactly as they are not skipped by the three event-level consumers.
 *
 * ## Solo bundles are byte-for-byte unaffected
 *
 * `classifyExternalChanges` does not run for a non-collaborative scope, so
 * `gitMergeIn` is empty, every function below returns what the un-discounted
 * arithmetic returned, and the flags, counts and severities are identical (R3).
 */

import type { FileReplayState } from '../index/reconstruct-file-provenance.js';

/**
 * How many characters of `state.content` git delivered from a provably
 * different verified contributor's recorded work.
 *
 * Subtract this from a file's length to get the length that is the student's to
 * explain.
 */
export function mergedInCharCount(state: FileReplayState, gitMergeIn: ReadonlySet<number>): number {
  if (gitMergeIn.size === 0) return 0;
  let count = 0;
  for (const globalIdx of state.provenance) {
    if (gitMergeIn.has(globalIdx)) count++;
  }
  return count;
}

/**
 * How many characters of `state.content` were written after `afterGlobalIdx` by
 * something other than a git merge.
 *
 * The `> afterGlobalIdx` half is `time_to_first_save_anomaly`'s existing "new
 * code" test — content seeded by the `doc.open` is attributed to the open
 * itself, and anything attributed to a lower `globalIdx` predates it. The
 * merged-in half is Tier 3.1: a pull that landed inside the open→save window
 * wrote characters, but the student did not.
 */
export function charsWrittenAfter(
  state: FileReplayState,
  afterGlobalIdx: number,
  gitMergeIn: ReadonlySet<number>,
): number {
  let count = 0;
  for (const globalIdx of state.provenance) {
    if (globalIdx <= afterGlobalIdx) continue;
    if (gitMergeIn.has(globalIdx)) continue;
    count++;
  }
  return count;
}
