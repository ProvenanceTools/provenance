/**
 * external-change-content.ts — pure helper that fills the inline-content
 * fields on FsExternalChangePayload.
 *
 * Mirrors the paste-payload truncation pattern (PRD §4.3 last paragraph):
 * inline the full text up to MAX_INLINE_BYTES, otherwise store head + tail +
 * size. Lets the analyzer reseed reconstruction after an external write so the
 * replay UI can show the post-change file (PRD §4.5 / §7.2).
 *
 * The caps now live in inline-content-limits.ts, shared with paste-payload.ts
 * and doc-events.ts; they are re-exported here so existing importers (and the
 * tests that pin the boundary) keep working.
 */

import { MAX_INLINE_BYTES, HEAD_TAIL_BYTES } from './inline-content-limits.js';

export { MAX_INLINE_BYTES, HEAD_TAIL_BYTES };

export type ExternalChangeContentFields = {
  new_content_size: number;
  /** Full post-change content if size <= MAX_INLINE_BYTES. */
  new_content?: string;
  /** First HEAD_TAIL_BYTES chars if size > MAX_INLINE_BYTES. */
  new_content_head?: string;
  /** Last HEAD_TAIL_BYTES chars if size > MAX_INLINE_BYTES. */
  new_content_tail?: string;
};

/**
 * Build the content fields for an fs.external_change payload.
 *
 * `new_content_size` is the UTF-8 byte length of `text` (Buffer.byteLength,
 * not string.length — multi-byte codepoints count as more than one byte).
 * Either `new_content` is set (small file) or `new_content_head` +
 * `new_content_tail` are set (large file), never both.
 *
 * The size cap is the ONLY thing that suppresses content. There was briefly a
 * `policy.capture.inline_content` knob that stripped the snippet at any size; it
 * was removed for the reason set out in `log-core/src/policy.ts` (program spec
 * §4) — a course must not be able to make the system more accusatory.
 */
export function buildExternalChangeContent(text: string): ExternalChangeContentFields {
  const byteLength = Buffer.byteLength(text, 'utf8');

  if (byteLength <= MAX_INLINE_BYTES) {
    return {
      new_content_size: byteLength,
      new_content: text,
    };
  }

  return {
    new_content_size: byteLength,
    new_content_head: text.slice(0, HEAD_TAIL_BYTES),
    new_content_tail: text.slice(-HEAD_TAIL_BYTES),
  };
}
