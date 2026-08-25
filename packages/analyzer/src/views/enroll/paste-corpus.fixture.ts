/**
 * The shared drift corpus for the `/enroll` paste artifact.
 *
 * ## Why this is a module and not a `const` inside a test file
 *
 * TWO suites must run the IDENTICAL cases, and they live in different
 * dependency graphs:
 *
 *  - `enrollment-token.test.ts` (this package) runs them through
 *    `checkRecorderPasteText` and through a transcription of the recorder's
 *    decision built from log-core's parsers;
 *  - `tools/enrollment-paste-conformance.test.ts` runs them through
 *    `checkRecorderPasteText` and through the recorder's REAL compiled
 *    `saveIdentityArtifact` from `packages/recorder/dist/`.
 *
 * If each suite kept its own list they would be two lookalike lists, and the
 * moment one grew a case the other did not, the "these two ends agree" claim
 * would quietly cover less than it appears to. Defining the cases once makes
 * that impossible: adding a case here adds it to both gates at once.
 *
 * It is a `.fixture.ts` rather than a `.test.ts` because importing a test file
 * would re-register its `describe` blocks inside whichever suite imported it.
 * Nothing in the shipped app imports this, so it is tree-shaken out of the
 * bundle.
 *
 * The signatures below are placeholders. Neither end verifies signatures at
 * import time — the 2.1 anchor is the recorder's embedded ROOT key, which a
 * browser does not have — so shape and version are the whole of what these
 * cases exercise. Real signatures appear in the tools gate, where the chain is
 * actually walked.
 */

import { INSTITUTION_IDENTITY_FORMAT_VERSION } from '@provenance/log-core';
import type { StudentCredentialResponse } from '@provenance/shared/api-schemas';
import { buildRecorderPasteText } from './enrollment-token.js';

export const CORPUS_PUBKEY = 'a'.repeat(64);
export const CORPUS_INSTITUTION_PUBKEY = 'b'.repeat(64);
export const CORPUS_SIG = 'c'.repeat(128);
export const CORPUS_ROOT_SIG = 'd'.repeat(128);
export const CORPUS_STUDENT_REF = '3f0b7c22-9a1e-4a55-8b3d-2c6e1f4a8d90';

/** A well-formed server response, exactly as `POST /identity/credential` returns. */
export const CORPUS_RESPONSE: StudentCredentialResponse = {
  credential: {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: 'berkeley',
    student_ref: CORPUS_STUDENT_REF,
    student_pubkey: CORPUS_PUBKEY,
    issued_at: '2026-08-19T17:00:00.000Z',
    expires_at: '2026-12-20',
    institution_sig: CORPUS_SIG,
  },
  institution_cert: {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: 'berkeley',
    institution_pubkey: CORPUS_INSTITUTION_PUBKEY,
    valid_from: '2026-08-01',
    valid_until: '2026-12-31',
    root_sig: CORPUS_ROOT_SIG,
  },
  institution_id: 'berkeley',
  student_ref: CORPUS_STUDENT_REF,
  reissued: false,
  machine_count: 1,
  key_first_issued: true,
};

/**
 * Every paste both ends must agree about.
 *
 * Ordered roughly by how a student produces them: the good case, then transport
 * damage, then structural damage, then version confusion, then forward
 * compatibility.
 */
export function pasteCorpus(): string[] {
  const good = buildRecorderPasteText(CORPUS_RESPONSE);
  return [
    good,
    `  ${good}  `,
    // Transport damage: a half-selected blob, either end.
    good.slice(0, good.length - 1),
    good.slice(1),
    // Not the artifact at all.
    '{}',
    '[]',
    'null',
    '"x"',
    'not json at all',
    // One half missing.
    JSON.stringify({ enrollment: CORPUS_RESPONSE.credential }),
    JSON.stringify({ enrollment_cert: CORPUS_RESPONSE.institution_cert }),
    // Two institutions mixed — the 2.1 analogue of a course_id mismatch.
    JSON.stringify({
      enrollment: CORPUS_RESPONSE.credential,
      enrollment_cert: { ...CORPUS_RESPONSE.institution_cert, institution_id: 'stanford' },
    }),
    // Field-level damage.
    JSON.stringify({
      enrollment: { ...CORPUS_RESPONSE.credential, student_pubkey: 'zz' },
      enrollment_cert: CORPUS_RESPONSE.institution_cert,
    }),
    JSON.stringify({
      enrollment: { ...CORPUS_RESPONSE.credential, institution_sig: CORPUS_SIG.slice(0, 100) },
      enrollment_cert: CORPUS_RESPONSE.institution_cert,
    }),
    // An expired credential is still SHAPE-valid: expiry is reported, never
    // enforced, so both ends must accept it and let the chain walk report it.
    JSON.stringify({
      enrollment: { ...CORPUS_RESPONSE.credential, expires_at: '2020-01-01' },
      enrollment_cert: CORPUS_RESPONSE.institution_cert,
    }),
    // A future version on both halves.
    JSON.stringify({
      enrollment: { ...CORPUS_RESPONSE.credential, format_version: '3.0' },
      enrollment_cert: { ...CORPUS_RESPONSE.institution_cert, format_version: '3.0' },
    }),
    // A version on one half only — the mix `verifyIdentityChain` also refuses.
    JSON.stringify({
      enrollment: { ...CORPUS_RESPONSE.credential, format_version: '3.0' },
      enrollment_cert: CORPUS_RESPONSE.institution_cert,
    }),
    // A legacy 2.0 artifact pasted into the 2.1 page.
    legacyTwoZeroPaste(),
    // Unknown keys are ignored for forward compatibility — both sides must agree.
    JSON.stringify({
      enrollment: { ...CORPUS_RESPONSE.credential, future_field: 1 },
      enrollment_cert: CORPUS_RESPONSE.institution_cert,
      note: 'hello',
    }),
  ];
}

/**
 * A shape-valid LEGACY 2.0 paste.
 *
 * The `/enroll` page never produces one — 2.0 minting is retired — but a
 * student may still hold a token from before the migration and try it here.
 * Both ends must name it a version problem rather than reading it under 2.1
 * rules, and the recorder must still ROUTE it to 2.0 storage.
 */
export function legacyTwoZeroPaste(): string {
  return JSON.stringify({
    enrollment: {
      format_version: '2.0',
      student_ref: CORPUS_STUDENT_REF,
      course_id: 'berkeley-cs61b-fa26',
      student_pubkey: CORPUS_PUBKEY,
      issued_at: '2026-08-19T17:00:00.000Z',
      expires_at: '2026-12-20',
      enrollment_sig: CORPUS_SIG,
    },
    enrollment_cert: {
      format_version: '2.0',
      course_id: 'berkeley-cs61b-fa26',
      enrollment_pubkey: CORPUS_INSTITUTION_PUBKEY,
      valid_from: '2026-08-01',
      valid_until: '2026-12-31',
      course_sig: CORPUS_ROOT_SIG,
    },
  });
}
