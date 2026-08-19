/**
 * Test-only helper: mint a signed Manifest 2.0 (root → course_cert → manifest).
 *
 * Mirrors what course-staff tooling will produce, so analysis-core tests can
 * exercise the real trust chain rather than a hand-stubbed object. Everything
 * here is deterministic given the seeds passed in.
 *
 * Not browser-safe by design (test infrastructure only); it uses the same
 * @noble/ed25519 sha512 wiring as `build-test-bundle.ts`.
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { signCourseCert, signManifest, MANIFEST_FORMAT_VERSION_2 } from '@provenance/log-core';
import type { CourseCert, Manifest, CapturePolicyBlock } from '@provenance/log-core';

// Same wiring as build-test-bundle.ts — jsdom's WebCrypto rejects the buffers
// @noble/ed25519's default async sha512 hands it.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

export type TrustChainKeys = {
  rootPrivkey: Uint8Array;
  rootPubkeyHex: string;
  coursePrivkey: Uint8Array;
  coursePubkeyHex: string;
};

/** Deterministic root + course keypairs from fixed 32-byte seeds. */
export async function buildTrustChainKeys(
  rootSeedByte = 0x11,
  courseSeedByte = 0x22,
): Promise<TrustChainKeys> {
  const rootPrivkey = new Uint8Array(32).fill(rootSeedByte);
  const coursePrivkey = new Uint8Array(32).fill(courseSeedByte);
  return {
    rootPrivkey,
    rootPubkeyHex: bytesToHex(await ed.getPublicKeyAsync(rootPrivkey)),
    coursePrivkey,
    coursePubkeyHex: bytesToHex(await ed.getPublicKeyAsync(coursePrivkey)),
  };
}

export type BuildManifest2Opts = {
  keys: TrustChainKeys;
  courseId?: string;
  /** `course_cert.course_id`. Defaults to `courseId` — set it differently to test step 3. */
  certCourseId?: string;
  assignmentId?: string;
  semester?: string;
  issuedAt?: string;
  filesUnderReview?: string[];
  collaboration?: 'solo' | 'group';
  submission?: 'bundle' | 'git';
  scope?: 'directory' | 'repo';
  policy?: CapturePolicyBlock;
  validFrom?: string;
  validUntil?: string;
};

/**
 * Mint a fully-signed Manifest 2.0.
 *
 * The returned object is what `session.start.data.manifest` carries in a 2.0
 * bundle: signed payload + `sig` + root-signed `course_cert`.
 */
export async function buildManifest2(opts: BuildManifest2Opts): Promise<Manifest> {
  const {
    keys,
    courseId = 'berkeley-cs61b',
    assignmentId = 'hw1',
    semester = 'fa26',
    issuedAt = '2026-09-08T00:00:00Z',
    filesUnderReview = ['hw1.py'],
    collaboration = 'solo',
    submission = 'bundle',
    scope = 'directory',
    policy = { capture: {} },
    validFrom = '2026-08-20',
    validUntil = '2027-01-15',
  } = opts;
  const certCourseId = opts.certCourseId ?? courseId;

  const certPayload: Omit<CourseCert, 'root_sig'> = {
    course_id: certCourseId,
    course_pubkey: keys.coursePubkeyHex,
    valid_from: validFrom,
    valid_until: validUntil,
  };
  const course_cert: CourseCert = {
    ...certPayload,
    root_sig: await signCourseCert(certPayload, keys.rootPrivkey),
  };

  const unsigned: Omit<Manifest, 'sig'> = {
    format_version: MANIFEST_FORMAT_VERSION_2,
    course_id: courseId,
    assignment_id: assignmentId,
    semester,
    issued_at: issuedAt,
    files_under_review: filesUnderReview,
    collaboration,
    submission,
    scope,
    policy,
    course_cert,
  };

  return { ...unsigned, sig: await signManifest(unsigned, keys.coursePrivkey) };
}

/**
 * The `session.start.data` fields a 2.0 recorder writes, ready to be handed to
 * `buildTestBundle`'s per-session `sessionStart` override.
 */
export function sessionStart2(manifest: Manifest): Record<string, unknown> {
  return {
    format_version: MANIFEST_FORMAT_VERSION_2,
    manifest_sig: manifest.sig,
    manifest,
    host: {
      editor: 'vscode',
      editor_version: '1.100.0',
      editor_build: '',
      platform: 'darwin',
    },
  };
}
