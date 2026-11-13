/**
 * Heuristic config routes — Phase 13b (PRD §8.11).
 *
 * GET    /semesters/:semesterId/heuristic-config          — get active config (semester member)
 * GET    /semesters/:semesterId/heuristic-configs         — list history (semester member)
 * PUT    /semesters/:semesterId/heuristic-config          — dry-run or commit (semester admin)
 * POST   /semesters/:semesterId/recompute               — enqueue recompute (semester admin)
 * GET    /semesters/:semesterId/recompute/:jobId           — poll recompute job status
 *
 * ## PUT ?dryRun=true
 *
 * - Validates the candidate config (422 on invalid).
 * - Requires `If-Match: <currentVersion>` header:
 *     - Missing → 428 PRECONDITION_REQUIRED
 *     - Mismatch → 409 CONFIG_VERSION_CONFLICT
 * - Returns DryRunDiff per PRD §8.11.
 *
 * ## PUT ?dryRun=false (or omitted)
 *
 * - Validates same as dry-run.
 * - Requires If-Match: <currentVersion>.
 * - Atomically commits the new active config via commitNewVersion().
 * - Enqueues a recompute_semester pg-boss job.
 * - Returns the new config row (id, version, set_at, recompute_job_id).
 *
 * ## POST /recompute
 *
 * - Enqueues a recompute_semester job for the current active config.
 * - 404 if no active config exists.
 * - Body: { note?: string } optional admin note.
 * - Returns { recompute_job: { id, semester_id, target_config_id, ... } }.
 *
 * ## GET /recompute/:jobId
 *
 * - Returns the recompute_jobs row (status, progress, completed_at, etc.).
 * - 404 if not found or not in this semester.
 *
 * ## Audit actions
 *
 *   heuristic_config.read     — GET active config
 *   heuristic_config.history  — GET history
 *   heuristic_config.dry_run  — PUT?dryRun=true
 *   heuristic_config.commit   — PUT?dryRun=false
 *   heuristic_config.recompute — POST /recompute
 *
 * ## PUT audit note
 *
 * The PUT handler fires the audit row manually inside the handler body (not via
 * middleware) because the action string depends on ?dryRun. Both paths return
 * 2xx and must emit different audit actions. Using audit() middleware with a
 * fixed action would emit the wrong action for one path.
 */

import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { requireAuth } from '../../middleware/authorize.js';
import { requirePrincipal } from '../../middleware/auth-session.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit, insertAuditRow } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import {
  getActiveConfig,
  listConfigHistory,
  validateConfig,
  DEFAULT_SERVER_CONFIG,
  commitNewVersion,
  createRecomputeJob,
} from '../../../services/heuristics/config.js';
import { computeDryRunDiff } from '../../../services/scoring/dry-run.js';
import { getBoss, JOB_KINDS } from '../../../jobs/pg-boss.js';
import type { RecomputeSemesterPayload } from '../../../jobs/recompute.js';
import { recompute_jobs } from '../../../db/schema.js';

/** Canonical UUID form, for path-param validation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createHeuristicConfigRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/heuristic-config — active config
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/heuristic-config',
    rateLimit('read.detail'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('heuristic_config.read', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const active = await getActiveConfig(db, semesterId);
      if (!active) {
        // No config yet (semester has no admin, backfill was skipped).
        // Return the default config as a virtual v0 response.
        return c.json({
          id: null,
          version: 0,
          config: DEFAULT_SERVER_CONFIG,
          set_at: null,
          note: 'default (no config committed yet)',
          is_active: true,
        });
      }

      return c.json({
        id: active.id,
        version: active.version,
        config: active.config,
        set_at: active.set_at.toISOString(),
        note: active.note,
        is_active: true,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/heuristic-configs — version history
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/heuristic-configs',
    rateLimit('read.detail'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('heuristic_config.history', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();

      const history = await listConfigHistory(db, semesterId);

      return c.json({
        configs: history.map((row) => ({
          id: row.id,
          version: row.version,
          set_at: row.set_at.toISOString(),
          set_by: row.set_by,
          note: row.note,
          is_active: row.is_active,
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // PUT /semesters/:semesterId/heuristic-config — dry-run or commit
  //
  // Audit rows are fired manually inside the handler (not via middleware) because
  // both ?dryRun=true and ?dryRun=false return 2xx but require different audit
  // actions (heuristic_config.dry_run vs heuristic_config.commit).
  // -------------------------------------------------------------------------

  router.put(
    '/semesters/:semesterId/heuristic-config',
    rateLimit('write.config'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const isDryRun = c.req.query('dryRun') === 'true';

      // -----------------------------------------------------------------------
      // If-Match header validation (required for both dry-run and commit).
      // -----------------------------------------------------------------------
      const ifMatch = c.req.header('If-Match');
      if (!ifMatch) {
        return c.json(
          {
            error: {
              code: 'PRECONDITION_REQUIRED',
              message:
                'If-Match header is required; set it to the current active config version (or "0" if none)',
            },
          },
          428,
        );
      }

      const ifMatchVersion = parseInt(ifMatch, 10);
      if (isNaN(ifMatchVersion)) {
        return c.json(
          {
            error: {
              code: 'PRECONDITION_REQUIRED',
              message: 'If-Match header must be a numeric version string',
            },
          },
          428,
        );
      }

      // -----------------------------------------------------------------------
      // Check current active config version against If-Match.
      // -----------------------------------------------------------------------
      const db = getDb();
      const active = await getActiveConfig(db, semesterId);
      const currentVersion = active?.version ?? 0;

      if (ifMatchVersion !== currentVersion) {
        throw Errors.configVersionConflict(currentVersion);
      }

      // -----------------------------------------------------------------------
      // Parse + validate the request body.
      // -----------------------------------------------------------------------
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        throw Errors.validation([{ message: 'Request body must be valid JSON' }]);
      }

      const validationResult = validateConfig(rawBody);
      if (!validationResult.ok) {
        throw Errors.heuristicConfigInvalid(validationResult.errors.join('; '));
      }

      const candidateConfig = validationResult.config;
      const candidateVersion = currentVersion + 1;

      // -----------------------------------------------------------------------
      // Helper: fire the audit row after the response is ready.
      //
      // Both paths return 2xx. We use insertAuditRow directly (not middleware)
      // so we can choose the action string at runtime.
      // -----------------------------------------------------------------------
      const principal = c.var.principal!;
      const actorUserId = principal.user.id;
      const actorTokenId = principal.principal_kind === 'token' ? principal.token.id : null;
      const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null;
      const userAgent = c.req.header('user-agent') ?? null;

      // -----------------------------------------------------------------------
      // Branch: dry-run path.
      // -----------------------------------------------------------------------
      if (isDryRun) {
        const protectedMode = requirePrincipal(c).user.protected;
        const diff = await computeDryRunDiff(db, semesterId, candidateConfig, candidateVersion, {
          active,
          protectedMode,
        });

        // Fire audit row fire-and-forget.
        void insertAuditRow({
          actorUserId,
          actorTokenId,
          semesterId,
          action: 'heuristic_config.dry_run',
          targetType: 'semester',
          targetId: semesterId,
          detail: { semesterId, candidate_version: candidateVersion },
          ip,
          userAgent,
          at: new Date(),
        }).catch(() => {
          /* fire-and-forget */
        });

        return c.json(diff);
      }

      // -----------------------------------------------------------------------
      // Branch: commit path.
      //
      // 1. commitNewVersion() atomically: deactivate old row, insert new row,
      //    create recompute_jobs row — all in one transaction.
      // 2. Enqueue a recompute_semester pg-boss job OUTSIDE the transaction.
      //    (pg-boss send must not be inside the Drizzle transaction to avoid
      //    deadlock with the pg-boss schema tables.)
      // -----------------------------------------------------------------------
      const note = (rawBody as Record<string, unknown>)['note'];
      const noteStr = typeof note === 'string' ? note : '';

      const { newConfigId, newVersion, newConfigSetAt, recomputeJobId } = await commitNewVersion(
        db,
        semesterId,
        candidateConfig,
        actorUserId,
        noteStr,
        ifMatchVersion,
      );

      // Enqueue the recompute_semester job (outside transaction).
      const boss = await getBoss();
      await boss.send(
        JOB_KINDS.RECOMPUTE_SEMESTER,
        {
          recomputeJobId,
          semesterId,
          targetConfigId: newConfigId,
        } satisfies RecomputeSemesterPayload,
        {
          retryLimit: 5, // PRD §12.3
        },
      );

      // Fire audit row fire-and-forget.
      void insertAuditRow({
        actorUserId,
        actorTokenId,
        semesterId,
        action: 'heuristic_config.commit',
        targetType: 'semester',
        targetId: semesterId,
        detail: {
          semesterId,
          new_version: newVersion,
          new_config_id: newConfigId,
          recompute_job_id: recomputeJobId,
        },
        ip,
        userAgent,
        at: new Date(),
      }).catch(() => {
        /* fire-and-forget */
      });

      return c.json({
        new_config: {
          id: newConfigId,
          version: newVersion,
          set_at: newConfigSetAt.toISOString(),
          note: noteStr,
          is_active: true,
        },
        recompute_job: {
          id: recomputeJobId,
          status: 'queued',
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /semesters/:semesterId/recompute — PRD §8.11
  //
  // Enqueues a recompute of the current active config without changing it.
  // Returns 404 if no active config exists for the semester.
  // Body: { note?: string } — optional admin note stored on the job row.
  // -------------------------------------------------------------------------

  router.post(
    '/semesters/:semesterId/recompute',
    rateLimit('write.config'),
    requireAuth({
      action: 'write',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    audit('heuristic_config.recompute', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const db = getDb();
      const principal = c.var.principal!;

      // Read optional note from request body (PRD §8.11 body: { note?: string }).
      let note: string | undefined;
      try {
        const rawBody = await c.req.json().catch(() => null);
        if (rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)) {
          const n = (rawBody as Record<string, unknown>)['note'];
          if (typeof n === 'string') note = n;
        }
      } catch {
        // Body is optional; ignore parse errors
      }

      const result = await createRecomputeJob(db, semesterId, principal.user.id, note);
      if (!result) {
        // No active config — cannot recompute against a default config.
        return c.json(
          {
            error: {
              code: 'NOT_FOUND',
              message: 'No active heuristic config found for this semester; commit one first',
            },
          },
          404,
        );
      }

      const { recomputeJobId, targetConfigId, jobRow } = result;

      // Enqueue the recompute_semester job.
      const boss = await getBoss();
      await boss.send(
        JOB_KINDS.RECOMPUTE_SEMESTER,
        {
          recomputeJobId,
          semesterId,
          targetConfigId,
        } satisfies RecomputeSemesterPayload,
        {
          retryLimit: 5, // PRD §12.3
        },
      );

      c.set('auditDetail', { semesterId, recompute_job_id: recomputeJobId });

      return c.json({
        recompute_job: jobRow,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /semesters/:semesterId/recompute/:jobId — poll job status
  // -------------------------------------------------------------------------

  router.get(
    '/semesters/:semesterId/recompute/:jobId',
    rateLimit('read.detail'),
    requireAuth({
      action: 'read',
      target: (c) => ({ semesterId: c.req.param('semesterId')! }),
    }),
    // Audit polling: kept intentionally low-noise (one row per actual poll request).
    // High-frequency polling by clients will produce many rows; if this becomes
    // too noisy in production, move to a sampled audit approach in Phase 19.
    audit('heuristic_config.read_job', 'semester', (c) => c.req.param('semesterId')!),
    async (c) => {
      const semesterId = c.req.param('semesterId')!;
      const jobId = c.req.param('jobId')!;

      // Validate before it reaches Postgres. A non-UUID lands in `WHERE id = $1`
      // on a uuid column, which throws and surfaces as a 500 -- a client passing
      // a bad id should get a 400, not look like a server fault.
      if (!UUID_RE.test(jobId)) {
        throw Errors.validation([{ path: 'jobId', message: 'jobId must be a UUID' }]);
      }

      const db = getDb();

      const rows = await db
        .select({
          id: recompute_jobs.id,
          semester_id: recompute_jobs.semester_id,
          target_config_id: recompute_jobs.target_config_id,
          triggered_by: recompute_jobs.triggered_by,
          status: recompute_jobs.status,
          progress_total: recompute_jobs.progress_total,
          progress_done: recompute_jobs.progress_done,
          progress_failed: recompute_jobs.progress_failed,
          created_at: recompute_jobs.created_at,
          started_at: recompute_jobs.started_at,
          completed_at: recompute_jobs.completed_at,
          summary: recompute_jobs.summary,
        })
        .from(recompute_jobs)
        .where(and(eq(recompute_jobs.id, jobId), eq(recompute_jobs.semester_id, semesterId)))
        .limit(1);

      const jobRow = rows[0];
      if (!jobRow) {
        throw Errors.notFound();
      }

      return c.json({
        id: jobRow.id,
        semester_id: jobRow.semester_id,
        target_config_id: jobRow.target_config_id,
        triggered_by: jobRow.triggered_by,
        status: jobRow.status,
        progress_total: jobRow.progress_total,
        progress_done: jobRow.progress_done,
        progress_failed: jobRow.progress_failed,
        created_at: jobRow.created_at.toISOString(),
        started_at: jobRow.started_at?.toISOString() ?? null,
        completed_at: jobRow.completed_at?.toISOString() ?? null,
        summary: jobRow.summary,
      });
    },
  );

  return router;
}
