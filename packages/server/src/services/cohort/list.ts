/**
 * Cohort list query builder — PRD §8.8.
 *
 * Builds the primary GET /semesters/{id}/submissions query with:
 * - Filters (assignmentId, studentId, flagIds, severityMin, validationStatus,
 *   scoreMin, scoreMax, hasExternalEdits, hasLargePaste, recorderVersion,
 *   includeSuperseded, q)
 * - Sort (score_desc | score_asc | ingested_desc | student_asc | student_desc | assignment_asc)
 * - Cursor pagination: multi-field (sort_key + id) tuple encoded as base64 JSON
 * - Flag counts and top 3 flags per submission (secondary query, keyed on returned ids)
 *
 * Performance notes:
 * - The default sort (score_desc, includeSuperseded=false) uses the partial
 *   covering index `submissions_cohort_idx` for the WHERE clause on
 *   superseded_by_submission_id IS NULL.
 * - total_count is a separate COUNT(*) with the same WHERE (O(N) — documented
 *   trade-off; acceptable for current scale per V34).
 * - top_flags uses ROW_NUMBER() OVER (PARTITION BY submission_id ...) to pick
 *   the 3 highest-severity flags per submission in a single query.
 */

import { and, or, eq, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { submissions, assignments, roster_entries } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { Severity } from '@provenance/analysis-core/heuristics/types.js';
import { SEVERITY_RANK } from '../scoring/denorm.js';
import { projectStudent } from '../protect.js';
import { fetchContributorsFor } from '../contributors/fetch-contributors.js';
import type { SubmissionContributor } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CohortFilters = {
  assignmentId?: string;
  studentId?: string;
  flagIds?: string[]; // heuristic ids; OR semantics
  severityMin?: Severity;
  validationStatus?: 'pass' | 'warn' | 'fail';
  scoreMin?: number;
  scoreMax?: number;
  hasExternalEdits?: boolean;
  hasLargePaste?: boolean;
  recorderVersion?: string;
  includeSuperseded?: boolean; // default false
  q?: string; // free-text on display_name or sid
};

export type CohortSort =
  | 'score_desc'
  | 'score_asc'
  | 'ingested_desc'
  | 'student_asc'
  | 'student_desc'
  | 'assignment_asc';

// Cursor variants — one shape per sort key.
// Encoded as base64url JSON for opacity to callers.
export type CohortCursor =
  | { kind: 'score'; score_total: number; id: string }
  | { kind: 'wall'; wall: string; id: string }
  | { kind: 'display_name'; display_name: string; id: string }
  | { kind: 'protected_index'; protected_index: number; id: string }
  | { kind: 'assignment_label'; assignment_label: string; id: string };

export type SubmissionRow = {
  id: string;
  semester_id: string;
  assignment: { id: string; assignment_id_str: string; label: string };
  /**
   * The submitter of record, or null when no single roster entry owns this
   * submission (D9). Mirrors `SubmissionRowSchema.student` in
   * `@provenance/shared`.
   */
  student: { id: string; sid: string; display_name: string } | null;
  /** Everyone this submission is attributable to. Exactly one entry for solo. */
  contributors: SubmissionContributor[];
  score_total: number;
  score_max_severity: Severity;
  flag_counts: { info: number; low: number; medium: number; high: number };
  top_flags: { heuristic_id: string; severity: Severity }[];
  total_active_ms: number | null;
  total_idle_ms: number | null;
  validation_status: string;
  ingested_at: string;
  recorder_version: string;
  superseded: boolean;
  recompute_status: string;
};

// ---------------------------------------------------------------------------
// Cursor encode / decode
// ---------------------------------------------------------------------------

export function encodeCursor(cursor: CohortCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(encoded: string): CohortCursor | null {
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p['id'] !== 'string') return null;

    const kind = p['kind'];
    if (kind === 'score' && typeof p['score_total'] === 'number') {
      return { kind: 'score', score_total: p['score_total'], id: p['id'] };
    }
    if (kind === 'wall' && typeof p['wall'] === 'string') {
      return { kind: 'wall', wall: p['wall'], id: p['id'] };
    }
    if (kind === 'display_name' && typeof p['display_name'] === 'string') {
      return { kind: 'display_name', display_name: p['display_name'], id: p['id'] };
    }
    if (kind === 'protected_index' && typeof p['protected_index'] === 'number') {
      return { kind: 'protected_index', protected_index: p['protected_index'], id: p['id'] };
    }
    if (kind === 'assignment_label' && typeof p['assignment_label'] === 'string') {
      return { kind: 'assignment_label', assignment_label: p['assignment_label'], id: p['id'] };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Severity ordering helper (for severity_min filter)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
};

// SEVERITIES_AT_OR_ABOVE (V46 and earlier): kept inline in the WHERE clause
// as an OR-expansion via inArray. P1-1a replaces this with a single
// `severity_rank >= N` range predicate using SEVERITY_RANK from
// services/scoring/denorm.ts so the partial cohort index can answer it
// with one comparison.

// ---------------------------------------------------------------------------
// Main query function
// ---------------------------------------------------------------------------

export async function listCohortSubmissions(
  db: DrizzleDb,
  semesterId: string,
  filters: CohortFilters,
  sort: CohortSort,
  cursor: CohortCursor | null,
  limit: number,
  protectedMode: boolean,
): Promise<{ items: SubmissionRow[]; nextCursor: string | null; totalCount: number }> {
  // Build WHERE conditions
  const whereConditions: SQL[] = [];

  whereConditions.push(eq(submissions.semester_id, semesterId));

  // include_superseded (default false)
  if (!filters.includeSuperseded) {
    whereConditions.push(isNull(submissions.superseded_by_submission_id));
  }

  // assignmentId
  if (filters.assignmentId !== undefined) {
    whereConditions.push(eq(submissions.assignment_id, filters.assignmentId));
  }

  // studentId
  //
  // A semi-join on `submission_contributors`, NOT `submissions.student_id`
  // (D9). Filtering on the scalar column would show a group submission only to
  // the partner who happened to submit it — the other partner would filter
  // their own work out of view. Every existing solo submission has exactly one
  // contributor row naming its `student_id`, so this matches precisely the same
  // rows it always did for them.
  //
  // EXISTS rather than a join: a join would emit one row per matching
  // contributor and inflate both the page and COUNT(*).
  if (filters.studentId !== undefined) {
    const wantedStudentId = filters.studentId;
    whereConditions.push(
      sql`EXISTS (
        SELECT 1 FROM submission_contributors sc
        WHERE sc.submission_id = ${submissions.id}
          AND sc.roster_entry_id = ${wantedStudentId}
      )`,
    );
  }

  // validationStatus
  if (filters.validationStatus !== undefined) {
    whereConditions.push(eq(submissions.validation_status, filters.validationStatus));
  }

  // scoreMin / scoreMax
  if (filters.scoreMin !== undefined) {
    whereConditions.push(sql`${submissions.score_total} >= ${filters.scoreMin}`);
  }
  if (filters.scoreMax !== undefined) {
    whereConditions.push(sql`${submissions.score_total} <= ${filters.scoreMax}`);
  }

  // recorderVersion
  if (filters.recorderVersion !== undefined) {
    whereConditions.push(eq(submissions.recorder_version, filters.recorderVersion));
  }

  // severityMin: submission must have score_max_severity >= severityMin.
  // Uses the denormalized severity_rank column (P1-1a) so this is a single
  // range predicate that the partial cohort index can answer directly.
  if (filters.severityMin !== undefined) {
    const minRank = SEVERITY_RANK[filters.severityMin];
    whereConditions.push(sql`${submissions.severity_rank} >= ${minRank}`);
  }

  // flagIds: EXISTS subquery on flags WHERE heuristic_id IN (flagIds)
  if (filters.flagIds !== undefined && filters.flagIds.length > 0) {
    const flagIdsArr = filters.flagIds;
    whereConditions.push(
      sql`EXISTS (
        SELECT 1 FROM flags f
        WHERE f.submission_id = ${submissions.id}
          AND f.heuristic_id IN (${sql.join(
            flagIdsArr.map((id) => sql`${id}`),
            sql`, `,
          )})
      )`,
    );
  }

  // hasExternalEdits: EXISTS on flags with heuristic_id='external_edits'
  if (filters.hasExternalEdits === true) {
    whereConditions.push(
      sql`EXISTS (
        SELECT 1 FROM flags f
        WHERE f.submission_id = ${submissions.id}
          AND f.heuristic_id = 'external_edits'
      )`,
    );
  } else if (filters.hasExternalEdits === false) {
    whereConditions.push(
      sql`NOT EXISTS (
        SELECT 1 FROM flags f
        WHERE f.submission_id = ${submissions.id}
          AND f.heuristic_id = 'external_edits'
      )`,
    );
  }

  // hasLargePaste: EXISTS on flags with heuristic_id='large_paste'
  if (filters.hasLargePaste === true) {
    whereConditions.push(
      sql`EXISTS (
        SELECT 1 FROM flags f
        WHERE f.submission_id = ${submissions.id}
          AND f.heuristic_id = 'large_paste'
      )`,
    );
  } else if (filters.hasLargePaste === false) {
    whereConditions.push(
      sql`NOT EXISTS (
        SELECT 1 FROM flags f
        WHERE f.submission_id = ${submissions.id}
          AND f.heuristic_id = 'large_paste'
      )`,
    );
  }

  // q: free-text ILIKE on roster_entries.display_name or sid.
  // Disabled in protected mode (it would be a name->Student-N lookup oracle).
  if (!protectedMode && filters.q !== undefined && filters.q.trim() !== '') {
    const pattern = `%${filters.q.trim()}%`;
    whereConditions.push(
      or(
        sql`${roster_entries.display_name} ILIKE ${pattern}`,
        sql`${roster_entries.sid} ILIKE ${pattern}`,
      )!,
    );
  }

  // Apply cursor-based pagination based on sort
  if (cursor !== null) {
    const cursorCond = buildCursorCondition(sort, cursor, protectedMode);
    if (cursorCond !== null) {
      whereConditions.push(cursorCond);
    }
  }

  const whereClause = and(...whereConditions);

  // Build ORDER BY
  const orderBy = buildOrderBy(sort, protectedMode);

  // Execute main query (limit + 1 to detect next page).
  // P1-1a: flag_counts and top_flags read directly from denormalized jsonb
  // columns — the two correlated sub-queries that dominated p95 are gone.
  const rows = await db
    .select({
      id: submissions.id,
      semester_id: submissions.semester_id,
      assignment_id: submissions.assignment_id,
      student_id: submissions.student_id,
      score_total: submissions.score_total,
      score_max_severity: submissions.score_max_severity,
      flag_counts: submissions.flag_counts,
      top_flags: submissions.top_flags,
      total_active_ms: submissions.total_active_ms,
      total_idle_ms: submissions.total_idle_ms,
      validation_status: submissions.validation_status,
      ingested_at: submissions.ingested_at,
      recorder_version: submissions.recorder_version,
      superseded_by_submission_id: submissions.superseded_by_submission_id,
      recompute_status: submissions.recompute_status,
      // From assignments JOIN
      assignment_assignment_id_str: assignments.assignment_id_str,
      assignment_label: assignments.label,
      // From roster_entries JOIN
      student_sid: roster_entries.sid,
      student_display_name: roster_entries.display_name,
      student_protected_index: roster_entries.protected_index,
    })
    .from(submissions)
    .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
    // LEFT, not INNER (D9). `submissions.student_id` is nullable now, and an
    // INNER join would make a submission with no single owning roster entry
    // DISAPPEAR from the cohort list entirely — no row, no error, and a
    // `total_count` that silently disagrees with the page. The roster columns
    // become nullable here and `student` carries the absence.
    .leftJoin(roster_entries, eq(submissions.student_id, roster_entries.id))
    .where(whereClause)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // Build the nextCursor from the last item if there are more results
  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    const c = buildCursorFromRow(sort, last, protectedMode);
    nextCursor = encodeCursor(c);
  }

  // One batched fetch of every contributor on this page (D9). Not per row —
  // the cohort list is the query the denormalised columns exist to keep fast,
  // and an N+1 here would undo that.
  const contributorsBySubmission = await fetchContributorsFor(
    db,
    pageRows.map((r) => r.id),
    protectedMode,
  );

  // Assemble SubmissionRow items directly from the row's jsonb columns.
  // The defaults in migration 0014 (empty counts / empty array) cover
  // freshly-ingested rows that haven't been scored yet.
  const items: SubmissionRow[] = pageRows.map((row) => ({
    id: row.id,
    semester_id: row.semester_id,
    assignment: {
      id: row.assignment_id,
      assignment_id_str: row.assignment_assignment_id_str,
      label: row.assignment_label,
    },
    // Null when no single roster entry owns this submission. The LEFT join
    // above is what makes that reachable instead of dropping the row.
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
    contributors: contributorsBySubmission.get(row.id) ?? [],
    score_total: row.score_total,
    score_max_severity: row.score_max_severity as Severity,
    flag_counts: row.flag_counts as { info: number; low: number; medium: number; high: number },
    top_flags: row.top_flags as { heuristic_id: string; severity: Severity }[],
    total_active_ms: row.total_active_ms,
    total_idle_ms: row.total_idle_ms,
    validation_status: row.validation_status,
    ingested_at: row.ingested_at.toISOString(),
    recorder_version: row.recorder_version,
    superseded: row.superseded_by_submission_id !== null,
    recompute_status: row.recompute_status,
  }));

  // COUNT query (same WHERE minus cursor condition)
  const countConditions: SQL[] = [];
  countConditions.push(eq(submissions.semester_id, semesterId));
  if (!filters.includeSuperseded) {
    countConditions.push(isNull(submissions.superseded_by_submission_id));
  }
  if (filters.assignmentId !== undefined) {
    countConditions.push(eq(submissions.assignment_id, filters.assignmentId));
  }
  if (filters.studentId !== undefined) {
    const wantedStudentId = filters.studentId;
    countConditions.push(
      sql`EXISTS (
        SELECT 1 FROM submission_contributors sc
        WHERE sc.submission_id = ${submissions.id}
          AND sc.roster_entry_id = ${wantedStudentId}
      )`,
    );
  }
  if (filters.validationStatus !== undefined) {
    countConditions.push(eq(submissions.validation_status, filters.validationStatus));
  }
  if (filters.scoreMin !== undefined) {
    countConditions.push(sql`${submissions.score_total} >= ${filters.scoreMin}`);
  }
  if (filters.scoreMax !== undefined) {
    countConditions.push(sql`${submissions.score_total} <= ${filters.scoreMax}`);
  }
  if (filters.recorderVersion !== undefined) {
    countConditions.push(eq(submissions.recorder_version, filters.recorderVersion));
  }
  if (filters.severityMin !== undefined) {
    const minRank = SEVERITY_RANK[filters.severityMin];
    countConditions.push(sql`${submissions.severity_rank} >= ${minRank}`);
  }
  if (filters.flagIds !== undefined && filters.flagIds.length > 0) {
    const flagIdsArr = filters.flagIds;
    countConditions.push(
      sql`EXISTS (
        SELECT 1 FROM flags f
        WHERE f.submission_id = ${submissions.id}
          AND f.heuristic_id IN (${sql.join(
            flagIdsArr.map((id) => sql`${id}`),
            sql`, `,
          )})
      )`,
    );
  }
  if (filters.hasExternalEdits === true) {
    countConditions.push(
      sql`EXISTS (SELECT 1 FROM flags f WHERE f.submission_id = ${submissions.id} AND f.heuristic_id = 'external_edits')`,
    );
  } else if (filters.hasExternalEdits === false) {
    countConditions.push(
      sql`NOT EXISTS (SELECT 1 FROM flags f WHERE f.submission_id = ${submissions.id} AND f.heuristic_id = 'external_edits')`,
    );
  }
  if (filters.hasLargePaste === true) {
    countConditions.push(
      sql`EXISTS (SELECT 1 FROM flags f WHERE f.submission_id = ${submissions.id} AND f.heuristic_id = 'large_paste')`,
    );
  } else if (filters.hasLargePaste === false) {
    countConditions.push(
      sql`NOT EXISTS (SELECT 1 FROM flags f WHERE f.submission_id = ${submissions.id} AND f.heuristic_id = 'large_paste')`,
    );
  }
  // q: disabled in protected mode (oracle closure — same guard as main query).
  if (!protectedMode && filters.q !== undefined && filters.q.trim() !== '') {
    const pattern = `%${filters.q.trim()}%`;
    countConditions.push(
      or(
        sql`${roster_entries.display_name} ILIKE ${pattern}`,
        sql`${roster_entries.sid} ILIKE ${pattern}`,
      )!,
    );
  }

  const [countResult] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(submissions)
    .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
    // LEFT for the same reason as the page query — the two must agree, or the
    // pager reports a count it can never reach. Still COUNT(*) over one row per
    // submission: the contributor filter above is an EXISTS, so nothing fans out.
    .leftJoin(roster_entries, eq(submissions.student_id, roster_entries.id))
    .where(and(...countConditions));

  const totalCount = countResult?.count ?? 0;

  return { items, nextCursor, totalCount };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * The name the `student_asc` / `student_desc` sorts order by.
 *
 * `COALESCE(..., '')` because the roster join is LEFT since D9: a submission
 * with no single owning roster entry has a NULL display name, and a keyset
 * predicate of the form `display_name > $cursor` evaluates to NULL — never
 * true — for such a row, so it would be silently unreachable on every page
 * after the first.
 *
 * Provably identity for every row that existed before the cut-over:
 * `roster_entries.display_name` is NOT NULL, and the join was INNER, so a
 * pre-0029 row can never have produced a NULL here. Solo ordering is unchanged
 * byte for byte.
 *
 * KNOWN GAP, deliberately not closed: the protected-mode sorts order by
 * `roster_entries.protected_index`, which was ALREADY nullable before this
 * change, and the same keyset argument applies to a row whose index is unset.
 * Coalescing it would move existing NULL-index rows in the ordering, which is a
 * behaviour change to shipped data that this task has no mandate for. No
 * current ingest path produces a null-roster submission, so the combination is
 * unreachable today.
 */
const STUDENT_SORT_NAME = sql`COALESCE(${roster_entries.display_name}, '')`;

function buildOrderBy(sort: CohortSort, protectedMode: boolean): SQL[] {
  switch (sort) {
    case 'score_desc':
      return [sql`${submissions.score_total} DESC`, sql`${submissions.id} DESC`];
    case 'score_asc':
      return [sql`${submissions.score_total} ASC`, sql`${submissions.id} ASC`];
    case 'ingested_desc':
      return [sql`${submissions.ingested_at} DESC`, sql`${submissions.id} DESC`];
    case 'student_asc':
      return protectedMode
        ? [sql`${roster_entries.protected_index} ASC`, sql`${submissions.id} ASC`]
        : [sql`${STUDENT_SORT_NAME} ASC`, sql`${submissions.id} ASC`];
    case 'student_desc':
      return protectedMode
        ? [sql`${roster_entries.protected_index} DESC`, sql`${submissions.id} DESC`]
        : [sql`${STUDENT_SORT_NAME} DESC`, sql`${submissions.id} DESC`];
    case 'assignment_asc':
      return [sql`${assignments.label} ASC`, sql`${submissions.id} ASC`];
  }
}

function buildCursorCondition(
  sort: CohortSort,
  cursor: CohortCursor,
  protectedMode: boolean,
): SQL | null {
  switch (sort) {
    case 'score_desc': {
      if (cursor.kind !== 'score') return null;
      // score_desc: next page has score_total < cursor OR (score_total = cursor AND id < cursor_id)
      return or(
        sql`${submissions.score_total} < ${cursor.score_total}`,
        and(
          sql`${submissions.score_total} = ${cursor.score_total}`,
          sql`${submissions.id} < ${cursor.id}`,
        ),
      )!;
    }
    case 'score_asc': {
      if (cursor.kind !== 'score') return null;
      // score_asc: next page has score_total > cursor OR (score_total = cursor AND id > cursor_id)
      return or(
        sql`${submissions.score_total} > ${cursor.score_total}`,
        and(
          sql`${submissions.score_total} = ${cursor.score_total}`,
          sql`${submissions.id} > ${cursor.id}`,
        ),
      )!;
    }
    case 'ingested_desc': {
      if (cursor.kind !== 'wall') return null;
      const cursorDate = new Date(cursor.wall);
      if (isNaN(cursorDate.getTime())) return null;
      // Use the millisecond+1 trick from V33 to handle µs precision
      const nextMs = new Date(cursorDate.getTime() + 1);
      // Pass dates as ISO strings — postgres-js cannot serialize Date objects
      // when they originate from js Date instances in sql`` template params.
      const cursorDateStr = cursorDate.toISOString();
      const nextMsStr = nextMs.toISOString();
      return or(
        sql`${submissions.ingested_at} < ${cursorDateStr}::timestamptz`,
        and(
          sql`${submissions.ingested_at} >= ${cursorDateStr}::timestamptz`,
          sql`${submissions.ingested_at} < ${nextMsStr}::timestamptz`,
          sql`${submissions.id} < ${cursor.id}`,
        ),
      )!;
    }
    case 'student_asc': {
      if (protectedMode) {
        if (cursor.kind !== 'protected_index') return null;
        return or(
          sql`${roster_entries.protected_index} > ${cursor.protected_index}`,
          and(
            sql`${roster_entries.protected_index} = ${cursor.protected_index}`,
            sql`${submissions.id} > ${cursor.id}`,
          ),
        )!;
      }
      if (cursor.kind !== 'display_name') return null;
      return or(
        sql`${STUDENT_SORT_NAME} > ${cursor.display_name}`,
        and(
          sql`${STUDENT_SORT_NAME} = ${cursor.display_name}`,
          sql`${submissions.id} > ${cursor.id}`,
        ),
      )!;
    }
    case 'student_desc': {
      if (protectedMode) {
        if (cursor.kind !== 'protected_index') return null;
        return or(
          sql`${roster_entries.protected_index} < ${cursor.protected_index}`,
          and(
            sql`${roster_entries.protected_index} = ${cursor.protected_index}`,
            sql`${submissions.id} < ${cursor.id}`,
          ),
        )!;
      }
      if (cursor.kind !== 'display_name') return null;
      return or(
        sql`${STUDENT_SORT_NAME} < ${cursor.display_name}`,
        and(
          sql`${STUDENT_SORT_NAME} = ${cursor.display_name}`,
          sql`${submissions.id} < ${cursor.id}`,
        ),
      )!;
    }
    case 'assignment_asc': {
      if (cursor.kind !== 'assignment_label') return null;
      return or(
        sql`${assignments.label} > ${cursor.assignment_label}`,
        and(
          sql`${assignments.label} = ${cursor.assignment_label}`,
          sql`${submissions.id} > ${cursor.id}`,
        ),
      )!;
    }
  }
}

function buildCursorFromRow(
  sort: CohortSort,
  row: {
    id: string;
    score_total: number;
    ingested_at: Date;
    /** Nullable since the roster join became LEFT (D9); mirrors STUDENT_SORT_NAME. */
    student_display_name: string | null;
    student_protected_index: number | null;
    assignment_label: string;
  },
  protectedMode: boolean,
): CohortCursor {
  switch (sort) {
    case 'score_desc':
    case 'score_asc':
      return { kind: 'score', score_total: row.score_total, id: row.id };
    case 'ingested_desc':
      return { kind: 'wall', wall: row.ingested_at.toISOString(), id: row.id };
    case 'student_asc':
    case 'student_desc':
      return protectedMode
        ? { kind: 'protected_index', protected_index: row.student_protected_index ?? 0, id: row.id }
        : // `?? ''` mirrors STUDENT_SORT_NAME exactly — the cursor value and the
          // predicate it is compared against must be the same expression.
          { kind: 'display_name', display_name: row.student_display_name ?? '', id: row.id };
    case 'assignment_asc':
      return { kind: 'assignment_label', assignment_label: row.assignment_label, id: row.id };
  }
}

// Re-export for use in tests
export { SEVERITY_ORDER };
