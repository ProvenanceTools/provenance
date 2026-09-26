/**
 * Testcontainers harness for RustFS integration tests.
 *
 * Usage:
 *   import { withTestRustfs } from '../../test/helpers/rustfs.js';
 *
 *   it('can put and get an object', async () => {
 *     await withTestRustfs(async ({ client, bucketName }) => {
 *       // client is a StorageClient wired to the ephemeral RustFS instance.
 *       // bucketName is the pre-created bucket name ('test-bucket').
 *     });
 *   });
 *
 * Requirements:
 * - Docker must be running.
 * - Each call gets its own isolated RustFS container.
 *   Container teardown is guaranteed even if `fn` throws.
 */

import { GenericContainer, Wait } from 'testcontainers';
import { createStorageClient, type StorageClient } from '../../src/services/storage/client.js';

const RUSTFS_IMAGE = 'rustfs/rustfs:1.0.0';
const RUSTFS_USER = 'rustsfadmin';
const RUSTFS_PASSWORD = 'rustsfadmin';
const BUCKET_NAME = 'test-bucket';

export interface TestRustfsContext {
  client: Extract<StorageClient, { kind: 's3' }>;
  bucketName: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export async function withTestRustfs(fn: (ctx: TestRustfsContext) => Promise<void>): Promise<void> {
  const container = await new GenericContainer(RUSTFS_IMAGE)
    .withEnvironment({
      RUSTFS_VOLUMES: '/data',
      RUSTFS_ADDRESS: '0.0.0.0:9000',
      RUSTFS_CONSOLE_ENABLE: 'false',
      RUSTFS_ACCESS_KEY: RUSTFS_USER,
      RUSTFS_SECRET_KEY: RUSTFS_PASSWORD,
      RUSTFS_REGION: 'us-east-1',
    })
    .withTmpFs({ '/data': 'rw,uid=10001,gid=10001' })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/health', 9000).forStatusCode(200))
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  const client = createStorageClient({
    kind: 's3',
    endpoint,
    region: 'us-east-1',
    bucket: BUCKET_NAME,
    accessKeyId: RUSTFS_USER,
    secretAccessKey: RUSTFS_PASSWORD,
  });
  if (client.kind !== 's3') throw new Error('expected s3 client from s3 config');

  const bucketUrl = `${endpoint}/${BUCKET_NAME}`;
  let lastError = '';
  let created = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    const response = await client.aws.fetch(bucketUrl, { method: 'PUT' });
    if (response.ok || response.status === 409) {
      created = true;
      break;
    }
    lastError = await response.text().catch(() => `HTTP ${response.status}`);
  }
  if (!created) {
    await container.stop();
    throw new Error(`Failed to create RustFS test bucket after retries: ${lastError}`);
  }

  try {
    await fn({
      client,
      bucketName: BUCKET_NAME,
      endpoint,
      accessKeyId: RUSTFS_USER,
      secretAccessKey: RUSTFS_PASSWORD,
      region: 'us-east-1',
    });
  } finally {
    await container.stop();
  }
}