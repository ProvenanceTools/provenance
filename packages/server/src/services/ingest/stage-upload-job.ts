/**
 * Background staging for a completed resumable upload.
 *
 * The HTTP `/complete` route no longer assembles + downloads + stages a multi-GB
 * export inside the request (that took minutes and left the UI stuck at 100%).
 * Instead it creates the `ingest_jobs` row up front and enqueues one
 * `ingest_stage_upload` job; this module is that job's body.
 *
 * It reuses `completeResumableUpload` (which completes the S3 multipart upload,
 * downloads the assembled ZIP to a temp file, and runs the shared
 * `ingestLocalPath` staging) — passing the pre-created `ingestJobId` so the
 * per-file jobs and the `finalizeIngestJob` machinery surface progress through
 * the normal job-status endpoint the analyzer already polls.
 *
 * Failure handling: S3 multipart completion is non-idempotent (the upload id is
 * consumed on first complete), so the job is enqueued with `retryLimit: 0`. On
 * any error we mark the ingest job `failed` so the UI shows the failure rather
 * than hanging.
 */

import type PgBoss from 'pg-boss';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { completeResumableUpload } from './resumable-upload.js';
import { failIngestJob } from './job-control.js';
import { JOB_KINDS } from '../../jobs/pg-boss.js';
import type { IngestScopeConfig } from './gradescope/repo-scopes.js';
import { getLogger } from '../../logging.js';

/** pg-boss payload for an `ingest_stage_upload` job. */
export interface IngestStageUploadPayload {
  ingestJobId: string;
  semesterId: string;
  userId: string;
  uploadId: string;
  s3UploadId: string;
  /**
   * Per-request declared-submission-type override, carried across the pg-boss
   * boundary because `/complete` returns 202 long before the staging work runs.
   * Plain JSON, so it round-trips through the job payload unchanged. Absent on
   * jobs enqueued before overrides existed, which is exactly the no-override
   * case.
   */
  ingestScopeOverride?: IngestScopeConfig;
}

export interface StageUploadArgs extends IngestStageUploadPayload {
  maxBundleBytes: number;
  maxBatchFiles: number;
  /** Bundles staged concurrently (see ingestLocalPath). Default 1 = serial. */
  stageConcurrency?: number;
}

export interface StageUploadDeps {
  db: DrizzleDb;
  storageClient: StorageClient;
  boss: PgBoss;
}

/**
 * Assemble a completed resumable upload and stage its bundles into the
 * pre-created ingest job `args.ingestJobId`. Settles the job on the paths that
 * would otherwise leave it `queued` forever.
 */
export async function stageUploadIntoJob(
  deps: StageUploadDeps,
  args: StageUploadArgs,
): Promise<void> {
  const { db, storageClient, boss } = deps;
  const logger = getLogger();

  const result = await completeResumableUpload(
    { storageClient },
    {
      db,
      semesterId: args.semesterId,
      userId: args.userId,
      uploadId: args.uploadId,
      s3UploadId: args.s3UploadId,
      maxBundleBytes: args.maxBundleBytes,
      maxBatchFiles: args.maxBatchFiles,
      ...(args.stageConcurrency !== undefined ? { stageConcurrency: args.stageConcurrency } : {}),
      ...(args.ingestScopeOverride !== undefined
        ? { ingestScopeOverride: args.ingestScopeOverride }
        : {}),
      jobId: args.ingestJobId,
    },
  );

  if (!result.ok) {
    logger.warn(
      { ingestJobId: args.ingestJobId, error: result.error, detail: result.detail },
      'ingest_stage_upload: invalid export — marking job failed',
    );
    await failIngestJob(db, args.ingestJobId, `${result.error}: ${result.detail}`);
    return;
  }

  // When no per-file jobs were enqueued (roster-only export, or every bundle
  // skipped), nothing will ever trigger maybeEnqueueFinalize — so settle the
  // job here. finalizeIngestJob on a 0-file job yields status 'succeeded'.
  //
  // Mutually exclusive with the finalize ingestLocalPath triggers itself: when
  // submissionsQueued > 0 it calls markStagingComplete + maybeEnqueueFinalize,
  // so we only direct-send here for the 0-file case. This direct send bypasses
  // the staging_complete gate, which is safe because finalizeIngestJob does not
  // consult staging_complete (only maybeEnqueueFinalize does). If that ever
  // changes, this path must markStagingComplete first or it will hang.
  if (result.submissionsQueued === 0) {
    await boss.send(
      JOB_KINDS.INGEST_FINALIZE,
      { ingestJobId: args.ingestJobId },
      { singletonKey: args.ingestJobId, retryLimit: 5 },
    );
    logger.info(
      { ingestJobId: args.ingestJobId },
      'ingest_stage_upload: no stageable bundles — enqueued finalize',
    );
  }
}
