/**
 * Per-submission routes — Phase 17 (PRD §8.9).
 *
 * GET /submissions/:submissionId/summary    — full summary
 * GET /submissions/:submissionId/flags      — flag list
 * GET /submissions/:submissionId/stats      — per-file + aggregate stats
 * GET /submissions/:submissionId/validation — validation results
 * GET /submissions/:submissionId/files      — file list (path + length + saves)
 *
 * Auth: read on the submission's semester. All routes use inline auth (the
 * semester_id is derived from the submission row, so requireAuth middleware
 * cannot be used — semesterId unknown until after the DB fetch).
 *
 * Pattern: same as cross-flags detail (V34). Derive semester from row, then
 * call authorize() manually. Return 404 (not 403) on membership failure to
 * avoid leaking submission existence to non-members.
 *
 * Rate: read.detail (PRD §8.9).
 *
 * Audit: reads are NOT logged per PRD §13 cohort-read convention.
 */

import { Hono } from 'hono';
import { getDb } from '../../../db/client.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { Errors } from '../errors.js';
import { authorize } from '../../../auth/authorize.js';
import { findMembership } from '../../../auth/membership-cache.js';
import { resolveSemesterFromSubmission } from '../../../services/submissions/resolve.js';
import { getSubmissionSummary } from '../../../services/submissions/summary.js';
import { rootPublicKeyHex } from '../../../config/root-key.js';
import { getSubmissionFlags } from '../../../services/submissions/flags.js';
import { getSubmissionStats } from '../../../services/submissions/stats.js';
import {
  getSubmissionValidation,
  getStoredChainIntact,
} from '../../../services/submissions/validation.js';
import { getSubmissionFiles } from '../../../services/submissions/files.js';
import { getBlob } from '../../../services/storage/blobs.js';
import { bundleKey } from '../../../services/storage/keys.js';
import { createStorageClient, storageConfigFromEnv } from '../../../services/storage/client.js';
import { getStorageClient } from '../../../services/storage/default-client.js';
import { getConfig } from '../../../config/index.js';
import {
  extractSubmittedFiles,
  extractSubmittedFileContent,
} from '../../../services/submissions/submitted-files.js';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createSubmissionsRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/summary
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/summary', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorize(principal, 'read', { semesterId }, membership);
    if (!authResult.ok) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const protectedMode = principal.user.protected;
    const summaryStorage = getStorageClient();
    const summary = await getSubmissionSummary(
      db,
      summaryStorage,
      submissionId,
      protectedMode,
      rootPublicKeyHex(),
    );
    if (summary === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    return c.json(summary);
  });

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/flags
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/flags', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorize(principal, 'read', { semesterId }, membership);
    if (!authResult.ok) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const flags = await getSubmissionFlags(db, submissionId);
    return c.json({ flags });
  });

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/stats
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/stats', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorize(principal, 'read', { semesterId }, membership);
    if (!authResult.ok) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const stats = await getSubmissionStats(db, getStorageClient(), submissionId);
    return c.json(stats);
  });

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/validation
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/validation', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorize(principal, 'read', { semesterId }, membership);
    if (!authResult.ok) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const validation = await getSubmissionValidation(db, submissionId);
    if (validation === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    return c.json(validation);
  });

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/files
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/files', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorize(principal, 'read', { semesterId }, membership);
    if (!authResult.ok) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const files = await getSubmissionFiles(db, submissionId);
    return c.json({ files });
  });

  // -------------------------------------------------------------------------
  // Shared blob helper (submitted-files routes only)
  // -------------------------------------------------------------------------

  async function readBundleBlob(
    semesterId: string,
    submissionId: string,
  ): Promise<ArrayBuffer | null> {
    try {
      const cfg = getConfig();
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      const stream = await getBlob(storageClient, bundleKey(semesterId, submissionId));
      // Buffer the stream into an ArrayBuffer (same pattern as parse-bundle-phase.ts).
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.byteLength;
      }
      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return combined.buffer as ArrayBuffer;
    } catch {
      // Blob gone (retention sweep) or storage error — callers return available:false / 404.
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/submitted-files
  // -------------------------------------------------------------------------

  router.get('/submissions/:submissionId/submitted-files', rateLimit('read.detail'), async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const db = getDb();

    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }

    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const cache = c.var.membershipCache;
    const membership = await findMembership(cache, db, principal.user.id, semesterId);
    const authResult = authorize(principal, 'read', { semesterId }, membership);
    if (!authResult.ok) {
      return c.json(Errors.notFound().toBody(), 404);
    }

    const blob = await readBundleBlob(semesterId, submissionId);
    if (blob === null) {
      return c.json({ available: false, files: [] });
    }
    // Gate the per-file verdicts on the STORED chain_integrity verdict, so this
    // tab and the Validation tab cannot disagree about it on one page load.
    const gate = await getStoredChainIntact(db, submissionId);
    return c.json(await extractSubmittedFiles(blob, gate));
  });

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/submitted-files/:path{.+}
  //
  // Uses the Hono `:path{.+}` regex-param syntax (same as files.ts) to capture
  // multi-segment paths such as `lab02/q1.py` that would otherwise be split by
  // the router. The analyzer encodes the path with encodeURIComponent before
  // appending it to the URL; decodeURIComponent here restores the original.
  // -------------------------------------------------------------------------

  router.get(
    '/submissions/:submissionId/submitted-files/:path{.+}',
    rateLimit('read.detail'),
    async (c) => {
      const submissionId = c.req.param('submissionId')!;
      const filePath = decodeURIComponent(c.req.param('path')!);
      const db = getDb();

      const principal = c.var.principal ?? null;
      if (principal === null) {
        const returnTo = encodeURIComponent(c.req.path);
        return c.json(
          Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
          401,
        );
      }

      const semesterId = await resolveSemesterFromSubmission(db, submissionId);
      if (semesterId === null) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const cache = c.var.membershipCache;
      const membership = await findMembership(cache, db, principal.user.id, semesterId);
      const authResult = authorize(principal, 'read', { semesterId }, membership);
      if (!authResult.ok) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const blob = await readBundleBlob(semesterId, submissionId);
      if (blob === null) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      const gate = await getStoredChainIntact(db, submissionId);
      const content = await extractSubmittedFileContent(blob, filePath, gate);
      if (content === null) {
        return c.json(Errors.notFound().toBody(), 404);
      }

      return c.json(content);
    },
  );

  return router;
}
