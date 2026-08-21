/**
 * low_typing_high_output heuristic (Phase 4).
 *
 * PRD §7.4 (literal): "(chars saved in final file) / (chars typed via doc.change
 * inserts) > 3."
 *
 * Refinement (intent-preserving — see PRD §7.6.3 example, which already
 * acknowledges the false positive this fixes): "output" is the **net delta**
 * between the file's content at first observation and its final content, NOT
 * the absolute final size. A student who opens a 500-char skeleton and adds
 * 50 chars has produced 50 chars of output — not 550. Using absolute size
 * mis-flags students for the boilerplate they didn't write.
 *
 * Effective rule:
 *
 *   startLength   = chars in file at first doc.open (or 0 if no doc.open
 *                   content was recorded — pre-v1.1 recorders, or files that
 *                   opened larger than the 64KB inline limit)
 *   finalLength   = chars in reconstructed final content
 *   mergedInChars = chars of the final content that a git merge delivered from
 *                   a provably different verified contributor's recorded work
 *                   (Tier 3.1; always 0 for a solo bundle)
 *   deltaLength   = finalLength - startLength - mergedInChars
 *
 *   If deltaLength <= 0:  no flag. Either the file shrank (refactoring,
 *                         deletion-heavy editing) or stayed the same size.
 *                         Either way there isn't a "high output" signal.
 *   Else:                 ratio = deltaLength / charsTyped (∞ when typed=0)
 *
 * Emits one Flag per offending file. The ratio is computed per file (not at
 * the bundle level) because different files may have very different ratios
 * for legitimate reasons.
 *
 * ## Tier 3.1 — a `git pull` is not this student's output
 *
 * A pull rewrites the file with nobody typing: `charsTyped = 0`, the file grows
 * by however much the partner wrote, and the ratio is infinite. That fired at
 * HIGH severity with confidence 1.0 on an honest puller — the "no false
 * accusations" row, in a shape a student cannot avoid.
 *
 * The fix is subtraction, not suppression: characters the content test proves
 * git delivered from a **provably different verified contributor's** recorded
 * work are removed from the numerator, and everything else about the file is
 * evaluated exactly as before. A student who pulls their partner's work and then
 * pastes a solution into the same file still fires — the pasted characters are
 * not merged-in ones. See `merged-in-content.ts` for why this is not decision
 * D16's timing hole (nothing here reads a clock or a recorder tag) and why a
 * solo bundle is byte-for-byte unaffected.
 *
 * Skips any file whose reconstruction is tainted (reconstructFile set
 * tainted=true due to fs.external_change or a large paste over the recorder's inline cap with no
 * inline content). In that case content cannot be reliably reconstructed.
 *
 * Severity by ratio bracket:
 *   - medium: ratio in [minRatio, highRatio)  (default: [3, 5))
 *   - high:   ratio >= highRatio              (default: >= 5)
 *
 * Confidence:
 *   Linearly interpolated from 0 (at 0 chars_typed) to 1.0 (at
 *   minCharsForConfidence chars_typed). More characters → more reliable ratio.
 *   Clamped to [0, 1].
 *
 * Edge cases:
 *   - chars_typed = 0 AND deltaLength > 0  → infinite ratio. High severity;
 *     confidence proportional to deltaLength / minCharsForConfidence.
 *   - deltaLength <= 0                     → no flag.
 *   - tainted reconstruction               → skip.
 *
 * ## Capture-policy audit (program spec §4)
 *
 * This heuristic reads `doc.open`, and is NOT policy-gated. `doc.open` is on the
 * hard floor — no `policy.capture` key can switch it off, precisely because
 * `doc.open.content` is the reconstruction seed. But the reasoning below is
 * worth keeping even so, because it is what makes this heuristic robust to
 * `doc.open` simply being MISSING (a 1.x recorder that never opened the file, a
 * truncated log), which no policy rule prevents.
 *
 * `doc.open.content` is both the heuristic's `startLength` anchor AND the seed
 * `reconstructFile` starts from. Removing it therefore removes the skeleton
 * from BOTH sides of `finalLength - startLength`, so the ratio is unchanged:
 * a 600-char skeleton the recorder never saw is absent from the final
 * reconstruction too. There is no inflation to guard against, and gating would
 * only delete real detections. (A gate here would also be strictly harmful in
 * the other direction: with `doc.open` gone, taint can never be re-anchored,
 * so affected files are skipped by the `reconstructionTainted` check anyway.)
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic, Severity } from './types.js';
import type { HeuristicConfig } from './config.js';
import { computeStats } from '../index/stats.js';
import { establishedReplayState } from './reconstruction-gate.js';
import { externalChangeClassificationFor } from '../index/classify-external-changes.js';
import { mergedInCharCount } from './merged-in-content.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function flagId(filePath: string, index: number): string {
  // Sanitize file path for use in an id: replace non-alphanum with '-'.
  const sanitized = filePath.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
  return `low_typing_high_output-${sanitized}-${index}`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { minRatio, highRatio, minCharsForConfidence } = config.lowTypingHighOutput;

  const bundleStats = computeStats(index, bundle);
  // Tier 3.1. Empty for a solo bundle — the pass does not run there.
  const { gitMergeIn } = externalChangeClassificationFor(bundle, index);

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const [filePath, fileStats] of bundleStats.perFile) {
    // Skip tainted files — reconstruction is unreliable.
    if (fileStats.reconstructionTainted) continue;

    const charsTyped = fileStats.charsTyped;

    // Tier 2.2: `null` when two contributors' edits are unordered here, so
    // there is no single final length to divide by. `reconstructionTainted`
    // above already catches this (computeStats sets it alongside
    // `reconstructionAmbiguity`); the explicit check is what keeps the skip true
    // if that coupling is ever loosened.
    const reconstruction = establishedReplayState(index, bundle, filePath);
    if (reconstruction === null) continue;
    const finalLength = reconstruction.content.length;

    // If final content is empty, there's nothing to flag.
    if (finalLength === 0) continue;

    // Determine starting length from the first doc.open event for this file.
    // Recorder v1.1+ inlines the file's initial content in the doc.open payload
    // (up to 64 KB). Pre-v1.1 events, truncated payloads, and files that never
    // received a doc.open event fall back to startLength = 0 — same behavior
    // as the original heuristic, which treated every file as starting empty.
    const fileEvents = index.byFile.get(filePath) ?? [];
    const firstOpen = fileEvents.find((e) => e.kind === 'doc.open');
    let startLength = 0;
    if (firstOpen !== undefined) {
      const op = firstOpen.payload as Record<string, unknown> | null;
      const content = op?.['content'];
      if (typeof content === 'string') {
        startLength = content.length;
      }
    }

    // Tier 3.1: characters git delivered from a partner's recorded work are not
    // this student's output, so they leave the numerator. Zero unless the scope
    // is collaborative AND the content test proved the match, so a solo bundle
    // computes exactly the number it computed before.
    const mergedInChars = mergedInCharCount(reconstruction, gitMergeIn);

    const deltaLength = finalLength - startLength - mergedInChars;

    // If the file did not grow, there's no "high output" to explain. This is
    // the key fix: a student who opens a 500-char skeleton and adds 50 chars
    // is no longer flagged for a 550/50 ratio of misattributed boilerplate.
    if (deltaLength <= 0) continue;

    let ratio: number;
    let severity: Severity;
    let confidence: number;

    if (charsTyped === 0) {
      // Infinite ratio — user typed nothing but the file grew.
      ratio = Infinity;
      severity = 'high';
      // Confidence proportional to the size of the unexplained delta.
      confidence = clamp(deltaLength / minCharsForConfidence, 0, 1);
    } else {
      ratio = deltaLength / charsTyped;

      // Only flag if ratio exceeds the minimum threshold.
      if (ratio < minRatio) continue;

      severity = ratio >= highRatio ? 'high' : 'medium';

      // Confidence: linearly interpolated from charsTyped.
      confidence = clamp(charsTyped / minCharsForConfidence, 0, 1);
    }

    // Collect the seq keys for the doc.save events on this file (best
    // supporting evidence for the ratio — shows what the final content is).
    const saveEvents = fileEvents.filter((e) => e.kind === 'doc.save');
    const supportingSeqs =
      saveEvents.length > 0 ? saveEvents.map((e) => `${e.sessionId}:${e.seq}`) : [];

    const id = flagId(filePath, flagIndex++);
    const ratioStr = isFinite(ratio) ? ratio.toFixed(2) : '∞';

    flags.push({
      id,
      heuristic: 'low_typing_high_output',
      title: `Low typing, high output in ${filePath}`,
      severity,
      confidence,
      supportingSeqs,
      description:
        `Output-to-typing ratio of ${ratioStr}× in ${filePath}: ` +
        `${deltaLength} chars added (final ${finalLength}, started ${startLength}) ` +
        `vs ${charsTyped} chars typed.` +
        // R1: the discount is stated, not silent. A grader reading the numbers
        // must be able to see why they do not add up to the file's size.
        (mergedInChars > 0
          ? ` ${mergedInChars} chars of the final content arrived by git merge from a ` +
            `partner's recorded work and are not counted as this student's output.`
          : ''),
      detail: {
        filePath,
        charsTyped,
        startLength,
        finalLength,
        mergedInChars,
        deltaLength,
        ratio: isFinite(ratio) ? ratio : null,
        tainted: false,
      },
    });
  }

  return flags;
}

export const lowTypingHighOutputHeuristic: Heuristic = {
  id: 'low_typing_high_output',
  label: 'Low typing relative to final output',
  run,
};
