/**
 * Assignment update route — PRD §8.5.
 *
 * PATCH /api/v1/semesters/:semesterId/assignments/:assignmentId
 *
 * Auth:  semester admin (action='write', target=semester).
 * Audit: 'assignment.update' on the assignment id.
 *
 * Body: { label?, sort_order?, ingest_scope? } — at least one required.
 *
 * `ingest_scope` is the assignment's persisted DEFAULT declared submission type
 * (see IngestScopeConfigSchema). provgate writes it once at Gradescope→
 * Provenance mapping time; an individual ingest request can still override it.
 * It is replaced wholesale, not merged.
 *
 * Returns: { assignment: AssignmentSummary } so the UI can patch in-place.
 *
 * 404 covers both "assignment id unknown" and "assignment id belongs to a
 * different semester than the path :semesterId" — we never want a write to a
 * sibling course's row to succeed because the caller has admin rights on a
 * different semester within the same course.
 *
 * GET /:semesterId/assignments stays in cohort.ts; that endpoint is read-heavy
 * (joins to submissions stats) and groups naturally with the cohort list.
 */

import { Hono } from 'hono';
import { getDb } from '../../../db/client.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireAuth } from '../../middleware/authorize.js';
import { audit } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import {
  UpdateAssignmentRequestSchema,
  UpdateAssignmentResponseSchema,
  CreateAssignmentRequestSchema,
  CreateAssignmentResponseSchema,
} from '@provenance/shared/api-schemas';
import * as assignmentService from '../../../services/cohort/assignments.js';
import { parseIngestScopeConfig } from '../../../services/ingest/gradescope/repo-scopes.js';

export function createAssignmentsRouter(): Hono {
  const router = new Hono();

  router.patch(
    '/semesters/:semesterId/assignments/:assignmentId',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('assignment.update', 'assignment', (c) => c.req.param('assignmentId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const assignmentId = c.req.param('assignmentId')!;

      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parsed = UpdateAssignmentRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(Errors.validation(parsed.error.issues).toBody(), 400);
      }

      const db = getDb();
      const updateInput: assignmentService.UpdateAssignmentInput = {};
      if (parsed.data.label !== undefined) updateInput.label = parsed.data.label;
      if (parsed.data.sort_order !== undefined) updateInput.sort_order = parsed.data.sort_order;
      if (parsed.data.ingest_scope !== undefined) {
        // Re-narrow through the same function every storage read uses, so what
        // is written is byte-for-byte what a later read will produce.
        updateInput.ingest_scope = parseIngestScopeConfig(parsed.data.ingest_scope);
      }

      const updated = await assignmentService.updateAssignment(
        db,
        semesterId,
        assignmentId,
        updateInput,
      );

      const response = UpdateAssignmentResponseSchema.parse({ assignment: updated });
      return c.json(response);
    },
  );

  router.post(
    '/semesters/:semesterId/assignments',
    rateLimit('write.misc'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('assignment.create', 'assignment', (c) => (c.var.auditDetail?.id as string) ?? 'unknown'),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;

      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json(Errors.validation([{ error: 'Invalid JSON' }]).toBody(), 400);
      }

      const parsed = CreateAssignmentRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(Errors.validation(parsed.error.issues).toBody(), 400);
      }

      const db = getDb();
      const createInput: assignmentService.CreateAssignmentInput = {
        assignmentIdStr: parsed.data.assignment_id_str,
      };
      if (parsed.data.label !== undefined) createInput.label = parsed.data.label;
      if (parsed.data.ingest_scope !== undefined) {
        createInput.ingest_scope = parseIngestScopeConfig(parsed.data.ingest_scope);
      }
      const created = await assignmentService.createAssignment(db, semesterId, createInput);

      // Feed the audit middleware the created entity's UUID.
      c.set('auditDetail', { id: created.id });

      const response = CreateAssignmentResponseSchema.parse({ assignment: created });
      return c.json(response, 201);
    },
  );

  return router;
}
