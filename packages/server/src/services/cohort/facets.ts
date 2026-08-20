/**
 * Cohort facet builder — PRD §8.8.
 *
 * Produces the `facets` block for GET /submissions:
 *   by_severity: { info, low, medium, high }
 *   by_validation: { pass, warn, fail }
 *   by_assignment: { id, label, count }[]
 *
 * Each facet count uses the full WHERE clause MINUS the dimension being
 * faceted (filter-minus-dimension semantics):
 *   - by_severity ignores filters.severityMin
 *   - by_validation ignores filters.validationStatus
 *   - by_assignment ignores filters.assignmentId
 *
 * This means "how many results would there be in each category if I removed
 * this dimension's filter?" — the standard facet UX.
 *
 * Implementation: 3 separate aggregation queries. Each builds a modified
 * copy of the filter without its own dimension, then aggregates.
 */

import { and, eq, isNull, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { submissions, assignments, roster_entries } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { CohortFilters } from './list.js';

export type CohortFacets = {
  by_severity: { info: number; low: number; medium: number; high: number };
  by_validation: { pass: number; warn: number; fail: number };
  by_assignment: { id: string; label: string; count: number }[];
};

const SEVERITIES_AT_OR_ABOVE: Record<string, string[]> = {
  info: ['info', 'low', 'medium', 'high'],
  low: ['low', 'medium', 'high'],
  medium: ['medium', 'high'],
  high: ['high'],
};

// ---------------------------------------------------------------------------
// Core WHERE builder (reusable across all 3 facet queries)
// ---------------------------------------------------------------------------

function buildWhereConditions(
  semesterId: string,
  filters: CohortFilters,
  omitDimensions: Set<'severity' | 'validation' | 'assignment'>,
  protectedMode: boolean,
): SQL[] {
  const conds: SQL[] = [];

  conds.push(eq(submissions.semester_id, semesterId));

  if (!filters.includeSuperseded) {
    conds.push(isNull(submissions.superseded_by_submission_id));
  }

  // assignmentId — omitted for by_assignment facet
  if (!omitDimensions.has('assignment') && filters.assignmentId !== undefined) {
    conds.push(eq(submissions.assignment_id, filters.assignmentId));
  }

  if (filters.studentId !== undefined) {
    // Semi-join on contributors, matching the cohort list exactly (D9). The
    // facets and the list are shown side by side; if they filtered on different
    // notions of "this student's submissions" the counts would contradict the
    // rows beside them.
    const wantedStudentId = filters.studentId;
    conds.push(
      sql`EXISTS (
        SELECT 1 FROM submission_contributors sc
        WHERE sc.submission_id = ${submissions.id}
          AND sc.roster_entry_id = ${wantedStudentId}
      )`,
    );
  }

  // validationStatus — omitted for by_validation facet
  if (!omitDimensions.has('validation') && filters.validationStatus !== undefined) {
    conds.push(eq(submissions.validation_status, filters.validationStatus));
  }

  if (filters.scoreMin !== undefined) {
    conds.push(sql`${submissions.score_total} >= ${filters.scoreMin}`);
  }
  if (filters.scoreMax !== undefined) {
    conds.push(sql`${submissions.score_total} <= ${filters.scoreMax}`);
  }

  if (filters.recorderVersion !== undefined) {
    conds.push(eq(submissions.recorder_version, filters.recorderVersion));
  }

  // severityMin — omitted for by_severity facet
  if (!omitDimensions.has('severity') && filters.severityMin !== undefined) {
    const q = SEVERITIES_AT_OR_ABOVE[filters.severityMin];
    if (q !== undefined) {
      if (q.length === 1) {
        conds.push(eq(submissions.score_max_severity, q[0]!));
      } else {
        conds.push(inArray(submissions.score_max_severity, q));
      }
    }
  }

  if (filters.flagIds !== undefined && filters.flagIds.length > 0) {
    const flagIdsArr = filters.flagIds;
    conds.push(
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
    conds.push(
      sql`EXISTS (SELECT 1 FROM flags f WHERE f.submission_id = ${submissions.id} AND f.heuristic_id = 'external_edits')`,
    );
  } else if (filters.hasExternalEdits === false) {
    conds.push(
      sql`NOT EXISTS (SELECT 1 FROM flags f WHERE f.submission_id = ${submissions.id} AND f.heuristic_id = 'external_edits')`,
    );
  }

  if (filters.hasLargePaste === true) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM flags f WHERE f.submission_id = ${submissions.id} AND f.heuristic_id = 'large_paste')`,
    );
  } else if (filters.hasLargePaste === false) {
    conds.push(
      sql`NOT EXISTS (SELECT 1 FROM flags f WHERE f.submission_id = ${submissions.id} AND f.heuristic_id = 'large_paste')`,
    );
  }

  // q: free-text ILIKE on roster_entries.display_name or sid.
  // Disabled in protected mode (it would be a name->Student-N lookup oracle).
  if (!protectedMode && filters.q !== undefined && filters.q.trim() !== '') {
    const pattern = `%${filters.q.trim()}%`;
    conds.push(
      or(
        sql`${roster_entries.display_name} ILIKE ${pattern}`,
        sql`${roster_entries.sid} ILIKE ${pattern}`,
      )!,
    );
  }

  return conds;
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

export async function buildFacets(
  db: DrizzleDb,
  semesterId: string,
  filters: CohortFilters,
  protectedMode: boolean = false,
): Promise<CohortFacets> {
  // --- by_severity: group by score_max_severity, ignoring severityMin filter ---
  const severityRows = await db
    .select({
      severity: submissions.score_max_severity,
      cnt: sql<number>`COUNT(*)::int`,
    })
    .from(submissions)
    .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
    // LEFT (D9): an INNER join drops a submission with no single owning roster
    // entry out of the facet counts, so the totals silently disagree with the
    // list beside them. Still COUNT(*) over one row per submission — the
    // student filter is an EXISTS, so nothing fans out.
    .leftJoin(roster_entries, eq(submissions.student_id, roster_entries.id))
    .where(and(...buildWhereConditions(semesterId, filters, new Set(['severity']), protectedMode)))
    .groupBy(submissions.score_max_severity);

  const bySeverity = { info: 0, low: 0, medium: 0, high: 0 };
  for (const r of severityRows) {
    if (r.severity === 'info') bySeverity.info = r.cnt;
    else if (r.severity === 'low') bySeverity.low = r.cnt;
    else if (r.severity === 'medium') bySeverity.medium = r.cnt;
    else if (r.severity === 'high') bySeverity.high = r.cnt;
  }

  // --- by_validation: group by validation_status, ignoring validationStatus filter ---
  const validationRows = await db
    .select({
      status: submissions.validation_status,
      cnt: sql<number>`COUNT(*)::int`,
    })
    .from(submissions)
    .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
    .leftJoin(roster_entries, eq(submissions.student_id, roster_entries.id))
    .where(
      and(...buildWhereConditions(semesterId, filters, new Set(['validation']), protectedMode)),
    )
    .groupBy(submissions.validation_status);

  const byValidation = { pass: 0, warn: 0, fail: 0 };
  for (const r of validationRows) {
    if (r.status === 'pass') byValidation.pass = r.cnt;
    else if (r.status === 'warn') byValidation.warn = r.cnt;
    else if (r.status === 'fail') byValidation.fail = r.cnt;
    // 'pending' is excluded from facets (it's not a stable terminal state)
  }

  // --- by_assignment: group by assignment, ignoring assignmentId filter ---
  const assignmentRows = await db
    .select({
      id: assignments.id,
      label: assignments.label,
      cnt: sql<number>`COUNT(*)::int`,
    })
    .from(submissions)
    .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
    .leftJoin(roster_entries, eq(submissions.student_id, roster_entries.id))
    .where(
      and(...buildWhereConditions(semesterId, filters, new Set(['assignment']), protectedMode)),
    )
    .groupBy(assignments.id, assignments.label)
    .orderBy(sql`COUNT(*) DESC`);

  const byAssignment = assignmentRows.map((r) => ({
    id: r.id,
    label: r.label,
    count: r.cnt,
  }));

  return {
    by_severity: bySeverity,
    by_validation: byValidation,
    by_assignment: byAssignment,
  };
}
