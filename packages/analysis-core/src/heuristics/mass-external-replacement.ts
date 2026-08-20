/**
 * mass_external_replacement heuristic (Phase 16).
 *
 * PRD §7.4 process-shape: "fs.external_change where the new content shares
 * <20% lines with the old."
 *
 * The fs.external_change payload only carries `old_hash`/`new_hash`/`diff_size`
 * — never the full pre- or post-change file content. To compare old vs new, we
 * use the reconstructed content *immediately before* the external_change event.
 * The post-change content is unavailable (the payload lacks it), so we use the
 * next save's reconstructed content as the proxy for "what came after."
 *
 * Degradation strategy:
 *   - If no pre-change content is available (e.g., the first event for the file
 *     is an external_change, or reconstruction is tainted), skip the event.
 *   - If no post-change content is recoverable (no subsequent save), skip the
 *     event — we cannot compute the overlap ratio.
 *
 * Severity: 'high' (full replacement of file content by an external actor).
 * Confidence: 0.75 (we're using a proxy for post-change content).
 *
 * Threshold: sharedLines / max(oldLines, postLines) < massExternalReplacement.sharedThreshold.
 *
 * ## Tier 3.1 — content-based reclassification
 *
 * A `git pull` that brings a partner's rewritten file in replaces ~100% of its
 * lines, which is exactly what this heuristic fires on — at high / 0.75. In a
 * COLLABORATIVE scope the event's content-derived classification decides:
 *
 *  - `git_merge_in` — the post-change bytes are byte-identical to a state a
 *    provably different verified contributor recorded on this path. The
 *    replacement happened, and it was the partner's work; no flag. The event
 *    remains in the index and in the classification, visible and countable.
 *  - `git_unrecorded_in` — flagged, unchanged in severity and confidence, with
 *    the classification named. A wholesale replacement by content nobody
 *    recorded is precisely the case worth a grader's attention.
 *  - `external` / `unclassified` — flagged exactly as before.
 *
 * A SOLO scope produces no verdicts, so behaviour there is unchanged.
 *
 * ## D16 does not reach this heuristic
 *
 * D16 stops the recorder's `explanation: 'git'` tag suppressing a
 * `git_unrecorded_in`. This heuristic has never read `explanation` at all — a
 * tagged mass replacement always produced a flag here — so there is nothing to
 * override and no behaviour change. That is deliberate, not an oversight: the
 * tag is timing-derived and this heuristic's evidence is content, so consulting
 * it would be a regression rather than consistency. `mass_external_replacement.
 * test.ts` pins it.
 */

import { diffLines } from 'diff';
import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import { establishedReplayState } from './reconstruction-gate.js';
import {
  externalChangeClassificationFor,
  describeClassification,
} from '../index/classify-external-changes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count shared (unchanged) lines between two text strings via diffLines().
 * Returns 0 when either string is empty.
 */
function sharedLineCount(textA: string, textB: string): number {
  if (textA.length === 0 || textB.length === 0) return 0;
  const parts = diffLines(textA, textB);
  let shared = 0;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      shared += part.count ?? 0;
    }
  }
  return shared;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function flagId(seqKey: string, idx: number): string {
  return `mass_external_replacement-${seqKey}-${idx}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function getFilePath(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  return typeof p['path'] === 'string' ? (p['path'] as string) : undefined;
}

/**
 * Find the first globalIdx of a content-modifying event (doc.change or paste)
 * strictly after `afterGlobalIdx` for a given file. Returns undefined if none found.
 */
function firstContentEventAfter(
  index: EventIndex,
  filePath: string,
  afterGlobalIdx: number,
): number | undefined {
  const fileEvents = index.byFile.get(filePath) ?? [];
  for (const e of fileEvents) {
    if (e.globalIdx <= afterGlobalIdx) continue;
    if (e.kind === 'doc.change' || e.kind === 'paste') {
      return e.globalIdx;
    }
  }
  return undefined;
}

/**
 * Find the next globalIdx of a doc.save event strictly after `afterGlobalIdx`
 * in the same session. Returns undefined if none found.
 */
function nextSaveAfter(
  index: EventIndex,
  filePath: string,
  sessionId: string,
  afterGlobalIdx: number,
): number | undefined {
  const fileEvents = index.byFile.get(filePath) ?? [];
  for (const e of fileEvents) {
    if (e.globalIdx <= afterGlobalIdx) continue;
    if (e.sessionId !== sessionId) continue;
    if (e.kind === 'doc.save') {
      return e.globalIdx;
    }
  }
  return undefined;
}

function run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[] {
  const threshold = config.massExternalReplacement.sharedThreshold;

  const externalEvents = index.byKind.get('fs.external_change') ?? [];
  if (externalEvents.length === 0) return [];

  const classification = externalChangeClassificationFor(bundle, index);

  // Cache reconstructed content at specific globalIdx boundaries.
  // `null` = no established content at that boundary (Tier 2.2). This
  // heuristic's polarity is fail-DANGEROUS — a small overlap ratio is what
  // FIRES it — so an unestablished content would manufacture a high-severity
  // "mass replacement" rather than merely miss one. The caller must skip.
  const reconstructionCache = new Map<string, string | null>();

  function getContentAt(filePath: string, upToGlobalIdx: number): string | null {
    const cacheKey = `${filePath}:${upToGlobalIdx}`;
    const cached = reconstructionCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const state = establishedReplayState(index, bundle, filePath, upToGlobalIdx);
    const content = state === null ? null : state.content;
    reconstructionCache.set(cacheKey, content);
    return content;
  }

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const e of externalEvents) {
    const filePath = getFilePath(e.payload);
    if (filePath === undefined) continue;

    // D1: the recorder reporting the editor's own save -- never a replacement.
    if (index.selfInflictedExternalChanges?.has(e.globalIdx)) continue;

    // Tier 3.1: git delivered a partner's recorded state. The file really was
    // replaced, and by their work -- not by an external actor. Skipped here
    // only; the event stays in the index and in the classification.
    if (classification.gitMergeIn.has(e.globalIdx)) continue;

    // No inline post-change content (a file over the recorder's inline cap, so it stored only
    // head/tail) means the overlap ratio is not computable and this heuristic
    // MUST NOT guess. It previously appeared to work here only as a side effect
    // of reconstruction zeroing its content on such events, which made overlap
    // trivially 0 and produced a HIGH "mass replacement" flag for EVERY
    // unseeable external write -- 14 of them on a single clean submission.
    //
    // `external_edits` still reports that an external write occurred, so the
    // event stays visible; we just stop asserting what it did without evidence.
    // Raising MAX_INLINE_BYTES in the recorders is what restores detection here.
    const payload = e.payload as Record<string, unknown> | null;
    if (typeof payload?.['new_content'] !== 'string') continue;

    // Pre-change content: reconstruct up to (but not including) this event.
    const preContent = getContentAt(filePath, e.globalIdx);

    // If we have no pre-content at all (empty before first save, tainted, or —
    // Tier 2.2 — two contributors' edits unordered at this cut), skip: we cannot
    // compute a meaningful overlap ratio, and a small ratio is what FIRES this
    // flag, so a guess here is a high-severity accusation rather than a miss.
    if (preContent === null || preContent.length === 0) continue;

    // Liveness check: there must be a subsequent doc.save in the same session.
    // This prevents flagging on stale external changes that the user never accepted.
    const savePastExternal = nextSaveAfter(index, filePath, e.sessionId, e.globalIdx);
    if (savePastExternal === undefined) continue;

    // Post-change content: reconstruct up to and including the first
    // content-modifying event (doc.change or paste) after the external_change.
    // This captures the post-external-change state (the content that the next
    // content event establishes), avoiding inflation from subsequent user typing.
    // If there's no content event after external_change, reconstruct immediately
    // after external_change (which will be empty/tainted), and we'll skip below.
    const firstContentGi = firstContentEventAfter(index, filePath, e.globalIdx);
    const postGlobalIdx = (firstContentGi ?? e.globalIdx) + 1;
    const postContent = getContentAt(filePath, postGlobalIdx);

    if (postContent === null || postContent.length === 0) continue;

    const oldLines = lineCount(preContent);
    const newLines = lineCount(postContent);
    const denominator = Math.max(oldLines, newLines);
    if (denominator === 0) continue;

    const shared = sharedLineCount(preContent, postContent);
    const ratio = shared / denominator;

    if (ratio >= threshold) continue; // not a mass replacement

    const seqKey = `${e.sessionId}:${e.seq}`;
    const id = flagId(seqKey, flagIndex++);

    // Tier 3.1. Empty for a solo scope and for `external` — those descriptions
    // and details are byte-for-byte what they were.
    const verdict = classification.byGlobalIdx.get(e.globalIdx) ?? null;

    flags.push({
      id,
      heuristic: 'mass_external_replacement',
      title: `Mass external replacement of ${filePath}`,
      severity: 'high',
      confidence: 0.75,
      supportingSeqs: [seqKey],
      description:
        `An external change to ${filePath} replaced ${Math.round((1 - ratio) * 100)}% ` +
        `of the file's lines (${shared}/${denominator} lines shared with post-change content).` +
        describeClassification(verdict),
      detail: {
        filePath,
        sharedLines: shared,
        oldLines,
        newLines,
        overlapRatio: ratio,
        threshold,
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

  return flags;
}

export const massExternalReplacementHeuristic: Heuristic = {
  id: 'mass_external_replacement',
  label: 'Mass external replacement',
  run,
};
