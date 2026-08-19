/**
 * The observed commit DAG — Tier 1.2 of
 * `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` (§5.2, §7).
 *
 * ## Why this exists
 *
 * Gradescope delivers the working tree and never `.git`, so the commit graph
 * exists only as whatever the recorders captured into their signed hash chains.
 * Two partners work on two machines whose relative wall clocks are worth
 * nothing — skew, timezones, a student who changed the clock — so wall time
 * cannot order anything across contributors (spec S16). The commit DAG is the
 * only cross-contributor ordering primitive that survives that, and it is
 * *partial by construction*: two commits on divergent branches are genuinely
 * unordered, and the honest answer is to say so.
 *
 * ## What this module promises, and what it refuses to promise
 *
 * Everything here is **observed**, never authoritative. The graph is assembled
 * from `git.event` payloads inside signed chains, so each fact carries the
 * `(sessionId, seq)` of the chain entry that asserted it — which is what makes
 * it evidence rather than metadata, and what lets Tier 1.1's `contributorOf`
 * turn "this session said so" into "this contributor said so".
 *
 * Four kinds of incompleteness are modelled EXPLICITLY, because collapsing any
 * of them into a tidy answer manufactures a claim nobody can back:
 *
 *  - **`parents` absent vs `parents: []`.** Absent means "the recorder could not
 *    read them"; empty means "this commit genuinely has no parents". Collapsing
 *    them turns every read failure into a false repository root (spec S15), and
 *    the `git-event` conformance vector already pins the two as canonicalizing —
 *    and therefore hashing — differently. {@link CommitNode.parentsState} keeps
 *    them apart, and `parents` is `null` (not `[]`) when unrecorded.
 *
 *  - **Witnessed-only commits.** A sha that only ever appears inside somebody
 *    else's `parents` array is proof a commit existed with no session recording
 *    work at it — a partner's commit, or history from before recording started.
 *    It becomes a node with `presence: 'witnessed_only'` and no observations.
 *
 *  - **Conflicting parent lists for one sha.** In real git this is impossible:
 *    the sha is a hash over the commit object, parents included. So two signed
 *    chains claiming different parents for one sha is evidence of a rewrite or a
 *    forgery, not a bug here. We keep every claim, pick no winner, raise a
 *    {@link ObservedDagDefect} — and assert NO in-edges for that commit, because
 *    an edge we are not sure of is a `≺` we are not sure of, and a wrong `≺` is
 *    a wrong accusation downstream.
 *
 *  - **Cycles.** Impossible in git, reachable by forgery. Detected at build
 *    time, reported as a defect, and every traversal here is iterative with a
 *    visited set, so a cycle can neither hang nor overflow the stack.
 *
 * ## No git author identity. Ever.
 *
 * There is no author field here and there must never be one; see the protocol
 * note on `GitEventPayload` in `log-core/src/events.ts`. Attribution runs
 * `observation.sessionId` → `contributorOf(bundle, sessionId)` →
 * `session.start.identity.student_ref`, and nowhere else.
 *
 * ## Single-repository assumption — stated, not hidden
 *
 * Node identity is `(repository, sha)`, exactly as spec §5.2 requires. The
 * repository discriminator is a signed-format decision that has NOT landed
 * (§8.6 / S14(b)): the chosen value is the repository's root-commit sha — both
 * partners derive it identically and offline, which is what makes
 * cross-contributor correlation possible, and a submodule has a different root
 * commit so it discriminates correctly — but no recorder emits it yet. So today
 * every observation is folded into the single sentinel repository
 * {@link ASSUMED_SINGLE_REPOSITORY}, and {@link ObservedDag.repositoryScope}
 * says exactly that, in the API, so a caller cannot mistake the assumption for a
 * finding.
 *
 * **A scope that really observed more than one repository (a submodule, a nested
 * repo) is UNSOUND today** — two unrelated sha spaces would be merged into one
 * graph. That is a stated, tested limitation, not a silent wrong answer. When
 * the discriminator lands, only {@link readRepositoryDiscriminator} changes:
 * every node, edge, traversal and public function here is already keyed on
 * `(repository, sha)`, so nothing else is redesigned.
 */

import type { HashedEnvelope } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Repository scoping
// ---------------------------------------------------------------------------

/**
 * A repository discriminator. Opaque; compared only for equality.
 *
 * Today the only value in circulation is {@link ASSUMED_SINGLE_REPOSITORY}.
 * When §8.6 lands this becomes the repository's root-commit sha.
 */
export type RepositoryKey = string;

/**
 * The sentinel repository every observation is folded into while `git.event`
 * carries no discriminator. Deliberately not a plausible sha, so a value that
 * leaks into a UI or a log reads as an assumption rather than as data.
 */
export const ASSUMED_SINGLE_REPOSITORY: RepositoryKey = 'repository:assumed-single';

/**
 * How this DAG's node keys were scoped, and therefore how far its answers can be
 * trusted.
 */
export type RepositoryScope = {
  /**
   * `'assumed_single'` is the only value today. It means: no observation carried
   * a repository discriminator, so every sha was folded into one repository.
   * Sound for a scope that observed exactly one repository — which is every
   * scope the recorders currently produce, since git wiring watches the one
   * repository owning the assignment root — and UNSOUND for a scope that
   * observed a submodule or a nested repo alongside it (S14(b)).
   */
  kind: 'assumed_single';
  /**
   * Whether any observation carried a repository discriminator. Always `false`
   * today; it is the single bit that flips when §8.6 lands.
   */
  discriminatorRecorded: boolean;
  /**
   * Every repository key present in the graph, in first-observation order. Empty
   * when nothing was observed at all.
   */
  repositories: readonly RepositoryKey[];
};

/**
 * Reads the repository discriminator off a `git.event` payload.
 *
 * Returns `null` today, unconditionally: the field does not exist in the signed
 * format yet (§8.6). This is the ONE function that changes when it does — it
 * starts returning the recorded root-commit sha, {@link RepositoryScope} gains a
 * discriminated variant, and every keyed structure below keeps working because
 * it already keys on `(repository, sha)`.
 *
 * It deliberately does not guess. Deriving a discriminator here — from the
 * branch name, from the shape of the graph, from anything — would invent the
 * very correlation the format decision exists to make trustworthy.
 */
function readRepositoryDiscriminator(_payload: Record<string, unknown>): RepositoryKey | null {
  return null;
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * A pointer at one entry in one signed hash chain. The unit of traceability:
 * every claim this module makes reduces to a set of these, and each one can be
 * re-read out of the `.slog` and re-verified.
 */
export type ObservationRef = {
  sessionId: string;
  /** Position within that session's chain. Totally ordered within a session (L0). */
  seq: number;
};

/** One `git.event` that named a commit sha. */
export type CommitObservation = {
  repository: RepositoryKey;
  /** The sha this event named, verbatim. Never normalized — see `readSha`. */
  sha: string;
  sessionId: string;
  seq: number;
  /**
   * The recording machine's wall clock at this entry, ISO 8601.
   *
   * **Display and skew measurement only** (spec §5.2 L3). Nothing in this module
   * orders, sorts or compares by it, and no caller may either: across
   * contributors it is not an ordering authority, which is the whole reason the
   * DAG exists.
   */
  wall: string;
  /** The `operation` string verbatim, or `''` if unreadable. Descriptive only. */
  operation: string;
  /** Branch name, or `null` when HEAD was detached / unrecorded. Never invented. */
  branch: string | null;
  /**
   * The parent shas this observation recorded, in git's own order — `parents[0]`
   * is the branch merged INTO. **Never sorted**: reversing the order inverts the
   * meaning of a merge, and the conformance vector `merge_commit_parents_flipped`
   * exists to catch a port that sorts.
   *
   * `null` means the field was ABSENT (or unreadable) — "we did not record
   * this". `[]` means the commit genuinely has no parents. These are different
   * facts and this type keeps them different.
   */
  parents: readonly string[] | null;
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** One distinct `parents` array claimed for a sha, with who claimed it. */
export type ParentsClaim = {
  /** The claimed list, in the order recorded. */
  parents: readonly string[];
  /** The observations that made exactly this claim, in `(sessionId, seq)` order. */
  observations: readonly ObservationRef[];
};

/**
 * What we know about a commit's in-edges.
 *
 * - `recorded` — at least one observation recorded `parents`, and every
 *   observation that recorded them agreed exactly, order included. Edges are
 *   asserted.
 * - `unrecorded` — no observation recorded `parents`. In-edges are UNKNOWN. The
 *   commit is never treated as a root; no edges are asserted.
 * - `conflicting` — two or more observations recorded different lists for the
 *   same sha. Cryptographically impossible in git, so it is evidence of a
 *   rewrite or a forgery. Every claim is kept, no winner is picked, and NO edges
 *   are asserted — an in-edge we cannot stand behind becomes an ordering we
 *   cannot stand behind.
 */
export type ParentsState = 'recorded' | 'unrecorded' | 'conflicting';

/** A commit in the observed graph. */
export type CommitNode = {
  repository: RepositoryKey;
  sha: string;
  /**
   * `observed` — some `git.event` named this sha as its own (the spec's
   * "observed HEAD"). `witnessed_only` — the sha appears only inside other
   * commits' `parents`, which is proof the commit existed with no session
   * recording work at it.
   */
  presence: 'observed' | 'witnessed_only';
  /**
   * Every observation naming this sha, in `(sessionId, seq)` order. Empty iff
   * `presence === 'witnessed_only'`. Two entries with different `sessionId`s is
   * the ordinary case of two contributors seeing the same commit —
   * corroboration, not a defect.
   */
  observations: readonly CommitObservation[];
  parentsState: ParentsState;
  /**
   * The agreed parent list in git's order, or `null` when
   * `parentsState !== 'recorded'`. `[]` here means a genuinely parentless
   * commit; `null` means we do not know. Never sorted.
   */
  parents: readonly string[] | null;
  /**
   * Every distinct list claimed for this sha, in first-claim order. Length 0 when
   * unrecorded, 1 when agreed, ≥2 when conflicting.
   */
  parentsClaims: readonly ParentsClaim[];
  /**
   * Shas whose agreed parents include this one, in first-mention order. The
   * out-edges; derived, never recorded.
   */
  children: readonly string[];
  /**
   * `parentsState === 'recorded'` and the agreed list is empty.
   *
   * This is **not** "the repository's history starts here" (spec S15). A shallow
   * clone's grafted boundary commit legitimately reports no parents and is not a
   * root, and the recorder cannot tell the two apart. Read this as
   * *root-or-truncated-lineage* and never render it as "history begins here".
   */
  recordedRoot: boolean;
};

// ---------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------

/**
 * Something the observations say that cannot all be true. Each is a fact worth
 * surfacing — the module fails toward reporting evidence, never toward a tidy
 * graph.
 */
export type ObservedDagDefect =
  | {
      kind: 'conflicting_parents';
      repository: RepositoryKey;
      sha: string;
      /** Every distinct claim, with its observations. No winner is picked. */
      claims: readonly ParentsClaim[];
    }
  | {
      kind: 'cycle';
      repository: RepositoryKey;
      /**
       * The commits on one cycle: each is a recorded parent of the one before it,
       * and the first is a recorded parent of the last. Rotated to start at the
       * lexicographically smallest sha so the report is deterministic whatever
       * the traversal entry point was.
       */
      shas: readonly string[];
    }
  | {
      kind: 'unreadable_parents';
      repository: RepositoryKey;
      sha: string;
      sessionId: string;
      seq: number;
      reason: 'not_an_array' | 'non_string_entry';
    };

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** How much of a graph we actually have. Counts only; no judgement. */
export type ObservedDagCoverage = {
  /** Sessions that produced at least one commit observation. */
  sessionsObserving: number;
  /** Total commit observations. */
  observations: number;
  /** Distinct `(repository, sha)` nodes. */
  commits: number;
  /** Nodes some session named directly. */
  observedCommits: number;
  /** Nodes known only from another commit's `parents`. */
  witnessedOnlyCommits: number;
  /** Nodes whose in-edges are unknown (`parentsState === 'unrecorded'`). */
  commitsWithUnrecordedParents: number;
  /** Nodes with contradictory claims. */
  commitsWithConflictingParents: number;
  /** Nodes with a recorded empty parent list — root-or-truncated, per S15. */
  recordedRoots: number;
  /**
   * `git.event`s carrying no sha at all. Ordinary, not a defect: a
   * `state_change` with an unreadable HEAD records that something happened
   * without naming a commit.
   */
  gitEventsWithoutSha: number;
};

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/** The assembled observed commit DAG. Produced by {@link buildObservedDag}. */
export type ObservedDag = {
  repositoryScope: RepositoryScope;
  /** Every node, keyed by {@link commitNodeKey}, in first-mention order. */
  nodes: ReadonlyMap<string, CommitNode>;
  /** Every commit observation in the scope, in `(sessionId, seq)` order. */
  observations: readonly CommitObservation[];
  /** Everything contradictory, in a deterministic order. */
  defects: readonly ObservedDagDefect[];
  coverage: ObservedDagCoverage;
};

/**
 * The minimum this module needs. `Bundle` satisfies it structurally, so callers
 * pass a bundle; tests can pass a hand-built pair of sessions without a ZIP.
 */
export type ObservedDagSource = {
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly events: readonly HashedEnvelope[];
  }[];
};

/**
 * Node identity: `(repository, sha)`, never sha alone (spec §5.2, S14(b)).
 *
 * The separator is a space, which cannot appear in a sha and does not appear in
 * the sentinel repository key.
 */
export function commitNodeKey(repository: RepositoryKey, sha: string): string {
  return `${repository} ${sha}`;
}

// ---------------------------------------------------------------------------
// Payload reading — defensive, because a .slog is untrusted input
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The sha a `git.event` names, verbatim.
 *
 * `sha` wins; `commit_sha` is the deprecated 1.x spelling of the same thing and
 * is still emitted by 2.0 writers, so a 1.x bundle yields nodes with no edges
 * rather than no nodes at all.
 *
 * Deliberately no normalization: no case folding, no abbreviation expansion, no
 * length check. Folding case could merge two strings that are not the same
 * recorded value; expanding an abbreviation could merge two distinct commits.
 * Either would corrupt the ordering the whole programme rests on, so the sha is
 * treated as an opaque identifier and compared exactly.
 */
function readSha(payload: Record<string, unknown>): string | null {
  return nonEmptyString(payload['sha']) ?? nonEmptyString(payload['commit_sha']);
}

type ParentsRead =
  | { ok: true; parents: readonly string[] | null }
  | { ok: false; reason: 'not_an_array' | 'non_string_entry' };

/**
 * Reads `parents`, keeping ABSENT and EMPTY apart.
 *
 * Absent (or `null`) → `{ parents: null }` — unknown. Present and an array of
 * strings → the recorded order, possibly empty. Present but malformed → a
 * defect, and the in-edges stay unknown: a garbled field must not silently
 * become "no parents", which would fabricate a root.
 */
function readParents(payload: Record<string, unknown>): ParentsRead {
  const raw = payload['parents'];
  if (raw === undefined || raw === null) return { ok: true, parents: null };
  if (!Array.isArray(raw)) return { ok: false, reason: 'not_an_array' };
  for (const entry of raw) {
    if (typeof entry !== 'string') return { ok: false, reason: 'non_string_entry' };
  }
  return { ok: true, parents: raw as readonly string[] };
}

/** Element-wise and order-sensitive. `[a,b]` and `[b,a]` are DIFFERENT claims. */
function sameParents(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** `(sessionId, seq)` — the spec's clock-free tiebreak (§5.2). Never wall. */
function byChainPosition(a: CommitObservation, b: CommitObservation): number {
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  return a.seq - b.seq;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

type MutableNode = {
  repository: RepositoryKey;
  sha: string;
  observations: CommitObservation[];
  claims: Array<{ parents: readonly string[]; observations: ObservationRef[] }>;
  children: string[];
};

/**
 * Assembles every `git.event` across every session into one observed commit DAG.
 *
 * Pure and deterministic: no wall clock in any decision, no randomness, and
 * every iteration is over an explicitly ordered structure — so two runs over the
 * same bundle produce identical output, which is what the ingest-retry contract
 * requires.
 */
export function buildObservedDag(source: ObservedDagSource): ObservedDag {
  const observations: CommitObservation[] = [];
  const defects: ObservedDagDefect[] = [];
  const observingSessions = new Set<string>();
  let gitEventsWithoutSha = 0;
  let discriminatorRecorded = false;

  for (const session of source.sessions) {
    for (const envelope of session.events) {
      if (envelope.kind !== 'git.event') continue;
      const payload = asRecord(envelope.data);
      if (payload === null) {
        gitEventsWithoutSha += 1;
        continue;
      }
      const sha = readSha(payload);
      if (sha === null) {
        // A git.event with no readable sha is ordinary, not a defect: the editor
        // reported a repository state change it could not resolve to a commit.
        gitEventsWithoutSha += 1;
        continue;
      }

      const discriminator = readRepositoryDiscriminator(payload);
      if (discriminator !== null) discriminatorRecorded = true;
      const repository = discriminator ?? ASSUMED_SINGLE_REPOSITORY;

      const parentsRead = readParents(payload);
      if (!parentsRead.ok) {
        defects.push({
          kind: 'unreadable_parents',
          repository,
          sha,
          sessionId: session.sessionId,
          seq: envelope.seq,
          reason: parentsRead.reason,
        });
      }

      observations.push({
        repository,
        sha,
        sessionId: session.sessionId,
        seq: envelope.seq,
        wall: envelope.wall,
        operation: typeof payload['operation'] === 'string' ? payload['operation'] : '',
        branch: nonEmptyString(payload['branch']),
        parents: parentsRead.ok ? parentsRead.parents : null,
      });
      observingSessions.add(session.sessionId);
    }
  }

  // Clock-free and deterministic. Bundle session order is wall-derived and is
  // therefore not trusted as an ordering input.
  observations.sort(byChainPosition);

  const draft = new Map<string, MutableNode>();
  const repositories: RepositoryKey[] = [];

  const ensureNode = (repository: RepositoryKey, sha: string): MutableNode => {
    const key = commitNodeKey(repository, sha);
    let node = draft.get(key);
    if (node === undefined) {
      node = { repository, sha, observations: [], claims: [], children: [] };
      draft.set(key, node);
      if (!repositories.includes(repository)) repositories.push(repository);
    }
    return node;
  };

  for (const obs of observations) {
    const node = ensureNode(obs.repository, obs.sha);
    node.observations.push(obs);
    const claimed = obs.parents;
    if (claimed === null) continue;
    const ref: ObservationRef = { sessionId: obs.sessionId, seq: obs.seq };
    const existing = node.claims.find((c) => sameParents(c.parents, claimed));
    if (existing !== undefined) existing.observations.push(ref);
    else node.claims.push({ parents: claimed, observations: [ref] });
    // Witnessed-only nodes for parents nobody recorded work at. A blank entry
    // names no commit, so it gets no node — but it stays inside the claim
    // verbatim, because the claim is the evidence.
    for (const parent of claimed) {
      if (parent.length > 0) ensureNode(obs.repository, parent);
    }
  }

  // Phase 1 — resolve each node's in-edges. A conflict is a defect and, crucially,
  // yields NO edges: an in-edge we cannot stand behind is an ordering we cannot
  // stand behind.
  const resolved = new Map<string, { state: ParentsState; parents: readonly string[] | null }>();
  for (const [key, node] of draft) {
    if (node.claims.length === 0) {
      resolved.set(key, { state: 'unrecorded', parents: null });
    } else if (node.claims.length === 1) {
      resolved.set(key, { state: 'recorded', parents: node.claims[0]!.parents });
    } else {
      resolved.set(key, { state: 'conflicting', parents: null });
      defects.push({
        kind: 'conflicting_parents',
        repository: node.repository,
        sha: node.sha,
        claims: node.claims.map((c) => ({ parents: c.parents, observations: c.observations })),
      });
    }
  }

  // Phase 2 — out-edges, derived from AGREED parents only.
  for (const [key, node] of draft) {
    const parents = resolved.get(key)!.parents;
    if (parents === null) continue;
    for (const parent of parents) {
      if (parent.length === 0) continue;
      const parentDraft = draft.get(commitNodeKey(node.repository, parent));
      if (parentDraft === undefined) continue;
      if (!parentDraft.children.includes(node.sha)) parentDraft.children.push(node.sha);
    }
  }

  // Phase 3 — freeze.
  const nodes = new Map<string, CommitNode>();
  for (const [key, node] of draft) {
    const { state, parents } = resolved.get(key)!;
    nodes.set(key, {
      repository: node.repository,
      sha: node.sha,
      presence: node.observations.length > 0 ? 'observed' : 'witnessed_only',
      observations: node.observations,
      parentsState: state,
      parents,
      parentsClaims: node.claims.map((c) => ({ parents: c.parents, observations: c.observations })),
      children: node.children,
      recordedRoot: state === 'recorded' && parents !== null && parents.length === 0,
    });
  }

  for (const cycle of findCycles(nodes)) defects.push(cycle);

  const coverage: ObservedDagCoverage = {
    sessionsObserving: observingSessions.size,
    observations: observations.length,
    commits: nodes.size,
    observedCommits: 0,
    witnessedOnlyCommits: 0,
    commitsWithUnrecordedParents: 0,
    commitsWithConflictingParents: 0,
    recordedRoots: 0,
    gitEventsWithoutSha,
  };
  for (const node of nodes.values()) {
    if (node.presence === 'observed') coverage.observedCommits += 1;
    else coverage.witnessedOnlyCommits += 1;
    if (node.parentsState === 'unrecorded') coverage.commitsWithUnrecordedParents += 1;
    if (node.parentsState === 'conflicting') coverage.commitsWithConflictingParents += 1;
    if (node.recordedRoot) coverage.recordedRoots += 1;
  }

  return {
    repositoryScope: { kind: 'assumed_single', discriminatorRecorded, repositories },
    nodes,
    observations,
    defects,
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

type CycleDefect = Extract<ObservedDagDefect, { kind: 'cycle' }>;

const WHITE = 0;
const GREY = 1;
const BLACK = 2;

/**
 * Iterative DFS over child→parent edges with an explicit stack and three-colour
 * marking. Iterative rather than recursive so a long lineage cannot overflow the
 * stack, and colour-marked so a forged cycle terminates instead of looping.
 */
function findCycles(nodes: ReadonlyMap<string, CommitNode>): CycleDefect[] {
  const colour = new Map<string, number>();
  for (const key of nodes.keys()) colour.set(key, WHITE);

  const found: CycleDefect[] = [];
  const seen = new Set<string>();

  for (const rootKey of nodes.keys()) {
    if (colour.get(rootKey) !== WHITE) continue;
    const path: string[] = [rootKey];
    const stack: Array<{ key: string; next: number }> = [{ key: rootKey, next: 0 }];
    colour.set(rootKey, GREY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const node = nodes.get(frame.key)!;
      const parents = node.parents ?? [];
      if (frame.next >= parents.length) {
        colour.set(frame.key, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      const parentSha = parents[frame.next]!;
      frame.next += 1;
      if (parentSha.length === 0) continue;
      const parentKey = commitNodeKey(node.repository, parentSha);
      if (!nodes.has(parentKey)) continue;
      const parentColour = colour.get(parentKey);
      if (parentColour === GREY) {
        const start = path.indexOf(parentKey);
        const shas = rotateToSmallest(path.slice(start).map((k) => nodes.get(k)!.sha));
        const fingerprint = `${node.repository} ${shas.join(',')}`;
        if (!seen.has(fingerprint)) {
          seen.add(fingerprint);
          found.push({ kind: 'cycle', repository: node.repository, shas });
        }
        continue;
      }
      if (parentColour === BLACK) continue;
      colour.set(parentKey, GREY);
      path.push(parentKey);
      stack.push({ key: parentKey, next: 0 });
    }
  }
  return found;
}

/** Deterministic cycle reporting: same cycle, same output, whatever the entry point. */
function rotateToSmallest(shas: readonly string[]): string[] {
  let best = 0;
  for (let i = 1; i < shas.length; i += 1) {
    if (shas[i]! < shas[best]!) best = i;
  }
  return [...shas.slice(best), ...shas.slice(0, best)];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** The node for a sha, or `undefined` if nothing in the scope mentioned it. */
export function getCommitNode(
  dag: ObservedDag,
  sha: string,
  repository: RepositoryKey = ASSUMED_SINGLE_REPOSITORY,
): CommitNode | undefined {
  return dag.nodes.get(commitNodeKey(repository, sha));
}

/**
 * Every commit reachable by following AGREED parent edges from `sha`.
 *
 * Cycle-safe: iterative, with a visited set, so a forged cycle terminates. If a
 * cycle makes a commit its own ancestor it appears in its own result — a true
 * statement about the observed edges, and the cycle is already in
 * `dag.defects`.
 */
export function ancestorsOfCommit(
  dag: ObservedDag,
  sha: string,
  repository: RepositoryKey = ASSUMED_SINGLE_REPOSITORY,
): ReadonlySet<string> {
  return traverse(dag, sha, repository, 'parents');
}

/** Every commit reachable by following agreed child edges from `sha`. Cycle-safe. */
export function descendantsOfCommit(
  dag: ObservedDag,
  sha: string,
  repository: RepositoryKey = ASSUMED_SINGLE_REPOSITORY,
): ReadonlySet<string> {
  return traverse(dag, sha, repository, 'children');
}

function traverse(
  dag: ObservedDag,
  sha: string,
  repository: RepositoryKey,
  direction: 'parents' | 'children',
): ReadonlySet<string> {
  const out = new Set<string>();
  const startKey = commitNodeKey(repository, sha);
  const start = dag.nodes.get(startKey);
  if (start === undefined) return out;
  const visited = new Set<string>([startKey]);
  const queue: CommitNode[] = [start];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head]!;
    head += 1;
    const next = direction === 'parents' ? (node.parents ?? []) : node.children;
    for (const nextSha of next) {
      if (nextSha.length === 0) continue;
      out.add(nextSha);
      const key = commitNodeKey(repository, nextSha);
      if (visited.has(key)) continue;
      visited.add(key);
      const nextNode = dag.nodes.get(key);
      if (nextNode !== undefined) queue.push(nextNode);
    }
  }
  return out;
}

/** `ancestor ≺_g descendant`. Strict: absent a cycle, a commit is not its own ancestor. */
export function isCommitAncestor(
  dag: ObservedDag,
  ancestor: string,
  descendant: string,
  repository: RepositoryKey = ASSUMED_SINGLE_REPOSITORY,
): boolean {
  return ancestorsOfCommit(dag, descendant, repository).has(ancestor);
}

/**
 * The answer {@link compareCommits} gives. **There is no total order here and
 * there must never be one.**
 *
 * The three ORDERING answers are `'before'`, `'after'` and `'unordered'`. The
 * other two are not orderings and must not be consumed as one:
 *
 * - `'same'` — the same commit.
 * - `'unknown'` — at least one sha is not in this DAG at all. Nobody recorded it
 *   and nobody witnessed it, so there is no basis for any statement. This is NOT
 *   `'unordered'`, which is a statement about two commits we do know about.
 *
 * `'unordered'` means the observed graph does not order the pair: they are on
 * divergent lineages, or the connecting history was never recorded, and the
 * evidence cannot tell those two apart. **Either way nothing downstream may
 * impose a sequence on them** — presenting them as concurrent is the required
 * behaviour (spec §5.2, §6), and picking one to come first fabricates a fact.
 *
 * A caller must handle all five explicitly. Code shaped `if (r === 'before') …
 * else …` silently treats `'after'`, `'unordered'`, `'same'` and `'unknown'`
 * alike; where a stable list order is needed, the tiebreak is `(sessionId, seq)`,
 * never wall clock and never this function.
 */
export type CommitOrder = 'before' | 'after' | 'unordered' | 'same' | 'unknown';

/**
 * Three-valued ordering over the observed DAG, plus the two non-ordering answers
 * documented on {@link CommitOrder}.
 *
 * `'before'` iff `a` is an ancestor of `b`; `'after'` iff `b` is an ancestor of
 * `a`. If BOTH hold the observations contradict themselves — reachable only
 * through a cycle, which is already reported in `dag.defects` — and the answer is
 * `'unordered'`, because a contradiction is not a licence to pick a side.
 */
export function compareCommits(
  dag: ObservedDag,
  a: string,
  b: string,
  repository: RepositoryKey = ASSUMED_SINGLE_REPOSITORY,
): CommitOrder {
  const nodeA = dag.nodes.get(commitNodeKey(repository, a));
  const nodeB = dag.nodes.get(commitNodeKey(repository, b));
  if (nodeA === undefined || nodeB === undefined) return 'unknown';
  if (a === b) return 'same';
  const aBeforeB = ancestorsOfCommit(dag, b, repository).has(a);
  const bBeforeA = ancestorsOfCommit(dag, a, repository).has(b);
  if (aBeforeB && bBeforeA) return 'unordered';
  if (aBeforeB) return 'before';
  if (bBeforeA) return 'after';
  return 'unordered';
}

/** Commits some session named directly — the spec's "observed HEAD"s. */
export function observedCommits(dag: ObservedDag): readonly CommitNode[] {
  return [...dag.nodes.values()].filter((n) => n.presence === 'observed');
}

/**
 * Commits known only from another commit's `parents`. Proof a commit existed with
 * no session recording work at it — a partner's commit, or history from before
 * recording began. Evidence about coverage, never of wrongdoing.
 */
export function witnessedOnlyCommits(dag: ObservedDag): readonly CommitNode[] {
  return [...dag.nodes.values()].filter((n) => n.presence === 'witnessed_only');
}

/** The cycle defects, if any. Non-empty means the observations contradict themselves. */
export function dagCycles(dag: ObservedDag): readonly CycleDefect[] {
  return dag.defects.filter((d): d is CycleDefect => d.kind === 'cycle');
}

/**
 * The sessions that observed a commit, deduplicated, in `(sessionId, seq)` order.
 *
 * The join point for attribution: each id goes through Tier 1.1's
 * `contributorOf(bundle, sessionId)`. This module never touches identity itself.
 */
export function sessionsObservingCommit(node: CommitNode): readonly string[] {
  const out: string[] = [];
  for (const obs of node.observations) {
    if (!out.includes(obs.sessionId)) out.push(obs.sessionId);
  }
  return out;
}
