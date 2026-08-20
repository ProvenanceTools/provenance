/**
 * Students aggregation service — PRD §8.8 (GET /students).
 *
 * Aggregates submissions by student within a semester, returning per-student:
 *   - submission_count
 *   - score_sum, score_max
 *   - flag_counts (info/low/medium/high)
 *   - worst_submission (highest score_total SubmissionRow)
 *   - recompute_status (worst across submissions: error > recomputing > stale > fresh)
 *
 * Filters: same as cohort list where applicable (minus student-centric filters
 * that don't make sense per-student).
 * Sort: score_sum_desc | score_max_desc | student_asc.
 * Pagination: cursor on (sort_key, student_id).
 */

import { and, eq, isNull, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  submissions,
  assignments,
  roster_entries,
  flags,
  submission_contributors,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { SubmissionRow, CohortFilters } from './list.js';
import { listCohortSubmissions } from './list.js';
import { projectStudent, maskEmail } from '../protect.js';

export type StudentSort = 'score_sum_desc' | 'score_max_desc' | 'student_asc';

export type StudentCursor =
  | { kind: 'score_sum'; score_sum: number; student_id: string }
  | { kind: 'score_max'; score_max: number; student_id: string }
  | { kind: 'display_name'; display_name: string; student_id: string }
  | { kind: 'protected_index'; protected_index: number; student_id: string };

export type StudentRow = {
  student: { id: string; sid: string; display_name: string; email?: string | null };
  submission_count: number;
  score_sum: number;
  score_max: number;
  flag_counts: { info: number; low: number; medium: number; high: number };
  worst_submission: SubmissionRow;
  recompute_status: string;
};

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

export function encodeStudentCursor(cursor: StudentCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeStudentCursor(encoded: string): StudentCursor | null {
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p['student_id'] !== 'string') return null;
    const kind = p['kind'];
    if (kind === 'score_sum' && typeof p['score_sum'] === 'number') {
      return { kind: 'score_sum', score_sum: p['score_sum'], student_id: p['student_id'] };
    }
    if (kind === 'score_max' && typeof p['score_max'] === 'number') {
      return { kind: 'score_max', score_max: p['score_max'], student_id: p['student_id'] };
    }
    if (kind === 'display_name' && typeof p['display_name'] === 'string') {
      return {
        kind: 'display_name',
        display_name: p['display_name'],
        student_id: p['student_id'],
      };
    }
    if (kind === 'protected_index' && typeof p['protected_index'] === 'number') {
      return {
        kind: 'protected_index',
        protected_index: p['protected_index'],
        student_id: p['student_id'],
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recompute status ordering (worst wins)
// ---------------------------------------------------------------------------

const RECOMPUTE_STATUS_ORDER: Record<string, number> = {
  fresh: 0,
  stale: 1,
  recomputing: 2,
  error: 3,
};

function worstRecomputeStatus(statuses: string[]): string {
  if (statuses.length === 0) return 'fresh';
  let worst = 'fresh';
  for (const s of statuses) {
    const cur = RECOMPUTE_STATUS_ORDER[s] ?? 0;
    const max = RECOMPUTE_STATUS_ORDER[worst] ?? 0;
    if (cur > max) worst = s;
  }
  return worst;
}

const SEVERITIES_AT_OR_ABOVE: Record<string, string[]> = {
  info: ['info', 'low', 'medium', 'high'],
  low: ['low', 'medium', 'high'],
  medium: ['medium', 'high'],
  high: ['high'],
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function listStudents(
  db: DrizzleDb,
  semesterId: string,
  filters: CohortFilters,
  sort: StudentSort,
  cursor: StudentCursor | null,
  limit: number,
  protectedMode: boolean,
): Promise<{ items: StudentRow[]; nextCursor: string | null; totalCount: number }> {
  // Build base WHERE conditions (shared with cohort list logic)
  const buildConditions = (omitStudent = false): SQL[] => {
    const conds: SQL[] = [];
    conds.push(eq(submissions.semester_id, semesterId));

    if (!filters.includeSuperseded) {
      conds.push(isNull(submissions.superseded_by_submission_id));
    }
    if (!omitStudent && filters.studentId !== undefined) {
      // Contributor semi-join, matching the cohort list and the facets (D9).
      const wantedStudentId = filters.studentId;
      conds.push(
        sql`EXISTS (
          SELECT 1 FROM submission_contributors sc
          WHERE sc.submission_id = ${submissions.id}
            AND sc.roster_entry_id = ${wantedStudentId}
        )`,
      );
    }
    if (filters.assignmentId !== undefined) {
      conds.push(eq(submissions.assignment_id, filters.assignmentId));
    }
    if (filters.validationStatus !== undefined) {
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
    if (filters.severityMin !== undefined) {
      const q = SEVERITIES_AT_OR_ABOVE[filters.severityMin];
      if (q !== undefined) {
        if (q.length === 1) conds.push(eq(submissions.score_max_severity, q[0]!));
        else conds.push(inArray(submissions.score_max_severity, q));
      }
    }
    if (filters.flagIds !== undefined && filters.flagIds.length > 0) {
      const ids = filters.flagIds;
      conds.push(
        sql`EXISTS (SELECT 1 FROM flags f WHERE f.submission_id = ${submissions.id} AND f.heuristic_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}))`,
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
  };

  // We can't easily apply HAVING clause cursor via Drizzle typed API,
  // so we fetch all matching students and paginate in-memory for correctness.
  // For large semesters (10k+ students) this is O(N) but acceptable per V34.
  // THE rollup query, and the one D14 changes most (D9).
  //
  // It groups on `submission_contributors.roster_entry_id`, not on
  // `submissions.student_id`. Two consequences, both intended:
  //
  //  - a group submission now appears under EVERY partner, not only whoever
  //    happened to submit it. Under the old join a partner's own work was
  //    missing from their own rollup.
  //  - the score summed is the CONTRIBUTOR's score, not the submission's. This
  //    is the load-bearing half of D14: summing `submissions.score_total` per
  //    partner would charge each of them for everything the other did, which is
  //    precisely the manufactured finding against an innocent student that this
  //    programme is judged on.
  //
  // Unchanged for every existing row: the 0029 backfill gives each pre-existing
  // submission exactly ONE contributor whose `roster_entry_id` is its
  // `student_id` and whose `score_total` is the submission's own. So the join
  // is 1:1, the grouping is identical, and every number here is the same number
  // it was before.
  const aggRows = await db
    .select({
      student_id: roster_entries.id,
      sid: roster_entries.sid,
      display_name: roster_entries.display_name,
      email: roster_entries.email,
      protected_index: roster_entries.protected_index,
      submission_count: sql<number>`COUNT(DISTINCT ${submissions.id})::int`,
      score_sum: sql<number>`SUM(${submission_contributors.score_total})`,
      score_max: sql<number>`MAX(${submission_contributors.score_total})`,
    })
    .from(submissions)
    .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
    .innerJoin(submission_contributors, eq(submission_contributors.submission_id, submissions.id))
    // INNER, deliberately: this list is "students and their submissions", so a
    // contributor with no roster row (D13) has no row to appear under. They are
    // not dropped from the system — they are listed on the submission itself.
    .innerJoin(roster_entries, eq(submission_contributors.roster_entry_id, roster_entries.id))
    .where(and(...buildConditions()))
    .groupBy(
      roster_entries.id,
      roster_entries.sid,
      roster_entries.display_name,
      roster_entries.email,
      roster_entries.protected_index,
    );

  const nameKey = (r: { display_name: string; protected_index: number | null }) =>
    protectedMode ? String(r.protected_index ?? 0).padStart(12, '0') : r.display_name;

  // Sort in-memory
  const sorted = [...aggRows].sort((a, b) => {
    switch (sort) {
      case 'score_sum_desc':
        if (b.score_sum !== a.score_sum) return b.score_sum - a.score_sum;
        return a.student_id < b.student_id ? -1 : 1;
      case 'score_max_desc':
        if (b.score_max !== a.score_max) return b.score_max - a.score_max;
        return a.student_id < b.student_id ? -1 : 1;
      case 'student_asc': {
        const ak = nameKey(a);
        const bk = nameKey(b);
        if (ak !== bk) return ak < bk ? -1 : 1;
        return a.student_id < b.student_id ? -1 : 1;
      }
    }
  });

  const totalCount = sorted.length;

  // Apply cursor-based slicing (find the start index)
  let startIdx = 0;
  if (cursor !== null) {
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i]!;
      let afterCursor = false;
      switch (sort) {
        case 'score_sum_desc':
          if (cursor.kind === 'score_sum') {
            afterCursor =
              r.score_sum < cursor.score_sum ||
              (r.score_sum === cursor.score_sum && r.student_id > cursor.student_id);
          }
          break;
        case 'score_max_desc':
          if (cursor.kind === 'score_max') {
            afterCursor =
              r.score_max < cursor.score_max ||
              (r.score_max === cursor.score_max && r.student_id > cursor.student_id);
          }
          break;
        case 'student_asc':
          if (protectedMode && cursor.kind === 'protected_index') {
            const rk = r.protected_index ?? 0;
            afterCursor =
              rk > cursor.protected_index ||
              (rk === cursor.protected_index && r.student_id > cursor.student_id);
          } else if (!protectedMode && cursor.kind === 'display_name') {
            afterCursor =
              r.display_name > cursor.display_name ||
              (r.display_name === cursor.display_name && r.student_id > cursor.student_id);
          }
          break;
      }
      if (afterCursor) {
        startIdx = i;
        break;
      }
      startIdx = i + 1;
    }
  }

  const page = sorted.slice(startIdx, startIdx + limit + 1);
  const hasMore = page.length > limit;
  const pageItems = hasMore ? page.slice(0, limit) : page;

  let nextCursor: string | null = null;
  if (hasMore && pageItems.length > 0) {
    const last = pageItems[pageItems.length - 1]!;
    let c: StudentCursor;
    switch (sort) {
      case 'score_sum_desc':
        c = { kind: 'score_sum', score_sum: last.score_sum, student_id: last.student_id };
        break;
      case 'score_max_desc':
        c = { kind: 'score_max', score_max: last.score_max, student_id: last.student_id };
        break;
      case 'student_asc':
        c = protectedMode
          ? {
              kind: 'protected_index',
              protected_index: last.protected_index ?? 0,
              student_id: last.student_id,
            }
          : { kind: 'display_name', display_name: last.display_name, student_id: last.student_id };
        break;
    }
    nextCursor = encodeStudentCursor(c);
  }

  if (pageItems.length === 0) {
    return { items: [], nextCursor: null, totalCount };
  }

  // For each student in the page, fetch their worst_submission as a SubmissionRow
  // by calling listCohortSubmissions with studentId filter, sort=score_desc, limit=1
  const items: StudentRow[] = await Promise.all(
    pageItems.map(async (agg) => {
      // Fetch worst submission (highest score_total)
      const { items: worstItems } = await listCohortSubmissions(
        db,
        semesterId,
        { ...filters, studentId: agg.student_id },
        'score_desc',
        null,
        1,
        protectedMode,
      );

      // Fetch all submission recompute statuses for this student
      // Through the join table (D9), matching the aggregate above. Keyed on the
      // roster entry, not `submissions.student_id`, so a partner's group
      // submission counts toward their recompute status too. DISTINCT because
      // one submission joins once per contributor and a group submission must
      // not contribute its status twice.
      const subRows = await db
        .selectDistinct({
          submission_id: submissions.id,
          recompute_status: submissions.recompute_status,
        })
        .from(submissions)
        .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
        .innerJoin(
          submission_contributors,
          eq(submission_contributors.submission_id, submissions.id),
        )
        .where(
          and(
            ...buildConditions(true),
            eq(submission_contributors.roster_entry_id, agg.student_id),
          ),
        );

      const recomputeStatuses = subRows.map((r) => r.recompute_status);

      // Fetch flag counts for this student's submissions
      const studentSubIds = (
        await db
          .selectDistinct({ id: submissions.id })
          .from(submissions)
          .innerJoin(
            submission_contributors,
            eq(submission_contributors.submission_id, submissions.id),
          )
          .where(
            and(
              eq(submissions.semester_id, semesterId),
              // Through the join table (D9) — see the aggregate above.
              eq(submission_contributors.roster_entry_id, agg.student_id),
              ...(!filters.includeSuperseded
                ? [isNull(submissions.superseded_by_submission_id)]
                : []),
            ),
          )
      ).map((r) => r.id);

      const flagCounts = { info: 0, low: 0, medium: 0, high: 0 };
      if (studentSubIds.length > 0) {
        const flagRows = await db
          .select({
            severity: flags.severity,
            cnt: sql<number>`COUNT(*)::int`,
          })
          .from(flags)
          .where(inArray(flags.submission_id, studentSubIds))
          .groupBy(flags.severity);

        for (const r of flagRows) {
          if (r.severity === 'info') flagCounts.info += r.cnt;
          else if (r.severity === 'low') flagCounts.low += r.cnt;
          else if (r.severity === 'medium') flagCounts.medium += r.cnt;
          else if (r.severity === 'high') flagCounts.high += r.cnt;
        }
      }

      return {
        student: {
          ...projectStudent(
            {
              id: agg.student_id,
              sid: agg.sid,
              display_name: agg.display_name,
              protected_index: agg.protected_index,
            },
            protectedMode,
          ),
          email: maskEmail(agg.email, protectedMode),
        },
        submission_count: agg.submission_count,
        score_sum: agg.score_sum,
        score_max: agg.score_max,
        flag_counts: flagCounts,
        worst_submission: worstItems[0]!,
        recompute_status: worstRecomputeStatus(recomputeStatuses),
      };
    }),
  );

  return { items, nextCursor, totalCount };
}
