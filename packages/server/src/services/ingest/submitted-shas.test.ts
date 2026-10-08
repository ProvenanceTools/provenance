/**
 * Unit tests for the persisted-submitted-shas helpers (pure; no containers).
 * The DB round-trip through runAndStoreValidation / recompute / the Source tab
 * is covered in services/scoring/recompute-submitted-shas.test.ts.
 */

import { describe, it, expect } from 'vitest';
import type { ValidationCheck } from '@provenance/analysis-core/validation/check-types.js';
import {
  attachSubmittedShas,
  readSubmittedShas,
  stripSubmittedShas,
  SUBMITTED_SHAS_FIELD,
} from './submitted-shas.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = '0123456789abcdef'.repeat(4);

function checks(): ValidationCheck[] {
  return [
    { id: 'manifest_sig', label: 'Manifest signature', status: 'pass' },
    { id: 'chain_integrity', label: 'Hash chain integrity', status: 'pass' },
    { id: 'submitted_code_match', label: 'Submitted code match', status: 'pass', detail: 'ok' },
  ];
}

describe('SUBMITTED_SHAS_FIELD', () => {
  it('is the literal the validation upsert hard-codes', () => {
    // runAndStoreValidation's ON CONFLICT clause spells the key as a SQL
    // literal ('submitted_shas'), because a bind parameter there is ambiguous
    // between jsonb's text and int `->` operators. Renaming the field here
    // without updating that SQL would silently stop the preservation.
    expect(SUBMITTED_SHAS_FIELD).toBe('submitted_shas');
  });
});

describe('attachSubmittedShas', () => {
  it('puts the shas on the check-8 entry only, without mutating the input', () => {
    const input = checks();
    const out = attachSubmittedShas(input, { 'a.py': SHA_A });
    expect(out[2]).toEqual({ ...input[2], submitted_shas: { 'a.py': SHA_A } });
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
    expect(input[2]).not.toHaveProperty('submitted_shas');
  });

  it('round-trips through readSubmittedShas, including an empty record', () => {
    expect(
      readSubmittedShas(attachSubmittedShas(checks(), { 'a.py': SHA_A, 'b/c.py': SHA_B })),
    ).toEqual({
      'a.py': SHA_A,
      'b/c.py': SHA_B,
    });
    // {} is a real record ("ingest saw the bytes; nothing was present"), and
    // must stay distinguishable from absent.
    expect(readSubmittedShas(attachSubmittedShas(checks(), {}))).toEqual({});
  });
});

describe('readSubmittedShas', () => {
  it('is undefined when the field was never written (rows ingested before it existed)', () => {
    expect(readSubmittedShas(checks())).toBeUndefined();
  });

  it('is undefined for a detail value that is not a checks array', () => {
    expect(readSubmittedShas(null)).toBeUndefined();
    expect(readSubmittedShas({})).toBeUndefined();
    expect(readSubmittedShas('x')).toBeUndefined();
    expect(readSubmittedShas([])).toBeUndefined();
  });

  it('only reads the field from the submitted_code_match entry', () => {
    const detail = checks().map((c) =>
      c.id === 'manifest_sig' ? { ...c, submitted_shas: { 'a.py': SHA_A } } : c,
    );
    expect(readSubmittedShas(detail)).toBeUndefined();
  });

  it.each([
    ['an uppercase sha', { 'a.py': SHA_A.toUpperCase() }],
    ['a short sha', { 'a.py': 'abc' }],
    ['a non-string value', { 'a.py': 42 }],
    ['an empty path', { '': SHA_A }],
    ['an array', [SHA_A]],
    ['null', null],
    ['a string', SHA_A],
  ])('treats %s as absent — the whole record, not just the entry', (_label, raw) => {
    const detail = checks().map((c) =>
      c.id === 'submitted_code_match' ? { ...c, submitted_shas: raw } : c,
    );
    expect(readSubmittedShas(detail)).toBeUndefined();
    // One bad value poisons the record: a partially trusted record could make
    // a sibling file's verdict depend on which entries happened to survive.
    if (isObj(raw)) {
      const mixed = checks().map((c) =>
        c.id === 'submitted_code_match' ? { ...c, submitted_shas: { 'ok.py': SHA_B, ...raw } } : c,
      );
      expect(readSubmittedShas(mixed)).toBeUndefined();
    }
  });
});

describe('stripSubmittedShas', () => {
  it('removes the field and leaves every other key, without mutating the input', () => {
    const stored = attachSubmittedShas(checks(), { 'a.py': SHA_A });
    const out = stripSubmittedShas(stored);
    expect(out).toEqual(checks());
    expect(stored[2]).toHaveProperty('submitted_shas');
    expect(JSON.stringify(out)).not.toContain('submitted_shas');
  });

  it('passes through entries without the field and non-object entries', () => {
    const odd: unknown[] = [null, 'x', 3, { id: 'seq_gaps', status: 'pass' }];
    expect(stripSubmittedShas(odd)).toEqual(odd);
  });
});

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
