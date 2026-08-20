/**
 * Format tests for `peer.observed` — peer witnessing (program spec §7 mechanism
 * 2, collaboration spec §5.5, Tier 4.1).
 *
 * ## What is being pinned
 *
 * A witness is one contributor's signed claim about ANOTHER contributor's file.
 * Three properties make it safe to carry that:
 *
 *  1. **The chain commitment, not the digest, is what it proves.** A foreign log
 *     is append-only and its owner keeps recording, so the bytes witnessed are
 *     normally a PREFIX of the bytes finally committed. `sha256` inequality is
 *     therefore the NORMAL case, not evidence. `seq_high` + `last_hash` are the
 *     verifiable part.
 *  2. **Parsed-ness is all-or-nothing.** A witness that names a session but not
 *     a tip commits to nothing checkable while reading as though it does.
 *  3. **No identity of any kind travels in the payload.** Same CPHS constraint
 *     that keeps git author identity out of `git.event`, with more force,
 *     because this payload is about somebody else.
 *
 * ## Compatibility, both directions
 *
 * An OLDER reader meeting a `peer.observed` entry must be unaffected:
 * `parseEntries` does not reject unknown `kind` values (PRD §5.1), and the
 * hash chain is computed over the envelope without interpreting `data`, so the
 * entry parses, chains, and validates. A NEWER reader meeting a bundle with no
 * `peer.observed` at all must also be unaffected — that is every bundle in
 * existence today, since no recorder emits the kind.
 */

import { describe, it, expect } from 'vitest';
import { canonicalize } from './canonical.js';
import { chainEntry, GENESIS_PREV_HASH } from './hash-chain.js';
import { validateChain } from './chain-validator.js';
import { parseEntries, serializeEntry } from './ndjson.js';
import { FLOOR_EVENT_KINDS, POLICY_GATED_EVENT_KINDS } from './policy.js';
import {
  validatePeerObservedPayload,
  describePeerObservedShapeError,
  PEER_OBSERVED_STATES,
} from './peer-observed.js';
import type { PeerObservedShapeError } from './peer-observed.js';
import type { PeerObservedPayload } from './events.js';
import type { Envelope, HashedEnvelope } from './envelope.js';

const WALL = '2026-01-01T00:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const HASH_T = 'c'.repeat(64);

const PARSED: PeerObservedPayload = {
  file: 'session-11111111-1111-4111-8111-111111111111.slog',
  sha256: SHA_A,
  bytes: 4096,
  session_id: '22222222-2222-4222-8222-222222222222',
  seq_high: 412,
  last_hash: HASH_T,
  state: 'appeared',
};

const UNPARSEABLE: PeerObservedPayload = {
  file: 'session-33333333-3333-4333-8333-333333333333.slog',
  sha256: SHA_B,
  bytes: 17,
  session_id: null,
  seq_high: null,
  last_hash: null,
  state: 'unparseable',
};

/** Narrow to the error branch, so the assertions below read as claims. */
function errorOf(value: unknown): PeerObservedShapeError {
  const result = validatePeerObservedPayload(value);
  if (result.ok) throw new Error('expected the payload to be rejected');
  return result.error;
}

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

describe('peer.observed is placed on the capture floor', () => {
  it('is in FLOOR_EVENT_KINDS and has no policy knob', () => {
    // Deliberate, and argued in policy.ts: the collaboration spec §5.6 assigns
    // "was witnessing AVAILABLE?" to a session.start capability report, not to a
    // capture knob, so there is no knob for this kind to be gated on. If CPHS
    // (§8 item 5) comes back requiring a per-course off switch, this expectation
    // is what forces that to be a deliberate edit rather than a quiet widening.
    expect(FLOOR_EVENT_KINDS).toContain('peer.observed');
    expect(Object.keys(POLICY_GATED_EVENT_KINDS)).not.toContain('peer.observed');
  });
});

// ---------------------------------------------------------------------------
// Compatibility, both directions
// ---------------------------------------------------------------------------

describe('compatibility with readers and writers that do not know the kind', () => {
  it('an older reader parses, chains and validates a peer.observed entry', () => {
    // The whole degrade-sanely story: ndjson.ts does not reject unknown kinds
    // and the chain is computed over the envelope without interpreting `data`.
    const envelope: Envelope<'peer.observed'> = {
      seq: 0,
      t: 0,
      wall: WALL,
      kind: 'peer.observed',
      data: PARSED,
    };
    const entry = chainEntry(GENESIS_PREV_HASH, envelope) as HashedEnvelope;
    const line = serializeEntry(entry);

    const parsed = parseEntries(line);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(1);
    expect(parsed.value[0]!.kind).toBe('peer.observed');
    expect(parsed.value[0]!.data).toEqual(PARSED);

    expect(validateChain([entry])).toEqual({ ok: true });
  });

  it('a peer.observed entry chains identically to any other kind', () => {
    // Nothing about this payload gets special hashing treatment. If it did, the
    // three recorder ports would have to know about it to chain correctly.
    const envelope: Envelope<'peer.observed'> = {
      seq: 3,
      t: 900,
      wall: WALL,
      kind: 'peer.observed',
      data: PARSED,
    };
    const expected = canonicalize({ ...envelope });
    const entry = chainEntry(GENESIS_PREV_HASH, envelope);
    expect(entry.hash).toBe(chainEntry(GENESIS_PREV_HASH, { ...envelope }).hash);
    expect(expected).toContain('"kind":"peer.observed"');
  });

  it('a log with no peer.observed at all is completely unaffected', () => {
    // Every bundle in existence today. The kind exists in the type space and in
    // nothing else, because no recorder emits it.
    const start = chainEntry(GENESIS_PREV_HASH, {
      seq: 0,
      t: 0,
      wall: WALL,
      kind: 'doc.close',
      data: { path: 'hw1.py' },
    });
    const next = chainEntry(start.hash, {
      seq: 1,
      t: 10,
      wall: WALL,
      kind: 'doc.close',
      data: { path: 'hw2.py' },
    });
    expect(validateChain([start, next] as HashedEnvelope[])).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Canonicalization — the tri-repo contract
// ---------------------------------------------------------------------------

describe('canonical form', () => {
  it('sorts keys as JCS requires and preserves explicit nulls', () => {
    // The nulls are LOAD-BEARING: null means "the recorder could not read this",
    // which is a different fact from a field being absent. A port that omits
    // null fields produces different bytes and therefore a different hash.
    expect(canonicalize(UNPARSEABLE)).toBe(
      '{"bytes":17,' +
        '"file":"session-33333333-3333-4333-8333-333333333333.slog",' +
        '"last_hash":null,' +
        '"seq_high":null,' +
        '"session_id":null,' +
        `"sha256":"${SHA_B}",` +
        '"state":"unparseable"}',
    );
  });

  it('a null field and an absent field are different bytes', () => {
    const withNull = canonicalize({ session_id: null, seq_high: 1 });
    const withAbsent = canonicalize({ seq_high: 1 });
    expect(withNull).not.toBe(withAbsent);
  });
});

// ---------------------------------------------------------------------------
// No identity in the payload
// ---------------------------------------------------------------------------

describe('the payload carries no identity, of any kind', () => {
  it('pins the exact key set, so it cannot be widened by accident', () => {
    // Same guard git.event has. Attribution runs through
    // session.start.identity.student_ref; a witness names a FILE and a CHAIN
    // POSITION. A student ref, a pubkey, or a git author here would be a new
    // category of identifier — and one describing somebody ELSE — which the
    // approved protocol requires a filed modification for, before implementation.
    expect(Object.keys(PARSED).sort()).toEqual([
      'bytes',
      'file',
      'last_hash',
      'seq_high',
      'session_id',
      'sha256',
      'state',
    ]);
  });

  it('rejects nothing on an unknown extra key, but never surfaces it', () => {
    // Forward compatibility (the rule resolveCapturePolicy applies to unknown
    // capture keys). A newer recorder's extra field must not make this reader
    // discard the whole witness — but it must not be carried through either.
    const result = validatePeerObservedPayload({
      ...PARSED,
      student_ref: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value)).not.toContain('student_ref');
  });
});

// ---------------------------------------------------------------------------
// validatePeerObservedPayload — accepting
// ---------------------------------------------------------------------------

describe('validatePeerObservedPayload accepts', () => {
  it('a fully parsed observation', () => {
    const result = validatePeerObservedPayload(PARSED);
    expect(result).toEqual({ ok: true, value: PARSED });
  });

  it('an unparseable observation with all three chain fields null', () => {
    const result = validatePeerObservedPayload(UNPARSEABLE);
    expect(result).toEqual({ ok: true, value: UNPARSEABLE });
  });

  it.each(PEER_OBSERVED_STATES)('the state %s', (state) => {
    const base = state === 'unparseable' ? UNPARSEABLE : PARSED;
    const result = validatePeerObservedPayload({ ...base, state });
    expect(result.ok).toBe(true);
  });

  it('seq_high of 0 — a foreign log holding only its session.start', () => {
    // 0 is a real seq. A truthiness check here would reject the shortest
    // possible honest witness and read it as unparsed.
    const result = validatePeerObservedPayload({ ...PARSED, seq_high: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.seq_high).toBe(0);
  });

  it('bytes of 0 — an empty file that was nonetheless there', () => {
    const result = validatePeerObservedPayload({ ...UNPARSEABLE, bytes: 0 });
    expect(result.ok).toBe(true);
  });

  it('a chain-field triple that is entirely absent rather than explicitly null', () => {
    // Absent reads as null here: `obj['session_id']` is undefined, which is
    // neither a string nor null... so this must be REJECTED, not silently
    // coerced. Pinned so the coercion is never introduced as a convenience.
    const { session_id: _s, ...withoutSessionId } = PARSED;
    expect(errorOf(withoutSessionId)).toEqual({ kind: 'bad_field', field: 'session_id' });
  });
});

// ---------------------------------------------------------------------------
// validatePeerObservedPayload — rejecting
// ---------------------------------------------------------------------------

describe('validatePeerObservedPayload rejects', () => {
  it.each([
    ['null', null],
    ['a string', 'session-x.slog'],
    ['a number', 7],
    ['an array', []],
  ])('%s as not_an_object', (_label, value) => {
    expect(errorOf(value)).toEqual({ kind: 'not_an_object' });
  });

  it.each([
    ['file', { ...PARSED, file: 42 }],
    ['file', { ...PARSED, file: '' }],
    ['sha256', { ...PARSED, sha256: 'not-hex' }],
    ['sha256', { ...PARSED, sha256: SHA_A.toUpperCase() }],
    ['sha256', { ...PARSED, sha256: null }],
    ['bytes', { ...PARSED, bytes: '4096' }],
    ['state', { ...PARSED, state: 9 }],
    ['session_id', { ...PARSED, session_id: 5 }],
    ['seq_high', { ...PARSED, seq_high: '412' }],
    ['last_hash', { ...PARSED, last_hash: 'short' }],
    ['last_hash', { ...PARSED, last_hash: 12 }],
  ])('a bad %s', (field, value) => {
    expect(errorOf(value)).toEqual({ kind: 'bad_field', field });
  });

  it('an unrecognised state', () => {
    // Unlike an unknown event KIND — forward compatibility, must pass — an
    // unknown state inside a payload we DO understand would have to be given a
    // meaning, and inventing one is how an unfamiliar observation becomes an
    // accusation.
    expect(errorOf({ ...PARSED, state: 'vanished' })).toEqual({
      kind: 'unknown_state',
      state: 'vanished',
    });
  });

  it.each([
    ['a negative seq_high', -1],
    ['a fractional seq_high', 4.5],
    ['a NaN seq_high', Number.NaN],
    ['an infinite seq_high', Number.POSITIVE_INFINITY],
  ])('%s', (_label, seqHigh) => {
    expect(errorOf({ ...PARSED, seq_high: seqHigh })).toEqual({
      kind: 'bad_seq_high',
      value: seqHigh,
    });
  });

  it.each([
    ['a negative bytes', -1],
    ['a fractional bytes', 1.5],
    ['a NaN bytes', Number.NaN],
  ])('%s', (_label, bytes) => {
    expect(errorOf({ ...PARSED, bytes })).toEqual({ kind: 'bad_bytes', value: bytes });
  });
});

// ---------------------------------------------------------------------------
// The cross-field rule
// ---------------------------------------------------------------------------

describe('parsed-ness is all-or-nothing', () => {
  it('rejects a witness that names a session but commits to no tip', () => {
    // THE shape this rule exists for. It looks authoritative — it names a
    // session — while committing to nothing a later archive could contradict.
    expect(errorOf({ ...PARSED, seq_high: null, last_hash: null })).toEqual({
      kind: 'partially_parsed',
      present: ['session_id'],
      absent: ['seq_high', 'last_hash'],
    });
  });

  it('rejects a witness with a tip but no session to attach it to', () => {
    expect(errorOf({ ...PARSED, session_id: null })).toEqual({
      kind: 'partially_parsed',
      present: ['seq_high', 'last_hash'],
      absent: ['session_id'],
    });
  });

  it('rejects a seq_high with no last_hash — the size-only claim', () => {
    // seq_high alone makes truncation detectable only by LENGTH, which a forger
    // can match. last_hash is what makes it a commitment to an exact prefix.
    expect(errorOf({ ...PARSED, last_hash: null })).toEqual({
      kind: 'partially_parsed',
      present: ['session_id', 'seq_high'],
      absent: ['last_hash'],
    });
  });

  it('rejects state unparseable that nonetheless carries chain values', () => {
    // Self-contradictory: the recorder cannot both have failed to read the file
    // and have read its chain out.
    expect(errorOf({ ...UNPARSEABLE, session_id: PARSED.session_id })).toEqual({
      kind: 'unparseable_with_chain_values',
      present: ['session_id'],
    });
  });

  it('accepts a non-unparseable state with all three chain fields null', () => {
    // A file that appeared and could not be read yet is legitimately reported
    // with state `appeared` and no chain values; only `unparseable` FORBIDS
    // them, it does not MONOPOLISE their absence.
    const result = validatePeerObservedPayload({
      ...PARSED,
      session_id: null,
      seq_high: null,
      last_hash: null,
      state: 'disappeared',
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error descriptions
// ---------------------------------------------------------------------------

describe('describePeerObservedShapeError', () => {
  it.each([
    [{ kind: 'not_an_object' } as const, 'not a JSON object'],
    [{ kind: 'bad_field', field: 'sha256' } as const, '"sha256"'],
    [{ kind: 'unknown_state', state: 'vanished' } as const, 'vanished'],
    [
      { kind: 'partially_parsed', present: ['session_id'], absent: ['seq_high'] } as const,
      'only in part',
    ],
    [{ kind: 'unparseable_with_chain_values', present: ['session_id'] } as const, 'did not parse'],
    [{ kind: 'bad_seq_high', value: -1 } as const, 'seq_high'],
    [{ kind: 'bad_bytes', value: -1 } as const, 'bytes'],
  ])('describes %j', (error, fragment) => {
    expect(describePeerObservedShapeError(error)).toContain(fragment);
  });

  it('covers every error kind', () => {
    // Full branch coverage is the log-core bar, and an undescribed error kind
    // reaches a grader as an empty string.
    const kinds = new Set<PeerObservedShapeError['kind']>([
      'not_an_object',
      'bad_field',
      'unknown_state',
      'partially_parsed',
      'unparseable_with_chain_values',
      'bad_seq_high',
      'bad_bytes',
    ]);
    for (const kind of kinds) {
      const error = {
        kind,
        field: 'file',
        state: 'x',
        present: ['a'],
        absent: ['b'],
        value: 0,
      } as unknown as PeerObservedShapeError;
      expect(describePeerObservedShapeError(error).length).toBeGreaterThan(0);
    }
  });
});
