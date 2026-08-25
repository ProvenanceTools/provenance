import { describe, expect, it } from 'vitest';
import {
  buildExternalChangeContent,
  MAX_INLINE_BYTES,
  HEAD_TAIL_BYTES,
} from './external-change-content.js';

describe('buildExternalChangeContent', () => {
  it('short text: inlines new_content, no head/tail', () => {
    const text = 'def foo(): pass\n';
    const result = buildExternalChangeContent(text);
    expect(result.new_content).toBe(text);
    expect(result.new_content_head).toBeUndefined();
    expect(result.new_content_tail).toBeUndefined();
    expect(result.new_content_size).toBe(text.length);
  });

  // -------------------------------------------------------------------------
  // Cap boundary (PRD §4.5). MAX_INLINE_BYTES is 64 KB, raised from 4 KB:
  // below that, a genuine external write to any real-sized source file was
  // unrecoverable by construction — the evidence was discarded at record time,
  // so no analyzer-side fix could bring it back, and mass_external_replacement
  // could not evaluate the change at all.
  // -------------------------------------------------------------------------

  it('pins the cap at 64 KB', () => {
    expect(MAX_INLINE_BYTES).toBe(64 * 1024);
  });

  it('just below the cap: inlines new_content', () => {
    const text = 'a'.repeat(MAX_INLINE_BYTES - 1);
    const result = buildExternalChangeContent(text);
    expect(result.new_content).toBe(text);
    expect(result.new_content_head).toBeUndefined();
    expect(result.new_content_size).toBe(MAX_INLINE_BYTES - 1);
  });

  it('exactly at the cap: inlines (boundary inclusive)', () => {
    const text = 'a'.repeat(MAX_INLINE_BYTES);
    const result = buildExternalChangeContent(text);
    expect(result.new_content).toBe(text);
    expect(result.new_content_head).toBeUndefined();
    expect(result.new_content_size).toBe(MAX_INLINE_BYTES);
  });

  it('one byte over the cap: sets head + tail, no inline new_content', () => {
    const text = 'a'.repeat(MAX_INLINE_BYTES + 1);
    const result = buildExternalChangeContent(text);
    expect(result.new_content).toBeUndefined();
    expect(result.new_content_head).toBe('a'.repeat(HEAD_TAIL_BYTES));
    expect(result.new_content_tail).toBe('a'.repeat(HEAD_TAIL_BYTES));
    expect(result.new_content_size).toBe(MAX_INLINE_BYTES + 1);
  });

  // -------------------------------------------------------------------------
  // The cap is BYTES, not JS string length. These two cases are the ones that
  // break if someone reaches for `text.length`: both strings are comfortably
  // under MAX_INLINE_BYTES *characters* while straddling the byte boundary.
  // -------------------------------------------------------------------------

  it('multi-byte UTF-8 exactly at the cap in BYTES: inlines', () => {
    const emoji = '😀'; // 4 UTF-8 bytes, 2 JS chars (surrogate pair)
    const text = emoji.repeat(MAX_INLINE_BYTES / 4);
    expect(Buffer.byteLength(text, 'utf8')).toBe(MAX_INLINE_BYTES);
    expect(text.length).toBeLessThan(MAX_INLINE_BYTES); // char length is half

    const result = buildExternalChangeContent(text);
    expect(result.new_content).toBe(text);
    expect(result.new_content_size).toBe(MAX_INLINE_BYTES);
  });

  it('multi-byte UTF-8 over the cap in BYTES but under it in chars: head/tail', () => {
    const emoji = '😀';
    const text = emoji.repeat(MAX_INLINE_BYTES / 4 + 1);
    expect(Buffer.byteLength(text, 'utf8')).toBe(MAX_INLINE_BYTES + 4);
    expect(text.length).toBeLessThan(MAX_INLINE_BYTES); // would wrongly inline on .length

    const result = buildExternalChangeContent(text);
    expect(result.new_content).toBeUndefined();
    expect(result.new_content_size).toBe(MAX_INLINE_BYTES + 4);
    // Character slices, so truncation never splits a surrogate pair.
    expect(result.new_content_head).toBe(emoji.repeat(HEAD_TAIL_BYTES / 2));
    expect(result.new_content_tail).toBe(emoji.repeat(HEAD_TAIL_BYTES / 2));
  });

  it('large text: head is first 512 chars, tail is last 512 chars', () => {
    const head = 'H'.repeat(HEAD_TAIL_BYTES);
    const middle = 'M'.repeat(MAX_INLINE_BYTES);
    const tail = 'T'.repeat(HEAD_TAIL_BYTES);
    const text = head + middle + tail;
    const result = buildExternalChangeContent(text);
    expect(result.new_content).toBeUndefined();
    expect(result.new_content_head).toBe(head);
    expect(result.new_content_tail).toBe(tail);
  });

  it('new_content_size is UTF-8 byte length, not JS char length', () => {
    const emoji = '😀'; // 4 bytes in UTF-8, length=2 in JS (surrogate pair)
    const result = buildExternalChangeContent(emoji);
    expect(result.new_content_size).toBe(4);
    expect(result.new_content_size).not.toBe(emoji.length);
  });

  it('empty text: inlines empty string, size=0', () => {
    const result = buildExternalChangeContent('');
    expect(result.new_content).toBe('');
    expect(result.new_content_size).toBe(0);
  });

  // --- the size cap is the ONLY thing that suppresses content ---------------

  it('takes exactly one argument — there is no capture-policy knob for content', () => {
    // The `inline_content` policy key was removed; see paste-payload.test.ts for
    // the reasoning. Pinning the arity means reintroducing a suppression
    // parameter fails here rather than silently re-enabling the knob.
    expect(buildExternalChangeContent).toHaveLength(1);
  });

  it('inlines content unconditionally below the cap', () => {
    expect(buildExternalChangeContent('hello').new_content).toBe('hello');
  });
});
