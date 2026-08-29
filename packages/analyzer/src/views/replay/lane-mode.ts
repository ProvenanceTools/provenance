/**
 * lane-mode — the ONE predicate for "does this submission get split lanes?"
 *
 * Lanes exist to separate two people's concurrent work, so the question they
 * answer is the same one reconstruction asks before it refuses to linearize a
 * file: are there two PROVABLY DIFFERENT contributors here?
 * {@link hasTwoDifferentContributors} is that question, and it requires both
 * sides `attributed` — a verified enrolment chain — precisely so an unstamped
 * bundle cannot talk the UI into a claim the evidence does not support.
 *
 * This module exists because `contributors.contributors.length > 1` is NOT that
 * question, and silently disagreed with it. `unattributedContributorKey` is
 * keyed per SESSION (`identity/resolve-contributors.ts`), so an unstamped solo
 * submission with five sessions yields five distinct `Contributor` entries.
 * Gating on that raw count put such a bundle into lane mode, where
 * `buildLaneLayout` caps code lanes at three and hands them to the first three
 * contributors in session order. A student whose editing happened in sessions
 * four and five then saw three permanently idle lanes and no content, start to
 * finish — while reconstruction, correctly on the solo path via the very
 * predicate below, had the file all along.
 *
 * Two implementations of "is this collaborative" are two answers waiting to
 * disagree. There is one, and it is here.
 */
import type { BundleContributors } from '@provenance/analysis-core/identity/types.js';
import { hasTwoDifferentContributors } from '@provenance/analysis-core/index/reconstruct-segments.js';

/**
 * Whether `contributors` describes a submission that split lanes can honestly
 * represent. `null`/`undefined` — no stamp resolved — is not collaborative:
 * lanes must never be the UI's guess.
 */
export function isLaneEligible(contributors: BundleContributors | null | undefined): boolean {
  if (contributors === null || contributors === undefined) return false;
  return hasTwoDifferentContributors([...contributors.bySession.values()]);
}
