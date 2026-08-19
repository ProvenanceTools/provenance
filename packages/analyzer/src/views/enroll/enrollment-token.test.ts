/**
 * Tests for the `/enroll` paste helpers.
 *
 * The interesting cases are all failures. A student under deadline pressure
 * half-selects a blob, drops the last brace, pastes the wrong 64-hex string, or
 * copies a whole document instead of one line — and every one of those has to
 * produce a specific, actionable message rather than a silent no-op.
 *
 * `checkRecorderPasteText` also has a correctness obligation beyond usability:
 * it must agree with the recorder's `saveEnrollment`. That is asserted here by
 * running the same corpus through log-core's `parseEnrollmentCert` /
 * `parseEnrollmentToken` — the exact functions the recorder calls — so the two
 * cannot drift without a red test.
 */

import { describe, it, expect } from 'vitest';
import {
  ENROLLMENT_FORMAT_VERSION,
  parseEnrollmentCert,
  parseEnrollmentToken,
} from '@provenance/log-core';
import type { EnrollmentResponse } from '@provenance/shared/api-schemas';
import {
  buildRecorderPasteText,
  checkRecorderPasteText,
  isSemesterId,
  normalizeStudentPubkey,
} from './enrollment-token.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBKEY = 'a'.repeat(64);
const ENROLLMENT_PUBKEY = 'b'.repeat(64);
const SIG = 'c'.repeat(128);
const COURSE_SIG = 'd'.repeat(128);

const RESPONSE: EnrollmentResponse = {
  enrollment: {
    format_version: ENROLLMENT_FORMAT_VERSION,
    student_ref: '3f0b7c22-9a1e-4a55-8b3d-2c6e1f4a8d90',
    course_id: 'berkeley-cs61b-fa26',
    student_pubkey: PUBKEY,
    issued_at: '2026-08-19T17:00:00.000Z',
    expires_at: '2026-12-20',
    enrollment_sig: SIG,
  },
  enrollment_cert: {
    format_version: ENROLLMENT_FORMAT_VERSION,
    course_id: 'berkeley-cs61b-fa26',
    enrollment_pubkey: ENROLLMENT_PUBKEY,
    valid_from: '2026-08-01',
    valid_until: '2026-12-31',
    course_sig: COURSE_SIG,
  },
  course_id: 'berkeley-cs61b-fa26',
  student_ref: '3f0b7c22-9a1e-4a55-8b3d-2c6e1f4a8d90',
  reissued: false,
};

/** The recorder's own accept/reject decision, via the functions it calls. */
function recorderWouldAccept(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  for (const field of ['enrollment_cert', 'enrollment'] as const) {
    const declared = (obj[field] as Record<string, unknown> | undefined)?.['format_version'];
    if (declared !== ENROLLMENT_FORMAT_VERSION) return false;
  }
  const cert = parseEnrollmentCert(obj['enrollment_cert']);
  if (!cert.ok) return false;
  const token = parseEnrollmentToken(obj['enrollment']);
  if (!token.ok) return false;
  return token.value.course_id === cert.value.course_id;
}

// ---------------------------------------------------------------------------
// normalizeStudentPubkey
// ---------------------------------------------------------------------------

describe('normalizeStudentPubkey', () => {
  it('accepts a bare 64-hex key', () => {
    expect(normalizeStudentPubkey(PUBKEY)).toEqual({ ok: true, pubkey: PUBKEY });
  });

  it('strips surrounding and internal whitespace from a wrapped paste', () => {
    const wrapped = `  ${PUBKEY.slice(0, 32)}\n${PUBKEY.slice(32)}\t\n`;
    expect(normalizeStudentPubkey(wrapped)).toEqual({ ok: true, pubkey: PUBKEY });
  });

  it('lowercases an uppercased key rather than letting the server 400 it', () => {
    expect(normalizeStudentPubkey(PUBKEY.toUpperCase())).toEqual({ ok: true, pubkey: PUBKEY });
  });

  it('extracts the key when the whole recorder document is pasted', () => {
    const doc =
      `Provenance enrollment key for berkeley-cs61b-fa26\n\n${PUBKEY}\n\n` +
      'This is a PUBLIC key. Give it to your course to get an enrollment token, then run\n' +
      '"Provenance: Import Enrollment Token" and paste the token back in.\n';
    expect(normalizeStudentPubkey(doc)).toEqual({ ok: true, pubkey: PUBKEY });
  });

  it('refuses to guess when a paste contains two different keys', () => {
    const result = normalizeStudentPubkey(`${PUBKEY}\n${ENROLLMENT_PUBKEY}\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/more than one key/);
  });

  it('does not mistake the first half of a 128-hex signature for a key', () => {
    const result = normalizeStudentPubkey(`enrollment_sig: ${SIG}`);
    expect(result.ok).toBe(false);
  });

  it('reports the observed length when a key is cut off', () => {
    const result = normalizeStudentPubkey(PUBKEY.slice(0, 63));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('63');
      expect(result.reason).toMatch(/cut off/);
    }
  });

  it('reports too-long separately from cut off', () => {
    const result = normalizeStudentPubkey(`${PUBKEY}ab`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('66');
      expect(result.reason).toMatch(/too long/);
    }
  });

  it('names non-hex characters as the problem', () => {
    const result = normalizeStudentPubkey(`${'z'.repeat(64)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/digits and a–f only/);
  });

  it('asks for a value when the field is empty', () => {
    const result = normalizeStudentPubkey('   \n ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Paste your enrollment key/);
  });
});

// ---------------------------------------------------------------------------
// buildRecorderPasteText
// ---------------------------------------------------------------------------

describe('buildRecorderPasteText', () => {
  it('emits exactly the two keys the recorder reads', () => {
    const parsed = JSON.parse(buildRecorderPasteText(RESPONSE)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['enrollment', 'enrollment_cert']);
  });

  it('drops the display-only echoes', () => {
    const text = buildRecorderPasteText(RESPONSE);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['reissued']).toBeUndefined();
    expect(parsed['student_ref']).toBeUndefined();
    // student_ref still travels INSIDE the token, which is what the recorder stores.
    expect((parsed['enrollment'] as Record<string, unknown>)['student_ref']).toBe(
      RESPONSE.student_ref,
    );
  });

  it('is a single line, because the recorder prompts with a one-line input box', () => {
    const text = buildRecorderPasteText(RESPONSE);
    expect(text).not.toMatch(/[\n\r]/);
    expect(text.startsWith('{')).toBe(true);
    expect(text.endsWith('}')).toBe(true);
  });

  it('produces text the recorder accepts', () => {
    const text = buildRecorderPasteText(RESPONSE);
    expect(recorderWouldAccept(text)).toBe(true);
    expect(checkRecorderPasteText(text).ok).toBe(true);
  });

  it('round-trips every field of both artifacts unchanged', () => {
    const parsed = JSON.parse(buildRecorderPasteText(RESPONSE)) as Record<string, unknown>;
    expect(parsed['enrollment']).toEqual(RESPONSE.enrollment);
    expect(parsed['enrollment_cert']).toEqual(RESPONSE.enrollment_cert);
  });
});

// ---------------------------------------------------------------------------
// checkRecorderPasteText
// ---------------------------------------------------------------------------

describe('checkRecorderPasteText', () => {
  const good = buildRecorderPasteText(RESPONSE);

  it('reports the token identity on success', () => {
    const result = checkRecorderPasteText(good);
    expect(result).toEqual({
      ok: true,
      courseId: 'berkeley-cs61b-fa26',
      studentRef: RESPONSE.student_ref,
      studentPubkey: PUBKEY,
      expiresAt: '2026-12-20',
    });
  });

  it('tolerates the whitespace a paste picks up', () => {
    expect(checkRecorderPasteText(`\n  ${good}  \n`).ok).toBe(true);
  });

  it('detects a truncated paste as truncated, not as generic bad JSON', () => {
    const result = checkRecorderPasteText(good.slice(0, good.length - 40));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('truncated');
      expect(result.message).toMatch(/cut off/);
    }
  });

  it('detects a paste that lost its opening brace', () => {
    const result = checkRecorderPasteText(good.slice(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('invalid_json');
  });

  it('rejects a JSON value that is not an object', () => {
    expect(checkRecorderPasteText('"berkeley-cs61b-fa26"')).toMatchObject({
      ok: false,
      kind: 'not_an_object',
    });
    expect(checkRecorderPasteText('[]')).toMatchObject({ ok: false, kind: 'not_an_object' });
    expect(checkRecorderPasteText('null')).toMatchObject({ ok: false, kind: 'not_an_object' });
  });

  it('asks for a value when the box is empty', () => {
    expect(checkRecorderPasteText('  ')).toMatchObject({ ok: false, kind: 'empty' });
  });

  it('gates on format_version BEFORE shape, so a 3.0 artifact is a version error', () => {
    // Deliberately also strips a required field: a version problem must never be
    // reported as a malformed artifact, whichever is checked first.
    const future = JSON.stringify({
      enrollment: { ...RESPONSE.enrollment, format_version: '3.0', enrollment_sig: undefined },
      enrollment_cert: { ...RESPONSE.enrollment_cert, format_version: '3.0' },
    });
    expect(checkRecorderPasteText(future)).toMatchObject({
      ok: false,
      kind: 'unsupported_format_version',
    });
    expect(recorderWouldAccept(future)).toBe(false);
  });

  it('rejects a missing enrollment_cert half', () => {
    const text = JSON.stringify({ enrollment: RESPONSE.enrollment });
    expect(checkRecorderPasteText(text)).toMatchObject({
      ok: false,
      kind: 'unsupported_format_version',
    });
  });

  it('rejects a cert missing a required field', () => {
    const text = JSON.stringify({
      enrollment: RESPONSE.enrollment,
      enrollment_cert: { ...RESPONSE.enrollment_cert, course_sig: undefined },
    });
    const result = checkRecorderPasteText(text);
    expect(result).toMatchObject({ ok: false, kind: 'invalid_cert_shape' });
    expect(recorderWouldAccept(text)).toBe(false);
  });

  it('rejects a token missing a required field', () => {
    const text = JSON.stringify({
      enrollment: { ...RESPONSE.enrollment, enrollment_sig: undefined },
      enrollment_cert: RESPONSE.enrollment_cert,
    });
    const result = checkRecorderPasteText(text);
    expect(result).toMatchObject({ ok: false, kind: 'invalid_token_shape' });
    expect(recorderWouldAccept(text)).toBe(false);
  });

  it('rejects a truncated signature inside an otherwise valid token', () => {
    const text = JSON.stringify({
      enrollment: { ...RESPONSE.enrollment, enrollment_sig: SIG.slice(0, 100) },
      enrollment_cert: RESPONSE.enrollment_cert,
    });
    expect(checkRecorderPasteText(text)).toMatchObject({ ok: false, kind: 'invalid_token_shape' });
  });

  it('catches a token and cert from two different courses', () => {
    const text = JSON.stringify({
      enrollment: RESPONSE.enrollment,
      enrollment_cert: { ...RESPONSE.enrollment_cert, course_id: 'berkeley-cs61c-fa26' },
    });
    const result = checkRecorderPasteText(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('course_id_mismatch');
      expect(result.message).toContain('berkeley-cs61b-fa26');
      expect(result.message).toContain('berkeley-cs61c-fa26');
    }
    expect(recorderWouldAccept(text)).toBe(false);
  });

  it('agrees with the recorder on every case in the corpus', () => {
    const corpus: string[] = [
      good,
      `  ${good}  `,
      good.slice(0, good.length - 1),
      good.slice(1),
      '{}',
      '[]',
      'null',
      '"x"',
      'not json at all',
      JSON.stringify({ enrollment: RESPONSE.enrollment }),
      JSON.stringify({ enrollment_cert: RESPONSE.enrollment_cert }),
      JSON.stringify({
        enrollment: RESPONSE.enrollment,
        enrollment_cert: { ...RESPONSE.enrollment_cert, course_id: 'other' },
      }),
      JSON.stringify({
        enrollment: { ...RESPONSE.enrollment, student_pubkey: 'zz' },
        enrollment_cert: RESPONSE.enrollment_cert,
      }),
      JSON.stringify({
        enrollment: { ...RESPONSE.enrollment, expires_at: '2020-01-01' },
        enrollment_cert: RESPONSE.enrollment_cert,
      }),
      // Unknown keys are ignored for forward compatibility — both sides must agree.
      JSON.stringify({
        enrollment: { ...RESPONSE.enrollment, future_field: 1 },
        enrollment_cert: RESPONSE.enrollment_cert,
        note: 'hello',
      }),
    ];

    for (const text of corpus) {
      expect(checkRecorderPasteText(text).ok, `disagreed on: ${text.slice(0, 60)}`).toBe(
        recorderWouldAccept(text),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// isSemesterId
// ---------------------------------------------------------------------------

describe('isSemesterId', () => {
  it('accepts a uuid, in either case, with surrounding whitespace', () => {
    expect(isSemesterId('3f0b7c22-9a1e-4a55-8b3d-2c6e1f4a8d90')).toBe(true);
    expect(isSemesterId('  3F0B7C22-9A1E-4A55-8B3D-2C6E1F4A8D90 ')).toBe(true);
  });

  it('rejects anything that would make the server 404 or Postgres throw', () => {
    expect(isSemesterId('')).toBe(false);
    expect(isSemesterId('cs61b-fa26')).toBe(false);
    expect(isSemesterId('3f0b7c22-9a1e-4a55-8b3d')).toBe(false);
    expect(isSemesterId("3f0b7c22-9a1e-4a55-8b3d-2c6e1f4a8d90'; drop table --")).toBe(false);
  });
});
