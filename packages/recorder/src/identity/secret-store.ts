/**
 * Student master secret + per-course enrollment storage (program spec §5a).
 *
 * ## Where the secrets live
 *
 * Everything here goes through VS Code's **`SecretStorage`** — `ExtensionContext.secrets`
 * — and nowhere else. Concretely that is the OS credential vault: Keychain on
 * macOS, DPAPI-backed Credential Manager on Windows, libsecret/gnome-keyring on
 * Linux. Deliberately NOT `globalState` (a plaintext JSON file under the
 * extension's global storage dir) and NOT a dotfile in the workspace:
 *
 *  - the master secret is the one value that lets someone sign as this student in
 *    *every* course, forever. Program spec §5a: it "never leaves the machine, is
 *    never sent to a server, and is never written into a log or a bundle";
 *  - a workspace file would be committed to a git-submission repo by accident,
 *    and would be readable by a lab partner sharing a 61B repo;
 *  - `SecretStorage` is per-**machine and per-user**, not per-workspace, which is
 *    exactly the scope the secret needs — one student takes many courses, in many
 *    workspaces, and must present the same identity in all of them.
 *
 * ## Moving to a new machine
 *
 * There is no escrow and no server-side key store, by design — so nobody can
 * recover this for a student. The student runs **"Provenance: Export Student
 * Identity Secret"** on the old machine, copies the 64-hex-character string it
 * shows, and runs **"Provenance: Import Student Identity Secret"** on the new
 * one. Their per-course keys are then re-derived by HKDF (`deriveCourseKeypair`),
 * byte-identically, so every enrollment token they already hold keeps working and
 * nothing has to be re-minted.
 *
 * If the secret is lost outright, the student generates a fresh one and asks for
 * a **new enrollment token** per course; past bundles remain verifiable, because
 * each one carries the token that was current when it was recorded.
 *
 * ## Why enrollment tokens live here too
 *
 * A token is a signed public statement, not a secret — it is written verbatim
 * into `session.start`. It is stored alongside the master secret anyway so there
 * is exactly ONE persistence mechanism to reason about: a wiped or unavailable
 * keyring then loses both together, which reads unambiguously as "not enrolled"
 * rather than as a half-state where a token exists but its key does not.
 */

import {
  parseEnrollmentCert,
  parseEnrollmentToken,
  generateStudentMasterSecret,
  ENROLLMENT_FORMAT_VERSION,
  STUDENT_MASTER_SECRET_BYTES,
} from '@provenance/log-core';
import type { EnrollmentCert, EnrollmentToken } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Seam
// ---------------------------------------------------------------------------

/**
 * The subset of `vscode.SecretStorage` this module uses.
 *
 * Structurally satisfied by the real API, so production passes
 * `context.secrets` directly. Declared as its own type so unit tests can supply
 * a map without the Extension Host (CLAUDE.md: "Mock at the seam").
 */
export type SecretStore = {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
};

/**
 * The SecretStorage key holding the hex-encoded 32-byte master secret.
 *
 * Part of the student-facing contract — it is what the export/import commands
 * name — so changing it strands existing installs.
 */
export const MASTER_SECRET_KEY = 'provenance.studentMasterSecret';

/** Prefix for the per-course enrollment blobs. */
export const ENROLLMENT_KEY_PREFIX = 'provenance.enrollment.';

/**
 * The SecretStorage key for one course's enrollment.
 *
 * `course_id` is a storage key here, not a JCS object key, so the
 * no-user-derived-object-keys constraint from `course-cert.ts` does not apply —
 * nothing about this string is ever canonicalized or signed.
 */
export function enrollmentKeyForCourse(courseId: string): string {
  return ENROLLMENT_KEY_PREFIX + courseId;
}

// ---------------------------------------------------------------------------
// Result plumbing (CLAUDE.md: errors are values when expected)
// ---------------------------------------------------------------------------

export type StoreResult<T, E> = { ok: true; value: T } | { ok: false; error: E };

const ok = <T>(value: T): StoreResult<T, never> => ({ ok: true, value });
const fail = <E>(error: E): StoreResult<never, E> => ({ ok: false, error });

export type MasterSecretError =
  /** Nothing stored. Only `loadMasterSecret` reports this; the load-or-create path creates one. */
  | { kind: 'no_master_secret' }
  /** Something is stored but is not 64 hex characters. Never overwritten automatically. */
  | { kind: 'corrupt_master_secret'; reason: string }
  /** The keyring itself failed — common on a headless Linux box with no libsecret. */
  | { kind: 'secret_store_unavailable'; reason: string };

export type EnrollmentImportError =
  | { kind: 'invalid_json'; message: string }
  | { kind: 'unsupported_format_version'; artifact: 'cert' | 'token'; format_version: string }
  | { kind: 'invalid_token_shape'; reason?: string }
  | { kind: 'invalid_cert_shape'; reason?: string }
  | { kind: 'course_id_mismatch'; token_course_id: string; cert_course_id: string }
  | { kind: 'secret_store_unavailable'; reason: string };

/** The `{ enrollment, enrollment_cert }` pair a student pastes in and we persist. */
export type StoredEnrollment = {
  enrollment: EnrollmentToken;
  enrollment_cert: EnrollmentCert;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEX_MASTER_RE = new RegExp(`^[0-9a-f]{${STUDENT_MASTER_SECRET_BYTES * 2}}$`);

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Normalize a pasted secret: students copy it out of a dialog, so a stray
 * newline or an uppercase rendering must not read as corruption.
 */
function normalizeHex(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Master secret
// ---------------------------------------------------------------------------

/** Read the stored master secret without creating one. */
export async function loadMasterSecret(
  secrets: SecretStore,
): Promise<StoreResult<Uint8Array, MasterSecretError>> {
  let stored: string | undefined;
  try {
    stored = await secrets.get(MASTER_SECRET_KEY);
  } catch (e) {
    return fail({ kind: 'secret_store_unavailable', reason: describe(e) });
  }

  if (stored === undefined || stored.length === 0) {
    return fail({ kind: 'no_master_secret' });
  }
  if (!HEX_MASTER_RE.test(stored)) {
    // NOT overwritten. A mis-encoded value may still be recoverable by hand, and
    // silently replacing it would invalidate every token the student holds.
    return fail({
      kind: 'corrupt_master_secret',
      reason: `expected ${STUDENT_MASTER_SECRET_BYTES * 2} hex characters`,
    });
  }
  return ok(fromHex(stored));
}

/**
 * Read the master secret, generating and persisting one on first use.
 *
 * A corrupt stored value is an error rather than a regeneration trigger, for the
 * reason in {@link loadMasterSecret}.
 */
export async function loadOrCreateMasterSecret(
  secrets: SecretStore,
): Promise<StoreResult<Uint8Array, MasterSecretError>> {
  const existing = await loadMasterSecret(secrets);
  if (existing.ok) return existing;
  if (existing.error.kind !== 'no_master_secret') return existing;

  const fresh = generateStudentMasterSecret();
  try {
    await secrets.store(MASTER_SECRET_KEY, toHex(fresh));
  } catch (e) {
    return fail({ kind: 'secret_store_unavailable', reason: describe(e) });
  }
  return ok(fresh);
}

/** Hex-encode the stored master secret for the student to copy to a new machine. */
export async function exportMasterSecret(
  secrets: SecretStore,
): Promise<StoreResult<string, MasterSecretError>> {
  const loaded = await loadMasterSecret(secrets);
  return loaded.ok ? ok(toHex(loaded.value)) : loaded;
}

/**
 * Adopt a master secret pasted from another machine.
 *
 * A malformed paste leaves any existing secret untouched — overwriting it on a
 * typo would be unrecoverable.
 */
export async function importMasterSecret(
  secrets: SecretStore,
  raw: string,
): Promise<StoreResult<true, MasterSecretError>> {
  const hex = normalizeHex(raw);
  if (!HEX_MASTER_RE.test(hex)) {
    return fail({
      kind: 'corrupt_master_secret',
      reason: `expected ${STUDENT_MASTER_SECRET_BYTES * 2} hex characters, got ${hex.length}`,
    });
  }
  try {
    await secrets.store(MASTER_SECRET_KEY, hex);
  } catch (e) {
    return fail({ kind: 'secret_store_unavailable', reason: describe(e) });
  }
  return ok(true as const);
}

// ---------------------------------------------------------------------------
// Enrollment tokens
// ---------------------------------------------------------------------------

/**
 * Validate a pasted `{ enrollment, enrollment_cert }` blob and persist it under
 * the course the token names.
 *
 * Shape and version only — SIGNATURES ARE NOT CHECKED HERE, because the trust
 * anchor for that is the manifest's root-verified `course_cert`, which belongs to
 * a workspace and is not in scope at import time. The real check happens at
 * session start in `session-identity.ts`, against the manifest actually being
 * recorded. Validating here is only to reject an obvious paste error while the
 * student is standing there to fix it.
 */
export async function saveEnrollment(
  secrets: SecretStore,
  rawJson: string,
): Promise<StoreResult<{ course_id: string }, EnrollmentImportError>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    return fail({ kind: 'invalid_json', message: describe(e) });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail({ kind: 'invalid_json', message: 'expected a JSON object' });
  }
  const obj = parsed as Record<string, unknown>;

  // Version gate BEFORE shape, mirroring verifyIdentityChain step 0: a future 3.0
  // artifact must be rejected as a version problem, never read under 2.0 rules.
  for (const [field, artifact] of [
    ['enrollment_cert', 'cert'],
    ['enrollment', 'token'],
  ] as const) {
    const declared = (obj[field] as Record<string, unknown> | undefined)?.['format_version'];
    if (declared !== ENROLLMENT_FORMAT_VERSION) {
      return fail({
        kind: 'unsupported_format_version',
        artifact,
        format_version: typeof declared === 'string' ? declared : '',
      });
    }
  }

  const cert = parseEnrollmentCert(obj['enrollment_cert']);
  if (!cert.ok) {
    return fail({
      kind: 'invalid_cert_shape',
      ...(cert.error.kind === 'invalid_shape' && cert.error.reason !== undefined
        ? { reason: cert.error.reason }
        : {}),
    });
  }
  const token = parseEnrollmentToken(obj['enrollment']);
  if (!token.ok) {
    return fail({
      kind: 'invalid_token_shape',
      ...(token.error.kind === 'invalid_shape' && token.error.reason !== undefined
        ? { reason: token.error.reason }
        : {}),
    });
  }

  // Caught here as well as in the chain walk: storing a pair that can never
  // verify would leave the student "enrolled" while every session silently
  // omitted an identity.
  if (token.value.course_id !== cert.value.course_id) {
    return fail({
      kind: 'course_id_mismatch',
      token_course_id: token.value.course_id,
      cert_course_id: cert.value.course_id,
    });
  }

  const stored: StoredEnrollment = { enrollment: token.value, enrollment_cert: cert.value };
  try {
    await secrets.store(enrollmentKeyForCourse(token.value.course_id), JSON.stringify(stored));
  } catch (e) {
    return fail({ kind: 'secret_store_unavailable', reason: describe(e) });
  }
  return ok({ course_id: token.value.course_id });
}

/**
 * Read the stored enrollment for one course.
 *
 * Returns `undefined` for every failure — absent, unreadable keyring, corrupt
 * blob. This is on the session-start path, where the only correct response to
 * "cannot produce an identity" is to record without one.
 */
export async function loadEnrollment(
  secrets: SecretStore,
  courseId: string,
): Promise<StoredEnrollment | undefined> {
  let raw: string | undefined;
  try {
    raw = await secrets.get(enrollmentKeyForCourse(courseId));
  } catch {
    return undefined;
  }
  if (raw === undefined || raw.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;

  const cert = parseEnrollmentCert(obj['enrollment_cert']);
  const token = parseEnrollmentToken(obj['enrollment']);
  if (!cert.ok || !token.ok) return undefined;

  return { enrollment: token.value, enrollment_cert: cert.value };
}

/** Forget one course's enrollment. Never touches the master secret. */
export async function clearEnrollment(secrets: SecretStore, courseId: string): Promise<void> {
  try {
    await secrets.delete(enrollmentKeyForCourse(courseId));
  } catch {
    // Best effort — there is nothing useful to do if the keyring is unavailable.
  }
}
