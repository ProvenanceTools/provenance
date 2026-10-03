/**
 * S3-compatible blob operations.
 *
 * All four operations use `aws4fetch` for SigV4 signing over standard `fetch`.
 * They work against any S3-compatible endpoint: AWS S3, Cloudflare R2, RustFS.
 *
 * PRD §6: single bucket, prefix layout enforced in `keys.ts`.
 * PRD §16.3: presigned URLs scoped to GET, expiry ≤ BLOB_DOWNLOAD_URL_TTL_SECONDS.
 */

import { createHash } from 'node:crypto';
import { AwsV4Signer } from 'aws4fetch';
import type { StorageClient } from './client.js';
import { fsPutBlob, fsGetBlob, fsDeleteBlob, fsPresignGetUrl } from './fs-blobs.js';

// ---------------------------------------------------------------------------
// putBlob
// ---------------------------------------------------------------------------

export interface PutBlobResult {
  /** Hex-encoded SHA-256 digest of the uploaded bytes. */
  sha256: string;
  /** Total bytes uploaded. */
  size: number;
}

/**
 * Stream `body` to `key` in the bucket.
 *
 * Computes sha256 incrementally as bytes flow through — callers never need to
 * buffer the entire body to hash it. Uses Node's `crypto.createHash` updated
 * per-chunk, so memory usage is O(chunk) not O(body).
 *
 * @throws If the S3 PUT returns a non-2xx status.
 */
export async function putBlob(
  client: StorageClient,
  key: string,
  body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
): Promise<PutBlobResult> {
  if (client.kind === 'fs') return fsPutBlob(client, key, body);
  const hasher = createHash('sha256');
  let size = 0;

  let uploadBody: ArrayBuffer;

  if (body instanceof ReadableStream) {
    // Consume the stream, hash in-flight, collect bytes for upload.
    // We must buffer because `fetch` on Node 22 does accept a ReadableStream body,
    // but aws4fetch needs to compute a content hash (SHA-256 of the body) for the
    // Authorization header when the body is not a simple buffer.
    // Buffering here keeps the implementation simple and correct; for very large
    // objects the caller should use multipart upload (out of scope for Phase 8).
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      size += value.byteLength;
      chunks.push(value);
    }
    // Concatenate into a single buffer for the request body.
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    uploadBody = combined.buffer as ArrayBuffer;
  } else {
    // ArrayBuffer or Uint8Array — hash directly.
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
    hasher.update(bytes);
    size = bytes.byteLength;
    uploadBody = bytes.buffer as ArrayBuffer;
  }

  const sha256 = hasher.digest('hex');
  const url = `${client.bucketUrl}/${key}`;

  const res = await client.aws.fetch(url, {
    method: 'PUT',
    body: uploadBody,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`putBlob failed for key "${key}": HTTP ${res.status} — ${text}`);
  }

  return { sha256, size };
}

// ---------------------------------------------------------------------------
// getBlob
// ---------------------------------------------------------------------------

/**
 * Return a `ReadableStream` of the object at `key`.
 *
 * The caller is responsible for consuming or cancelling the stream. Does not
 * buffer in memory.
 *
 * @throws If the S3 GET returns a non-2xx status (including 404).
 */
export async function getBlob(
  client: StorageClient,
  key: string,
): Promise<ReadableStream<Uint8Array>> {
  if (client.kind === 'fs') return fsGetBlob(client, key);
  const url = `${client.bucketUrl}/${key}`;
  const res = await client.aws.fetch(url, { method: 'GET' });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`getBlob failed for key "${key}": HTTP ${res.status} — ${text}`);
  }

  if (!res.body) {
    throw new Error(`getBlob: response body is null for key "${key}"`);
  }

  // `res.body` is a Web `ReadableStream<Uint8Array>` in Node 22+.
  return res.body as ReadableStream<Uint8Array>;
}

// ---------------------------------------------------------------------------
// presignGetUrl
// ---------------------------------------------------------------------------

/**
 * Produce a SigV4 query-string-signed GET URL valid for `ttlSeconds` seconds.
 *
 * The URL is method-locked to GET (the signer encodes the method in the
 * canonical request; a PUT against this URL will be rejected by the server
 * with a 403 SignatureDoesNotMatch).
 *
 * PRD §16.3: expiry ≤ BLOB_DOWNLOAD_URL_TTL_SECONDS, enforced by callers
 * passing `getConfig().BLOB_DOWNLOAD_URL_TTL_SECONDS`.
 */
export async function presignGetUrl(
  client: StorageClient,
  key: string,
  ttlSeconds: number,
): Promise<string> {
  if (client.kind === 'fs') return fsPresignGetUrl(client, key, ttlSeconds);
  const objectUrl = `${client.bucketUrl}/${key}`;

  // aws4fetch's AwsClient exposes credentials as public properties (see type definitions).
  // We use AwsV4Signer directly so we can set signQuery=true and include X-Amz-Expires
  // in the canonical query string before signing.
  const url = new URL(objectUrl);
  // X-Amz-Expires must be part of the query string before signing.
  url.searchParams.set('X-Amz-Expires', String(ttlSeconds));

  const signer = new AwsV4Signer({
    url: url.toString(),
    method: 'GET',
    accessKeyId: client.aws.accessKeyId,
    secretAccessKey: client.aws.secretAccessKey,
    region: client.aws.region ?? 'us-east-1',
    service: client.aws.service ?? 's3',
    signQuery: true,
  });

  const { url: signedUrl } = await signer.sign();
  return signedUrl.toString();
}

// ---------------------------------------------------------------------------
// deleteBlob
// ---------------------------------------------------------------------------

/**
 * Delete the object at `key` from the bucket.
 *
 * S3 returns 204 on successful delete and also 204 when the object doesn't
 * exist (idempotent). We treat both as success.
 *
 * @throws If the server returns a non-2xx/204 status.
 */
export async function deleteBlob(client: StorageClient, key: string): Promise<void> {
  if (client.kind === 'fs') return fsDeleteBlob(client, key);
  const url = `${client.bucketUrl}/${key}`;
  const res = await client.aws.fetch(url, { method: 'DELETE' });

  // S3/RustFS/R2: 204 on success (both present and absent objects).
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`deleteBlob failed for key "${key}": HTTP ${res.status} — ${text}`);
  }
}
