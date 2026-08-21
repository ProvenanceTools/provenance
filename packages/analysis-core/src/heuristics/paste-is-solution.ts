/**
 * paste_is_solution heuristic (Phase 16, extended in recorder v1.2).
 *
 * PRD §7.4 process-shape: "Paste payload matches ≥80% of the file's final
 * state." Uses Phase 12's reconstructFileWithProvenance to obtain the final
 * file content, then runs diffLines() to compute line overlap between the
 * paste payload and the final content.
 *
 * Iterates `iterateCandidatePastes(index)` so we evaluate BOTH:
 *   - native `paste` events
 *   - `doc.change` events with `source: 'paste_likely' | 'paste_confirmed'`,
 *     one candidate per delta. Recorder v1.2's broadened classifier routes
 *     tool-applied bulk edits (Claude Code "Apply", multi-delta WorkspaceEdits)
 *     through this path; without iterating doc.change candidates those edits
 *     never trip this heuristic.
 *
 * Fires one Flag per qualifying candidate. Severity is 'high'; confidence
 * is 0.85 (high signal but paste contents could match a skeleton/boilerplate).
 *
 * Threshold: the insertion accounts for ≥80% of the FINAL FILE's lines, and at
 * least `minSharedLines` (10) lines in absolute terms. Specifically:
 *   shared_lines >= pasteIsSolution.minSharedLines            (checked first)
 *   shared_lines / final_file_lines >= pasteIsSolution.finalFileCoverage
 *
 * NOT shared_lines / paste_lines ("survival" — how much of the paste made it
 * into the file). Survival is trivially 1.0 for any small paste nobody
 * deleted, so a 3-line import block pasted onto a 60-line hand-typed file used
 * to score 1.0 and raise `high`, the most damning flag in the catalogue. The
 * claim this flag makes is "the submitted file is pasted code, not written
 * code", and coverage of the final file is the evidence for that claim.
 * Survival is still reported in `detail.survivalRatio` for the grader reading
 * the finding — informative, never load-bearing.
 *
 * Only candidates with inline content are eligible — paste events that exceed
 * the recorder's inline cap omit content and cannot be checked this way. The line
 * overlap metric counts lines that appear on BOTH sides of the diff (i.e.,
 * lines that diffLines reports as unchanged).
 */

import { diffLines } from 'diff';
import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import { establishedReplayState } from './reconstruction-gate.js';
import { iterateCandidatePastes } from './candidate-pastes.js';
import { classifyInternalMoves } from './internal-move.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the number of shared lines between two text strings using
 * diffLines(). A line is "shared" if it appears in both strings (i.e.,
 * the diff part has `count` with no added/removed flag).
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

/**
 * Count lines in a string (number of '\n'-separated segments).
 * Empty string → 0 lines (for threshold purposes).
 */
function lineCount(text: string): number {
  if (text.length === 0) return 0;
  // A string with N '\n' chars has N+1 lines.
  return text.split('\n').length;
}

function flagId(seqKey: string, idx: number): string {
  return `paste_is_solution-${seqKey}-${idx}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { finalFileCoverage, minSharedLines } = config.pasteIsSolution;
  const moves = classifyInternalMoves(index, config);

  // Cache the final state per file path to avoid re-running reconstruction.
  // `null` marks a file with no established final state (Tier 2.2). This is the
  // most damning flag in the catalogue, so "we cannot establish what the final
  // file was" must mean no flag at all rather than a flag against one branch.
  const finalStateCache = new Map<string, string | null>();

  function getFinalContent(filePath: string): string | null {
    const cached = finalStateCache.get(filePath);
    if (cached !== undefined) return cached;
    const state = establishedReplayState(index, bundle, filePath);
    const content = state === null ? null : state.content;
    finalStateCache.set(filePath, content);
    return content;
  }

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const c of iterateCandidatePastes(index)) {
    // Only candidates with inline content can be compared. Paste events that
    // exceeded the recorder's inline cap omit content; doc.change deltas always carry text.
    if (c.content === undefined || c.content.length === 0) continue;

    const finalContent = getFinalContent(c.path);
    if (finalContent === null || finalContent.length === 0) continue;

    const pasteLines = lineCount(c.content);
    if (pasteLines === 0) continue;

    const finalFileLines = lineCount(finalContent);
    if (finalFileLines === 0) continue;

    const shared = sharedLineCount(c.content, finalContent);

    // Size floor FIRST. Below it the coverage ratio is not meaningful evidence:
    // a 4-line file whose 4 lines were pasted is 100% coverage and no story.
    if (shared < minSharedLines) continue;

    const coverage = shared / finalFileLines;
    if (coverage < finalFileCoverage) continue;

    // Informative only — see the module header.
    const survivalRatio = shared / pasteLines;

    const id = flagId(c.seqKey, flagIndex++);

    const sourceDescriptor =
      c.origin === 'paste' ? 'A paste' : 'A paste-shaped bulk edit (doc.change/paste_likely)';

    // A student who types the whole solution and then reorganises it would
    // otherwise trip this at high severity — the most damning flag in the
    // catalogue — for doing nothing wrong. Downgrade, but keep the record.
    const move = moves.get(c.ordinal);
    const isMove = move !== undefined && move.classification === 'internal_move';
    const movedAcrossFiles = isMove && move.sourcePath !== undefined && move.sourcePath !== c.path;

    flags.push({
      id,
      heuristic: 'paste_is_solution',
      title: isMove
        ? movedAcrossFiles
          ? `Code moved from ${move.sourcePath} into ${c.path}`
          : `Code moved within ${c.path}`
        : `Paste matches solution in ${c.path}`,
      severity: isMove ? 'info' : 'high',
      confidence: 0.85,
      supportingSeqs: [c.seqKey],
      description: isMove
        ? `An insertion in ${c.path} accounts for ${Math.round(coverage * 100)}% of the file's ` +
          `final content (${shared} of ${finalFileLines} lines), but it is a relocation of the ` +
          `student's own previously-typed code in ${move.sourcePath}. Not treated as an external paste.`
        : `${sourceDescriptor} in ${c.path} accounts for ${Math.round(coverage * 100)}% of the ` +
          `file's final content (${shared} of ${finalFileLines} lines), suggesting the insertion ` +
          `may be the complete solution.`,
      detail: {
        filePath: c.path,
        pasteLines,
        finalFileLines,
        sharedLines: shared,
        coverageRatio: coverage,
        survivalRatio,
        coverageThreshold: finalFileCoverage,
        minSharedLines,
        origin: c.origin,
        ...(isMove
          ? {
              internalMove: {
                sourcePath: move.sourcePath,
                sourceGlobalIdx: move.sourceGlobalIdx,
                matchRatio: move.matchRatio,
                typedRatio: move.typedRatio,
                via: move.via,
              },
            }
          : {}),
      },
    });
  }

  return flags;
}

export const pasteIsSolutionHeuristic: Heuristic = {
  id: 'paste_is_solution',
  label: 'Paste matches solution',
  run,
};
