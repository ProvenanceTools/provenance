import { describe, expect, it } from 'vitest';
import { buildPastePayload, MAX_INLINE_BYTES, HEAD_TAIL_BYTES } from './paste-payload.js';

describe('buildPastePayload', () => {
  it('short text: sets content, no head/tail', () => {
    const text = 'hello world';
    const result = buildPastePayload(text);
    expect(result.content).toBe(text);
    expect(result.content_head).toBeUndefined();
    expect(result.content_tail).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Cap boundary (PRD §4.3). MAX_INLINE_BYTES is 64 KB, raised from 4 KB.
  // A `paste` event is NOT duplicated by a `doc.change`, so anything dropped
  // here is gone from reconstruction AND from the paste heuristics — which
  // made a >4 KB pasted solution, the single most load-bearing detection case
  // in the product, invisible.
  // -------------------------------------------------------------------------

  it('pins the cap at 64 KB', () => {
    expect(MAX_INLINE_BYTES).toBe(64 * 1024);
  });

  it('just below the cap: sets content', () => {
    const text = 'a'.repeat(MAX_INLINE_BYTES - 1);
    const result = buildPastePayload(text);
    expect(result.content).toBe(text);
    expect(result.content_head).toBeUndefined();
    expect(result.length).toBe(MAX_INLINE_BYTES - 1);
  });

  it('exactly at the cap: sets content (boundary inclusive)', () => {
    const text = 'a'.repeat(MAX_INLINE_BYTES);
    const result = buildPastePayload(text);
    expect(result.content).toBe(text);
    expect(result.content_head).toBeUndefined();
    expect(result.length).toBe(MAX_INLINE_BYTES);
  });

  it('one byte over the cap: sets head/tail, no content', () => {
    const text = 'a'.repeat(MAX_INLINE_BYTES + 1);
    const result = buildPastePayload(text);
    expect(result.content).toBeUndefined();
    expect(result.content_head).toBe('a'.repeat(HEAD_TAIL_BYTES));
    expect(result.content_tail).toBe('a'.repeat(HEAD_TAIL_BYTES));
    expect(result.length).toBe(MAX_INLINE_BYTES + 1);
  });

  // The cap is BYTES, not JS string length — the case that breaks if someone
  // reaches for `text.length`.
  it('multi-byte UTF-8 exactly at the cap in BYTES: sets content', () => {
    const emoji = '😀'; // 4 UTF-8 bytes, 2 JS chars (surrogate pair)
    const text = emoji.repeat(MAX_INLINE_BYTES / 4);
    expect(Buffer.byteLength(text, 'utf8')).toBe(MAX_INLINE_BYTES);
    expect(text.length).toBeLessThan(MAX_INLINE_BYTES);

    const result = buildPastePayload(text);
    expect(result.content).toBe(text);
    expect(result.length).toBe(MAX_INLINE_BYTES);
  });

  it('multi-byte UTF-8 over the cap in BYTES but under it in chars: head/tail', () => {
    const emoji = '😀';
    const text = emoji.repeat(MAX_INLINE_BYTES / 4 + 1);
    expect(Buffer.byteLength(text, 'utf8')).toBe(MAX_INLINE_BYTES + 4);
    expect(text.length).toBeLessThan(MAX_INLINE_BYTES); // would wrongly inline on .length

    const result = buildPastePayload(text);
    expect(result.content).toBeUndefined();
    expect(result.length).toBe(MAX_INLINE_BYTES + 4);
    // Character slices, so truncation never splits a surrogate pair.
    expect(result.content_head).toBe(emoji.repeat(HEAD_TAIL_BYTES / 2));
    expect(result.content_tail).toBe(emoji.repeat(HEAD_TAIL_BYTES / 2));
  });

  it('large text: head is first 512 chars, tail is last 512 chars', () => {
    // Build text where head and tail are distinct
    const head = 'H'.repeat(HEAD_TAIL_BYTES);
    const middle = 'M'.repeat(MAX_INLINE_BYTES);
    const tail = 'T'.repeat(HEAD_TAIL_BYTES);
    const text = head + middle + tail;
    const result = buildPastePayload(text);
    expect(result.content).toBeUndefined();
    expect(result.content_head).toBe(head);
    expect(result.content_tail).toBe(tail);
  });

  it('length is UTF-8 byte length, not char length (multi-byte chars)', () => {
    // Each emoji is 4 bytes in UTF-8, 2 chars in JS (surrogate pair)
    const emoji = '😀'; // 4 bytes, length=2 in JS
    const result = buildPastePayload(emoji);
    expect(result.length).toBe(4); // byte length
    expect(result.length).not.toBe(emoji.length); // NOT char length (which would be 2)
  });

  it('length matches Buffer.byteLength for ASCII text', () => {
    const text = 'hello';
    const result = buildPastePayload(text);
    expect(result.length).toBe(5);
    expect(result.length).toBe(text.length); // same for ASCII
  });

  it('sha256 is 64-char lowercase hex', () => {
    const result = buildPastePayload('test');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sha256 is deterministic for same input', () => {
    const text = 'deterministic test';
    expect(buildPastePayload(text).sha256).toBe(buildPastePayload(text).sha256);
  });

  it('sha256 differs for different inputs', () => {
    expect(buildPastePayload('abc').sha256).not.toBe(buildPastePayload('def').sha256);
  });

  it('empty string: length=0, content=""', () => {
    const result = buildPastePayload('');
    expect(result.length).toBe(0);
    expect(result.content).toBe('');
    expect(result.content_head).toBeUndefined();
  });

  // --- the size cap is the ONLY thing that suppresses content ---------------

  it('takes exactly one argument — there is no capture-policy knob for content', () => {
    // The `inline_content` policy key was removed: `internal_move` reads paste
    // content to DOWNGRADE a `large_paste` flag, so stripping it made the system
    // more likely to falsely accuse a student who was relocating their own code.
    // Pinning the arity means reintroducing a suppression parameter fails here.
    expect(buildPastePayload).toHaveLength(1);
  });

  it('inlines content unconditionally below the cap', () => {
    const text = 'def solve(): return 42';
    expect(buildPastePayload(text).content).toBe(text);
  });
});
