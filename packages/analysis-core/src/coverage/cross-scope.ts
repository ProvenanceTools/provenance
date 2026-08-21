/**
 * cross-scope — the ONE place that decides which pairs of submissions are two
 * views of the SAME repository, and are therefore not comparable against each
 * other at all.
 *
 * Spec: `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` S20
 * ("Both partners submit the same repo to Gradescope"), §5.2 L2 (the observed
 * commit DAG), §6 Rule 3 (the coverage register).
 *
 * ## The defect this exists to close
 *
 * A git-native submission shares one committed, add-only `.provenance/`
 * directory between partners. Alice's signed `.slog` is therefore *physically
 * inside Bob's bundle*, and Bob's inside Alice's. When both partners submit —
 * S20's "bytes differ" branch, which S20 calls the more likely one — the
 * semester's cross-heuristics see two bundles containing the same events and
 * conclude the obvious wrong thing:
 *
 *  - `paste_shared_across_students` fires at **high / 0.95** on every paste
 *    either partner ever made, describing it as "content sharing";
 *  - `editing_pattern_clone` fires at medium / 0.7 on a Jaccard of 1.0.
 *
 * S20: *"The system's flagship collusion detector fires on the two people the
 * course assigned to collaborate, at high severity, every time."*
 *
 * ## The key, and why it is the commit DAG
 *
 * S20's prescribed fix: exclude pairs whose observed DAGs share a commit. That
 * key is signed (it comes out of a `git.event` inside a hash chain), cheap, and
 * self-defending — to fake being someone's partner you would have to have
 * observed their commits, which means having their repository.
 *
 * Three narrowings are load-bearing, and each of the three exists because the
 * wide reading would make the system WORSE than the bug:
 *
 *  1. **Observed commits only, never witnessed-only ones.** A witnessed-only sha
 *     appears solely inside another commit's `parents` — which is exactly where
 *     a course-issued skeleton repository's history lives. Every student who
 *     clones the same starter witnesses the same ancestors, so keying on
 *     ancestry would put an entire cohort into one lineage and switch
 *     cross-submission detection off course-wide. An *observed* commit means a
 *     session was recording AT that commit, which is a far stronger claim of a
 *     shared working repository. (Residual gap, stated rather than papered over:
 *     two students who both `git pull` a mid-assignment staff commit while
 *     recording will both observe it and will be excluded. That is a false
 *     exclusion, and it is the price of the S20 key; the honest mitigation is a
 *     visible exclusion register — see {@link SameScopeExclusion} — so a grader
 *     can see the suppression happened and why.)
 *
 *  2. **The sentinel repository is never itself a match.** Nodes are keyed
 *     `(repository, sha)` through `commitNodeKey`, and an observation that named
 *     no repository folds into `ASSUMED_SINGLE_REPOSITORY` — which is every
 *     bundle recorded to date. Two unlabelled scopes therefore share a
 *     *repository key* by construction. Only a shared **commit** may exclude:
 *     matching on the sentinel would suppress genuine detection between
 *     unrelated students across the whole corpus.
 *
 *  3. **Absence is never a match.** A scope with no observed commits, and a
 *     scope whose commit list was never computed, are each their own singleton
 *     lineage. "Neither of us ran git" is not evidence of partnership.
 *
 * ## Why the decision lives here and not inside the heuristics
 *
 * Exactly the shape `coverage/session-overlap.ts` established, for exactly the
 * same reason: there is ONE enumeration and ONE suppression decision, and the
 * two consumers receive the two halves of a single partition rather than each
 * applying a rule that agrees on the day it is written and drifts after.
 *
 *  - The heuristics consume {@link CrossScopePartition.lineageOf} — an opaque
 *    class id, so a heuristic cannot re-derive, re-interpret or second-guess the
 *    rule; the only question it can ask is "same class?".
 *  - The coverage register consumes {@link CrossScopePartition.exclusions} — the
 *    facts, with the commits that proved them.
 *
 * Nothing in this module is a Flag, contributes to a score, or fails a check. An
 * exclusion is a statement about the recording ("these two archives are the same
 * repository"), never a finding about a person — §6 Rule 3.
 */

import type { CrossSubmissionFeatures } from '../heuristics/cross/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An opaque equivalence-class id over submissions. Compare with `===`; the
 * numeric value carries no meaning and is not stable across runs with different
 * inputs.
 */
export type RepositoryLineageId = number;

/**
 * One group of submissions proved to be the same repository, and therefore not
 * comparable against each other.
 *
 * This is the visible half of the partition — S20 requires excluded pairs be
 * *visibly* excluded, never silently dropped, or the system has simply become
 * quieter with no explanation. Rendered as coverage context, in the register §6
 * Rule 3 describes: facts about the recording, never findings about anyone.
 */
export type SameScopeExclusion = {
  /**
   * Why the comparison is not applicable. A single-valued union today, spelled
   * as a union so a second exclusion reason cannot be added by widening a
   * boolean.
   */
  reason: 'same_repository_lineage';
  /** The submissions in this lineage, sorted. Always length >= 2. */
  bundleIds: readonly string[];
  /** Display names, in the same order as {@link bundleIds}. */
  sourceFilenames: readonly string[];
  /**
   * The `(repository, sha)` node keys that at least two of these submissions
   * BOTH observed — the evidence for the exclusion, sorted. A commit only one
   * side observed proves nothing and is not listed.
   */
  sharedCommits: readonly string[];
  /**
   * How many pairwise comparisons this exclusion suppressed: `n*(n-1)/2`. Stated
   * so a grader reading "no findings" can see how much of the comparison space
   * was withheld rather than searched.
   */
  excludedPairCount: number;
};

/** The single pass. Both halves come from one enumeration; see the header. */
export type CrossScopePartition = {
  /** bundleId → lineage class. Every input bundle has exactly one entry. */
  lineageOf: ReadonlyMap<string, RepositoryLineageId>;
  /** Every lineage containing 2 or more submissions, sorted by first bundleId. */
  exclusions: readonly SameScopeExclusion[];
};

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Partition submissions into repository lineages by shared observed commits.
 *
 * Pure, synchronous, deterministic and order-independent in its output facts.
 * Linear in the total number of observed commit keys.
 *
 * Sharing is TRANSITIVE and that is deliberate: if Alice and Bob share a commit
 * and Bob and Carol share a different one, all three hold copies of one
 * repository. Union-find is the shape that says so without an O(n^2) pass over
 * submissions — which matters, because this runs over a whole semester.
 */
export function partitionCrossScopes(
  features: readonly CrossSubmissionFeatures[],
): CrossScopePartition {
  const n = features.length;

  // Union-find over submission indexes.
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    // Path compression.
    let cur = x;
    while (parent[cur] !== r) {
      const next = parent[cur]!;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };

  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Union by index keeps the representative deterministic without a rank array.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  // commit node key → the submission indexes that observed it.
  const observersByCommit = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    // Absent means "never computed" — read as no exclusion, so a construction
    // site that predates the field behaves exactly as it did before.
    const keys = features[i]!.observedCommitKeys ?? [];
    // Deduplicate within a submission: one submission observing the same commit
    // from two sessions is corroboration, not a second observer.
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const list = observersByCommit.get(key);
      if (list === undefined) observersByCommit.set(key, [i]);
      else list.push(i);
    }
  }

  /** Only a commit two different submissions BOTH observed is evidence. */
  const provingCommits: string[] = [];
  for (const [key, observers] of observersByCommit) {
    if (observers.length < 2) continue;
    provingCommits.push(key);
    for (let k = 1; k < observers.length; k++) union(observers[0]!, observers[k]!);
  }

  // Dense, deterministic class ids in first-appearance order.
  const idByRoot = new Map<number, RepositoryLineageId>();
  const lineageOf = new Map<string, RepositoryLineageId>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let id = idByRoot.get(root);
    if (id === undefined) {
      id = idByRoot.size;
      idByRoot.set(root, id);
    }
    lineageOf.set(features[i]!.bundleId, id);
  }

  // Build the visible register from the classes that actually merged.
  const membersByRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = membersByRoot.get(root);
    if (list === undefined) membersByRoot.set(root, [i]);
    else list.push(i);
  }

  const commitsByRoot = new Map<number, string[]>();
  for (const key of provingCommits) {
    const root = find(observersByCommit.get(key)![0]!);
    const list = commitsByRoot.get(root);
    if (list === undefined) commitsByRoot.set(root, [key]);
    else list.push(key);
  }

  const exclusions: SameScopeExclusion[] = [];
  for (const [root, members] of membersByRoot) {
    if (members.length < 2) continue;
    // Sorted by the name a grader actually sees, with the bundle id as the
    // tiebreak so two archives uploaded under one filename still order stably.
    const sorted = members
      .map((i) => features[i]!)
      .sort((a, b) => {
        if (a.sourceFilename !== b.sourceFilename) {
          return a.sourceFilename < b.sourceFilename ? -1 : 1;
        }
        return a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0;
      });
    exclusions.push({
      reason: 'same_repository_lineage',
      bundleIds: sorted.map((f) => f.bundleId),
      sourceFilenames: sorted.map((f) => f.sourceFilename),
      sharedCommits: [...(commitsByRoot.get(root) ?? [])].sort(),
      excludedPairCount: (members.length * (members.length - 1)) / 2,
    });
  }

  exclusions.sort((a, b) => {
    const x = a.bundleIds[0] ?? '';
    const y = b.bundleIds[0] ?? '';
    return x < y ? -1 : x > y ? 1 : 0;
  });

  return { lineageOf, exclusions };
}

/**
 * Are these two submissions two views of one repository?
 *
 * The only question a consumer may ask of the partition. Deliberately takes the
 * partition rather than the two features, so no caller can re-derive the rule.
 */
export function sameRepositoryLineage(
  partition: CrossScopePartition,
  bundleIdA: string,
  bundleIdB: string,
): boolean {
  const a = partition.lineageOf.get(bundleIdA);
  const b = partition.lineageOf.get(bundleIdB);
  // An unknown bundle is not proved to share anything. Fail toward comparing.
  if (a === undefined || b === undefined) return false;
  return a === b;
}
