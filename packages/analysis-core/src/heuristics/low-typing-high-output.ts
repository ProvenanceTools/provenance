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
 *   deltaLength   = finalLength - startLength
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
 * This heuristic reads `doc.open`, which a course can switch off via
 * `policy.capture.doc_open_close`, and it is nonetheless NOT policy-gated —
 * deliberately, and the reason is worth recording so the next audit does not
 * "fix" it.
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
import { reconstructFile } from '../index/reconstruct-file.js';

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

function run(index: EventIndex, _bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { minRatio, highRatio, minCharsForConfidence } = config.lowTypingHighOutput;

  const bundleStats = computeStats(index);

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const [filePath, fileStats] of bundleStats.perFile) {
    // Skip tainted files — reconstruction is unreliable.
    if (fileStats.reconstructionTainted) continue;

    const charsTyped = fileStats.charsTyped;

    // Get the reconstructed final content length.
    const reconstruction = reconstructFile(index, filePath);
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

    const deltaLength = finalLength - startLength;

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
        `vs ${charsTyped} chars typed.`,
      detail: {
        filePath,
        charsTyped,
        startLength,
        finalLength,
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
