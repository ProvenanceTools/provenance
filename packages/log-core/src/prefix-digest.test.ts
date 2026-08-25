import { describe, it, expect } from 'vitest';
import { findSha256PrefixLength } from './prefix-digest.js';
import { sha256Hex } from './hash-chain.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Three NDJSON-shaped lines, as a `.slog` is. */
const LINES = ['{"seq":0}\n', '{"seq":1}\n', '{"seq":2}\n'];
const FILE = LINES.join('');

describe('findSha256PrefixLength', () => {
  it('matches the whole file', () => {
    expect(findSha256PrefixLength(enc(FILE), sha256Hex(FILE))).toBe(FILE.length);
  });

  it('matches a prefix ending at a newline — the honest rolling-seal case', () => {
    // The seal was written when only the first two entries had been flushed.
    const sealed = LINES[0]! + LINES[1]!;
    expect(findSha256PrefixLength(enc(FILE), sha256Hex(sealed))).toBe(sealed.length);
  });

  it('matches the empty prefix', () => {
    // sha256('') is what the rolling-seal writer records when it cannot read
    // the .slog at all. It matches, and attests to nothing.
    expect(findSha256PrefixLength(enc(FILE), sha256Hex(''))).toBe(0);
    expect(findSha256PrefixLength(new Uint8Array(0), sha256Hex(''))).toBe(0);
  });

  it('matches a file cut off mid-entry, whose last line has no newline', () => {
    // A power cut during a flush. The final partial line is a candidate the
    // newline scan never offers.
    const partial = LINES[0]! + '{"seq":1';
    expect(findSha256PrefixLength(enc(partial), sha256Hex(partial))).toBe(partial.length);
  });

  it('does NOT match when a byte inside the sealed prefix changed', () => {
    const sealed = LINES[0]! + LINES[1]!;
    const target = sha256Hex(sealed);
    const edited = '{"seq":9}\n' + LINES[1]! + LINES[2]!;
    expect(findSha256PrefixLength(enc(edited), target)).toBeNull();
  });

  it('does NOT match when the file was truncated below the sealed prefix', () => {
    const sealed = LINES[0]! + LINES[1]!;
    expect(findSha256PrefixLength(enc(LINES[0]!), sha256Hex(sealed))).toBeNull();
  });

  it('DOES match when bytes were appended past the sealed prefix', () => {
    // The residual, stated as a test rather than left implicit: a rolling seal
    // cannot attest to bytes written after it. Callers must report the tail.
    const sealed = LINES[0]!;
    const grown = FILE + '{"seq":3}\n';
    expect(findSha256PrefixLength(enc(grown), sha256Hex(sealed))).toBe(sealed.length);
  });

  it('does not match an interior substring that is not a prefix', () => {
    expect(findSha256PrefixLength(enc(FILE), sha256Hex(LINES[1]!))).toBeNull();
  });

  it('rejects a malformed digest without searching', () => {
    expect(findSha256PrefixLength(enc(FILE), '')).toBeNull();
    expect(findSha256PrefixLength(enc(FILE), 'not-a-digest')).toBeNull();
    expect(findSha256PrefixLength(enc(FILE), 'a'.repeat(63))).toBeNull();
  });

  it('accepts an uppercase digest', () => {
    expect(findSha256PrefixLength(enc(FILE), sha256Hex(FILE).toUpperCase())).toBe(FILE.length);
  });

  it('honours a custom boundary byte', () => {
    const bytes = enc('a;b;c');
    expect(findSha256PrefixLength(bytes, sha256Hex('a;'), 0x3b)).toBe(2);
    // With the default newline boundary, 'a;' is not a candidate at all.
    expect(findSha256PrefixLength(bytes, sha256Hex('a;'))).toBeNull();
  });
});
