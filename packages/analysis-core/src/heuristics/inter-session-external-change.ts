/**
 * inter_session_external_change heuristic.
 *
 * Detects file content that diverged between the END of one recorder session
 * and the START of the next. The recorder only emits `fs.external_change`
 * events while a session is live; a student who edits hw1.py with another
 * tool between two `code` launches will leave no event in either session —
 * but the next session's first `doc.open` for that file carries the on-disk
 * content (recorder v1.1+), so we can compare it against the reconstruction
 * at the end of the previous session.
 *
 * Detection per consecutive (sessionA, sessionB) pair, per file F:
 *   prevEnd  = reconstructed content of F just after sessionA's last event
 *   nextOpen = payload.content of the first doc.open for F in sessionB
 *   if both are known and prevEnd !== nextOpen  →  emit flag
 *
 * Severity:
 *   high   if |len(nextOpen) - len(prevEnd)| > highSeverityCharsChanged
 *   medium otherwise
 *
 * Confidence: 0.85 — high signal (the file demonstrably changed while the
 * recorder was off) but slightly less than `external_edits` (0.9) since
 * we can't attribute the change to a specific tool (formatter, git, …).
 *
 * Supporting seq: sessionB's first doc.open for F. Jumping there in Replay
 * lands the user at the moment the divergence becomes visible.
 *
 * Skips (no flag):
 *   - F never touched in sessionA (nothing to compare against).
 *   - Pre-v1.1 recorder: no `content` field on doc.open.
 *   - The two strings are equal (no divergence).
 *   - The two sessions belong to PROVEN-DIFFERENT contributors (see below).
 *   - The two sessions OVERLAP in wall time (see "Scoped to non-overlapping
 *     pairs" below) — the whole pair is skipped, not per-file.
 *
 * ## Scoped to one contributor's chain (Tier 3.2/3.3)
 *
 * The claim this heuristic can support is "the file changed while MY recorder
 * was off". In a repo shared by two partners it was making a different claim
 * entirely: sessionB is a different person on a different machine with a
 * different working tree, so the content difference is not merely likely, it is
 * GUARANTEED. Every partner commit landing between two sessions produced a
 * 0.85-confidence finding — high once the delta passed
 * `highSeverityCharsChanged` — against a student who did nothing wrong. See
 * `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` §3 S5.
 *
 * A consecutive pair is therefore gated on {@link compareContributors}:
 *
 *  - `'different'` — two verified, distinct people. No comparison, no flag.
 *    This is the ONLY case that suppresses, and it needs proof on both sides.
 *  - `'same'` — one verified person's own consecutive sessions. The original
 *    signal, unchanged in severity and confidence.
 *  - `'unknown'` — at least one side is `unattributed` or `unverifiable`. The
 *    pair is compared exactly as it was before Tier 3.3, because "these are two
 *    different people" is precisely what is not established. An unenrolled
 *    cohort loses no findings; the description names the ambiguity instead.
 *
 * Never compare `contributorKey` strings directly. Every unattributed session
 * carries a per-session singleton key, so a direct compare reads "unproven" as
 * "different people" and silently deletes findings.
 *
 * ### The gap this deliberately leaves open
 *
 * Only the pair filter is implemented, not a full walk of each contributor's
 * chain across intervening partner sessions. In wall order A1, B1, A2 the pairs
 * (A1,B1) and (B1,A2) are now suppressed and (A1,A2) is NOT compared.
 *
 * That is on purpose. Comparing A1 against A2 would flag the partner's work
 * that git delivered into A's tree in between — manufacturing the very
 * accusation this change removes. The spec lists 3.3 as depending on Tier 3.1,
 * whose content-based git-delivery test ("do these bytes match a state some
 * contributor's session demonstrably produced?") is what makes an A1→A2
 * comparison sound.
 *
 * Tier 3.1 has since landed (`index/classify-external-changes.ts`), but it
 * classifies `fs.external_change` EVENTS, and the gap this heuristic covers is
 * by definition the interval where the recorder emitted none. Closing the A1→A2
 * case needs the same content test applied to a `doc.open` seed rather than to
 * an external-change payload — a change to this heuristic, not a missing
 * dependency. It is not done here, and until it is, the honest position remains
 * to compare fewer pairs rather than to invent findings; the pairs dropped here
 * are only the ones that were never anything but false.
 *
 * ## Scoped to non-overlapping pairs
 *
 * A second, independent gate sits beside the contributor gate: a consecutive
 * pair is only compared when sessionA's last event happened at or before
 * sessionB's first event. When the two sessions overlap in wall time, no
 * comparison is made and no flag is emitted for that pair, for any file.
 *
 * This is not noise suppression. It is the removal of a claim whose own stated
 * basis is false:
 *
 *  1. The heuristic's entire premise is an INTERVAL during which no recorder
 *     observed the working tree — "the recorder only emits `fs.external_change`
 *     while a session is live", so a gap between sessions is a gap in
 *     observation. Overlap is positive evidence that no such gap existed: a
 *     second recorder was watching the whole time sessionA's clock says it was
 *     "off". The finding's stated basis — "changed while the recorder was
 *     off" — is not weakly supported here, it is false by construction. That
 *     is a stronger reason to withhold it than "cannot attribute", which is
 *     all the Tier 3.3 gate above establishes.
 *
 *  2. "Consecutive sessions" is a fiction once two machines are involved.
 *     Sessions are ordered here by wall clock (`bySessionId` iteration order,
 *     sorted by wall in `buildIndex`), and two independent machines' clocks are
 *     not evidence of which one ran first — the identical principle that makes
 *     `index/reconstruct-segments.ts` refuse to linearise a file with live,
 *     unordered branches rather than hand a grader content that never existed
 *     on any one disk (spec S16, L3: "two machines' clocks are not evidence").
 *     When sessionA and sessionB overlap, "the end of one" and "the start of
 *     the next" are not two sequential states of ONE working tree sampled in
 *     order; they are two DIFFERENT trees sampled at two arbitrary moments that
 *     happen to sort adjacently. Diffing them and calling the diff "what
 *     happened in between" assumes the very ordering the overlap disproves.
 *
 *  3. Suppressing here loses nothing, because the overlap fact is not thrown
 *     away — it is computed exactly once, structurally, by
 *     `partitionSessionOverlaps` (`coverage/session-overlap.ts`) and surfaced
 *     to a grader through the channel built for it: the submission overview's
 *     Recording coverage panel (`CoveragePanel.tsx`) renders a "Concurrent
 *     recording" statement for every pair of sessions proven to belong to two
 *     different verified people — "Both are verified, and verified as
 *     different people — this is what collaboration looks like, and not a
 *     finding" — and a parallel "One contributor, two machines" statement when
 *     it is one person on two enrolled machines. An overlap this heuristic
 *     cannot yet attribute either way instead reaches a grader through
 *     `multiple_sessions_overlap`, the heuristic that partition actually feeds
 *     for the `judged` arm, hedged the same way this file's Tier 3.3 comment
 *     hedges `'unknown'` pairs. Either way, the overlap is reported by the ONE
 *     place in the codebase built to report it correctly. This heuristic
 *     manufacturing a second, wrongly-premised claim about the same interval —
 *     "the file changed while nobody was watching", over an interval where
 *     someone demonstrably was — adds no coverage and only adds risk.
 *
 * The gap is computed once per (sessionA, sessionB) pair, before the per-file
 * loop, and reused for both the suppression decision and the description text
 * — a session pair does not overlap for some files and not others. When either
 * endpoint's `wall` fails to parse, the gap is `null`: unlike a numeric gap,
 * `null` is NOT evidence of overlap (or of anything else), so it does not
 * suppress. The pair is still compared as before Tier 3.3/this change; only the
 * description's gap figure is omitted rather than fabricated as `0s`, which is
 * what a naive "parse failure defaults to 0" would print — and did, before this
 * change made `null` a real state instead of a silent zero.
 */

import type { EventIndex, IndexedEvent } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import { establishedContent } from './reconstruction-gate.js';
import {
  contributorOf,
  compareContributors,
  describeSessionContributor,
} from '../identity/resolve-contributors.js';
import type { Flag, Heuristic, Severity } from './types.js';
import type { HeuristicConfig } from './config.js';

const CONFIDENCE = 0.85;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

/**
 * Walk sessionEvents in order and return the first doc.open whose
 * `payload.path === file` and whose payload carries a string `content`.
 * Returns null if no such event exists.
 */
function firstDocOpenWithContent(
  sessionEvents: IndexedEvent[],
  file: string,
): { event: IndexedEvent; content: string } | null {
  for (const e of sessionEvents) {
    if (e.kind !== 'doc.open') continue;
    if (getString(e.payload, 'path') !== file) continue;
    const content = getString(e.payload, 'content');
    if (content === null) continue;
    return { event: e, content };
  }
  return null;
}

/**
 * Sessions touched in sessionA, by reading byFile filtered to sessionA.
 * Returns the set of file paths.
 */
function filesTouchedInSession(sessionEvents: IndexedEvent[]): Set<string> {
  const files = new Set<string>();
  for (const e of sessionEvents) {
    if (e.file !== undefined) files.add(e.file);
  }
  return files;
}

/**
 * Wall-clock gap, in ms, between sessionA's last event and sessionB's first
 * event. Positive means sessionA ended before sessionB started (the ordinary
 * case this heuristic is about). Zero or negative means the sessions overlap
 * or touch — see the "Scoped to non-overlapping pairs" header comment.
 *
 * Returns `null`, not `0`, when either endpoint's `wall` cannot be parsed:
 * `null` means "cannot establish", which must NOT be treated as evidence of
 * overlap (a `<= 0` suppression rule would otherwise silently swallow every
 * pair with a bad timestamp).
 */
function sessionGapMs(
  sessionAEvents: IndexedEvent[],
  sessionBEvents: IndexedEvent[],
): number | null {
  const aEnd = Date.parse(sessionAEvents[sessionAEvents.length - 1]!.wall);
  const bStart = Date.parse(sessionBEvents[0]!.wall);
  if (!Number.isFinite(aEnd) || !Number.isFinite(bStart)) return null;
  return bStart - aEnd;
}

// ---------------------------------------------------------------------------
// Heuristic
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { highSeverityCharsChanged } = config.interSessionExternalChange;

  // bySessionId iteration order = session-start chronological order
  // (events were inserted into bySessionId in `ordered` order, which is
  // sorted by wall in buildIndex / buildIndexFromEventRows).
  const sessionIds = Array.from(index.bySessionId.keys());
  if (sessionIds.length < 2) return [];

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (let i = 0; i + 1 < sessionIds.length; i++) {
    const sessionAId = sessionIds[i]!;
    const sessionBId = sessionIds[i + 1]!;
    const sessionAEvents = index.bySessionId.get(sessionAId) ?? [];
    const sessionBEvents = index.bySessionId.get(sessionBId) ?? [];
    if (sessionAEvents.length === 0 || sessionBEvents.length === 0) continue;

    // Tier 3.3: across two PROVEN-different contributors the difference is
    // guaranteed by construction — different person, different machine,
    // different working tree — and says nothing about misconduct. Only a proven
    // 'different' suppresses; 'unknown' keeps the pre-3.3 comparison.
    const contribA = contributorOf(bundle, sessionAId);
    const contribB = contributorOf(bundle, sessionBId);
    const comparison = compareContributors(contribA, contribB);
    if (comparison === 'different') continue;

    // Overlap gate (see "Scoped to non-overlapping pairs" above): a gap of
    // zero or less is proof the two sessions were not sequential, so the
    // whole pair is skipped before any file is compared. A `null` gap
    // ("cannot establish") is not proof of overlap and does NOT suppress —
    // the pair is still compared, just without a gap figure in the text.
    const gapMs = sessionGapMs(sessionAEvents, sessionBEvents);
    if (gapMs !== null && gapMs <= 0) continue;

    const sessionALastIdx = sessionAEvents[sessionAEvents.length - 1]!.globalIdx;
    // upToGlobalIdx is exclusive — to include all of sessionA's events,
    // pass lastGlobalIdx + 1.
    const upTo = sessionALastIdx + 1;

    const touchedInA = filesTouchedInSession(sessionAEvents);

    // Look at every file opened in sessionB for which we have initial content.
    // De-dup by file (only consider the first doc.open per file in B).
    const seenFiles = new Set<string>();
    for (const e of sessionBEvents) {
      if (e.kind !== 'doc.open') continue;
      const file = e.file;
      if (file === undefined) continue;
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);

      // Need content in payload (recorder v1.1+).
      const nextOpen = firstDocOpenWithContent(sessionBEvents, file);
      if (nextOpen === null) continue;

      // Need to have touched the file in A so reconstruction is meaningful.
      if (!touchedInA.has(file)) continue;

      // Tier 2.2: this comparison is an exact string equality, so it is the
      // most content-sensitive site in the codebase — one wrong character
      // reports "the file changed while the recorder was off". A third
      // contributor's segments can span this cut even when A and B are the same
      // person, so the gate is needed here despite the check above.
      const prevEnd = establishedContent(index, bundle, file, upTo);
      if (prevEnd === null) continue;
      if (prevEnd === nextOpen.content) continue;

      const lenDiff = Math.abs(nextOpen.content.length - prevEnd.length);
      const severity: Severity = lenDiff > highSeverityCharsChanged ? 'high' : 'medium';

      const supportingSeqs = [`${nextOpen.event.sessionId}:${nextOpen.event.seq}`];
      const id = `inter_session_external_change-${supportingSeqs[0]}-${flagIndex++}`;

      // gapMs was computed once for the whole (sessionA, sessionB) pair above
      // (and already gated the pair on overlap before this loop started). A
      // `null` gap means it could not be established, not that it was zero —
      // print no figure rather than a fabricated "0s".
      const gapClause =
        gapMs === null
          ? '; the wall-clock gap between sessions could not be established'
          : ` over a ${Math.round(gapMs / 1000)}s gap`;

      flags.push({
        id,
        heuristic: 'inter_session_external_change',
        title: `${file} changed between sessions`,
        severity,
        confidence: CONFIDENCE,
        supportingSeqs,
        description:
          `${file} differs between the end of one recorder session and the start ` +
          `of the next (Δ ${lenDiff} chars${gapClause}).` +
          (comparison === 'same'
            ? ` Both sessions are attributed to the same verified contributor, so the file` +
              ` changed while that contributor's recorder was off.`
            : ` It is not established that the same person recorded both sessions` +
              ` (previous session: ${describeSessionContributor(contribA)}; next session:` +
              ` ${describeSessionContributor(contribB)}), so if a collaborator sharing this` +
              ` repository recorded one of them, the difference may be ordinary shared work` +
              ` rather than an edit made outside the recorder.`),
        detail: {
          file,
          prev_session_id: sessionAId,
          next_session_id: sessionBId,
          contributor_comparison: comparison,
          prev_session_contributor: describeSessionContributor(contribA),
          next_session_contributor: describeSessionContributor(contribB),
          prev_length: prevEnd.length,
          next_length: nextOpen.content.length,
          chars_length_delta: lenDiff,
          gap_wall_ms: gapMs,
          seqs: supportingSeqs,
        },
      });
    }
  }

  return flags;
}

export const interSessionExternalChangeHeuristic: Heuristic = {
  id: 'inter_session_external_change',
  label: 'File changed between recorder sessions',
  run,
};
