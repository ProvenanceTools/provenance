/**
 * Cohort routes — Phase 16 (PRD §8.5, §8.8).
 *
 * GET /semesters/:semesterId/submissions  — cohort list workhorse
 * GET /semesters/:semesterId/students     — per-student aggregation
 * GET /semesters/:semesterId/assignments  — assignments with summary stats
 *
 * Auth: semester member (read) for all 3.
 * Rate: read.cohort.
 *
 * Audit: cohort reads are NOT logged per PRD §13:
 *   "Reads of cohort lists are NOT" (logged).
 *
 * Cursor format (submissions): base64url JSON with 'kind' discriminant.
 * Cursor format (students): base64url JSON with 'kind' discriminant.
 */

import { Hono } from 'hono';
import { getDb } from '../../../db/client.js';
import { requireAuth } from '../../middleware/authorize.js';
import { requirePrincipal } from '../../middleware/auth-session.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { Errors } from '../errors.js';
import {
  listCohortSubmissions,
  decodeCursor,
  type CohortFilters,
  type CohortSort,
} from '../../../services/cohort/list.js';
import { buildFacets } from '../../../services/cohort/facets.js';
import {
  listStudents,
  decodeStudentCursor,
  type StudentSort,
} from '../../../services/cohort/students.js';
import { listAssignments } from '../../../services/cohort/assignments.js';
import type { Severity } from '@provenance/analysis-core/heuristics/types.js';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createCohortRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/submissions
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/submissions',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      // Parse filters
      const filters: CohortFilters = {};

      const assignmentId = c.req.query('assignment_id');
      if (assignmentId) filters.assignmentId = assignmentId;

      const studentId = c.req.query('student_id');
      if (studentId) filters.studentId = studentId;

      // flag_id can appear multiple times (repeated key)
      const flagIds = c.req.queries('flag_id');
      if (flagIds && flagIds.length > 0) filters.flagIds = flagIds;

      const severityMin = c.req.query('severity_min');
      if (severityMin) {
        const valid: Severity[] = ['info', 'low', 'medium', 'high'];
        if (!valid.includes(severityMin as Severity)) {
          return c.json(
            Errors.validation([
              { field: 'severity_min', issue: 'Must be info|low|medium|high' },
            ]).toBody(),
            400,
          );
        }
        filters.severityMin = severityMin as Severity;
      }

      const validationStatus = c.req.query('validation_status');
      if (validationStatus) {
        if (!['pass', 'warn', 'fail'].includes(validationStatus)) {
          return c.json(
            Errors.validation([
              { field: 'validation_status', issue: 'Must be pass|warn|fail' },
            ]).toBody(),
            400,
          );
        }
        filters.validationStatus = validationStatus as 'pass' | 'warn' | 'fail';
      }

      const scoreMinStr = c.req.query('score_min');
      if (scoreMinStr !== undefined) {
        const n = parseFloat(scoreMinStr);
        if (!isNaN(n)) filters.scoreMin = n;
      }

      const scoreMaxStr = c.req.query('score_max');
      if (scoreMaxStr !== undefined) {
        const n = parseFloat(scoreMaxStr);
        if (!isNaN(n)) filters.scoreMax = n;
      }

      const activeMinutesMinStr = c.req.query('active_minutes_min');
      if (activeMinutesMinStr !== undefined) {
        const n = parseFloat(activeMinutesMinStr);
        if (!isNaN(n)) filters.activeMinutesMin = n;
      }

      const activeMinutesMaxStr = c.req.query('active_minutes_max');
      if (activeMinutesMaxStr !== undefined) {
        const n = parseFloat(activeMinutesMaxStr);
        if (!isNaN(n)) filters.activeMinutesMax = n;
      }

      const totalMinutesMinStr = c.req.query('total_minutes_min');
      if (totalMinutesMinStr !== undefined) {
        const n = parseFloat(totalMinutesMinStr);
        if (!isNaN(n)) filters.totalMinutesMin = n;
      }

      const totalMinutesMaxStr = c.req.query('total_minutes_max');
      if (totalMinutesMaxStr !== undefined) {
        const n = parseFloat(totalMinutesMaxStr);
        if (!isNaN(n)) filters.totalMinutesMax = n;
      }

      const hasExternalEdits = c.req.query('has_external_edits');
      if (hasExternalEdits === 'true') filters.hasExternalEdits = true;
      else if (hasExternalEdits === 'false') filters.hasExternalEdits = false;

      const hasLargePaste = c.req.query('has_large_paste');
      if (hasLargePaste === 'true') filters.hasLargePaste = true;
      else if (hasLargePaste === 'false') filters.hasLargePaste = false;

      const recorderVersion = c.req.query('recorder_version');
      if (recorderVersion) filters.recorderVersion = recorderVersion;

      const includeSuperseded = c.req.query('include_superseded');
      filters.includeSuperseded = includeSuperseded === 'true';

      const qParam = c.req.query('q');
      if (qParam) filters.q = qParam;

      // Parse sort
      const sortParam = c.req.query('sort') ?? 'score_desc';
      const validSorts: CohortSort[] = [
        'score_desc',
        'score_asc',
        'ingested_desc',
        'student_asc',
        'student_desc',
        'assignment_asc',
      ];
      if (!validSorts.includes(sortParam as CohortSort)) {
        return c.json(
          Errors.validation([{ field: 'sort', issue: 'Invalid sort value' }]).toBody(),
          400,
        );
      }
      const sort = sortParam as CohortSort;

      // Parse limit
      const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : rawLimit > 500 ? 500 : rawLimit;

      // Parse cursor
      const cursorStr = c.req.query('cursor');
      const cursor = cursorStr !== undefined ? decodeCursor(cursorStr) : null;
      if (cursorStr !== undefined && cursor === null) {
        return c.json(
          Errors.validation([{ field: 'cursor', issue: 'Invalid cursor' }]).toBody(),
          400,
        );
      }

      const principal = requirePrincipal(c);
      const protectedMode = principal.user.protected;

      // Execute list + facets in parallel
      const [listResult, facets] = await Promise.all([
        listCohortSubmissions(db, semesterId, filters, sort, cursor, limit, protectedMode),
        buildFacets(db, semesterId, filters, protectedMode),
      ]);

      return c.json({
        items: listResult.items,
        next_cursor: listResult.nextCursor,
        total_count: listResult.totalCount,
        facets,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/students
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/students',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      // Same filter set as submissions
      const filters: CohortFilters = {};

      const assignmentId = c.req.query('assignment_id');
      if (assignmentId) filters.assignmentId = assignmentId;

      const studentId = c.req.query('student_id');
      if (studentId) filters.studentId = studentId;

      const flagIds = c.req.queries('flag_id');
      if (flagIds && flagIds.length > 0) filters.flagIds = flagIds;

      const severityMin = c.req.query('severity_min');
      if (severityMin) {
        const valid: Severity[] = ['info', 'low', 'medium', 'high'];
        if (!valid.includes(severityMin as Severity)) {
          return c.json(
            Errors.validation([
              { field: 'severity_min', issue: 'Must be info|low|medium|high' },
            ]).toBody(),
            400,
          );
        }
        filters.severityMin = severityMin as Severity;
      }

      const validationStatus = c.req.query('validation_status');
      if (validationStatus) {
        if (!['pass', 'warn', 'fail'].includes(validationStatus)) {
          return c.json(
            Errors.validation([
              { field: 'validation_status', issue: 'Must be pass|warn|fail' },
            ]).toBody(),
            400,
          );
        }
        filters.validationStatus = validationStatus as 'pass' | 'warn' | 'fail';
      }

      const scoreMinStr = c.req.query('score_min');
      if (scoreMinStr !== undefined) {
        const n = parseFloat(scoreMinStr);
        if (!isNaN(n)) filters.scoreMin = n;
      }

      const scoreMaxStr = c.req.query('score_max');
      if (scoreMaxStr !== undefined) {
        const n = parseFloat(scoreMaxStr);
        if (!isNaN(n)) filters.scoreMax = n;
      }

      const activeMinutesMinStr = c.req.query('active_minutes_min');
      if (activeMinutesMinStr !== undefined) {
        const n = parseFloat(activeMinutesMinStr);
        if (!isNaN(n)) filters.activeMinutesMin = n;
      }

      const activeMinutesMaxStr = c.req.query('active_minutes_max');
      if (activeMinutesMaxStr !== undefined) {
        const n = parseFloat(activeMinutesMaxStr);
        if (!isNaN(n)) filters.activeMinutesMax = n;
      }

      const totalMinutesMinStr = c.req.query('total_minutes_min');
      if (totalMinutesMinStr !== undefined) {
        const n = parseFloat(totalMinutesMinStr);
        if (!isNaN(n)) filters.totalMinutesMin = n;
      }

      const totalMinutesMaxStr = c.req.query('total_minutes_max');
      if (totalMinutesMaxStr !== undefined) {
        const n = parseFloat(totalMinutesMaxStr);
        if (!isNaN(n)) filters.totalMinutesMax = n;
      }

      const hasExternalEdits = c.req.query('has_external_edits');
      if (hasExternalEdits === 'true') filters.hasExternalEdits = true;
      else if (hasExternalEdits === 'false') filters.hasExternalEdits = false;

      const hasLargePaste = c.req.query('has_large_paste');
      if (hasLargePaste === 'true') filters.hasLargePaste = true;
      else if (hasLargePaste === 'false') filters.hasLargePaste = false;

      const recorderVersion = c.req.query('recorder_version');
      if (recorderVersion) filters.recorderVersion = recorderVersion;

      const includeSuperseded = c.req.query('include_superseded');
      filters.includeSuperseded = includeSuperseded === 'true';

      const qParam = c.req.query('q');
      if (qParam) filters.q = qParam;

      // Sort
      const sortParam = c.req.query('sort') ?? 'score_sum_desc';
      const validSorts: StudentSort[] = ['score_sum_desc', 'score_max_desc', 'student_asc'];
      if (!validSorts.includes(sortParam as StudentSort)) {
        return c.json(
          Errors.validation([
            { field: 'sort', issue: 'Must be score_sum_desc|score_max_desc|student_asc' },
          ]).toBody(),
          400,
        );
      }
      const sort = sortParam as StudentSort;

      const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : rawLimit > 500 ? 500 : rawLimit;

      const cursorStr = c.req.query('cursor');
      const cursor = cursorStr !== undefined ? decodeStudentCursor(cursorStr) : null;
      if (cursorStr !== undefined && cursor === null) {
        return c.json(
          Errors.validation([{ field: 'cursor', issue: 'Invalid cursor' }]).toBody(),
          400,
        );
      }

      const protectedMode = requirePrincipal(c).user.protected;

      const result = await listStudents(
        db,
        semesterId,
        filters,
        sort,
        cursor,
        limit,
        protectedMode,
      );

      return c.json({
        items: result.items,
        next_cursor: result.nextCursor,
        total_count: result.totalCount,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/assignments
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/assignments',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const result = await listAssignments(db, semesterId);

      // Wrapper key is `items` to match AssignmentListResponseSchema in
      // packages/shared/src/api-schemas.ts. Pre-V46 this returned
      // `{ assignments: result }` and the analyzer's Zod parse silently
      // bombed — the UI showed "Failed to load assignments" forever. The
      // assignments table never had real data behind it (Phase 22's stub
      // banner masked the failure) so the mismatch went unnoticed.
      return c.json({ items: result });
    },
  );

  return router;
}
