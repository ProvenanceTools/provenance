/**
 * Pure logic for the staff manifest composer (`/compose/manifest`).
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §3 (Manifest 2.0) and §4 (capture policy).
 *
 * ## What this module is
 *
 * The browser half of `tools/sign-manifest.ts`. That CLI's docstring is the
 * spec, and this module reproduces its behaviour exactly — same required
 * fields, same 1.0 legacy path, same "strip any existing sig and rebuild", same
 * self-verify-before-writing rule, and the same output bytes:
 * `canonicalize(signed) + '\n'`.
 *
 * **Byte identity with the CLI is a tested property, not an intention.**
 * `tools/manifest-composer-conformance.test.ts` runs the real CLI as a
 * subprocess over a temp file and compares its output byte-for-byte against
 * what {@link composeSignedManifest} returns for the same inputs, at 2.0 and at
 * 1.0. Canonicalization goes through log-core's `canonicalize` — the same seam
 * the CLI uses — and is never hand-rolled here; JCS key ordering and number
 * representation are exactly the things a second implementation gets subtly
 * wrong, and a manifest whose bytes drift is a manifest that does not verify.
 *
 * ## THE PRIVATE KEY
 *
 * The course signing key is offline-generated and never leaves staff's machine.
 * That is the whole reason a separate, server-held *enrollment* key exists; the
 * server does not hold this one and must not learn it.
 *
 * Signing therefore happens in the browser, and the key material is treated as
 * radioactive. The rules this module keeps, all of them checkable:
 *
 *  - **The private key never becomes a value any caller holds.** There is no
 *    function here that returns it. {@link withCourseSigningKey} is the only
 *    door: it parses, hands the bytes to a callback, and zeroes them in a
 *    `finally`. Callers get a {@link ComposeOk} carrying the *public* half.
 *  - **The private key is never in React state.** The view holds a `File`
 *    handle — a pointer to disk — and re-reads it at sign time, so the bytes
 *    exist only inside one async call and are gone before the promise settles
 *    into state. See `ManifestComposerView.tsx`.
 *  - **No error message, and no thrown value, carries file content.** A
 *    `JSON.parse` failure message from V8 quotes the offending input
 *    ("Unexpected non-whitespace character after JSON at position 5"), which for
 *    a key file is a fragment of a private key going into an error string that
 *    could be rendered, logged, or reported. Every parse failure here is
 *    replaced by a fixed sentence. Never `String(e)` a parse of a key file.
 *  - **Nothing is transmitted, stored, or logged.** This module imports
 *    `@provenance/log-core` and nothing else — no API client, no storage, no
 *    `console`. `manifest-composer.leak.test.tsx` asserts that structurally over
 *    the source of both files, and drives the whole view to prove the key hex
 *    never appears in a request, in storage, in a console call, in the DOM, or
 *    in the produced blob.
 *
 * ## The 64-hex confusion hazard
 *
 * A course private key, a course public key, and a student master secret are
 * all 64 lowercase hex characters. This program has already been bitten once by
 * that — a secret pasted where a public key was expected — which is why the
 * recorder now marks exported secrets with `provenance-secret-v1:` and
 * `enrollment-token.ts` refuses anything carrying it.
 *
 * The same discipline applies here, in both directions, because the failure is
 * worse: the `course_cert` is *published to every student in the class*.
 *
 *  - {@link parseCourseCertFile} refuses a file carrying `private_key_hex`
 *    outright, before shape validation. Picking the keypair file in the
 *    certificate slot is a plausible mis-click, and `parseCourseCert` would
 *    merely say "course_id must be a non-empty string" — a message that tells
 *    staff to fix the wrong thing while their signing key sits in the form.
 *  - {@link withCourseSigningKey} refuses a file carrying `root_sig` — the
 *    mirror mis-click — rather than reporting a missing `private_key_hex`.
 *  - Neither slot accepts a bare 64-hex string. Both require the *structured
 *    file* the tooling writes, so a lone hex value has nowhere to be pasted and
 *    the two roles cannot be interchanged by copy-paste at all.
 *
 * ## The capture-policy floor
 *
 * A policy may only narrow what the analyzer expects. Nothing critical to
 * reconstruction may be policy-disableable — the floor is defined by what
 * reconstruction and validation depend on, not by privacy sensitivity, and
 * `doc.open` is on it because `DocOpenPayload.content` is the reconstruction
 * seed (see `log-core/src/policy.ts`).
 *
 * The composer makes a floor-disabling manifest **unrepresentable** rather than
 * merely discouraged: {@link POLICY_CAPTURE_TOGGLES} is the complete set of
 * knobs, it is derived from log-core's own `POLICY_GATED_EVENT_KINDS`, and
 * {@link buildPolicyBlock} is the only way a `policy` block is produced — there
 * is no free-text policy input anywhere in the view. `manifest-composer.test.ts`
 * asserts the toggle set equals log-core's gated set exactly, so a floor kind
 * acquiring a knob here fails a test rather than shipping.
 */

import {
  canonicalize,
  isExactEntry,
  parseCourseCert,
  signManifest,
  validateScopeEntry,
  verifyManifest,
  verifyManifestChain,
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_ENROLLMENT_POLICY,
  HEARTBEAT_INTERVAL_MAX_MS,
  HEARTBEAT_INTERVAL_MIN_MS,
  MANIFEST_FORMAT_VERSION_2,
  MANIFEST_FORMAT_VERSION_LEGACY,
} from '@provenance/log-core';
import type {
  CapturePolicyBlock,
  CourseCert,
  Manifest,
  ManifestChainOk,
  ManifestCollaboration,
  ManifestScope,
  ManifestSubmission,
} from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type ComposeResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

function fail<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Form model
// ---------------------------------------------------------------------------

export type ComposerFormat =
  | typeof MANIFEST_FORMAT_VERSION_LEGACY
  | typeof MANIFEST_FORMAT_VERSION_2;

/**
 * The capture knobs, and what turning one off actually costs in analysis terms.
 *
 * `key` is the `policy.capture` key; `eventKinds` names the event kinds the
 * knob governs, so the UI can say which signal disappears rather than making
 * staff infer it from a field name.
 *
 * This list is asserted equal to log-core's `POLICY_GATED_EVENT_KINDS` — see
 * the module docstring. Adding an entry for a floor kind is a test failure.
 */
export const POLICY_CAPTURE_TOGGLES = [
  {
    key: 'selection_change',
    label: 'Selection changes',
    eventKinds: ['selection.change'],
    captures: 'Where the cursor is and what is selected, as the student works.',
    cost:
      'Reading-vs-typing evidence goes away. Heuristics that look at whether a student ever ' +
      'navigated to code before it appeared will report not-applicable instead of exculpating ' +
      'them — the manifest records that you disabled this, so the analyzer reads the silence as ' +
      'your policy rather than as the student never having looked.',
  },
  {
    key: 'focus_change',
    label: 'Window focus changes',
    eventKinds: ['focus.change'],
    captures: 'When the editor window gains or loses focus. Never what the student switched to.',
    cost:
      'Away-from-editor intervals become invisible. A gap before a large paste can no longer be ' +
      'told apart from a student sitting and thinking — in either direction.',
  },
  {
    key: 'terminal',
    label: 'Terminal activity',
    eventKinds: ['terminal.open', 'terminal.command'],
    captures: 'Terminal opens and the command lines run in them.',
    cost:
      'Test-run and build evidence goes away. Iterative debugging is one of the strongest ' +
      'exculpatory signals there is, and this is where most of it lives.',
  },
] as const satisfies readonly {
  key: keyof NonNullable<CapturePolicyBlock['capture']>;
  label: string;
  eventKinds: readonly string[];
  captures: string;
  cost: string;
}[];

export type PolicyToggleKey = (typeof POLICY_CAPTURE_TOGGLES)[number]['key'];

export type PolicyForm = {
  readonly selection_change: boolean;
  readonly focus_change: boolean;
  readonly terminal: boolean;
  readonly heartbeat_interval_ms: number;
  /**
   * Whether the recorder asks this course's students to enrol.
   *
   * Not a capture toggle — it is deliberately absent from
   * {@link POLICY_CAPTURE_TOGGLES}, because it costs the course no evidence. It
   * changes nothing about what is recorded; the bundle is byte-identical either
   * way. What it costs is ATTRIBUTION: nothing in the bundle says who produced
   * it. That matters for group work and for a contested submission, and for
   * nothing else — which is why a course running solo assignments can switch
   * the prompting off and lose nothing it was using.
   */
  readonly enrollment_required: boolean;
};

export const DEFAULT_POLICY_FORM: PolicyForm = {
  selection_change: DEFAULT_CAPTURE_POLICY.selection_change,
  focus_change: DEFAULT_CAPTURE_POLICY.focus_change,
  terminal: DEFAULT_CAPTURE_POLICY.terminal,
  heartbeat_interval_ms: DEFAULT_CAPTURE_POLICY.heartbeat_interval_ms,
  // Required by default, deliberately. A course opts OUT of attribution as a
  // decision it makes; it must never be opted out by a form default.
  enrollment_required: DEFAULT_ENROLLMENT_POLICY.required,
};

export type ComposerForm = {
  readonly format: ComposerFormat;
  readonly assignment_id: string;
  readonly semester: string;
  readonly issued_at: string;
  /** One path per line in the UI; already split and trimmed by {@link splitPathList}. */
  readonly files_under_review: readonly string[];
  /** One entry per line in the UI; split by {@link splitPathList}. 2.0 only. */
  readonly ignore: readonly string[];
  /** One entry per line in the UI; split by {@link splitPathList}. 2.0 only. */
  readonly attachments: readonly string[];
  // --- 2.0 only ---
  readonly course_id: string;
  readonly collaboration: ManifestCollaboration;
  readonly submission: ManifestSubmission;
  readonly scope: ManifestScope;
  readonly policy: PolicyForm;
};

/**
 * `issued_at` for a manifest being signed at `now`: UTC, whole seconds.
 *
 * The clock is a parameter rather than a `new Date()` inside, so the form's
 * default value is a pure function of a timestamp and can be asserted on.
 * Milliseconds are dropped — `ISO_LIKE_RE` accepts them, but the field is a
 * date staff read and edit, and a signed `.123Z` says nothing true.
 */
export function issuedAtFrom(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

export const EMPTY_COMPOSER_FORM: ComposerForm = {
  format: MANIFEST_FORMAT_VERSION_2,
  assignment_id: '',
  semester: '',
  issued_at: '',
  files_under_review: [],
  ignore: [],
  attachments: [],
  course_id: '',
  collaboration: 'solo',
  submission: 'bundle',
  scope: 'directory',
  policy: DEFAULT_POLICY_FORM,
};

/**
 * Split a path list textarea into entries.
 *
 * Blank lines are dropped and each line is trimmed, because a trailing space on
 * a path is invisible in a textarea and produces an entry that matches no file
 * — signed, distributed, and diagnosed weeks later. Duplicates are dropped too:
 * they are signed noise, and the recorder resolves a path once regardless.
 */
export function splitPathList(text: string): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** @deprecated Use {@link splitPathList}. Kept so existing imports keep working. */
export const splitFilesUnderReview = splitPathList;

// ---------------------------------------------------------------------------
// Field validation — what the form catches before anything is signed
// ---------------------------------------------------------------------------

export type FieldIssue = {
  /** A `ComposerForm` key, or `'course_cert'` for a cross-file problem. */
  readonly field: string;
  readonly message: string;
};

const ISO_LIKE_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Everything wrong with the form, in field order.
 *
 * `cert` is the parsed certificate when one has been chosen, `null` otherwise.
 * The `course_id` comparison lives HERE, in field validation, and not only in
 * the chain walk. Chain step 3 does catch it — signing succeeds and
 * verification fails — but by then the message staff see is a refused download
 * for a manifest that looked fine, and the actual fault (two ids that disagree
 * by one character) is three layers down in a `ManifestChainError`. Naming it
 * beside the field is the difference between a typo and a mystery.
 */
export function validateComposerForm(
  form: ComposerForm,
  cert: CourseCert | null,
): readonly FieldIssue[] {
  const issues: FieldIssue[] = [];
  const requireText = (field: string, value: string, what: string): void => {
    if (value.trim().length === 0) issues.push({ field, message: `${what} is required.` });
  };

  requireText('assignment_id', form.assignment_id, 'Assignment id');
  requireText('semester', form.semester, 'Semester');

  if (form.issued_at.trim().length === 0) {
    issues.push({ field: 'issued_at', message: 'Issued-at is required.' });
  } else if (!ISO_LIKE_RE.test(form.issued_at.trim())) {
    issues.push({
      field: 'issued_at',
      message:
        'Issued-at must be an ISO 8601 date or timestamp, e.g. 2026-09-08T00:00:00Z. It is what ' +
        'the certificate validity window is checked against.',
    });
  }

  if (form.files_under_review.length === 0) {
    issues.push({
      field: 'files_under_review',
      message: 'List at least one file under review — one path per line, relative to this file.',
    });
  }

  const checkList = (field: string, entries: readonly string[]): void => {
    for (const entry of entries) {
      const problem = validateScopeEntry(entry);
      if (problem !== null) {
        issues.push({ field, message: `"${entry}" — ${problem.detail}` });
        return; // one message per field; the first bad entry is the one to fix
      }
    }
  };
  checkList('files_under_review', form.files_under_review);

  if (form.format !== MANIFEST_FORMAT_VERSION_2) {
    // `src/` and `*.java` are legal entries at 2.0 (a folder rule, a suffix
    // rule) but at 1.x there is no such grammar — an entry is only ever an
    // exact path. Letting one through here would sign a manifest that matches
    // nothing: `src/` becomes a search for a file literally named `src/`.
    for (const entry of form.files_under_review) {
      if (isExactEntry(entry)) continue;
      issues.push({
        field: 'files_under_review',
        message:
          `"${entry}" is a folder or suffix rule, which only exists at format 2.0. In a 1.x ` +
          'manifest it means a file with that literal name, so it would match nothing. Switch the ' +
          'format to 2.0, or list exact paths.',
      });
      break;
    }
    return issues;
  }

  requireText('course_id', form.course_id, 'Course id');

  if (cert === null) {
    issues.push({
      field: 'course_cert',
      message: 'Choose the course certificate. A 2.0 manifest carries it inline.',
    });
  } else if (form.course_id.trim().length > 0 && form.course_id.trim() !== cert.course_id) {
    issues.push({
      field: 'course_id',
      message:
        `This does not match the certificate, which says "${cert.course_id}". A manifest may not ` +
        'claim a course its certificate does not cover — the recorder checks exactly this ' +
        '(trust chain step 3) and would refuse to activate. Fix the id, or choose the ' +
        'certificate for this course.',
    });
  }

  const hb = form.policy.heartbeat_interval_ms;
  if (!Number.isInteger(hb)) {
    issues.push({
      field: 'heartbeat_interval_ms',
      message: 'Heartbeat interval must be a whole number of milliseconds.',
    });
  } else if (hb < HEARTBEAT_INTERVAL_MIN_MS || hb > HEARTBEAT_INTERVAL_MAX_MS) {
    issues.push({
      field: 'heartbeat_interval_ms',
      message:
        `Heartbeat interval must be between ${String(HEARTBEAT_INTERVAL_MIN_MS)} and ` +
        `${String(HEARTBEAT_INTERVAL_MAX_MS)} ms. A recorder clamps anything outside that range, ` +
        'so a value it will not honour would be signed into the manifest and then silently ' +
        'ignored.',
    });
  }

  checkList('ignore', form.ignore);
  checkList('attachments', form.attachments);

  return issues;
}

// ---------------------------------------------------------------------------
// Unsigned manifest construction
// ---------------------------------------------------------------------------

/**
 * Build the policy block.
 *
 * All five keys are always emitted, even when they carry the default. The
 * program spec's reason for a fixed key set at the manifest level applies here
 * too: three hand-written canonicalizers (JS, Kotlin, Lua) must agree, and
 * "which optional keys were present" is a divergence risk. It is also honest —
 * a course that reviewed the policy and left everything on has said so
 * explicitly, and the recorded block is then a statement rather than a silence.
 *
 * There is no path here that emits a key outside this set. That is what makes a
 * floor-disabling manifest unrepresentable rather than merely discouraged.
 *
 * `enrollment` sits beside `capture` rather than inside it: it governs nothing
 * about what is captured, only whether the recorder tells an un-enrolled student
 * so. It rides in the `policy` block because that is the one signed manifest
 * field the three recorders canonicalize verbatim, so a recorder that predates
 * the key still verifies the manifest and simply ignores it.
 */
export function buildPolicyBlock(policy: PolicyForm): CapturePolicyBlock {
  return {
    capture: {
      selection_change: policy.selection_change,
      focus_change: policy.focus_change,
      terminal: policy.terminal,
      heartbeat_interval_ms: policy.heartbeat_interval_ms,
    },
    enrollment: {
      required: policy.enrollment_required,
    },
  };
}

/**
 * The unsigned manifest, with exactly the key set `tools/sign-manifest.ts`
 * produces for the same format. Trimmed, because a trailing space in
 * `assignment_id` is signed and then never matches anything.
 */
export function buildUnsignedManifest(form: ComposerForm): Omit<Manifest, 'sig'> {
  const base = {
    assignment_id: form.assignment_id.trim(),
    semester: form.semester.trim(),
    issued_at: form.issued_at.trim(),
    files_under_review: form.files_under_review,
  };

  if (form.format === MANIFEST_FORMAT_VERSION_LEGACY) return base;

  return {
    ...base,
    format_version: MANIFEST_FORMAT_VERSION_2,
    course_id: form.course_id.trim(),
    collaboration: form.collaboration,
    submission: form.submission,
    scope: form.scope,
    policy: buildPolicyBlock(form.policy),
    ignore: form.ignore,
    attachments: form.attachments,
  };
}

// ---------------------------------------------------------------------------
// The certificate file
// ---------------------------------------------------------------------------

export type CertFileError = {
  readonly kind: 'looks_like_a_private_key' | 'invalid_json' | 'invalid_shape';
  readonly message: string;
};

/**
 * Parse the file staff chose in the certificate slot.
 *
 * The private-key refusal runs FIRST, ahead of shape validation, for the same
 * reason `normalizeStudentPubkey` refuses a marked secret before extraction:
 * the fallback path is helpful enough to hide the real problem. `parseCourseCert`
 * on a keypair file reports a missing `course_id`, which reads as "this
 * certificate is malformed" and sends staff off to re-mint a certificate that
 * was never the problem.
 *
 * The stakes are the asymmetry: this file is stapled into the manifest and
 * distributed to the whole class. A private key reaching this slot is a key
 * disclosure, not a validation error.
 */
export function parseCourseCertFile(text: string): ComposeResult<CourseCert, CertFileError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Deliberately not `String(e)`: V8 quotes the offending input, and if this
    // slot is holding a mis-chosen keypair file that is private key material in
    // an error string.
    return fail({
      kind: 'invalid_json' as const,
      message:
        'That file is not valid JSON. Choose the certificate minted by tools/mint-course-cert.ts.',
    });
  }

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    'private_key_hex' in parsed
  ) {
    return fail({
      kind: 'looks_like_a_private_key' as const,
      message:
        'That is your course PRIVATE KEY file, not the certificate. It was not read, and nothing ' +
        'from it is on this page. The certificate is published to every student in the class — ' +
        'if this file had been stapled into a manifest, your signing key would have gone with ' +
        'it. Choose the file from tools/mint-course-cert.ts: it has a root_sig and no ' +
        'private_key_hex.',
    });
  }

  const cert = parseCourseCert(parsed);
  if (!cert.ok) {
    return fail({
      kind: 'invalid_shape' as const,
      message:
        'That file is not a course certificate. It needs course_id, course_pubkey, valid_from, ' +
        'valid_until and root_sig — the file tools/mint-course-cert.ts writes.',
    });
  }
  return ok(cert.value);
}

// ---------------------------------------------------------------------------
// The signing key — the only place private key material is touched
// ---------------------------------------------------------------------------

const HEX_64_RE = /^[0-9a-f]{64}$/;

export type KeyFileError = {
  readonly kind: 'looks_like_a_certificate' | 'invalid_json' | 'invalid_shape' | 'malformed_hex';
  readonly message: string;
};

function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The ONLY door to the course private key.
 *
 * Parses the keypair file, hands the 32 raw bytes and the declared public half
 * to `use`, and zeroes the bytes in a `finally` — on the success path, on a
 * thrown path, and on an early return. Nothing this function returns contains
 * the private key, and there is no variant that hands it back: a caller cannot
 * accidentally retain what it is never given.
 *
 * `use` runs inside the `try`, so a throw from signing still zeroes. The
 * callback's own value is passed straight through; keeping the key's lifetime
 * inside one lexical scope is the entire design.
 *
 * ## What is NOT checked here
 *
 * That `private_key_hex` actually corresponds to `public_key_hex`. Deriving the
 * public half would need `@noble/ed25519` — not an analyzer dependency, and
 * this module deliberately imports nothing but log-core. It does not need to:
 * self-verification after signing catches a mismatched pair with certainty,
 * because the signature is checked against `course_cert.course_pubkey` at 2.0
 * and against the file's declared public half at 1.0. A key file that lies
 * about its own public half produces a signature that does not verify, and
 * {@link composeSignedManifest} refuses to emit it.
 */
export async function withCourseSigningKey<T>(
  fileText: string,
  use: (privateKey: Uint8Array, publicKeyHex: string) => Promise<T>,
): Promise<ComposeResult<T, KeyFileError>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    // Never `String(e)` — see parseCourseCertFile.
    return fail({
      kind: 'invalid_json' as const,
      message:
        'That file is not valid JSON. Choose the keypair written by ' +
        'tools/generate-course-keypair.ts.',
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail({
      kind: 'invalid_shape' as const,
      message: 'That file is not a course keypair. It needs public_key_hex and private_key_hex.',
    });
  }
  const obj = parsed as Record<string, unknown>;

  // The mirror of parseCourseCertFile's refusal: staff picked the certificate
  // here. Harmless, but "missing private_key_hex" would not say which file to
  // fix, and both files sit in the same directory with similar names.
  if ('root_sig' in obj && !('private_key_hex' in obj)) {
    return fail({
      kind: 'looks_like_a_certificate' as const,
      message:
        'That is the course CERTIFICATE, not the keypair. It carries no private key, so nothing ' +
        'can be signed with it. Choose the file from tools/generate-course-keypair.ts.',
    });
  }

  if (typeof obj['public_key_hex'] !== 'string' || typeof obj['private_key_hex'] !== 'string') {
    return fail({
      kind: 'invalid_shape' as const,
      message: 'That file is not a course keypair. It needs public_key_hex and private_key_hex.',
    });
  }

  const publicKeyHex = obj['public_key_hex'];
  const privateKeyHex = obj['private_key_hex'];

  // Lengths and alphabet only — the message never echoes either value.
  if (!HEX_64_RE.test(publicKeyHex) || !HEX_64_RE.test(privateKeyHex)) {
    return fail({
      kind: 'malformed_hex' as const,
      message:
        'That keypair file has a malformed key. Both public_key_hex and private_key_hex must be ' +
        '64 lowercase hex characters. The file was not used.',
    });
  }

  const privateKey = hexToBytes32(privateKeyHex);
  try {
    return ok(await use(privateKey, publicKeyHex));
  } finally {
    privateKey.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Compose + sign + self-verify
// ---------------------------------------------------------------------------

export type ComposeInput = {
  readonly form: ComposerForm;
  /** Raw text of the course keypair file. Read at sign time, never stored. */
  readonly keypairFileText: string;
  /** Raw text of the course certificate file. Required at 2.0, ignored at 1.0. */
  readonly certFileText: string | null;
  /** The root public key, for self-verifying the chain. Required at 2.0. */
  readonly rootPubkeyHex: string | null;
};

export type ComposeError =
  | {
      readonly kind: 'invalid_form';
      readonly issues: readonly FieldIssue[];
      readonly message: string;
    }
  | { readonly kind: 'bad_cert_file'; readonly message: string }
  | { readonly kind: 'bad_key_file'; readonly message: string }
  | { readonly kind: 'missing_root_pubkey'; readonly message: string }
  | { readonly kind: 'keypair_not_certified'; readonly message: string }
  | { readonly kind: 'self_verification_failed'; readonly message: string };

export type ComposeOk = {
  /** Exactly what the CLI writes: `canonicalize(signed) + '\n'`. */
  readonly fileText: string;
  readonly filename: string;
  readonly sig: string;
  /** The PUBLIC half of the signing key. The private half is not here, by construction. */
  readonly coursePublicKeyHex: string;
  /** `null` at 1.0, where there is no chain to walk. */
  readonly chain: ManifestChainOk | null;
  /**
   * Set when the certificate was out of its validity window at `issued_at`.
   * Non-fatal by design (program spec §4) — the recorder still records — so it
   * is a warning on a successful compose, never a refusal.
   */
  readonly windowWarning: string | null;
};

/**
 * The recorder accepts `.provenance-manifest` or `provenance-manifest`
 * (`MANIFEST_FILE_NAMES` in `recorder/src/activation/manifest-loader.ts`).
 *
 * The download uses the DOTLESS spelling on purpose. A browser saving a file
 * whose name begins with a dot drops an invisible file into the Downloads
 * folder on macOS and Linux, and staff then cannot find what they just made.
 * The dotted spelling is canonical in the repo; the view says so and says to
 * rename on the way into the assignment skeleton if that is the convention the
 * course follows.
 */
export const MANIFEST_DOWNLOAD_FILENAME = 'provenance-manifest';

/**
 * Compose, sign, and SELF-VERIFY. Returns bytes only if the manifest verifies.
 *
 * The rule is the CLI's, verbatim: *a tool that emits a manifest that fails its
 * own check is worse than no tool*. At 2.0 the check is the real
 * `verifyManifestChain` against the real root key — not a shape check, and not
 * a signature check against the key we just signed with, which would be
 * self-referential and prove nothing. At 1.0 it is `verifyManifest` against the
 * keypair's declared public half, which is what the CLI does and is the only
 * anchor 1.0 has.
 *
 * A 2.0 compose with no root public key available therefore FAILS rather than
 * skipping the check. Emitting an unverified manifest because verification was
 * inconvenient is precisely the failure the rule names.
 */
export async function composeSignedManifest(
  input: ComposeInput,
): Promise<ComposeResult<ComposeOk, ComposeError>> {
  const { form } = input;
  const isV2 = form.format === MANIFEST_FORMAT_VERSION_2;

  let cert: CourseCert | null = null;
  if (isV2) {
    if (input.certFileText === null) {
      return fail({
        kind: 'bad_cert_file' as const,
        message: 'Choose the course certificate first.',
      });
    }
    const parsedCert = parseCourseCertFile(input.certFileText);
    if (!parsedCert.ok) {
      return fail({ kind: 'bad_cert_file' as const, message: parsedCert.error.message });
    }
    cert = parsedCert.value;
  }

  const issues = validateComposerForm(form, cert);
  if (issues.length > 0) {
    return fail({
      kind: 'invalid_form' as const,
      issues,
      message: 'Fix the highlighted fields first. Nothing was signed.',
    });
  }

  const rootPubkeyHex = input.rootPubkeyHex;
  if (isV2 && (rootPubkeyHex === null || rootPubkeyHex.length === 0)) {
    return fail({
      kind: 'missing_root_pubkey' as const,
      message:
        'No root public key is available, so this page cannot check the trust chain of what it ' +
        'would produce — and it will not hand you a manifest it has not verified. Paste the ' +
        'root public key below, or ask whoever deployed this analyzer to set ' +
        'VITE_ROOT_PUBLIC_KEY_HEX.',
    });
  }

  const unsigned = buildUnsignedManifest(form);

  const signed = await withCourseSigningKey(
    input.keypairFileText,
    async (privateKey, publicKeyHex) => {
      const sig = await signManifest(unsigned, privateKey);
      return { sig, publicKeyHex };
    },
  );
  if (!signed.ok) return fail({ kind: 'bad_key_file' as const, message: signed.error.message });

  const { sig, publicKeyHex } = signed.value;

  if (cert !== null && publicKeyHex !== cert.course_pubkey) {
    return fail({
      kind: 'keypair_not_certified' as const,
      message:
        'That keypair is not the one this certificate authorizes. The certificate vouches for a ' +
        'different public key, so a manifest signed with this key would fail trust chain step 2 ' +
        'and the recorder would refuse to activate. Choose the keypair the certificate was ' +
        'minted for.',
    });
  }

  const manifest: Manifest =
    cert === null ? { ...unsigned, sig } : { ...unsigned, sig, course_cert: cert };

  let chain: ManifestChainOk | null = null;
  let windowWarning: string | null = null;

  if (isV2) {
    const walked = await verifyManifestChain(manifest, rootPubkeyHex as string);
    if (!walked.ok) {
      return fail({
        kind: 'self_verification_failed' as const,
        message: describeChainFailure(walked.error.kind),
      });
    }
    chain = walked.value;
    if (!walked.value.window.in_window) {
      windowWarning = describeWindow(
        walked.value.window.reason,
        form.issued_at.trim(),
        cert as CourseCert,
      );
    }
  } else {
    const verified = await verifyManifest(manifest, publicKeyHex);
    if (!verified.ok) {
      return fail({
        kind: 'self_verification_failed' as const,
        message:
          'The manifest this page just signed does not verify against the keypair that signed ' +
          'it, so nothing was produced. The most likely cause is a keypair file whose ' +
          'private_key_hex and public_key_hex are not actually a pair.',
      });
    }
  }

  return ok({
    fileText: canonicalize(manifest) + '\n',
    filename: MANIFEST_DOWNLOAD_FILENAME,
    sig,
    coursePublicKeyHex: publicKeyHex,
    chain,
    windowWarning,
  });
}

/**
 * Turn a chain failure into something staff can act on.
 *
 * Every branch is reachable from a real mis-step, and each names the file to
 * fix. `not_manifest_2_0` and `missing_course_cert` are unreachable from this
 * page's own construction — it always sets `format_version` and always staples
 * the certificate at 2.0 — but a message beats a crash if that ever stops being
 * true.
 */
function describeChainFailure(kind: string): string {
  switch (kind) {
    case 'invalid_root_signature':
      return (
        'The certificate does not verify against the root public key, so the manifest was NOT ' +
        'produced. Either the root key configured here is not the one that signed this ' +
        'certificate, or the certificate file has been edited since it was minted.'
      );
    case 'invalid_course_signature':
      return (
        'The signature this page just produced does not verify against the public key in the ' +
        'certificate, so nothing was produced. The usual cause is a keypair file whose ' +
        'private_key_hex and public_key_hex are not actually a pair.'
      );
    case 'course_id_mismatch':
      return (
        'The course id does not match the certificate, so nothing was produced — a recorder ' +
        'would have refused this manifest at trust chain step 3.'
      );
    case 'invalid_manifest_shape':
      return (
        'The composed manifest did not pass its own shape check, so nothing was produced. That ' +
        'is a bug on this page — please report it.'
      );
    default:
      return (
        `The composed manifest failed self-verification (${kind}), so nothing was produced. A ` +
        'manifest this page cannot verify is a manifest a recorder would reject.'
      );
  }
}

function describeWindow(reason: string, issuedAt: string, cert: CourseCert): string {
  if (reason === 'unparseable_timestamp') {
    return (
      `The certificate window could not be compared against issued_at ("${issuedAt}"). The ` +
      'manifest is signed and valid, but check the timestamp format.'
    );
  }
  const which = reason === 'before_valid_from' ? 'has not started yet' : 'had already ended';
  return (
    `Heads up: issued_at (${issuedAt}) falls outside this certificate's validity window ` +
    `(${cert.valid_from} to ${cert.valid_until}) — it ${which}. This is signed and will still ` +
    'record: an expired certificate never stops a recorder, because silently halting capture ' +
    'for a whole class is worse than recording under a stale key. The analyzer will flag it. ' +
    'Re-mint the certificate if this is not what you meant.'
  );
}
