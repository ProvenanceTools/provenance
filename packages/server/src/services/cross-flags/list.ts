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
 * Pagination: cursor on (created_at DESC, id DESC).
 * Uses same millisecond-precision trick from V33 for µs-precision timestamps.
 *
 * Response shape: CrossFlagSummary[] with participants[].
 */

import { and, eq, or, sql, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  cross_flags,
  cross_flag_participants,
  submissions,
  roster_entries,
  assignments,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { Severity } from '@provenance/analysis-core/heuristics/types.js';
import { projectStudent } from '../protect.js';

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

// Cursor: (created_at, id) compound — created_at DESC, id DESC
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
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCrossFlagCursor(encoded: string): CrossFlagCursor | null {
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p['created_at'] !== 'string' || typeof p['id'] !== 'string') return null;
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

  // Cursor: (created_at DESC, id DESC)
  if (cursor !== null) {
    const cursorDate = new Date(cursor.created_at);
    if (!isNaN(cursorDate.getTime())) {
      // Same millisecond+1 trick from V33 to handle µs precision on DESC order
      const prevMs = new Date(cursorDate.getTime() - 1);
      // Pass dates as ISO strings — postgres-js cannot serialize Date objects
      // when they originate from js Date instances in sql`` template params.
      const prevMsStr = prevMs.toISOString();
      const cursorDateStr = cursorDate.toISOString();
      // "next page" = rows earlier in time than cursor, OR same ms + smaller id
      whereConditions.push(
        or(
          sql`${cross_flags.created_at} < ${prevMsStr}::timestamptz`,
          and(
            sql`${cross_flags.created_at} >= ${prevMsStr}::timestamptz`,
            sql`${cross_flags.created_at} <= ${cursorDateStr}::timestamptz`,
            sql`${cross_flags.id} < ${cursor.id}`,
          ),
        )!,
      );
    }
  }

  const rows = await db
    .select({
      id: cross_flags.id,
      heuristic_id: cross_flags.heuristic_id,
      severity: cross_flags.severity,
      confidence: cross_flags.confidence,
      detail: cross_flags.detail,
      created_at: cross_flags.created_at,
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
      created_at: last.created_at.toISOString(),
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

  for (const row of rows) {
    if (!result.has(row.cross_flag_id)) {
      result.set(row.cross_flag_id, []);
    }
    result.get(row.cross_flag_id)!.push({
      submission_id: row.submission_id,
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
