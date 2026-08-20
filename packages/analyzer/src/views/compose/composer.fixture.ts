/**
 * Shared fixtures for the manifest composer.
 *
 * A `.fixture.ts` rather than a `.test.ts` so `tools/manifest-composer-conformance.test.ts`
 * can import the SAME keys, certificate and form the analyzer's own suite uses.
 * The precedent is `views/enroll/paste-corpus.fixture.ts`, shared with
 * `tools/enrollment-paste-conformance.test.ts` for the same reason: a
 * cross-graph gate that builds its own inputs is testing two things that were
 * never claimed to be the same.
 *
 * Keys are DERIVED, not hardcoded, so they are real ed25519 keypairs with real
 * signatures — `deriveStudentKeypair` is just log-core's deterministic seed →
 * keypair helper, used here as a keypair factory. Nothing about these being
 * "student" keys matters; ed25519 is ed25519.
 */

import { deriveStudentKeypair, signCourseCert } from '@provenance/log-core';
import type { CourseCert } from '@provenance/log-core';
import { EMPTY_COMPOSER_FORM } from './manifest-composer.js';
import type { ComposerForm } from './manifest-composer.js';

export type TestKeypair = {
  readonly publicKeyHex: string;
  readonly privateKeyHex: string;
  /** The JSON `tools/generate-course-keypair.ts` writes. */
  readonly fileText: string;
};

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A deterministic ed25519 keypair, in the on-disk keypair-file shape. */
export async function makeKeypair(seedByte: number): Promise<TestKeypair> {
  const { publicKeyHex, privateKey } = await deriveStudentKeypair(
    new Uint8Array(32).fill(seedByte),
  );
  const privateKeyHex = bytesToHex(privateKey);
  return {
    publicKeyHex,
    privateKeyHex,
    fileText:
      JSON.stringify(
        {
          public_key_hex: publicKeyHex,
          private_key_hex: privateKeyHex,
          generated_at: '2026-08-01T00:00:00.000Z',
          note: 'Course offline-signing key. Keep secret. See tools/generate-course-keypair.ts.',
        },
        null,
        2,
      ) + '\n',
  };
}

export type TestCourseCert = {
  readonly cert: CourseCert;
  /** The JSON `tools/mint-course-cert.ts` writes. */
  readonly fileText: string;
};

/** Mint a real root-signed certificate for `coursePubkeyHex`. */
export async function makeCourseCert(options: {
  courseId: string;
  coursePubkeyHex: string;
  rootPrivateKey: Uint8Array;
  validFrom?: string;
  validUntil?: string;
}): Promise<TestCourseCert> {
  const unsigned = {
    course_id: options.courseId,
    course_pubkey: options.coursePubkeyHex,
    valid_from: options.validFrom ?? '2026-08-20',
    valid_until: options.validUntil ?? '2027-01-15',
  };
  const root_sig = await signCourseCert(unsigned, options.rootPrivateKey);
  const cert: CourseCert = { ...unsigned, root_sig };
  return { cert, fileText: JSON.stringify(cert, null, 2) + '\n' };
}

/** A complete, valid 2.0 form. Callers override the one field under test. */
export function makeForm(overrides: Partial<ComposerForm> = {}): ComposerForm {
  return {
    ...EMPTY_COMPOSER_FORM,
    assignment_id: 'proj2',
    semester: 'fa26',
    issued_at: '2026-09-08T00:00:00Z',
    files_under_review: ['src/main.py', 'src/helpers.py'],
    course_id: 'berkeley-cs61b',
    collaboration: 'solo',
    submission: 'bundle',
    scope: 'directory',
    ...overrides,
  };
}
