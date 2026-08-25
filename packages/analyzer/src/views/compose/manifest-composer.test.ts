/**
 * Unit tests for the manifest composer's pure logic.
 *
 * The properties that matter, and which test carries each:
 *
 *  - a floor signal cannot be disabled → "the policy floor"
 *  - a mismatched course_id is caught in the FORM → "course_id vs the certificate"
 *  - a manifest that would not verify is never produced → "self-verification"
 *  - the private key does not escape → "the signing key" (structural leak
 *    coverage lives in `manifest-composer.leak.test.tsx`)
 *
 * Byte identity with `tools/sign-manifest.ts` is deliberately NOT tested here:
 * a test in this package could only compare against a transcription of the CLI,
 * which is exactly the drift the gate exists to catch. It lives in
 * `tools/manifest-composer-conformance.test.ts`, which runs the real CLI.
 */

import { describe, it, expect } from 'vitest';
import {
  FLOOR_EVENT_KINDS,
  POLICY_GATED_EVENT_KINDS,
  canonicalize,
  parseManifest,
  resolveCapturePolicy,
  signManifest,
  verifyManifestChain,
} from '@provenance/log-core';
import {
  EMPTY_COMPOSER_FORM,
  MANIFEST_DOWNLOAD_FILENAME,
  POLICY_CAPTURE_TOGGLES,
  buildPolicyBlock,
  buildUnsignedManifest,
  composeSignedManifest,
  issuedAtFrom,
  parseCourseCertFile,
  splitFilesUnderReview,
  validateComposerForm,
  withCourseSigningKey,
} from './manifest-composer.js';
import { makeCourseCert, makeForm, makeKeypair } from './composer.fixture.js';

/** The root keypair, as raw bytes (to sign a cert) plus its public hex. */
async function rootKey(): Promise<{ privateKey: Uint8Array; publicKeyHex: string }> {
  const kp = await makeKeypair(0x51);
  const privateKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    privateKey[i] = Number.parseInt(kp.privateKeyHex.slice(i * 2, i * 2 + 2), 16);
  }
  return { privateKey, publicKeyHex: kp.publicKeyHex };
}

/** A course keypair + a root-signed certificate for it. */
async function setup(options: { courseId?: string; validFrom?: string; validUntil?: string } = {}) {
  const root = await rootKey();
  const course = await makeKeypair(0x22);
  const cert = await makeCourseCert({
    courseId: options.courseId ?? 'berkeley-cs61b',
    coursePubkeyHex: course.publicKeyHex,
    rootPrivateKey: root.privateKey,
    ...(options.validFrom === undefined ? {} : { validFrom: options.validFrom }),
    ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }),
  });
  return { root, course, cert };
}

// ---------------------------------------------------------------------------
// The policy floor
// ---------------------------------------------------------------------------

describe('the policy floor', () => {
  it('offers exactly the knobs log-core says are gated, and no others', () => {
    const offered = new Set<string>(POLICY_CAPTURE_TOGGLES.map((t) => t.key));
    const gated = new Set<string>(Object.values(POLICY_GATED_EVENT_KINDS));
    expect([...offered].sort()).toEqual([...gated].sort());
  });

  it('offers no knob for any floor event kind', () => {
    const governed = new Set<string>(POLICY_CAPTURE_TOGGLES.flatMap((t) => [...t.eventKinds]));
    for (const floorKind of FLOOR_EVENT_KINDS) {
      expect(governed.has(floorKind)).toBe(false);
    }
  });

  it('governs only kinds that log-core lists as policy-gated', () => {
    for (const toggle of POLICY_CAPTURE_TOGGLES) {
      for (const kind of toggle.eventKinds) {
        expect(Object.keys(POLICY_GATED_EVENT_KINDS)).toContain(kind);
        // The knob a kind is governed by must be the knob log-core maps it to,
        // or the manifest would say one thing and the recorder read another.
        expect((POLICY_GATED_EVENT_KINDS as Readonly<Record<string, string>>)[kind]).toBe(
          toggle.key,
        );
      }
    }
  });

  it('emits a fixed four-key capture block and nothing else', () => {
    const block = buildPolicyBlock({
      selection_change: false,
      focus_change: true,
      terminal: false,
      heartbeat_interval_ms: 60_000,
    });
    expect(Object.keys(block)).toEqual(['capture']);
    expect(Object.keys(block.capture ?? {}).sort()).toEqual([
      'focus_change',
      'heartbeat_interval_ms',
      'selection_change',
      'terminal',
    ]);
  });

  it('round-trips through the recorder-side resolver', () => {
    const policy = {
      selection_change: false,
      focus_change: false,
      terminal: true,
      heartbeat_interval_ms: 45_000,
    };
    expect(resolveCapturePolicy(buildPolicyBlock(policy))).toEqual(policy);
  });

  it('cannot express a floor signal being off, even through the whole compose path', async () => {
    const { root, course, cert } = await setup();
    const composed = await composeSignedManifest({
      form: makeForm({
        policy: {
          selection_change: false,
          focus_change: false,
          terminal: false,
          heartbeat_interval_ms: 5_000,
        },
      }),
      keypairFileText: course.fileText,
      certFileText: cert.fileText,
      rootPubkeyHex: root.publicKeyHex,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;

    const parsed = parseManifest(composed.value.fileText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Everything the course turned off is off; everything on the floor still
    // resolves to captured, because there is no key that could say otherwise.
    const capture = (parsed.value.policy as { capture: Record<string, unknown> }).capture;
    expect(Object.keys(capture).sort()).toEqual([
      'focus_change',
      'heartbeat_interval_ms',
      'selection_change',
      'terminal',
    ]);
    for (const floorKind of FLOOR_EVENT_KINDS) {
      expect(Object.keys(capture)).not.toContain(floorKind);
    }
  });
});

// ---------------------------------------------------------------------------
// Form plumbing
// ---------------------------------------------------------------------------

describe('splitFilesUnderReview', () => {
  it('trims, drops blanks, and de-duplicates', () => {
    expect(splitFilesUnderReview('  a.py \n\n b.py\na.py\n   \n')).toEqual(['a.py', 'b.py']);
  });

  it('is empty for empty text', () => {
    expect(splitFilesUnderReview('')).toEqual([]);
    expect(splitFilesUnderReview('   \n  ')).toEqual([]);
  });
});

describe('buildUnsignedManifest', () => {
  it('emits the 2.0 key set', () => {
    const keys = Object.keys(buildUnsignedManifest(makeForm())).sort();
    expect(keys).toEqual([
      'assignment_id',
      'attachments',
      'collaboration',
      'course_id',
      'files_under_review',
      'format_version',
      'ignore',
      'issued_at',
      'policy',
      'scope',
      'semester',
      'submission',
    ]);
  });

  it('emits only the four 1.0 fields at format 1.0 — no format_version, no policy', () => {
    const keys = Object.keys(buildUnsignedManifest(makeForm({ format: '1.0' }))).sort();
    expect(keys).toEqual(['assignment_id', 'files_under_review', 'issued_at', 'semester']);
  });

  it('trims the signed string fields', () => {
    const built = buildUnsignedManifest(
      makeForm({ assignment_id: '  proj2  ', semester: ' fa26 ', course_id: ' berkeley-cs61b ' }),
    );
    expect(built.assignment_id).toBe('proj2');
    expect(built.semester).toBe('fa26');
    expect(built.course_id).toBe('berkeley-cs61b');
  });
});

// ---------------------------------------------------------------------------
// course_id vs the certificate — chain step 3, caught in the form
// ---------------------------------------------------------------------------

describe('course_id vs the certificate', () => {
  it('reports a mismatch on the course_id field, naming the certificate id', async () => {
    const { cert } = await setup({ courseId: 'berkeley-cs61b' });
    const issues = validateComposerForm(makeForm({ course_id: 'berkeley-cs61c' }), cert.cert);
    const issue = issues.find((i) => i.field === 'course_id');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('berkeley-cs61b');
    expect(issue?.message).toContain('step 3');
  });

  it('reports nothing when they agree', async () => {
    const { cert } = await setup();
    const issues = validateComposerForm(makeForm(), cert.cert);
    expect(issues).toEqual([]);
  });

  it('refuses to compose, and produces no bytes, when they disagree', async () => {
    const { root, course, cert } = await setup({ courseId: 'berkeley-cs61b' });
    const composed = await composeSignedManifest({
      form: makeForm({ course_id: 'berkeley-cs61c' }),
      keypairFileText: course.fileText,
      certFileText: cert.fileText,
      rootPubkeyHex: root.publicKeyHex,
    });
    expect(composed.ok).toBe(false);
    if (composed.ok) return;
    expect(composed.error.kind).toBe('invalid_form');
    expect(composed).not.toHaveProperty('value');
    if (composed.error.kind !== 'invalid_form') return;
    expect(composed.error.issues.map((i) => i.field)).toContain('course_id');
  });

  it('is caught even if the form check is bypassed — the chain walk refuses it too', async () => {
    // Simulates the form check being wrong or absent: sign against a cert for a
    // DIFFERENT course. Chain step 3 must still refuse, so the form check is a
    // usability layer over a real control rather than the only control.
    const { root, course } = await setup();
    const otherCert = await makeCourseCert({
      courseId: 'berkeley-cs61c',
      coursePubkeyHex: course.publicKeyHex,
      rootPrivateKey: root.privateKey,
    });
    const unsigned = buildUnsignedManifest(makeForm({ course_id: 'berkeley-cs61b' }));
    const signedResult = await withCourseSigningKey(course.fileText, (priv) =>
      signManifest(unsigned, priv),
    );
    expect(signedResult.ok).toBe(true);
    if (!signedResult.ok) return;
    const walked = await verifyManifestChain(
      { ...unsigned, sig: signedResult.value, course_cert: otherCert.cert },
      root.publicKeyHex,
    );
    expect(walked.ok).toBe(false);
    if (walked.ok) return;
    expect(walked.error.kind).toBe('course_id_mismatch');
  });
});

// ---------------------------------------------------------------------------
// The certificate file
// ---------------------------------------------------------------------------

describe('parseCourseCertFile', () => {
  it('accepts a real minted certificate', async () => {
    const { cert } = await setup();
    const parsed = parseCourseCertFile(cert.fileText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.course_id).toBe('berkeley-cs61b');
  });

  it('refuses a keypair file BEFORE shape validation, and says which file it is', async () => {
    const course = await makeKeypair(0x22);
    const parsed = parseCourseCertFile(course.fileText);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.kind).toBe('looks_like_a_private_key');
    // The refusal must not quote the thing it refused.
    expect(parsed.error.message).not.toContain(course.privateKeyHex);
    expect(parsed.error.message).not.toContain(course.publicKeyHex);
  });

  it('refuses a private-key file even when it would otherwise parse as a certificate', async () => {
    const { root, course, cert } = await setup();
    const hybrid = JSON.stringify({ ...cert.cert, private_key_hex: course.privateKeyHex });
    const parsed = parseCourseCertFile(hybrid);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.kind).toBe('looks_like_a_private_key');
    expect(parsed.error.message).not.toContain(course.privateKeyHex);
    expect(root.publicKeyHex.length).toBe(64);
  });

  it('never echoes file content in a JSON parse failure', async () => {
    const course = await makeKeypair(0x22);
    // Trailing garbage after valid JSON: V8's message quotes the input.
    const parsed = parseCourseCertFile(`{"private_key_hex_x":"${course.privateKeyHex}"} trailing`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.kind).toBe('invalid_json');
    expect(parsed.error.message).not.toContain(course.privateKeyHex);
  });
});

// ---------------------------------------------------------------------------
// The signing key
// ---------------------------------------------------------------------------

describe('the signing key', () => {
  it('zeroes the private key bytes after the callback returns', async () => {
    const course = await makeKeypair(0x22);
    let captured: Uint8Array | null = null;
    const result = await withCourseSigningKey(course.fileText, async (priv) => {
      captured = priv;
      expect(priv.some((b) => b !== 0)).toBe(true);
      return 'done';
    });
    expect(result.ok).toBe(true);
    expect(captured).not.toBeNull();
    expect([...(captured as unknown as Uint8Array)].every((b) => b === 0)).toBe(true);
  });

  it('zeroes the private key bytes even when the callback throws', async () => {
    const course = await makeKeypair(0x22);
    let captured: Uint8Array | null = null;
    await expect(
      withCourseSigningKey(course.fileText, async (priv) => {
        captured = priv;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect([...(captured as unknown as Uint8Array)].every((b) => b === 0)).toBe(true);
  });

  it('never returns the private key', async () => {
    const course = await makeKeypair(0x22);
    const result = await withCourseSigningKey(course.fileText, async (_priv, pub) => pub);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result)).not.toContain(course.privateKeyHex);
    expect(result.value).toBe(course.publicKeyHex);
  });

  it('refuses a certificate chosen in the keypair slot', async () => {
    const { cert } = await setup();
    const result = await withCourseSigningKey(cert.fileText, async () => 'unreachable');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('looks_like_a_certificate');
  });

  it('refuses a malformed key without echoing it', async () => {
    const result = await withCourseSigningKey(
      JSON.stringify({ public_key_hex: 'ABCD', private_key_hex: 'not-hex-at-all' }),
      async () => 'unreachable',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('malformed_hex');
    expect(result.error.message).not.toContain('not-hex-at-all');
  });

  it('never echoes file content in a JSON parse failure', async () => {
    const course = await makeKeypair(0x22);
    const result = await withCourseSigningKey(
      `{"private_key_hex":"${course.privateKeyHex}"} trailing`,
      async () => 'unreachable',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain(course.privateKeyHex);
  });
});

// ---------------------------------------------------------------------------
// Self-verification — nothing unverified is ever produced
// ---------------------------------------------------------------------------

describe('self-verification', () => {
  it('produces a manifest that verifies against the real chain', async () => {
    const { root, course, cert } = await setup();
    const composed = await composeSignedManifest({
      form: makeForm(),
      keypairFileText: course.fileText,
      certFileText: cert.fileText,
      rootPubkeyHex: root.publicKeyHex,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;

    expect(composed.value.filename).toBe(MANIFEST_DOWNLOAD_FILENAME);
    expect(composed.value.fileText.endsWith('\n')).toBe(true);
    expect(composed.value.windowWarning).toBeNull();
    expect(composed.value.chain?.course_id).toBe('berkeley-cs61b');

    const parsed = parseManifest(composed.value.fileText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const walked = await verifyManifestChain(parsed.value, root.publicKeyHex);
    expect(walked.ok).toBe(true);
  });

  it('emits canonical bytes — the file is its own canonical form plus a newline', async () => {
    const { root, course, cert } = await setup();
    const composed = await composeSignedManifest({
      form: makeForm(),
      keypairFileText: course.fileText,
      certFileText: cert.fileText,
      rootPubkeyHex: root.publicKeyHex,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    const reparsed: unknown = JSON.parse(composed.value.fileText);
    expect(canonicalize(reparsed) + '\n').toBe(composed.value.fileText);
  });

  it('refuses to produce anything when the root key does not match the certificate', async () => {
    const { course, cert } = await setup();
    const wrongRoot = await makeKeypair(0x77);
    const composed = await composeSignedManifest({
      form: makeForm(),
      keypairFileText: course.fileText,
      certFileText: cert.fileText,
      rootPubkeyHex: wrongRoot.publicKeyHex,
    });
    expect(composed.ok).toBe(false);
    if (composed.ok) return;
    expect(composed.error.kind).toBe('self_verification_failed');
    expect(composed).not.toHaveProperty('value');
  });

  it('refuses to produce anything at 2.0 with no root key at all', async () => {
    const { course, cert } = await setup();
    const composed = await composeSignedManifest({
      form: makeForm(),
      keypairFileText: course.fileText,
      certFileText: cert.fileText,
      rootPubkeyHex: null,
    });
    expect(composed.ok).toBe(false);
    if (composed.ok) return;
    expect(composed.error.kind).toBe('missing_root_pubkey');
  });

  it('refuses a keypair the certificate does not authorize', async () => {
    const { root, cert } = await setup();
    const otherKey = await makeKeypair(0x33);
    const composed = await composeSignedManifest({
      form: makeForm(),
      keypairFileText: otherKey.fileText,
      certFileText: cert.fileText,
      rootPubkeyHex: root.publicKeyHex,
    });
    expect(composed.ok).toBe(false);
    if (composed.ok) return;
    expect(composed.error.kind).toBe('keypair_not_certified');
  });

  it('refuses a keypair file that lies about its own public half', async () => {
    // public_key_hex says the certified key; private_key_hex is a different key.
    // Only actually verifying the signature catches this — the public-half
    // comparison passes.
    const { root, course, cert } = await setup();
    const impostor = await makeKeypair(0x44);
    const liar = JSON.stringify({
      public_key_hex: course.publicKeyHex,
      private_key_hex: impostor.privateKeyHex,
    });
    const composed = await composeSignedManifest({
      form: makeForm(),
      keypairFileText: liar,
      certFileText: cert.fileText,
      rootPubkeyHex: root.publicKeyHex,
    });
    expect(composed.ok).toBe(false);
    if (composed.ok) return;
    expect(composed.error.kind).toBe('self_verification_failed');
  });

  it('refuses at 1.0 too when the keypair halves are not a pair', async () => {
    const course = await makeKeypair(0x22);
    const impostor = await makeKeypair(0x44);
    const composed = await composeSignedManifest({
      form: makeForm({ format: '1.0' }),
      keypairFileText: JSON.stringify({
        public_key_hex: course.publicKeyHex,
        private_key_hex: impostor.privateKeyHex,
      }),
      certFileText: null,
      rootPubkeyHex: null,
    });
    expect(composed.ok).toBe(false);
    if (composed.ok) return;
    expect(composed.error.kind).toBe('self_verification_failed');
  });

  it('returns no private key material on the success value', async () => {
    const { root, course, cert } = await setup();
    const composed = await composeSignedManifest({
      form: makeForm(),
      keypairFileText: course.fileText,
      certFileText: cert.fileText,
      rootPubkeyHex: root.publicKeyHex,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(JSON.stringify(composed.value)).not.toContain(course.privateKeyHex);
    expect(composed.value.coursePublicKeyHex).toBe(course.publicKeyHex);
  });
});

// ---------------------------------------------------------------------------
// 1.0 legacy
// ---------------------------------------------------------------------------

describe('1.0 legacy output', () => {
  it('carries no format_version, course_cert, or policy', async () => {
    const course = await makeKeypair(0x22);
    const composed = await composeSignedManifest({
      form: makeForm({ format: '1.0' }),
      keypairFileText: course.fileText,
      certFileText: null,
      rootPubkeyHex: null,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.value.chain).toBeNull();
    const obj = JSON.parse(composed.value.fileText) as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual([
      'assignment_id',
      'files_under_review',
      'issued_at',
      'semester',
      'sig',
    ]);
  });

  it('needs no certificate and no root key', async () => {
    const course = await makeKeypair(0x22);
    const issues = validateComposerForm(makeForm({ format: '1.0' }), null);
    expect(issues).toEqual([]);
    const composed = await composeSignedManifest({
      form: makeForm({ format: '1.0' }),
      keypairFileText: course.fileText,
      certFileText: null,
      rootPubkeyHex: null,
    });
    expect(composed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The validity window — non-fatal, per program spec §4
// ---------------------------------------------------------------------------

describe('the certificate validity window', () => {
  it('warns but still produces a manifest when issued_at is out of window', async () => {
    const { root, course, cert } = await setup({
      validFrom: '2025-08-20',
      validUntil: '2026-01-15',
    });
    const composed = await composeSignedManifest({
      form: makeForm(),
      keypairFileText: course.fileText,
      certFileText: cert.fileText,
      rootPubkeyHex: root.publicKeyHex,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.value.windowWarning).toContain('outside');
    expect(composed.value.fileText.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

describe('validateComposerForm', () => {
  it('requires the 1.x fields', () => {
    const issues = validateComposerForm(
      makeForm({
        format: '1.0',
        assignment_id: '  ',
        semester: '',
        issued_at: '',
        files_under_review: [],
      }),
      null,
    );
    expect(issues.map((i) => i.field).sort()).toEqual([
      'assignment_id',
      'files_under_review',
      'issued_at',
      'semester',
    ]);
  });

  it('rejects an issued_at that is not ISO 8601', () => {
    const issues = validateComposerForm(
      makeForm({ format: '1.0', issued_at: 'next tuesday' }),
      null,
    );
    expect(issues.map((i) => i.field)).toEqual(['issued_at']);
  });

  it('renders a clock as a whole-second UTC issued_at that validates', () => {
    const at = issuedAtFrom(new Date('2026-09-08T17:04:31.412Z'));
    expect(at).toBe('2026-09-08T17:04:31Z');
    expect(validateComposerForm(makeForm({ format: '1.0', issued_at: at }), null)).toEqual([]);
  });

  it('renders a non-UTC clock in UTC', () => {
    expect(issuedAtFrom(new Date('2026-09-08T17:04:31+02:00'))).toBe('2026-09-08T15:04:31Z');
  });

  it('requires a certificate at 2.0', () => {
    const issues = validateComposerForm(makeForm(), null);
    expect(issues.map((i) => i.field)).toEqual(['course_cert']);
  });

  it('rejects a heartbeat interval outside the clamp range', async () => {
    const { cert } = await setup();
    for (const ms of [4_999, 120_001]) {
      const issues = validateComposerForm(
        makeForm({
          policy: {
            selection_change: true,
            focus_change: true,
            terminal: true,
            heartbeat_interval_ms: ms,
          },
        }),
        cert.cert,
      );
      expect(issues.map((i) => i.field)).toEqual(['heartbeat_interval_ms']);
    }
  });

  it('accepts the clamp boundaries', async () => {
    const { cert } = await setup();
    for (const ms of [5_000, 120_000]) {
      const issues = validateComposerForm(
        makeForm({
          policy: {
            selection_change: true,
            focus_change: true,
            terminal: true,
            heartbeat_interval_ms: ms,
          },
        }),
        cert.cert,
      );
      expect(issues).toEqual([]);
    }
  });

  it('rejects a non-integer heartbeat interval', async () => {
    const { cert } = await setup();
    const issues = validateComposerForm(
      makeForm({
        policy: {
          selection_change: true,
          focus_change: true,
          terminal: true,
          heartbeat_interval_ms: Number.NaN,
        },
      }),
      cert.cert,
    );
    expect(issues.map((i) => i.field)).toEqual(['heartbeat_interval_ms']);
  });
});

// ---------------------------------------------------------------------------
// The scope lists — ignore and attachments
// ---------------------------------------------------------------------------

describe('the scope lists', () => {
  it('emits ignore and attachments at 2.0 and neither at 1.x', () => {
    const form = {
      ...EMPTY_COMPOSER_FORM,
      assignment_id: 'a',
      semester: 'fa26',
      issued_at: '2026-09-08T00:00:00Z',
      course_id: 'c',
      files_under_review: ['src/'],
      ignore: ['*.class'],
      attachments: ['logs/'],
    };
    const v2 = buildUnsignedManifest(form) as Record<string, unknown>;
    expect(v2['ignore']).toEqual(['*.class']);
    expect(v2['attachments']).toEqual(['logs/']);

    const v1 = buildUnsignedManifest({ ...form, format: '1.0' }) as Record<string, unknown>;
    expect('ignore' in v1).toBe(false);
    expect('attachments' in v1).toBe(false);
  });

  it('reports the offending entry and why, per list', () => {
    const form = {
      ...EMPTY_COMPOSER_FORM,
      assignment_id: 'a',
      semester: 'fa26',
      issued_at: '2026-09-08T00:00:00Z',
      course_id: 'c',
      files_under_review: ['src/*.java'],
      ignore: ['../escape'],
      attachments: ['a?.log'],
    };
    const issues = validateComposerForm(form, null);
    const byField = new Map(issues.map((i) => [i.field, i.message]));
    expect(byField.get('files_under_review')).toContain('src/*.java');
    expect(byField.get('ignore')).toContain('../escape');
    expect(byField.get('attachments')).toContain('a?.log');
  });

  it('accepts empty ignore and attachments lists', () => {
    const form = {
      ...EMPTY_COMPOSER_FORM,
      assignment_id: 'a',
      semester: 'fa26',
      issued_at: '2026-09-08T00:00:00Z',
      course_id: 'c',
      files_under_review: ['Main.java'],
    };
    const issues = validateComposerForm(form, null);
    expect(issues.some((i) => i.field === 'ignore')).toBe(false);
    expect(issues.some((i) => i.field === 'attachments')).toBe(false);
  });
});
