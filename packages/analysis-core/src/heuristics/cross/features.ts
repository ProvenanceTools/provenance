/**
 * Cross-submission feature extraction (memory-bounded input for cross-heuristics).
 *
 * The cross-heuristic (paste_shared_across_students) only needs a tiny slice of
 * each submission, NOT the full Bundle + EventIndex: each paste event's
 * `${sessionId}:${seq}` key + length/sha256/content, plus the two same-scope
 * exclusion keys every cross comparison is partitioned by.
 *
 * (editing_pattern_clone, retired 2026-09, also needed a kind-stream 3-gram set,
 * a few representative seq keys and the course's disabled capture signals. Those
 * fields went with it.)
 *
 * Holding full bundles for an entire semester at once OOMs the server (a 50k-event
 * bundle × hundreds of submissions = multiple GB). `CrossSubmissionFeatures` is the
 * compact per-submission representation the heuristics consume instead. The browser
 * builds it from an in-memory Bundle/EventIndex via `extractCrossFeatures`; the
 * server builds the same shape by streaming rows from the DB (one submission at a
 * time, discarding the heavy event stream after extraction).
 */

import type { Bundle } from '../../loader/types.js';
import type { EventIndex } from '../../index/event-index.js';
import type { CrossSubmissionFeatures, CrossPasteFeature } from './types.js';
import { buildObservedDag, commitNodeKey, observedCommits } from '../../git/observed-dag.js';
import { sessionNodeKey } from '../../coverage/cross-scope.js';
import type { ObservedDagSource } from '../../git/observed-dag.js';

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
 * The second same-scope exclusion key: every session this archive CARRIES,
 * keyed by `(session_pubkey, session_id)`.
 *
 * Exported for the same reason {@link observedCommitKeysOf} is — the server
 * builds `CrossSubmissionFeatures` on its own path and must produce the
 * identical value from one derivation, not a second one that agrees today.
 *
 * A session whose `session.start` carries no usable `session_pubkey`
 * contributes NOTHING rather than a degraded key. Absence is never a match:
 * unioning on "neither of us could be identified" is the shape that suppresses
 * detection between strangers. See `coverage/cross-scope.ts`.
 *
 * Sorted, so the value is deterministic and diffable; the consumer treats it as
 * a set.
 */
export function recordedSessionKeysOf(bundle: Bundle): string[] {
  const keys: string[] = [];
  for (const session of bundle.sessions) {
    const pubkey = session.firstEvent.data.session_pubkey;
    if (typeof pubkey !== 'string' || pubkey === '') continue;
    keys.push(sessionNodeKey(pubkey, session.sessionId));
  }
  return keys.sort();
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

  return {
    bundleId: bundle.id,
    sourceFilename: bundle.sourceFilename,
    pastes,
    observedCommitKeys: observedCommitKeysOf(bundle),
    recordedSessionKeys: recordedSessionKeysOf(bundle),
  };
}
