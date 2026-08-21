/**
 * `parseEntriesToleratingTornTail` — the byte-level rule, both directions.
 *
 * Split from `ndjson.test.ts` the way `verify-log-bytes-line-endings.test.ts` is
 * split from `verify-log-bytes.test.ts`: one narrow, load-bearing rule, held
 * apart so the argument for it stays readable.
 *
 * The rule is deliberately byte-level rather than a judgement. Tolerance covers
 * the characters after the FINAL `'\n'`, and only when the text does not end in
 * `'\n'` at all. A completed append always terminates its line, so that absence
 * is the signature of an interrupted write and nothing else can borrow it.
 *
 * Half of these tests exist to prove the tolerance does NOT spread: a corrupt
 * line in the middle is real evidence, and a torn tail must never become cover
 * for one.
 */

import { describe, it, expect } from 'vitest';
import { serializeEntry, parseEntries, parseEntriesToleratingTornTail } from './ndjson.js';
import { chainEntry, GENESIS_PREV_HASH, sha256Hex } from './hash-chain.js';
import type { Envelope, HashedEnvelope } from './envelope.js';

function makeChain(count: number): HashedEnvelope[] {
  const entries: HashedEnvelope[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < count; i++) {
    const env: Envelope<'session.end'> = {
      seq: i,
      t: i * 1000,
      wall: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      kind: 'session.end',
      data: { reason: 'test' },
    };
    const hashed = chainEntry(prevHash, env, sha256Hex);
    entries.push(hashed);
    prevHash = hashed.hash;
  }
  return entries;
}

describe('parseEntriesToleratingTornTail', () => {
  it('behaves exactly like parseEntries on a well-formed log', () => {
    const text = makeChain(3).map(serializeEntry).join('');
    const tolerant = parseEntriesToleratingTornTail(text);
    const strict = parseEntries(text);
    expect(tolerant.ok && strict.ok).toBe(true);
    if (!tolerant.ok || !strict.ok) return;
    expect(tolerant.value.entries).toEqual(strict.value);
    expect(tolerant.value.tornTail).toBeNull();
  });

  it('empty text yields no entries and no torn tail', () => {
    const r = parseEntriesToleratingTornTail('');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries).toEqual([]);
    expect(r.value.tornTail).toBeNull();
  });

  it('discards an unterminated trailing FRAGMENT and reports it', () => {
    const entries = makeChain(3);
    const whole = entries.map(serializeEntry).join('');
    const fragment = serializeEntry(entries[2]!).slice(0, 25);
    const r = parseEntriesToleratingTornTail(whole + fragment);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries).toHaveLength(3);
    expect(r.value.tornTail).not.toBeNull();
    expect(r.value.tornTail!.line).toBe(4);
    expect(r.value.tornTail!.discardedChars).toBe(fragment.length);
    expect(r.value.tornTail!.reason.length).toBeGreaterThan(0);
  });

  it('KEEPS a complete final entry that merely lost its newline', () => {
    // A flush that wrote the whole line and died before the terminator. The
    // entry is intact and chains; discarding it over one missing byte would be
    // its own small injustice.
    const text = makeChain(3).map(serializeEntry).join('').replace(/\n$/, '');
    const r = parseEntriesToleratingTornTail(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries).toHaveLength(3);
    expect(r.value.tornTail).toBeNull();
  });

  it('a text ending in a newline has NO torn tail, so a bad line in it still errors', () => {
    // This is what keeps the middle intact: with a terminator present there is
    // no final segment to tolerate, and every line is a middle line.
    const text = makeChain(2).map(serializeEntry).join('') + 'NOT JSON {{{\n';
    const r = parseEntriesToleratingTornTail(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_json');
    expect(r.error.line).toBe(3);
  });

  it('a corrupt line BEFORE the final segment still errors, torn tail or not', () => {
    // The obvious abuse: hide an edit up the file behind a torn tail, hoping
    // the reader gives up at the first bad line and keeps what came before.
    // Tolerance covers exactly one segment and gives no cover to anything else.
    const good = makeChain(3).map(serializeEntry);
    const text = good[0]! + 'NOT JSON {{{\n' + good[2]! + '{"seq":9';
    const r = parseEntriesToleratingTornTail(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.line).toBe(2);
  });

  it('a fragment that is valid JSON but not an entry is discarded, never accepted', () => {
    const text = makeChain(2).map(serializeEntry).join('') + '{"seq":9}';
    const r = parseEntriesToleratingTornTail(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries).toHaveLength(2);
    expect(r.value.tornTail!.reason).toContain('invalid_shape');
  });

  it('a file that is nothing BUT a fragment yields zero entries, reported at line 1', () => {
    const r = parseEntriesToleratingTornTail('{"seq":0,"t":0');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries).toEqual([]);
    expect(r.value.tornTail!.line).toBe(1);
  });

  it('parseEntries itself is UNCHANGED — the recorder callers keep strict semantics', () => {
    // `chain-recovery.ts`, `seal.ts` and `peer-watcher.ts` all call
    // `parseEntries`. Quarantining a damaged log is recorder FAILURE HANDLING
    // and a separate product decision; this change must not reach it by making
    // the shared primitive silently lenient underneath them.
    const text = makeChain(2).map(serializeEntry).join('') + '{"seq":9';
    expect(parseEntries(text).ok).toBe(false);
  });
});
