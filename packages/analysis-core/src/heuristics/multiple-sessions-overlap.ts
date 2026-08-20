/**
 * multiple_sessions_overlap heuristic (Phase 17).
 *
 * PRD §7.4 integrity: two sessions have overlapping wall-time ranges.
 *
 * ## Keyed on CONTRIBUTOR, not on the bundle (Tier 3.2)
 *
 * The original wording of this flag — carried verbatim into its description —
 * was that overlapping sessions are "impossible on a single machine without
 * clock manipulation or log forging". In a shared repo worked by two partners,
 * each running their own recorder, that overlap is produced every single time
 * two people sit down together. The flag was therefore a high/0.95 forgery
 * accusation against the assignment being done exactly as assigned. See
 * `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` §3 S5.
 *
 * So a pair is now judged by {@link compareContributors} over the two sessions'
 * resolved contributors:
 *
 *  - `'same'`     — one verified person recorded both. This is the ORIGINAL
 *                   signal and keeps its severity and confidence untouched.
 *  - `'different'` — two verified, distinct people recorded them. Expected
 *                   collaboration; no flag. This is the ONLY case that
 *                   suppresses, and it requires proof on both sides.
 *  - `'unknown'`  — at least one side is `unattributed` or `unverifiable`, so
 *                   "these are two different people" is exactly what is NOT
 *                   established. The flag fires, with wording that says so.
 *                   An unenrolled cohort therefore loses no findings.
 *
 * Never compare `contributorKey` strings directly here. That reads "unproven"
 * as "different people" and reintroduces the accusation through the back door,
 * because every unattributed session carries a per-session singleton key.
 *
 * ## Where the suppression actually lives
 *
 * Not in this file. `coverage/session-overlap.ts` owns the ONE enumeration of
 * overlapping session pairs and the ONE `'different'` decision, and returns a
 * partition: `judged` (what this heuristic flags) and `collaboration` (what the
 * §5.4 step 5 coverage stage states as an exculpatory fact).
 *
 * That move is the whole point. The suppression used to be a bare `continue`
 * here, taken before `pairId`, before `emittedPairs`, and before the `detail`
 * object existed — and `run()` returns only `Flag[]`, with no side channel. So a
 * suppressed overlap produced **no flag and no fact**, which is weaker than §6
 * Rule 3 intends. Reading the fact back out now requires no second copy of the
 * range rules, the strict-`<` overlap test, or the three-valued comparison.
 * `JudgedOverlap.comparison` cannot be `'different'`, so this file cannot
 * re-admit a suppressed pair even by accident.
 *
 * The BEHAVIOUR of this heuristic is unchanged by that move: the same pairs
 * flag, at the same severity, with the same ids, description and `detail`.
 *
 * The verdict is read through `contributorOf`, which answers `unattributed` for
 * a bundle no caller has stamped via `establishBundleContributors`. That is the
 * fail-toward-more-findings direction: an unstamped bundle behaves exactly as
 * this heuristic did before Tier 3.2.
 *
 * For each pair of sessions in the bundle, compare:
 *   - rangeA: [session.start.wall, session.end.wall]
 *   - rangeB: [session.start.wall, session.end.wall]
 *
 * If the two ranges overlap (i.e., A.start < B.end AND B.start < A.end),
 * emit a flag for that pair.
 *
 * Sessions with no `session.end` event are bounded at their LAST RECORDED
 * EVENT's wall, not at +Infinity.
 *
 * A missing `session.end` is the ordinary crash signature, not a suspicious
 * one: the recorder only emits `session.end` from `deactivate()`, which the
 * editor skips whenever the window is killed, the OS shuts down, or the host
 * process dies. The recorder itself already reads this as a crash — see
 * `previous_session_dangling` in the recorder's `startup/chain-recovery.ts`.
 *
 * Treating such a session as running until +Infinity claimed it overlapped
 * every session that started after it, forever — one crash on day 1 flagged
 * every session for the rest of the assignment. The last recorded event is the
 * last moment the session demonstrably existed; extending the range past it
 * invents evidence. A session whose only event is `session.start` therefore
 * has a zero-length range and cannot overlap anything, which is correct: it
 * never demonstrably ran concurrently with anything.
 *
 * This preserves the real signal — two sessions genuinely recording events in
 * the same wall-clock window still overlap and still flag.
 *
 * Do NOT reintroduce a "same machine_id → suppress" guard. `machine_id` is
 * sha256(hostname:username:sessionId) in all three recorders (VS Code,
 * JetBrains, Neovim) — session-salted by design, per PRD §5.1, to prevent
 * cross-assignment correlation. It is therefore unique per session and can
 * never match across two sessions, so such a guard is unreachable. An earlier
 * version of this file carried one; it was dead code, and its unit tests passed
 * only because the fixtures hand-set a shared machine_id no recorder can emit.
 * The contributor gate above is the discriminator that guard was reaching for,
 * and it is grounded in a signed identity chain rather than in a salted hash.
 *
 * Note on bundle.sessions ordering: sessions are sorted oldest-first by
 * firstEvent.wall (done in the loader). We iterate all pairs N*(N-1)/2.
 * With typical bundle sizes (1–10 sessions) this is negligible.
 *
 * Severity: 'high'. Confidence: 0.95 — unchanged, and deliberately so. Tier 3.2
 * narrows WHICH pairs are judged; it does not soften the judgement on the pairs
 * that survive the gate. The remaining innocent explanations (a misconfigured
 * clock, or one person recording on two machines under one identity) are named
 * in the description rather than being asserted away; clock skew would also
 * trigger monotonic_wall_regression.
 *
 * One flag per overlapping pair. The supporting seqs are the session.start
 * events of each session.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import { describeSessionContributor } from '../identity/resolve-contributors.js';
import type { SessionContributor } from '../identity/types.js';
import { partitionSessionOverlaps, type SessionRange } from '../coverage/session-overlap.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionIdA: string, sessionIdB: string): string {
  // Lexicographic sort to ensure A < B → stable, pair-order-independent ID.
  const [first, second] =
    sessionIdA < sessionIdB ? [sessionIdA, sessionIdB] : [sessionIdB, sessionIdA];
  return `multiple_sessions_overlap-${first}-${second}`;
}

/**
 * The clause that says what the overlap MEANS, given who recorded the two
 * sessions. Never reached for `'different'` — that pair produces no flag.
 */
function contributorClause(
  comparison: 'same' | 'unknown',
  ca: SessionContributor,
  cb: SessionContributor,
): string {
  if (comparison === 'same') {
    const who = ca.kind === 'attributed' ? ca.studentRef : 'the same contributor';
    return (
      `Both sessions are attributed to the same verified contributor (${who}), so this is one ` +
      `person's recorder covering the same wall-clock window twice. On a single machine that ` +
      `does not happen without clock manipulation or log forging; the remaining innocent ` +
      `explanation is that this person recorded on two machines under one identity.`
    );
  }
  return (
    `It is NOT established that two different people recorded these sessions: ` +
    `session A is ${describeSessionContributor(ca)}; session B is ${describeSessionContributor(cb)}. ` +
    `If one person recorded both, the overlap indicates clock manipulation or log forging. ` +
    `If two collaborators sharing a repository recorded them, it is ordinary concurrent work — ` +
    `the verified identity evidence that would tell those apart is absent here.`
  );
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, _config: HeuristicConfig): Flag[] {
  // Tier 3.2: two PROVEN-different contributors recording at once is the
  // expected shape of pair work, not evidence of forgery. That suppression is
  // NOT made here — `coverage/session-overlap.ts` owns the single enumeration
  // of overlapping pairs and the single suppression decision, and hands back a
  // partition. This heuristic judges the `judged` half; the coverage stage
  // states the `collaboration` half as a fact, which is how a suppressed
  // overlap stopped being invisible.
  //
  // `JudgedOverlap.comparison` is typed `'same' | 'unknown'`, so a suppressed
  // pair is not merely filtered out here — it is unrepresentable. The two
  // consumers cannot drift apart about which pairs were suppressed because
  // neither of them computes it.
  const { judged } = partitionSessionOverlaps(bundle, index);

  const flags: Flag[] = [];
  const emittedPairs = new Set<string>();

  for (const pair of judged) {
    const { a, b, contributorA: ca, contributorB: cb, comparison } = pair;

    const pairId = flagId(a.sessionId, b.sessionId);
    if (emittedPairs.has(pairId)) continue;
    emittedPairs.add(pairId);

    // Supporting seqs: the session.start events of both sessions.
    const supportingSeqs = [`${a.sessionId}:${a.startSeq}`, `${b.sessionId}:${b.startSeq}`];

    // Label a crash-bounded end so a reader knows the bound came from the last
    // recorded event rather than a real session.end.
    const endLabel = (r: SessionRange): string =>
      r.openEnded
        ? `${new Date(r.endWall).toISOString()} (last event; no session.end)`
        : new Date(r.endWall).toISOString();

    const aEndLabel = endLabel(a);
    const bEndLabel = endLabel(b);

    flags.push({
      id: pairId,
      heuristic: 'multiple_sessions_overlap',
      title: `Sessions overlap: ${a.sessionId.slice(0, 8)}… and ${b.sessionId.slice(0, 8)}…`,
      severity: 'high',
      confidence: 0.95,
      supportingSeqs,
      description:
        `Sessions "${a.sessionId}" and "${b.sessionId}" have overlapping wall-time ranges. ` +
        `Session A: [${new Date(a.startWall).toISOString()}, ${aEndLabel}]. ` +
        `Session B: [${new Date(b.startWall).toISOString()}, ${bEndLabel}]. ` +
        contributorClause(comparison, ca, cb),
      detail: {
        sessionA: a.sessionId,
        sessionB: b.sessionId,
        sessionAStartWall: new Date(a.startWall).toISOString(),
        sessionAEndWall: aEndLabel,
        sessionBStartWall: new Date(b.startWall).toISOString(),
        sessionBEndWall: bEndLabel,
        sessionAOpenEnded: a.openEnded,
        sessionBOpenEnded: b.openEnded,
        contributorComparison: comparison,
        sessionAContributor: describeSessionContributor(ca),
        sessionBContributor: describeSessionContributor(cb),
      },
    });
  }

  return flags;
}

export const multipleSessionsOverlapHeuristic: Heuristic = {
  id: 'multiple_sessions_overlap',
  label: 'Multiple sessions with overlapping wall-time ranges',
  run,
};
