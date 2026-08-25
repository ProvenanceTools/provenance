/**
 * The single policy for what analysis does when reconstruction has no single
 * truth — Tier 2.2 (spec §5.3, §6 Rule 2).
 *
 * ## The rule
 *
 * **A heuristic may not fire on content it cannot establish.**
 *
 * When {@link reconstructFileSegmented} answers `concurrent` or `unknown`, there
 * is no single content for the file, so every comparison a content heuristic
 * wants to make — "does this paste match the final state", "did the file change
 * between sessions", "how much output per keystroke" — has no well-defined
 * operand. Running the comparison against one arbitrarily chosen branch does not
 * produce a weaker finding; it produces a finding about a file that never
 * existed, attached to a named student. Spec §6 Rule 2 puts the bar at
 * `established` evidence before a finding may name a person, and a branch that
 * was picked rather than proven is not established.
 *
 * So the answer is `null`, and every caller skips the file.
 *
 * ## Why this cannot quietly weaken a real course
 *
 * Skipping produces FEWER findings, which is the direction that needs
 * justifying. It is safe here because it is unreachable for solo work: a file
 * only reaches `concurrent` when its events span two contributors whose
 * enrolment chains BOTH verify against the course-signed root
 * (`reconstruct-segments.ts`, "The solo guarantee"). A student cannot forge a
 * second contributor to silence a heuristic — an `unverifiable` identity block
 * does not count — and a solo bundle never takes this path at all. That is the
 * operational form of the spec's closing negative rule: nothing here reduces the
 * findings produced for a solo, non-git submission.
 *
 * ## What is deliberately NOT done here
 *
 * The skip is not yet a visible `not_applicable` flag with a reason attached.
 * Spec §5.4 step 8 wants one ("a heuristic is never silently disabled", R1), but
 * that means a new flag id, its registration in `known-flag-ids.ts`, and a slot
 * in the analyzer's flag-tuning UI — a product decision about the catalogue
 * rather than a coding one.
 *
 * This was previously written as deferred to "Tier 3.5's per-contributor
 * scoping work". That work will not happen: per-contributor heuristic
 * *scoping* (as opposed to *attribution* and *scoring* of a whole-scope run)
 * is closed as out-of-scope-by-analysis — see decision D14 in
 * `docs/superpowers/specs/2026-08-19-program-decision-log.md` and the pinned
 * analysis in `contributor-scope-boundary.test.ts`. Slicing a heuristic's
 * input to one contributor is exactly what would defeat *this* gate (a file
 * only reaches `concurrent` when its events span two verified contributors;
 * narrow the scope to one and every suppressed verdict becomes a firing one),
 * re-manufacturing the false accusations this gate exists to prevent.
 *
 * So the `not_applicable` flag is not blocked on scoping work — that
 * dependency no longer exists. Whether and how to add it is an open,
 * separately owned product decision (not resolved here). Until it is made,
 * the fact is recorded on the file's stats as
 * {@link FileStats.reconstructionAmbiguity}, so it is visible rather than lost.
 */

import type { Bundle } from '../loader/types.js';
import type { EventIndex } from '../index/event-index.js';
import type { FileReplayState } from '../index/reconstruct-file-provenance.js';
import type { ReconstructResult } from '../index/reconstruct-file.js';
import {
  determinateValue,
  reconstructFileSegmented,
  reconstructFileSegmentedWithProvenance,
  reconstructionScopeFor,
  type SegmentedResult,
} from '../index/reconstruct-segments.js';

/**
 * The reconstructed content of `filePath`, or `null` when the evidence does not
 * establish one. `null` means SKIP THIS FILE — never "use something else".
 */
export function establishedContent(
  index: EventIndex,
  bundle: Bundle,
  filePath: string,
  upToGlobalIdx?: number,
): string | null {
  return establishedResult(index, bundle, filePath, upToGlobalIdx)?.content ?? null;
}

/** {@link establishedContent}, but the whole {@link ReconstructResult}. */
export function establishedResult(
  index: EventIndex,
  bundle: Bundle,
  filePath: string,
  upToGlobalIdx?: number,
): ReconstructResult | null {
  return determinateValue(
    reconstructFileSegmented(reconstructionScopeFor(bundle, index), filePath, upToGlobalIdx),
  );
}

/** {@link establishedContent}, but the whole {@link FileReplayState}. */
export function establishedReplayState(
  index: EventIndex,
  bundle: Bundle,
  filePath: string,
  upToGlobalIdx?: number,
): FileReplayState | null {
  return determinateValue(
    reconstructFileSegmentedWithProvenance(
      reconstructionScopeFor(bundle, index),
      filePath,
      upToGlobalIdx,
    ),
  );
}

/**
 * The ambiguity state of a file's reconstruction, for the record rather than for
 * a decision. `undefined` when there is a single content.
 */
export function reconstructionAmbiguityOf(
  index: EventIndex,
  bundle: Bundle,
  filePath: string,
): 'concurrent' | 'unknown' | undefined {
  return ambiguityOf(reconstructFileSegmented(reconstructionScopeFor(bundle, index), filePath));
}

function ambiguityOf<T>(result: SegmentedResult<T>): 'concurrent' | 'unknown' | undefined {
  return result.kind === 'determinate' ? undefined : result.kind;
}
