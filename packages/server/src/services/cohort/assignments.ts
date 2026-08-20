/**
 * Assignments listing service — PRD §8.5.
 *
 * GET /semesters/{semesterId}/assignments
 *
 * Lists assignments for a semester with on-demand aggregated stats:
 *   submission_count, distinct_students, mean_score, median_score, p95_score,
 *   fail_count, warn_count
 *
 * Stats are computed via SQL aggregation (no caching). Acceptable for current
 * scale — assignments per semester is typically O(10-50).
 */

import { eq, and, sql } from 'drizzle-orm';
import { assignments } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { Errors } from '../../api/v1/errors.js';
import {
  parseIngestScopeConfig,
  type IngestScopeConfig,
} from '../ingest/gradescope/repo-scopes.js';

export type AssignmentSummary = {
  id: string;
  semester_id: string;
  assignment_id_str: string;
  label: string;
  sort_order: number;
  submission_count: number;
  distinct_students: number;
  mean_score: number;
  median_score: number;
  p95_score: number;
  fail_count: number;
  warn_count: number;
  /**
   * The persisted ingest-scope default (`assignments.ingest_scope`). Always
   * narrowed through `parseIngestScopeConfig` before it leaves the service, so
   * a hand-written or pre-migration-0026 jsonb value can never reach the API as
   * something the response schema would reject.
   */
  ingest_scope: IngestScopeConfig;
};

export async function listAssignments(
  db: DrizzleDb,
  semesterId: string,
): Promise<AssignmentSummary[]> {
  // Fetch all assignments for the semester
  const assignmentRows = await db
    .select({
      id: assignments.id,
      semester_id: assignments.semester_id,
      assignment_id_str: assignments.assignment_id_str,
      label: assignments.label,
      sort_order: assignments.sort_order,
      ingest_scope: assignments.ingest_scope,
    })
    .from(assignments)
    .where(eq(assignments.semester_id, semesterId))
    .orderBy(assignments.sort_order, assignments.label);

  if (assignmentRows.length === 0) return [];

  // Aggregate stats per assignment using a single query with FILTER clauses
  // Only count non-superseded submissions (same as cohort list default)
  const statsRows = await db.execute<{
    assignment_id: string;
    submission_count: number;
    distinct_students: number;
    mean_score: number | null;
    median_score: number | null;
    p95_score: number | null;
    fail_count: number;
    warn_count: number;
  }>(
    sql`
      WITH live AS (
        SELECT id, assignment_id, score_total, validation_status
        FROM submissions
        WHERE semester_id = ${semesterId}
          AND superseded_by_submission_id IS NULL
      ),
      -- distinct_students counts PEOPLE, via submission_contributors (D9), not
      -- COUNT(DISTINCT submissions.student_id). The scalar column names only
      -- the submitter, so a group submission would have counted one person and
      -- hidden the rest. Every pre-0029 submission has exactly one contributor
      -- row naming its student_id, so this returns the identical number for all
      -- existing data.
      --
      -- Computed in its OWN aggregate and joined back, deliberately: joining
      -- contributors into the main aggregate would fan each submission out to
      -- one row per contributor and silently weight COUNT(*), AVG(score_total)
      -- and both percentiles by group size.
      contrib AS (
        SELECT l.assignment_id,
               COUNT(DISTINCT sc.roster_entry_id)::int AS distinct_students
        FROM live l
        JOIN submission_contributors sc ON sc.submission_id = l.id
        GROUP BY l.assignment_id
      )
      SELECT
        l.assignment_id,
        COUNT(*)::int AS submission_count,
        COALESCE(c.distinct_students, 0) AS distinct_students,
        AVG(l.score_total) AS mean_score,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY l.score_total) AS median_score,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY l.score_total) AS p95_score,
        COUNT(*) FILTER (WHERE l.validation_status = 'fail')::int AS fail_count,
        COUNT(*) FILTER (WHERE l.validation_status = 'warn')::int AS warn_count
      FROM live l
      LEFT JOIN contrib c ON c.assignment_id = l.assignment_id
      GROUP BY l.assignment_id, c.distinct_students
    `,
  );

  // Build a map from assignment_id -> stats
  type StatsMap = {
    submission_count: number;
    distinct_students: number;
    mean_score: number;
    median_score: number;
    p95_score: number;
    fail_count: number;
    warn_count: number;
  };

  const statsMap = new Map<string, StatsMap>();
  for (const r of statsRows) {
    statsMap.set(r.assignment_id, {
      submission_count: r.submission_count ?? 0,
      distinct_students: r.distinct_students ?? 0,
      mean_score: r.mean_score != null ? Number(r.mean_score) : 0,
      median_score: r.median_score != null ? Number(r.median_score) : 0,
      p95_score: r.p95_score != null ? Number(r.p95_score) : 0,
      fail_count: r.fail_count ?? 0,
      warn_count: r.warn_count ?? 0,
    });
  }

  return assignmentRows.map((a) => {
    const stats = statsMap.get(a.id);
    return {
      id: a.id,
      semester_id: a.semester_id,
      assignment_id_str: a.assignment_id_str,
      label: a.label,
      sort_order: a.sort_order,
      submission_count: stats?.submission_count ?? 0,
      distinct_students: stats?.distinct_students ?? 0,
      mean_score: stats?.mean_score ?? 0,
      median_score: stats?.median_score ?? 0,
      p95_score: stats?.p95_score ?? 0,
      fail_count: stats?.fail_count ?? 0,
      warn_count: stats?.warn_count ?? 0,
      ingest_scope: parseIngestScopeConfig(a.ingest_scope),
    };
  });
}

// ---------------------------------------------------------------------------
// PATCH /semesters/:semesterId/assignments/:assignmentId — PRD §8.5.
//
// Updates label, sort_order and/or ingest_scope on a single assignment.
// Validates that the assignment belongs to the semester before writing — a
// wrong-semester id resolves to 404 rather than silently editing a sibling
// course's row.
//
// `ingest_scope` is REPLACED wholesale, never merged: the modes carry different
// meaningful fields (`path_glob` belongs only to `repo_scoped`), so merging
// would let a switch to `repo_whole` silently retain a stale glob. The route
// validates the object before it gets here, so what is written is always a
// complete, self-consistent config.
// ---------------------------------------------------------------------------

export type UpdateAssignmentInput = {
  label?: string;
  sort_order?: number;
  ingest_scope?: IngestScopeConfig;
};

export async function updateAssignment(
  db: DrizzleDb,
  semesterId: string,
  assignmentId: string,
  input: UpdateAssignmentInput,
): Promise<AssignmentSummary> {
  const existing = await db
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.id, assignmentId), eq(assignments.semester_id, semesterId)))
    .limit(1);
  if (existing.length === 0) throw Errors.notFound();

  const updates: { label?: string; sort_order?: number; ingest_scope?: IngestScopeConfig } = {};
  if (input.label !== undefined) updates.label = input.label;
  if (input.sort_order !== undefined) updates.sort_order = input.sort_order;
  if (input.ingest_scope !== undefined) updates.ingest_scope = input.ingest_scope;

  if (Object.keys(updates).length > 0) {
    await db.update(assignments).set(updates).where(eq(assignments.id, assignmentId));
  }

  // Return the assignment with the same summary shape the list endpoint emits
  // so the UI can replace the row in-place without a separate refetch.
  const refreshed = await listAssignments(db, semesterId);
  const updated = refreshed.find((a) => a.id === assignmentId);
  if (!updated) throw Errors.notFound();
  return updated;
}

// ---------------------------------------------------------------------------
// POST /semesters/:semesterId/assignments — manual assignment creation.
//
// Inserts a new assignment row. A brand-new assignment has no submissions, so
// all aggregate stats are zero. A blank label defaults to assignment_id_str
// (matches the ingest upsert in create-submission.ts). Relies on the
// (semester_id, assignment_id_str) unique constraint: an insert that hits it
// is DO NOTHING → empty returning → 409.
// ---------------------------------------------------------------------------

export type CreateAssignmentInput = {
  assignmentIdStr: string;
  label?: string;
  /** Omitted ⇒ the column default, `self_identifying` / `ingest_all`. */
  ingest_scope?: IngestScopeConfig;
};

export async function createAssignment(
  db: DrizzleDb,
  semesterId: string,
  input: CreateAssignmentInput,
): Promise<AssignmentSummary> {
  const label =
    input.label !== undefined && input.label.trim() !== '' ? input.label : input.assignmentIdStr;

  const inserted = await db
    .insert(assignments)
    .values({
      semester_id: semesterId,
      assignment_id_str: input.assignmentIdStr,
      label,
      sort_order: 0,
      // Left unset when not declared, so the column DEFAULT applies rather than
      // this code restating it — one source of truth for what the default is.
      ...(input.ingest_scope !== undefined ? { ingest_scope: input.ingest_scope } : {}),
    })
    .onConflictDoNothing({
      target: [assignments.semester_id, assignments.assignment_id_str],
    })
    .returning({
      id: assignments.id,
      semester_id: assignments.semester_id,
      assignment_id_str: assignments.assignment_id_str,
      label: assignments.label,
      sort_order: assignments.sort_order,
      ingest_scope: assignments.ingest_scope,
    });

  if (inserted.length === 0) throw Errors.assignmentIdStrTaken(input.assignmentIdStr);
  const row = inserted[0]!;

  return {
    id: row.id,
    semester_id: row.semester_id,
    assignment_id_str: row.assignment_id_str,
    label: row.label,
    sort_order: row.sort_order,
    submission_count: 0,
    distinct_students: 0,
    mean_score: 0,
    median_score: 0,
    p95_score: 0,
    fail_count: 0,
    warn_count: 0,
    ingest_scope: parseIngestScopeConfig(row.ingest_scope),
  };
}
