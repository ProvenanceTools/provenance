/**
 * Integration tests for S3 multipart upload ops against MinIO (via withTestMinio).
 * Validates create → uploadPart → listParts (resume) → complete → object bytes,
 * plus abort. Requires Docker.
 */

import { describe, it, expect, vi } from 'vitest';
import { withTestMinio } from '../../../test/helpers/minio.js';
import { getBlob } from './blobs.js';
import {
  createMultipartUpload,
  uploadPart,
  listParts,
  completeMultipartUpload,
  abortMultipartUpload,
  S3_MIN_PART_BYTES,
} from './multipart.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function makeBytes(size: number, fill: number): Uint8Array {
  const b = new Uint8Array(size);
  b.fill(fill);
  return b;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

describe('S3 multipart ops', () => {
  it('create → parts → listParts (resume) → complete assembles the object', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'uploads/test/multi.bin';
      const part1 = makeBytes(S3_MIN_PART_BYTES, 0x41); // must be >= 5 MiB
      const part2 = makeBytes(1024, 0x42); // last part may be small

      const uploadId = await createMultipartUpload(client, key);
      expect(uploadId.length).toBeGreaterThan(0);

      const etag1 = await uploadPart(client, key, uploadId, 1, part1);
      expect(etag1.length).toBeGreaterThan(0);

      // Resume view after one part: listParts reports exactly part 1.
      const afterOne = await listParts(client, key, uploadId);
      expect(afterOne.map((p) => p.partNumber)).toEqual([1]);
      expect(afterOne[0]!.size).toBe(part1.byteLength);

      await uploadPart(client, key, uploadId, 2, part2);

      const both = await listParts(client, key, uploadId);
      expect(both.map((p) => p.partNumber)).toEqual([1, 2]);

      await completeMultipartUpload(client, key, uploadId, both);

      const assembled = await collect(await getBlob(client, key));
      expect(assembled.byteLength).toBe(part1.byteLength + part2.byteLength);
      expect(assembled[0]).toBe(0x41);
      expect(assembled[part1.byteLength]).toBe(0x42);
    });
  });

  it('abort discards the upload', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'uploads/test/aborted.bin';
      const uploadId = await createMultipartUpload(client, key);
      await uploadPart(client, key, uploadId, 1, makeBytes(S3_MIN_PART_BYTES, 0x43));
      await abortMultipartUpload(client, key, uploadId);
      // Listing parts of an aborted upload fails (the upload no longer exists).
      await expect(listParts(client, key, uploadId)).rejects.toThrow();
    });
  });
});
