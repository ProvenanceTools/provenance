/**
 * contributor-display — the single source of wording for "who is this
 * submission about".
 *
 * A submission used to belong to exactly one student. After the 0029 cut-over
 * it is attributable to N contributors, and `student` (the SUBMITTER of record)
 * can be null when no single roster entry owns it. Every surface that names
 * people — the cohort table, the CSV export, the submission overview, the
 * cross-flag participant cards, the tuning dry-run table — goes through these
 * functions so the wording cannot drift between them.
 *
 * Two invariants the callers rely on:
 *
 * 1. A SOLO submission has exactly one contributor and it is the same person as
 *    `student`, so `contributorsLabel`/`contributorsSidLabel` return exactly the
 *    old `student.display_name` / `student.sid` strings. Solo rendering is
 *    unchanged, by construction.
 * 2. `student === null` on a contributor means a real person we cannot NAME —
 *    enrolled, but not on this semester's roster. That is an ADMINISTRATIVE
 *    GAP, not a finding. It is rendered with neutral wording and neutral
 *    styling: never as an error, a warning, "unknown", or "invalid". We never
 *    invent a name to fill the hole.
 */

/** Neutral stand-in for a contributor who is not on the semester's roster. */
export const UNNAMED_CONTRIBUTOR_LABEL = 'Unnamed contributor';

/** Default separator for the list labels. */
const DEFAULT_SEPARATOR = ', ';

/**
 * The naming fields every person-shaped API record carries. Structural on
 * purpose: `SubmissionRow['student']` also has an `id` and
 * `SubmissionSummary['student']` does not, and both are accepted here.
 */
export interface DisplayPerson {
  display_name: string;
  sid: string;
}

/** The only part of a `SubmissionContributor` these functions read. */
export interface DisplayContributor {
  student: DisplayPerson | null;
}

export interface ContributorListOptions {
  /**
   * Used only when the contributor list is EMPTY — a defensive fallback to the
   * submission's `student` for any response that predates `contributors`.
   */
  fallbackStudent?: DisplayPerson | null;
  /** Joins multiple entries. Defaults to `', '`; the CSV export passes `';'`. */
  separator?: string;
}

/** Display name for one person, or the neutral placeholder when unnamed. */
export function personLabel(person: DisplayPerson | null | undefined): string {
  return person ? person.display_name : UNNAMED_CONTRIBUTOR_LABEL;
}

/**
 * SID for one person, or the empty string when unnamed — an unnamed contributor
 * has no SID to show, and callers render nothing rather than a placeholder so
 * the gap reads as absence, not as a problem.
 */
export function personSid(person: DisplayPerson | null | undefined): string {
  return person ? person.sid : '';
}

/** Display name for one contributor. */
export function contributorLabel(contributor: DisplayContributor): string {
  return personLabel(contributor.student);
}

/** SID for one contributor, or `''` when they are not on the roster. */
export function contributorSid(contributor: DisplayContributor): string {
  return personSid(contributor.student);
}

/**
 * Names of every contributor, joined. Exactly `student.display_name` for a solo
 * submission. `''` for an empty list with no fallback.
 */
export function contributorsLabel(
  contributors: readonly DisplayContributor[],
  options: ContributorListOptions = {},
): string {
  const separator = options.separator ?? DEFAULT_SEPARATOR;
  if (contributors.length === 0) {
    const fallback = options.fallbackStudent;
    return fallback === undefined || fallback === null ? '' : fallback.display_name;
  }
  return contributors.map(contributorLabel).join(separator);
}

/**
 * SIDs of every contributor, joined, positionally aligned with
 * {@link contributorsLabel} — an unnamed contributor contributes an empty
 * entry rather than being dropped, so the two lists stay index-for-index
 * comparable in the CSV export.
 */
export function contributorsSidLabel(
  contributors: readonly DisplayContributor[],
  options: ContributorListOptions = {},
): string {
  const separator = options.separator ?? DEFAULT_SEPARATOR;
  if (contributors.length === 0) {
    const fallback = options.fallbackStudent;
    return fallback === undefined || fallback === null ? '' : fallback.sid;
  }
  return contributors.map(contributorSid).join(separator);
}
