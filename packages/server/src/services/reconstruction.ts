/**
 * File reconstruction service — Phase 18 (PRD §11.1).
 *
 * Server-side wrapper around v2's `reconstructFileWithProvenance`. Adds:
 *  - Bundle + EventIndex loading via `reconstructBundleFromDb`, which re-parses
 *    the stored bundle blob through `loadSubmissionIndex` (same as Phase 13b/14;
 *    there is no `events` table — the name is legacy).
 *  - LRU cache keyed by `${submissionId}:${filePath}:${atSeq ?? 'last'}`.
 *  - `tainted` flag from `per_file_stats.reconstruction_tainted`.
 *
 * Cache capacity: `RECONSTRUCTION_CACHE_SIZE` env var (default 100).
 * Cache is process-local and invalidated on process restart; no explicit
 * cache invalidation on supersede (the signed-URL TTL of 60s is the
 * client-side staleness bound).
 *
 * LRU is hand-rolled as a Map-based doubly-linked list (< 30 lines)
 * because `lru-cache` is not in the server's deps and adding it requires
 * explicit approval per CLAUDE.md.
 */

import { eq, and } from 'drizzle-orm';
import { reconstructBundleFromDb } from './heuristics/reconstruct-bundle.js';
import type { ProvenanceKind } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import {
  describeAmbiguity,
  determinateValue,
  reconstructFileSegmentedWithProvenance,
  reconstructionScopeFor,
} from '@provenance/analysis-core/index/reconstruct-segments.js';
import { per_file_stats } from '../db/schema.js';
import type { DrizzleDb } from '../db/client.js';
import type { StorageClient } from './storage/client.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging.js';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

/**
 * Why there is no single content — the two non-`determinate` arms of
 * `SegmentedResult`, flattened for the API boundary.
 *
 * `concurrent` and `unknown` are DIFFERENT FACTS and are never merged: the
 * first says we hold both records and the evidence does not order them, the
 * second says the relation does not reach these events at all. A grader draws
 * opposite conclusions from them.
 */
export type ReconstructionAmbiguity = {
  kind: 'concurrent' | 'unknown';
  detail: string;
};

export type ReconstructedFile = {
  /** Empty when {@link ReconstructedFile.ambiguity} is non-null — there is no single content. */
  content: string;
  /** globalIdx values; will be RLE-encoded at the API boundary. Empty when ambiguous. */
  provenance: number[];
  kindByGlobalIdx: Map<number, ProvenanceKind>;
  computedAtMs: number;
  tainted: boolean;
  /**
   * `null` for the ordinary `determinate` answer, which is every solo
   * submission. Non-null means the caller must NOT present `content` as the
   * file — it is empty precisely so that a viewer cannot render one lineage as
   * though it were what the student submitted.
   */
  ambiguity: ReconstructionAmbiguity | null;
};

// ---------------------------------------------------------------------------
// Minimal hand-rolled LRU cache (Map-based doubly-linked list)
// ---------------------------------------------------------------------------

/**
 * Map-based LRU cache with a fixed capacity cap.
 *
 * Uses Map's insertion-order iteration property (ECMA spec §23.1.3.5):
 * the oldest entry is always `map.keys().next().value`. On access, the
 * entry is deleted and re-inserted to move it to the "most recent" tail.
 *
 * ~25 lines. No external dependency.
 */
class LruCache<K, V> {
  private readonly capacity: number;
  private readonly map: Map<K, V>;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError('LruCache capacity must be >= 1');
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Re-insert to mark as most recently used.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      // Evict the least-recently-used (first) entry.
      const lruKey = this.map.keys().next().value as K;
      this.map.delete(lruKey);
    }
  }

  /** Returns current cache size. Exposed for tests. */
  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Module-level cache (process singleton)
// ---------------------------------------------------------------------------

let _cache: LruCache<string, ReconstructedFile> | null = null;

function getCache(): LruCache<string, ReconstructedFile> {
  if (_cache !== null) return _cache;
  const capacity = getConfig().RECONSTRUCTION_CACHE_SIZE;
  _cache = new LruCache(capacity);
  return _cache;
}

/**
 * Reset cache for tests. Not exported in production — only for unit tests.
 * @internal
 */
export function _resetReconstructionCacheForTest(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// reconstructFile
// ---------------------------------------------------------------------------

/**
 * Reconstruct the content and provenance of `filePath` in a submission.
 *
 * Steps:
 *  1. Check LRU cache. Cache hit → return immediately.
 *  2. Check `per_file_stats` for the file path. Missing row → throw FILE_NOT_FOUND.
 *  3. Build EventIndex by re-parsing the stored bundle blob via
 *     `reconstructBundleFromDb` (there is no `events` table).
 *  4. Call v2's `reconstructFileWithProvenance(index, filePath, atSeq)`.
 *  5. Convert Uint32Array → number[].
 *  6. Populate cache. Return.
 *
 * @param db           - Drizzle DB handle.
 * @param submissionId - Submission UUID.
 * @param filePath     - File path as stored in per_file_stats.file_path.
 * @param atSeq        - Optional globalIdx upper bound (exclusive). `undefined`
 *                       means replay to the end of the event stream.
 */
export async function reconstructFile(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
  filePath: string,
  atSeq?: number,
): Promise<ReconstructedFile> {
  const cacheKey = `${submissionId}:${filePath}:${atSeq ?? 'last'}`;
  const cache = getCache();

  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // Look up per_file_stats to (a) validate the file exists and (b) get tainted flag.
  const statsRows = await db
    .select({
      reconstruction_tainted: per_file_stats.reconstruction_tainted,
    })
    .from(per_file_stats)
    .where(
      and(eq(per_file_stats.submission_id, submissionId), eq(per_file_stats.file_path, filePath)),
    )
    .limit(1);

  if (statsRows.length === 0) {
    // FILE_NOT_FOUND: path not in per_file_stats for this submission.
    // Throw a structured object the route handler converts to the right error response.
    const err = new Error(`File not found: ${filePath}`);
    (err as unknown as Record<string, unknown>)['code'] = 'FILE_NOT_FOUND';
    throw err;
  }

  const tainted = statsRows[0]!.reconstruction_tainted;

  const t0 = Date.now();

  // Build Bundle + EventIndex from the stored bundle blob.
  const { bundle, index } = await reconstructBundleFromDb(db, storage, submissionId);

  // Tier 2.2. The scope is memoized per EventIndex, and for a bundle without two
  // provably different contributors it is the `ordering: null` scope — so every
  // solo submission short-circuits to the untouched linear replay, byte for
  // byte, and pays for no graph. `upToGlobalIdx` semantics are unchanged:
  // exclusive upper bound over the index's own dense numbering.
  const scope = reconstructionScopeFor(bundle, index);
  const segmented = reconstructFileSegmentedWithProvenance(scope, filePath, atSeq);
  const replayState = determinateValue(segmented);

  const computedAtMs = Date.now() - t0;

  getLogger().debug(
    { submissionId, filePath, atSeq, computedAtMs, tainted, verdict: segmented.kind },
    'file reconstruction completed',
  );

  // No single content. Serving one branch here — and the unscoped
  // `reconstructFileWithProvenance` this used to call served a linearization of
  // ALL of them, with per-character attribution — puts a file that never existed
  // on anyone's disk in front of a grader as fact.
  const result: ReconstructedFile =
    replayState === null
      ? {
          content: '',
          provenance: [],
          kindByGlobalIdx: new Map(),
          computedAtMs,
          tainted,
          ambiguity: {
            kind: segmented.kind === 'concurrent' ? 'concurrent' : 'unknown',
            detail: describeAmbiguity(segmented) ?? '',
          },
        }
      : {
          content: replayState.content,
          provenance: Array.from(replayState.provenance),
          kindByGlobalIdx: replayState.kindByGlobalIdx,
          computedAtMs,
          tainted,
          ambiguity: null,
        };

  cache.set(cacheKey, result);
  return result;
}
