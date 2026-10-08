/**
 * Shared iterator for paste-content heuristics (large_paste, paste_is_solution,
 * paste_matches_known_source).
 *
 * Recorder v1.2 broadened the paste classifier (PRD §4.3) so that tool-applied
 * bulk edits — multi-delta WorkspaceEdits, large replacement edits — get
 * marked as `source: "paste_likely"` on `doc.change` events instead of being
 * routed through the `paste` event kind. That routing preserves reconstruction
 * fidelity (applyDocChange can reproduce multi-delta and non-empty-range edits
 * faithfully; applyPaste cannot), but it means the analyzer's existing
 * paste-content heuristics, which only iterate `kind === 'paste'`, miss those
 * events entirely.
 *
 * This module provides a single iterator that yields one `CandidatePaste` per
 * inserted blob, regardless of whether the recorder stored it as a `paste`
 * event or as a paste-shaped `doc.change`. The three paste-content heuristics
 * iterate this instead of `index.byKind.get('paste')` so they catch both
 * shapes consistently.
 */

import { sha256Hex } from '@provenance/log-core';
import type { Range } from '@provenance/log-core';
import type { EventIndex } from '../index/event-index.js';

/**
 * One unit of "this is a chunk of inserted text that wasn't typed".
 *
 * For native `paste` events: 1 candidate per event.
 * For paste-shaped `doc.change` events: 1 candidate per delta (a multi-delta
 *   WorkspaceEdit yields multiple candidates, each carrying the same
 *   sessionId/seq/seqKey since they came from the same envelope).
 */
export type CandidatePaste = {
  sessionId: string;
  seq: number;
  /** Stable key used in Flag.supportingSeqs. */
  seqKey: string;
  /** Monotonic ms since session start. */
  t: number;
  /** Workspace-relative file path. */
  path: string;
  /** Target range of the insertion / replacement. */
  range: Range;
  /**
   * The inserted text.
   *
   * Always present for `doc.change`-derived candidates (the recorder always
   * inlines delta text regardless of size). Absent for `paste` events that
   * exceeded the recorder's inline cap — those carry only sha256 + head/tail.
   */
  content: string | undefined;
  /**
   * Inserted character count. Authoritative even when `content` is undefined:
   *   - paste events: payload.length (recorder writes it explicitly)
   *   - doc.change deltas: text.length
   */
  length: number;
  /**
   * SHA-256 hex of the inserted text.
   *
   * Pre-populated only for native paste events (recorder writes it into the
   * payload). For doc.change-derived candidates this is undefined; callers
   * that need the hash should compute it via `sha256OfCandidate(c)`.
   */
  sha256: string | undefined;
  /** Source event kind. */
  origin: 'paste' | 'doc.change';
  /**
   * globalIdx of the source event. Used by the internal-move classifier as the
   * point-in-time key for "what did every file look like just before this".
   */
  globalIdx: number;
  /**
   * 0-based position in `iterateCandidatePastes` order. Stable across runs and
   * across consumers, because the iterator walks `index.ordered` (globalIdx
   * ascending) and yields a multi-delta event's deltas in array order.
   *
   * This is the join key between a candidate and its internal-move
   * classification. `seqKey` cannot serve: a multi-delta doc.change yields
   * several candidates that all share one seqKey.
   */
  ordinal: number;
};

/**
 * Walk `index.ordered` (globalIdx ascending) and yield candidates in event
 * time order. Yields:
 *   - one candidate per `paste` event
 *   - one candidate per delta of a `doc.change` event whose payload
 *     `source` is `'paste_likely'` or `'paste_confirmed'`
 * Other events are skipped.
 */
export function* iterateCandidatePastes(
  index: EventIndex,
  /**
   * Optional path filter (per-file heuristics pass the reviewed-scope
   * predicate). `ordinal` is assigned BEFORE filtering, so it stays the same
   * join key into `classifyInternalMoves` whether or not a filter is applied.
   */
  includePath?: (path: string) => boolean,
): Generator<CandidatePaste> {
  let ordinal = 0;
  for (const e of index.ordered) {
    if (e.kind === 'paste') {
      const p = e.payload as Record<string, unknown> | null;
      if (!p) continue;
      const path = typeof p['path'] === 'string' ? (p['path'] as string) : undefined;
      if (path === undefined) continue;
      const range = p['range'] as Range | undefined;
      if (range === undefined) continue;
      const length = typeof p['length'] === 'number' ? (p['length'] as number) : 0;
      const content = typeof p['content'] === 'string' ? (p['content'] as string) : undefined;
      const sha256 = typeof p['sha256'] === 'string' ? (p['sha256'] as string) : undefined;
      const ord = ordinal++;
      if (includePath !== undefined && !includePath(path)) continue;
      yield {
        sessionId: e.sessionId,
        seq: e.seq,
        seqKey: `${e.sessionId}:${e.seq}`,
        t: e.t,
        path,
        range,
        content,
        length,
        sha256,
        origin: 'paste',
        globalIdx: e.globalIdx,
        ordinal: ord,
      };
      continue;
    }

    if (e.kind === 'doc.change') {
      const p = e.payload as Record<string, unknown> | null;
      if (!p) continue;
      const source = typeof p['source'] === 'string' ? (p['source'] as string) : 'typed';
      if (source !== 'paste_likely' && source !== 'paste_confirmed') continue;
      const path = typeof p['path'] === 'string' ? (p['path'] as string) : undefined;
      if (path === undefined) continue;
      const deltas = p['deltas'];
      if (!Array.isArray(deltas)) continue;
      const seqKey = `${e.sessionId}:${e.seq}`;
      for (const dRaw of deltas as unknown[]) {
        if (typeof dRaw !== 'object' || dRaw === null) continue;
        const d = dRaw as { range?: unknown; text?: unknown };
        if (typeof d.text !== 'string') continue;
        const range = d.range as Range | undefined;
        if (range === undefined) continue;
        const ord = ordinal++;
        if (includePath !== undefined && !includePath(path)) continue;
        yield {
          sessionId: e.sessionId,
          seq: e.seq,
          seqKey,
          t: e.t,
          path,
          range,
          content: d.text,
          length: d.text.length,
          sha256: undefined,
          origin: 'doc.change',
          globalIdx: e.globalIdx,
          ordinal: ord,
        };
      }
    }
  }
}

/**
 * Return the candidate's sha256 hex, computing it from `content` on demand
 * for doc.change-derived candidates. Returns undefined if the candidate has
 * neither a pre-computed hash nor inline content (e.g., a paste over the recorder's inline cap whose
 * payload was empty — shouldn't happen because PastePayload always has a
 * sha256, but the type allows it).
 */
export function sha256OfCandidate(c: CandidatePaste): string | undefined {
  if (c.sha256 !== undefined) return c.sha256;
  if (c.content === undefined) return undefined;
  return sha256Hex(c.content);
}
