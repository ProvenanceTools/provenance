/**
 * Cross-flags list service — PRD §8.10.
 *
 * GET /semesters/{semesterId}/cross-flags
 *
 * Filters:
 *   heuristic_id?       — exact match on cross_flags.heuristic_id
 *   severity_min?       — cross_flags.severity IN (severityMin and above)
 *   submission_id?      — only cross_flags where this submission is a participant
 *
 * Pagination: cursor on (created_at DESC, id DESC), carrying a
 * microsecond-precision timestamp and compared with a row-value comparison.
 * See `../keyset.ts` for why anything less drops rows.
 *
 * Response shape: CrossFlagSummary[] with participants[].
 */

import { and, eq, sql, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { KEYSET_CURSOR_VERSION, isMicroTimestamp, keysetAfter, microTimestamp } from '../keyset.js';
import {
  cross_flags,
  cross_flag_exclusions,
  cross_flag_participants,
  submissions,
  roster_entries,
  assignments,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { Severity } from '@provenance/analysis-core/heuristics/types.js';
import type { SubmissionContributor } from '@provenance/shared/api-schemas';
import { projectStudent } from '../protect.js';
import { fetchContributorsFor } from '../contributors/fetch-contributors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CrossFlagParticipantRow = {
  submission_id: string;
  /**
   * The submitter of record, or null when no single roster entry owns this
   * submission (D9). Mirrors `CrossFlagParticipantSchema.student` in
   * `@provenance/shared`. The participant is always listed; only the NAME can
   * be absent.
   */
  student: { id: string; sid: string; display_name: string } | null;
  /**
   * Everyone this participant's submission is attributable to (D9). `student`
   * above is one of them; on a group submission it is one of several, and
   * naming only that one points the finding at an arbitrary partner. Exactly
   * one entry, equal to `student`, for every solo submission.
   */
  contributors: SubmissionContributor[];
  assignment: { id: string; assignment_id_str: string };
  supporting_seqs: number[];
};

export type CrossFlagSummary = {
  id: string;
  heuristic_id: string;
  severity: Severity;
  confidence: number;
  participants: CrossFlagParticipantRow[];
  detail: unknown;
  created_at: string;
};

export type CrossFlagFilters = {
  heuristicId?: string;
  severityMin?: Severity;
  submissionId?: string;
};

/** One member of an excluded lineage, resolved for display. */
export type CrossScopeExclusionMemberRow = {
  submission_id: string;
  source_filename: string;
  /** Everyone the submission is attributable to, as on a cross-flag participant. */
  contributors: SubmissionContributor[];
  student: { id: string; sid: string; display_name: string } | null;
  assignment: { id: string; assignment_id_str: string };
};

/**
 * One row of the exclusion register — a repository lineage that was NOT
 * compared against itself.
 *
 * Not a flag: no severity, no confidence, no score. See migration 0031 and
 * `analysis-core/coverage/cross-scope.ts` for why it is its own table.
 */
export type CrossScopeExclusionSummary = {
  id: string;
  reason: 'same_repository_lineage' | 'shared_recording_scope';
  members: CrossScopeExclusionMemberRow[];
  shared_commits: string[];
  /**
   * The session keys that proved it (migration 0032). Empty for a lineage
   * proved by commits alone — including every row written before 0032, which
   * the column default makes true rather than merely likely.
   */
  shared_sessions: string[];
  excluded_pair_count: number;
  created_at: string;
};

/**
 * Hard cap on the register returned with one list response.
 *
 * The register holds one row per partnered group per semester, so a course
 * where every submission is a pair is bounded by half the cohort — a few
 * hundred rows at the very top end. The cap is a backstop against an
 * unbounded response, not a paging scheme; the register is deliberately not
 * paginated, because it is read as a whole ("what was withheld?") and a
 * half-answer to that question is worse than none.
 */
export const CROSS_SCOPE_EXCLUSION_LIMIT = 500;

/**
 * Cursor: (created_at, id) compound — created_at DESC, id DESC.
 *
 * `created_at` is a MICROSECOND-precision UTC ISO string, not a
 * `Date.toISOString()` value. See `../keyset.ts`.
 */
export type CrossFlagCursor = { created_at: string; id: string };

const SEVERITIES_AT_OR_ABOVE: Record<Severity, Severity[]> = {
  info: ['info', 'low', 'medium', 'high'],
  low: ['low', 'medium', 'high'],
  medium: ['medium', 'high'],
  high: ['high'],
};

// ---------------------------------------------------------------------------
// Cursor encode / decode
// ---------------------------------------------------------------------------

export function encodeCrossFlagCursor(cursor: CrossFlagCursor): string {
  return Buffer.from(
    JSON.stringify({ v: KEYSET_CURSOR_VERSION, created_at: cursor.created_at, id: cursor.id }),
  ).toString('base64url');
}

/**
 * Returns `null` for anything this build cannot paginate from correctly — the
 * route turns that into a 400.
 *
 * That deliberately includes a **pre-fix cursor**, which is recognisable both
 * by its missing version tag and by its millisecond-precision timestamp.
 * Honouring one would mean treating its timestamp as a bucket floor and
 * silently dropping the rest of that millisecond — the exact defect this code
 * exists to fix. A 400 the client recovers from by restarting pagination is the
 * only honest answer.
 */
export function decodeCrossFlagCursor(encoded: string): CrossFlagCursor | null {
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (p['v'] !== KEYSET_CURSOR_VERSION) return null;
    if (typeof p['created_at'] !== 'string' || typeof p['id'] !== 'string') return null;
    if (!isMicroTimestamp(p['created_at'])) return null;
    return { created_at: p['created_at'], id: p['id'] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main query
// ---------------------------------------------------------------------------

export async function listCrossFlags(
  db: DrizzleDb,
  semesterId: string,
  filters: CrossFlagFilters,
  cursor: CrossFlagCursor | null,
  limit: number,
  protectedMode: boolean,
): Promise<{ items: CrossFlagSummary[]; nextCursor: string | null }> {
  const whereConditions: SQL[] = [];

  whereConditions.push(eq(cross_flags.semester_id, semesterId));

  if (filters.heuristicId !== undefined) {
    whereConditions.push(eq(cross_flags.heuristic_id, filters.heuristicId));
  }

  if (filters.severityMin !== undefined) {
    const q = SEVERITIES_AT_OR_ABOVE[filters.severityMin];
    if (q.length === 1) {
      whereConditions.push(eq(cross_flags.severity, q[0]!));
    } else {
      whereConditions.push(inArray(cross_flags.severity, q));
    }
  }

  // submission_id filter: only cross_flags that have this submission as a participant
  if (filters.submissionId !== undefined) {
    whereConditions.push(
      sql`EXISTS (
        SELECT 1 FROM cross_flag_participants cfp
        WHERE cfp.cross_flag_id = ${cross_flags.id}
          AND cfp.submission_id = ${filters.submissionId}
      )`,
    );
  }

  // Cursor: (created_at DESC, id DESC).
  //
  // One row-value comparison, which IS the (created_at, id) lexicographic order
  // the ORDER BY below uses — so it agrees with it by construction. The cursor
  // carries full microsecond precision (`created_at_us`), which is what makes
  // that possible; `decodeCrossFlagCursor` has already refused anything less.
  // See `../keyset.ts` for what the previous millisecond-bucket branches did.
  if (cursor !== null) {
    whereConditions.push(
      keysetAfter(cross_flags.created_at, cross_flags.id, cursor.created_at, cursor.id, 'desc'),
    );
  }

  const rows = await db
    .select({
      id: cross_flags.id,
      heuristic_id: cross_flags.heuristic_id,
      severity: cross_flags.severity,
      confidence: cross_flags.confidence,
      detail: cross_flags.detail,
      created_at: cross_flags.created_at,
      // Cursor-only projection. `created_at` above is a JS `Date` and has
      // already lost the microseconds; this keeps them. The response field
      // still comes from the `Date`, so the API shape is unchanged.
      created_at_us: microTimestamp(cross_flags.created_at),
    })
    .from(cross_flags)
    .where(and(...whereConditions))
    .orderBy(sql`${cross_flags.created_at} DESC`, sql`${cross_flags.id} DESC`)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = encodeCrossFlagCursor({
      created_at: last.created_at_us,
      id: last.id,
    });
  }

  // Fetch participants for all returned cross_flag_ids
  const crossFlagIds = pageRows.map((r) => r.id);
  const participantsMap = await fetchParticipants(db, crossFlagIds, protectedMode);

  const items: CrossFlagSummary[] = pageRows.map((row) => ({
    id: row.id,
    heuristic_id: row.heuristic_id,
    severity: row.severity as Severity,
    confidence: row.confidence,
    participants: participantsMap.get(row.id) ?? [],
    detail: row.detail,
    created_at: row.created_at.toISOString(),
  }));

  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// The exclusion register (spec S20 / §6 Rule 3)
// ---------------------------------------------------------------------------

/**
 * Every repository lineage in this semester whose members were NOT compared.
 *
 * Returned alongside the findings rather than from an endpoint of its own,
 * because it is only meaningful next to them: it is the answer to "why is there
 * nothing here?", and a grader who has to go and ask a second question to get
 * it will not ask.
 *
 * The `heuristic_id` and `severity_min` filters are deliberately NOT applied. An
 * exclusion has neither field — it is one suppression that covers every
 * cross-heuristic at once (both `paste_shared_across_students` and
 * `editing_pattern_clone` consume the same partition), so narrowing the findings
 * to one heuristic does not narrow what was withheld. `submission_id` IS
 * applied: it names one submission, and the honest answer to "show me
 * everything about this submission" includes the comparisons it was kept out of.
 */
export async function listCrossScopeExclusions(
  db: DrizzleDb,
  semesterId: string,
  filters: CrossFlagFilters,
  protectedMode: boolean,
): Promise<CrossScopeExclusionSummary[]> {
  const whereConditions: SQL[] = [eq(cross_flag_exclusions.semester_id, semesterId)];

  if (filters.submissionId !== undefined) {
    // Containment, which is what the GIN index in migration 0031 answers.
    whereConditions.push(
      sql`${cross_flag_exclusions.submission_ids} @> ARRAY[${filters.submissionId}]::uuid[]`,
    );
  }

  const rows = await db
    .select({
      id: cross_flag_exclusions.id,
      reason: cross_flag_exclusions.reason,
      submission_ids: cross_flag_exclusions.submission_ids,
      shared_commits: cross_flag_exclusions.shared_commits,
      shared_sessions: cross_flag_exclusions.shared_sessions,
      excluded_pair_count: cross_flag_exclusions.excluded_pair_count,
      created_at: cross_flag_exclusions.created_at,
    })
    .from(cross_flag_exclusions)
    .where(and(...whereConditions))
    .orderBy(sql`${cross_flag_exclusions.created_at} DESC`, sql`${cross_flag_exclusions.id} DESC`)
    .limit(CROSS_SCOPE_EXCLUSION_LIMIT);

  if (rows.length === 0) return [];

  const allIds = [...new Set(rows.flatMap((r) => r.submission_ids))];
  const memberById = await fetchExclusionMembers(db, allIds, protectedMode);

  return rows.map((row) => ({
    id: row.id,
    // The CHECK constraint admits exactly these two values; the cast keeps the
    // API type honest without a runtime branch that can never be taken.
    reason: row.reason as 'same_repository_lineage' | 'shared_recording_scope',
    // `submission_ids` is stored sorted, so this preserves that order. A member
    // the join could not resolve is NOT dropped — evidence of a withheld
    // comparison must not disappear because a row went missing.
    members: row.submission_ids.map(
      (id) =>
        memberById.get(id) ?? {
          submission_id: id,
          source_filename: id,
          contributors: [],
          student: null,
          assignment: { id: '', assignment_id_str: '' },
        },
    ),
    shared_commits: row.shared_commits,
    shared_sessions: row.shared_sessions,
    excluded_pair_count: row.excluded_pair_count,
    created_at: row.created_at.toISOString(),
  }));
}

async function fetchExclusionMembers(
  db: DrizzleDb,
  submissionIds: string[],
  protectedMode: boolean,
): Promise<Map<string, CrossScopeExclusionMemberRow>> {
  const result = new Map<string, CrossScopeExclusionMemberRow>();
  if (submissionIds.length === 0) return result;

  const rows = await db
    .select({
      submission_id: submissions.id,
      source_filename: submissions.source_filename,
      student_id: roster_entries.id,
      student_sid: roster_entries.sid,
      student_display_name: roster_entries.display_name,
      student_protected_index: roster_entries.protected_index,
      assignment_id: assignments.id,
      assignment_id_str: assignments.assignment_id_str,
    })
    .from(submissions)
    // LEFT for the same reason `fetchParticipants` uses one (D9): a submission
    // with no single owning roster entry must still be listed, unnamed.
    .leftJoin(roster_entries, eq(submissions.student_id, roster_entries.id))
    .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
    .where(inArray(submissions.id, submissionIds));

  // ONE batched query for every member submission, for the same reason
  // `fetchParticipants` batches: a per-member fetch would put an N+1 on a list
  // endpoint.
  const contributorsBySubmission = await fetchContributorsFor(
    db,
    [...new Set(rows.map((r) => r.submission_id))],
    protectedMode,
  );

  for (const row of rows) {
    result.set(row.submission_id, {
      submission_id: row.submission_id,
      source_filename: row.source_filename,
      contributors: contributorsBySubmission.get(row.submission_id) ?? [],
      student:
        row.student_id === null || row.student_sid === null || row.student_display_name === null
          ? null
          : projectStudent(
              {
                id: row.student_id,
                sid: row.student_sid,
                display_name: row.student_display_name,
                protected_index: row.student_protected_index,
              },
              protectedMode,
            ),
      assignment: {
        id: row.assignment_id,
        assignment_id_str: row.assignment_id_str,
      },
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Participant fetch helper (shared with detail.ts)
// ---------------------------------------------------------------------------

export async function fetchParticipants(
  db: DrizzleDb,
  crossFlagIds: string[],
  protectedMode: boolean,
): Promise<Map<string, CrossFlagParticipantRow[]>> {
  const result = new Map<string, CrossFlagParticipantRow[]>();
  if (crossFlagIds.length === 0) return result;

  const rows = await db
    .select({
      cross_flag_id: cross_flag_participants.cross_flag_id,
      submission_id: cross_flag_participants.submission_id,
      supporting_seqs: cross_flag_participants.supporting_seqs,
      student_id: roster_entries.id,
      student_sid: roster_entries.sid,
      student_display_name: roster_entries.display_name,
      student_protected_index: roster_entries.protected_index,
      assignment_id: assignments.id,
      assignment_id_str: assignments.assignment_id_str,
    })
    .from(cross_flag_participants)
    .innerJoin(submissions, eq(cross_flag_participants.submission_id, submissions.id))
    // LEFT, not INNER (D9). `cross_flag_participants` has no student column of
    // its own — the only route to one is through `submissions.student_id` — so
    // an INNER join silently DROPPED any participant whose roster join was
    // empty. A two-party cross flag could then render as one-party, or as
    // zero-party, with no error anywhere: the caller does
    // `participantsMap.get(id) ?? []` and an empty list reads as "no
    // participants" rather than "we lost them". Evidence must not disappear
    // because a submission has no single owning student.
    .leftJoin(roster_entries, eq(submissions.student_id, roster_entries.id))
    .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
    .where(inArray(cross_flag_participants.cross_flag_id, crossFlagIds));

  // ONE batched query for every participant submission on the page, for the
  // same reason the cohort list batches: a per-participant fetch would put an
  // N+1 on a list endpoint.
  const contributorsBySubmission = await fetchContributorsFor(
    db,
    [...new Set(rows.map((r) => r.submission_id))],
    protectedMode,
  );

  for (const row of rows) {
    if (!result.has(row.cross_flag_id)) {
      result.set(row.cross_flag_id, []);
    }
    result.get(row.cross_flag_id)!.push({
      submission_id: row.submission_id,
      contributors: contributorsBySubmission.get(row.submission_id) ?? [],
      student:
        row.student_id === null || row.student_sid === null || row.student_display_name === null
          ? null
          : projectStudent(
              {
                id: row.student_id,
                sid: row.student_sid,
                display_name: row.student_display_name,
                protected_index: row.student_protected_index,
              },
              protectedMode,
            ),
      assignment: {
        id: row.assignment_id,
        assignment_id_str: row.assignment_id_str,
      },
      supporting_seqs: row.supporting_seqs,
    });
  }

  return result;
}
