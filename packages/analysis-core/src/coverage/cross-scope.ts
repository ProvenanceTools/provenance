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
 * ## Mixed-scope tolerance, and the line it must not cross
 *
 * The node key carries the repository, and the repository is only known when the
 * recorder emitted a D12 root-commit discriminator. An honest partner pair where
 * ONE partner runs a discriminator-emitting build and the other runs an older
 * one therefore produces two DIFFERENT keys for the SAME commit —
 * `repository:<root> <sha>` on one side, `repository:assumed-single <sha>` on
 * the other — one observer each, no union, no exclusion, and the pair is
 * compared and flagged. That is a live false accusation against two people the
 * course assigned to work together, and it is what a staged rollout of any
 * recorder build guarantees.
 *
 * So the match is **sentinel-tolerant**: two observations of the same bare sha
 * union when at least one of them carries the sentinel. What it must never do is
 * union two observations under two DIFFERENT *real* repository keys — commit
 * shas are unique only within a repository, and a submodule, fork, vendored
 * skeleton or template-derived repo legitimately shares them. That is precisely
 * the sha-space merge D12 exists to prevent, and a false exclusion switches a
 * detector silently OFF, which is the dangerous direction.
 *
 * The exact rule, and it is a whitelist rather than a blacklist:
 *
 *  - `repository:A <sha>` + `repository:A <sha>` → union.
 *  - `repository:assumed-single <sha>` + `repository:assumed-single <sha>` → union.
 *  - `repository:A <sha>` + `repository:assumed-single <sha>` → union.
 *  - `repository:A <sha>` + `repository:B <sha>` → **never** union.
 *
 * The fourth line survives transitivity too, which is the non-obvious part. If
 * one sha is observed under the sentinel AND under two different real keys, then
 * bridging the sentinel to both would union A with B through it — the forbidden
 * merge, arrived at in two hops. When a sha carries more than one real
 * repository key, the unlabelled observation is genuinely ambiguous about which
 * of them it belongs to, so no bridge is built for that sha at all and the
 * exact-key matches stand alone. Failing toward comparing is the safe direction;
 * failing toward excluding is not.
 *
 * ## The SECOND key: one signed session present in both archives
 *
 * The commit key is a PROXY. What it is actually standing in for is the thing
 * the register's own text says — "each archive contains the other's recorded
 * sessions" — and the proxy fails whenever that is true but no commit was
 * observed. Git observation is an explicitly optional capability
 * (`log-core/session-capabilities.ts`: `GIT_CAPTURE_VALUES` is `available` /
 * `unavailable` / `not_owned`, and provnvim reports only the first two), so a
 * genuinely shared `.provenance/` produces ZERO observed commits whenever the
 * host exposes no git integration, the partners commit from a terminal outside
 * a recording session, or there is no git at all — two people on one laptop, a
 * lab machine, a synced folder. In every one of those cases both archives carry
 * both partners' signed `.slog` files and the flagship collusion detector fires
 * at high / 0.95 on the pair, exactly as S20 describes.
 *
 * So a shared SESSION unions too. The key is
 * {@link sessionNodeKey}`(session_pubkey, session_id)`, and both halves matter:
 *
 *  - `session_id` alone would be a bare uuid, and a recorder build that minted a
 *    constant one would union everything it touched.
 *  - the digest of the `.slog` would be WRONG, and wrong in the direction that
 *    silently removes the fix: `.provenance/` is add-only, so a partner who
 *    pulled yesterday holds a PREFIX of today's log and a different sha256. The
 *    pubkey is written once, in `session.start`, which is the first event of
 *    every prefix — so it is stable exactly where the digest is not.
 *
 * A session contributing no usable pubkey contributes no key at all. Absence is
 * never a match here either.
 *
 * ## The starter guard: a cohort-fraction ceiling
 *
 * Narrowing 1 has a direct analogue here, and ignoring it would rebuild the
 * course-wide outage it exists to prevent. If staff ever prepare an assignment
 * skeleton with the recorder running and commit the resulting `.provenance/`,
 * then EVERY student's archive carries that one staff session, every pair shares
 * it, and one union pass switches cross-submission detection off for the entire
 * cohort.
 *
 * The discriminator is distribution. A partnership is a property of a PAIR, so
 * its session shows up in about two archives. A starter is a property of the
 * ASSIGNMENT, so its session shows up in all of them. Hence the rule, applied
 * per key BEFORE any union:
 *
 *   a session key may union only when the number of archives carrying it is a
 *   STRICT MINORITY of the assignment's submission pool — `k < n / 2`.
 *
 * That buys a stated invariant rather than a probability: no single session key
 * can ever move more than `ceil(n/2) - 1` submissions, so the majority of any
 * pool is always still compared, and a cohort-wide switch-off is structurally
 * unreachable rather than merely unlikely.
 *
 * At the boundary — an exact even split, `k === n / 2` — the key is REJECTED. An
 * even split is the single most ambiguous shape the evidence can take, and the
 * guard fails toward comparing, which is the same direction the sentinel bridge
 * fails in.
 *
 * ## Why the ceiling is inert on small pools, which is not a loophole
 *
 * The ceiling can admit the SMALLEST possible partnership, `k = 2`, only once
 * `2 < n / 2` — that is, from `n = 5` up. Below that it admits nothing at all,
 * so applying it there would not be a guard; it would be a blanket refusal that
 * protects nothing and costs the fix. `/local/compare` is the case that makes
 * this concrete: a grader drops two partners' zips on the page, `n` is 2, and a
 * ceiling applied there would show them the false accusation this module exists
 * to remove.
 *
 * The asymmetry is what settles it. The catastrophe the guard prevents needs a
 * COHORT; a pool of four has none, and the most a starter can suppress there is
 * four submissions and six pairs, all of them in front of a person who is
 * reading the register. So the ceiling engages from {@link MIN_POOL_FOR_CEILING}
 * up, and that bound is derived from the rule rather than chosen: it is the
 * smallest `n` at which `k < n / 2` has any satisfying `k >= 2`.
 *
 * Transitivity still chains across DIFFERENT keys — A~B on one session, B~C on
 * another — exactly as it does for commits, and deliberately so: those are three
 * archives that really do hold one another's logs. What the ceiling forbids is a
 * single key doing it in one hop, which is the only shape a distributed starter
 * can take.
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
import { ASSUMED_SINGLE_REPOSITORY, commitNodeKey } from '../git/observed-dag.js';

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
   * Why the comparison is not applicable.
   *
   *  - `same_repository_lineage` — at least one commit was proved shared. The
   *    stronger claim, because a repository is a thing that demonstrably exists.
   *  - `shared_recording_scope` — no commit was proved shared, but a signed
   *    session was: these archives physically contain one another's logs. The
   *    honest wording for a pair whose recorder never observed git.
   *
   * Derived from the proofs, never passed in: a lineage that holds ANY shared
   * commit reports the repository reason, so the register never downgrades a
   * claim the evidence supports. Both proof lists are carried either way, so it
   * also never asserts a commit it does not have.
   */
  reason: 'same_repository_lineage' | 'shared_recording_scope';
  /** The submissions in this lineage, sorted. Always length >= 2. */
  bundleIds: readonly string[];
  /** Display names, in the same order as {@link bundleIds}. */
  sourceFilenames: readonly string[];
  /**
   * The `(repository, sha)` node keys that proved the exclusion, sorted. A
   * commit only one side observed proves nothing and is not listed.
   *
   * Usually these are keys at least two of these submissions BOTH observed. For
   * a sentinel-tolerant (mixed-scope) proof there is no such key — one side
   * observed the sha under a real repository key and the other under
   * `repository:assumed-single` — so BOTH participating keys are listed. Saying
   * "both observed `repository:<root> <sha>`" when one of them did not would be
   * a claim the record does not support, and this list is read as evidence.
   */
  sharedCommits: readonly string[];
  /**
   * The `sessionNodeKey(pubkey, session_id)` keys that proved the exclusion,
   * sorted — the sessions at least two of these submissions BOTH carry.
   *
   * Empty when the lineage was proved by commits alone. A session only one side
   * carries proves nothing and is not listed, and neither is one the
   * cohort-fraction ceiling rejected: a key that did not union anything must
   * never appear as the evidence that something was unioned.
   */
  sharedSessions: readonly string[];
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
// The session key, and the ceiling that guards it
// ---------------------------------------------------------------------------

/**
 * The same-scope key for ONE recorded session: its `session.start`
 * `session_pubkey` and its logical `session_id`, in the shape `commitNodeKey`
 * uses — a labelled first half, a space, then the id verbatim.
 *
 * Both halves are read out of the first event of the log, so a partner holding
 * only a PREFIX of a still-growing `.slog` derives the identical key. See the
 * header for why the file digest cannot be used for this and the bare uuid
 * should not be.
 */
export function sessionNodeKey(sessionPubkey: string, sessionId: string): string {
  return `session:${sessionPubkey} ${sessionId}`;
}

/**
 * The smallest partnership the evidence can describe: two people.
 *
 * Named rather than inlined because {@link MIN_POOL_FOR_CEILING} is DERIVED from
 * it, and the derivation is the argument for that bound.
 */
const MIN_PARTNERSHIP = 2;

/**
 * The smallest submission pool on which the cohort-fraction ceiling is applied.
 *
 * The ceiling admits a key carried by `k` archives when `k < n / 2`. For the
 * smallest partnership that needs `MIN_PARTNERSHIP < n / 2`, i.e.
 * `n > 2 * MIN_PARTNERSHIP` — so `2 * MIN_PARTNERSHIP + 1` is the first pool
 * size at which the rule can say yes to anything. Applying it below that would
 * not narrow the key, it would disable it. See the header.
 */
const MIN_POOL_FOR_CEILING = 2 * MIN_PARTNERSHIP + 1;

/**
 * May a session key carried by `observerCount` of `poolSize` archives union?
 *
 * Strict minority, with the exact even split rejected — the ambiguous boundary
 * fails toward comparing. Inert below {@link MIN_POOL_FOR_CEILING}, where the
 * rule has no satisfying `k` and there is no cohort to protect.
 */
function ceilingAdmits(observerCount: number, poolSize: number): boolean {
  if (poolSize < MIN_POOL_FOR_CEILING) return true;
  return observerCount * 2 < poolSize;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Split a `commitNodeKey` back into its two halves.
 *
 * The separator is the FIRST space: a repository key is `repository:` followed
 * by hex or by the sentinel word, and can never contain one, while a sha is
 * stored verbatim and — this shape round-trips through JSON from two producers —
 * is not guaranteed to be well-formed.
 *
 * Returns `null` for anything that is not `<repository> <sha>`. Such a key still
 * participates in exact-key matching, where it can only ever match a byte-equal
 * key; it simply gets no sentinel-tolerant bridge, because there is no sha to
 * bridge on. Guessing at a malformed key is how a partition ends up merging on
 * garbage.
 */
function splitNodeKey(key: string): { repository: string; sha: string } | null {
  const i = key.indexOf(' ');
  if (i <= 0 || i === key.length - 1) return null;
  return { repository: key.slice(0, i), sha: key.slice(i + 1) };
}

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
  // bare sha → how it was observed, split by repository labelling. The second
  // view of the same data, and the one the sentinel-tolerant bridge reads.
  const byBareSha = new Map<string, { sentinel: number[]; real: Map<string, number[]> }>();

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

      const parts = splitNodeKey(key);
      if (parts === null) continue;
      let group = byBareSha.get(parts.sha);
      if (group === undefined) {
        group = { sentinel: [], real: new Map() };
        byBareSha.set(parts.sha, group);
      }
      if (parts.repository === ASSUMED_SINGLE_REPOSITORY) {
        group.sentinel.push(i);
      } else {
        const observers = group.real.get(parts.repository);
        if (observers === undefined) group.real.set(parts.repository, [i]);
        else observers.push(i);
      }
    }
  }

  // session node key → the submission indexes that carry that session. Same
  // shape as `observersByCommit`, and deduplicated within a submission for the
  // same reason: one archive holding a session is one holder of it, however
  // many ways it is reachable.
  const holdersBySession = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    // Absent means "never computed" — read as no exclusion, so a construction
    // site that predates the field behaves exactly as it did before.
    const keys = features[i]!.recordedSessionKeys ?? [];
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const list = holdersBySession.get(key);
      if (list === undefined) holdersBySession.set(key, [i]);
      else list.push(i);
    }
  }

  /**
   * Every node key proven shared, mapped to one submission that observed it —
   * enough to recover the lineage root once all unions have settled.
   */
  const provingCommits = new Map<string, number>();
  /** The same, for session keys — kept apart so the two proofs never mix. */
  const provingSessions = new Map<string, number>();

  /** Only a commit two different submissions BOTH observed is evidence. */
  for (const [key, observers] of observersByCommit) {
    if (observers.length < 2) continue;
    if (!provingCommits.has(key)) provingCommits.set(key, observers[0]!);
    for (let k = 1; k < observers.length; k++) union(observers[0]!, observers[k]!);
  }

  // The sentinel-tolerant bridge: one sha, one real repository, at least one
  // unlabelled observation of it. See the header — the `real.size !== 1` guard
  // is what stops two real repositories being merged through the sentinel in two
  // hops, and is not an optimization.
  for (const [sha, group] of byBareSha) {
    if (group.sentinel.length === 0) continue;
    if (group.real.size !== 1) continue;
    const entry = [...group.real.entries()][0]!;
    const [repository, realObservers] = entry;

    const members = new Set<number>([...group.sentinel, ...realObservers]);
    // One submission that labelled some sessions and not others observes this
    // sha under both keys. That is one holder of one repository, not two.
    if (members.size < 2) continue;

    const sentinelKey = commitNodeKey(ASSUMED_SINGLE_REPOSITORY, sha);
    const realKey = commitNodeKey(repository, sha);
    const representative = group.sentinel[0]!;
    if (!provingCommits.has(sentinelKey)) provingCommits.set(sentinelKey, representative);
    if (!provingCommits.has(realKey)) provingCommits.set(realKey, realObservers[0]!);

    const ordered = [...members].sort((a, b) => a - b);
    for (let k = 1; k < ordered.length; k++) union(ordered[0]!, ordered[k]!);
  }

  // The session pass. Runs AFTER the commit passes so that a lineage the
  // commits already established is not re-derived, and — the part that matters
  // — so the cohort-fraction ceiling is evaluated against the ORIGINAL pool
  // rather than against whatever the earlier unions produced. Measuring
  // distribution against a partly-collapsed pool would let the first few
  // legitimate unions shrink the denominator and admit a starter.
  for (const [key, holders] of holdersBySession) {
    if (holders.length < 2) continue;
    // The starter guard. A key the ceiling rejects is discarded as evidence
    // entirely: it unions nothing, and it is not recorded as having proved
    // anything either.
    if (!ceilingAdmits(holders.length, n)) continue;
    if (!provingSessions.has(key)) provingSessions.set(key, holders[0]!);
    for (let k = 1; k < holders.length; k++) union(holders[0]!, holders[k]!);
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
  for (const [key, representative] of provingCommits) {
    const root = find(representative);
    const list = commitsByRoot.get(root);
    if (list === undefined) commitsByRoot.set(root, [key]);
    else list.push(key);
  }

  const sessionsByRoot = new Map<number, string[]>();
  for (const [key, representative] of provingSessions) {
    const root = find(representative);
    const list = sessionsByRoot.get(root);
    if (list === undefined) sessionsByRoot.set(root, [key]);
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
    const sharedCommits = [...(commitsByRoot.get(root) ?? [])].sort();
    const sharedSessions = [...(sessionsByRoot.get(root) ?? [])].sort();
    exclusions.push({
      // Derived from the proofs. A lineage holding any shared commit is a
      // repository lineage and says so; one proved only by shared sessions
      // makes the narrower claim it can actually support.
      reason: sharedCommits.length > 0 ? 'same_repository_lineage' : 'shared_recording_scope',
      bundleIds: sorted.map((f) => f.bundleId),
      sourceFilenames: sorted.map((f) => f.sourceFilename),
      sharedCommits,
      sharedSessions,
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
