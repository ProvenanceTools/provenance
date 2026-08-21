/**
 * Cross-flags routes — Phase 16 (PRD §8.10).
 *
 * GET /semesters/:semesterId/cross-flags     — list (semester member)
 * GET /cross-flags/:crossFlagId             — detail (top-level; derive semester from row)
 *
 * Auth:
 *   List:   semester member (read) — semesterId in URL
 *   Detail: semester member (read) — semester_id derived from crossFlagId
 *     The detail route cannot use requireAuth middleware directly because the
 *     semesterId is unknown at middleware time (it's a row-level field). Instead
 *     it calls findMembership + authorize inline after fetching the row.
 *
 * Rate: read.cohort.
 *
 * Audit: cross-flag reads are not individually logged per PRD §13.
 */

import { Hono } from 'hono';
import { getDb } from '../../../db/client.js';
import { requireAuth } from '../../middleware/authorize.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { Errors } from '../errors.js';
import {
  listCrossFlags,
  listCrossScopeExclusions,
  decodeCrossFlagCursor,
  type CrossFlagFilters,
} from '../../../services/cross-flags/list.js';
import { getCrossFlag } from '../../../services/cross-flags/detail.js';
import { authorize } from '../../../auth/authorize.js';
import { findMembership } from '../../../auth/membership-cache.js';
import { requirePrincipal } from '../../middleware/auth-session.js';
import type { Severity } from '@provenance/analysis-core/heuristics/types.js';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createCrossFlagsRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/cross-flags
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/cross-flags',
    rateLimit('read.cohort'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const filters: CrossFlagFilters = {};

      const heuristicId = c.req.query('heuristic_id');
      if (heuristicId) filters.heuristicId = heuristicId;

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

      const submissionId = c.req.query('submission_id');
      if (submissionId) filters.submissionId = submissionId;

      const rawLimit = parseInt(c.req.query('limit') ?? '50', 10);
      const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : rawLimit > 500 ? 500 : rawLimit;

      const cursorStr = c.req.query('cursor');
      const cursor = cursorStr !== undefined ? decodeCrossFlagCursor(cursorStr) : null;
      if (cursorStr !== undefined && cursor === null) {
        return c.json(
          Errors.validation([{ field: 'cursor', issue: 'Invalid cursor' }]).toBody(),
          400,
        );
      }

      const protectedMode = requirePrincipal(c).user.protected;
      const result = await listCrossFlags(db, semesterId, filters, cursor, limit, protectedMode);

      // The exclusion register (spec S20 / §6 Rule 3): which comparisons were
      // NOT made, and why. Returned beside the findings because it is the
      // answer to "why is there nothing here?", and only on the FIRST page —
      // it is not paginated, and the list view accumulates pages, so page one
      // is where it belongs. A grader who has to ask a second question to find
      // out that a comparison was withheld will not ask.
      const exclusions =
        cursor === null
          ? await listCrossScopeExclusions(db, semesterId, filters, protectedMode)
          : [];

      return c.json({
        items: result.items,
        next_cursor: result.nextCursor,
        exclusions,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /cross-flags/:crossFlagId
  //
  // Top-level endpoint — not under /semesters. Derives semester_id from the
  // cross_flags row and checks membership inline (cannot use requireAuth
  // middleware because semesterId is unknown until after the DB fetch).
  // -------------------------------------------------------------------------

  router.get('/cross-flags/:crossFlagId', rateLimit('read.cohort'), async (c) => {
    const crossFlagId = c.req.param('crossFlagId')!;
    const db = getDb();

    // Auth: require authenticated principal first
    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const protectedMode = principal.user.protected;

    // Fetch the cross_flag row to get semester_id
    const result = await getCrossFlag(db, crossFlagId, protectedMode);
    if (result === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    // Check membership in the derived semester
    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, result.semesterId);
    const authResult = authorize(principal, 'read', { semesterId: result.semesterId }, membership);
    if (!authResult.ok) {
      // Return 404 for membership failures to avoid leaking cross_flag existence
      return c.json(Errors.notFound().toBody(), 404);
    }

    // Wrap in `{ item }` to match CrossFlagDetailResponseSchema in shared.
    // Pre-2026-05-27 the server returned the flat object, which silently
    // failed Zod parsing on the analyzer side — the CrossFlag detail page
    // showed empty / errored without surfacing the contract gap.
    return c.json({ item: result.item });
  });

  return router;
}
