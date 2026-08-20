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
 * ## Working on a second machine
 *
 * The student does NOT move this value. They install the recorder on the other
 * machine, which generates its OWN master secret, and enrol that machine on the
 * enrollment page. Signing in with the same account returns the SAME global
 * `student_ref`, so the second machine gets its own credential over the same
 * identity — and contributor resolution, which groups on `student_ref`, sees one
 * person. Two machines, two keys, one contributor; swap between them freely.
 *
 * ## Backup and recovery
 *
 * There is no escrow and no server-side key store, by design — so nobody can
 * recover this for a student. That is what **"Provenance: Back Up Student
 * Identity Secret"** is for: it shows the 64-hex-character string so the student
 * can keep it in a password manager, and **"Provenance: Restore Student Identity
 * Secret"** puts it back if the keyring is wiped or the machine is rebuilt. Keys
 * are re-derived by HKDF (`deriveCourseKeypair` / `deriveStudentKeypair`)
 * byte-identically, so every credential they already hold keeps working and
 * nothing has to be re-minted.
 *
 * If the secret is lost with no backup, nothing breaks and nothing is
 * unrecoverable at the level that matters: the student enrols that machine
 * again, exactly as if it were new. Past bundles remain verifiable, because each
 * one carries the credential that was current when it was recorded.
 *
 * ## Why enrollment tokens live here too
 *
 * A token is a signed public statement, not a secret — it is written verbatim
 * into `session.start`. It is stored alongside the master secret anyway so there
 * is exactly ONE persistence mechanism to reason about: a wiped or unavailable
 * keyring then loses both together, which reads unambiguously as "not enrolled"
 * rather than as a half-state where a token exists but its key does not.
 *
 * ## Two identity families live here, and both stay
 *
 * - **2.1, INSTITUTION-scoped (current).** ONE {@link StoredCredential} at
 *   {@link CREDENTIAL_KEY}, with no course component — a 2.1 credential names no
 *   course and serves every course forever.
 * - **2.0, COURSE-scoped (legacy).** One {@link StoredEnrollment} per course,
 *   under {@link ENROLLMENT_KEY_PREFIX}. Minting is retired server-side, but a
 *   token a student already holds must keep working, and archived bundles that
 *   carry one must keep verifying — that is the entire justification for this
 *   system.
 *
 * {@link saveIdentityArtifact} is the single entry point and routes on the
 * SIGNED `format_version`, so a student never has to know which kind they hold.
 *
 * **A recorder holding BOTH prefers 2.1**, decided in `session-identity.ts` —
 * see the precedence note there.
 */

import {
  parseEnrollmentCert,
  parseEnrollmentToken,
  parseInstitutionCert,
  parseStudentCredential,
  generateStudentMasterSecret,
  ENROLLMENT_FORMAT_VERSION,
  INSTITUTION_IDENTITY_FORMAT_VERSION,
  STUDENT_MASTER_SECRET_BYTES,
} from '@provenance/log-core';
import type {
  EnrollmentCert,
  EnrollmentToken,
  InstitutionCert,
  StudentCredential,
} from '@provenance/log-core';

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

/** Prefix for the per-course enrollment blobs. LEGACY 2.0 — see {@link saveEnrollment}. */
export const ENROLLMENT_KEY_PREFIX = 'provenance.enrollment.';

/**
 * The SecretStorage key holding the student's 2.1 INSTITUTION-scoped credential.
 *
 * SINGULAR, with no course component, because a 2.1 credential names no course:
 * a student obtains one credential, once, and it serves every course forever
 * (`log-core/institution.ts`). That is the whole point of the 2.0 → 2.1 change,
 * and the storage key is where it becomes visible — there is nothing to key by.
 */
export const CREDENTIAL_KEY = 'provenance.studentCredential';

/**
 * Marker prefixed to the master secret when it is exported for the student to
 * keep as a backup.
 *
 * ## Why the exported secret is no longer a bare hex string
 *
 * A student master secret and a student PUBLIC key are both 64 lowercase hex
 * characters, and the enrollment page cannot tell them apart by inspection. A
 * student who runs "Back Up Student Identity Secret" and pastes the result into
 * that page's key field has handed their signing identity to a web server —
 * silently, because every check on both ends passes.
 *
 * Prefixing the exported value makes it SELF-IDENTIFYING, which converts that
 * silent catastrophe into a named refusal: the analyzer looks for this exact
 * marker and hard-refuses the paste (`enrollment-token.ts`). The warning text
 * next to the field stays, but it is no longer the only defence.
 *
 * {@link importMasterSecret} accepts the value with or without the marker, so a
 * secret exported by an older build still imports and nothing is stranded.
 *
 * The analyzer restates this literal rather than importing it — it cannot depend
 * on recorder source — and `tools/enrollment-paste-conformance.test.ts` asserts
 * the two spellings are identical, so they cannot drift.
 */
export const MASTER_SECRET_EXPORT_PREFIX = 'provenance-secret-v1:';

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

/**
 * The 2.1 `{ enrollment, enrollment_cert }` pair. SAME TWO WIRE SLOTS as
 * {@link StoredEnrollment}, carrying the institution-scoped artifacts.
 *
 * The slot names are `enrollment` / `enrollment_cert` in both versions and that
 * is deliberate, not laziness: these two fields are literally two-thirds of
 * `SessionIdentity`, so `buildSessionIdentity` drops the stored pair straight in
 * and adds only `session_pubkey_sig`. There is no rename step between the paste
 * and the signed log entry, and therefore no rename step to get wrong.
 */
export type StoredCredential = {
  enrollment: StudentCredential;
  enrollment_cert: InstitutionCert;
};

/** Why a pasted 2.1 credential would be refused. Parallel to {@link EnrollmentImportError}. */
export type CredentialImportError =
  | { kind: 'invalid_json'; message: string }
  | {
      kind: 'unsupported_format_version';
      artifact: 'cert' | 'credential';
      format_version: string;
    }
  | { kind: 'invalid_credential_shape'; reason?: string }
  | { kind: 'invalid_cert_shape'; reason?: string }
  | {
      kind: 'institution_id_mismatch';
      credential_institution_id: string;
      cert_institution_id: string;
    }
  | { kind: 'secret_store_unavailable'; reason: string };

/**
 * The version-routed result of importing whatever a student pasted.
 *
 * `identity_version` is read from the SIGNED `format_version` in the cert slot,
 * never from which fields happen to be present — see {@link saveIdentityArtifact}.
 */
export type IdentityImportOk =
  | { identity_version: '2.0'; course_id: string }
  | {
      identity_version: '2.1';
      institution_id: string;
      student_ref: string;
      /** So the caller can check this machine derives it, without re-reading the store. */
      student_pubkey: string;
    };

/** Either family's import failure, plus the router's own version refusal. */
export type IdentityImportError =
  | { kind: 'invalid_json'; message: string }
  | { kind: 'unsupported_identity_version'; format_version: string }
  | { kind: 'legacy_2_0'; error: EnrollmentImportError }
  | { kind: 'current_2_1'; error: CredentialImportError };

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
 *
 * The {@link MASTER_SECRET_EXPORT_PREFIX} marker is stripped if present, so a
 * secret exported by this build and one exported by an older build both import.
 */
function normalizeHex(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, '').toLowerCase();
  return collapsed.startsWith(MASTER_SECRET_EXPORT_PREFIX)
    ? collapsed.slice(MASTER_SECRET_EXPORT_PREFIX.length)
    : collapsed;
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
 * Adopt a master secret from the student's own backup (or, equivalently, one
 * exported on another machine).
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

// ---------------------------------------------------------------------------
// Student credentials — identity 2.1, INSTITUTION-scoped
// ---------------------------------------------------------------------------

/**
 * Validate a pasted 2.1 `{ enrollment, enrollment_cert }` blob and persist it.
 *
 * Step for step the twin of {@link saveEnrollment}, in the same order and for
 * the same reasons, with the 2.1 artifacts and the 2.1 cross-field check:
 *
 *  1. JSON, and a JSON *object*.
 *  2. Version gate on BOTH slots, cert first — before any shape work, so a
 *     future 3.0 artifact is refused as a version problem and never read under
 *     2.1 rules. This mirrors `verifyIdentityChain` step 0.
 *  3. Shape, cert first, via log-core's own parsers.
 *  4. `institution_id` agreement between the credential and the cert travelling
 *     with it — the 2.1 analogue of the 2.0 `course_id` comparison.
 *
 * SIGNATURES ARE NOT CHECKED HERE, exactly as at 2.0. The 2.1 trust anchor is
 * the recorder's embedded ROOT public key, and the real walk happens at session
 * start in `session-identity.ts`. Validating here only rejects an obvious paste
 * error while the student is standing there to fix it.
 *
 * Note what step 4 does NOT do: it cannot detect the cross-institution forgery
 * `verifyIdentityChain` guards against, because that check needs the
 * root-verified anchor and this function has no anchor. It catches a student who
 * mixed two pastes, nothing more.
 */
export async function saveStudentCredentialArtifact(
  secrets: SecretStore,
  rawJson: string,
): Promise<
  StoreResult<
    { institution_id: string; student_ref: string; student_pubkey: string },
    CredentialImportError
  >
> {
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

  for (const [field, artifact] of [
    ['enrollment_cert', 'cert'],
    ['enrollment', 'credential'],
  ] as const) {
    const declared = (obj[field] as Record<string, unknown> | undefined)?.['format_version'];
    if (declared !== INSTITUTION_IDENTITY_FORMAT_VERSION) {
      return fail({
        kind: 'unsupported_format_version',
        artifact,
        format_version: typeof declared === 'string' ? declared : '',
      });
    }
  }

  const cert = parseInstitutionCert(obj['enrollment_cert']);
  if (!cert.ok) {
    return fail({
      kind: 'invalid_cert_shape',
      ...(cert.error.kind === 'invalid_shape' && cert.error.reason !== undefined
        ? { reason: cert.error.reason }
        : {}),
    });
  }
  const credential = parseStudentCredential(obj['enrollment']);
  if (!credential.ok) {
    return fail({
      kind: 'invalid_credential_shape',
      ...(credential.error.kind === 'invalid_shape' && credential.error.reason !== undefined
        ? { reason: credential.error.reason }
        : {}),
    });
  }

  if (credential.value.institution_id !== cert.value.institution_id) {
    return fail({
      kind: 'institution_id_mismatch',
      credential_institution_id: credential.value.institution_id,
      cert_institution_id: cert.value.institution_id,
    });
  }

  const stored: StoredCredential = {
    enrollment: credential.value,
    enrollment_cert: cert.value,
  };
  try {
    await secrets.store(CREDENTIAL_KEY, JSON.stringify(stored));
  } catch (e) {
    return fail({ kind: 'secret_store_unavailable', reason: describe(e) });
  }
  return ok({
    institution_id: credential.value.institution_id,
    student_ref: credential.value.student_ref,
    student_pubkey: credential.value.student_pubkey,
  });
}

/**
 * Read the stored 2.1 credential.
 *
 * Returns `undefined` for every failure, for the same reason as
 * {@link loadEnrollment}: this is on the session-start path, where the only
 * correct response to "cannot produce an identity" is to record without one.
 */
export async function loadStudentCredentialArtifact(
  secrets: SecretStore,
): Promise<StoredCredential | undefined> {
  let raw: string | undefined;
  try {
    raw = await secrets.get(CREDENTIAL_KEY);
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

  const cert = parseInstitutionCert(obj['enrollment_cert']);
  const credential = parseStudentCredential(obj['enrollment']);
  if (!cert.ok || !credential.ok) return undefined;

  return { enrollment: credential.value, enrollment_cert: cert.value };
}

/** Forget the 2.1 credential. Never touches the master secret. */
export async function clearStudentCredentialArtifact(secrets: SecretStore): Promise<void> {
  try {
    await secrets.delete(CREDENTIAL_KEY);
  } catch {
    // Best effort — nothing useful to do if the keyring is unavailable.
  }
}

// ---------------------------------------------------------------------------
// The one importer — routes on the SIGNED version
// ---------------------------------------------------------------------------

/**
 * Import whatever identity artifact a student pasted, 2.0 or 2.1.
 *
 * ## Routing on the signed version, never on which fields exist
 *
 * Both versions use the same two wire slots, so "which keys are present" says
 * nothing about which version this is. The discriminator is the
 * `format_version` INSIDE `enrollment_cert` — signed in both families, at the
 * same wire key in both — which is exactly what `verifyIdentityChain` step 0
 * reads, and for exactly the reason spelled out there: `bundle-manifest.ts` once
 * routed on the mere presence of a field and made a whole code path
 * unreachable. Presence is attacker-controlled and ambiguous; a signed version
 * is neither.
 *
 * Reading the declared version off an unvalidated object is safe precisely
 * because nothing has been trusted yet — the routed-to function re-reads and
 * re-validates it before anything is stored.
 *
 * ## Both versions remain importable, forever
 *
 * A student who still holds a 2.0 token can still import it, and a recorder that
 * already stored one keeps using it. 2.0 MINTING is retired; 2.0 handling is
 * not, and archived material is the entire justification for the system.
 */
export async function saveIdentityArtifact(
  secrets: SecretStore,
  rawJson: string,
): Promise<StoreResult<IdentityImportOk, IdentityImportError>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    return fail({ kind: 'invalid_json', message: describe(e) });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail({ kind: 'invalid_json', message: 'expected a JSON object' });
  }

  const declared = (
    (parsed as Record<string, unknown>)['enrollment_cert'] as Record<string, unknown> | undefined
  )?.['format_version'];
  const version = typeof declared === 'string' ? declared : '';

  if (version === INSTITUTION_IDENTITY_FORMAT_VERSION) {
    const saved = await saveStudentCredentialArtifact(secrets, rawJson);
    return saved.ok
      ? ok({
          identity_version: '2.1' as const,
          institution_id: saved.value.institution_id,
          student_ref: saved.value.student_ref,
          student_pubkey: saved.value.student_pubkey,
        })
      : fail({ kind: 'current_2_1', error: saved.error });
  }

  if (version === ENROLLMENT_FORMAT_VERSION) {
    const saved = await saveEnrollment(secrets, rawJson);
    return saved.ok
      ? ok({ identity_version: '2.0' as const, course_id: saved.value.course_id })
      : fail({ kind: 'legacy_2_0', error: saved.error });
  }

  return fail({ kind: 'unsupported_identity_version', format_version: version });
}
