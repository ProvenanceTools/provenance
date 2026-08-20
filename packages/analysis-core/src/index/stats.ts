/**
 * computeStats — per-file and bundle-level aggregates (Phase 3).
 *
 * PRD §7.3, §7.4.
 *
 * Pure function over EventIndex. No side effects, no I/O.
 */

import type { Bundle } from '../loader/types.js';
import type { EventIndex } from './event-index.js';
import { reconstructFile } from './reconstruct-file.js';
import {
  determinateValue,
  reconstructFileSegmented,
  reconstructionScopeFor,
} from './reconstruct-segments.js';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type FileStats = {
  filePath: string;
  /** Sum of inserted character counts across all doc.change events. */
  charsTyped: number;
  /**
   * Sum of paste lengths. Uses the `length` field from the PastePayload
   * (always present, even for large pastes where content is omitted).
   */
  charsPasted: number;
  /**
   * Sum of |new_size - old_size| deltas for fs.external_change events.
   * Uses `diff_size` from the payload (PRD §4.5), which is the absolute
   * difference in character counts. When the field is absent or not a number,
   * falls back to 0 for that event.
   */
  charsExternalChangeDelta: number;
  /** Count of doc.save events for this file. */
  saves: number;
  /** True if reconstructFile reported tainted (large paste or external change). */
  reconstructionTainted: boolean;
  /**
   * Set when reconstruction has no single truth for this file (Tier 2.2):
   * `'concurrent'` — two contributors' edits are unordered here; `'unknown'` —
   * the happens-before relation does not cover these events.
   *
   * Distinct from {@link FileStats.reconstructionTainted}, which means "we have
   * one content and it is best-effort". This means "there is no one content", a
   * different fact that a grader must be told apart from the other. Absent for
   * the overwhelmingly common determinate case, so a solo bundle's stats object
   * is unchanged.
   *
   * `reconstructionTainted` is ALSO set whenever this is set, deliberately: it
   * is the existing gate every content heuristic already honours, so a file with
   * no established content is suppressed even in a consumer that predates this
   * field and knows nothing about it. Failing toward suppression is correct
   * here — the alternative is a finding against a named student derived from a
   * file state that never existed.
   */
  reconstructionAmbiguity?: 'concurrent' | 'unknown';
};

export type TerminalOpenDuration = {
  terminalId: string;
  /** Wall-clock milliseconds the terminal was open, or null if still open. */
  openMs: number | null;
};

export type BundleStats = {
  perFile: Map<string, FileStats>;
  /**
   * Total active milliseconds across the bundle.
   * "Active" = gap between consecutive events is < IDLE_THRESHOLD_MS.
   */
  totalActiveMs: number;
  /**
   * Total idle milliseconds across the bundle.
   * "Idle" = gap between consecutive events is >= IDLE_THRESHOLD_MS.
   */
  totalIdleMs: number;
  /** Per-terminal open durations. Paired terminal.open / terminal.close events. */
  terminalOpenDurations: TerminalOpenDuration[];
  sessionCount: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Gap threshold separating "active" from "idle" intervals.
 * Two consecutive events separated by less than this are counted as active;
 * >= this threshold is idle. 60s is the plan's spec; it is not in the PRD.
 */
const IDLE_THRESHOLD_MS = 60_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse an ISO wall timestamp to ms-since-epoch. Returns NaN on failure. */
function wallToMs(wall: string): number {
  return Date.parse(wall);
}

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------

/**
 * `bundle` is optional so that every existing caller — the server's ingest
 * stats, the analyzer's panels, hand-built test indexes — keeps compiling and
 * keeps today's behaviour. Without it the scope is solo, which is exactly the
 * pre-Tier-2.2 path. Pass it to get the concurrency-aware taint gate.
 */
export function computeStats(index: EventIndex, bundle?: Bundle): BundleStats {
  // ---------------------------------------------------------------------------
  // Per-file stats
  // ---------------------------------------------------------------------------
  const perFile = new Map<string, FileStats>();

  function getOrCreateFileStats(filePath: string): FileStats {
    let s = perFile.get(filePath);
    if (s === undefined) {
      s = {
        filePath,
        charsTyped: 0,
        charsPasted: 0,
        charsExternalChangeDelta: 0,
        saves: 0,
        reconstructionTainted: false,
      };
      perFile.set(filePath, s);
    }
    return s;
  }

  // Walk file-associated events once.
  for (const [filePath, events] of index.byFile) {
    const stats = getOrCreateFileStats(filePath);

    for (const e of events) {
      switch (e.kind) {
        case 'doc.change': {
          // Sum inserted characters across all deltas in the event.
          //
          // Recorder routes paste-shaped doc.changes (multi-delta WorkspaceEdits,
          // large replacement edits) through this event kind with
          // `source: 'paste_likely'` so reconstruction can apply the deltas
          // faithfully — but those chars did NOT come from student typing.
          // Bucket them under charsPasted instead. Older recorders (pre-1.1
          // and unconverted bundles) emit `source: 'typed'` for every
          // doc.change; treat anything other than an explicit paste_likely /
          // paste_confirmed value as typed.
          const p = e.payload as Record<string, unknown> | null;
          const source = typeof p?.['source'] === 'string' ? (p['source'] as string) : 'typed';
          const isPasteSourced = source === 'paste_likely' || source === 'paste_confirmed';
          const deltas = p?.['deltas'];
          if (Array.isArray(deltas)) {
            for (const delta of deltas as Array<{ text?: unknown }>) {
              if (typeof delta.text === 'string') {
                if (isPasteSourced) {
                  stats.charsPasted += delta.text.length;
                } else {
                  stats.charsTyped += delta.text.length;
                }
              }
            }
          }
          break;
        }

        case 'paste': {
          const p = e.payload as Record<string, unknown> | null;
          const length = p?.['length'];
          if (typeof length === 'number') {
            stats.charsPasted += length;
          }
          break;
        }

        case 'fs.external_change': {
          const p = e.payload as Record<string, unknown> | null;
          const diffSize = p?.['diff_size'];
          if (typeof diffSize === 'number') {
            stats.charsExternalChangeDelta += Math.abs(diffSize);
          }
          break;
        }

        case 'doc.save': {
          stats.saves += 1;
          break;
        }

        default:
          break;
      }
    }

    // Reconstruction taint, and — when a bundle is available to resolve
    // contributors — whether there is a single content at all.
    if (bundle === undefined) {
      stats.reconstructionTainted = reconstructFile(index, filePath).tainted;
    } else {
      const result = reconstructFileSegmented(reconstructionScopeFor(bundle, index), filePath);
      const determinate = determinateValue(result);
      if (determinate !== null) {
        stats.reconstructionTainted = determinate.tainted;
      } else {
        // No single content. Record WHICH kind of no — `concurrent` and
        // `unknown` are different facts — and set the existing taint gate so
        // that consumers which only know about taint still suppress.
        stats.reconstructionAmbiguity = result.kind === 'concurrent' ? 'concurrent' : 'unknown';
        stats.reconstructionTainted = true;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Active / idle calculation
  //
  // Walk index.ordered (chronological). For each pair of consecutive events,
  // compute the wall-time delta. If < IDLE_THRESHOLD_MS → active; else → idle.
  // ---------------------------------------------------------------------------
  let totalActiveMs = 0;
  let totalIdleMs = 0;

  for (let i = 1; i < index.ordered.length; i++) {
    const prev = index.ordered[i - 1]!;
    const curr = index.ordered[i]!;
    const deltaMs = wallToMs(curr.wall) - wallToMs(prev.wall);

    if (isNaN(deltaMs) || deltaMs < 0) continue; // malformed wall — skip

    if (deltaMs < IDLE_THRESHOLD_MS) {
      totalActiveMs += deltaMs;
    } else {
      totalIdleMs += deltaMs;
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal open durations
  //
  // Pair terminal.open / terminal.close events by terminal_id.
  // Terminals still open at the end of the bundle get openMs = null.
  // ---------------------------------------------------------------------------
  const terminalOpenDurations: TerminalOpenDuration[] = [];
  const openTerminals = new Map<string, number>(); // terminalId → openWallMs

  const terminalOpenEvents = index.byKind.get('terminal.open') ?? [];

  // terminal.close is mentioned in PRD §4.4 but is not yet in the EventKindMap
  // (log-core v1 only has terminal.open + terminal.command). We use a cast here
  // so that when log-core adds terminal.close in the future, this code
  // automatically benefits without a Phase 3 re-open. If the kind is absent,
  // byKind.get returns undefined and we fall back to [].
  const terminalCloseEvents =
    (index.byKind as Map<string, typeof index.ordered>).get('terminal.close') ?? [];

  // Build a map from terminalId → sorted close wall times.
  const closeByTerminalId = new Map<string, number[]>();
  for (const e of terminalCloseEvents) {
    const p = e.payload as Record<string, unknown> | null;
    const terminalId = typeof p?.['terminal_id'] === 'string' ? p['terminal_id'] : undefined;
    if (terminalId === undefined) continue;
    const wallMs = wallToMs(e.wall);
    if (isNaN(wallMs)) continue;
    let arr = closeByTerminalId.get(terminalId);
    if (arr === undefined) {
      arr = [];
      closeByTerminalId.set(terminalId, arr);
    }
    arr.push(wallMs);
  }
  // Sort each terminal's close times ascending so we can match in order.
  for (const arr of closeByTerminalId.values()) {
    arr.sort((a, b) => a - b);
  }
  const closeByTerminalIdCursor = new Map<string, number>(); // cursor into the sorted arrays

  for (const e of terminalOpenEvents) {
    const p = e.payload as Record<string, unknown> | null;
    const terminalId = typeof p?.['terminal_id'] === 'string' ? p['terminal_id'] : undefined;
    if (terminalId === undefined) continue;

    const openWallMs = wallToMs(e.wall);
    if (isNaN(openWallMs)) continue;

    // Find the next close for this terminal after this open.
    const closes = closeByTerminalId.get(terminalId);
    const cursor = closeByTerminalIdCursor.get(terminalId) ?? 0;
    let matched = false;

    if (closes !== undefined) {
      for (let ci = cursor; ci < closes.length; ci++) {
        const closeMs = closes[ci]!;
        if (closeMs >= openWallMs) {
          terminalOpenDurations.push({ terminalId, openMs: closeMs - openWallMs });
          closeByTerminalIdCursor.set(terminalId, ci + 1);
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      // Terminal still open (no matching close found).
      openTerminals.set(terminalId, openWallMs);
      terminalOpenDurations.push({ terminalId, openMs: null });
    }
  }

  return {
    perFile,
    totalActiveMs,
    totalIdleMs,
    terminalOpenDurations,
    sessionCount: index.bySessionId.size,
  };
}
