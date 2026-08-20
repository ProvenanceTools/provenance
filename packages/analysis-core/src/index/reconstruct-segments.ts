/**
 * Segment-based file reconstruction — Tier 2.2 of
 * `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` (§5.3, §6).
 *
 * ## The fabrication this removes
 *
 * `reconstructFile` replays ONE linear stream: `index.byFile.get(path)`, ordered
 * by `globalIdx`, which is wall-derived. With two partners editing one file on
 * divergent branches, that stream interleaves two machines' clocks and produces
 * a content string **that never existed on anyone's disk** — and then hands it
 * to a grader as fact. Two clocks are worth nothing relative to each other
 * (spec S16, L3), so the interleaving is not merely imprecise, it is invented.
 *
 * This module replays over `≺` (`order/happens-before.ts`) instead, and answers
 * with three states rather than always producing a string:
 *
 *  - **`determinate`** — `≺` orders the relevant history into a chain. Exactly
 *    one content is possible. This is today's answer, and for a single
 *    contributor it is today's answer BYTE FOR BYTE (see "The solo guarantee").
 *  - **`concurrent`** — two or more contributors' edits are genuinely unordered
 *    at the cut. There is no single truth. Every live branch is returned; none
 *    is chosen, and they are never merged into a synthetic string.
 *  - **`unknown`** — the relation itself cannot speak, because a relevant event
 *    is not in the ordering's scope.
 *
 * `concurrent` and `unknown` are DIFFERENT FACTS and collapsing them is a bug
 * the test suite catches. "Two recorded branches raced" and "we have no record"
 * lead a grader to opposite conclusions. This is the same discipline Tier 1.1
 * applied to `unverifiable` vs `unattributed` and Tier 1.2 to `unordered` vs
 * `unknown`.
 *
 * ## The solo guarantee — why every existing course is safe
 *
 * A file whose events do not span two PROVABLY DIFFERENT contributors does not
 * take the segmented path at all. {@link reconstructFileSegmented} short-
 * circuits to `reconstructFile(index, path, cut)` — the same function, the same
 * arguments, the same memo — so the result is identical by construction rather
 * than by careful reimplementation. There is no second replay to drift.
 *
 * "Provably different" means {@link compareContributors} answers `'different'`,
 * which requires BOTH sides to be `attributed`, i.e. both enrolment chains
 * verified against the course-signed root. Consequences, all deliberate:
 *
 *  - One session, or N sessions of one student → solo path.
 *  - A bundle with no identity at all (every session `unattributed`) → solo
 *    path. `compareContributors` answers `'unknown'`, never `'different'`.
 *  - A forged identity block (`unverifiable`) cannot manufacture a second
 *    contributor and thereby talk a file into `concurrent` — that would be a
 *    student-controllable way to make reconstruction refuse to answer, i.e. a
 *    free evasion. The gate is inside the course-signed payload (spec §6, final
 *    negative rule: a solo submission takes the identical path it takes today).
 *  - Two partners editing DIFFERENT files → each file sees one contributor →
 *    both files take the solo path and both are `determinate`.
 *
 * ## Segments, and why they are the right atom
 *
 * A **segment** is a maximal run of one session's events on one path between
 * two `git.event` observations. That boundary is not arbitrary: it is exactly
 * the granularity at which `≺` stops being able to tell two events apart.
 *
 * `happens-before.ts` factors every cross-session path through "doors" — an
 * event's exit is the first observation at or after its `seq`, its entrance the
 * last observation at or before it. Two events of one session with no
 * observation between them therefore share both doors, so for EVERY event `f`
 * outside the session, `compareEvents(e₁, f) === compareEvents(e₂, f)`. A
 * segment is precisely an equivalence class of that relation, which is what
 * makes "compare two segments by comparing one representative event" sound
 * rather than a sampling heuristic.
 *
 * It also bounds the cost: the segment count is (sessions + `git.event`s), never
 * proportional to keystrokes. See "Cost".
 *
 * ## Anchors, and why `concurrent` does not swallow the whole timeline
 *
 * A segment containing an **anchor** — a `doc.open` carrying inline `content`,
 * or an `fs.external_change` carrying `new_content` — is ground truth read off
 * a disk. The replay reseeds from it and discards everything before, so an
 * anchor makes a segment's predecessors irrelevant to its output bytes.
 *
 * That is what closes a divergence. After a merge commit, the first disk
 * observation any contributor makes for the path re-anchors, the sibling
 * branches die, and a single lineage resumes (spec §5.3). So `concurrent` lasts
 * from the branch point to the first post-merge observation — not forever.
 *
 * ## Cost
 *
 * Solo files: one extra pass over the file's events to count distinct
 * contributors, then the existing memoized `reconstructFile`. No DAG, no
 * ordering, no graph — {@link buildReconstructionScope} does not even build the
 * relation unless the bundle has two different contributors.
 *
 * Multi-contributor files: O(N) to bucket events into segments, then O(S²)
 * segment comparisons where S is bounded by sessions + `git.event`s (tens), and
 * one replay per surviving lineage. **No pass is quadratic in event count** —
 * which matters because heuristics are already O(N²) and ingest is CPU-bound.
 */

import type { EventKind } from '@provenance/log-core';
import { buildObservedDag } from '../git/observed-dag.js';
import { contributorOf } from '../identity/resolve-contributors.js';
import { compareContributors, type SessionContributor } from '../identity/types.js';
import type { Bundle } from '../loader/types.js';
import {
  buildEventOrdering,
  compareEvents,
  type EventOrdering,
  type EventRef,
} from '../order/happens-before.js';
import type { EventIndex, IndexedEvent } from './event-index.js';
import { reconstructFile, type ReconstructResult } from './reconstruct-file.js';
import {
  reconstructFileWithProvenance,
  type FileReplayState,
} from './reconstruct-file-provenance.js';

// ---------------------------------------------------------------------------
// The three-state result
// ---------------------------------------------------------------------------

/** Why a `determinate` answer was reachable. Display and test evidence. */
export type DeterminateBasis =
  /** The file's events span at most one session. The overwhelmingly common case. */
  | 'single_session'
  /**
   * More than one session, but no pair of them belongs to provably different
   * contributors — so there is no cross-contributor divergence to represent and
   * the file takes the untouched linear path.
   */
  | 'single_contributor'
  /** Two or more contributors, and `≺` orders their segments into a chain. */
  | 'ordered_by_happens_before'
  /**
   * Two or more contributors diverged, but an anchor (a post-merge disk
   * observation) re-seeded the file and closed the divergence.
   */
  | 'reanchored_after_merge';

/** Why the relation could not speak. Never conflated with `concurrent`. */
export type UnknownReason =
  /**
   * `compareEvents` answered `'unknown'` — a relevant event is not in the
   * ordering's scope, so there is no basis for any statement about it.
   */
  'event_outside_ordering';

/** One live, unordered lineage at the cut. Never to be silently preferred. */
export type ReconstructionBranch<T> = {
  /**
   * The contributor whose lineage this is — {@link Contributor.key}. For an
   * `unattributed` or `unverifiable` session this is a per-session singleton,
   * so a branch is never labelled with a person the evidence does not name.
   */
  contributorKey: string;
  contributor: SessionContributor;
  /** The last event of this branch's tip segment. */
  tip: EventRef;
  /** The replay of this lineage alone. */
  value: T;
  /**
   * `true` when this branch's OWN history is itself not fully ordered, so even
   * the branch content is a best-effort linearization. A caller showing a
   * branch must say so.
   */
  ambiguousAncestry: boolean;
};

export type DivergenceReport = {
  /**
   * Contributor keys with a live branch at the cut, sorted. Two or more, always
   * — one is `determinate` by definition.
   */
  contributorKeys: readonly string[];
  /** Human-readable statement of what is unordered and what would resolve it. */
  detail: string;
};

/**
 * The answer. **A caller must handle all three arms.**
 *
 * There is deliberately no `content` accessor on the union and no default
 * branch selection anywhere in this module. Code shaped
 * `result.branches[0].value` is the exact fabrication Tier 2.2 exists to
 * remove; {@link determinateValue} is the only sanctioned narrowing and it
 * returns `null` rather than guessing.
 */
export type SegmentedResult<T> =
  | { kind: 'determinate'; value: T; basis: DeterminateBasis }
  | {
      kind: 'concurrent';
      branches: readonly ReconstructionBranch<T>[];
      divergence: DivergenceReport;
    }
  | { kind: 'unknown'; reason: UnknownReason; detail: string };

/**
 * The ONLY sanctioned way to get one value out of a {@link SegmentedResult}.
 *
 * Returns `null` for `concurrent` and for `unknown`, which forces every caller
 * to write the handling down. It deliberately does not take a fallback
 * argument: a default parameter is how "just use the first branch" gets written
 * without anybody noticing it in review.
 */
export function determinateValue<T>(result: SegmentedResult<T>): T | null {
  return result.kind === 'determinate' ? result.value : null;
}

/**
 * A short, grader-readable statement of why there is no single content.
 * `null` when there is one. For UI copy and flag detail strings.
 */
export function describeAmbiguity<T>(result: SegmentedResult<T>): string | null {
  if (result.kind === 'determinate') return null;
  if (result.kind === 'unknown') return result.detail;
  return result.divergence.detail;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Everything reconstruction needs beyond an {@link EventIndex}: who each session
 * belongs to, and the happens-before relation over the same scope.
 *
 * `ordering` is `null` for a scope that cannot diverge (fewer than two provably
 * different contributors). That is not a missing value to be filled in later —
 * it is the statement that the relation would change no answer here, and it is
 * what keeps a solo bundle from paying for a graph nobody reads.
 */
export type ReconstructionScope = {
  readonly index: EventIndex;
  readonly contributorBySession: ReadonlyMap<string, SessionContributor>;
  readonly ordering: EventOrdering | null;
};

/**
 * Build a scope from a loaded bundle and its index.
 *
 * Cheap by design: the contributor stamp is read first, and the observed DAG and
 * `≺` are built ONLY when the bundle actually contains two provably different
 * contributors. A solo bundle — every existing course — pays one map lookup per
 * session and nothing else.
 *
 * An unstamped bundle (no `establishBundleContributors` run) reads as fully
 * `unattributed` via {@link contributorOf}, which yields no `'different'` pair
 * and therefore the solo path. That fails toward today's behaviour, not toward
 * a refusal to answer.
 */
export function buildReconstructionScope(bundle: Bundle, index: EventIndex): ReconstructionScope {
  const contributorBySession = new Map<string, SessionContributor>();
  for (const session of bundle.sessions) {
    contributorBySession.set(session.sessionId, contributorOf(bundle, session.sessionId));
  }

  if (!hasTwoDifferentContributors([...contributorBySession.values()])) {
    return { index, contributorBySession, ordering: null };
  }

  const dag = buildObservedDag(bundle);
  const ordering = buildEventOrdering({ source: bundle, dag, contributors: contributorBySession });
  return { index, contributorBySession, ordering };
}

/**
 * Per-`EventIndex` memo of {@link buildReconstructionScope}.
 *
 * Every heuristic that reconstructs needs the same scope for the same index, and
 * building the observed DAG plus the reachability closure once per heuristic
 * would be a real regression on an ingest path that is already CPU-bound. Keyed
 * weakly on the index, exactly like the reconstruction memos next door, so it is
 * released with it.
 *
 * For a solo bundle the memoized value is the `ordering: null` scope, so the
 * saving is the contributor scan rather than a graph — there is no graph.
 */
const scopeCache = new WeakMap<EventIndex, ReconstructionScope>();

/** {@link buildReconstructionScope}, memoized per index. The accessor callers should use. */
export function reconstructionScopeFor(bundle: Bundle, index: EventIndex): ReconstructionScope {
  let scope = scopeCache.get(index);
  if (scope === undefined) {
    scope = buildReconstructionScope(bundle, index);
    scopeCache.set(index, scope);
  }
  return scope;
}

/**
 * A scope for an index with no bundle behind it — hand-built test indexes, and
 * `buildIndexFromEventRows`. Always solo, so always today's exact behaviour.
 */
export function soloReconstructionScope(index: EventIndex): ReconstructionScope {
  return { index, contributorBySession: new Map(), ordering: null };
}

/** Is there a pair among these that `compareContributors` calls `'different'`? */
function hasTwoDifferentContributors(contributors: readonly SessionContributor[]): boolean {
  // `'different'` requires both sides attributed, so only attributed sessions
  // can produce one — comparing distinct attributed contributor keys is exactly
  // equivalent and is O(n) rather than O(n²).
  const keys = new Set<string>();
  for (const c of contributors) {
    if (c.kind !== 'attributed') continue;
    keys.add(c.contributorKey);
    if (keys.size > 1) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Reconstruct a file's content over `≺`.
 *
 * `upToGlobalIdx` is exclusive and keeps its exact existing meaning — it is a
 * cut over the index's own dense numbering, NOT a re-keyed order. `globalIdx`
 * is persisted as `flags.supporting_seqs`; Tier 2.1 deliberately did not re-key
 * it and this module does not either.
 */
export function reconstructFileSegmented(
  scope: ReconstructionScope,
  filePath: string,
  upToGlobalIdx?: number,
): SegmentedResult<ReconstructResult> {
  return resolve(scope, filePath, upToGlobalIdx, (index, path) => reconstructFile(index, path));
}

/**
 * Reconstruct a file's content and per-character provenance over `≺`.
 *
 * The provenance variant of {@link reconstructFileSegmented}, with the identical
 * three-state contract. Per-character attribution is `globalIdx`-keyed exactly
 * as today; the contributor axis on provenance is Tier 2.3, not this change.
 */
export function reconstructFileSegmentedWithProvenance(
  scope: ReconstructionScope,
  filePath: string,
  upToGlobalIdx?: number,
): SegmentedResult<FileReplayState> {
  return resolve(scope, filePath, upToGlobalIdx, (index, path) =>
    reconstructFileWithProvenance(index, path),
  );
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Replays an already-ordered event list for one path. */
type Replay<T> = (index: EventIndex, filePath: string) => T;

function resolve<T>(
  scope: ReconstructionScope,
  filePath: string,
  upToGlobalIdx: number | undefined,
  replay: Replay<T>,
): SegmentedResult<T> {
  const { index, ordering, contributorBySession } = scope;

  // ---- The solo short-circuit. -------------------------------------------
  //
  // Delegating to the untouched entry point — same function, same memo — is why
  // "byte-for-byte unaffected" is a property of the code rather than a claim
  // about it. Note this runs BEFORE any segmenting, so a solo file never even
  // allocates a segment.
  const fileEvents = index.byFile.get(filePath) ?? [];
  const cutEvents = cutBefore(fileEvents, upToGlobalIdx);
  // One allocation-free pass answering both questions. Worth the slightly
  // awkward shape: this runs for EVERY file of EVERY bundle, including the solo
  // ones that must not pay for a feature they cannot use, and the obvious
  // `new Set(events.map(e => e.sessionId))` allocates a second array the size of
  // the event stream to do it.
  const survey = surveySessions(cutEvents, contributorBySession);
  if (ordering === null || !survey.spansTwoContributors) {
    return {
      kind: 'determinate',
      value: replayLinear(index, filePath, upToGlobalIdx, replay),
      basis: survey.multipleSessions ? 'single_contributor' : 'single_session',
    };
  }

  // ---- The segmented path. ------------------------------------------------
  const segments = buildSegments(index, cutEvents);
  const relation = new SegmentRelation(ordering, segments);
  if (relation.sawUnknown) {
    return {
      kind: 'unknown',
      reason: 'event_outside_ordering',
      detail:
        `Reconstruction of ${filePath} spans events the happens-before relation does not ` +
        `cover, so no statement can be made about their order. This is not a claim that the ` +
        `edits raced — it is the absence of a record. Rebuilding the ordering over the same ` +
        `scope as the index would resolve it.`,
    };
  }

  const maximal = relation.maximalSegments();

  // Everything reachable backwards from the live tips, stopping at anchors —
  // a segment that reseeds from disk makes its own history irrelevant to its
  // output bytes, which is what lets a merge close a divergence (§5.3).
  const live = relation.ancestorClosureStoppingAtAnchors(maximal);
  const conflict = relation.findCrossContributorConcurrency(live, contributorBySession);

  if (conflict === null) {
    const anchored = maximal.length === 1 && maximal[0]!.hasAnchor && live.length === 1;
    return {
      kind: 'determinate',
      value: replaySegments(index, filePath, relation.topologicalOrder(live), replay),
      basis: anchored ? 'reanchored_after_merge' : 'ordered_by_happens_before',
    };
  }

  // ---- Genuinely concurrent. ----------------------------------------------
  //
  // One branch per live tip. No branch is preferred, no two branches are
  // concatenated, and nothing here consults a wall clock to break the tie —
  // there is no tie to break.
  const branches: ReconstructionBranch<T>[] = [];
  for (const tip of maximal) {
    const lineage = relation.ancestorClosureStoppingAtAnchors([tip]);
    const contributor = contributorFor(tip, contributorBySession);
    branches.push({
      contributorKey: contributorKeyOf(contributor, tip.sessionId),
      contributor,
      tip: { sessionId: tip.sessionId, seq: tip.lastSeq },
      value: replaySegments(index, filePath, relation.topologicalOrder(lineage), replay),
      ambiguousAncestry:
        relation.findCrossContributorConcurrency(lineage, contributorBySession) !== null,
    });
  }
  branches.sort((a, b) => compareBranches(a, b));

  const contributorKeys = [...new Set(branches.map((b) => b.contributorKey))].sort();
  return {
    kind: 'concurrent',
    branches,
    divergence: {
      contributorKeys,
      detail:
        `${branches.length} lineage(s) of ${filePath} across ${contributorKeys.length} ` +
        `contributor(s) are live and unordered at this point: the recorded evidence — hash ` +
        `chains, session links and the observed commit DAG — does not establish which came ` +
        `first, and the two machines' clocks are not evidence. No single content existed. A ` +
        `merge commit followed by any disk observation of this file would resolve it.`,
    },
  };
}

/** `reconstructFile` / `reconstructFileWithProvenance`, untouched, with the memo intact. */
function replayLinear<T>(
  index: EventIndex,
  filePath: string,
  upToGlobalIdx: number | undefined,
  replay: Replay<T>,
): T {
  if (upToGlobalIdx === undefined) return replay(index, filePath);
  // The cut is honoured through a view rather than by passing `upToGlobalIdx`
  // so that exactly one code path exists for "replay these events".
  const cut = cutBefore(index.byFile.get(filePath) ?? [], upToGlobalIdx);
  return replay(viewIndex(index, filePath, cut), filePath);
}

/**
 * Replay an explicitly ordered event list.
 *
 * The list is handed to the untouched replay through a shallow VIEW of the index
 * whose `byFile` holds just this path's chosen events, in the chosen order. Both
 * replays read `index.byFile.get(path)` and nothing else positional, so the view
 * is a complete substitution — and, importantly, this means the segmented path
 * and the linear path run the SAME reconstruction code. There is no second
 * implementation of the event-dispatch switch to drift out of lockstep.
 *
 * `selfInflictedExternalChanges` and `pathAliases` are carried across by the
 * spread, so external-change suppression (D1) still agrees with the index.
 */
function replaySegments<T>(
  index: EventIndex,
  filePath: string,
  events: readonly IndexedEvent[],
  replay: Replay<T>,
): T {
  return replay(viewIndex(index, filePath, events), filePath);
}

function viewIndex(
  index: EventIndex,
  filePath: string,
  events: readonly IndexedEvent[],
): EventIndex {
  return { ...index, byFile: new Map([[filePath, [...events]]]) };
}

function cutBefore(
  events: readonly IndexedEvent[],
  upToGlobalIdx: number | undefined,
): readonly IndexedEvent[] {
  if (upToGlobalIdx === undefined) return events;
  return events.filter((e) => e.globalIdx < upToGlobalIdx);
}

type SessionSurvey = {
  /** Does the file's event stream touch more than one session? */
  multipleSessions: boolean;
  /** Do two of those sessions belong to provably different contributors? */
  spansTwoContributors: boolean;
};

/**
 * One pass, no allocation until a second session actually appears, and an early
 * exit the moment the answer can no longer change.
 *
 * The single-session case — the overwhelming majority of files in every bundle —
 * costs one string compare per event and allocates nothing at all.
 */
function surveySessions(
  events: readonly IndexedEvent[],
  contributorBySession: ReadonlyMap<string, SessionContributor>,
): SessionSurvey {
  let firstSession: string | undefined;
  let sessions: Set<string> | undefined;
  for (const event of events) {
    if (firstSession === undefined) {
      firstSession = event.sessionId;
      continue;
    }
    if (event.sessionId === firstSession) continue;
    if (sessions === undefined) sessions = new Set([firstSession]);
    sessions.add(event.sessionId);
  }
  if (sessions === undefined) return { multipleSessions: false, spansTwoContributors: false };

  const keys = new Set<string>();
  for (const sessionId of sessions) {
    const contributor = contributorBySession.get(sessionId);
    if (contributor === undefined || contributor.kind !== 'attributed') continue;
    keys.add(contributor.contributorKey);
    if (keys.size > 1) return { multipleSessions: true, spansTwoContributors: true };
  }
  return { multipleSessions: true, spansTwoContributors: false };
}

function contributorFor(
  segment: Segment,
  contributorBySession: ReadonlyMap<string, SessionContributor>,
): SessionContributor {
  return (
    contributorBySession.get(segment.sessionId) ?? {
      kind: 'unattributed',
      sessionId: segment.sessionId,
      contributorKey: `unattributed:${segment.sessionId}`,
    }
  );
}

function contributorKeyOf(contributor: SessionContributor, sessionId: string): string {
  return contributor.contributorKey || `unattributed:${sessionId}`;
}

function compareBranches<T>(a: ReconstructionBranch<T>, b: ReconstructionBranch<T>): number {
  if (a.contributorKey !== b.contributorKey) return a.contributorKey < b.contributorKey ? -1 : 1;
  if (a.tip.sessionId !== b.tip.sessionId) return a.tip.sessionId < b.tip.sessionId ? -1 : 1;
  return a.tip.seq - b.tip.seq;
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/**
 * A maximal run of one session's events on one path between two `git.event`
 * observations — an equivalence class of `≺` (see the module header), so every
 * event in it answers identically against every event outside the session.
 */
type Segment = {
  sessionId: string;
  /** How many of this session's `git.event`s precede the segment. The window id. */
  window: number;
  events: IndexedEvent[];
  firstSeq: number;
  lastSeq: number;
  /** Lowest `globalIdx` in the segment — the presentation tiebreak, never evidence. */
  minGlobalIdx: number;
  /**
   * Does the segment reseed from a disk observation? A `doc.open` with inline
   * `content` or an `fs.external_change` with `new_content`. Such a segment
   * discards its inherited content, so its predecessors cannot change its output
   * bytes — which is how a post-merge observation closes a divergence (§5.3).
   */
  hasAnchor: boolean;
};

/**
 * Partition a path's events into segments.
 *
 * Boundaries come from `git.event` seqs read off `index.byKind` — the same
 * observations Tier 1.2 keys the DAG on, and public API rather than the
 * ordering's `_internal`. A `git.event` is never itself a file event, so no
 * file-event seq can coincide with a boundary and the windows are unambiguous.
 */
function buildSegments(index: EventIndex, events: readonly IndexedEvent[]): Segment[] {
  const boundaries = gitObservationSeqsBySession(index);
  const bySegment = new Map<string, Segment>();

  for (const event of events) {
    const seqs = boundaries.get(event.sessionId) ?? [];
    const window = countBelow(seqs, event.seq);
    const key = `${event.sessionId} ${window}`;
    let segment = bySegment.get(key);
    if (segment === undefined) {
      segment = {
        sessionId: event.sessionId,
        window,
        events: [],
        firstSeq: event.seq,
        lastSeq: event.seq,
        minGlobalIdx: event.globalIdx,
        hasAnchor: false,
      };
      bySegment.set(key, segment);
    }
    segment.events.push(event);
    if (event.seq < segment.firstSeq) segment.firstSeq = event.seq;
    if (event.seq > segment.lastSeq) segment.lastSeq = event.seq;
    if (event.globalIdx < segment.minGlobalIdx) segment.minGlobalIdx = event.globalIdx;
    if (isAnchor(event)) segment.hasAnchor = true;
  }

  const segments = [...bySegment.values()];
  for (const segment of segments) {
    // L0 — the hash chain is the total order inside a session, and it is the
    // strongest evidence in the system. Sorting on `seq` rather than trusting
    // the index's wall-derived arrival order is the whole point.
    segment.events.sort((a, b) => a.seq - b.seq);
  }
  // Deterministic, clock-free construction order.
  segments.sort((a, b) =>
    a.sessionId !== b.sessionId ? (a.sessionId < b.sessionId ? -1 : 1) : a.window - b.window,
  );
  return segments;
}

function gitObservationSeqsBySession(index: EventIndex): ReadonlyMap<string, number[]> {
  const out = new Map<string, number[]>();
  for (const event of index.byKind.get('git.event' satisfies EventKind) ?? []) {
    let seqs = out.get(event.sessionId);
    if (seqs === undefined) {
      seqs = [];
      out.set(event.sessionId, seqs);
    }
    seqs.push(event.seq);
  }
  for (const seqs of out.values()) seqs.sort((a, b) => a - b);
  return out;
}

/**
 * An anchor is a disk observation that is ground truth rather than a derived
 * state — the two kinds the replay already treats as re-seeding
 * (`reconstruct-file.ts`: `doc.open` with inline content clears taint;
 * `fs.external_change` with `new_content` reseeds).
 */
function isAnchor(event: IndexedEvent): boolean {
  const payload = event.payload as Record<string, unknown> | null;
  if (payload === null || typeof payload !== 'object') return false;
  if (event.kind === 'doc.open') return typeof payload['content'] === 'string';
  if (event.kind === 'fs.external_change') return typeof payload['new_content'] === 'string';
  return false;
}

/** Count of sorted values strictly below `target`. */
function countBelow(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// The segment relation
// ---------------------------------------------------------------------------

/**
 * `≺` lifted from events to segments, computed once.
 *
 * Sound because a segment is an equivalence class of `≺` (module header), so one
 * representative event answers for all of them. `S²` comparisons, `S` bounded by
 * sessions + `git.event`s — never by keystrokes.
 */
class SegmentRelation {
  /** `before[i]` = indices strictly after segment `i`. */
  private readonly after: Set<number>[];
  /** `true` once any pair answered `'unknown'`. */
  readonly sawUnknown: boolean;

  constructor(
    ordering: EventOrdering,
    readonly segments: readonly Segment[],
  ) {
    const n = segments.length;
    this.after = Array.from({ length: n }, () => new Set<number>());
    let unknown = false;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = representative(segments[i]!);
        const b = representative(segments[j]!);
        const order = compareEvents(ordering, a, b);
        if (order === 'before') this.after[i]!.add(j);
        else if (order === 'after') this.after[j]!.add(i);
        else if (order === 'unknown') unknown = true;
        // `'concurrent'` adds no edge — that is the point.
        // `'same'` is unreachable: distinct segments hold distinct events.
      }
    }
    this.sawUnknown = unknown;
  }

  isBefore(i: number, j: number): boolean {
    return this.after[i]!.has(j);
  }

  /** Segments with nothing after them — the live tips at the cut. */
  maximalSegments(): Segment[] {
    const out: Segment[] = [];
    for (let i = 0; i < this.segments.length; i++) {
      if (this.after[i]!.size === 0) out.push(this.segments[i]!);
    }
    return out;
  }

  /**
   * Every segment that can still affect the given tips' bytes.
   *
   * Walks backwards from each tip and STOPS at an anchored segment: a segment
   * that reseeds from disk discards whatever it inherited, so nothing before it
   * on that lineage is reachable in the output. This is the pruning that keeps a
   * post-merge divergence from staying `concurrent` forever.
   */
  ancestorClosureStoppingAtAnchors(tips: readonly Segment[]): Segment[] {
    const index = this.indexOf();
    const keep = new Set<number>();
    const stack: number[] = [];
    for (const tip of tips) stack.push(index.get(tip)!);

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (keep.has(current)) continue;
      keep.add(current);
      if (this.segments[current]!.hasAnchor) continue;
      for (let i = 0; i < this.segments.length; i++) {
        if (i !== current && this.isBefore(i, current) && !keep.has(i)) stack.push(i);
      }
    }
    return [...keep].sort((a, b) => a - b).map((i) => this.segments[i]!);
  }

  /**
   * The first pair in `set` that `≺` leaves unordered AND that belongs to
   * provably different contributors. `null` when the set can be linearized
   * without inventing a cross-contributor ordering.
   *
   * Same-contributor concurrency deliberately does NOT count: two sessions of
   * one student with no link and no commits are unordered under `≺`, and
   * refusing to reconstruct there would break every existing multi-session solo
   * bundle. Their relative order is a presentation choice within one person's
   * own work, not a claim about who did what.
   */
  findCrossContributorConcurrency(
    set: readonly Segment[],
    contributorBySession: ReadonlyMap<string, SessionContributor>,
  ): { a: Segment; b: Segment } | null {
    const index = this.indexOf();
    for (let i = 0; i < set.length; i++) {
      for (let j = i + 1; j < set.length; j++) {
        const a = set[i]!;
        const b = set[j]!;
        const ia = index.get(a)!;
        const ib = index.get(b)!;
        if (this.isBefore(ia, ib) || this.isBefore(ib, ia)) continue;
        const ca = contributorBySession.get(a.sessionId);
        const cb = contributorBySession.get(b.sessionId);
        if (ca === undefined || cb === undefined) continue;
        if (compareContributors(ca, cb) === 'different') return { a, b };
      }
    }
    return null;
  }

  /**
   * A replay order for a set of segments: `≺` where it speaks, `globalIdx` where
   * it does not.
   *
   * Kahn's algorithm, ties broken by `minGlobalIdx`. The tiebreak is reached
   * ONLY for same-contributor concurrency — a cross-contributor pair has already
   * become a `concurrent` result and never gets here — so it never linearizes
   * two people's work, and for one person's work it reproduces the index's own
   * order, which is today's behaviour.
   */
  topologicalOrder(set: readonly Segment[]): IndexedEvent[] {
    const index = this.indexOf();
    const ids = set.map((s) => index.get(s)!);
    const member = new Set(ids);
    const indegree = new Map<number, number>();
    for (const id of ids) {
      let count = 0;
      for (const other of ids) {
        if (other !== id && this.isBefore(other, id)) count++;
      }
      indegree.set(id, count);
    }

    const ready = ids.filter((id) => indegree.get(id) === 0);
    const out: IndexedEvent[] = [];
    const emitted = new Set<number>();
    while (ready.length > 0) {
      ready.sort((a, b) => this.segments[a]!.minGlobalIdx - this.segments[b]!.minGlobalIdx);
      const next = ready.shift()!;
      emitted.add(next);
      out.push(...this.segments[next]!.events);
      for (const id of ids) {
        if (emitted.has(id) || !this.isBefore(next, id)) continue;
        const remaining = (indegree.get(id) ?? 0) - 1;
        indegree.set(id, remaining);
        if (remaining === 0) ready.push(id);
      }
    }
    // A cycle in `≺` is a recorded contradiction, already reported as a
    // `session_chain_cycle` defect by Tier 2.1. Emit the stragglers in
    // `globalIdx` order rather than dropping their events on the floor.
    if (emitted.size < ids.length) {
      const left = ids
        .filter((id) => !emitted.has(id) && member.has(id))
        .sort((a, b) => this.segments[a]!.minGlobalIdx - this.segments[b]!.minGlobalIdx);
      for (const id of left) out.push(...this.segments[id]!.events);
    }
    return out;
  }

  private cachedIndex: Map<Segment, number> | null = null;
  private indexOf(): Map<Segment, number> {
    if (this.cachedIndex === null) {
      this.cachedIndex = new Map(this.segments.map((s, i) => [s, i]));
    }
    return this.cachedIndex;
  }
}

function representative(segment: Segment): EventRef {
  // Any event in the segment answers identically for every event outside the
  // session (module header), so the first is as good as any and is stable.
  return { sessionId: segment.sessionId, seq: segment.firstSeq };
}
