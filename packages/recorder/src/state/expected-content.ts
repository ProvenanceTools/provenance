/**
 * ExpectedContent — in-memory model of a file's current content.
 * Used as the foundation for external-change detection (Phase 7).
 *
 * The "streaming" aspect is per-file hash tracking; we recompute SHA-256
 * from the full content on each access (memoized, invalidated on change).
 * Full recompute is fine for typical assignment file sizes (kilobytes).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------
// Delta shape (mirrors vscode.TextDocumentContentChangeEvent geometry)
// ---------------------------------------------------------------------------

export type Delta = {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  text: string;
};

// ---------------------------------------------------------------------------
// Recent-state ring
// ---------------------------------------------------------------------------

/**
 * How many recent buffer-content hashes to retain per watched file.
 *
 * This is the tolerance window for "the disk holds a state this buffer genuinely
 * passed through" (see `hasRecentHash`). It is a *count* of states rather than a
 * time window on purpose: a count needs no clock, so the model stays pure and
 * deterministic under test, and it degrades correctly for both fast and slow
 * typists (a slow typist simply covers more wall-clock time with the same ring).
 *
 * 32 states is comfortably more than the number of keystrokes that can land
 * between VS Code physically writing the file and our asynchronous read of it
 * completing (typically one, occasionally a handful at burst typing speed),
 * while staying trivially small: 32 x 64 hex chars is ~2 KB per watched file.
 * Only hashes are retained — never content.
 *
 * Mirrored by `RECENT_STATE_WINDOW` in
 * `analysis-core/src/validation/verify-doc-save-hashes.ts` (check 7), which
 * accepts a doc.save carrying any of these states. Change both together.
 */
export const RECENT_HASH_RING_SIZE = 32;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ExpectedContent {
  private _content: string;
  private _hash: string | null = null; // null = needs recompute

  /**
   * Bounded FIFO of hashes this model has held, oldest first, most recent last.
   * Maintained eagerly (one sha256 per content mutation) because the states we
   * need to recognise later are exactly the intermediate ones — by the time a
   * stale disk snapshot arrives, the content that produced it is long gone.
   */
  private readonly _recentHashes: string[] = [];

  /** Construct from the initial known content of a file (typically read at doc.open). */
  constructor(initialContent: string) {
    this._content = initialContent;
    this._recordState();
  }

  /** Current full content. */
  get content(): string {
    return this._content;
  }

  /** Line count. Empty string → 0. Non-empty with no \n → 1. Trailing \n counts empty line. */
  get lineCount(): number {
    if (this._content === '') return 0;
    // Count newlines + 1
    let count = 1;
    for (let i = 0; i < this._content.length; i++) {
      if (this._content[i] === '\n') count++;
    }
    return count;
  }

  /** Current hex sha256 of the full content. Memoized; invalidated by applyDelta/reset. */
  get hash(): string {
    if (this._hash === null) {
      this._hash = bytesToHex(sha256(new TextEncoder().encode(this._content)));
    }
    return this._hash;
  }

  /**
   * Whether `hash` is one of the recent content states this model has held.
   *
   * External-change detection uses this to tell "the editor's own write, which we
   * observed after a later keystroke already moved the model on" from "something
   * outside the editor wrote this file". A disk snapshot whose hash appears here
   * is a state the buffer genuinely passed through, so the write was ours.
   */
  hasRecentHash(hash: string): boolean {
    return this._recentHashes.includes(hash);
  }

  /** Apply a single doc.change delta. Updates content + invalidates cached hash. */
  applyDelta(delta: Delta): void {
    this._applyDeltaInPlace(delta);
    this._recordState();
  }

  /**
   * Apply many deltas in order.
   *
   * Only the resulting state is recorded in the recent-hash ring: the states
   * between deltas of a single change event were never observable as buffer
   * content, so they must not widen the tolerance window.
   */
  applyDeltas(deltas: ReadonlyArray<Delta>): void {
    for (const delta of deltas) {
      this._applyDeltaInPlace(delta);
    }
    this._recordState();
  }

  /** Replace content entirely (e.g., after fs.external_change reconciliation). */
  reset(content: string): void {
    this._content = content;
    this._hash = null;
    this._recordState();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Mutate content by one delta without touching the recent-hash ring. */
  private _applyDeltaInPlace(delta: Delta): void {
    const { startOffset, endOffset } = this._resolveRange(delta.range);
    this._content =
      this._content.slice(0, startOffset) + delta.text + this._content.slice(endOffset);
    this._hash = null;
  }

  /** Push the current hash onto the bounded recent-state ring. */
  private _recordState(): void {
    const current = this.hash; // computes + memoizes, so `hash` reads stay free
    if (this._recentHashes[this._recentHashes.length - 1] === current) {
      // No-op change (e.g. an empty delta list) — don't consume a ring slot.
      return;
    }
    this._recentHashes.push(current);
    if (this._recentHashes.length > RECENT_HASH_RING_SIZE) {
      this._recentHashes.shift();
    }
  }

  /**
   * Convert a {line, character} range to {startOffset, endOffset} in the content string.
   * Newlines are \n. Clamps defensively to valid bounds.
   */
  private _resolveRange(range: Delta['range']): { startOffset: number; endOffset: number } {
    return {
      startOffset: this._positionToOffset(range.start),
      endOffset: this._positionToOffset(range.end),
    };
  }

  private _positionToOffset(pos: { line: number; character: number }): number {
    const content = this._content;
    let line = 0;
    let i = 0;

    // Advance line-by-line
    while (i < content.length && line < pos.line) {
      if (content[i] === '\n') line++;
      i++;
    }

    // Now add character offset, clamped to end of line / end of content
    const remaining = content.length - i;
    const charOffset = Math.min(pos.character, remaining);
    return i + charOffset;
  }
}
