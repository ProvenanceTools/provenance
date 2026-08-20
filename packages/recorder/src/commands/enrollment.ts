/**
 * Student-facing enrollment commands (program spec §5a, "Enrollment flow").
 *
 * ## Enrollment is a paste, not a fetch
 *
 * Recorder PRD NG2: the recorder makes **no network calls during a session**, and
 * identity gets no exception. So the flow is deliberately manual:
 *
 *   1. "Provenance: Show My Enrollment Key" copies the student's GLOBAL PUBLIC
 *      key. They paste it into their institution's `/enroll` page (a browser —
 *      anything that is not this extension).
 *   2. The server authenticates them with Google, maps them to an opaque global
 *      `student_ref`, and signs `{ enrollment, enrollment_cert }`.
 *   3. "Provenance: Import Enrollment Token" takes that JSON as a paste and
 *      persists it.
 *
 * At 2.0 steps 1 and 3 were per-COURSE and step 1 refused unless a course was
 * already recording. Neither is true any more — see `showEnrollmentKey`.
 *
 * Nothing here opens a socket, and there is no code path that could. That is the
 * property, not an implementation detail — a recorder that phones home is a
 * recorder students are right not to trust.
 *
 * ## The other two commands
 *
 * "Export/Import Student Identity Secret" exist because `SecretStorage` is an OS
 * credential vault the student cannot read by hand. Without an export there is
 * literally no way to move an identity to a second machine, and since there is no
 * escrow (§5a: no server-side key store to breach) nobody could recover it for
 * them. See `identity/secret-store.ts` for the full new-machine story.
 */

import { deriveCourseKeypair, deriveStudentKeypair } from '@provenance/log-core';
import {
  exportMasterSecret,
  importMasterSecret,
  loadEnrollment,
  loadOrCreateMasterSecret,
  saveIdentityArtifact,
  MASTER_SECRET_EXPORT_PREFIX,
} from '../identity/secret-store.js';
import type { IdentityImportError, SecretStore } from '../identity/secret-store.js';

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Everything these commands touch, injected. Production wires each to the
 * matching `vscode.window` / `vscode.env` call in extension.ts; unit tests pass
 * plain functions (CLAUDE.md: "Mock at the seam").
 */
export type EnrollmentCommandDeps = {
  secrets: SecretStore;
  /** A single-line paste prompt. `undefined` = cancelled. */
  promptInput: (opts: { prompt: string; placeHolder: string }) => Promise<string | undefined>;
  showInfo: (message: string) => void;
  showError: (message: string) => void;
  copyToClipboard: (text: string) => Promise<void>;
  /** Open a read-only document, so a long value is visible as well as copied. */
  showDocument: (text: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Show + copy the student's GLOBAL PUBLIC key, so they can obtain a credential.
 *
 * Creates the master secret on first use — the public key cannot exist without
 * it. Only the public half ever leaves this function.
 *
 * ## No course is required, and that is the whole point
 *
 * At 2.0 this derived a PER-COURSE key and so refused unless an assignment with
 * a Manifest 2.0 `.provenance-manifest` was already open and recording. That
 * requirement was one half of the deadlock identity 2.1 removes: a student needs
 * an identity BEFORE they do any work, and at 2.0 they could not even see their
 * key until a course was underway (the other half being the server's roster
 * precondition — see `log-core/institution.ts`).
 *
 * A 2.1 key is global and derived from the master secret alone, so this command
 * now works on a fresh install with nothing open.
 */
export async function showEnrollmentKey(deps: EnrollmentCommandDeps): Promise<void> {
  const master = await loadOrCreateMasterSecret(deps.secrets);
  if (!master.ok) {
    deps.showError(
      `Provenance: could not read your student identity secret (${master.error.kind}). ` +
        'If you have a backup, run "Provenance: Import Student Identity Secret".',
    );
    return;
  }

  const keypair = await deriveStudentKeypair(master.value);
  await deps.copyToClipboard(keypair.publicKeyHex);
  await deps.showDocument(
    `Provenance enrollment key\n\n${keypair.publicKeyHex}\n\n` +
      'This is a PUBLIC key, and it is the same in every course. Paste it into your\n' +
      "institution's enrollment page to get a credential, then run\n" +
      '"Provenance: Import Enrollment Token" and paste the credential back in.\n\n' +
      'It is NOT your identity secret. The secret shown by "Provenance: Export Student\n' +
      'Identity Secret" is also 64 characters and must never be typed into a website.\n',
  );
  deps.showInfo('Provenance: enrollment key copied to the clipboard.');
}

/** Render an import failure in terms a student can act on. */
function describeImportError(error: IdentityImportError): string {
  switch (error.kind) {
    case 'invalid_json':
      return (
        'that paste is not valid JSON. Use the Copy button on the enrollment page and paste ' +
        'the whole line without editing it.'
      );
    case 'unsupported_identity_version':
      return (
        `that paste declares identity version "${error.format_version || '(none)'}", which this ` +
        'recorder does not understand. Update the Provenance extension, then paste it again.'
      );
    case 'current_2_1':
      return (
        `that credential was not accepted (${error.error.kind}). Copy the whole JSON object ` +
        'from the enrollment page, including the enrollment_cert.'
      );
    case 'legacy_2_0':
      return (
        `that enrollment token was not accepted (${error.error.kind}). Copy the whole JSON ` +
        'object your course gave you, including the enrollment_cert.'
      );
  }
}

/**
 * Import a pasted `{ enrollment, enrollment_cert }` artifact and persist it.
 *
 * Accepts BOTH families, routed on the signed `format_version` — a current 2.1
 * institution credential, or a legacy 2.0 course token a student already holds.
 * The student does not have to know which they were given.
 *
 * Shape and version are checked here; SIGNATURES are not, because the real walk
 * happens at session start against the proper trust anchor
 * (`identity/session-identity.ts`). What this does check, as a courtesy while
 * the student is still here to act on it, is that the artifact's
 * `student_pubkey` is one this machine can actually derive.
 */
export async function importEnrollmentToken(deps: EnrollmentCommandDeps): Promise<void> {
  const pasted = await deps.promptInput({
    prompt: 'Paste the credential JSON issued by your institution',
    placeHolder: '{"enrollment":{...},"enrollment_cert":{...}}',
  });
  if (pasted === undefined || pasted.trim().length === 0) return;

  const saved = await saveIdentityArtifact(deps.secrets, pasted);
  if (!saved.ok) {
    deps.showError(`Provenance: ${describeImportError(saved.error)}`);
    return;
  }

  // Courtesy check — non-blocking, and deliberately AFTER the artifact is
  // stored. The artifact itself is fine; it is this machine's key that does not
  // match, and the fix is one the student can do right now. Runs for both
  // families, against whichever derivation that family uses.
  let expectedPubkey: string;
  if (saved.value.identity_version === '2.0') {
    deps.showInfo(`Provenance: enrolled in ${saved.value.course_id}.`);
    const stored = await loadEnrollment(deps.secrets, saved.value.course_id);
    if (stored === undefined) return;
    expectedPubkey = stored.enrollment.student_pubkey;
  } else {
    deps.showInfo(`Provenance: enrolled at ${saved.value.institution_id}.`);
    expectedPubkey = saved.value.student_pubkey;
  }

  const master = await loadOrCreateMasterSecret(deps.secrets);
  if (!master.ok) return;

  const derived =
    saved.value.identity_version === '2.0'
      ? await deriveCourseKeypair(master.value, saved.value.course_id)
      : await deriveStudentKeypair(master.value);

  if (derived.publicKeyHex !== expectedPubkey) {
    deps.showError(
      'Provenance: this was issued to a different student identity secret than the one on ' +
        'this machine. Run "Provenance: Import Student Identity Secret" with the secret from ' +
        'your other machine, or enrol again with the key shown by "Provenance: Show My ' +
        'Enrollment Key". Recording continues either way, without an identity claim.',
    );
  }
}

/**
 * Reveal + copy the master secret so the student can move to another machine.
 *
 * The one place this value is ever surfaced. It is shown in a document as well as
 * copied because a clipboard is easy to lose and this is unrecoverable.
 */
export async function exportIdentitySecret(deps: EnrollmentCommandDeps): Promise<void> {
  // load-or-create, so "export" on a fresh install produces something to back up
  // rather than an error the student has to decode.
  const created = await loadOrCreateMasterSecret(deps.secrets);
  if (!created.ok) {
    deps.showError(`Provenance: could not read your identity secret (${created.error.kind}).`);
    return;
  }
  const exported = await exportMasterSecret(deps.secrets);
  if (!exported.ok) {
    deps.showError(`Provenance: could not read your identity secret (${exported.error.kind}).`);
    return;
  }

  // Marked, not bare. A master secret and a public key are both 64 lowercase
  // hex characters, so an unmarked export is indistinguishable from the key the
  // enrollment page asks for — and pasting it there hands over the student's
  // whole identity, silently. The marker lets that page refuse it BY NAME.
  // `importMasterSecret` strips the marker, and still accepts an unmarked
  // secret exported by an older build.
  const marked = `${MASTER_SECRET_EXPORT_PREFIX}${exported.value}`;
  await deps.copyToClipboard(marked);
  await deps.showDocument(
    `Provenance student identity secret\n\n${marked}\n\n` +
      'KEEP THIS PRIVATE. Anyone holding it can sign work as you, in every course.\n' +
      'Store it in a password manager. There is no backup on any server, so if you lose it\n' +
      'you will need a new credential.\n\n' +
      'NEVER paste this into a website, including the enrollment page. That page asks for\n' +
      'your enrollment KEY, which is a different value — use "Provenance: Show My\n' +
      'Enrollment Key" for it.\n\n' +
      'On a new machine: run "Provenance: Import Student Identity Secret" and paste this in.\n',
  );
  deps.showInfo('Provenance: identity secret copied to the clipboard. Store it somewhere private.');
}

/** Adopt a master secret pasted from another machine. */
export async function importIdentitySecret(deps: EnrollmentCommandDeps): Promise<void> {
  const pasted = await deps.promptInput({
    prompt: 'Paste your Provenance student identity secret (64 hex characters)',
    placeHolder: '0123456789abcdef...',
  });
  if (pasted === undefined || pasted.trim().length === 0) return;

  const imported = await importMasterSecret(deps.secrets, pasted);
  if (!imported.ok) {
    deps.showError(
      `Provenance: that does not look like an identity secret (${imported.error.kind}). ` +
        'Your existing secret has been left untouched.',
    );
    return;
  }
  deps.showInfo(
    'Provenance: identity secret imported. Your keys are re-derived from it, so an existing ' +
      'credential keeps working.',
  );
}
