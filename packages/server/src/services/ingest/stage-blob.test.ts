/**
 * Integration tests for stageBlob (Phase 9a §9.3 step 1).
 *
 * Uses withTestMinio — requires Docker.
 */

import { vi, describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { withTestMinio } from '../../../test/helpers/minio.js';
import { stageBlob } from './stage-blob.js';
import { getBlob } from '../storage/blobs.js';
import { ingestStagingKey } from '../storage/keys.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// ---------------------------------------------------------------------------
// stageBlob tests
// ---------------------------------------------------------------------------

describe('stageBlob', () => {
  it('stages a file to MinIO at the expected key', async () => {
    await withTestMinio(async ({ client }) => {
      const jobId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const data = new TextEncoder().encode('hello provenance ingest');

      await stageBlob({ storageClient: client }, { jobId, ingestFileId: fileId, body: data });

      const expectedKey = ingestStagingKey(jobId, fileId);
      // Retrieve and verify content.
      const stream = await getBlob(client, expectedKey);
      const retrieved = await collectStream(stream);
      expect(retrieved).toEqual(data);
    });
  });

  it('returns correct stagingKey matching ingestStagingKey(jobId, fileId)', async () => {
    await withTestMinio(async ({ client }) => {
      const jobId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const data = new Uint8Array(64).fill(0xab);

      const result = await stageBlob(
        { storageClient: client },
        { jobId, ingestFileId: fileId, body: data },
      );

      expect(result.stagingKey).toBe(ingestStagingKey(jobId, fileId));
    });
  });

  it('returns correct sha256 matching independently computed hash', async () => {
    await withTestMinio(async ({ client }) => {
      const jobId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const data = new TextEncoder().encode('sha256-test-content');
      const expectedSha256 = sha256Hex(data);

      const result = await stageBlob(
        { storageClient: client },
        { jobId, ingestFileId: fileId, body: data },
      );

      expect(result.blobSha256).toBe(expectedSha256);
    });
  });

  it('returns correct sizeBytes', async () => {
    await withTestMinio(async ({ client }) => {
      const jobId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const data = new Uint8Array(1024).fill(0x42);

      const result = await stageBlob(
        { storageClient: client },
        { jobId, ingestFileId: fileId, body: data },
      );

      expect(result.sizeBytes).toBe(1024);
    });
  });

  it('works with ArrayBuffer body', async () => {
    await withTestMinio(async ({ client }) => {
      const jobId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const data = new Uint8Array(256).fill(0xcd);
      const expectedSha256 = sha256Hex(data);

      const result = await stageBlob(
        { storageClient: client },
        { jobId, ingestFileId: fileId, body: data.buffer as ArrayBuffer },
      );

      expect(result.blobSha256).toBe(expectedSha256);
      expect(result.sizeBytes).toBe(256);
    });
  });

  it('stages different files for the same job to distinct keys', async () => {
    await withTestMinio(async ({ client }) => {
      const jobId = crypto.randomUUID();
      const fileId1 = crypto.randomUUID();
      const fileId2 = crypto.randomUUID();

      const r1 = await stageBlob(
        { storageClient: client },
        { jobId, ingestFileId: fileId1, body: new Uint8Array([1, 2, 3]) },
      );
      const r2 = await stageBlob(
        { storageClient: client },
        { jobId, ingestFileId: fileId2, body: new Uint8Array([4, 5, 6]) },
      );

      expect(r1.stagingKey).not.toBe(r2.stagingKey);

      // Retrieve each to confirm distinct content.
      const s1 = await getBlob(client, r1.stagingKey);
      const b1 = await collectStream(s1);
      expect(b1).toEqual(new Uint8Array([1, 2, 3]));

      const s2 = await getBlob(client, r2.stagingKey);
      const b2 = await collectStream(s2);
      expect(b2).toEqual(new Uint8Array([4, 5, 6]));
    });
  });
});
