/**
 * terminal_active_during_external_change heuristic (Phase 17).
 *
 * PRD §7.4 environment: "A terminal was open at the time an external file
 * change occurred, suggesting the external change may have been script-driven."
 *
 * Logic:
 *   For each `fs.external_change` event, check whether any terminal was open
 *   at that time within the same session. A terminal is considered "open" if
 *   the session has any `terminal.open` event with `t ≤ externalChange.t` and
 *   no corresponding close (terminal.close is not in the event set — the
 *   recorder does not emit terminal.close events in v1). We therefore treat
 *   a terminal as open from its `terminal.open` event until the session ends.
 *
 * This is a weak signal: an open terminal is common and doesn't prove the
 * external change was script-driven. However, combined with `mass_external_
 * replacement` or `external_edits` flags, it strengthens the case.
 *
 * Severity: 'info'. Confidence: 0.6.
 *
 * One flag per `fs.external_change` event that co-occurs with an open terminal.
 * De-duplicated by the change event's seq.
 *
 * Known limitation — signal-to-noise:
 *   Once any `terminal.open` event appears in a session, every subsequent
 *   `fs.external_change` event will fire this heuristic for the remainder of
 *   the session (since terminal.close is never emitted; terminals remain "open"
 *   until session end). In sessions with many external changes (e.g., auto-save,
 *   formatter runs, git operations), this results in repeated 'info' flags that
 *   dilute the flag list and weaken the signal. Example: a 4-hour session with
 *   one terminal open and 30 external changes yields 30 'info' flags, none of
 *   which directly indicate dishonesty.
 *
 *   Mitigations for future polish:
 *   - Gate on co-occurrence with `external_edits` or `mass_external_replacement`
 *     flags (strengthens the case that the terminal contributed to the change).
 *   - Aggregate to a single per-session flag listing all affected external-change
 *     events, rather than one per event.
 *
 * ## Tier 3.1 — content-based reclassification
 *
 * The worst instance of the flood above is the one the census names: the student
 * ran `git pull` **in the integrated terminal**, so a terminal is definitionally
 * open when every file the pull rewrote changes. In a COLLABORATIVE scope the
 * event's content-derived classification now decides:
 *
 *  - `git_merge_in` — the bytes are a provably different verified contributor's
 *    recorded state. The terminal was open because the student was using git,
 *    and the change is their partner's work; no flag. The event stays in the
 *    index and in the classification, visible and countable.
 *  - `git_unrecorded_in` — flagged, unchanged, with the classification named.
 *    A terminal open while content nobody recorded lands on disk is exactly the
 *    "script-driven change" this heuristic was written for.
 *  - `external` / `unclassified` — flagged exactly as before.
 *
 * Note the third bullet of the old mitigation list — "filter out changes whose
 * `explanation` suggests an automated origin" — is deliberately NOT what
 * shipped. `explanation` is the recorder's timing-based tag; the classification
 * consumed here is derived from content and is the sounder discriminator.
 *
 * That is also why **D16 does not reach this heuristic**: D16 stops the
 * `explanation: 'git'` tag suppressing a `git_unrecorded_in`, and this heuristic
 * never let the tag suppress anything in the first place. No behaviour change,
 * and adding a tag test for "consistency" would undo the paragraph above.
 * `terminal-active-during-external-change.test.ts` pins it.
 *
 * A SOLO scope produces no verdicts, so behaviour there is unchanged.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import { isSignalCaptured } from '../manifest/bundle-manifest.js';
import {
  externalChangeClassificationFor,
  describeClassification,
} from '../index/classify-external-changes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionId: string, seq: number): string {
  return `terminal_active_during_external_change-${sessionId}-${seq}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, _config: HeuristicConfig): Flag[] {
  // Absence-vs-disabled (program spec §4). "No terminal was open when the file
  // changed externally" is a real statement only when terminals were being
  // recorded at all.
  if (!isSignalCaptured(bundle, 'terminal')) return [];

  const classification = externalChangeClassificationFor(bundle, index);
  const flags: Flag[] = [];

  for (const [, sessionEvents] of index.bySessionId) {
    // Collect terminal open times (t values) for this session.
    // Since terminal.close is not emitted, any terminal opened before t remains open.
    const terminalOpenTimes: number[] = sessionEvents
      .filter((e) => e.kind === 'terminal.open')
      .map((e) => e.t);

    if (terminalOpenTimes.length === 0) continue;

    // For each external change, check if any terminal was already open (open.t <= change.t).
    const externalChangeEvents = sessionEvents.filter(
      (e) =>
        e.kind === 'fs.external_change' &&
        // D1: skip external changes that were the recorder reporting the
        // editor's own save -- they describe something that never happened.
        !index.selfInflictedExternalChanges?.has(e.globalIdx) &&
        // Tier 3.1: git delivered a partner's recorded work. The terminal was
        // open because that is where git was run. Skipped here only; the event
        // stays in the index and in the classification.
        !classification.gitMergeIn.has(e.globalIdx),
    );
    for (const ev of externalChangeEvents) {
      const terminalWasOpen = terminalOpenTimes.some((openT) => openT <= ev.t);
      if (!terminalWasOpen) continue;

      const payload = ev.payload as Record<string, unknown> | null;
      const filePath = typeof payload?.['path'] === 'string' ? payload['path'] : 'unknown';
      const diffSize = typeof payload?.['diff_size'] === 'number' ? payload['diff_size'] : null;

      // Tier 3.1. Empty for a solo scope and for `external` — those
      // descriptions and details are byte-for-byte what they were.
      const verdict = classification.byGlobalIdx.get(ev.globalIdx) ?? null;

      flags.push({
        id: flagId(ev.sessionId, ev.seq),
        heuristic: 'terminal_active_during_external_change',
        title: `Terminal open during external file change: ${filePath}`,
        severity: 'info',
        confidence: 0.6,
        supportingSeqs: [`${ev.sessionId}:${ev.seq}`],
        description:
          `A terminal was open when the file "${filePath}" was externally changed ` +
          `(diff_size: ${diffSize ?? 'unknown'} chars). This may indicate a script or ` +
          `automated tool was responsible for the file change.` +
          describeClassification(verdict),
        detail: {
          sessionId: ev.sessionId,
          filePath,
          diffSize,
          terminalOpenCount: terminalOpenTimes.length,
          externalChangeT: ev.t,
          externalChangeSeq: ev.seq,
          ...(verdict === null
            ? {}
            : {
                externalChangeClass: verdict.classification,
                externalChangeReason: verdict.reason?.kind ?? null,
                externalChangeDetail: verdict.detail,
              }),
        },
      });
    }
  }

  return flags;
}

export const terminalActiveDuringExternalChangeHeuristic: Heuristic = {
  id: 'terminal_active_during_external_change',
  label: 'Terminal active during external file change',
  run,
};
