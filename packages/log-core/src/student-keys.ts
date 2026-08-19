/**
 * Student master secret and per-course key derivation (program spec §S2).
 *
 * One secret for a student to hold and back up; one unlinkable ed25519 keypair
 * per course derived from it:
 *
 *   master_secret (32 random bytes; NEVER leaves the student's machine)
 *        │ HKDF-SHA256, info bound to course_id
 *        ▼
 *   per-course ed25519 seed ──► student per-course keypair
 *        │ countersigns
 *        ▼
 *   session_pubkey  (the existing ephemeral session key)
 *
 * ## Why derive instead of generating one key per course
 *
 * Three properties, all of which a student holding N independent keypairs loses:
 *
 *  - **One thing to back up.** A student who loses their key loses the ability to
 *    prove authorship of their own work. Backing up one 32-byte secret is a
 *    request a student can actually satisfy; backing up a growing set of
 *    per-course keys is not.
 *  - **Unlinkability.** Each course sees a public key derived under a different
 *    `info`, so two courses comparing rosters cannot tell that two entries are
 *    the same person. Correlating them requires the master secret, which never
 *    leaves the machine and is never sent to any server.
 *  - **Recoverability without escrow.** Re-deriving on a new machine needs only
 *    the master secret. There is no server-side key store to breach, because
 *    there is nothing to store.
 *
 * ## THE DERIVATION IS A CROSS-LANGUAGE CONTRACT
 *
 * Three recorders (TypeScript, Kotlin, Lua) must derive **byte-identical** keys
 * from the same master secret, or a student's signature made in one editor will
 * not verify against the public key their token names. The parameters are
 * therefore pinned exactly, here and in the `student-keys.json` conformance
 * vectors:
 *
 *   algorithm  HKDF (RFC 5869) with SHA-256
 *   IKM        the 32 RAW BYTES of the master secret (not hex, not base64)
 *   salt       UTF-8 bytes of "provenance-student-key-v1" — 25 bytes.
 *              Deliberately NON-EMPTY: HKDF's "absent salt" rule (substitute
 *              HashLen zero bytes) is a place where three implementations can
 *              quietly disagree, and HMAC's own zero-padding makes an empty
 *              salt and a 32-zero-byte salt produce the same PRK — an
 *              equivalence that is true but that no port should have to know.
 *              Passing concrete bytes removes the question entirely.
 *   info       UTF-8 bytes of "provenance-student-key-v1:" + course_id
 *   L          32 bytes
 *
 * The 32-byte output IS the ed25519 secret key (seed). ed25519 accepts any
 * 32 bytes as a seed, so no rejection sampling or retry loop is needed — another
 * property that would otherwise have to agree across three ports.
 *
 * `course_id` enters the derivation as a **value** inside `info`, never as a JSON
 * object key. The permanent no-user-derived-object-keys constraint documented in
 * `course-cert.ts` is about canonicalization key ordering and does not apply to
 * `info`, which is a flat byte string: UTF-8 encoding is unambiguous across all
 * three languages. A non-ASCII `course_id` is therefore safe here, and pinned by
 * a conformance vector to prove it.
 */

import * as ed from '@noble/ed25519';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------
// Pinned HKDF parameters — see the module docstring. Changing any of these is a
// breaking change to two other repos, not a refactor.
// ---------------------------------------------------------------------------

/** Length of a student master secret, in bytes. */
export const STUDENT_MASTER_SECRET_BYTES = 32;

/**
 * HKDF `info` prefix. The full info is this string concatenated with the
 * `course_id`, then UTF-8 encoded. The trailing colon is part of the constant.
 */
export const STUDENT_KEY_HKDF_INFO_PREFIX = 'provenance-student-key-v1:';

/**
 * HKDF salt: the UTF-8 bytes of `provenance-student-key-v1` (25 bytes).
 *
 * Frozen at module load and copied on read so a caller cannot mutate the shared
 * array and silently change every subsequent derivation in the process.
 */
export const STUDENT_KEY_HKDF_SALT: Uint8Array = new TextEncoder().encode(
  'provenance-student-key-v1',
);

/** Output length of the derivation, in bytes — an ed25519 seed. */
export const STUDENT_KEY_SEED_BYTES = 32;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StudentCourseKeypair = {
  /** Hex-encoded ed25519 public key (32 bytes → 64 hex chars). */
  publicKeyHex: string;
  /**
   * Raw 32-byte ed25519 secret key — the HKDF output itself. Kept in memory
   * only; it is re-derivable from the master secret and must never be persisted.
   */
  privateKey: Uint8Array;
};

// ---------------------------------------------------------------------------
// Master secret
// ---------------------------------------------------------------------------

/**
 * Generate a fresh 32-byte student master secret.
 *
 * This is the ONLY value in the identity scheme that a student must keep and
 * back up. It never leaves the machine, is never sent to a server, and is never
 * written into a log or a bundle. Losing it means losing the ability to sign as
 * yourself in every course; leaking it means every per-course key is derivable
 * AND every course identity becomes linkable.
 */
export function generateStudentMasterSecret(): Uint8Array {
  return randomBytes(STUDENT_MASTER_SECRET_BYTES);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Derive the raw 32-byte ed25519 seed for a student's key in one course.
 *
 * Pure and synchronous. Throws (rather than returning a `Result`) on a
 * malformed input, because both failure modes are programmer errors at a call
 * site that controls both arguments — an unexpected condition, not an expected
 * one. See CLAUDE.md, "Errors are values when expected, exceptions when
 * unexpected".
 *
 * @param masterSecret Exactly {@link STUDENT_MASTER_SECRET_BYTES} raw bytes.
 * @param courseId     The course this key is for; non-empty.
 */
export function deriveCourseKeySeed(masterSecret: Uint8Array, courseId: string): Uint8Array {
  if (masterSecret.length !== STUDENT_MASTER_SECRET_BYTES) {
    throw new TypeError(
      `deriveCourseKeySeed: masterSecret must be exactly ${STUDENT_MASTER_SECRET_BYTES} bytes, got ${masterSecret.length}`,
    );
  }
  if (courseId.length === 0) {
    throw new TypeError('deriveCourseKeySeed: courseId must be a non-empty string');
  }

  const info = new TextEncoder().encode(STUDENT_KEY_HKDF_INFO_PREFIX + courseId);
  // A fresh copy of the salt each call: `hkdf` does not mutate it, but the
  // exported constant is shared and this removes any doubt.
  const salt = Uint8Array.from(STUDENT_KEY_HKDF_SALT);
  return hkdf(sha256, masterSecret, salt, info, STUDENT_KEY_SEED_BYTES);
}

/**
 * Derive a student's per-course ed25519 keypair from their master secret.
 *
 * The private key is the {@link deriveCourseKeySeed} output verbatim; the public
 * key is the ordinary ed25519 public key for that seed. This is the key that
 * signs `session_pubkey` (see `enrollment.ts`) and whose public half a course
 * binds to a roster entry inside an enrollment token.
 */
export async function deriveCourseKeypair(
  masterSecret: Uint8Array,
  courseId: string,
): Promise<StudentCourseKeypair> {
  const privateKey = deriveCourseKeySeed(masterSecret, courseId);
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKey);
  return { publicKeyHex: bytesToHex(publicKeyBytes), privateKey };
}
