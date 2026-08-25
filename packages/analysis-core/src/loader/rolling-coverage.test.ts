import { describe, it, expect } from 'vitest';
import { canonicalize, sha256Hex } from '@provenance/log-core';
import {
  computeSlogCoverage,
  computeMetaCoverage,
  resolveAmbiguousCoverage,
} from './rolling-coverage.js';

const LINES = ['{"seq":0,"kind":"session.start"}\n', '{"seq":1}\n', '{"seq":2}\n'];
const SLOG = LINES.join('');
const SLOG_SHA = sha256Hex(SLOG);

// A `.slog.meta` as MetaWriter writes it: JCS-canonical JSON whose only
// time-varying field is `checkpoints`.
const cp = (seq: number): Record<string, unknown> => ({
  seq,
  hash: `${seq}`.repeat(64).slice(0, 64),
  sig: 'a'.repeat(128),
});
const metaWith = (n: number): string =>
  canonicalize({
    format_version: '1.0',
    session_id: 'abc',
    session_pubkey: 'b'.repeat(64),
    encrypted_session_privkey: { alg: 'x', nonce: 'n', ciphertext: 'c' },
    checkpoints: Array.from({ length: n }, (_, i) => cp(i)),
  });

describe('computeSlogCoverage', () => {
  it('reports exact when the digest covers the whole file', () => {
    expect(computeSlogCoverage(SLOG, SLOG_SHA, SLOG_SHA)).toEqual({ kind: 'exact' });
  });

  it('reports a partial prefix when the log grew after the seal', () => {
    const sealed = LINES[0]! + LINES[1]!;
    expect(computeSlogCoverage(SLOG, SLOG_SHA, sha256Hex(sealed))).toEqual({
      kind: 'partial',
      sealed: sealed.length,
      total: SLOG.length,
      unit: 'bytes',
    });
  });

  it('reports a zero-length prefix when the seal committed to an empty log', () => {
    // The rolling-seal writer records sha256('') when it cannot read the .slog.
    // That is a real match covering nothing, and the caller reports the size.
    expect(computeSlogCoverage(SLOG, SLOG_SHA, sha256Hex(''))).toEqual({
      kind: 'partial',
      sealed: 0,
      total: SLOG.length,
      unit: 'bytes',
    });
  });

  it('reports no_match when a byte inside the sealed prefix changed', () => {
    const sealed = LINES[0]! + LINES[1]!;
    const edited = LINES[0]! + '{"seq":9}\n' + LINES[2]!;
    expect(computeSlogCoverage(edited, sha256Hex(edited), sha256Hex(sealed))).toEqual({
      kind: 'no_match',
    });
  });

  it('reports no_match when the log was truncated below the sealed prefix', () => {
    const sealed = LINES[0]! + LINES[1]!;
    const cut = LINES[0]!;
    expect(computeSlogCoverage(cut, sha256Hex(cut), sha256Hex(sealed))).toEqual({
      kind: 'no_match',
    });
  });

  it('is unavailable when the manifest carries no usable digest', () => {
    expect(computeSlogCoverage(SLOG, SLOG_SHA, undefined).kind).toBe('unavailable');
    expect(computeSlogCoverage(SLOG, SLOG_SHA, 'nope').kind).toBe('unavailable');
    expect(computeSlogCoverage(SLOG, SLOG_SHA, '').kind).toBe('unavailable');
  });

  it('is unavailable when the decoded text does not re-encode to the hashed bytes', () => {
    // Whatever was hashed, it was not this text — so refuse rather than answer
    // confidently about the wrong bytes.
    const result = computeSlogCoverage(SLOG, 'f'.repeat(64), sha256Hex(LINES[0]!));
    expect(result.kind).toBe('unavailable');
  });
});

describe('computeMetaCoverage', () => {
  it('reports exact when the digest covers the archived meta', () => {
    const meta = metaWith(2);
    const sha = sha256Hex(meta);
    expect(computeMetaCoverage(meta, sha, sha)).toEqual({ kind: 'exact' });
  });

  it('reports a partial checkpoint prefix when checkpoints were added after the seal', () => {
    const archived = metaWith(3);
    expect(computeMetaCoverage(archived, sha256Hex(archived), sha256Hex(metaWith(1)))).toEqual({
      kind: 'partial',
      sealed: 1,
      total: 3,
      unit: 'checkpoints',
    });
  });

  it('reports a zero-checkpoint prefix when the seal predated every checkpoint', () => {
    const archived = metaWith(2);
    expect(computeMetaCoverage(archived, sha256Hex(archived), sha256Hex(metaWith(0)))).toEqual({
      kind: 'partial',
      sealed: 0,
      total: 2,
      unit: 'checkpoints',
    });
  });

  it('reports no_match when a SEALED checkpoint was deleted', () => {
    // The archived list is [cp1, cp2]; the seal committed to [cp0]. No
    // truncation of the archived list reproduces that, so this is not growth.
    const sealed = sha256Hex(metaWith(1));
    const tamperedObj = JSON.parse(metaWith(3)) as Record<string, unknown>;
    tamperedObj['checkpoints'] = (tamperedObj['checkpoints'] as unknown[]).slice(1);
    const archived = canonicalize(tamperedObj);
    expect(computeMetaCoverage(archived, sha256Hex(archived), sealed)).toEqual({
      kind: 'no_match',
    });
  });

  it('reports no_match when a field other than checkpoints changed', () => {
    const sealed = sha256Hex(metaWith(1));
    const obj = JSON.parse(metaWith(2)) as Record<string, unknown>;
    obj['session_pubkey'] = 'c'.repeat(64);
    const archived = canonicalize(obj);
    expect(computeMetaCoverage(archived, sha256Hex(archived), sealed)).toEqual({
      kind: 'no_match',
    });
  });

  it('is unavailable for a meta that is not canonical JSON', () => {
    // A hand-written or legacy meta cannot be re-derived from its own parse,
    // so its earlier states are not reconstructible. Do not guess.
    const obj = JSON.parse(metaWith(2)) as Record<string, unknown>;
    const pretty = JSON.stringify(obj, null, 2);
    expect(computeMetaCoverage(pretty, sha256Hex(pretty), sha256Hex(metaWith(1)))).toEqual({
      kind: 'unavailable',
      reason: 'the .slog.meta is not in canonical form',
    });
  });

  it('is unavailable for unparseable or wrongly-shaped meta', () => {
    const target = sha256Hex(metaWith(1));
    expect(computeMetaCoverage('{{{', sha256Hex('{{{'), target).kind).toBe('unavailable');
    expect(computeMetaCoverage('[]', sha256Hex('[]'), target).kind).toBe('unavailable');
    expect(computeMetaCoverage('{"a":1}', sha256Hex('{"a":1}'), target).kind).toBe('unavailable');
  });

  it('is unavailable when the manifest carries no usable digest', () => {
    const meta = metaWith(1);
    expect(computeMetaCoverage(meta, sha256Hex(meta), null).kind).toBe('unavailable');
  });
});

describe('resolveAmbiguousCoverage', () => {
  const REASON = 'two logs claim this session';

  it('returns a single claimant unchanged — the ordinary, non-ambiguous path', () => {
    expect(resolveAmbiguousCoverage([{ kind: 'exact' }], REASON)).toEqual({ kind: 'exact' });
  });

  it('keeps the verdict when every claimant agrees', () => {
    // A byte-identical backup copy of `.provenance/`. Agreement is an answer:
    // whichever file the seal was written over, this is what it says.
    const partial = { kind: 'partial', sealed: 10, total: 20, unit: 'bytes' } as const;
    expect(resolveAmbiguousCoverage([partial, partial], REASON)).toEqual(partial);
  });

  it('keeps a no_match every claimant shares — ambiguity is not a licence', () => {
    // THE DANGEROUS DIRECTION. If ambiguity always suppressed the verdict, a
    // student could append to their `.slog`, copy it under a second filename,
    // and buy silence. "No file in this bundle claiming this session reproduces
    // the sealed digest" is established regardless of which one the seal meant.
    expect(resolveAmbiguousCoverage([{ kind: 'no_match' }, { kind: 'no_match' }], REASON)).toEqual({
      kind: 'no_match',
    });
  });

  it('answers indeterminate when the claimants disagree', () => {
    // One copy satisfies the seal and one contradicts it, and nothing in the
    // archive says which one the seal was written over. "We cannot check" is a
    // different fact from "the bytes do not match", and saying the second here
    // is how a duplicated log became a maximum-severity tamper finding.
    expect(resolveAmbiguousCoverage([{ kind: 'exact' }, { kind: 'no_match' }], REASON)).toEqual({
      kind: 'indeterminate',
      reason: REASON,
    });
  });

  it('answers indeterminate when the claimants seal different amounts', () => {
    expect(
      resolveAmbiguousCoverage(
        [
          { kind: 'partial', sealed: 10, total: 20, unit: 'bytes' },
          { kind: 'partial', sealed: 10, total: 30, unit: 'bytes' },
        ],
        REASON,
      ),
    ).toEqual({ kind: 'indeterminate', reason: REASON });
  });

  it('answers indeterminate rather than guessing when there is no claimant at all', () => {
    expect(resolveAmbiguousCoverage([], REASON)).toEqual({ kind: 'indeterminate', reason: REASON });
  });
});
