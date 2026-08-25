/**
 * Unmatched tray routes (PRD §8.7).
 *
 * GET  /semesters/:semesterId/unmatched                — semester member
 * PATCH /semesters/:semesterId/unmatched/:ingestFileId — semester admin
 * POST /semesters/:semesterId/unmatched/:ingestFileId/discard — semester admin
 *
 * Auth:
 *   GET list   — semester member (read)
 *   PATCH      — semester admin (write.ingest)
 *   POST discard — semester admin (write.ingest)
 *
 * Audit:
 *   ingest.unmatched.attach  — on PATCH success
 *   ingest.unmatched.discard — on POST discard success
 *
 * Cursor format:
 *   Opaque base64-encoded JSON `{ v, ca, id }` for stable keyset pagination on
 *   (created_at, id). `ca` is a MICROSECOND-precision UTC ISO string — not a
 *   `Date.toISOString()` value, which would truncate to milliseconds and make
 *   the whole millisecond bucket undecidable. See `services/keyset.ts`.
 */

import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { requireAuth } from '../../middleware/authorize.js';
import { requirePrincipal } from '../../middleware/auth-session.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { insertAuditRow } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import { ingest_files, ingest_jobs, roster_entries, assignments } from '../../../db/schema.js';
import { createStorageClient, storageConfigFromEnv } from '../../../services/storage/client.js';
import { getConfig } from '../../../config/index.js';
import { getBoss } from '../../../jobs/pg-boss.js';
import { attachUnmatchedFile, getIngestFileSemesterId } from '../../../services/ingest/attach.js';
import { projectStudent, maskFilename, protectedLabel } from '../../../services/protect.js';
import {
  KEYSET_CURSOR_VERSION,
  isMicroTimestamp,
  keysetAfter,
  microTimestamp,
} from '../../../services/keyset.js';

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorPayload {
  /** Microsecond-precision UTC ISO string; see `services/keyset.ts`. */
  ca: string;
  id: string; // ingest_files.id UUID
}

function encodeCursor(createdAtMicros: string, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: KEYSET_CURSOR_VERSION, ca: createdAtMicros, id }),
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
function decodeCursor(encoded: string): CursorPayload | null {
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (p['v'] !== KEYSET_CURSOR_VERSION) return null;
    if (typeof p['ca'] !== 'string' || typeof p['id'] !== 'string') return null;
    if (!isMicroTimestamp(p['ca'])) return null;
    return { ca: p['ca'], id: p['id'] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// IngestFileSummary formatter (reuse the shape from ingest.ts)
// ---------------------------------------------------------------------------

interface RawFileRow {
  id: string;
  original_filename: string;
  size_bytes: number;
  blob_sha256: string;
  status: string;
  matched_student_id: string | null;
  matched_student_sid: string | null;
  matched_student_display_name: string | null;
  matched_student_protected_index: number | null;
  matched_assignment_id: string | null;
  matched_assignment_id_str: string | null;
  matched_assignment_label: string | null;
  submission_id: string | null;
  filename_capture: unknown;
  error: unknown;
  created_at: Date | null;
}

function formatFileSummary(row: RawFileRow, protectedMode: boolean): Record<string, unknown> {
  const idxLabel =
    row.matched_student_id !== null
      ? protectedLabel(row.matched_student_protected_index, row.matched_student_id)
      : null;
  const out: Record<string, unknown> = {
    id: row.id,
    original_filename: maskFilename(
      row.original_filename,
      protectedMode,
      idxLabel !== null ? `${idxLabel} — file` : `(unmatched file ${row.id.slice(0, 8)})`,
    ),
    size_bytes: row.size_bytes,
    blob_sha256: row.blob_sha256,
    status: row.status,
  };

  if (row.matched_student_id !== null) {
    out['matched_student'] = projectStudent(
      {
        id: row.matched_student_id,
        sid: row.matched_student_sid ?? '',
        display_name: row.matched_student_display_name ?? '',
        protected_index: row.matched_student_protected_index,
      },
      protectedMode,
    );
  }
  if (row.matched_assignment_id !== null) {
    out['matched_assignment'] = {
      id: row.matched_assignment_id,
      assignment_id_str: row.matched_assignment_id_str,
      label: row.matched_assignment_label,
    };
  }
  if (row.submission_id !== null) {
    out['submission_id'] = row.submission_id;
  }
  if (!protectedMode && row.filename_capture !== null && row.filename_capture !== undefined) {
    out['filename_capture'] = row.filename_capture;
  }
  if (row.error !== null && row.error !== undefined) {
    out['error'] = row.error;
  }

  return out;
}

// ---------------------------------------------------------------------------
// File row query helper (with LEFT JOINs for nested objects)
// ---------------------------------------------------------------------------

const FILE_SELECT = {
  id: ingest_files.id,
  original_filename: ingest_files.original_filename,
  size_bytes: ingest_files.size_bytes,
  blob_sha256: ingest_files.blob_sha256,
  status: ingest_files.status,
  matched_student_id: ingest_files.matched_student_id,
  matched_student_sid: roster_entries.sid,
  matched_student_display_name: roster_entries.display_name,
  matched_student_protected_index: roster_entries.protected_index,
  matched_assignment_id: ingest_files.matched_assignment_id,
  matched_assignment_id_str: assignments.assignment_id_str,
  matched_assignment_label: assignments.label,
  submission_id: ingest_files.submission_id,
  filename_capture: ingest_files.filename_capture,
  error: ingest_files.error,
  created_at: ingest_files.created_at,
};

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createUnmatchedRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/unmatched
  //
  // Returns paginated unmatched files for the semester. Uses a (created_at, id)
  // compound keyset cursor for stable pagination.
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/unmatched',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 || rawLimit > 200 ? 50 : rawLimit;

      const cursorStr = c.req.query('cursor');
      const cursor = cursorStr !== undefined ? decodeCursor(cursorStr) : null;
      // A cursor this build cannot honour is a 400, not a silent restart from
      // page 1: paging from the top while the client believes it is paging
      // forward produces a duplicate-laden result set with no error anywhere.
      if (cursorStr !== undefined && cursor === null) {
        return c.json(
          Errors.validation([{ field: 'cursor', issue: 'Invalid cursor' }]).toBody(),
          400,
        );
      }

      // Build the WHERE clause. We join ingest_files → ingest_jobs to filter
      // by semester_id, then apply the unmatched status filter (which uses the
      // ingest_files_unmatched_idx partial index when status='unmatched').
      //
      // Keyset pagination on (created_at ASC, id ASC).
      //
      // One row-value comparison, which IS that lexicographic order — so it
      // agrees with the ORDER BY by construction. The cursor carries full
      // microsecond precision, which is what makes that possible; `decodeCursor`
      // has already refused anything less.
      //
      // The millisecond-bucket branches this replaces covered `[floor, ∞)`
      // with no gap, so they looked right — but the floor is all a `Date`-derived
      // cursor can express, so every same-millisecond row was decided by the
      // random-uuid tiebreak instead of by its true microsecond. That both
      // DROPPED rows (true ts later than the cursor's but smaller id) and
      // DUPLICATED them (true ts earlier but larger id). Batch ingest writes a
      // whole tray in one go, so sharing a millisecond is the normal case here.
      // See `services/keyset.ts`.
      const cursorCondition =
        cursor !== null
          ? keysetAfter(ingest_files.created_at, ingest_files.id, cursor.ca, cursor.id, 'asc')
          : undefined;

      const rows = await db
        .select({
          ...FILE_SELECT,
          // Cursor-only projection. `created_at` in FILE_SELECT is a JS `Date`
          // and has already lost the microseconds; this keeps them.
          created_at_us: microTimestamp(ingest_files.created_at),
        })
        .from(ingest_files)
        .innerJoin(ingest_jobs, eq(ingest_files.ingest_job_id, ingest_jobs.id))
        .leftJoin(roster_entries, eq(ingest_files.matched_student_id, roster_entries.id))
        .leftJoin(assignments, eq(ingest_files.matched_assignment_id, assignments.id))
        .where(
          and(
            eq(ingest_jobs.semester_id, semesterId),
            eq(ingest_files.status, 'unmatched'),
            cursorCondition,
          ),
        )
        .orderBy(ingest_files.created_at, ingest_files.id)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = items.at(-1);
      const nextCursor =
        hasMore && lastItem !== undefined
          ? encodeCursor(lastItem.created_at_us, lastItem.id)
          : null;

      const protectedMode = requirePrincipal(c).user.protected;
      return c.json({
        items: items.map((row) => formatFileSummary(row, protectedMode)),
        next_cursor: nextCursor,
      });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /semesters/:semesterId/unmatched/:ingestFileId
  //
  // Manually attaches an unmatched file to a (student, assignment).
  // Re-runs phases 5–9: createSubmission + materialize + stats + validation +
  // heuristics. Returns the updated IngestFileSummary + any warnings.
  // -------------------------------------------------------------------------

  router.patch(
    '/semesters/:semesterId/unmatched/:ingestFileId',
    rateLimit('write.ingest'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const ingestFileId = c.req.param('ingestFileId')!;
      const db = getDb();
      const principal = c.var.principal!;

      // Parse body.
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return c.json(
          Errors.validation([{ field: 'body', issue: 'Invalid JSON body' }]).toBody(),
          400,
        );
      }

      const studentId = body['student_id'];
      const assignmentIdStr = body['assignment_id_str'];

      if (typeof studentId !== 'string' || studentId.trim() === '') {
        return c.json(
          Errors.validation([
            { field: 'student_id', issue: 'Must be a non-empty UUID string' },
          ]).toBody(),
          400,
        );
      }
      if (typeof assignmentIdStr !== 'string' || assignmentIdStr.trim() === '') {
        return c.json(
          Errors.validation([
            { field: 'assignment_id_str', issue: 'Must be a non-empty string' },
          ]).toBody(),
          400,
        );
      }

      // Verify the file belongs to this semester (security: don't let an admin
      // of semester A attach files from semester B).
      const fileSemesterId = await getIngestFileSemesterId(db, ingestFileId);
      if (fileSemesterId === null) {
        return c.json(Errors.notFound().toBody(), 404);
      }
      if (fileSemesterId !== semesterId) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const cfg = getConfig();
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      const boss = await getBoss();

      // Call the attach service. It throws typed ApiError on error conditions.
      const attachResult = await attachUnmatchedFile(
        { db, storageClient, boss },
        {
          ingestFileId,
          semesterId,
          studentId: studentId.trim(),
          assignmentIdStr: assignmentIdStr.trim(),
        },
      );

      // Audit log (fire-and-forget).
      const actorUserId = principal.user.id;
      const actorTokenId = principal.principal_kind === 'token' ? principal.token.id : null;
      const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null;
      const userAgent = c.req.header('user-agent') ?? null;
      void insertAuditRow({
        actorUserId,
        actorTokenId,
        semesterId,
        action: 'ingest.unmatched.attach',
        targetType: 'ingest_file',
        targetId: ingestFileId,
        detail: {
          submission_id: attachResult.submissionId,
          student_id: studentId,
          assignment_id_str: assignmentIdStr,
        },
        ip,
        userAgent,
        at: new Date(),
      }).catch(() => {
        /* non-fatal */
      });

      // Fetch the now-matched file row for the response.
      const updatedRows = await db
        .select(FILE_SELECT)
        .from(ingest_files)
        .leftJoin(roster_entries, eq(ingest_files.matched_student_id, roster_entries.id))
        .leftJoin(assignments, eq(ingest_files.matched_assignment_id, assignments.id))
        .where(eq(ingest_files.id, ingestFileId))
        .limit(1);

      if (updatedRows.length === 0) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const patchProtectedMode = requirePrincipal(c).user.protected;
      return c.json(
        {
          ...formatFileSummary(updatedRows[0]!, patchProtectedMode),
          warnings: attachResult.warnings,
        },
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/unmatched/:ingestFileId/discard
  //
  // Marks the file as 'discarded'. The blob remains until the retention sweep.
  // reason (if provided) is stored in the existing error jsonb column as
  // { discard_reason: string } — reuses the column rather than adding a new one
  // (the column is already defined and flexible; no migration needed).
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/unmatched/:ingestFileId/discard',
    rateLimit('write.ingest'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const ingestFileId = c.req.param('ingestFileId')!;
      const db = getDb();
      const principal = c.var.principal!;

      // Parse optional reason from body.
      let reason: string | undefined;
      try {
        const body = (await c.req.json()) as Record<string, unknown>;
        if (typeof body['reason'] === 'string' && body['reason'].trim() !== '') {
          reason = body['reason'].trim();
        }
      } catch {
        // Body is optional — empty body or non-JSON is fine.
      }

      // Verify the file belongs to this semester.
      const fileSemesterId = await getIngestFileSemesterId(db, ingestFileId);
      if (fileSemesterId === null) {
        return c.json(Errors.notFound().toBody(), 404);
      }
      if (fileSemesterId !== semesterId) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      // Attempt to transition the file to 'discarded'. We use a conditional
      // UPDATE that only succeeds when status='unmatched', then check rows
      // updated to detect concurrent edits.
      const updateResult = await db
        .update(ingest_files)
        .set({
          status: 'discarded',
          resolved_at: sql`now()`,
          ...(reason !== undefined && {
            error: { code: 'DISCARDED', message: reason, details: { reason } },
          }),
        })
        .where(and(eq(ingest_files.id, ingestFileId), eq(ingest_files.status, 'unmatched')))
        .returning({ id: ingest_files.id, status: ingest_files.status });

      if (updateResult.length === 0) {
        // Either the file was already in a non-unmatched state, or it doesn't
        // exist. Determine which to return the right error.
        const existing = await db
          .select({ status: ingest_files.status })
          .from(ingest_files)
          .where(eq(ingest_files.id, ingestFileId))
          .limit(1);
        if (existing.length === 0) {
          return c.json(Errors.notFound().toBody(), 404);
        }
        // File exists but status !== 'unmatched'.
        throw Errors.ingestFileNotUnmatched(ingestFileId);
      }

      // Audit log (fire-and-forget).
      const actorUserIdDiscard = principal.user.id;
      const actorTokenIdDiscard = principal.principal_kind === 'token' ? principal.token.id : null;
      const ipDiscard = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null;
      const userAgentDiscard = c.req.header('user-agent') ?? null;
      void insertAuditRow({
        actorUserId: actorUserIdDiscard,
        actorTokenId: actorTokenIdDiscard,
        semesterId,
        action: 'ingest.unmatched.discard',
        targetType: 'ingest_file',
        targetId: ingestFileId,
        detail: reason !== undefined ? { reason } : {},
        ip: ipDiscard,
        userAgent: userAgentDiscard,
        at: new Date(),
      }).catch(() => {
        /* non-fatal */
      });

      // Fetch the updated row for the response.
      const updatedRows = await db
        .select(FILE_SELECT)
        .from(ingest_files)
        .leftJoin(roster_entries, eq(ingest_files.matched_student_id, roster_entries.id))
        .leftJoin(assignments, eq(ingest_files.matched_assignment_id, assignments.id))
        .where(eq(ingest_files.id, ingestFileId))
        .limit(1);

      if (updatedRows.length === 0) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const discardProtectedMode = requirePrincipal(c).user.protected;
      return c.json(formatFileSummary(updatedRows[0]!, discardProtectedMode), 200);
    },
  );

  return router;
}
