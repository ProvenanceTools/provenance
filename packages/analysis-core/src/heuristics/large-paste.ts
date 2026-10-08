/**
 * large_paste heuristic (Phase 4, extended in recorder v1.2).
 *
 * PRD §7.4: "Single paste with text length ≥ 200 chars or ≥ 10 lines."
 *
 * Emits one Flag per qualifying paste-shaped insertion. Severity escalates
 * to high when the paste exceeds the high-severity thresholds (500 chars or
 * 30 lines by default — see config.ts for the rubric).
 *
 * Iterates `iterateCandidatePastes(index)` rather than `index.byKind.get('paste')`
 * so we catch BOTH:
 *   - native `paste` events (single-delta empty-range pastes — the classical
 *     clipboard shape), and
 *   - `doc.change` events with `source: 'paste_likely' | 'paste_confirmed'`,
 *     which recorder v1.2's broadened classifier uses for multi-delta
 *     WorkspaceEdits and large replacement edits typical of AI-assistant
 *     "Apply" actions (Claude Code, Copilot, etc.).
 *
 * Confidence is 0.8 for normal candidates. If a candidate is temporally
 * adjacent to a paste.anomaly event (within the same session's event stream),
 * confidence is reduced to 0.6 because the paste detection is less reliable
 * in that context (paste.anomaly fires when the recorder's paste detection
 * heuristics had low confidence themselves).
 *
 * paste.anomaly adjacency rule:
 *   A candidate C is "in an anomaly window" if any paste.anomaly event in the
 *   SAME session has |t_C - t_anomaly| ≤ 5000ms.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic, Severity } from './types.js';
import type { HeuristicConfig } from './config.js';
import { reviewedPathPredicate } from './reviewed-scope.js';
import { iterateCandidatePastes } from './candidate-pastes.js';
import { classifyInternalMoves } from './internal-move.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a set of session-local `t` windows occupied by paste.anomaly events
 * (keyed by sessionId).
 *
 * We index these up front so the paste-event loop is O(1) per paste.
 */
function buildAnomalyWindows(index: EventIndex): Map<string, number[]> {
  const bySession = new Map<string, number[]>();
  const anomalyEvents = index.byKind.get('paste.anomaly') ?? [];
  for (const e of anomalyEvents) {
    let arr = bySession.get(e.sessionId);
    if (arr === undefined) {
      arr = [];
      bySession.set(e.sessionId, arr);
    }
    arr.push(e.t);
  }
  return bySession;
}

const ANOMALY_WINDOW_MS = 5000;
const ANOMALY_CONFIDENCE = 0.6;
const NORMAL_CONFIDENCE = 0.8;

function isInAnomalyWindow(t: number, anomalyTs: number[] | undefined): boolean {
  if (anomalyTs === undefined || anomalyTs.length === 0) return false;
  return anomalyTs.some((at) => Math.abs(t - at) <= ANOMALY_WINDOW_MS);
}

// ---------------------------------------------------------------------------
// Flag ID construction (deterministic, no Math.random / Date.now)
// ---------------------------------------------------------------------------

function flagId(seq0: string, index: number): string {
  return `large_paste-${seq0}-${index}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { minChars, minLines, highSeverityChars, highSeverityLines } = config.largePaste;

  const anomalyWindows = buildAnomalyWindows(index);
  const moves = classifyInternalMoves(index, config);

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const c of iterateCandidatePastes(index, reviewedPathPredicate(bundle))) {
    // `length` is authoritative — present even when content was omitted (paste
    // events that exceeded the recorder's inline cap).
    const length = c.length;

    // Line count: count newlines in `content` if available. When the content
    // wasn't inlined (large paste only), we can't infer line count reliably
    // and rely on the char threshold alone.
    const lines = c.content !== undefined ? c.content.split('\n').length : 0;

    // Check threshold. We flag on either chars OR lines.
    const meetsCharThreshold = length >= minChars;
    const meetsLineThreshold = lines >= minLines;
    if (!meetsCharThreshold && !meetsLineThreshold) continue;

    // Severity: escalate if either high-severity threshold is met.
    const baseSeverity: Severity =
      length >= highSeverityChars || lines >= highSeverityLines ? 'high' : 'medium';

    // Confidence: reduced if inside a paste.anomaly window.
    const anomalyTs = anomalyWindows.get(c.sessionId);
    const confidence = isInAnomalyWindow(c.t, anomalyTs) ? ANOMALY_CONFIDENCE : NORMAL_CONFIDENCE;

    const id = flagId(c.seqKey, flagIndex++);

    const lineInfo = lines > 0 ? `, ${lines} lines` : '';
    const sourceDescriptor =
      c.origin === 'paste' ? 'A paste' : 'A paste-shaped bulk edit (doc.change/paste_likely)';

    // An internal move is the student relocating their own previously-typed
    // code. Keep the record — evidence is never destroyed — but drop it to
    // 'info', which scores 0 under the default severity weights and so leaves
    // the ranked queue. `heuristic` deliberately stays 'large_paste' so per-flag
    // weights, severity roll-ups, and cross-flag counting keep working.
    const move = moves.get(c.ordinal);
    const isMove = move !== undefined && move.classification === 'internal_move';
    const movedAcrossFiles = isMove && move.sourcePath !== undefined && move.sourcePath !== c.path;

    flags.push({
      id,
      heuristic: 'large_paste',
      title: isMove
        ? movedAcrossFiles
          ? `Code moved from ${move.sourcePath} into ${c.path}`
          : `Code moved within ${c.path}`
        : `Large paste in ${c.path}`,
      severity: isMove ? 'info' : baseSeverity,
      confidence,
      supportingSeqs: [c.seqKey],
      description: isMove
        ? `${length} characters${lineInfo} were relocated into ${c.path} from the student's own ` +
          `previously-typed code in ${move.sourcePath}. Not treated as an external paste.`
        : `${sourceDescriptor} of ${length} characters${lineInfo} was detected in ${c.path}.`,
      detail: {
        path: c.path,
        charCount: length,
        lineCount: lines > 0 ? lines : null,
        inAnomalyWindow: isInAnomalyWindow(c.t, anomalyTs),
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

export const largePasteHeuristic: Heuristic = {
  id: 'large_paste',
  label: 'Large paste',
  run,
};
