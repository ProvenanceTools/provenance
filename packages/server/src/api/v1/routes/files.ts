/**
 * File content and provenance routes — Phase 18 (PRD §8.9).
 *
 * GET /submissions/:submissionId/files/:path{.+}/content
 * GET /submissions/:submissionId/files/:path{.+}/provenance
 *
 * The `:path{.+}` Hono syntax captures multi-segment file paths
 * (e.g. `src/utils/foo.py`) into a named `path` parameter via the inline
 * regex `{.+}`. The decoded value equals the per_file_stats.file_path string.
 *
 * Auth: read on the submission's semester. Inline auth — same pattern as
 * submissions.ts (V34 / V35): derive semesterId post-fetch, return 404 on
 * membership failure (avoids existence leaks).
 *
 * Rate: read.detail (PRD §8.9).
 *
 * Cache-Control: max-age=60, private (PRD §8.9 line 1227).
 *
 * Error semantics:
 *   - FILE_NOT_FOUND (404)           — path not in per_file_stats
 *   - FILE_RECONSTRUCTION_TAINTED    — 200 with content:"" + warning field
 *   - FILE_RECONSTRUCTION_CONCURRENT — 200 with content:"" + warning field.
 *     Two provably different contributors edited this file on lineages the
 *     evidence does not order (Tier 2.2), so there is no single content. These
 *     routes go through the SEGMENTED reconstruction; they used to call the
 *     unscoped replay, which silently linearized every branch into one string
 *     and attributed it per character.
 *   - FILE_RECONSTRUCTION_UNKNOWN    — 200 with content:"" + warning field.
 *     The happens-before relation does not reach some of these events. Never
 *     merged with CONCURRENT: the absence of a record is not a raced edit.
 */

import { Hono } from 'hono';
import { getDb } from '../../../db/client.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { Errors, Warnings } from '../errors.js';
import { authorize } from '../../../auth/authorize.js';
import { findMembership } from '../../../auth/membership-cache.js';
import { resolveSemesterFromSubmission } from '../../../services/submissions/resolve.js';
import { reconstructFile } from '../../../services/reconstruction.js';
import { encodeRle } from '../../../services/provenance-rle.js';
import { loadSubmissionIndex } from '../../../services/bundle/load-index.js';
import { getStorageClient } from '../../../services/storage/default-client.js';
import type { StorageClient } from '../../../services/storage/client.js';
import type { DrizzleDb } from '../../../db/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the last `doc.save` event's seq for a given submission + file path.
 * Falls back to the last event's seq overall if no doc.save exists for the file.
 * Returns undefined if there are no events at all for the submission.
 *
 * The file path filter uses `payload->>'path'` — same JSONB pattern as the
 * events query builder (V35). No covering index; acceptable at per-submission
 * scale (~10k events).
 */
async function resolveDefaultAtSeq(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
  filePath: string,
): Promise<number | undefined> {
  const { index } = await loadSubmissionIndex(db, storage, submissionId);

  // Last doc.save for this file → its globalIdx (= the API's seq). byFile is in
  // chronological order, so the last matching doc.save is the newest.
  const fileEvents = index.byFile.get(filePath);
  if (fileEvents !== undefined) {
    for (let i = fileEvents.length - 1; i >= 0; i--) {
      if (fileEvents[i]!.kind === 'doc.save') {
        return fileEvents[i]!.globalIdx;
      }
    }
  }

  // No doc.save for this file — fall back to the last event seq overall.
  const ordered = index.ordered;
  return ordered.length > 0 ? ordered[ordered.length - 1]!.globalIdx : undefined;
}

/**
 * Parse the `at_seq` query parameter. Returns the parsed integer, undefined
 * if not present, or a validation error message if invalid.
 */
function parseAtSeq(raw: string | undefined): { value: number | undefined } | { error: string } {
  if (raw === undefined) return { value: undefined };
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) {
    return { error: 'at_seq must be a non-negative integer' };
  }
  return { value: parsed };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createFilesRouter(): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/files/:path{.+}/content
  // -------------------------------------------------------------------------

  router.get(
    '/submissions/:submissionId/files/:path{.+}/content',
    rateLimit('read.detail'),
    async (c) => {
      const submissionId = c.req.param('submissionId')!;
      const filePath = decodeURIComponent(c.req.param('path')!);
      const db = getDb();

      // Inline auth (V34 / V35 pattern).
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

      // Parse at_seq query param.
      const atSeqParsed = parseAtSeq(c.req.query('at_seq'));
      if ('error' in atSeqParsed) {
        return c.json(
          Errors.validation([{ path: 'at_seq', message: atSeqParsed.error }]).toBody(),
          400,
        );
      }

      // Resolve default atSeq (last doc.save, or last event) if not supplied.
      const storage = getStorageClient();
      const atSeq =
        atSeqParsed.value !== undefined
          ? atSeqParsed.value
          : await resolveDefaultAtSeq(db, storage, submissionId, filePath);

      let result;
      try {
        result = await reconstructFile(db, storage, submissionId, filePath, atSeq);
      } catch (err: unknown) {
        const e = err as Record<string, unknown>;
        if (e['code'] === 'FILE_NOT_FOUND') {
          return c.json(Errors.fileNotFound(filePath).toBody(), 404);
        }
        throw err;
      }

      c.header('Cache-Control', 'max-age=60, private');

      // Tier 2.2 — no single content. Reported BEFORE `tainted` because it is
      // the stronger statement: tainted means "one content, best-effort", this
      // means there is no content to qualify. Same 200 + empty-content + warning
      // shape the tainted path already uses, so a client that handles one
      // handles both.
      if (result.ambiguity !== null) {
        return c.json({
          submission_id: submissionId,
          path: filePath,
          at_seq: atSeq ?? null,
          content: '',
          computed_at_ms: result.computedAtMs,
          ...Warnings.fileReconstructionAmbiguous(
            filePath,
            result.ambiguity.kind,
            result.ambiguity.detail,
          ),
        });
      }

      // Tainted file: PRD §8.9 line 1228 — return 200 with content:"" + warning.
      if (result.tainted) {
        return c.json({
          submission_id: submissionId,
          path: filePath,
          at_seq: atSeq ?? null,
          content: '',
          computed_at_ms: result.computedAtMs,
          ...Warnings.fileReconstructionTainted(filePath, 'reconstruction tainted'),
        });
      }

      return c.json({
        submission_id: submissionId,
        path: filePath,
        at_seq: atSeq ?? null,
        content: result.content,
        computed_at_ms: result.computedAtMs,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /submissions/:submissionId/files/:path{.+}/provenance
  // -------------------------------------------------------------------------

  router.get(
    '/submissions/:submissionId/files/:path{.+}/provenance',
    rateLimit('read.detail'),
    async (c) => {
      const submissionId = c.req.param('submissionId')!;
      const filePath = decodeURIComponent(c.req.param('path')!);
      const db = getDb();

      // Inline auth.
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

      // Parse at_seq.
      const atSeqParsed = parseAtSeq(c.req.query('at_seq'));
      if ('error' in atSeqParsed) {
        return c.json(
          Errors.validation([{ path: 'at_seq', message: atSeqParsed.error }]).toBody(),
          400,
        );
      }

      const storage = getStorageClient();
      const atSeq =
        atSeqParsed.value !== undefined
          ? atSeqParsed.value
          : await resolveDefaultAtSeq(db, storage, submissionId, filePath);

      let result;
      try {
        result = await reconstructFile(db, storage, submissionId, filePath, atSeq);
      } catch (err: unknown) {
        const e = err as Record<string, unknown>;
        if (e['code'] === 'FILE_NOT_FOUND') {
          return c.json(Errors.fileNotFound(filePath).toBody(), 404);
        }
        throw err;
      }

      c.header('Cache-Control', 'max-age=60, private');

      // Tier 2.2 — no single content means no single per-character attribution
      // either. Colouring one lineage's characters as though they were the
      // file's would attribute text to a named contributor on the strength of a
      // coin flip, which is the fabrication this endpoint most needs to avoid.
      if (result.ambiguity !== null) {
        return c.json({
          submission_id: submissionId,
          path: filePath,
          at_seq: atSeq ?? null,
          length: 0,
          provenance: [],
          ...Warnings.fileReconstructionAmbiguous(
            filePath,
            result.ambiguity.kind,
            result.ambiguity.detail,
          ),
        });
      }

      const provenanceRuns = encodeRle(result.provenance, result.kindByGlobalIdx);

      return c.json({
        submission_id: submissionId,
        path: filePath,
        at_seq: atSeq ?? null,
        length: result.content.length,
        provenance: provenanceRuns,
      });
    },
  );

  return router;
}
