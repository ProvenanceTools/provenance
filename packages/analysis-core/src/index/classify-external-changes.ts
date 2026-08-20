/**
 * External-change reclassification — Tier 3.1 of
 * `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` (§3 S2, §7).
 *
 * ## The problem
 *
 * `fs.external_change` means "this file changed on disk and the recorder did not
 * see the edit". That is a genuine cheating-shaped signal — and it is also
 * exactly what a `git pull` looks like. A student pulling their partner's work,
 * or checking out a branch, rewrites N files through no fault of their own and
 * collects N findings. The census names it the most common false positive in the
 * system (spec §3 S2).
 *
 * The mitigation that shipped before this is the recorder's explanation tagger
 * (`recorder/src/events/explanation-tags.ts`): a time window after a git state
 * change, recorder-side, explicitly labelled a bridge. Timing cannot tell
 * "content git delivered" from "content someone pasted", and a watcher event
 * that lands after the window — or a save-time compare minutes later — is
 * unexplained however wide the window is.
 *
 * ## What this module does instead: classify by CONTENT
 *
 * Each `fs.external_change` is classified by what its post-change bytes ARE, not
 * by when they arrived:
 *
 *  - **`git_merge_in`** — the post-change sha256 equals a sha256 that a
 *    **provably different, verified contributor** recorded in this scope, on the
 *    same path, as a `doc.save.sha256` or a `doc.open.sha256`. That is a
 *    cryptographic statement that the bytes are a partner's recorded work, and
 *    it needs no clock. This is collaboration, not an external edit, and it is
 *    the ONLY class the consuming heuristics skip.
 *
 *  - **`git_unrecorded_in`** — no such match, but a `git.event` that MOVED HEAD
 *    sits within {@link GIT_ADJACENCY_WINDOW_MS} before the change in the same
 *    session's chain. Code entered the working tree from a commit no recorder
 *    observed. **It is not suppressed** — folding it into `git_merge_in`
 *    because both involve git would hide exactly what this system exists to
 *    surface, and (decision D16) the recorder's `explanation: 'git'` tag no
 *    longer suppresses it either: a two-second timing window must not silence a
 *    finding the content test says is real.
 *
 *    It is equally NOT an accusation. The class says the content has no
 *    recorded authorship *in this scope* — which an honest pair whose partner
 *    never enrolled produces just as readily as a paste from elsewhere. The
 *    `detail` sentence states both readings and says what would distinguish
 *    them (whether every collaborator is enrolled and recording), because a
 *    grader must be able to tell them apart or know that the system cannot.
 *
 *  - **`external`** — neither. Today's meaning, preserved exactly.
 *
 *  - **`unclassified`** — the test could not be run soundly, with a reason. See
 *    below; this is NOT a fourth flavour of accusation.
 *
 * ## Three rules this module is built around
 *
 * **R1 — a reclassified event stays visible.** Nothing here removes an event
 * from the index. `byKind`, `byFile` and `ordered` are untouched; the verdict is
 * a side table keyed on `globalIdx`, exactly as `selfInflictedExternalChanges`
 * is. A `git_merge_in` is still in the timeline, still in the Source tab, still
 * countable — it is *described* differently, not deleted. The consumers name the
 * classification in their flag text so the relabelling is legible rather than
 * silent.
 *
 * **R2 — "cannot classify" never becomes the accusatory answer.** Missing DAG
 * data, an unattributed partner, or a change with no post-change hash produce
 * `unclassified` with a stated reason, never `external`. `unclassified` fires
 * every consumer exactly as `external` does — failing toward surfacing evidence
 * — but it says a different thing, and a grader is entitled to the difference.
 * This is the discipline Tier 1.1 applied to `unverifiable` vs `unattributed`.
 *
 * **R3 — a solo bundle is byte-for-byte unaffected.** The pass does not run at
 * all unless the scope is collaborative (see {@link classifyExternalChanges}),
 * and both triggers are course-signed or identity-verified, so neither is
 * student-controllable. A solo bundle gets
 * `applicability: 'scope_not_collaborative'`, an empty verdict map, and
 * therefore the identical flags, counts, severities and descriptions it got
 * before this landed.
 *
 * ## Why git-adjacency is coarse for one class and tight for the other
 *
 * "Git-adjacent" is the one part of this that reads a clock, so it is used with
 * care and only ever the session's OWN monotonic `t` (L0 — never a cross-machine
 * wall clock, spec §5.2 L3).
 *
 *  - For `git_merge_in` the requirement is only that HEAD moved **somewhere
 *    earlier in this session** ({@link headMovedBefore}). Coarse on purpose: a
 *    pull rewrites files the student has not opened, and the resulting external
 *    change can surface minutes later through the save-time compare in
 *    `doc-wiring`. A tight window there would leave the commonest false positive
 *    in place. It is safe to be coarse because the load-bearing condition is the
 *    exact content match against a *provably different verified* contributor —
 *    the timing merely corroborates that a git operation was available to
 *    deliver it.
 *
 *  - For `git_unrecorded_in` the requirement is a HEAD move within
 *    {@link GIT_ADJACENCY_WINDOW_MS}. Tight on purpose: there is no content
 *    evidence here, so the only thing separating "a pull delivered this" from
 *    "the student pasted this outside the editor" is proximity, and calling a
 *    genuine out-of-editor paste "attributable to a git operation" would mislead
 *    a grader. When the window is missed the answer falls back to `external` —
 *    today's answer, and the safe direction.
 *
 * ## What is deliberately NOT a match source
 *
 * Another `fs.external_change`'s `new_hash` is never a match source. Allowing it
 * would let one unrecorded external write explain a later one, which is a
 * laundering path: paste content in once with no recording, and every subsequent
 * arrival of the same bytes explains itself. Only content a session recorded
 * through the editor (`doc.save`, `doc.open`) counts.
 *
 * Likewise the match must come from a contributor `compareContributors` calls
 * `'different'`. A match against the SAME contributor's other session, or
 * against a session whose contributor is `unattributed` / `unverifiable`, is
 * reported (`content_match_not_attributable`) and NOT suppressed: "two different
 * people" is precisely what is unproven there, and suppressing on an unproven
 * relationship is how a student's own laundered content would explain itself.
 *
 * ## No git author identity
 *
 * Attribution runs `session.start.identity.student_ref` → `contributorOf`, and
 * nowhere else. There is no author field in `git.event` and this module invents
 * none. See the protocol note on `GitEventPayload` in `log-core/src/events.ts`.
 */

import type { Bundle } from '../loader/types.js';
import type { EventIndex, IndexedEvent } from './event-index.js';
import {
  buildObservedDag,
  isCommitAncestor,
  type ObservedDag,
  type RepositoryKey,
} from '../git/observed-dag.js';
import { contributorOf } from '../identity/resolve-contributors.js';
import { compareContributors, type SessionContributor } from '../identity/types.js';
import { hasTwoDifferentContributors } from './reconstruct-segments.js';
import { bundleCollaboration } from '../manifest/bundle-manifest.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How close, in the session's OWN monotonic `t`, a HEAD-moving `git.event` must
 * sit before an `fs.external_change` for the change to be called
 * `git_unrecorded_in` rather than `external`.
 *
 * One minute. Generous next to the fs-watcher path (which reads the file and
 * emits within milliseconds of the write) and next to the editor's auto-reload
 * discriminator, and deliberately far short of "anywhere in this session" — a
 * session in which the student committed once must not have every later
 * out-of-editor paste described as git-delivered.
 *
 * Exceeding it yields `external`, which is exactly today's answer, so the
 * failure mode of this number is "no change from before", never a suppression.
 * It is intra-session only: `t` is milliseconds since that session's start, so
 * no cross-machine clock is being compared (spec §5.2 L3).
 */
export const GIT_ADJACENCY_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * What an `fs.external_change` actually was.
 *
 * Four members, all of which a caller must handle. Code shaped
 * `if (c === 'git_merge_in') skip; else accuse` is correct today only because
 * the other three all fire — but it erases the distinction R2 exists to
 * preserve, so consumers surface {@link ExternalChangeVerdict.detail} too.
 */
export type ExternalChangeClass =
  | 'git_merge_in'
  | 'git_unrecorded_in'
  | 'external'
  | 'unclassified';

/** Why a change could not be classified. Never a synonym for `external`. */
export type UnclassifiedReason =
  /**
   * The change carries no usable post-change sha256 — a `delete`, or a payload
   * whose `new_hash` is empty or unreadable. The content test cannot run at all.
   * Absent content is not evidence of anything and must not be read as one.
   */
  | { kind: 'no_post_change_hash' }
  /**
   * This session recorded no `git.event` naming a commit, so whether a git
   * operation delivered these bytes is not merely unproven, it is unobservable.
   * Reported rather than guessed: a dark signal is a coverage fact (spec §6
   * Rule 3), not a finding about the student.
   */
  | { kind: 'no_git_observations' }
  /**
   * The bytes match a state a provably different contributor recorded — but
   * HEAD never moved in this session, so nothing observed here delivered them.
   * Surfaced with the match named, because a grader reading a flag about these
   * bytes should be told they also exist in a partner's recorded work.
   */
  | { kind: 'content_match_without_git_operation' }
  /**
   * The bytes match a recorded state, but not one belonging to a provably
   * different contributor — the match is the same contributor's other session,
   * or a session whose identity is `unattributed` / `unverifiable`. Suppressing
   * on that would assert a relationship the evidence does not establish.
   */
  | { kind: 'content_match_not_attributable' };

/** One recorded editor state whose sha256 equals a change's post-change sha256. */
export type ContentMatch = {
  sessionId: string;
  seq: number;
  /** Which recorded state carried the sha. Never `fs.external_change` — see the module docstring. */
  kind: 'doc.save' | 'doc.open';
  /** {@link compareContributors} against the changed session's contributor. */
  contributorComparison: 'same' | 'different' | 'unknown';
  /**
   * The matching session's verified `student_ref`, or `null`.
   *
   * Non-null ONLY when that session's contributor is `attributed` — spec §6
   * Rule 2: a finding names a person only on established evidence.
   */
  studentRef: string | null;
};

/** The `git.event` that put a change in reach of a git operation. */
export type GitAdjacency = {
  sessionId: string;
  seq: number;
  /** The sha HEAD was observed at. Verbatim; never normalized. */
  sha: string;
  /**
   * Did this observation move HEAD? True when the previous observation in the
   * same session named a different sha. The recorder emits a `git.event` on
   * EVERY repository state change (spec S28) — staging, an index refresh — and
   * those rewrite no files, so a move is what makes an observation relevant.
   *
   * The first observation in a session is NOT a move: the recorder records the
   * initial HEAD without emitting it (`git-wiring.ts` `watchRepo`), so whether
   * HEAD moved before that first emitted event is unknowable, and guessing
   * "yes" would make every later change in the session git-adjacent.
   */
  headMoved: boolean;
  /** `change.t - gitEvent.t`, in the session's own monotonic clock. */
  withinMs: number;
};

/** One `fs.external_change`, classified. */
export type ExternalChangeVerdict = {
  globalIdx: number;
  sessionId: string;
  seq: number;
  /** Canonical path (workspace-root aliases already resolved by `buildIndex`). */
  path: string;
  classification: ExternalChangeClass;
  /** Non-null exactly when `classification === 'unclassified'`. */
  reason: UnclassifiedReason | null;
  /** Every recorded state in the scope whose sha256 equals this change's. May be empty. */
  matches: readonly ContentMatch[];
  /**
   * The nearest HEAD-moving observation before this change in the same session,
   * or `null` when there was none. Descriptive on every class.
   */
  gitAdjacency: GitAdjacency | null;
  /**
   * Does the observed commit DAG connect a matching session's observed commits
   * to the commit this session was at?
   *
   * **Corroboration only — never a requirement.** Requiring it would make
   * `git_merge_in` depend on the PARTNER's recorder having captured git at all,
   * and `git.event` was 100% dark for the standard nested-assignment layout
   * until very recently (decision log §3 item 3). The content match is the
   * cryptographic statement; this says how much of the commit graph corroborates
   * it.
   *
   *  - `'ancestor'` — a commit a matching session observed is an ancestor of the
   *    commit this session was at when the change landed. The strongest form:
   *    the partner's work provably precedes this state in the graph.
   *  - `'same_commit'` — both sessions observed the same commit.
   *  - `'unordered'` — both observed commits, and the graph relates neither.
   *  - `'no_observations'` — one side observed no commits, so there is nothing
   *    to relate. NOT a negative finding.
   *  - `'not_applicable'` — there are no partner matches to relate.
   */
  dagCorroboration: 'ancestor' | 'same_commit' | 'unordered' | 'no_observations' | 'not_applicable';
  /**
   * What the recorder's timing-based explanation tagger said about this event,
   * verbatim. Recorded for corroboration and for measuring the tagger's residual
   * value; it is NOT an input to the classification.
   *
   * It is still an input to `external_edits`, which suppresses on a tag — but
   * only where the content test has nothing stronger to say. Per decision D16 a
   * `git_unrecorded_in` overrides an `explanation: 'git'` tag there. See
   * {@link overridesRecorderGitTag}.
   */
  recorderExplanation: 'git' | 'formatter' | null;
  /** One grader-readable sentence. Consumers surface this in their flag text. */
  detail: string;
};

/** The whole-scope verdict. Produced by {@link classifyExternalChanges}. */
export type ExternalChangeClassification = {
  /**
   * `'scope_not_collaborative'` means the pass did not run — the maps are empty
   * and every consumer behaves exactly as it did before Tier 3.1. This is R3,
   * made explicit in the API so a caller cannot read "no verdicts" as "nothing
   * was reclassifiable".
   */
  applicability: 'ran' | 'scope_not_collaborative';
  /** Verdicts, keyed by `globalIdx`. Empty when the pass did not run. */
  byGlobalIdx: ReadonlyMap<number, ExternalChangeVerdict>;
  /**
   * `globalIdx` of every `git_merge_in` — the ONLY suppressing class, and the
   * set the three consuming heuristics skip. Deliberately a separate, narrow
   * surface: a consumer that reaches for "the set to skip" gets exactly the one
   * class that may be skipped, and cannot accidentally skip `unclassified`.
   */
  gitMergeIn: ReadonlySet<number>;
  /** How many changes landed in each class. Coverage-panel input (spec §6 Rule 3). */
  counts: Record<ExternalChangeClass, number>;
  /** Why the pass ran, or did not. */
  scope: {
    /** The course-signed `collaboration` field; `null` at 1.x or when unverified. */
    collaboration: 'solo' | 'group' | null;
    /** Are there two contributors `compareContributors` calls `'different'`? */
    twoDifferentContributors: boolean;
  };
};

// ---------------------------------------------------------------------------
// Payload reading — a .slog is untrusted input
// ---------------------------------------------------------------------------

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readRecorderExplanation(payload: unknown): 'git' | 'formatter' | null {
  const v = readString(payload, 'explanation');
  return v === 'git' || v === 'formatter' ? v : null;
}

// ---------------------------------------------------------------------------
// The content index
// ---------------------------------------------------------------------------

type RecordedState = { sessionId: string; seq: number; kind: 'doc.save' | 'doc.open' };

/**
 * `path → sha256 → the recorded editor states carrying it`.
 *
 * One pass over the `doc.save` and `doc.open` buckets — the "hash-set join over
 * recorded shas in the scope" the spec's §9 cost note asks about. Built once per
 * scope, so the per-`fs.external_change` cost is two map lookups, not a scan.
 *
 * `doc.open` is included as well as `doc.save` because a partner's session that
 * merely OPENED the file records its on-disk sha, and that is the same evidence:
 * these exact bytes existed in that contributor's working tree while their
 * recorder was running.
 */
function buildRecordedStateIndex(index: EventIndex): Map<string, Map<string, RecordedState[]>> {
  const byPath = new Map<string, Map<string, RecordedState[]>>();

  const add = (e: IndexedEvent, kind: 'doc.save' | 'doc.open'): void => {
    const path = e.file;
    if (path === undefined) return;
    const sha = readString(e.payload, 'sha256');
    if (sha === null) return;
    let byBytes = byPath.get(path);
    if (byBytes === undefined) {
      byBytes = new Map();
      byPath.set(path, byBytes);
    }
    let states = byBytes.get(sha);
    if (states === undefined) {
      states = [];
      byBytes.set(sha, states);
    }
    states.push({ sessionId: e.sessionId, seq: e.seq, kind });
  };

  for (const e of index.byKind.get('doc.save') ?? []) add(e, 'doc.save');
  for (const e of index.byKind.get('doc.open') ?? []) add(e, 'doc.open');

  return byPath;
}

// ---------------------------------------------------------------------------
// Git observations, per session
// ---------------------------------------------------------------------------

type SessionObservation = {
  seq: number;
  sha: string;
  repository: RepositoryKey;
  /** Milliseconds since that session's start. Intra-session only. */
  t: number;
  headMoved: boolean;
};

/**
 * Every commit observation, bucketed per session in ascending `seq` order, with
 * `headMoved` resolved and the session-local `t` attached.
 *
 * Observations come from {@link buildObservedDag} rather than from re-reading
 * payloads: Tier 1.2 already did the defensive parsing, the `sha` vs
 * `commit_sha` fallback and the repository keying, and a second implementation
 * of a contract that exists to have exactly one is how the two drift apart.
 */
function bucketObservations(
  dag: ObservedDag,
  index: EventIndex,
): Map<string, SessionObservation[]> {
  const bySession = new Map<string, SessionObservation[]>();

  for (const obs of dag.observations) {
    const indexed = index.bySeq.get(`${obs.sessionId}:${obs.seq}`);
    // An observation whose event is not in the index cannot be positioned
    // against anything, so it cannot make a change adjacent. Skipping it fails
    // toward `external` / `unclassified`, never toward a suppression.
    if (indexed === undefined) continue;
    let bucket = bySession.get(obs.sessionId);
    if (bucket === undefined) {
      bucket = [];
      bySession.set(obs.sessionId, bucket);
    }
    bucket.push({
      seq: obs.seq,
      sha: obs.sha,
      repository: obs.repository,
      t: indexed.t,
      headMoved: false,
    });
  }

  for (const bucket of bySession.values()) {
    bucket.sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.sha < b.sha ? -1 : 1));
    // The FIRST observation is not a move: see GitAdjacency.headMoved.
    for (let i = 1; i < bucket.length; i++) {
      bucket[i]!.headMoved = bucket[i]!.sha !== bucket[i - 1]!.sha;
    }
  }

  return bySession;
}

/** The nearest HEAD-moving observation strictly before `seq` in this session. */
function nearestHeadMove(
  observations: readonly SessionObservation[] | undefined,
  seq: number,
): SessionObservation | null {
  if (observations === undefined) return null;
  let found: SessionObservation | null = null;
  for (const obs of observations) {
    if (obs.seq >= seq) break;
    if (obs.headMoved) found = obs;
  }
  return found;
}

/**
 * Did HEAD move anywhere in this session before `seq`?
 *
 * The coarse test, used only for `git_merge_in` — see the module docstring for
 * why the two classes are gated differently.
 */
function headMovedBefore(
  observations: readonly SessionObservation[] | undefined,
  seq: number,
): boolean {
  return nearestHeadMove(observations, seq) !== null;
}

/** The commit this session was last observed at, before `seq`. */
function headShaBefore(
  observations: readonly SessionObservation[] | undefined,
  seq: number,
): { sha: string; repository: RepositoryKey } | null {
  if (observations === undefined) return null;
  let found: { sha: string; repository: RepositoryKey } | null = null;
  for (const obs of observations) {
    if (obs.seq >= seq) break;
    found = { sha: obs.sha, repository: obs.repository };
  }
  return found;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

const EMPTY_CLASSIFICATION_COUNTS: Record<ExternalChangeClass, number> = {
  git_merge_in: 0,
  git_unrecorded_in: 0,
  external: 0,
  unclassified: 0,
};

function notCollaborative(
  collaboration: 'solo' | 'group' | null,
  twoDifferentContributors: boolean,
): ExternalChangeClassification {
  return {
    applicability: 'scope_not_collaborative',
    byGlobalIdx: new Map(),
    gitMergeIn: new Set(),
    counts: { ...EMPTY_CLASSIFICATION_COUNTS },
    scope: { collaboration, twoDifferentContributors },
  };
}

/**
 * Classify every `fs.external_change` in a scope.
 *
 * Pure and deterministic: no wall clock in any decision (only the session's own
 * monotonic `t`, and only within one session), no randomness, every iteration
 * over an explicitly ordered structure. Two runs over one bundle produce
 * identical output — the property the ingest-retry contract depends on.
 *
 * ## The gate (R3)
 *
 * Runs only for a **collaborative scope**, which is either:
 *
 *  - `manifest.collaboration === 'group'` on a manifest whose trust chain
 *    VERIFIED — a course-signed field a student cannot set (it is absent from
 *    the signed payload below 2.0, and `parseManifestValue` strips it there); or
 *  - two contributors `compareContributors` calls `'different'` — which requires
 *    a verified enrollment chain on both sides.
 *
 * Anything else, including an unstamped bundle, takes the
 * `scope_not_collaborative` path and every consumer behaves exactly as it did
 * before. Neither trigger is student-controllable, which is what makes the gate
 * a gate rather than an opt-out.
 */
export function classifyExternalChanges(
  bundle: Bundle,
  index: EventIndex,
): ExternalChangeClassification {
  const contributorBySession = new Map<string, SessionContributor>();
  for (const session of bundle.sessions) {
    contributorBySession.set(session.sessionId, contributorOf(bundle, session.sessionId));
  }

  const collaboration = bundleCollaboration(bundle);
  const twoDifferent = hasTwoDifferentContributors([...contributorBySession.values()]);
  if (collaboration !== 'group' && !twoDifferent) {
    return notCollaborative(collaboration, twoDifferent);
  }

  const changes = index.byKind.get('fs.external_change') ?? [];
  if (changes.length === 0) {
    return {
      applicability: 'ran',
      byGlobalIdx: new Map(),
      gitMergeIn: new Set(),
      counts: { ...EMPTY_CLASSIFICATION_COUNTS },
      scope: { collaboration, twoDifferentContributors: twoDifferent },
    };
  }

  const recorded = buildRecordedStateIndex(index);
  const dag = buildObservedDag(bundle);
  const observations = bucketObservations(dag, index);

  const byGlobalIdx = new Map<number, ExternalChangeVerdict>();
  const gitMergeIn = new Set<number>();
  const counts: Record<ExternalChangeClass, number> = { ...EMPTY_CLASSIFICATION_COUNTS };

  for (const e of changes) {
    // The recorder reporting the editor's own save (D1). Already reclassified
    // upstream and already skipped by every consumer; classifying it again would
    // put two verdicts on one event.
    if (index.selfInflictedExternalChanges?.has(e.globalIdx)) continue;

    const verdict = classifyOne(e, { recorded, dag, observations, contributorBySession });
    byGlobalIdx.set(e.globalIdx, verdict);
    counts[verdict.classification] += 1;
    if (verdict.classification === 'git_merge_in') gitMergeIn.add(e.globalIdx);
  }

  return {
    applicability: 'ran',
    byGlobalIdx,
    gitMergeIn,
    counts,
    scope: { collaboration, twoDifferentContributors: twoDifferent },
  };
}

type ClassifyDeps = {
  recorded: Map<string, Map<string, RecordedState[]>>;
  dag: ObservedDag;
  observations: Map<string, SessionObservation[]>;
  contributorBySession: Map<string, SessionContributor>;
};

function classifyOne(e: IndexedEvent, deps: ClassifyDeps): ExternalChangeVerdict {
  const { recorded, dag, observations, contributorBySession } = deps;
  const path = e.file ?? readString(e.payload, 'path') ?? 'unknown';
  const recorderExplanation = readRecorderExplanation(e.payload);
  const sessionObs = observations.get(e.sessionId);

  const nearest = nearestHeadMove(sessionObs, e.seq);
  const gitAdjacency: GitAdjacency | null =
    nearest === null
      ? null
      : {
          sessionId: e.sessionId,
          seq: nearest.seq,
          sha: nearest.sha,
          headMoved: true,
          withinMs: e.t - nearest.t,
        };

  const base = {
    globalIdx: e.globalIdx,
    sessionId: e.sessionId,
    seq: e.seq,
    path,
    gitAdjacency,
    recorderExplanation,
  };

  // -------------------------------------------------------------------------
  // (a) No post-change hash — a delete, or an unreadable payload. The content
  //     test cannot run, and absent content is not evidence of anything.
  // -------------------------------------------------------------------------
  const newHash = readString(e.payload, 'new_hash');
  if (newHash === null) {
    return {
      ...base,
      classification: 'unclassified',
      reason: { kind: 'no_post_change_hash' },
      matches: [],
      dagCorroboration: 'not_applicable',
      detail:
        `The external change to ${path} carries no post-change content hash ` +
        `(a deletion, or a payload the recorder could not complete), so it cannot be ` +
        `checked against content recorded elsewhere in this submission.`,
    };
  }

  // -------------------------------------------------------------------------
  // (b) The content test.
  // -------------------------------------------------------------------------
  const here = contributorBySession.get(e.sessionId);
  const states = recorded.get(path)?.get(newHash) ?? [];
  const matches: ContentMatch[] = [];
  for (const state of states) {
    if (state.sessionId === e.sessionId) continue; // its own session proves nothing
    const there = contributorBySession.get(state.sessionId);
    const comparison =
      here === undefined || there === undefined ? 'unknown' : compareContributors(here, there);
    matches.push({
      sessionId: state.sessionId,
      seq: state.seq,
      kind: state.kind,
      contributorComparison: comparison,
      studentRef: there !== undefined && there.kind === 'attributed' ? there.studentRef : null,
    });
  }
  matches.sort((a, b) =>
    a.sessionId !== b.sessionId ? (a.sessionId < b.sessionId ? -1 : 1) : a.seq - b.seq,
  );

  const partnerMatches = matches.filter((m) => m.contributorComparison === 'different');
  const dagCorroboration = corroborate(dag, observations, e, partnerMatches);

  if (partnerMatches.length > 0) {
    if (!headMovedBefore(sessionObs, e.seq)) {
      return {
        ...base,
        classification: 'unclassified',
        reason: { kind: 'content_match_without_git_operation' },
        matches,
        dagCorroboration,
        detail:
          `The content written to ${path} matches a state recorded under a different ` +
          `verified contributor (${describeMatches(partnerMatches)}), but this session ` +
          `recorded no git operation that moved HEAD beforehand, so nothing observed here ` +
          `delivered it. Reported rather than set aside.`,
      };
    }
    return {
      ...base,
      classification: 'git_merge_in',
      reason: null,
      matches,
      dagCorroboration,
      detail:
        `The content written to ${path} is byte-identical to a state recorded under a ` +
        `different verified contributor (${describeMatches(partnerMatches)}), and git moved ` +
        `HEAD in this session beforehand. This is a merge of a partner's recorded work, not ` +
        `an edit made outside the editor.` +
        (dagCorroboration === 'ancestor' || dagCorroboration === 'same_commit'
          ? ` The observed commit graph corroborates it (${dagCorroboration}).`
          : ''),
    };
  }

  if (matches.length > 0) {
    return {
      ...base,
      classification: 'unclassified',
      reason: { kind: 'content_match_not_attributable' },
      matches,
      dagCorroboration,
      detail:
        `The content written to ${path} matches a state recorded in ` +
        `${describeMatches(matches)}, but that session's contributor is not established as a ` +
        `different person from this one, so this cannot be called a partner's work. ` +
        `Reported at full strength.`,
    };
  }

  // -------------------------------------------------------------------------
  // (c) No content match. Was a git operation even observable here?
  // -------------------------------------------------------------------------
  if (sessionObs === undefined || sessionObs.length === 0) {
    return {
      ...base,
      classification: 'unclassified',
      reason: { kind: 'no_git_observations' },
      matches: [],
      dagCorroboration: 'not_applicable',
      detail:
        `The content written to ${path} matches nothing recorded elsewhere in this ` +
        `submission, and this session recorded no git activity at all — so whether a git ` +
        `operation delivered it is unobservable, not merely unproven.`,
    };
  }

  if (gitAdjacency !== null && gitAdjacency.withinMs <= GIT_ADJACENCY_WINDOW_MS) {
    return {
      ...base,
      classification: 'git_unrecorded_in',
      reason: null,
      matches: [],
      dagCorroboration: 'not_applicable',
      detail:
        `${path} changed on disk ${gitAdjacency.withinMs} ms after git moved HEAD to ` +
        `${gitAdjacency.sha}, so a git operation is the likely source — and no session in ` +
        `this submission recorded producing these bytes. What is established is that this ` +
        `content has no recorded authorship in this scope; who wrote it is NOT established. ` +
        `That is equally consistent with a collaborator who never enrolled or was not ` +
        `running a recorder, and with code brought in from outside the submission. Confirm ` +
        `whether every collaborator on this repository is enrolled and recording before ` +
        `reading it as either.`,
    };
  }

  return {
    ...base,
    classification: 'external',
    reason: null,
    matches: [],
    dagCorroboration: 'not_applicable',
    detail:
      `${path} changed outside the editor. The content matches nothing recorded elsewhere ` +
      `in this submission, and no git operation in this session moved HEAD close enough ` +
      `beforehand to account for it.`,
  };
}

function describeMatches(matches: readonly ContentMatch[]): string {
  const first = matches[0];
  if (first === undefined) return 'no session';
  // Spec §6 Rule 2: name a person only on established evidence.
  const who = first.studentRef === null ? '' : ` (student_ref ${first.studentRef})`;
  const more = matches.length > 1 ? ` and ${matches.length - 1} more` : '';
  return `session ${first.sessionId}${who} ${first.kind} at seq ${first.seq}${more}`;
}

/**
 * How the observed commit DAG relates the matching sessions' commits to the
 * commit this session was at. Corroboration only — see
 * {@link ExternalChangeVerdict.dagCorroboration}.
 */
function corroborate(
  dag: ObservedDag,
  observations: Map<string, SessionObservation[]>,
  e: IndexedEvent,
  partnerMatches: readonly ContentMatch[],
): ExternalChangeVerdict['dagCorroboration'] {
  if (partnerMatches.length === 0) return 'not_applicable';

  const head = headShaBefore(observations.get(e.sessionId), e.seq);
  if (head === null) return 'no_observations';

  let sawAny = false;
  let sawSame = false;
  for (const match of partnerMatches) {
    for (const obs of observations.get(match.sessionId) ?? []) {
      if (obs.repository !== head.repository) continue;
      sawAny = true;
      if (obs.sha === head.sha) {
        sawSame = true;
        continue;
      }
      if (isCommitAncestor(dag, obs.sha, head.sha, head.repository)) return 'ancestor';
    }
  }
  if (sawSame) return 'same_commit';
  return sawAny ? 'unordered' : 'no_observations';
}

// ---------------------------------------------------------------------------
// The memoized accessor — what consumers use
// ---------------------------------------------------------------------------

/**
 * Per-`EventIndex` memo of {@link classifyExternalChanges}.
 *
 * All three consuming heuristics need the same verdicts for the same index, and
 * rebuilding the recorded-state index and the observed DAG once per heuristic
 * would be a real regression on an ingest path that is already CPU-bound. Keyed
 * weakly on the index, exactly like the reconstruction memos, so it is released
 * with it.
 *
 * For a solo bundle the memoized value is the `scope_not_collaborative` verdict,
 * so the saving is the contributor scan — there is no DAG and no content index.
 */
const classificationCache = new WeakMap<EventIndex, ExternalChangeClassification>();

/** {@link classifyExternalChanges}, memoized per index. The accessor callers should use. */
export function externalChangeClassificationFor(
  bundle: Bundle,
  index: EventIndex,
): ExternalChangeClassification {
  let cached = classificationCache.get(index);
  if (cached === undefined) {
    cached = classifyExternalChanges(bundle, index);
    classificationCache.set(index, cached);
  }
  return cached;
}

/**
 * The verdict for one event, or `null` when the pass did not run (a solo scope)
 * or the event was already reclassified as self-inflicted.
 *
 * `null` means "no opinion", and a consumer must treat it as today's behaviour —
 * fire, unchanged. It never means "innocent".
 */
export function externalChangeVerdictFor(
  bundle: Bundle,
  index: EventIndex,
  globalIdx: number,
): ExternalChangeVerdict | null {
  return externalChangeClassificationFor(bundle, index).byGlobalIdx.get(globalIdx) ?? null;
}

/**
 * Should a heuristic that reports on external changes SKIP this event?
 *
 * True for `git_merge_in` and nothing else. Deliberately a predicate rather than
 * a set lookup at each call site, so the answer to "which classes are
 * suppressed" lives in exactly one place and a future class cannot be added to
 * the skip list by accident at one of three consumers.
 */
export function isGitMergeIn(bundle: Bundle, index: EventIndex, globalIdx: number): boolean {
  return externalChangeClassificationFor(bundle, index).gitMergeIn.has(globalIdx);
}

/**
 * Does this verdict override the recorder's `explanation: 'git'` tag?
 *
 * **Decision D16.** The recorder stamps `explanation: 'git'` on an external
 * change that lands within ~2 s of a git state change. That tag is retained
 * deliberately — it covers scopes the content test structurally cannot (solo,
 * 1.x, an unenrolled partner) and it lives inside the signed chain at the moment
 * of the operation. What changed is what the ANALYZER does with it: a
 * `git_unrecorded_in` is a content-derived statement that the bytes match
 * nothing anyone recorded, and a two-second timing window must not silence it.
 * Left suppressing, the window is a hole a student could learn to exploit by
 * timing an out-of-editor paste right after any git command.
 *
 * `git_merge_in` is not listed because it never reaches a tag test — it is
 * skipped outright, by content, tag or no tag.
 *
 * Scoped to the `'git'` tag only. `'formatter'` is a narrower, different claim
 * (a known formatter ran on this path) and D16 does not reach it; it also has no
 * production caller today, so no shipped bundle can carry it.
 *
 * A predicate rather than an inline comparison so "which classes beat the tag"
 * has exactly one home, the way {@link isGitMergeIn} does for suppression.
 */
export function overridesRecorderGitTag(
  verdict: ExternalChangeVerdict | null | undefined,
  tag: 'git' | 'formatter',
): boolean {
  if (verdict === null || verdict === undefined) return false;
  return tag === 'git' && verdict.classification === 'git_unrecorded_in';
}

/**
 * A clause naming the classification, for a flag's description.
 *
 * `''` when there is no verdict (a solo scope) and `''` for `external`, which
 * keeps every existing description byte-for-byte identical — R3.
 */
export function describeClassification(verdict: ExternalChangeVerdict | null): string {
  if (verdict === null) return '';
  switch (verdict.classification) {
    case 'git_merge_in':
      // Not reached from a consumer: git_merge_in is skipped. Present so the
      // switch is total and a UI that wants the sentence can have it.
      return ` Reclassified as git_merge_in: ${verdict.detail}`;
    case 'git_unrecorded_in':
      return ` Classified git_unrecorded_in: ${verdict.detail}`;
    case 'external':
      return '';
    case 'unclassified':
      return ` Not classifiable against partner activity: ${verdict.detail}`;
  }
}
