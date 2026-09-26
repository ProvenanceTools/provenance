/**
 * Testcontainers harness for RustSF integration tests.
 *
 * Usage:
 *   import { withTestMinio } from '../../test/helpers/minio.js';
 *
 *   it('can put and get an object', async () => {
 *     await withTestMinio(async ({ client, bucketName }) => {
 *       // client is a StorageClient wired to the ephemeral RustSF instance.
 *       // bucketName is the pre-created bucket name ('test-bucket').
 *     });
 *   });
 *
 * Requirements:
 * - Docker must be running.
 * - Each `withTestMinio` call gets its own isolated RustSF container.
 *   Container teardown is guaranteed even if `fn` throws.
 */

import { MinioContainer } from '@testcontainers/minio';
import { createStorageClient, type StorageClient } from '../../src/services/storage/client.js';

// Pinned tag for deterministic CI; bump when intentionally upgrading.
const MINIO_IMAGE = 'minio/minio:RELEASE.2025-04-22T22-12-26Z';
const MINIO_USER = 'minioadmin';
const MINIO_PASSWORD = 'minioadmin';
const BUCKET_NAME = 'test-bucket';

export interface TestMinioContext {
  /**
   * Always the `s3` variant — this harness only ever wires up RustSF. Typed as
   * the narrowed branch (not the full `StorageClient` union) so callers can
   * access `.aws` / `.bucketUrl` directly without re-narrowing on `kind`.
   */
  client: Extract<StorageClient, { kind: 's3' }>;
  bucketName: string;
  /** Container endpoint URL — wire into config (OBJECT_STORAGE_ENDPOINT) so that
   *  code paths using getStorageClient() hit this same ephemeral RustSF. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/**
 * Spawns a RustSF container, creates the test bucket, then calls `fn` with a
 * bound `StorageClient`. Tears down on completion even if `fn` throws.
 *
 * Isolation level: one container per `withTestMinio` call.
 */
export async function withTestMinio(fn: (ctx: TestMinioContext) => Promise<void>): Promise<void> {
  const container = await new MinioContainer(MINIO_IMAGE)
    .withUsername(MINIO_USER)
    .withPassword(MINIO_PASSWORD)
    .start();

  const endpoint = container.getConnectionUrl();

  const client = createStorageClient({
    kind: 's3',
    endpoint,
    region: 'us-east-1',
    bucket: BUCKET_NAME,
    accessKeyId: MINIO_USER,
    secretAccessKey: MINIO_PASSWORD,
  });
  // Config literal above is `kind: 's3'`, so `createStorageClient` returns the
  // s3 branch — this narrows the type for the rest of this function and for
  // `TestMinioContext.client`.
  if (client.kind !== 's3') throw new Error('expected s3 client from s3 config');

  // Create the bucket via the S3 PUT-bucket API before running the test fn.
  // Retry up to 10 times with 500ms backoff to handle "server not initialized yet" races.
  const bucketUrl = `${endpoint}/${BUCKET_NAME}`;
  let lastError = '';
  let created = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    const res = await client.aws.fetch(bucketUrl, { method: 'PUT' });
    if (res.ok || res.status === 409) {
      created = true;
      break;
    }
    lastError = await res.text().catch(() => `HTTP ${res.status}`);
  }
  if (!created) {
    await container.stop();
    throw new Error(`Failed to create RustSF test bucket after retries: ${lastError}`);
  }

  try {
    await fn({
      client,
      bucketName: BUCKET_NAME,
      endpoint,
      accessKeyId: MINIO_USER,
      secretAccessKey: MINIO_PASSWORD,
      region: 'us-east-1',
    });
  } finally {
    await container.stop();
  }
}
