/**
 * Parser and signature verifier for the `.provenance-manifest`/`provenance-manifest` assignment file.
 * PRD §4.1 — the recorder activates only when this manifest is present and valid.
 *
 * Two format versions live here.
 *
 * **1.x** (PRD §4.1) has no `format_version` field at all, so 1.x manifests are
 * identified by its *absence*. Signing payload:
 *
 *   canonicalize({assignment_id, semester, issued_at, files_under_review})
 *
 * **2.0** (program spec §3, `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`)
 * carries two independent signature scopes in one file: a course-signed payload
 * and a root-signed `course_cert` that authorizes the course key. Signing
 * payload:
 *
 *   canonicalize({format_version, course_id, assignment_id, semester, issued_at,
 *                 files_under_review, ignore, attachments, collaboration, submission,
 *                 scope, policy})
 *
 * `buildSignedPayload` excludes `sig` in both versions, and excludes
 * `course_cert` in 2.0 — the course does not sign its own certificate.
 *
 * **1.x parsing is supported permanently.** Archived submissions must still
 * validate years later; that adjudication case is precisely what justifies the
 * whole program (program spec §9). A missing `format_version` defaults to
 * `'1.0'` and parses successfully — it never rejects.
 *
 * ## Permanent constraint: no user-derived object keys
 *
 * Every key in the signed payload is a fixed ASCII identifier chosen by us, and
 * every future addition must be too — never a course id, assignment id, path, or
 * any other user-supplied string promoted to a key. provnvim's hand-rolled Lua
 * JCS sorts object keys bytewise while the JS and Kotlin implementations sort by
 * UTF-16 code unit; the two agree only for ASCII. See `course-cert.ts` for the
 * full statement of the rule.
 */

import * as ed from '@noble/ed25519';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { canonicalize } from './canonical.js';
import { ok, err } from './result.js';
import type { Result } from './result.js';
import { parseCourseCert, verifyCourseCert, checkCertWindow } from './course-cert.js';
import type { CourseCert, CertWindowStatus } from './course-cert.js';
import type { CapturePolicyBlock } from './policy.js';
import { validateScopeEntry } from './path-scope.js';
import type { ResolvedScope } from './path-scope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Whether the assignment is worked on alone or by a group (program spec §3). */
export type ManifestCollaboration = 'solo' | 'group';

/** How the work reaches the analyzer: a sealed bundle, or a git repo. */
export type ManifestSubmission = 'bundle' | 'git';

/** Whether the assignment scope is one directory or a whole repository. */
export type ManifestScope = 'directory' | 'repo';

export type Manifest = {
  /**
   * `'1.0'` (or absent, meaning 1.0) or `'2.0'`.
   *
   * Optional at the type level so every existing 1.x construction site stays
   * valid. {@link parseManifest} always populates it with the resolved value, so
   * a parsed manifest never leaves you guessing. Use
   * {@link manifestFormatVersion} when reading a hand-built one.
   */
  format_version?: string;
  assignment_id: string;
  semester: string;
  /** ISO 8601 timestamp. */
  issued_at: string;
  files_under_review: readonly string[];
  /** Hex ed25519 signature, 128 chars (64 bytes). */
  sig: string;

  // --- 2.0 only (program spec §3). Optional at the type level so 1.x
  // --- manifests remain assignable; required by parseManifest when
  // --- format_version is '2.0'.

  /** MUST equal `course_cert.course_id` — see {@link verifyManifestChain} step 3. */
  course_id?: string;
  collaboration?: ManifestCollaboration;
  submission?: ManifestSubmission;
  scope?: ManifestScope;
  /**
   * Capture policy. Inside the signed payload so a professor can turn capture
   * down and a student cannot turn it off.
   *
   * Passed to `canonicalize` verbatim, unknown keys included, so the block
   * round-trips byte-for-byte through signature verification.
   */
  policy?: CapturePolicyBlock;
  /**
   * Paths the recorder must NOT capture at all (design spec §3, §3.4).
   *
   * Inside the signed payload for the same reason `policy` is: a professor can
   * narrow capture, a student cannot. An entry here means no events are
   * produced for those paths — INCLUDING exculpatory ones, which is why the
   * composer says so in as many words.
   */
  ignore?: readonly string[];
  /**
   * Paths sealed into the bundle and hashed, but never captured (design spec §3).
   *
   * An attachment has no event provenance by definition, so check 8 must not
   * compare it against reconstruction — see `verify-submitted-code.ts`.
   */
  attachments?: readonly string[];
  /**
   * Root-signed certificate authorizing the course key. Travels inline but sits
   * OUTSIDE the course-signed payload.
   */
  course_cert?: CourseCert;
};

export type ManifestError =
  | { kind: 'invalid_json'; message: string }
  | { kind: 'invalid_shape'; field?: string; reason?: string }
  | { kind: 'invalid_signature' };

/**
 * Failure modes of {@link verifyManifestChain}, in the order the steps run.
 * Note that an out-of-window `issued_at` is NOT here — it is non-fatal and is
 * reported on the success value instead.
 */
export type ManifestChainError =
  /**
   * Step 0: the manifest is not 2.0, so there is no trust chain to walk.
   *
   * The attack this belongs to is the 1.x downgrade: at 1.x, `course_id`,
   * `collaboration`, `submission`, `scope`, and `policy` are NOT in the signed
   * payload, so a student holding a legitimately-issued 1.x manifest from their
   * own course could staple on that course's (public) certificate, a matching
   * `course_id` to satisfy step 3, and an arbitrary unsigned `policy` — every
   * individual signature still verifying.
   *
   * **This step is not what stops that, and the layering is worth stating
   * exactly.** The stapled fields never survive to be trusted, because
   * {@link parseManifestValue} returns early for a non-2.0 `format_version` and
   * the object it returns carries only the four 1.x fields plus `sig`. Any
   * reader that goes through it — `readSessionManifests` in `analysis-core`
   * before a bundle's chain is walked, and this function's own internal
   * re-validation before either signature is checked — is therefore looking at
   * a manifest with no `course_cert`, no `course_id` and no `policy` at all.
   * Remove step 0 and the walk does not succeed; it fails at
   * `missing_course_cert`, and the capture policy is gone either way.
   *
   * What step 0 buys is the honest error. `missing_course_cert` about a manifest
   * that plainly carries one reads as a bug in the analyzer rather than as a
   * refused downgrade, and staff adjudicating a case need the true cause. Keep
   * it: cheap, first, and correct where the fallback is merely safe.
   */
  | { kind: 'not_manifest_2_0'; format_version: string }
  | { kind: 'missing_course_cert' }
  /**
   * The manifest itself does not satisfy the 2.0 shape. Reported before any
   * signature work, because a 2.0 manifest with a required field missing
   * canonicalizes to a payload without that key — so an unvalidated object could
   * chain successfully while carrying no `policy` at all.
   */
  | { kind: 'invalid_manifest_shape'; field?: string; reason?: string }
  /** Step 1: `course_cert` does not verify against the root public key. */
  | { kind: 'invalid_root_signature' }
  /** Step 2: the payload does not verify against `course_cert.course_pubkey`. */
  | { kind: 'invalid_course_signature' }
  /** Step 3: 61B's key signing a manifest that claims to be 61C. */
  | {
      kind: 'course_id_mismatch';
      manifest_course_id: string | null;
      cert_course_id: string;
    };

export type ManifestChainOk = {
  /** The course this manifest is proven to belong to (manifest and cert agree). */
  course_id: string;
  /** The course public key the root vouched for. */
  course_pubkey: string;
  cert: CourseCert;
  /**
   * Step 4, non-fatal. Out of window does NOT invalidate anything — the caller
   * decides. Program spec §4: an expired cert must not stop a recorder from
   * recording, because silently halting capture for a whole class is a worse
   * failure for an integrity tool than recording under a stale key.
   */
  window: CertWindowStatus;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEX_128_RE = /^[0-9a-f]{128}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;

/** The format version of a manifest with no `format_version` field. */
export const MANIFEST_FORMAT_VERSION_LEGACY = '1.0';

/** The version at which the trust chain, policy, and capability flags appear. */
export const MANIFEST_FORMAT_VERSION_2 = '2.0';

const COLLABORATION_VALUES: readonly string[] = ['solo', 'group'];
const SUBMISSION_VALUES: readonly string[] = ['bundle', 'git'];
const SCOPE_VALUES: readonly string[] = ['directory', 'repo'];

/** Printable ASCII. See {@link sanitizeSignedValue}. */
const ASCII_KEY_RE = /^[\x20-\x7e]+$/;

/**
 * Deep-rebuild an attacker-influenced sub-tree destined for the signed payload,
 * rejecting anything that would make the signed bytes disagree with what the
 * rest of the system reads.
 *
 * `policy` is the only signed field with open-ended contents, so it is the only
 * place these hazards can enter. Three things are enforced:
 *
 *  - **Printable-ASCII keys.** The permanent constraint documented in
 *    `course-cert.ts`: provnvim's hand-rolled Lua JCS sorts object keys bytewise
 *    while JS and Kotlin sort by UTF-16 code unit, and the two orderings diverge
 *    above U+007F. `{"ａ":1,"\u{10000}":2}` canonicalizes to different bytes
 *    in Lua than in JS, so the same manifest would verify on one recorder and
 *    fail on another. Documenting the rule in three docstrings and enforcing it
 *    nowhere was not enough.
 *  - **Plain data only.** Rebuilding drops `toJSON` methods and accessor
 *    properties. `canonicalize` honours `toJSON`, so a `policy` carrying one
 *    signs as one thing and is read as another — the signature would cover a
 *    capture-everything block while `resolveCapturePolicy` saw
 *    capture-nothing. Not reachable from `JSON.parse`, but very reachable once
 *    a `Manifest` can arrive as an in-process object (see
 *    {@link parseManifestValue}).
 *  - **Finite numbers.** `canonicalize` throws on `NaN`/`Infinity`; rejecting
 *    here turns that into a value rather than an exception.
 *
 * Key ORDER is deliberately not preserved: JCS sorts keys, so rebuilding cannot
 * change the canonical bytes of an otherwise-valid block.
 */
function sanitizeSignedValue(value: unknown, path: string): Result<unknown, ManifestError> {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return ok(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return err({ kind: 'invalid_shape', field: path, reason: 'must be a finite number' });
    }
    return ok(value);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const child = sanitizeSignedValue(value[i], `${path}[${i}]`);
      if (!child.ok) return child;
      out.push(child.value);
    }
    return ok(out);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!ASCII_KEY_RE.test(key)) {
        return err({
          kind: 'invalid_shape',
          field: path,
          reason: 'object keys must be printable ASCII',
        });
      }
      const child = sanitizeSignedValue((value as Record<string, unknown>)[key], `${path}.${key}`);
      if (!child.ok) return child;
      out[key] = child.value;
    }
    return ok(out);
  }
  // function, symbol, bigint, undefined — none are valid JSON.
  return err({ kind: 'invalid_shape', field: path, reason: 'must be JSON data' });
}

/**
 * Resolve a manifest's format version.
 *
 * **A missing `format_version` means `'1.0'`.** 1.x manifests have no such
 * field; treating its absence as anything but 1.0 would break every archived
 * submission. Non-negotiable (program spec §3).
 */
export function manifestFormatVersion(manifest: Pick<Manifest, 'format_version'>): string {
  return manifest.format_version ?? MANIFEST_FORMAT_VERSION_LEGACY;
}

/**
 * Build the canonical bytes that were signed.
 *
 * `sig` is always excluded. In 2.0, `course_cert` is excluded too — the course
 * does not sign its own certificate.
 *
 * For a 1.x manifest this produces **exactly** the bytes it produced before
 * Manifest 2.0 existed: the same four fields, no `format_version`. Existing
 * signatures on archived manifests therefore keep verifying forever. Pinned by
 * `manifest.test.ts` ("1.0 signed payload is byte-identical to the pre-2.0
 * bytes").
 *
 * JCS orders keys, so the literal order below has no effect on the output.
 */
function buildSignedPayload(manifest: Omit<Manifest, 'sig'>): Uint8Array {
  if (manifestFormatVersion(manifest) === MANIFEST_FORMAT_VERSION_2) {
    const payload = canonicalize({
      format_version: MANIFEST_FORMAT_VERSION_2,
      course_id: manifest.course_id,
      assignment_id: manifest.assignment_id,
      semester: manifest.semester,
      issued_at: manifest.issued_at,
      files_under_review: manifest.files_under_review,
      ignore: manifest.ignore,
      attachments: manifest.attachments,
      collaboration: manifest.collaboration,
      submission: manifest.submission,
      scope: manifest.scope,
      policy: manifest.policy,
    });
    return new TextEncoder().encode(payload);
  }

  const payload = canonicalize({
    assignment_id: manifest.assignment_id,
    semester: manifest.semester,
    issued_at: manifest.issued_at,
    files_under_review: manifest.files_under_review,
  });
  return new TextEncoder().encode(payload);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate one scope list. Used for all three at 2.0.
 *
 * At 1.x this is NOT called: 1.x parsing must never reject (see the module
 * docstring), and a 1.x manifest's entries carry exact-path meaning regardless
 * of how they are spelled.
 */
function checkScopeList(value: unknown, field: string): ManifestError | null {
  if (!Array.isArray(value)) {
    return { kind: 'invalid_shape', field, reason: 'must be an array' };
  }
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') {
      return { kind: 'invalid_shape', field, reason: 'all elements must be strings' };
    }
    const problem = validateScopeEntry(entry);
    if (problem !== null) {
      return { kind: 'invalid_shape', field, reason: `"${entry}": ${problem.detail}` };
    }
  }
  return null;
}

/**
 * Parse a `.provenance-manifest`/`provenance-manifest` file (text content) into a Manifest.
 * Validates JSON structure and field shapes. Does NOT verify any signature.
 *
 * Version handling (program spec §3):
 *
 *  - **No `format_version`** → defaults to `'1.0'` and parses successfully. This
 *    is how every 1.x manifest ever written is identified, so rejecting it would
 *    break every archived submission.
 *  - **`'2.0'`** → the 2.0 fields are all required, including `course_cert`.
 *    Requiring the full set keeps the signed key set fixed, which is what lets
 *    the Kotlin and Lua ports canonicalize identically without having to
 *    reproduce a "which optional keys were present" rule.
 *  - **Any other `'1.x'`** → parsed with the 1.x rules.
 *  - **Anything else** → rejected, rather than guessed at. Silently
 *    canonicalizing an unknown version under the wrong rules would produce a
 *    signature failure with a misleading cause.
 *
 * Unknown top-level keys are ignored for forward compatibility. That is safe
 * because canonicalization operates on the named fields only, so an unknown key
 * cannot silently change the signed bytes.
 */
export function parseManifest(text: string): Result<Manifest, ManifestError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err({ kind: 'invalid_json', message });
  }
  return parseManifestValue(parsed);
}

/**
 * The same validation as {@link parseManifest}, on an already-deserialized value.
 *
 * Needed because a manifest does not only arrive as file text any more: program
 * spec §5 puts the full `Manifest` inside `session.start`, so the analyzer and
 * server receive one as a parsed object embedded in a larger payload. Without an
 * object-taking validator those consumers would skip validation entirely and
 * hand an unchecked object to {@link verifyManifestChain}, which is exactly how
 * "the chain verified" stops implying "the course signed a policy".
 */
export function parseManifestValue(parsed: unknown): Result<Manifest, ManifestError> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err({ kind: 'invalid_shape', reason: 'must be an object' });
  }

  const obj = parsed as Record<string, unknown>;

  // format_version: absent means 1.0. Never a rejection reason on its own.
  if (obj['format_version'] !== undefined && typeof obj['format_version'] !== 'string') {
    return err({
      kind: 'invalid_shape',
      field: 'format_version',
      reason: 'must be a string when present',
    });
  }
  const formatVersion =
    (obj['format_version'] as string | undefined) ?? MANIFEST_FORMAT_VERSION_LEGACY;
  const isV2 = formatVersion === MANIFEST_FORMAT_VERSION_2;
  if (!isV2 && !formatVersion.startsWith('1.')) {
    return err({
      kind: 'invalid_shape',
      field: 'format_version',
      reason: `unsupported format_version '${formatVersion}'`,
    });
  }

  if (typeof obj['assignment_id'] !== 'string' || obj['assignment_id'].length === 0) {
    return err({
      kind: 'invalid_shape',
      field: 'assignment_id',
      reason: 'must be a non-empty string',
    });
  }
  if (typeof obj['semester'] !== 'string' || obj['semester'].length === 0) {
    return err({ kind: 'invalid_shape', field: 'semester', reason: 'must be a non-empty string' });
  }
  if (typeof obj['issued_at'] !== 'string' || obj['issued_at'].length === 0) {
    return err({ kind: 'invalid_shape', field: 'issued_at', reason: 'must be a non-empty string' });
  }
  if (!Array.isArray(obj['files_under_review'])) {
    return err({ kind: 'invalid_shape', field: 'files_under_review', reason: 'must be an array' });
  }
  for (const f of obj['files_under_review'] as unknown[]) {
    if (typeof f !== 'string') {
      return err({
        kind: 'invalid_shape',
        field: 'files_under_review',
        reason: 'all elements must be strings',
      });
    }
  }

  // sig: 128 hex chars (64-byte ed25519 signature)
  if (obj['sig'] === undefined) {
    return err({
      kind: 'invalid_shape',
      field: 'sig',
      reason: 'missing',
    });
  }
  if (typeof obj['sig'] !== 'string' || !HEX_128_RE.test(obj['sig'])) {
    return err({
      kind: 'invalid_shape',
      field: 'sig',
      reason: 'must be a 128-char hex string',
    });
  }

  const base: Manifest = {
    format_version: formatVersion,
    assignment_id: obj['assignment_id'] as string,
    semester: obj['semester'] as string,
    issued_at: obj['issued_at'] as string,
    files_under_review: obj['files_under_review'] as readonly string[],
    sig: obj['sig'] as string,
  };

  if (!isV2) return ok(base);

  // --- 2.0-only fields, all required ---------------------------------------

  if (typeof obj['course_id'] !== 'string' || obj['course_id'].length === 0) {
    return err({ kind: 'invalid_shape', field: 'course_id', reason: 'must be a non-empty string' });
  }
  const ignoreProblem = checkScopeList(obj['ignore'], 'ignore');
  if (ignoreProblem !== null) return err(ignoreProblem);
  const attachmentsProblem = checkScopeList(obj['attachments'], 'attachments');
  if (attachmentsProblem !== null) return err(attachmentsProblem);
  // files_under_review already passed the array/string check in the shared
  // section above; at 2.0 its entries must also satisfy the entry grammar.
  const trackProblem = checkScopeList(obj['files_under_review'], 'files_under_review');
  if (trackProblem !== null) return err(trackProblem);
  const enumField = <T extends string>(
    field: string,
    allowed: readonly string[],
  ): Result<T, ManifestError> => {
    const value = obj[field];
    if (typeof value !== 'string' || !allowed.includes(value)) {
      return err({
        kind: 'invalid_shape',
        field,
        reason: `must be one of ${allowed.join(' | ')}`,
      });
    }
    return ok(value as T);
  };

  const collaboration = enumField<ManifestCollaboration>('collaboration', COLLABORATION_VALUES);
  if (!collaboration.ok) return collaboration;
  const submission = enumField<ManifestSubmission>('submission', SUBMISSION_VALUES);
  if (!submission.ok) return submission;
  const scope = enumField<ManifestScope>('scope', SCOPE_VALUES);
  if (!scope.ok) return scope;

  const rawPolicy = obj['policy'];
  if (typeof rawPolicy !== 'object' || rawPolicy === null || Array.isArray(rawPolicy)) {
    return err({ kind: 'invalid_shape', field: 'policy', reason: 'must be an object' });
  }
  // Rebuilt as plain data with ASCII keys — see sanitizeSignedValue. Contents are
  // otherwise preserved verbatim, unknown keys included, so the block still
  // round-trips through signature verification byte-for-byte.
  const policy = sanitizeSignedValue(rawPolicy, 'policy');
  if (!policy.ok) return policy;

  if (obj['course_cert'] === undefined) {
    return err({ kind: 'invalid_shape', field: 'course_cert', reason: 'missing' });
  }
  const cert = parseCourseCert(obj['course_cert']);
  if (!cert.ok) {
    const inner = cert.error;
    if (inner.kind === 'invalid_shape') {
      return err({
        kind: 'invalid_shape',
        field: inner.field === undefined ? 'course_cert' : `course_cert.${inner.field}`,
        ...(inner.reason === undefined ? {} : { reason: inner.reason }),
      });
    }
    return err({ kind: 'invalid_signature' });
  }

  return ok({
    ...base,
    course_id: obj['course_id'] as string,
    ignore: obj['ignore'] as readonly string[],
    attachments: obj['attachments'] as readonly string[],
    collaboration: collaboration.value,
    submission: submission.value,
    scope: scope.value,
    // Contents kept verbatim (unknown keys included) so the signed bytes
    // round-trip; only the container is rebuilt as plain data.
    policy: policy.value as CapturePolicyBlock,
    course_cert: cert.value,
  });
}

/**
 * Sign an assignment manifest with the course private key (inverse of
 * verifyManifest). Returns the hex ed25519 signature over the version-appropriate
 * signed payload — see {@link buildSignedPayload}.
 *
 * This is the routine course staff tooling (and the dev seed) use to produce a
 * `.provenance-manifest`/`provenance-manifest` sig; verifyManifest against the same payload confirms it.
 *
 * Signing a 2.0 manifest with a 2.0 field missing produces a signature over a
 * payload with that key absent, which will then fail verification against a
 * correctly-parsed manifest. Build 2.0 manifests through a complete object.
 */
export async function signManifest(
  manifest: Omit<Manifest, 'sig'>,
  signingPrivkey: Uint8Array,
): Promise<string> {
  const payloadBytes = buildSignedPayload(manifest);
  const sig = await ed.signAsync(payloadBytes, signingPrivkey);
  return bytesToHex(sig);
}

/**
 * Verify the ed25519 signature on a parsed Manifest.
 *
 * @param manifest  A manifest returned by parseManifest (sig already validated as 128 hex chars).
 * @param pubkey    Hex-encoded ed25519 public key (32 bytes → 64 hex chars). For a 2.0
 *                  manifest this is `course_cert.course_pubkey`; for 1.x it is the single
 *                  embedded course key.
 *
 * The signed payload is version-dependent — see {@link buildSignedPayload}. The
 * `sig` field is always excluded (PRD §4.1); `course_cert` is excluded in 2.0.
 *
 * This entry point is unchanged for 1.x callers: same signature, same bytes,
 * same result.
 *
 * **This is NOT chain verification.** At 2.0 it answers only "did this public key
 * sign this payload", and the public key you would naturally reach for —
 * `manifest.course_cert.course_pubkey` — comes out of a student-editable file.
 * Calling `verifyManifest(m, m.course_cert.course_pubkey)` and treating the
 * result as trust is self-referential and proves nothing. Use
 * {@link verifyManifestChain}, which roots the key in the root signature first.
 */
export async function verifyManifest(
  manifest: Manifest,
  pubkey: string,
): Promise<Result<true, ManifestError>> {
  if (!HEX_64_RE.test(pubkey)) {
    return err({ kind: 'invalid_signature' });
  }
  // Pre-check rather than letting hexToBytes throw: a malformed sig is an
  // expected input (it comes from a file a student can edit), and expected
  // failures are values here, not exceptions.
  if (!HEX_128_RE.test(manifest.sig)) {
    return err({ kind: 'invalid_signature' });
  }

  let valid: boolean;
  try {
    // Everything that can throw on hostile input lives inside the try:
    // `hexToBytes` on a malformed hex string, and `buildSignedPayload`, which
    // canonicalizes an attacker-influenced `policy` block and throws on NaN,
    // Infinity, or a circular reference.
    const sigBytes = hexToBytes(manifest.sig);
    const pubkeyBytes = hexToBytes(pubkey);
    const payloadBytes = buildSignedPayload(manifest);
    // `@noble/ed25519` v3 defaults to ZIP215 verification semantics (more permissive than RFC8032
    // about non-canonical point encodings). At 1.x the verifying key was hardcoded into the
    // recorder build, which made this a non-issue. At 2.0 it is `course_cert.course_pubkey`,
    // i.e. it arrives in a student-editable file — but `verifyManifestChain` root-verifies the
    // certificate carrying that key BEFORE reaching this call, so the key is still trusted by
    // the time it is used. That ordering is what keeps ZIP215 acceptable; do not call this
    // function with an unverified key and call the result trust.
    valid = await ed.verifyAsync(sigBytes, payloadBytes, pubkeyBytes);
  } catch {
    return err({ kind: 'invalid_signature' });
  }

  if (!valid) {
    return err({ kind: 'invalid_signature' });
  }

  return ok(true as const);
}

/**
 * Walk the full Manifest 2.0 trust chain: root → course_cert → manifest.
 *
 * Program spec §3. **The four steps run in this order and the order is
 * load-bearing:**
 *
 *  1. `course_cert` minus `root_sig` verifies against `rootPubkeyHex`.
 *  2. The manifest payload (minus `sig` and `course_cert`) verifies against
 *     `course_cert.course_pubkey`.
 *  3. `manifest.course_id === course_cert.course_id`.
 *  4. `manifest.issued_at` falls within `[valid_from, valid_until]`.
 *
 * Step 3 is not a formality. Without it, CS 61B's course key can sign a manifest
 * whose `course_id` says `berkeley-cs61c`, and steps 1 and 2 both pass: the cert
 * is genuinely root-signed, and the payload is genuinely signed by the key that
 * cert authorizes. Only comparing the two ids catches it. Mandatory conformance
 * vector.
 *
 * Step 4 is evaluated against `issued_at`, NEVER against wall-clock now — a Fall
 * 2026 bundle must still verify in 2028 for an adjudication case. It is also
 * **non-fatal**: an out-of-window result is returned on the success value as
 * `window`, not as an error. A course that lets a cert lapse mid-semester must
 * not have recording silently stop for the whole class (program spec §4); the
 * recorder records and stamps the expiry, and the analyzer decides.
 *
 * @param rootPubkeyHex The embedded root public key. A PARAMETER — `log-core`
 *                      never hardcodes it; each recorder build embeds its own.
 */
export async function verifyManifestChain(
  manifest: Manifest,
  rootPubkeyHex: string,
): Promise<Result<ManifestChainOk, ManifestChainError>> {
  // Step 0 — the chain exists only at 2.0. This is the OUTER layer of the
  // defence against the 1.x downgrade attack; the inner one is
  // parseManifestValue, which strips course_cert / course_id / policy off any
  // non-2.0 manifest, so the walk would fail at missing_course_cert even
  // without this. Step 0 is what makes the refusal say what it means. See
  // ManifestChainError.
  const declaredVersion = manifestFormatVersion(manifest);
  if (declaredVersion !== MANIFEST_FORMAT_VERSION_2) {
    return err({ kind: 'not_manifest_2_0', format_version: declaredVersion });
  }

  if (manifest.course_cert === undefined) {
    return err({ kind: 'missing_course_cert' });
  }

  // Re-validate the WHOLE manifest, not just the certificate: `manifest` may
  // have been hand-built, or (per program spec §5) lifted straight out of a
  // `session.start` payload without going through parseManifest. Skipping this
  // would let a 2.0 manifest missing `policy` verify happily — `canonicalize`
  // omits undefined-valued keys, so the absent field simply drops out of the
  // signed payload — and "the chain verified" would stop implying "the course
  // signed a capture policy", which is the entire point of §4.
  const validated = parseManifestValue(manifest);
  if (!validated.ok) {
    const inner = validated.error;
    return err({
      kind: 'invalid_manifest_shape',
      ...(inner.kind === 'invalid_shape' && inner.field !== undefined
        ? { field: inner.field }
        : {}),
      ...(inner.kind === 'invalid_shape' && inner.reason !== undefined
        ? { reason: inner.reason }
        : {}),
    });
  }
  // Verify against the validated copy: its `policy` is plain data with ASCII
  // keys, so the bytes checked here are the bytes every later reader sees.
  const checked = validated.value;
  const cert = checked.course_cert as CourseCert;

  // Step 1 — cert vs root.
  const rootOk = await verifyCourseCert(cert, rootPubkeyHex);
  if (!rootOk.ok) {
    return err({ kind: 'invalid_root_signature' });
  }

  // Step 2 — payload vs course_pubkey.
  const courseOk = await verifyManifest(checked, cert.course_pubkey);
  if (!courseOk.ok) {
    return err({ kind: 'invalid_course_signature' });
  }

  // Step 3 — the manifest may not claim a course its cert does not cover.
  if (checked.course_id !== cert.course_id) {
    return err({
      kind: 'course_id_mismatch',
      manifest_course_id: checked.course_id ?? null,
      cert_course_id: cert.course_id,
    });
  }

  // Step 4 — non-fatal validity window, evaluated against issued_at.
  return ok({
    course_id: cert.course_id,
    course_pubkey: cert.course_pubkey,
    cert,
    window: checkCertWindow(cert, checked.issued_at),
  });
}

/**
 * The three scope lists as a {@link ResolvedScope}.
 *
 * The ONLY way a consumer should build one. A 1.x manifest has no `ignore` or
 * `attachments`, so both default to empty — which resolves every path to
 * `'reviewed'` or `'unscoped'` exactly as 1.x always behaved.
 */
export function scopeFromManifest(manifest: Manifest): ResolvedScope {
  return {
    track: manifest.files_under_review,
    ignore: manifest.ignore ?? [],
    attachments: manifest.attachments ?? [],
  };
}
