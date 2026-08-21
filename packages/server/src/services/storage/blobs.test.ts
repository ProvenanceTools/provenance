/**
 * Integration tests for blob operations (putBlob, getBlob, presignGetUrl, deleteBlob).
 *
 * Requires Docker — each test gets its own isolated MinIO container via
 * `withTestMinio`.
 *
 * Per V12 convention: integration test files set generous timeouts at the top.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { withTestMinio } from '../../../test/helpers/minio.js';
import { putBlob, getBlob, presignGetUrl, deleteBlob } from './blobs.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBytes(size: number, fillByte = 0x42): Uint8Array {
  const buf = new Uint8Array(size);
  buf.fill(fillByte);
  return buf;
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function toReadableStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
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
// put → get round-trip
// ---------------------------------------------------------------------------

describe('putBlob + getBlob', () => {
  it('round-trips bytes correctly (ArrayBuffer body)', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'test/roundtrip-arraybuffer';
      const original = makeBytes(1024, 0xab);
      await putBlob(client, key, original);

      const stream = await getBlob(client, key);
      const retrieved = await collectStream(stream);
      expect(retrieved).toEqual(original);
    });
  });

  it('round-trips bytes correctly (ReadableStream body)', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'test/roundtrip-stream';
      const original = makeBytes(512, 0xcd);
      await putBlob(client, key, toReadableStream(original));

      const stream = await getBlob(client, key);
      const retrieved = await collectStream(stream);
      expect(retrieved).toEqual(original);
    });
  });
});

// ---------------------------------------------------------------------------
// sha256 correctness
// ---------------------------------------------------------------------------

describe('putBlob — sha256 computation', () => {
  it('returns the correct sha256 for a known-content fixture', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'test/sha256-fixture';
      const data = new TextEncoder().encode('hello provenance');
      const expected = sha256Hex(data);

      const { sha256 } = await putBlob(client, key, data);
      expect(sha256).toBe(expected);
    });
  });

  it('computes correct sha256 for a large buffer (50 MB)', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'test/sha256-large';
      // 50 MB of 0x5a bytes.
      const MB50 = 50 * 1024 * 1024;
      const data = makeBytes(MB50, 0x5a);
      const expected = sha256Hex(data);

      const { sha256 } = await putBlob(client, key, data);
      expect(sha256).toBe(expected);
    });
  });
});

// ---------------------------------------------------------------------------
// size reporting
// ---------------------------------------------------------------------------

describe('putBlob — size reporting', () => {
  it('reports the correct byte size', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'test/size-check';
      const data = makeBytes(4096);
      const { size } = await putBlob(client, key, data);
      expect(size).toBe(4096);
    });
  });

  it('reports 0 for an empty body', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'test/size-empty';
      const data = new Uint8Array(0);
      const { size } = await putBlob(client, key, data);
      expect(size).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// getBlob returns a stream (not a buffer)
// ---------------------------------------------------------------------------

describe('getBlob — returns a ReadableStream', () => {
  it('getBlob returns a ReadableStream instance', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'test/stream-type';
      await putBlob(client, key, makeBytes(128));

      const stream = await getBlob(client, key);
      // The return value must be a ReadableStream — callers can decide whether to
      // buffer, pipe, or cancel it.
      expect(stream).toBeInstanceOf(ReadableStream);
    });
  });
});

// ---------------------------------------------------------------------------
// presignGetUrl
// ---------------------------------------------------------------------------

describe('presignGetUrl', () => {
  it('returns a URL that fetches the object successfully', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'test/presign-fetch';
      const data = new TextEncoder().encode('presigned content');
      await putBlob(client, key, data);

      const url = await presignGetUrl(client, key, 300);
      const res = await fetch(url);
      expect(res.ok).toBe(true);
      const body = await res.arrayBuffer();
      expect(new Uint8Array(body)).toEqual(data);
    });
  });

  it('signed URL is scoped to GET — a PUT to it is rejected', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'test/presign-put-rejection';
      await putBlob(client, key, new TextEncoder().encode('original'));

      const url = await presignGetUrl(client, key, 300);
      // Attempt a PUT using the GET-signed URL — S3/MinIO reject it.
      const res = await fetch(url, {
        method: 'PUT',
        body: 'tampered',
      });
      expect(res.ok).toBe(false);
      // 403 SignatureDoesNotMatch is the expected status.
      expect(res.status).toBe(403);
    });
  });

  it('expired presigned URL returns 403 (TTL=1s, wait 2s)', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'test/presign-expired';
      await putBlob(client, key, new TextEncoder().encode('ephemeral'));

      const url = await presignGetUrl(client, key, 1);

      // Wait for the TTL to elapse.
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));

      const res = await fetch(url);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// deleteBlob
// ---------------------------------------------------------------------------

describe('deleteBlob', () => {
  it('deletes an object so a subsequent getBlob throws', async () => {
    await withTestMinio(async ({ client }) => {
      const key = 'test/delete-check';
      await putBlob(client, key, makeBytes(64));

      // Confirm it exists.
      const before = await getBlob(client, key);
      await collectStream(before);

      await deleteBlob(client, key);

      // After deletion, getBlob should throw (404 → non-2xx).
      await expect(getBlob(client, key)).rejects.toThrow();
    });
  });

  it('delete is idempotent — deleting a non-existent key does not throw', async () => {
    await withTestMinio(async ({ client }) => {
      // S3 and MinIO return 204 for DELETE of a non-existent object.
      await expect(deleteBlob(client, 'test/does-not-exist')).resolves.toBeUndefined();
    });
  });
});
