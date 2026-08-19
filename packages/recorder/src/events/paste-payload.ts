/**
 * Paste payload builder — PRD §4.2 paste row + §4.3.
 *
 * Stores full pasted text up to MAX_INLINE_BYTES inline; for larger pastes
 * stores a hash + head/tail truncation. Uses Buffer.byteLength for byte-accurate
 * length (handles multi-byte UTF-8 codepoints correctly).
 *
 * The caps live in inline-content-limits.ts, shared with external-change-content.ts
 * and doc-events.ts; they are re-exported here so existing importers (and the
 * tests that pin the boundary) keep working.
 *
 * A `paste` event is NOT duplicated by a `doc.change`, so whatever is dropped
 * here is dropped from reconstruction and from the paste heuristics for good.
 *
 * @noble/hashes is in the approved dependency list (CLAUDE.md boundary).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { MAX_INLINE_BYTES, HEAD_TAIL_BYTES } from './inline-content-limits.js';

export { MAX_INLINE_BYTES, HEAD_TAIL_BYTES };

export type PastePayloadFields = {
  length: number;
  sha256: string;
  /** Full text inline if <= MAX_INLINE_BYTES bytes. */
  content?: string;
  /** Head of text if > MAX_INLINE_BYTES. First HEAD_TAIL_BYTES chars. */
  content_head?: string;
  /** Tail of text if > MAX_INLINE_BYTES. Last HEAD_TAIL_BYTES chars. */
  content_tail?: string;
};

/**
 * Build the paste payload fields for a pasted string.
 *
 * length: UTF-8 byte length (Buffer.byteLength, not string.length).
 * sha256: hex sha256 of the text (64-char lowercase hex string).
 * content: set when length <= MAX_INLINE_BYTES.
 * content_head / content_tail: set when length > MAX_INLINE_BYTES.
 *   Uses character slices (not byte slices) to avoid splitting multi-byte codepoints.
 *
 * The size cap is the ONLY thing that suppresses content. There was briefly a
 * `policy.capture.inline_content` knob that stripped the snippet at any size;
 * it was removed because `internal_move` reads paste content to DOWNGRADE a
 * `large_paste` flag, so stripping it made the system more likely to falsely
 * accuse a student relocating their own code (program spec §4).
 */
export function buildPastePayload(text: string): PastePayloadFields {
  const byteLength = Buffer.byteLength(text, 'utf8');
  const hashHex = bytesToHex(sha256(new TextEncoder().encode(text)));

  if (byteLength <= MAX_INLINE_BYTES) {
    return {
      length: byteLength,
      sha256: hashHex,
      content: text,
    };
  }

  return {
    length: byteLength,
    sha256: hashHex,
    content_head: text.slice(0, HEAD_TAIL_BYTES),
    content_tail: text.slice(-HEAD_TAIL_BYTES),
  };
}
