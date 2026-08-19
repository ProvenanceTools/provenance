/**
 * Student-facing enrollment commands (program spec §5a, "Enrollment flow").
 *
 * ## Enrollment is a paste, not a fetch
 *
 * Recorder PRD NG2: the recorder makes **no network calls during a session**, and
 * identity gets no exception. So the flow is deliberately manual:
 *
 *   1. "Provenance: Show My Enrollment Key" copies the student's per-course
 *      PUBLIC key. They give it to the course's enrollment endpoint (a browser,
 *      a form — anything that is not this extension).
 *   2. The server authenticates them, maps them to an opaque `roster_entries.id`,
 *      and mints `{ enrollment, enrollment_cert }`.
 *   3. "Provenance: Import Enrollment Token" takes that JSON as a paste and
 *      persists it per course.
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

import { deriveCourseKeypair } from '@provenance/log-core';
import {
  exportMasterSecret,
  importMasterSecret,
  loadOrCreateMasterSecret,
  saveEnrollment,
  loadEnrollment,
} from '../identity/secret-store.js';
import type { SecretStore } from '../identity/secret-store.js';

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
  /** `course_id` of every currently recording assignment root. */
  activeCourseIds: () => string[];
  /** Disambiguate when more than one course is active. `undefined` = dismissed. */
  pickCourse: (items: string[]) => Promise<string | undefined>;
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

/**
 * Resolve which course a command applies to: the only active one, or the
 * student's pick. `undefined` means "stop, without an error" — either nothing is
 * recording (already reported) or the student dismissed the picker.
 */
async function resolveCourse(deps: EnrollmentCommandDeps): Promise<string | undefined> {
  const courses = Array.from(new Set(deps.activeCourseIds())).sort();
  if (courses.length === 0) {
    deps.showError(
      'Provenance: no course is currently recording. Open an assignment with a Manifest 2.0 ' +
        '`.provenance-manifest` first — the enrollment key is derived per course.',
    );
    return undefined;
  }
  if (courses.length === 1) return courses[0];
  return deps.pickCourse(courses);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Show + copy the student's per-course PUBLIC key, so they can obtain a token.
 *
 * Creates the master secret if this is the student's first course — the public
 * key cannot exist without it. Only the public half ever leaves this function.
 */
export async function showEnrollmentKey(deps: EnrollmentCommandDeps): Promise<void> {
  const courseId = await resolveCourse(deps);
  if (courseId === undefined) return;

  const master = await loadOrCreateMasterSecret(deps.secrets);
  if (!master.ok) {
    deps.showError(
      `Provenance: could not read your student identity secret (${master.error.kind}). ` +
        'If you have a backup, run "Provenance: Import Student Identity Secret".',
    );
    return;
  }

  const keypair = await deriveCourseKeypair(master.value, courseId);
  await deps.copyToClipboard(keypair.publicKeyHex);
  await deps.showDocument(
    `Provenance enrollment key for ${courseId}\n\n${keypair.publicKeyHex}\n\n` +
      'This is a PUBLIC key. Give it to your course to get an enrollment token, then run\n' +
      '"Provenance: Import Enrollment Token" and paste the token back in.\n',
  );
  deps.showInfo(`Provenance: enrollment key for ${courseId} copied to the clipboard.`);
}

/**
 * Import a pasted `{ enrollment, enrollment_cert }` token and persist it.
 *
 * Shape and version are checked here; SIGNATURES are not, because the trust
 * anchor for those is the manifest's root-verified `course_cert` and the real
 * walk happens at session start (`identity/session-identity.ts`). What this does
 * check, as a courtesy while the student is still here to act on it, is that the
 * token's `student_pubkey` is one this machine can actually derive.
 */
export async function importEnrollmentToken(deps: EnrollmentCommandDeps): Promise<void> {
  const pasted = await deps.promptInput({
    prompt: 'Paste the enrollment token JSON issued by your course',
    placeHolder: '{"enrollment":{...},"enrollment_cert":{...}}',
  });
  if (pasted === undefined || pasted.trim().length === 0) return;

  const saved = await saveEnrollment(deps.secrets, pasted);
  if (!saved.ok) {
    deps.showError(
      `Provenance: that enrollment token was not accepted (${saved.error.kind}). ` +
        'Copy the whole JSON object your course gave you, including the enrollment_cert.',
    );
    return;
  }

  deps.showInfo(`Provenance: enrolled in ${saved.value.course_id}.`);

  // Courtesy check — non-blocking, and deliberately AFTER the token is stored.
  // The token itself is fine; it is this machine's key that does not match, and
  // the fix (import the identity secret) is one the student can do right now.
  const master = await loadOrCreateMasterSecret(deps.secrets);
  const stored = await loadEnrollment(deps.secrets, saved.value.course_id);
  if (master.ok && stored !== undefined) {
    const derived = await deriveCourseKeypair(master.value, saved.value.course_id);
    if (derived.publicKeyHex !== stored.enrollment.student_pubkey) {
      deps.showError(
        'Provenance: this token was issued to a different student identity secret than the one ' +
          'on this machine. Run "Provenance: Import Student Identity Secret" with the secret ' +
          'from your other machine, or ask your course to re-issue a token for the key shown by ' +
          '"Provenance: Show My Enrollment Key". Recording continues either way, without an ' +
          'identity claim.',
      );
    }
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

  await deps.copyToClipboard(exported.value);
  await deps.showDocument(
    `Provenance student identity secret\n\n${exported.value}\n\n` +
      'KEEP THIS PRIVATE. Anyone holding it can sign work as you, in every course.\n' +
      'Store it in a password manager. There is no backup on any server, so if you lose it\n' +
      'you will need a new enrollment token for each course.\n\n' +
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
    'Provenance: identity secret imported. Your per-course keys are re-derived from it, so ' +
      'existing enrollment tokens keep working.',
  );
}
