/**
 * S3-compatible multipart upload operations (for resumable large uploads).
 *
 * These back the chunked/resumable ingest endpoints: the client uploads a large
 * export in parts, the storage tracks part state server-side (so an interrupted
 * upload resumes by re-sending only missing parts via `listParts`), and on
 * completion S3 assembles the parts into one object. Works against any
 * S3-compatible endpoint (AWS S3, RustFS, R2) via `aws4fetch` SigV4 signing —
 * the same signer `blobs.ts` uses.
 *
 * S3 constraint: every part except the last must be ≥ 5 MiB.
 *
 * The XML responses S3 returns for these operations are tightly specified; we
 * extract the few fields we need with targeted parsing rather than pulling in an
 * XML parser dependency.
 */

import type { StorageClient } from './client.js';
import {
  fsCreateMultipartUpload,
  fsUploadPart,
  fsListParts,
  fsCompleteMultipartUpload,
  fsAbortMultipartUpload,
} from './fs-multipart.js';

/** Minimum size (bytes) of every multipart part except the last (S3 rule). */
export const S3_MIN_PART_BYTES = 5 * 1024 * 1024;

export interface UploadedPart {
  partNumber: number;
  /** S3 ETag (quoted), as returned by UploadPart / ListParts. */
  etag: string;
  size: number;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Extract the text of the first `<tag>…</tag>` in `xml`, or null. */
function firstTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXmlEntities(m[1]!) : null;
}

async function failOnNon2xx(res: Response, op: string, key: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${op} failed for key "${key}": HTTP ${res.status} — ${text}`);
  }
}

// ---------------------------------------------------------------------------
// createMultipartUpload
// ---------------------------------------------------------------------------

/** Initiate a multipart upload; returns the S3 upload id. */
export async function createMultipartUpload(client: StorageClient, key: string): Promise<string> {
  if (client.kind === 'fs') return fsCreateMultipartUpload(client, key);
  const url = `${client.bucketUrl}/${key}?uploads`;
  const res = await client.aws.fetch(url, { method: 'POST' });
  await failOnNon2xx(res, 'createMultipartUpload', key);
  const xml = await res.text();
  const uploadId = firstTag(xml, 'UploadId');
  if (uploadId === null) {
    throw new Error(`createMultipartUpload: no UploadId in response for key "${key}"`);
  }
  return uploadId;
}

// ---------------------------------------------------------------------------
// uploadPart
// ---------------------------------------------------------------------------

/** Upload one part. `partNumber` is 1-based. Returns the part's ETag. */
export async function uploadPart(
  client: StorageClient,
  key: string,
  uploadId: string,
  partNumber: number,
  body: ArrayBuffer | Uint8Array,
): Promise<string> {
  if (client.kind === 'fs') return fsUploadPart(client, key, uploadId, partNumber, body);
  const url = `${client.bucketUrl}/${key}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const res = await client.aws.fetch(url, {
    method: 'PUT',
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  await failOnNon2xx(res, 'uploadPart', key);
  const etag = res.headers.get('etag');
  if (etag === null) {
    throw new Error(`uploadPart: no ETag header for key "${key}" part ${partNumber}`);
  }
  return etag;
}

// ---------------------------------------------------------------------------
// listParts
// ---------------------------------------------------------------------------

/** List the parts already uploaded (for resume). */
export async function listParts(
  client: StorageClient,
  key: string,
  uploadId: string,
): Promise<UploadedPart[]> {
  if (client.kind === 'fs') return fsListParts(client, key, uploadId);
  const parts: UploadedPart[] = [];
  // S3 paginates parts; follow part-number-marker until IsTruncated is false.
  let marker = '';
  for (;;) {
    const markerQ = marker ? `&part-number-marker=${encodeURIComponent(marker)}` : '';
    const url = `${client.bucketUrl}/${key}?uploadId=${encodeURIComponent(uploadId)}${markerQ}`;
    const res = await client.aws.fetch(url, { method: 'GET' });
    await failOnNon2xx(res, 'listParts', key);
    const xml = await res.text();
    for (const block of xml.match(/<Part>[\s\S]*?<\/Part>/g) ?? []) {
      const partNumber = firstTag(block, 'PartNumber');
      const etag = firstTag(block, 'ETag');
      const size = firstTag(block, 'Size');
      if (partNumber !== null && etag !== null) {
        parts.push({
          partNumber: parseInt(partNumber, 10),
          etag,
          size: size !== null ? parseInt(size, 10) : 0,
        });
      }
    }
    if (firstTag(xml, 'IsTruncated') === 'true') {
      marker = firstTag(xml, 'NextPartNumberMarker') ?? '';
      if (marker === '') break;
    } else {
      break;
    }
  }
  parts.sort((a, b) => a.partNumber - b.partNumber);
  return parts;
}

// ---------------------------------------------------------------------------
// completeMultipartUpload
// ---------------------------------------------------------------------------

/**
 * Complete the upload, assembling `parts` (must be sorted by partNumber) into
 * the final object. S3 can return HTTP 200 with an `<Error>` body, so we check
 * the body too.
 */
export async function completeMultipartUpload(
  client: StorageClient,
  key: string,
  uploadId: string,
  parts: UploadedPart[],
): Promise<void> {
  if (client.kind === 'fs') return fsCompleteMultipartUpload(client, key, uploadId, parts);
  const body =
    '<CompleteMultipartUpload>' +
    parts
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
      .join('') +
    '</CompleteMultipartUpload>';
  const url = `${client.bucketUrl}/${key}?uploadId=${encodeURIComponent(uploadId)}`;
  const res = await client.aws.fetch(url, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/xml' },
  });
  await failOnNon2xx(res, 'completeMultipartUpload', key);
  const xml = await res.text();
  if (xml.includes('<Error>')) {
    throw new Error(
      `completeMultipartUpload error for key "${key}": ${firstTag(xml, 'Code') ?? 'unknown'} — ${firstTag(xml, 'Message') ?? xml}`,
    );
  }
}

// ---------------------------------------------------------------------------
// abortMultipartUpload
// ---------------------------------------------------------------------------

/** Abort an in-progress upload, discarding any uploaded parts. Idempotent. */
export async function abortMultipartUpload(
  client: StorageClient,
  key: string,
  uploadId: string,
): Promise<void> {
  if (client.kind === 'fs') return fsAbortMultipartUpload(client, key, uploadId);
  const url = `${client.bucketUrl}/${key}?uploadId=${encodeURIComponent(uploadId)}`;
  const res = await client.aws.fetch(url, { method: 'DELETE' });
  // 204 on success; 404 if already gone — both fine (idempotent).
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`abortMultipartUpload failed for key "${key}": HTTP ${res.status} — ${text}`);
  }
}
