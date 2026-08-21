/**
 * Cross-submission feature extraction (memory-bounded input for cross-heuristics).
 *
 * The cross-heuristics (paste_shared_across_students, editing_pattern_clone) only
 * need a tiny slice of each submission, NOT the full Bundle + EventIndex:
 *
 *   - paste_shared: each paste event's `${sessionId}:${seq}` key + length/sha256/content.
 *   - editing_pattern_clone: the SET of 3-grams of the event-kind stream (a bounded
 *     "fingerprint" — independent of event count) + the first few seq keys as
 *     representative references.
 *
 * Holding full bundles for an entire semester at once OOMs the server (a 50k-event
 * bundle × hundreds of submissions = multiple GB). `CrossSubmissionFeatures` is the
 * compact per-submission representation the heuristics consume instead. The browser
 * builds it from an in-memory Bundle/EventIndex via `extractCrossFeatures`; the
 * server builds the same shape by streaming rows from the DB (one submission at a
 * time, discarding the heavy event stream after fingerprinting).
 */

import type { Bundle } from '../../loader/types.js';
import type { EventIndex } from '../../index/event-index.js';
import type { CrossSubmissionFeatures, CrossPasteFeature } from './types.js';
import { resolveBundleCapturePolicy } from '../../manifest/bundle-manifest.js';
import { buildObservedDag, commitNodeKey, observedCommits } from '../../git/observed-dag.js';
import type { ObservedDagSource } from '../../git/observed-dag.js';

/** 3-gram size for the editing-pattern kind-stream fingerprint. */
export const NGRAM_SIZE = 3;

/** Number of leading events kept per submission as representative references. */
export const REPRESENTATIVE_EVENT_COUNT = 5;

/**
 * Build the SET of n-gram strings from an ordered event-kind stream.
 *
 * Each n-gram is `"${k0}|${k1}|...|${k(n-1)}"`. Using a Set (distinct types, not
 * counts) keeps the fingerprint bounded by the kind alphabet regardless of how many
 * events the submission has — e.g. 10,000 doc.change events produce the same n-gram
 * set as 100. Returns an empty set when there are fewer than `n` kinds.
 */
export function buildKindNgramSet(kinds: readonly string[], n: number): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + n <= kinds.length; i++) {
    set.add(kinds.slice(i, i + n).join('|'));
  }
  return set;
}

/**
 * The same-scope exclusion key (spec S20): every commit a session in this scope
 * was OBSERVED at, as `(repository, sha)` node keys.
 *
 * Exported because the server builds `CrossSubmissionFeatures` on its own path
 * and must produce the identical value — one derivation, two call sites, rather
 * than two derivations that agree today.
 *
 * **Observed only, never witnessed-only**, and that narrowing is the difference
 * between a fix and a course-wide outage: a witnessed-only sha is one that
 * appears solely inside another commit's `parents`, which is exactly where a
 * shared skeleton repository's history lives. Keying on ancestry would put every
 * student who cloned the same starter into one lineage and switch
 * cross-submission detection off for the whole cohort. See
 * `coverage/cross-scope.ts` for the full rationale.
 *
 * Sorted, so the value is deterministic and diffable; the consumer treats it as
 * a set.
 */
export function observedCommitKeysOf(source: ObservedDagSource): string[] {
  const dag = buildObservedDag(source);
  return observedCommits(dag)
    .map((n) => commitNodeKey(n.repository, n.sha))
    .sort();
}

/**
 * Extract the compact cross-submission features from an in-memory Bundle + EventIndex.
 *
 * Used by the browser (BundleContext), where bundles are already loaded. The server
 * produces the identical shape directly from the DB without building a Bundle.
 */
export function extractCrossFeatures(bundle: Bundle, index: EventIndex): CrossSubmissionFeatures {
  const pastes: CrossPasteFeature[] = [];
  for (const e of index.byKind.get('paste') ?? []) {
    const p =
      typeof e.payload === 'object' && e.payload !== null
        ? (e.payload as Record<string, unknown>)
        : null;
    pastes.push({
      seqKey: `${e.sessionId}:${e.seq}`,
      sha256: p !== null && typeof p['sha256'] === 'string' ? (p['sha256'] as string) : undefined,
      content:
        p !== null && typeof p['content'] === 'string' ? (p['content'] as string) : undefined,
      length: p !== null && typeof p['length'] === 'number' ? (p['length'] as number) : 0,
    });
  }

  const kinds = index.ordered.map((e) => e.kind);

  return {
    bundleId: bundle.id,
    sourceFilename: bundle.sourceFilename,
    pastes,
    kindNgrams: buildKindNgramSet(kinds, NGRAM_SIZE),
    eventCount: index.ordered.length,
    representativeSeqKeys: index.ordered
      .slice(0, REPRESENTATIVE_EVENT_COUNT)
      .map((e) => `${e.sessionId}:${e.seq}`),
    disabledCaptureSignals: resolveBundleCapturePolicy(bundle).disabledSignals,
    observedCommitKeys: observedCommitKeysOf(bundle),
  };
}
