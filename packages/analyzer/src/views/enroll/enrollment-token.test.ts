/**
 * Tests for the `/enroll` paste helpers, at identity `format_version` 2.1.
 *
 * The interesting cases are all failures. A student under deadline pressure
 * half-selects a blob, drops the last brace, pastes the wrong 64-hex string, or
 * copies a whole document instead of one line — and every one of those has to
 * produce a specific, actionable message rather than a silent no-op.
 *
 * `checkRecorderPasteText` also has a correctness obligation beyond usability:
 * it must agree with the recorder's `saveStudentCredentialArtifact`. That is
 * asserted here by running the same corpus through log-core's
 * `parseInstitutionCert` / `parseStudentCredential` — the exact functions the
 * recorder calls — so the two cannot drift without a red test.
 *
 * `recorderWouldAccept` below is a TRANSCRIPTION of the recorder's decision,
 * which is a weaker guarantee than running the recorder itself. That gap is
 * closed by `tools/enrollment-paste-conformance.test.ts`, which drives the
 * REAL compiled importer from `packages/recorder/dist/` over the same corpus.
 * The two layers exist because this suite must stay inside the analyzer's
 * dependency graph, and `tools/` is the only place that may span both.
 *
 * The corpus is exported so the tools gate consumes the identical cases rather
 * than a lookalike list that could drift.
 */

import { describe, it, expect } from 'vitest';
import {
  INSTITUTION_IDENTITY_FORMAT_VERSION,
  parseInstitutionCert,
  parseStudentCredential,
} from '@provenance/log-core';
import {
  buildRecorderPasteText,
  checkRecorderPasteText,
  normalizeStudentPubkey,
  MASTER_SECRET_MARKER,
} from './enrollment-token.js';
import {
  CORPUS_RESPONSE as RESPONSE,
  CORPUS_PUBKEY as PUBKEY,
  CORPUS_SIG as SIG,
  CORPUS_STUDENT_REF as STUDENT_REF,
  legacyTwoZeroPaste,
  pasteCorpus,
} from './paste-corpus.fixture.js';

// ---------------------------------------------------------------------------
// The recorder's decision, transcribed
//
// The fixtures and the corpus live in `paste-corpus.fixture.ts` so that
// `tools/enrollment-paste-conformance.test.ts` runs the IDENTICAL cases through
// the recorder's real compiled importer. See that module's docstring.
// ---------------------------------------------------------------------------

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
    if (declared !== INSTITUTION_IDENTITY_FORMAT_VERSION) return false;
  }
  const cert = parseInstitutionCert(obj['enrollment_cert']);
  if (!cert.ok) return false;
  const credential = parseStudentCredential(obj['enrollment']);
  if (!credential.ok) return false;
  return credential.value.institution_id === cert.value.institution_id;
}

// ---------------------------------------------------------------------------
// normalizeStudentPubkey
// ---------------------------------------------------------------------------

describe('normalizeStudentPubkey', () => {
  it('accepts a bare 64-hex key', () => {
    expect(normalizeStudentPubkey(PUBKEY)).toEqual({ ok: true, pubkey: PUBKEY });
  });

  it('strips surrounding and internal whitespace from a wrapped paste', () => {
    const wrapped = `${PUBKEY.slice(0, 32)}\n${PUBKEY.slice(32)}\n`;
    expect(normalizeStudentPubkey(wrapped)).toEqual({ ok: true, pubkey: PUBKEY });
  });

  it('lowercases an uppercased key rather than letting the server 400 it', () => {
    expect(normalizeStudentPubkey(PUBKEY.toUpperCase())).toEqual({ ok: true, pubkey: PUBKEY });
  });

  it('extracts the key when the whole recorder document is pasted', () => {
    const doc = `Provenance enrollment key\n\n${PUBKEY}\n\nThis is a PUBLIC key.\n`;
    expect(normalizeStudentPubkey(doc)).toEqual({ ok: true, pubkey: PUBKEY });
  });

  it('refuses to guess when a paste contains two different keys', () => {
    const two = `${PUBKEY}\n${'e'.repeat(64)}`;
    const result = normalizeStudentPubkey(two);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/more than one key/);
  });

  it('does not mistake the first half of a 128-hex signature for a key', () => {
    const result = normalizeStudentPubkey(`signature: ${'f'.repeat(128)}`);
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
    if (!result.ok) expect(result.reason).toMatch(/too long/);
  });

  it('names non-hex characters as the problem', () => {
    const result = normalizeStudentPubkey(`${'z'.repeat(64)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/digits and a–f only/);
  });

  it('asks for a value when the field is empty', () => {
    expect(normalizeStudentPubkey('   ')).toEqual({
      ok: false,
      reason: 'Paste your enrollment key first.',
    });
  });

  // -------------------------------------------------------------------------
  // Master secret vs public key — both are 64 lowercase hex
  // -------------------------------------------------------------------------

  describe('refusing a master secret', () => {
    it('refuses a marked secret outright', () => {
      const result = normalizeStudentPubkey(`${MASTER_SECRET_MARKER}${'9'.repeat(64)}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/identity SECRET/);
    });

    /**
     * REGRESSION. The 2.0 version of this function accepted the recorder's
     * whole identity-secret document: the marker did not exist, and the
     * whole-document fallback found exactly one 64-hex run in it and reported
     * it as a valid key. A student who pasted that document handed their
     * signing identity to the server, and every check on both ends passed.
     */
    it('refuses the whole identity-secret document, marker or not', () => {
      const marked =
        `Provenance student identity secret\n\n${MASTER_SECRET_MARKER}${'9'.repeat(64)}\n\n` +
        'KEEP THIS PRIVATE. Anyone holding it can sign work as you, in every course.\n';
      expect(normalizeStudentPubkey(marked).ok).toBe(false);

      // Same document as an OLDER recorder build wrote it: no marker at all, so
      // only the prose gives it away.
      const unmarked =
        `Provenance student identity secret\n\n${'9'.repeat(64)}\n\n` +
        'KEEP THIS PRIVATE. Anyone holding it can sign work as you, in every course.\n';
      const result = normalizeStudentPubkey(unmarked);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/identity SECRET/);
    });

    it('is case-insensitive about the tell', () => {
      expect(normalizeStudentPubkey(`My Identity Secret is ${'9'.repeat(64)}`).ok).toBe(false);
    });

    it('runs BEFORE extraction, so the secret is never pulled out of the prose', () => {
      // If the order were reversed this would succeed with the embedded hex.
      const doc = `identity secret\n${'9'.repeat(64)}`;
      const result = normalizeStudentPubkey(doc);
      expect(result.ok).toBe(false);
    });

    it('still accepts the ordinary key document, which says PUBLIC', () => {
      const doc = `Provenance enrollment key\n\n${PUBKEY}\n\nThis is a PUBLIC key.\n`;
      expect(normalizeStudentPubkey(doc).ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// buildRecorderPasteText
// ---------------------------------------------------------------------------

describe('buildRecorderPasteText', () => {
  it('renames the HTTP fields to the two WIRE SLOTS the recorder reads', () => {
    // The response says `credential` / `institution_cert`; SessionIdentity says
    // `enrollment` / `enrollment_cert`. This is the one place that rename
    // happens, and the recorder stores the result verbatim.
    const parsed = JSON.parse(buildRecorderPasteText(RESPONSE)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['enrollment', 'enrollment_cert']);
    expect(parsed['credential']).toBeUndefined();
    expect(parsed['institution_cert']).toBeUndefined();
  });

  it('drops the display-only echoes', () => {
    const parsed = JSON.parse(buildRecorderPasteText(RESPONSE)) as Record<string, unknown>;
    expect(parsed['reissued']).toBeUndefined();
    expect(parsed['student_ref']).toBeUndefined();
    expect(parsed['institution_id']).toBeUndefined();
    // student_ref still travels INSIDE the credential, which is what is stored.
    expect((parsed['enrollment'] as Record<string, unknown>)['student_ref']).toBe(STUDENT_REF);
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
    expect(parsed['enrollment']).toEqual(RESPONSE.credential);
    expect(parsed['enrollment_cert']).toEqual(RESPONSE.institution_cert);
  });

  it('carries the signed version inside both payloads, not in the key names', () => {
    const parsed = JSON.parse(buildRecorderPasteText(RESPONSE)) as Record<
      string,
      Record<string, unknown>
    >;
    expect(parsed['enrollment']!['format_version']).toBe(INSTITUTION_IDENTITY_FORMAT_VERSION);
    expect(parsed['enrollment_cert']!['format_version']).toBe(INSTITUTION_IDENTITY_FORMAT_VERSION);
  });
});

// ---------------------------------------------------------------------------
// checkRecorderPasteText
// ---------------------------------------------------------------------------

describe('checkRecorderPasteText', () => {
  const good = buildRecorderPasteText(RESPONSE);

  it('reports the credential identity on success', () => {
    expect(checkRecorderPasteText(good)).toEqual({
      ok: true,
      institutionId: 'berkeley',
      studentRef: STUDENT_REF,
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
    expect(checkRecorderPasteText('"berkeley"')).toMatchObject({
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
      enrollment: { ...RESPONSE.credential, format_version: '3.0', institution_sig: undefined },
      enrollment_cert: { ...RESPONSE.institution_cert, format_version: '3.0' },
    });
    expect(checkRecorderPasteText(future)).toMatchObject({
      ok: false,
      kind: 'unsupported_format_version',
    });
    expect(recorderWouldAccept(future)).toBe(false);
  });

  it('refuses a legacy 2.0 token, as a version problem', () => {
    // 2.0 minting is retired, so this page never produces one — but a student
    // may still hold an old token and try it here. It must be named as a
    // version mismatch rather than silently read under 2.1 rules.
    expect(checkRecorderPasteText(legacyTwoZeroPaste())).toMatchObject({
      ok: false,
      kind: 'unsupported_format_version',
    });
  });

  it('rejects a missing enrollment_cert half', () => {
    const text = JSON.stringify({ enrollment: RESPONSE.credential });
    expect(checkRecorderPasteText(text)).toMatchObject({
      ok: false,
      kind: 'unsupported_format_version',
    });
  });

  it('rejects a cert missing a required field', () => {
    const text = JSON.stringify({
      enrollment: RESPONSE.credential,
      enrollment_cert: { ...RESPONSE.institution_cert, root_sig: undefined },
    });
    expect(checkRecorderPasteText(text)).toMatchObject({ ok: false, kind: 'invalid_cert_shape' });
    expect(recorderWouldAccept(text)).toBe(false);
  });

  it('rejects a credential missing a required field', () => {
    const text = JSON.stringify({
      enrollment: { ...RESPONSE.credential, institution_sig: undefined },
      enrollment_cert: RESPONSE.institution_cert,
    });
    expect(checkRecorderPasteText(text)).toMatchObject({
      ok: false,
      kind: 'invalid_credential_shape',
    });
    expect(recorderWouldAccept(text)).toBe(false);
  });

  it('rejects a truncated signature inside an otherwise valid credential', () => {
    const text = JSON.stringify({
      enrollment: { ...RESPONSE.credential, institution_sig: SIG.slice(0, 100) },
      enrollment_cert: RESPONSE.institution_cert,
    });
    expect(checkRecorderPasteText(text)).toMatchObject({
      ok: false,
      kind: 'invalid_credential_shape',
    });
  });

  it('catches a credential and cert from two different institutions', () => {
    const text = JSON.stringify({
      enrollment: RESPONSE.credential,
      enrollment_cert: { ...RESPONSE.institution_cert, institution_id: 'stanford' },
    });
    const result = checkRecorderPasteText(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('institution_id_mismatch');
      expect(result.message).toContain('berkeley');
      expect(result.message).toContain('stanford');
    }
    expect(recorderWouldAccept(text)).toBe(false);
  });

  it('agrees with the recorder on every case in the corpus', () => {
    for (const text of pasteCorpus()) {
      expect(checkRecorderPasteText(text).ok, `disagreed on: ${text.slice(0, 60)}`).toBe(
        recorderWouldAccept(text),
      );
    }
  });
});
