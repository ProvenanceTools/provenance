/**
 * Read `submission_contributors` for the API — the one place a read path turns
 * contributor rows into the wire shape.
 *
 * Every submission-shaped response now carries `contributors[]`, and they all
 * come through here so protected-mode masking, ordering and the roster
 * projection cannot drift between the cohort list, the summary, the cross-flag
 * participants and the dry-run movers.
 *
 * ## Batched, because these are list endpoints
 *
 * `fetchContributorsFor` takes every submission id on the page and issues ONE
 * query. A per-row fetch would put an N+1 on the cohort list's hot path, which
 * is the query the denormalised `flag_counts` / `top_flags` columns exist to
 * keep fast.
 *
 * ## Protected mode
 *
 * A contributor's name and SID go through the same `projectStudent` every other
 * student-bearing response uses. A contributor with no roster row has no name
 * to mask and stays `student: null` — there is nothing there to leak, and
 * substituting a placeholder would invent a person.
 */

import { inArray, asc, eq } from 'drizzle-orm';
import type { SubmissionContributor } from '@provenance/shared/api-schemas';
import { roster_entries, submission_contributors } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { projectStudent } from '../protect.js';

/**
 * Contributors for each of the given submissions, keyed by submission id.
 *
 * A submission with no contributor rows is absent from the map; callers use
 * `?? []`. That is a real state (a bundle with no identity and no roster match)
 * and it is not an error.
 *
 * Ordering within a submission is stable and meaningful: submitters first, then
 * by name, then by key. A grader scanning a list must see the same person in
 * the same place on every reload.
 */
export async function fetchContributorsFor(
  db: DrizzleDb,
  submissionIds: readonly string[],
  protectedMode: boolean,
): Promise<Map<string, SubmissionContributor[]>> {
  const result = new Map<string, SubmissionContributor[]>();
  if (submissionIds.length === 0) return result;

  // LEFT join: a contributor with no roster row (D13 — verified identity, not
  // on this semester's roster) must still be listed. An INNER join here would
  // silently drop exactly the people the join table was added to represent.
  const rows = await db
    .select({
      submission_id: submission_contributors.submission_id,
      contributor_key: submission_contributors.contributor_key,
      kind: submission_contributors.kind,
      student_ref: submission_contributors.student_ref,
      session_count: submission_contributors.session_count,
      is_submitter: submission_contributors.is_submitter,
      score_total: submission_contributors.score_total,
      score_max_severity: submission_contributors.score_max_severity,
      flag_counts: submission_contributors.flag_counts,
      roster_id: roster_entries.id,
      roster_sid: roster_entries.sid,
      roster_display_name: roster_entries.display_name,
      roster_protected_index: roster_entries.protected_index,
    })
    .from(submission_contributors)
    .leftJoin(roster_entries, eq(submission_contributors.roster_entry_id, roster_entries.id))
    .where(inArray(submission_contributors.submission_id, [...submissionIds]))
    .orderBy(asc(submission_contributors.contributor_key));

  for (const row of rows) {
    const contributor: SubmissionContributor = {
      contributor_key: row.contributor_key,
      kind: row.kind === 'attributed' ? 'attributed' : 'roster',
      student:
        row.roster_id === null
          ? null
          : projectStudent(
              {
                id: row.roster_id,
                sid: row.roster_sid ?? '',
                display_name: row.roster_display_name ?? '',
                protected_index: row.roster_protected_index ?? null,
              },
              protectedMode,
            ),
      student_ref: row.student_ref,
      session_count: row.session_count,
      is_submitter: row.is_submitter,
      score_total: row.score_total,
      score_max_severity: normaliseSeverity(row.score_max_severity),
      flag_counts: normaliseFlagCounts(row.flag_counts),
    };

    const bucket = result.get(row.submission_id);
    if (bucket === undefined) result.set(row.submission_id, [contributor]);
    else bucket.push(contributor);
  }

  for (const list of result.values()) list.sort(compareContributorsForDisplay);

  return result;
}

/** Convenience wrapper for the single-submission read paths. */
export async function fetchContributors(
  db: DrizzleDb,
  submissionId: string,
  protectedMode: boolean,
): Promise<SubmissionContributor[]> {
  const map = await fetchContributorsFor(db, [submissionId], protectedMode);
  return map.get(submissionId) ?? [];
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Deterministic display order: submitters first, then named contributors by
 * name, then unnamed ones by key.
 */
function compareContributorsForDisplay(a: SubmissionContributor, b: SubmissionContributor): number {
  if (a.is_submitter !== b.is_submitter) return a.is_submitter ? -1 : 1;
  const an = a.student?.display_name ?? '';
  const bn = b.student?.display_name ?? '';
  if (an !== bn) {
    // A contributor with no name sorts after every named one rather than to the
    // top, which is what an empty string would do.
    if (an === '') return 1;
    if (bn === '') return -1;
    return an < bn ? -1 : 1;
  }
  return a.contributor_key < b.contributor_key ? -1 : a.contributor_key > b.contributor_key ? 1 : 0;
}

const SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
type Sev = (typeof SEVERITIES)[number];

/** The column is CHECK-constrained, so this only ever narrows the type. */
function normaliseSeverity(value: string): Sev {
  return (SEVERITIES as readonly string[]).includes(value) ? (value as Sev) : 'info';
}

/**
 * `flag_counts` is jsonb. It is written only by `applyContributorScores` and is
 * CHECK-free, so narrow it defensively rather than casting — a malformed value
 * must degrade to zeroes, never crash a list endpoint.
 */
function normaliseFlagCounts(value: unknown): {
  info: number;
  low: number;
  medium: number;
  high: number;
} {
  const out = { info: 0, low: 0, medium: 0, high: 0 };
  if (typeof value !== 'object' || value === null) return out;
  const record = value as Record<string, unknown>;
  for (const key of SEVERITIES) {
    const n = record[key];
    if (typeof n === 'number' && Number.isFinite(n)) out[key] = n;
  }
  return out;
}
