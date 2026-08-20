/**
 * Pure helpers for the student `/enroll` page — identity `format_version` 2.1.
 *
 * ## Why this module exists separately from the view
 *
 * The whole page is one copy-paste hop: hex out of the recorder into a browser,
 * JSON out of the browser back into the recorder. Both directions are text a
 * student retypes or half-selects under deadline pressure, so both get pure,
 * exhaustively tested functions rather than inline `useState` logic.
 *
 * ## THE PASTE ARTIFACT
 *
 * Exactly one shape, for both identity families:
 *
 *     {"enrollment":{…credential…},"enrollment_cert":{…cert…}}
 *
 * compact, single-line, and carrying nothing else. Three properties are
 * load-bearing, and each is driven by what consumes the string:
 *
 *  - **The two wire slots are `enrollment` and `enrollment_cert`, at 2.1 as at
 *    2.0.** These are not the names the HTTP response uses (`credential` /
 *    `institution_cert`); {@link buildRecorderPasteText} renames them exactly
 *    once, here. They are the names `SessionIdentity` uses, so the artifact IS
 *    two-thirds of the identity block the recorder writes into `session.start`.
 *    The recorder stores it verbatim and adds only `session_pubkey_sig` — there
 *    is no transformation step between the paste and the signed log entry, and
 *    therefore none to get wrong.
 *  - **The version lives INSIDE the signed payloads, never in the key names.**
 *    Both families occupy the same two slots, so "which keys are present" says
 *    nothing about which version this is. Both ends read
 *    `enrollment_cert.format_version`, which is signed in both families, which
 *    is precisely what `verifyIdentityChain` step 0 reads. Routing on presence
 *    is the bug that once made log-core's whole legacy path unreachable.
 *  - **One line, no indentation.** The recorder prompts with a VS Code input
 *    box — a SINGLE-LINE control. Pretty-printed JSON pasted into it is a
 *    coin-flip between mangled and truncated, and the failure lands in the
 *    recorder where this page cannot explain it. So the artifact is compact by
 *    construction, not by the student's care.
 *
 * ## The paste check is deliberately a MIRROR, not an approximation
 *
 * {@link checkRecorderPasteText} reproduces `saveStudentCredentialArtifact` in
 * `packages/recorder/src/identity/secret-store.ts` step for step, in the same
 * order, and calls the SAME `parseInstitutionCert` / `parseStudentCredential` /
 * `INSTITUTION_IDENTITY_FORMAT_VERSION` from `@provenance/log-core` that the
 * recorder calls. The analyzer must not import recorder source (CLAUDE.md
 * architecture rules), and log-core is the shared seam that makes duplicating
 * the recorder's decision unnecessary: the only thing restated here is the
 * ORDER of the checks.
 *
 * That equivalence is what lets this page make a promise it can keep — "the
 * recorder will accept this text" — instead of hoping. It is pinned twice:
 *
 *  1. `enrollment-token.test.ts` feeds a corpus of mangled pastes through both
 *     this function and log-core's parsers;
 *  2. `tools/enrollment-paste-conformance.test.ts` feeds the SAME corpus
 *     through this function and through the recorder's REAL compiled importer
 *     from `packages/recorder/dist/`, and then drives the accepted artifact all
 *     the way to a `session.start` identity block that the real 2.1 chain walk
 *     verifies. `tools/` is the repo's established home for cross-graph gates
 *     (see `recorder-seal-conformance.test.ts`); neither package acquires a
 *     dependency edge.
 *
 * Signatures are NOT verified here, for the same reason the recorder does not
 * verify them on import: the 2.1 trust anchor is the recorder's embedded ROOT
 * public key, which a browser does not have. The real walk happens in the
 * recorder at session start.
 */

import {
  INSTITUTION_IDENTITY_FORMAT_VERSION,
  parseInstitutionCert,
  parseStudentCredential,
} from '@provenance/log-core';
import type { StudentCredentialResponse } from '@provenance/shared/api-schemas';

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

/**
 * The marker the recorder puts in front of an exported master secret —
 * `MASTER_SECRET_EXPORT_PREFIX` in `recorder/src/identity/secret-store.ts`.
 *
 * Restated as a literal because the analyzer cannot import recorder source.
 * `tools/enrollment-paste-conformance.test.ts` asserts the two spellings are
 * identical, so they cannot drift apart silently.
 */
export const MASTER_SECRET_MARKER = 'provenance-secret-v1:';

/**
 * Phrases that only ever appear in the recorder's identity-secret document.
 *
 * Checked in addition to the marker because a student can paste the document's
 * prose without the marked line, or strip the marker by hand.
 */
const SECRET_DOCUMENT_TELLS = ['identity secret', 'keep this private'];

export type PubkeyResult =
  | { readonly ok: true; readonly pubkey: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Normalize and validate a pasted student public key.
 *
 * Forgiving about transport, strict about the value:
 *  - all whitespace is stripped (a wrapped line, a trailing newline)
 *  - hex is lowercased (`StudentPubkeySchema` accepts lowercase only, and the
 *    server would 400 on an uppercased key that is otherwise perfectly correct)
 *  - if the result is not a bare key, a single embedded key is extracted, so
 *    copying the entire "Provenance enrollment key" document works
 *
 * Failure reasons are phrased for a student, and name the observed length —
 * "63 characters" is actionable in a way that "invalid key" is not.
 *
 * ## Refusing a master secret
 *
 * A student master secret is ALSO 64 lowercase hex characters, so the VALUE
 * cannot be told from a public key by inspection — there is no arithmetic that
 * separates them. What can be told apart is the TEXT it arrived in, and that is
 * what this checks: the recorder marks an exported secret with
 * {@link MASTER_SECRET_MARKER} and surrounds it with unmistakable prose, and
 * both are refused here before any extraction happens.
 *
 * The ordering is deliberate. This check runs FIRST, ahead of the
 * whole-document extraction fallback — which would otherwise happily pull the
 * single 64-hex run out of the secret document and report it as a valid key.
 * That was a real hole in the 2.0 version of this function.
 *
 * A student who strips the marker and pastes 64 bare characters still defeats
 * this, and nothing here can stop them; the warning beside the input is the
 * remaining defence, which is why it is worded as strongly as it is.
 */
export function normalizeStudentPubkey(raw: string): PubkeyResult {
  const lowered = raw.toLowerCase();

  // BEFORE anything else, including extraction. See the docstring.
  if (
    lowered.includes(MASTER_SECRET_MARKER) ||
    SECRET_DOCUMENT_TELLS.some((tell) => lowered.includes(tell))
  ) {
    return {
      ok: false,
      reason:
        'That is your identity SECRET, not your enrollment key. Never paste it into a ' +
        'website — anyone holding it can sign work as you, in every course. Run ' +
        '"Provenance: Show My Enrollment Key" instead, and paste that.',
    };
  }

  const collapsed = lowered.replace(/\s+/g, '');

  if (collapsed.length === 0) {
    return { ok: false, reason: 'Paste your enrollment key first.' };
  }

  if (PUBKEY_RE.test(collapsed)) {
    return { ok: true, pubkey: collapsed };
  }

  // Fallback: the student pasted the whole document the recorder opened. Accept
  // it only when there is exactly one candidate — two would mean guessing which
  // key to enrol, and enrolling the wrong one silently misattributes their work.
  const found = [...new Set(lowered.match(PUBKEY_IN_TEXT_RE) ?? [])];
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
// Step 2 — the credential, pasted back OUT to the recorder
// ---------------------------------------------------------------------------

/**
 * Build the exact text the student copies into
 * "Provenance: Import Enrollment Token".
 *
 * This is the ONE place the HTTP response's `credential` / `institution_cert`
 * names become the wire slots `enrollment` / `enrollment_cert`. The display-only
 * echoes (`institution_id`, `student_ref`, `reissued`) are dropped: shipping
 * them would be inert — the recorder ignores unknown keys — but it pads a blob
 * the student may have to select by hand, for no benefit.
 *
 * See the module docstring for why the slot names are what they are.
 */
export function buildRecorderPasteText(response: StudentCredentialResponse): string {
  return JSON.stringify({
    enrollment: response.credential,
    enrollment_cert: response.institution_cert,
  });
}

/** Why the recorder would refuse a pasted credential. Mirrors `CredentialImportError`. */
export type PasteRejection =
  | 'empty'
  | 'truncated'
  | 'invalid_json'
  | 'not_an_object'
  | 'unsupported_format_version'
  | 'invalid_cert_shape'
  | 'invalid_credential_shape'
  | 'institution_id_mismatch';

export type PasteCheck =
  | {
      readonly ok: true;
      readonly institutionId: string;
      readonly studentRef: string;
      readonly studentPubkey: string;
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly kind: PasteRejection; readonly message: string };

/**
 * Decide whether the recorder would accept this text, without a recorder.
 *
 * Step-for-step equivalent to `saveStudentCredentialArtifact`, including the
 * order: the version gate runs BEFORE any shape work (so a future 3.0 artifact
 * is reported as a version problem, never read under 2.1 rules),
 * `enrollment_cert` is gated before `enrollment`, and the cross-field
 * `institution_id` comparison runs last.
 *
 * Only the messages are new. The recorder's are written for someone who already
 * has a credential in hand; these are written for someone still standing in
 * front of the page that produced it, and so point at the fix.
 */
export function checkRecorderPasteText(text: string): PasteCheck {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { ok: false, kind: 'empty', message: 'Paste the credential to check it.' };
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
          'That credential is cut off — it should end with "}". Use the Copy button and paste ' +
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
      message: 'That is not a credential. Copy the whole JSON object, starting with "{".',
    };
  }
  const obj = parsed as Record<string, unknown>;

  for (const field of ['enrollment_cert', 'enrollment'] as const) {
    const declared = (obj[field] as Record<string, unknown> | undefined)?.['format_version'];
    if (declared !== INSTITUTION_IDENTITY_FORMAT_VERSION) {
      return {
        ok: false,
        kind: 'unsupported_format_version',
        message:
          `The ${field} in that paste is not version ${INSTITUTION_IDENTITY_FORMAT_VERSION}. ` +
          'Copy the credential from this page again — and if it still says this, your recorder ' +
          'is a different version than your institution expects.',
      };
    }
  }

  const cert = parseInstitutionCert(obj['enrollment_cert']);
  if (!cert.ok) {
    return {
      ok: false,
      kind: 'invalid_cert_shape',
      message:
        'The enrollment_cert half of that paste is incomplete. Copy the whole credential, ' +
        'including everything after "enrollment_cert".',
    };
  }

  const credential = parseStudentCredential(obj['enrollment']);
  if (!credential.ok) {
    return {
      ok: false,
      kind: 'invalid_credential_shape',
      message:
        'The enrollment half of that paste is incomplete. Copy the whole credential, without ' +
        'editing it.',
    };
  }

  if (credential.value.institution_id !== cert.value.institution_id) {
    return {
      ok: false,
      kind: 'institution_id_mismatch',
      message:
        `That paste mixes two institutions — the credential says ` +
        `"${credential.value.institution_id}" and the certificate says ` +
        `"${cert.value.institution_id}". Copy one credential at a time.`,
    };
  }

  return {
    ok: true,
    institutionId: credential.value.institution_id,
    studentRef: credential.value.student_ref,
    studentPubkey: credential.value.student_pubkey,
    expiresAt: credential.value.expires_at,
  };
}
