/**
 * idle_then_complete heuristic (Phase 16).
 *
 * PRD §7.4 process-shape: "idle >10min then a single save brings file from
 * skeleton to complete."
 *
 * Definitions:
 *   - "Idle gap": the time between two consecutive session.heartbeat events
 *     exceeds idleGapMs (default: 600000ms = 10 minutes). We measure idle gaps
 *     via session.heartbeat `t` values within the same session (t is session-
 *     local monotonic). Heartbeat gaps > idleGapMs indicate the user was
 *     absent.
 *   - "Skeleton": the file's content just before the idle gap started is
 *     < sizeRatio (default: 0.5 = 50%) of the file's final character count.
 *     We measure this at the `t` of the last heartbeat before the gap (the
 *     `gapStart` heartbeat), using the last file event with t ≤ gapStart.
 *   - "Complete": the save's sha256 matches the file's final recorded save
 *     hash (i.e., no further content-changing events after this save).
 *
 * Algorithm:
 *   For each (session, idle gap) pair where gap > idleGapMs:
 *     1. Find doc.save events in that session with t in [gapEnd, gapEnd + 60s].
 *     2. For each such save that is the final save for its file:
 *        a. Reconstruct file content just before the gap (at globalIdx of the
 *           last file event with t ≤ gapStart heartbeat's t).
 *        b. If that pre-gap content < sizeRatio × finalLength → flag.
 *
 * Severity: high. Confidence: 0.8.
 */

import type { EventIndex, IndexedEvent } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import { establishedReplayState } from './reconstruction-gate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(seqKey: string, idx: number): string {
  return `idle_then_complete-${seqKey}-${idx}`;
}

/**
 * A detected idle gap: the heartbeat period before and after the gap.
 */
type IdleGap = {
  gapStartT: number; // t of the last heartbeat before the gap
  gapEndT: number; // t of the first heartbeat after the gap
};

/**
 * Build a map: sessionId → sorted list of heartbeat events (by t).
 */
function buildHeartbeatsBySession(index: EventIndex): Map<string, IndexedEvent[]> {
  const result = new Map<string, IndexedEvent[]>();
  const heartbeats = index.byKind.get('session.heartbeat') ?? [];
  for (const e of heartbeats) {
    let arr = result.get(e.sessionId);
    if (arr === undefined) {
      arr = [];
      result.set(e.sessionId, arr);
    }
    arr.push(e);
  }
  return result;
}

/**
 * Find idle gaps in a session's heartbeat sequence.
 * Returns pairs of (gapStartT, gapEndT) where the gap exceeds idleGapMs.
 */
function findIdleGaps(heartbeats: IndexedEvent[], idleGapMs: number): IdleGap[] {
  const gaps: IdleGap[] = [];
  for (let i = 1; i < heartbeats.length; i++) {
    const prev = heartbeats[i - 1]!;
    const curr = heartbeats[i]!;
    if (curr.t - prev.t > idleGapMs) {
      gaps.push({ gapStartT: prev.t, gapEndT: curr.t });
    }
  }
  return gaps;
}

/**
 * Find the globalIdx of the last file event for `filePath` in `sessionId`
 * with t ≤ maxT. Returns undefined if no such event exists.
 */
function lastFileEventGlobalIdx(
  index: EventIndex,
  filePath: string,
  sessionId: string,
  maxT: number,
): number | undefined {
  const fileEvents = index.byFile.get(filePath) ?? [];
  let lastGi: number | undefined;
  for (const e of fileEvents) {
    if (e.sessionId !== sessionId) continue;
    if (e.t > maxT) break; // byFile is in globalIdx order = chronological within session
    lastGi = e.globalIdx;
  }
  return lastGi;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { idleGapMs, sizeRatio, postIdleWindowMs } = config.idleThenComplete;

  const saveEvents = index.byKind.get('doc.save') ?? [];
  if (saveEvents.length === 0) return [];

  const heartbeatsBySession = buildHeartbeatsBySession(index);

  // Collect save records with file path and sha256.
  type SaveRecord = { event: IndexedEvent; filePath: string; sha256: string };
  const saveRecords: SaveRecord[] = [];
  for (const e of saveEvents) {
    const p = e.payload as Record<string, unknown> | null;
    const path = typeof p?.['path'] === 'string' ? (p['path'] as string) : undefined;
    const sha256 = typeof p?.['sha256'] === 'string' ? (p['sha256'] as string) : undefined;
    if (path === undefined || sha256 === undefined) continue;
    saveRecords.push({ event: e, filePath: path, sha256 });
  }
  if (saveRecords.length === 0) return [];

  // For each file: the sha256 of its last doc.save (= the "final" save hash).
  const finalSaveHash = new Map<string, string>();
  for (const r of saveRecords) {
    finalSaveHash.set(r.filePath, r.sha256); // last write wins (globalIdx order)
  }

  // Cache for final char count per file.
  // `null` = no established final content for the file (Tier 2.2).
  const finalCharCount = new Map<string, number | null>();

  // Cache for reconstruction results (keyed by filePath:upToGlobalIdx).
  // `null` = no established content at that boundary (Tier 2.2), so the
  // "skeleton before the gap, complete file after" ratio has no operand.
  const reconstructionCache = new Map<string, number | null>();

  function getContentLengthAt(filePath: string, upToGlobalIdx: number): number | null {
    const key = `${filePath}:${upToGlobalIdx}`;
    const cached = reconstructionCache.get(key);
    if (cached !== undefined) return cached;
    const state = establishedReplayState(index, bundle, filePath, upToGlobalIdx);
    const length = state === null ? null : state.content.length;
    reconstructionCache.set(key, length);
    return length;
  }

  const flags: Flag[] = [];
  let flagIndex = 0;

  // Build a lookup: (sessionId, filePath) → saves, sorted by t.
  // Using the saveRecords which are in globalIdx order.
  const savesBySessionFile = new Map<string, SaveRecord[]>();
  for (const r of saveRecords) {
    const key = `${r.event.sessionId}:${r.filePath}`;
    let arr = savesBySessionFile.get(key);
    if (arr === undefined) {
      arr = [];
      savesBySessionFile.set(key, arr);
    }
    arr.push(r);
  }

  // Iterate: for each session × idle-gap combination.
  for (const [sessionId, heartbeats] of heartbeatsBySession) {
    if (heartbeats.length < 2) continue;

    const gaps = findIdleGaps(heartbeats, idleGapMs);
    if (gaps.length === 0) continue;

    // For each idle gap, find saves in [gapEndT, gapEndT + postIdleWindowMs].
    for (const gap of gaps) {
      // Find files with saves in the post-idle window for this session.
      for (const [key, saves] of savesBySessionFile) {
        if (!key.startsWith(`${sessionId}:`)) continue;
        const filePath = key.slice(sessionId.length + 1);

        const postIdleSave = saves.find(
          (r) => r.event.t >= gap.gapEndT && r.event.t <= gap.gapEndT + postIdleWindowMs,
        );
        if (postIdleSave === undefined) continue;

        // Check this save is the final save for the file.
        const finalHash = finalSaveHash.get(filePath);
        if (finalHash === undefined || postIdleSave.sha256 !== finalHash) continue;

        // Get final char count.
        if (!finalCharCount.has(filePath)) {
          const finalState = establishedReplayState(index, bundle, filePath);
          finalCharCount.set(filePath, finalState === null ? null : finalState.content.length);
        }
        const finalLen = finalCharCount.get(filePath);
        if (finalLen === null || finalLen === undefined || finalLen === 0) continue;

        // Get pre-gap content: reconstruct up to (but not including) the first
        // file event after gapStartT. We use the globalIdx of the last file event
        // with t ≤ gapStartT, then take upTo = that globalIdx + 1.
        const preGapGi = lastFileEventGlobalIdx(index, filePath, sessionId, gap.gapStartT);
        const upTo = preGapGi !== undefined ? preGapGi + 1 : 0;
        // `null` = no established pre-gap content (Tier 2.2). Without it the
        // skeleton ratio has no numerator, and guessing one manufactures the
        // flag rather than missing it.
        const preLen = getContentLengthAt(filePath, upTo);
        if (preLen === null) continue;

        // Skeleton check: pre-gap content < sizeRatio × final.
        if (preLen >= sizeRatio * finalLen) continue;

        // All conditions met — flag.
        const seqKey = `${postIdleSave.event.sessionId}:${postIdleSave.event.seq}`;
        const id = flagId(seqKey, flagIndex++);

        flags.push({
          id,
          heuristic: 'idle_then_complete',
          title: `File completed after idle gap: ${filePath}`,
          severity: 'high',
          confidence: 0.8,
          supportingSeqs: [seqKey],
          description:
            `After an idle period >${Math.round(idleGapMs / 60000)}min, ` +
            `${filePath} went from ${preLen} chars to ${finalLen} chars in a single save ` +
            `(skeleton threshold: ${Math.round(sizeRatio * 100)}% of final).`,
          detail: {
            filePath,
            preLength: preLen,
            finalLength: finalLen,
            sizeRatio,
            idleGapMs,
          },
        });
      }
    }
  }

  return flags;
}

export const idleThenCompleteHeuristic: Heuristic = {
  id: 'idle_then_complete',
  label: 'Idle then file completed',
  run,
};
