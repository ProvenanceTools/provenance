/**
 * Pure helpers for the student `/enroll` page (program spec §5a — S2).
 *
 * ## Why this module exists separately from the view
 *
 * The whole page is one copy-paste hop: hex out of the recorder into a browser,
 * JSON out of the browser back into the recorder. Both directions are text a
 * student retypes or half-selects under deadline pressure, so both get pure,
 * exhaustively tested functions rather than inline `useState` logic.
 *
 * ## The paste check is deliberately a MIRROR, not an approximation
 *
 * {@link checkRecorderPasteText} reproduces `saveEnrollment` in
 * `packages/recorder/src/identity/secret-store.ts` step for step, in the same
 * order, and calls the SAME `parseEnrollmentCert` / `parseEnrollmentToken` /
 * `ENROLLMENT_FORMAT_VERSION` from `@provenance/log-core` that the recorder
 * calls. The analyzer must not import recorder source (CLAUDE.md architecture
 * rules), and log-core is the shared seam that makes duplicating the recorder's
 * decision unnecessary: the only thing restated here is the ORDER of the checks.
 *
 * That equivalence is what lets this page make a promise it can keep — "the
 * recorder will accept this text" — instead of hoping. It is pinned by
 * `enrollment-token.test.ts`, which feeds the same corpus of mangled pastes
 * through both. Signatures are NOT verified here, for the same reason the
 * recorder does not verify them on import: the trust anchor is the manifest's
 * root-verified `course_cert`, which a browser does not have. The real walk
 * happens in the recorder at session start.
 */

import {
  ENROLLMENT_FORMAT_VERSION,
  parseEnrollmentCert,
  parseEnrollmentToken,
} from '@provenance/log-core';
import type { EnrollmentResponse } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Step 1 — the student's PUBLIC key, pasted in from the recorder
// ---------------------------------------------------------------------------

/** 64 lowercase hex characters — matches `StudentPubkeySchema` in `shared`. */
const PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * A 64-hex run with word boundaries on both sides, used to pull the key out of
 * the surrounding prose when a student copies the recorder's whole document.
 *
 * The boundaries matter: without them this would happily match the first 64
 * characters of a 128-hex signature. With them, a longer hex run matches
 * nothing, so a signature can never be mistaken for a key.
 */
const PUBKEY_IN_TEXT_RE = /\b[0-9a-f]{64}\b/g;

export type PubkeyResult =
  | { readonly ok: true; readonly pubkey: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Normalize and validate a pasted per-course public key.
 *
 * Forgiving about transport, strict about the value:
 *  - all whitespace is stripped (a wrapped line, a trailing newline)
 *  - hex is lowercased (`StudentPubkeySchema` accepts lowercase only, and the
 *    server would 400 on an uppercased key that is otherwise perfectly correct)
 *  - if the result is not a bare key, a single embedded key is extracted, so
 *    copying the entire "Provenance enrollment key for …" document works
 *
 * Failure reasons are phrased for a student, and name the observed length —
 * "63 characters" is actionable in a way that "invalid key" is not.
 *
 * NOTE: a student master secret is ALSO 64 lowercase hex characters, so this
 * function cannot tell one from the other. See the warning rendered next to the
 * input in `EnrollView`; there is no mechanical defence available here.
 */
export function normalizeStudentPubkey(raw: string): PubkeyResult {
  const collapsed = raw.replace(/\s+/g, '').toLowerCase();

  if (collapsed.length === 0) {
    return { ok: false, reason: 'Paste your enrollment key first.' };
  }

  if (PUBKEY_RE.test(collapsed)) {
    return { ok: true, pubkey: collapsed };
  }

  // Fallback: the student pasted the whole document the recorder opened. Accept
  // it only when there is exactly one candidate — two would mean guessing which
  // key to enrol, and enrolling the wrong one silently misattributes a semester.
  const found = [...new Set(raw.toLowerCase().match(PUBKEY_IN_TEXT_RE) ?? [])];
  if (found.length === 1) {
    return { ok: true, pubkey: found[0]! };
  }
  if (found.length > 1) {
    return {
      ok: false,
      reason:
        'That text contains more than one key. Paste just the key from ' +
        '"Provenance: Show My Enrollment Key".',
    };
  }

  if (/[^0-9a-f]/.test(collapsed)) {
    return {
      ok: false,
      reason:
        'An enrollment key is 64 characters, digits and a–f only. That paste has other ' +
        'characters in it — copy it again from "Provenance: Show My Enrollment Key".',
    };
  }

  return {
    ok: false,
    reason: `An enrollment key is 64 characters; that paste has ${String(collapsed.length)}. ${
      collapsed.length < 64 ? 'It looks cut off — ' : 'It looks too long — '
    }copy the whole key and nothing else.`,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — the token, pasted back OUT to the recorder
// ---------------------------------------------------------------------------

/**
 * Build the exact text the student copies into
 * "Provenance: Import Enrollment Token".
 *
 * Two properties are load-bearing, both driven by what consumes this string:
 *
 *  - **Only `enrollment` and `enrollment_cert`.** Those are the two keys
 *    `saveEnrollment` reads. `course_id`, `student_ref` and `reissued` in the
 *    HTTP response are echoes for display; shipping them would be inert (the
 *    recorder ignores unknown keys) but it pads a blob the student has to
 *    select by hand, for no benefit.
 *  - **One line, no indentation.** The recorder prompts with a VS Code input
 *    box — a SINGLE-LINE control. Pretty-printed JSON pasted into it is a
 *    coin-flip between mangled and truncated, and the failure lands in the
 *    recorder where this page cannot explain it. So the artifact is compact by
 *    construction, not by the student's care.
 */
export function buildRecorderPasteText(response: EnrollmentResponse): string {
  return JSON.stringify({
    enrollment: response.enrollment,
    enrollment_cert: response.enrollment_cert,
  });
}

/** Why the recorder would refuse a pasted token. Mirrors `EnrollmentImportError`. */
export type PasteRejection =
  | 'empty'
  | 'truncated'
  | 'invalid_json'
  | 'not_an_object'
  | 'unsupported_format_version'
  | 'invalid_cert_shape'
  | 'invalid_token_shape'
  | 'course_id_mismatch';

export type PasteCheck =
  | {
      readonly ok: true;
      readonly courseId: string;
      readonly studentRef: string;
      readonly studentPubkey: string;
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly kind: PasteRejection; readonly message: string };

/**
 * Decide whether the recorder would accept this text, without a recorder.
 *
 * Step-for-step equivalent to `saveEnrollment`, including the order: the
 * version gate runs BEFORE any shape work (so a future 3.0 artifact is reported
 * as a version problem, never read under 2.0 rules), `enrollment_cert` is gated
 * before `enrollment`, and the cross-field `course_id` comparison runs last.
 *
 * Only the messages are new. The recorder's are written for someone who already
 * has a token in hand; these are written for someone still standing in front of
 * the page that produced it, and so point at the fix.
 */
export function checkRecorderPasteText(text: string): PasteCheck {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { ok: false, kind: 'empty', message: 'Paste the token to check it.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A cut-off selection is by far the most common way this fails, and it has a
    // specific tell — the text stops before its closing brace. Say so, rather
    // than making a student parse the words "invalid JSON".
    if (!trimmed.endsWith('}')) {
      return {
        ok: false,
        kind: 'truncated',
        message:
          'That token is cut off — it should end with "}". Use the Copy button and paste ' +
          'the whole thing.',
      };
    }
    return {
      ok: false,
      kind: 'invalid_json',
      message:
        'That is not valid JSON. Something changed it in transit — use the Copy button and ' +
        'paste it without editing.',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      kind: 'not_an_object',
      message: 'That is not an enrollment token. Copy the whole JSON object, starting with "{".',
    };
  }
  const obj = parsed as Record<string, unknown>;

  for (const field of ['enrollment_cert', 'enrollment'] as const) {
    const declared = (obj[field] as Record<string, unknown> | undefined)?.['format_version'];
    if (declared !== ENROLLMENT_FORMAT_VERSION) {
      return {
        ok: false,
        kind: 'unsupported_format_version',
        message:
          `The ${field} in that paste is not version ${ENROLLMENT_FORMAT_VERSION}. ` +
          'Copy the token from this page again — and if it still says this, your recorder ' +
          'is a different version than your course expects.',
      };
    }
  }

  const cert = parseEnrollmentCert(obj['enrollment_cert']);
  if (!cert.ok) {
    return {
      ok: false,
      kind: 'invalid_cert_shape',
      message:
        'The enrollment_cert half of that paste is incomplete. Copy the whole token, ' +
        'including everything after "enrollment_cert".',
    };
  }

  const token = parseEnrollmentToken(obj['enrollment']);
  if (!token.ok) {
    return {
      ok: false,
      kind: 'invalid_token_shape',
      message:
        'The enrollment half of that paste is incomplete. Copy the whole token, without ' +
        'editing it.',
    };
  }

  if (token.value.course_id !== cert.value.course_id) {
    return {
      ok: false,
      kind: 'course_id_mismatch',
      message:
        `That paste mixes two courses — the token says "${token.value.course_id}" and the ` +
        `certificate says "${cert.value.course_id}". Copy one course's token at a time.`,
    };
  }

  return {
    ok: true,
    courseId: token.value.course_id,
    studentRef: token.value.student_ref,
    studentPubkey: token.value.student_pubkey,
    expiresAt: token.value.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Step 0 — which semester
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a semester id before it is put in a URL.
 *
 * Mirrors the server's own guard in `routes/enrollment.ts`, which 404s a
 * non-uuid before it reaches Postgres. Checking here too turns "Not found" —
 * indistinguishable from a semester that was deleted — into "that does not look
 * like an id", which tells the student their link is wrong rather than stale.
 */
export function isSemesterId(raw: string): boolean {
  return UUID_RE.test(raw.trim());
}
