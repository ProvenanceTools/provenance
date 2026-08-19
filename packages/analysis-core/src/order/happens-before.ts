/**
 * `≺` — the happens-before relation over events — Tier 2.1 of
 * `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` (§5.2, §7).
 *
 * ## What this is, and what it deliberately is NOT
 *
 * This module answers exactly one question: **given two events, does the
 * evidence prove one happened before the other?** The answer is one of five
 * values and one of them is "no, they are concurrent". That is not a gap to be
 * filled in later; it is the correct answer, and the spec forbids anything
 * downstream from linearizing it away (§5.2, §6).
 *
 * What this module is NOT is a re-keying of {@link EventIndex.globalIdx}. The
 * spec's §5.2 "What this costs" paragraph proposes re-keying `globalIdx` onto
 * the new order in one change. **That is not done here, on purpose**, and the
 * reason is recorded at the top of the file because it is the single most
 * dangerous thing anyone could do to this codebase:
 *
 * > `globalIdx` is PERSISTED. `packages/server/src/db/schema.ts` stores
 * > `flags.supporting_seqs` and `cross_flag_participants.supporting_seqs` as
 * > `int[]` of `globalIdx` values. Re-keying `globalIdx` silently repoints every
 * > stored finding's evidence at different events. A grader opening a months-old
 * > academic-integrity finding against a named student would be shown the wrong
 * > events, with no error raised anywhere. Fabricated evidence against a real
 * > person is the worst failure this system can produce (spec R2), and it would
 * > be produced silently, at rest, by a change that looked like a refactor.
 *
 * So `globalIdx` keeps its exact meaning: a dense index over the wall-derived
 * `ordered` array. `buildIndex` is untouched. Nothing stored changes meaning.
 * `≺` is delivered as a SEPARATE artifact that consumers adopt deliberately, one
 * at a time, and the re-key (if it is ever wanted) becomes a decision taken with
 * a migration, when real consumers exist to test it against.
 *
 * ## Why you cannot accidentally get a total order out of this
 *
 * Three structural defences, because "the caller will be careful" is not a
 * defence:
 *
 *  1. {@link compareEvents} returns a **string**, never a number. It is
 *     physically unusable as an `Array.prototype.sort` comparator — passing it
 *     to `sort` is a type error, not a subtly wrong ordering. This mirrors
 *     {@link compareCommits} in `git/observed-dag.ts` for the same reason.
 *  2. There is **no new integer field** on `IndexedEvent`. An `orderIdx` sitting
 *     beside `globalIdx` would be two interchangeable-looking numbers on one
 *     object, one of which is written to Postgres — that is a foot-gun with a
 *     hair trigger, and the way to not fire it is to not build it.
 *  3. The one function that does produce a list, {@link presentationSort}, says
 *     so in its name, returns events rather than indices, and documents that its
 *     tiebreak is presentation and never a happens-before claim.
 *
 * ## The model (spec §5.2)
 *
 * `≺` is the transitive closure of three generators, strongest first:
 *
 *  - **L0 — intra-session hash chain.** `seq` order within one session. Total,
 *    and forging it requires the session's private key.
 *  - **L1 — intra-contributor session chain.** `prev_session_id`, ownership-
 *    gated: a back-pointer at a session belonging to a PROVABLY DIFFERENT
 *    contributor is a {@link ForeignSessionLinkDefect} and is not an edge
 *    (§5.4 step 2). `'unknown'` contributors still link — the spec gates on
 *    `'different'`, and refusing to link an unidentified student's own two
 *    sessions would discard real ordering for every pre-identity bundle.
 *  - **L2 — the observed commit DAG.** The only trustworthy CROSS-contributor
 *    relation. Consumed through Tier 1.2's `compareCommits` / `ancestorsOfCommit`;
 *    this module never re-reads a `git.event` payload itself.
 *
 * **L3 — wall clock — generates nothing here.** It is not read, not compared and
 * not sorted on anywhere in this file. Two machines' clocks are worth nothing
 * relative to each other (spec S16), so a skew of any size cannot change a
 * single answer this module gives. That is a property worth testing, and
 * `happens-before.test.ts` tests it.
 *
 * ## How it is computed, and why it is not quadratic in event count
 *
 * The naive reading of rule L2 — "for every pair of events, hunt for a
 * connecting pair of git observations" — is O(N²) in events, on top of
 * heuristics that are already O(N²). Instead the relation is factored through a
 * small **position graph**, because every cross-session path must leave one
 * session and enter another through a bounded set of doors:
 *
 *  - one node per commit observation (`G` of them, one per `git.event` naming a
 *    sha — tens, occasionally hundreds; never proportional to keystrokes), plus
 *  - two virtual nodes per session, `SIN` (before all events) and `SOUT` (after
 *    all events), which is what lets a session with no `git.event` at all still
 *    participate in L1 ordering.
 *
 * An event's only way out of its session is the first observation at or after
 * its `seq` (or `SOUT` if there is none); its only way in is the last
 * observation at or before its `seq` (or `SIN`). So `e ≺ f` across sessions
 * reduces to a single reachability lookup between two precomputed doors.
 *
 * Cost: **O(N)** to bucket events and locate doors (one pass), **O(G + S)**
 * nodes, and a bitset reachability fixpoint over that small graph. No pass is
 * quadratic in N, and queries are O(1) after construction. See
 * `happens-before.bench.test.ts` for the measurement.
 */

import type { EventKind, HashedEnvelope } from '@provenance/log-core';
import {
  ASSUMED_SINGLE_REPOSITORY,
  ancestorsOfCommit,
  type ObservedDag,
  type RepositoryKey,
} from '../git/observed-dag.js';
import { compareContributors, type SessionContributor } from '../identity/types.js';

// ---------------------------------------------------------------------------
// Public vocabulary
// ---------------------------------------------------------------------------

/**
 * A pointer at one event: its session, and its position in that session's signed
 * chain. Deliberately the same `(sessionId, seq)` pair the DAG uses for
 * observations, and deliberately NOT `globalIdx` — this module has no opinion
 * about, and no dependency on, the index's dense numbering.
 */
export type EventRef = {
  sessionId: string;
  seq: number;
};

/**
 * The answer {@link compareEvents} gives. **There is no total order here and
 * there must never be one.**
 *
 * A string union, not a number, so that this can never be handed to `sort`.
 *
 * - `'before'` / `'after'` — proven by L0, L1 or L2. A real happens-before claim.
 * - `'concurrent'` — the evidence orders neither way. Either genuinely divergent
 *   branches, or history nobody recorded; **the evidence cannot tell those two
 *   apart and neither may the caller.** Picking a side here fabricates a fact.
 * - `'same'` — the same event.
 * - `'unknown'` — at least one ref names an event that is not in this scope.
 *   Nobody recorded it, so there is no basis for any statement. This is NOT
 *   `'concurrent'`, which is a statement about two events we do have.
 *
 * The `'unknown'` / `'concurrent'` distinction is inherited deliberately from
 * {@link CommitOrder} and collapsing it is a mutation the test suite catches:
 * "we have no record of this event" and "these two events genuinely raced" are
 * different facts and a reader must be told which one they are looking at.
 *
 * A caller must handle all five. Code shaped `if (r === 'before') … else …`
 * silently lumps `'after'`, `'concurrent'`, `'same'` and `'unknown'` together.
 */
export type EventOrder = 'before' | 'after' | 'concurrent' | 'same' | 'unknown';

/** A `prev_session_id` that cannot be honoured as an ordering edge. */
export type ForeignSessionLinkDefect = {
  kind: 'foreign_session_link';
  /** The session whose `session.start` carried the back-pointer. */
  sessionId: string;
  /** The session it pointed at. */
  prevSessionId: string;
  detail: string;
};

/** A `prev_session_id` naming a session that is not in this scope. */
export type DanglingSessionLinkDefect = {
  kind: 'dangling_session_link';
  sessionId: string;
  prevSessionId: string;
  detail: string;
};

/**
 * The `prev_session_id` edges form a cycle, so they cannot all be true.
 *
 * Reported rather than resolved. The edges are still installed: a cycle makes
 * every session in it mutually reachable, which surfaces as `'concurrent'` for
 * the pairs involved — refusing to order a contradiction, exactly as
 * {@link compareCommits} refuses to pick a side inside a commit cycle.
 */
export type SessionChainCycleDefect = {
  kind: 'session_chain_cycle';
  /** The sessions on the cycle, sorted, so the report is deterministic. */
  sessionIds: readonly string[];
  detail: string;
};

export type EventOrderingDefect =
  | ForeignSessionLinkDefect
  | DanglingSessionLinkDefect
  | SessionChainCycleDefect;

/**
 * The minimum this module needs from a bundle. `Bundle` satisfies it
 * structurally, so callers pass a bundle and tests can pass hand-built sessions
 * without a ZIP — the same arrangement as {@link ObservedDagSource}.
 */
export type EventOrderingSource = {
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly events: readonly HashedEnvelope[];
  }[];
};

export type EventOrderingInput = {
  readonly source: EventOrderingSource;
  /**
   * Tier 1.2's observed commit DAG, built from the same scope. Supplying an
   * empty DAG is legitimate and simply removes L2: sessions then order only
   * within themselves (L0) and along their contributor's chain (L1).
   */
  readonly dag: ObservedDag;
  /**
   * Tier 1.1's `contributorOf`, as a map. Omit for a scope with no identity: L1
   * edges are then ungated, which matches the pre-identity single-student world
   * and is what keeps existing bundles ordering exactly as they always have.
   */
  readonly contributors?: ReadonlyMap<string, SessionContributor> | undefined;
};

/**
 * The computed relation. Opaque by intent: everything you may ask of it goes
 * through the exported functions below, none of which will hand you a total
 * order over concurrent events.
 */
export type EventOrdering = {
  /** Sessions in this scope, sorted by id. Clock-free and deterministic. */
  readonly sessionIds: readonly string[];
  /** Everything contradictory about the session chain, in a deterministic order. */
  readonly defects: readonly EventOrderingDefect[];
  /** @internal Position-graph plumbing. Not part of the supported surface. */
  readonly _internal: OrderingInternals;
};

type OrderingInternals = {
  /** `sessionId` → the seqs present, for existence checks (the `'unknown'` answer). */
  readonly seqsBySession: ReadonlyMap<string, ReadonlySet<number>>;
  /** `sessionId` → observation seqs in that session, ascending. */
  readonly obsSeqsBySession: ReadonlyMap<string, readonly number[]>;
  /** `sessionId` → position-graph node id of each observation, parallel to the above. */
  readonly obsNodesBySession: ReadonlyMap<string, readonly number[]>;
  /** `sessionId` → its `SIN` node id. */
  readonly sinNode: ReadonlyMap<string, number>;
  /** `sessionId` → its `SOUT` node id. */
  readonly soutNode: ReadonlyMap<string, number>;
  /** Bitset reachability over the position graph: `reach[node]` = nodes reachable. */
  readonly reach: Uint32Array;
  readonly words: number;
  readonly nodeCount: number;
  /**
   * How many nodes can reach each node. A cycle-safe stand-in for a topological
   * rank: if `x ⇒ y` and not `y ⇒ x` then everything reaching `x` also reaches
   * `y`, plus `x` itself, so `rank(x) < rank(y)` strictly. Mutually reachable
   * nodes simply tie, which is the honest outcome for a contradiction.
   *
   * This is what lets {@link presentationSort} be a sort rather than a pairwise
   * topological walk — i.e. O(n log n) in events, not O(n²).
   */
  readonly inReachCount: Int32Array;
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build `≺` for one scope.
 *
 * Pure and deterministic: no wall clock is read, no `Math.random`, and every
 * iteration is over an explicitly sorted sequence rather than a Map's insertion
 * order. Two runs over one bundle produce identical output — which is the
 * property ingest retries depend on, and which
 * `happens-before.test.ts` asserts directly.
 *
 * This is NOT called by `buildIndex`. Nothing in the current pipeline consumes
 * `≺` yet, and making every index build pay for a graph nobody reads would be a
 * regression on an ingest path that is already CPU-bound. Tier 2.2+ wires it in
 * at the point of first use.
 */
export function buildEventOrdering(input: EventOrderingInput): EventOrdering {
  const { source, dag, contributors } = input;

  // Sessions in a deterministic, clock-free order. Everything below iterates
  // this array rather than `source.sessions`, so a caller handing us sessions in
  // a different order cannot change a single bit of the result.
  const sessionIds = [...new Set(source.sessions.map((s) => s.sessionId))].sort();
  const sessionSet = new Set(sessionIds);

  // -------------------------------------------------------------------------
  // Pass 1 (O(N)): which seqs exist, and each session's prev_session_id.
  // -------------------------------------------------------------------------
  const seqsBySession = new Map<string, Set<number>>();
  const prevBySession = new Map<string, string | null>();
  for (const id of sessionIds) {
    seqsBySession.set(id, new Set<number>());
    prevBySession.set(id, null);
  }
  for (const session of source.sessions) {
    const seqs = seqsBySession.get(session.sessionId);
    if (seqs === undefined) continue;
    for (const envelope of session.events) {
      seqs.add(envelope.seq);
      if (envelope.kind === ('session.start' satisfies EventKind)) {
        const prev = readPrevSessionId(envelope.data);
        if (prev !== null && prevBySession.get(session.sessionId) === null) {
          prevBySession.set(session.sessionId, prev);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Observations, bucketed per session in ascending seq order.
  //
  // Sourced from `dag.observations` rather than re-read from payloads: Tier 1.2
  // already did the defensive parsing, the absent-vs-empty `parents` handling and
  // the repository keying, and duplicating any of that here would be a second
  // implementation of a contract that exists to have exactly one.
  // -------------------------------------------------------------------------
  const obsBySession = new Map<string, { seq: number; sha: string; repository: RepositoryKey }[]>();
  for (const id of sessionIds) obsBySession.set(id, []);
  for (const obs of dag.observations) {
    const bucket = obsBySession.get(obs.sessionId);
    if (bucket === undefined) continue;
    bucket.push({ seq: obs.seq, sha: obs.sha, repository: obs.repository });
  }
  for (const bucket of obsBySession.values()) {
    bucket.sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : compareStrings(a.sha, b.sha)));
  }

  // -------------------------------------------------------------------------
  // Position graph nodes: SIN_s, then s's observations in seq order, then SOUT_s.
  // -------------------------------------------------------------------------
  const sinNode = new Map<string, number>();
  const soutNode = new Map<string, number>();
  const obsSeqsBySession = new Map<string, number[]>();
  const obsNodesBySession = new Map<string, number[]>();
  /** node id → the commit it observes; `undefined` for the virtual nodes. */
  const nodeCommit: ({ sha: string; repository: RepositoryKey } | undefined)[] = [];

  let nodeCount = 0;
  for (const id of sessionIds) {
    sinNode.set(id, nodeCount);
    nodeCommit[nodeCount] = undefined;
    nodeCount += 1;

    const seqs: number[] = [];
    const nodes: number[] = [];
    for (const obs of obsBySession.get(id) ?? []) {
      seqs.push(obs.seq);
      nodes.push(nodeCount);
      nodeCommit[nodeCount] = { sha: obs.sha, repository: obs.repository };
      nodeCount += 1;
    }
    obsSeqsBySession.set(id, seqs);
    obsNodesBySession.set(id, nodes);

    soutNode.set(id, nodeCount);
    nodeCommit[nodeCount] = undefined;
    nodeCount += 1;
  }

  // -------------------------------------------------------------------------
  // Edges.
  // -------------------------------------------------------------------------
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);

  // E1 — within a session: SIN → obs₀ → obs₁ → … → SOUT (L0, the hash chain).
  for (const id of sessionIds) {
    const nodes = obsNodesBySession.get(id) ?? [];
    const sin = sinNode.get(id)!;
    const sout = soutNode.get(id)!;
    let prevNode = sin;
    for (const node of nodes) {
      adjacency[prevNode]!.push(node);
      prevNode = node;
    }
    adjacency[prevNode]!.push(sout);
  }

  // E2 — the commit DAG (L2). The only cross-contributor generator.
  //
  // Ancestor sets are computed once per distinct commit and then reused, so this
  // is |distinct commits| traversals plus G² set lookups — G being observation
  // count, which is bounded by `git.event` count, not by event count.
  const defects: EventOrderingDefect[] = [];
  const ancestorCache = new Map<string, ReadonlySet<string>>();
  const ancestorsOf = (repository: RepositoryKey, sha: string): ReadonlySet<string> => {
    const key = `${repository} ${sha}`;
    let set = ancestorCache.get(key);
    if (set === undefined) {
      set = ancestorsOfCommit(dag, sha, repository);
      ancestorCache.set(key, set);
    }
    return set;
  };

  for (let to = 0; to < nodeCount; to++) {
    const target = nodeCommit[to];
    if (target === undefined) continue;
    const ancestors = ancestorsOf(target.repository, target.sha);
    if (ancestors.size === 0) continue;
    for (let from = 0; from < nodeCount; from++) {
      if (from === to) continue;
      const origin = nodeCommit[from];
      if (origin === undefined) continue;
      if (origin.repository !== target.repository) continue;
      if (!ancestors.has(origin.sha)) continue;
      adjacency[from]!.push(to);
    }
  }

  // E3 — the contributor's session chain (L1), ownership-gated.
  for (const id of sessionIds) {
    const prev = prevBySession.get(id) ?? null;
    if (prev === null) continue;
    if (prev === id) {
      defects.push({
        kind: 'session_chain_cycle',
        sessionIds: [id],
        detail: `session ${id} names itself as prev_session_id`,
      });
      continue;
    }
    if (!sessionSet.has(prev)) {
      defects.push({
        kind: 'dangling_session_link',
        sessionId: id,
        prevSessionId: prev,
        detail: `prev_session_id names ${prev}, which is not in this scope`,
      });
      continue;
    }
    if (contributors !== undefined) {
      const here = contributors.get(id);
      const there = contributors.get(prev);
      if (
        here !== undefined &&
        there !== undefined &&
        compareContributors(here, there) === 'different'
      ) {
        // Spec §5.4 step 2. Honouring this would let one contributor's chain
        // hang off another's, which is precisely how work gets laundered onto a
        // student who did not do it.
        defects.push({
          kind: 'foreign_session_link',
          sessionId: id,
          prevSessionId: prev,
          detail: `prev_session_id names ${prev}, which belongs to a different contributor; not honoured as an ordering edge`,
        });
        continue;
      }
    }
    adjacency[soutNode.get(prev)!]!.push(sinNode.get(id)!);
  }

  // -------------------------------------------------------------------------
  // Reachability closure over the position graph.
  //
  // Bitset fixpoint. Cycle-safe by construction (a fixpoint converges on a cycle
  // by making its members mutually reachable, which `compareEvents` then reports
  // as `'concurrent'` — a contradiction is not a licence to pick a side).
  // -------------------------------------------------------------------------
  const words = Math.max(1, Math.ceil(nodeCount / 32));
  const reach = new Uint32Array(nodeCount * words);
  for (let node = 0; node < nodeCount; node++) {
    const base = node * words;
    for (const next of adjacency[node]!) {
      reach[base + (next >>> 5)]! |= 1 << (next & 31);
    }
  }
  // Iterate in reverse node order: node ids ascend with (session, seq), so the
  // within-session chains converge in a single pass and only the cross-session
  // edges need further rounds. Bounded by nodeCount, which guarantees
  // termination even on a forged cycle.
  for (let round = 0; round < nodeCount; round++) {
    let changed = false;
    for (let node = nodeCount - 1; node >= 0; node--) {
      const base = node * words;
      for (const next of adjacency[node]!) {
        const nextBase = next * words;
        for (let w = 0; w < words; w++) {
          const before = reach[base + w]!;
          const after = before | reach[nextBase + w]!;
          if (after !== before) {
            reach[base + w] = after;
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  detectSessionChainCycles(sessionIds, sinNode, soutNode, reach, words, defects);

  // In-reach counts, for the presentation rank. Counts set bits of the reach
  // matrix column-wise; bounded by the position graph, never by event count.
  const inReachCount = new Int32Array(nodeCount);
  for (let from = 0; from < nodeCount; from++) {
    const base = from * words;
    for (let w = 0; w < words; w++) {
      let bits = reach[base + w]!;
      while (bits !== 0) {
        const lowest = bits & -bits;
        const to = (w << 5) + bitIndex(lowest);
        inReachCount[to]! += 1;
        bits ^= lowest;
      }
    }
  }

  defects.sort(compareDefects);

  return {
    sessionIds,
    defects,
    _internal: {
      seqsBySession,
      obsSeqsBySession,
      obsNodesBySession,
      sinNode,
      soutNode,
      reach,
      words,
      nodeCount,
      inReachCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Querying — the supported surface
// ---------------------------------------------------------------------------

/**
 * `≺`. Five-valued, partial, and returning a **string so it can never be used as
 * a sort comparator**.
 *
 * See {@link EventOrder} for what each answer means and why `'concurrent'` and
 * `'unknown'` must not be collapsed.
 */
export function compareEvents(ordering: EventOrdering, a: EventRef, b: EventRef): EventOrder {
  const internals = ordering._internal;

  const aSeqs = internals.seqsBySession.get(a.sessionId);
  const bSeqs = internals.seqsBySession.get(b.sessionId);
  if (aSeqs === undefined || bSeqs === undefined) return 'unknown';
  if (!aSeqs.has(a.seq) || !bSeqs.has(b.seq)) return 'unknown';

  // L0 — within one session the hash chain is a total order, and it is the
  // strongest evidence in the system.
  if (a.sessionId === b.sessionId) {
    if (a.seq === b.seq) return 'same';
    return a.seq < b.seq ? 'before' : 'after';
  }

  const forward = crossSessionReaches(internals, a, b);
  const backward = crossSessionReaches(internals, b, a);
  // Both directions means the observations contradict themselves — reachable
  // only through a cycle, already reported in `defects`. Refuse to pick a side.
  if (forward && backward) return 'concurrent';
  if (forward) return 'before';
  if (backward) return 'after';
  return 'concurrent';
}

/**
 * `true` iff the evidence orders neither way. Sugar over {@link compareEvents},
 * and deliberately false for `'unknown'`: an event nobody recorded is not
 * thereby "concurrent" with one we have.
 */
export function areConcurrent(ordering: EventOrdering, a: EventRef, b: EventRef): boolean {
  return compareEvents(ordering, a, b) === 'concurrent';
}

/** `true` iff `a ≺ b` is proven. Every other answer, including `'unknown'`, is false. */
export function happensBefore(ordering: EventOrdering, a: EventRef, b: EventRef): boolean {
  return compareEvents(ordering, a, b) === 'before';
}

/**
 * An event's only exit from its session: the first observation at or after its
 * `seq`, else the session's `SOUT`.
 */
function exitNode(internals: OrderingInternals, ref: EventRef): number {
  const seqs = internals.obsSeqsBySession.get(ref.sessionId) ?? [];
  const nodes = internals.obsNodesBySession.get(ref.sessionId) ?? [];
  const i = lowerBound(seqs, ref.seq);
  if (i < nodes.length) return nodes[i]!;
  return internals.soutNode.get(ref.sessionId)!;
}

/**
 * An event's only entrance into its session: the last observation at or before
 * its `seq`, else the session's `SIN`.
 */
function entryNode(internals: OrderingInternals, ref: EventRef): number {
  const seqs = internals.obsSeqsBySession.get(ref.sessionId) ?? [];
  const nodes = internals.obsNodesBySession.get(ref.sessionId) ?? [];
  const i = upperBound(seqs, ref.seq) - 1;
  if (i >= 0) return nodes[i]!;
  // `-1` for a session outside this scope. Only reachable via `presentationSort`,
  // which accepts any refs; `compareEvents` has already answered `'unknown'`.
  return internals.sinNode.get(ref.sessionId) ?? -1;
}

function crossSessionReaches(internals: OrderingInternals, a: EventRef, b: EventRef): boolean {
  const from = exitNode(internals, a);
  const to = entryNode(internals, b);
  if (from === to) return false;
  const word = internals.reach[from * internals.words + (to >>> 5)] ?? 0;
  return (word & (1 << (to & 31))) !== 0;
}

// ---------------------------------------------------------------------------
// Presentation — NOT an ordering claim
// ---------------------------------------------------------------------------

/**
 * A stable list order for display.
 *
 * **This is presentation, not happens-before.** Where `≺` orders two events this
 * respects it; where `≺` is silent — i.e. the events are genuinely concurrent —
 * it falls back to the `(sessionId, seq)` tiebreak purely so a list does not
 * reshuffle between renders. The resulting sequence is a TOTAL order and
 * therefore says strictly more than the evidence does. Anything reasoning about
 * what happened before what must call {@link compareEvents} and handle
 * `'concurrent'`; reading adjacency in this list as causality is exactly the
 * mistake the five-valued API exists to prevent.
 *
 * The tiebreak is `(sessionId, seq)` — clock-free, so two machines' skew cannot
 * change it, and identical across runs.
 *
 * Note this does NOT renumber anything. It returns events. `globalIdx` remains
 * the index's own wall-derived numbering and remains what `supporting_seqs`
 * persists; see this module's header.
 */
export function presentationSort<T extends EventRef>(
  ordering: EventOrdering,
  events: readonly T[],
): readonly T[] {
  const internals = ordering._internal;
  // Rank by the event's entrance door. Proof this is a linear extension of `≺`:
  // if `e ≺ f` then `entry(e) ⇒* exit(e) ⇒* entry(f)` — the first step because
  // a session's own chain runs SIN → obs… → SOUT in seq order and `entry(e)`
  // sits at or before `exit(e)` — so every node reaching `entry(e)` reaches
  // `entry(f)`, and `entry(e)` does too, giving a strictly larger in-reach count
  // unless the two are mutually reachable (a forged cycle) or identical (same
  // session, where the `seq` tiebreak already agrees with `≺`).
  const rank = (ref: EventRef): number => {
    const node = entryNode(internals, ref);
    return internals.inReachCount[node] ?? 0;
  };
  const ranked = events.map((event) => ({ event, rank: rank(event) }));
  ranked.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : compareEventRefs(a.event, b.event)));
  return ranked.map((r) => r.event);
}

/** The presentation tiebreak: `(sessionId, seq)`. Clock-free by construction. */
export function compareEventRefs(a: EventRef, b: EventRef): number {
  if (a.sessionId !== b.sessionId) return compareStrings(a.sessionId, b.sessionId);
  return a.seq - b.seq;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPrevSessionId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const prev = (data as Record<string, unknown>)['prev_session_id'];
  return typeof prev === 'string' && prev.length > 0 ? prev : null;
}

/** Index of the single set bit in a power-of-two word. */
function bitIndex(lowestSetBit: number): number {
  return 31 - Math.clz32(lowestSetBit);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** First index whose value is `>= target`. */
function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is `> target`. */
function upperBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function detectSessionChainCycles(
  sessionIds: readonly string[],
  sinNode: ReadonlyMap<string, number>,
  soutNode: ReadonlyMap<string, number>,
  reach: Uint32Array,
  words: number,
  defects: EventOrderingDefect[],
): void {
  const onCycle: string[] = [];
  for (const id of sessionIds) {
    const sin = sinNode.get(id)!;
    const sout = soutNode.get(id)!;
    // A session is on a cycle iff its own SOUT can reach its own SIN.
    const word = reach[sout * words + (sin >>> 5)] ?? 0;
    if ((word & (1 << (sin & 31))) !== 0) onCycle.push(id);
  }
  if (onCycle.length > 0) {
    defects.push({
      kind: 'session_chain_cycle',
      sessionIds: [...onCycle].sort(),
      detail: `${onCycle.length} session(s) are mutually reachable, so the recorded ordering cannot all be true; affected pairs are reported as concurrent`,
    });
  }
}

function compareDefects(a: EventOrderingDefect, b: EventOrderingDefect): number {
  if (a.kind !== b.kind) return compareStrings(a.kind, b.kind);
  if (a.kind === 'session_chain_cycle' && b.kind === 'session_chain_cycle') {
    return compareStrings(a.sessionIds.join(','), b.sessionIds.join(','));
  }
  const aa = a as ForeignSessionLinkDefect | DanglingSessionLinkDefect;
  const bb = b as ForeignSessionLinkDefect | DanglingSessionLinkDefect;
  if (aa.sessionId !== bb.sessionId) return compareStrings(aa.sessionId, bb.sessionId);
  return compareStrings(aa.prevSessionId, bb.prevSessionId);
}
