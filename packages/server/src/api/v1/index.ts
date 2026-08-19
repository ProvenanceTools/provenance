/**
 * API v1 — Hono app composition.
 *
 * Mounts auth and me routes under /api/v1.
 * Imported by api/start.ts which mounts this under '/api/v1'.
 *
 * Route order: /me/tokens is mounted before /me so the more-specific prefix
 * is registered first and cannot be shadowed by the broader /me handler.
 *
 * Pipeline established here (applies to all v1 routes):
 *   authSessionMiddleware  — resolves bearer/session principal → c.var.principal
 *   initMembershipCache    — initializes empty per-request membership cache
 *
 * Per-route middleware composition example (for future phases):
 *
 *   router.post('/semesters/:id/config',
 *     rateLimit('write.config'),
 *     requireAuth({ action: 'write', target: (c) => ({ semesterId: c.req.param('id') }) }),
 *     audit('heuristic_config.commit', 'semester', (c) => c.req.param('id')),
 *     handler,
 *   );
 *
 * The three middleware factory calls give a new endpoint:
 *   - Rate limiting (per principal, per route class)
 *   - Authorization (action + semester-scoped membership check)
 *   - Audit logging (fire-and-forget row on 2xx)
 */

import { Hono } from 'hono';
import { createAuthRouter } from './routes/auth.js';
import { createMeRouter } from './routes/me.js';
import { createMeTokensRouter } from './routes/me-tokens.js';
import { createCoursesRouter } from './routes/courses.js';
import { createSemestersRouter } from './routes/semesters.js';
import { createMembersRouter } from './routes/members.js';
import { createRosterRouter } from './routes/roster.js';
import { createEnrollmentRouter } from './routes/enrollment.js';
import { createIngestRouter } from './routes/ingest.js';
import { createHeuristicConfigRouter } from './routes/heuristic-config.js';
import { createUnmatchedRouter } from './routes/unmatched.js';
import { createCohortRouter } from './routes/cohort.js';
import { createAssignmentsRouter } from './routes/assignments.js';
import { createCrossFlagsRouter } from './routes/cross-flags.js';
import { createSubmissionsRouter } from './routes/submissions.js';
import { createEventsRouter } from './routes/events.js';
import { createFilesRouter } from './routes/files.js';
import { createBundleRouter } from './routes/bundle.js';
import { createBlobDownloadRouter } from './routes/blob-download.js';
import { createAuditRouter } from './routes/audit.js';
import { createAdminRouter } from './routes/admin.js';
import { createOpenApiRouter } from './routes/openapi.js';
import { createDocsRouter } from './routes/docs.js';
import { authSessionMiddleware } from '../middleware/auth-session.js';
import { initMembershipCache } from '../../auth/membership-cache.js';
import { errorFormatter } from '../middleware/error.js';

export function createV1App(): Hono {
  const app = new Hono();

  // Cache-Control: no-store on all v1 responses by default (PRD §7.7).
  // Individual routes may override this (e.g. /openapi.json, /docs, /files/*/content).
  // We set it AFTER next() so routes that set their own Cache-Control win.
  app.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) {
      c.res.headers.set('Cache-Control', 'no-store');
    }
  });

  // Auth resolution runs before all v1 routes.
  app.use('*', authSessionMiddleware);

  // Membership cache is initialized per-request so requireAuth can call
  // findMembership() without hitting the DB more than once per semester.
  app.use('*', initMembershipCache);

  app.route('/auth', createAuthRouter());
  // Mount /me/tokens before /me to prevent prefix shadowing.
  app.route('/me/tokens', createMeTokensRouter());
  app.route('/me', createMeRouter());
  // Mount courses and semesters routes.
  // createCoursesRouter declares paths relative to /courses (e.g. '/', '/:courseId').
  // createSemestersRouter declares full paths (e.g. '/courses/:courseId/semesters',
  // '/semesters/:semesterId') so it mounts at root '/'.
  app.route('/courses', createCoursesRouter());
  app.route('/', createSemestersRouter());
  // Members + invitations routes.
  // Paths: /semesters/:semesterId/members and /semesters/:semesterId/invitations/:id
  app.route('/', createMembersRouter());

  // Student enrollment (program spec §5a — S2).
  // Path: /semesters/:semesterId/enrollment (POST)
  //
  // The ONLY route a student — as opposed to course staff — can reach. It is
  // mounted before the roster/ingest/cohort routers purely for readability;
  // paths do not overlap. Authorization is roster membership, not `memberships`,
  // so it deliberately does NOT use requireAuth.
  app.route('/', createEnrollmentRouter());

  // Roster routes.
  // Paths: /semesters/:semesterId/roster (GET, POST :upload, POST :commit, PATCH /:id)
  app.route('/', createRosterRouter());

  // Ingest routes.
  // Paths: /semesters/:semesterId/ingest (POST),
  //        /semesters/:semesterId/ingest/jobs (GET),
  //        /semesters/:semesterId/ingest/jobs/:jobId/cancel (POST)
  app.route('/', createIngestRouter());

  // Heuristic config routes.
  // Paths: /semesters/:semesterId/heuristic-config (GET, PUT)
  //        /semesters/:semesterId/heuristic-configs (GET)
  app.route('/', createHeuristicConfigRouter());

  // Unmatched tray routes (Phase 15).
  // Paths: /semesters/:semesterId/unmatched (GET)
  //        /semesters/:semesterId/unmatched/:ingestFileId (PATCH)
  //        /semesters/:semesterId/unmatched/:ingestFileId/discard (POST)
  app.route('/', createUnmatchedRouter());

  // Cohort routes (Phase 16).
  // Paths: /semesters/:semesterId/submissions (GET)
  //        /semesters/:semesterId/students (GET)
  //        /semesters/:semesterId/assignments (GET)
  app.route('/', createCohortRouter());

  // Assignment mutation route (V46 — closes Phase 22 carry-over).
  // Path: /semesters/:semesterId/assignments/:assignmentId (PATCH)
  app.route('/', createAssignmentsRouter());

  // Cross-flags routes (Phase 16).
  // Paths: /semesters/:semesterId/cross-flags (GET)
  //        /cross-flags/:crossFlagId (GET — top-level)
  app.route('/', createCrossFlagsRouter());

  // Per-submission routes (Phase 17 + Group F).
  // Paths: /submissions/:submissionId (GET)
  //        /submissions/:submissionId/flags (GET)
  //        /submissions/:submissionId/stats (GET)
  //        /submissions/:submissionId/validation (GET)
  //        /submissions/:submissionId/files (GET)
  //        /submissions/:submissionId/submitted-files (GET)
  //        /submissions/:submissionId/submitted-files/:path{.+} (GET)
  app.route('/', createSubmissionsRouter());

  // Events routes (Phase 17).
  // Paths: /submissions/:submissionId/events (GET)
  //        /submissions/:submissionId/events/:seq (GET)
  app.route('/', createEventsRouter());

  // File content + provenance routes (Phase 18).
  // Paths: /submissions/:submissionId/files/:path{.+}/content (GET)
  //        /submissions/:submissionId/files/:path{.+}/provenance (GET)
  app.route('/', createFilesRouter());

  // Bundle download route (Phase 18).
  // Paths: /submissions/:submissionId/bundle (GET → 302)
  app.route('/', createBundleRouter());

  // Blob download route (fs storage backend presigned-URL target).
  // Path: /blob (GET) — self-authenticating via HMAC query token; no
  // session/token auth (the token IS the credential, same as S3 presigned
  // URLs). Not gated by authSessionMiddleware above: that middleware only
  // 401s when an Authorization header is present but invalid — it does not
  // require credentials to be present, so an unauthenticated request (the
  // normal case for a presigned download link) passes through to the
  // handler, which performs no principal check of its own.
  app.route('/', createBlobDownloadRouter());

  // Audit log route (Phase 19).
  // Path: /audit (GET — semester admin or superadmin)
  app.route('/', createAuditRouter());

  // Admin routes (V45 — superadmin only).
  // Paths: /admin/users (GET, GET :id, DELETE :id)
  //        /admin/view-as (POST), /admin/view-as/exit (POST)
  app.route('/admin', createAdminRouter());

  // OpenAPI spec + Redoc docs (Phase 19).
  // Paths: /openapi.json (GET — public), /docs (GET — public)
  app.route('/', createOpenApiRouter());
  app.route('/', createDocsRouter());

  // Global error handler
  app.onError(errorFormatter);

  return app;
}
