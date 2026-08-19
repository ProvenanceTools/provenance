/**
 * loadSubmissionIndex — parse a submission's stored bundle from object storage
 * and build its EventIndex, on demand.
 *
 * This is the replacement for reading the (removed) Postgres `events` table.
 * Every server read path that needs the raw event stream — file reconstruction,
 * the events/timeline API, per-submission recompute, cross-flag feature
 * extraction, the summary session list — goes through here instead of querying
 * `events`.
 *
 * The parsed `{ bundle, index }` is memoized in a process-local LRU keyed by
 * `${submissionId}:${blob_sha256}`. The sha256 in the key means a superseded /
 * re-ingested blob (which gets a new object + sha) never returns a stale parse.
 *
 * The stored bundle is provenance-only (source files stripped at ingest). That
 * is fine here: reconstruction, heuristics, and the event stream derive entirely
 * from the `.slog` logs — they never read submitted source bytes.
 *
 * Every bundle handed out from here has had its Manifest 2.0 trust chain walked
 * and the verdict stamped on it (`establishBundleTrust`). That is what lets the
 * course-signed capture policy gate heuristics: an unverified policy is not
 * honoured, so a student cannot edit their own manifest to switch signals — and
 * with them the cross-submission comparisons — off. Validation check 2 stamps
 * the same verdict on the ingest path; this covers the read paths that never
 * re-run validation, above all the cross-flag job (`run-cross.ts`). Doing it
 * here rather than at each call site means a new read path cannot forget.
 */

import { eq } from 'drizzle-orm';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import { establishBundleTrust } from '@provenance/analysis-core/manifest/bundle-manifest.js';
import { rootPublicKeyHexIfConfigured } from '../../config/root-key.js';
import { getBlob } from '../storage/blobs.js';
import type { StorageClient } from '../storage/client.js';
import { submissions } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { LruCache } from './lru-cache.js';

// ---------------------------------------------------------------------------
// Types & errors
// ---------------------------------------------------------------------------

export type SubmissionIndex = {
  bundle: Bundle;
  index: EventIndex;
};

/** Thrown when the submission row or its blob cannot be found / parsed. */
export class SubmissionBundleError extends Error {
  readonly code: 'SUBMISSION_NOT_FOUND' | 'BLOB_READ_FAILED' | 'BUNDLE_PARSE_FAILED';
  constructor(
    code: 'SUBMISSION_NOT_FOUND' | 'BLOB_READ_FAILED' | 'BUNDLE_PARSE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'SubmissionBundleError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Parsed-bundle cache capacity (number of submissions). Kept small: each entry
 * holds a fully parsed Bundle + EventIndex. Process-local, no cross-process
 * invalidation needed (the sha256 in the key handles supersede).
 */
const BUNDLE_INDEX_CACHE_CAPACITY = 16;

let _cache: LruCache<string, SubmissionIndex> | null = null;

function getCache(): LruCache<string, SubmissionIndex> {
  if (_cache === null) _cache = new LruCache(BUNDLE_INDEX_CACHE_CAPACITY);
  return _cache;
}

/**
 * Reset the cache. Test-only.
 * @internal
 */
export function _resetBundleIndexCacheForTest(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// loadSubmissionIndex
// ---------------------------------------------------------------------------

/**
 * Load and parse a submission's stored bundle, returning its Bundle + EventIndex.
 *
 * @param db           - Drizzle DB handle (to resolve the blob key + sha).
 * @param storage      - Storage client for the object store.
 * @param submissionId - Submission UUID.
 * @throws SubmissionBundleError on missing submission, blob read failure, or
 *         unparseable bundle.
 */
export async function loadSubmissionIndex(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
): Promise<SubmissionIndex> {
  const rows = await db
    .select({
      blob_object_key: submissions.blob_object_key,
      blob_sha256: submissions.blob_sha256,
    })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);

  if (rows.length === 0) {
    throw new SubmissionBundleError(
      'SUBMISSION_NOT_FOUND',
      `Submission not found: ${submissionId}`,
    );
  }
  const { blob_object_key: blobKey, blob_sha256: blobSha } = rows[0]!;

  const cacheKey = `${submissionId}:${blobSha}`;
  const cache = getCache();
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Read the blob and buffer it into an ArrayBuffer for loadBundle.
  let blobBuffer: ArrayBuffer;
  try {
    const stream = await getBlob(storage, blobKey);
    blobBuffer = await bufferStream(stream);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SubmissionBundleError(
      'BLOB_READ_FAILED',
      `Failed to read bundle blob for ${submissionId}: ${detail}`,
    );
  }

  const parsed = await loadBundle(blobBuffer, `submission-${submissionId}.zip`);
  if (!parsed.ok) {
    throw new SubmissionBundleError(
      'BUNDLE_PARSE_FAILED',
      `Failed to parse bundle for ${submissionId}: ${parsed.error.kind}`,
    );
  }

  const bundle = parsed.value;
  // Before anything reads the capture policy off this bundle. Cached with it,
  // so the verdict is computed once per parse, not once per read path.
  await establishBundleTrust(bundle, rootPublicKeyHexIfConfigured());
  const index = buildIndex(bundle);
  const result: SubmissionIndex = { bundle, index };
  cache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function bufferStream(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer as ArrayBuffer;
}
