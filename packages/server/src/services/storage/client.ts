/**
 * Storage client factory.
 *
 * `StorageConfig`/`StorageClient` are discriminated unions over the blob
 * backend (`s3` or `fs`), selected at boot via `BLOB_STORAGE_BACKEND`.
 *
 * The `s3` variant wraps an `AwsClient` pre-configured with the
 * OBJECT_STORAGE_* env vars — a thin SigV4 wrapper over `fetch` that works
 * against any S3-compatible endpoint (AWS S3, Cloudflare R2, RustFS, etc.).
 *
 * The `fs` variant targets a local/NFS-mounted directory (`rootDir`), with a
 * signing secret for producing time-limited download URLs and a public base
 * URL those URLs resolve against. The free functions in `blobs.ts` /
 * `multipart.ts` do not yet implement the `fs` branch (Tasks 2–4).
 *
 * One instance per process is sufficient — `AwsClient` is stateless except for
 * a credential cache (a plain `Map`) that's safe to share across calls.
 */

import { AwsClient } from 'aws4fetch';
import type { Env } from '../../config/env.js';

export type StorageConfig =
  | {
      kind: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    }
  | { kind: 'fs'; rootDir: string; signingSecret: string; publicBaseUrl: string };

export type StorageClient =
  | { kind: 's3'; aws: AwsClient; bucketUrl: string }
  | { kind: 'fs'; rootDir: string; signingSecret: string; publicBaseUrl: string };

/**
 * Build a `StorageConfig` from a validated `Env` object.
 * Tests call `createStorageClient(storageConfigFromEnv(...))` so they never
 * touch `process.env` directly.
 */
export function storageConfigFromEnv(env: Env): StorageConfig {
  if (env.BLOB_STORAGE_BACKEND === 'fs') {
    // superRefine guarantees these are present when backend is fs.
    return {
      kind: 'fs',
      rootDir: env.BLOB_STORAGE_FS_ROOT!,
      signingSecret: env.BLOB_URL_SIGNING_SECRET!,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    };
  }
  return {
    kind: 's3',
    endpoint: env.OBJECT_STORAGE_ENDPOINT!,
    region: env.OBJECT_STORAGE_REGION,
    bucket: env.OBJECT_STORAGE_BUCKET!,
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
  };
}

/**
 * Create a storage client from an explicit config slice.
 * The caller is responsible for obtaining config (e.g. via `getConfig()`).
 */
export function createStorageClient(cfg: StorageConfig): StorageClient {
  if (cfg.kind === 'fs') {
    return {
      kind: 'fs',
      rootDir: cfg.rootDir,
      signingSecret: cfg.signingSecret,
      publicBaseUrl: cfg.publicBaseUrl,
    };
  }
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: 's3',
    // Disable automatic retries: callers decide retry policy at their layer.
    retries: 0,
  });

  // Normalise the endpoint to avoid double-slash when concatenating keys.
  const base = cfg.endpoint.endsWith('/') ? cfg.endpoint.slice(0, -1) : cfg.endpoint;
  return { kind: 's3', aws, bucketUrl: `${base}/${cfg.bucket}` };
}
