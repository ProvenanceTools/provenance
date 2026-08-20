/**
 * Resumable chunked upload for very large Gradescope exports over HTTP.
 *
 * A single multi-GB upload in one request is fragile: any interruption (wifi
 * drop, proxy timeout, server restart) loses the whole transfer. This splits the
 * export into parts backed by an S3/MinIO **multipart upload**, so:
 *   - part state lives in object storage, not server memory — correct across
 *     multiple `--mode=api` processes behind a load balancer, and durable across
 *     restarts;
 *   - an interrupted upload resumes by listing already-received parts and
 *     re-sending only the missing ones.
 *
 * The (semesterId, uploadId) pair deterministically derives the storage key, so
 * chunk/complete/abort requests need no server-side session table — the S3
 * upload id (returned at create) is the capability secret, and every route is
 * re-authorized against the semester.
 *
 * On completion the assembled object is streamed to a temp file and fed through
 * the same `ingestLocalPath` pipeline as every other ingest path, then the
 * temp object + file are cleaned up.
 */

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { resumableUploadKey } from '../storage/keys.js';
import { getBlob, deleteBlob } from '../storage/blobs.js';
import {
  createMultipartUpload,
  uploadPart,
  listParts,
  completeMultipartUpload,
  abortMultipartUpload,
  S3_MIN_PART_BYTES,
} from '../storage/multipart.js';
import { ingestLocalPath, type IngestLocalPathResult } from './local-path.js';
import type { IngestScopeConfig } from './gradescope/repo-scopes.js';

/** Largest part size we allow a client to request. */
const MAX_CHUNK_BYTES = 512 * 1024 * 1024;
/** Default part size when the client doesn't specify one. */
const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024;

export interface ResumableDeps {
  storageClient: StorageClient;
}

/** Clamp a requested chunk size into the S3-legal range. */
export function resolveChunkBytes(requested: number | undefined): number {
  const v = requested && Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_CHUNK_BYTES;
  return Math.max(S3_MIN_PART_BYTES, Math.min(MAX_CHUNK_BYTES, v));
}

export interface CreateResumableArgs {
  semesterId: string;
  uploadId: string;
  totalBytes: number;
  chunkBytes: number;
}

/** Initiate the multipart upload; returns the S3 upload id and the part count. */
export async function createResumableUpload(
  deps: ResumableDeps,
  args: CreateResumableArgs,
): Promise<{ s3UploadId: string; totalParts: number }> {
  const key = resumableUploadKey(args.semesterId, args.uploadId);
  const s3UploadId = await createMultipartUpload(deps.storageClient, key);
  const totalParts = Math.max(1, Math.ceil(args.totalBytes / args.chunkBytes));
  return { s3UploadId, totalParts };
}

/** Upload one part (1-based partNumber). Returns the part ETag. */
export async function putResumablePart(
  deps: ResumableDeps,
  args: {
    semesterId: string;
    uploadId: string;
    s3UploadId: string;
    partNumber: number;
    body: ArrayBuffer;
  },
): Promise<string> {
  const key = resumableUploadKey(args.semesterId, args.uploadId);
  return uploadPart(deps.storageClient, key, args.s3UploadId, args.partNumber, args.body);
}

/** Part numbers already received (for resume). */
export async function listResumablePartNumbers(
  deps: ResumableDeps,
  args: { semesterId: string; uploadId: string; s3UploadId: string },
): Promise<number[]> {
  const key = resumableUploadKey(args.semesterId, args.uploadId);
  const parts = await listParts(deps.storageClient, key, args.s3UploadId);
  return parts.map((p) => p.partNumber);
}

/** Abort the upload and best-effort delete any assembled object. Idempotent. */
export async function abortResumableUpload(
  deps: ResumableDeps,
  args: { semesterId: string; uploadId: string; s3UploadId: string },
): Promise<void> {
  const key = resumableUploadKey(args.semesterId, args.uploadId);
  await abortMultipartUpload(deps.storageClient, key, args.s3UploadId);
  await deleteBlob(deps.storageClient, key).catch(() => {});
}

/** Stream an object from storage to a fresh temp file; returns its path + a cleanup. */
async function downloadToTempFile(
  storageClient: StorageClient,
  key: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prov-complete-'));
  const filePath = path.join(dir, 'assembled.zip');
  const stream = await getBlob(storageClient, key);
  await pipeline(
    Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(filePath),
  );
  return { path: filePath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface CompleteResumableArgs {
  db: DrizzleDb;
  semesterId: string;
  userId: string;
  uploadId: string;
  s3UploadId: string;
  maxBundleBytes: number;
  maxBatchFiles: number;
  /** Bundles staged concurrently (see ingestLocalPath). Default 1 = serial. */
  stageConcurrency?: number;
  /** Optional pre-created ingest job to stage into (see ingestLocalPath). */
  jobId?: string;
  /** Per-request declared-submission-type override (see ingestLocalPath). */
  ingestScopeOverride?: IngestScopeConfig;
}

/**
 * Complete the multipart upload, then ingest the assembled export with the same
 * streaming pipeline as the local-path / single-upload paths. Cleans up the
 * assembled object and temp file regardless of outcome.
 */
export async function completeResumableUpload(
  deps: ResumableDeps,
  args: CompleteResumableArgs,
): Promise<IngestLocalPathResult> {
  const { storageClient } = deps;
  const key = resumableUploadKey(args.semesterId, args.uploadId);

  const parts = await listParts(storageClient, key, args.s3UploadId);
  if (parts.length === 0) {
    return { ok: false, error: 'not_a_zip', detail: 'no parts were uploaded' };
  }
  await completeMultipartUpload(storageClient, key, args.s3UploadId, parts);

  const tmp = await downloadToTempFile(storageClient, key);
  try {
    return await ingestLocalPath(
      { db: args.db, storageClient },
      {
        semesterId: args.semesterId,
        userId: args.userId,
        archivePath: tmp.path,
        maxBundleBytes: args.maxBundleBytes,
        maxBatchFiles: args.maxBatchFiles,
        ...(args.stageConcurrency !== undefined ? { stageConcurrency: args.stageConcurrency } : {}),
        ...(args.jobId !== undefined ? { jobId: args.jobId } : {}),
        ...(args.ingestScopeOverride !== undefined
          ? { ingestScopeOverride: args.ingestScopeOverride }
          : {}),
      },
    );
  } finally {
    await tmp.cleanup();
    // The assembled object has served its purpose; drop it (best effort).
    await deleteBlob(storageClient, key).catch(() => {});
  }
}
