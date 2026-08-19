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
 *                 files_under_review, collaboration, submission, scope, policy})
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
   * This gate is a security control, not a convenience. At 1.x, `course_id`,
   * `collaboration`, `submission`, `scope`, and `policy` are NOT in the signed
   * payload. Without this check a student holding any legitimately-issued 1.x
   * manifest from their own course could staple on that course's (public)
   * certificate, add a matching `course_id` to satisfy step 3, and staple on an
   * arbitrary unsigned `policy` — and the whole chain would return ok. That
   * would let a student turn capture off, which is exactly what the policy block
   * living inside the signed payload exists to prevent.
   */
  | { kind: 'not_manifest_2_0'; format_version: string }
  | { kind: 'missing_course_cert' }
  | { kind: 'invalid_cert_shape'; field?: string; reason?: string }
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

  const policy = obj['policy'];
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    return err({ kind: 'invalid_shape', field: 'policy', reason: 'must be an object' });
  }

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
    collaboration: collaboration.value,
    submission: submission.value,
    scope: scope.value,
    // Kept verbatim (unknown keys included) so the signed bytes round-trip.
    policy: policy as CapturePolicyBlock,
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
 */
export async function verifyManifest(
  manifest: Manifest,
  pubkey: string,
): Promise<Result<true, ManifestError>> {
  if (!HEX_64_RE.test(pubkey)) {
    return err({ kind: 'invalid_signature' });
  }

  const sigBytes = hexToBytes(manifest.sig);
  const pubkeyBytes = hexToBytes(pubkey);
  const payloadBytes = buildSignedPayload(manifest);

  let valid: boolean;
  try {
    // `@noble/ed25519` v3 defaults to ZIP215 verification semantics (more permissive than RFC8032
    // about non-canonical point encodings). Safe here since the course public key is hardcoded;
    // reconsider if the key ever becomes user-supplied.
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
  // Step 0 — the chain exists only at 2.0. Refusing a 1.x manifest here closes a
  // downgrade attack: at 1.x, course_id / collaboration / submission / scope /
  // policy are all OUTSIDE the signed payload, so a student could staple their
  // course's public cert and a capture-disabling policy onto a genuinely signed
  // 1.x manifest and walk the chain successfully. See ManifestChainError.
  const formatVersion = manifestFormatVersion(manifest);
  if (formatVersion !== MANIFEST_FORMAT_VERSION_2) {
    return err({ kind: 'not_manifest_2_0', format_version: formatVersion });
  }

  if (manifest.course_cert === undefined) {
    return err({ kind: 'missing_course_cert' });
  }

  // Re-validate the cert shape: `manifest` may have been hand-built rather than
  // produced by parseManifest.
  const certResult = parseCourseCert(manifest.course_cert);
  if (!certResult.ok) {
    const inner = certResult.error;
    if (inner.kind === 'invalid_shape') {
      return err({
        kind: 'invalid_cert_shape',
        ...(inner.field === undefined ? {} : { field: inner.field }),
        ...(inner.reason === undefined ? {} : { reason: inner.reason }),
      });
    }
    return err({ kind: 'invalid_root_signature' });
  }
  const cert = certResult.value;

  // Step 1 — cert vs root.
  const rootOk = await verifyCourseCert(cert, rootPubkeyHex);
  if (!rootOk.ok) {
    return err({ kind: 'invalid_root_signature' });
  }

  // Step 2 — payload vs course_pubkey.
  const courseOk = await verifyManifest(manifest, cert.course_pubkey);
  if (!courseOk.ok) {
    return err({ kind: 'invalid_course_signature' });
  }

  // Step 3 — the manifest may not claim a course its cert does not cover.
  if (manifest.course_id !== cert.course_id) {
    return err({
      kind: 'course_id_mismatch',
      manifest_course_id: manifest.course_id ?? null,
      cert_course_id: cert.course_id,
    });
  }

  // Step 4 — non-fatal validity window, evaluated against issued_at.
  return ok({
    course_id: cert.course_id,
    course_pubkey: cert.course_pubkey,
    cert,
    window: checkCertWindow(cert, manifest.issued_at),
  });
}
