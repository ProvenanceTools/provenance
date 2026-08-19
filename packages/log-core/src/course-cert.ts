/**
 * Course certificate — the middle link of the Manifest 2.0 trust chain.
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md` §2, §3.
 *
 *   root keypair (Provenance maintainer, offline; NEVER signs a manifest)
 *        │ signs
 *        ▼
 *   course_cert { course_id, course_pubkey, valid_from, valid_until }
 *        │ authorizes
 *        ▼
 *   course keypair (course staff; signs `.provenance-manifest` files)
 *
 * `log-core` stays pure: **the root public key is never a constant in this
 * package.** It is embedded by each recorder build (`ROOT_PUBLIC_KEY_HEX`) and
 * passed in as a parameter to `verifyCourseCert`. A hardcoded key here would
 * make one build serve exactly one deployment, which is the thing this design
 * exists to remove.
 *
 * The signed payload is the certificate MINUS `root_sig`:
 *
 *   canonicalize({course_id, course_pubkey, valid_from, valid_until})
 *
 * Revocation is deliberately NOT modelled here. An offline recorder cannot learn
 * that a key was revoked without making a network call, which recorder PRD NG2
 * forbids. Revocation is a server-side list checked by the analyzer; the offline
 * mitigation is short validity windows (one semester per cert). This is a real,
 * accepted limitation — see program spec §2.
 *
 * ## Permanent constraint: no user-derived object keys in a signed payload
 *
 * Every object KEY that ends up inside a canonicalized, signed payload — here,
 * in the manifest, and in the capture-policy block — MUST be a fixed ASCII
 * identifier chosen by us. Never a course id, student ref, filename, or any
 * other user-supplied string promoted to a key.
 *
 * The reason is cross-language canonicalization parity. provnvim's JCS
 * implementation is hand-rolled in Lua and sorts object keys BYTEWISE; the JS
 * (`canonicalize`) and Kotlin (`java-json-canonicalization`) implementations
 * sort by UTF-16 code unit. Those two orderings agree for ASCII keys and can
 * diverge for anything above U+007F — silently, producing different signed bytes
 * and breaking signature cross-verification between recorders. Values are
 * unconstrained; only keys carry this rule.
 *
 * This applies to all future format work, not just Manifest 2.0.
 */

import * as ed from '@noble/ed25519';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { canonicalize } from './canonical.js';
import { ok, err } from './result.js';
import type { Result } from './result.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CourseCert = {
  /** Must equal the enclosing manifest's `course_id` (program spec §3 step 3). */
  course_id: string;
  /** Hex ed25519 public key of the course signing key, 64 chars (32 bytes). */
  course_pubkey: string;
  /** Inclusive lower bound of the validity window. ISO 8601 date or timestamp. */
  valid_from: string;
  /** Inclusive upper bound of the validity window. ISO 8601 date or timestamp. */
  valid_until: string;
  /** Hex ed25519 signature by the ROOT key, 128 chars (64 bytes). */
  root_sig: string;
};

export type CourseCertError =
  | { kind: 'invalid_shape'; field?: string; reason?: string }
  | { kind: 'invalid_signature' };

/**
 * Outcome of the validity-window check (program spec §3 step 4).
 *
 * Evaluated against `manifest.issued_at`, NEVER against wall-clock now: a Fall
 * 2026 bundle must still verify in 2028 for an adjudication case. The question
 * is always "was the cert valid when the manifest was issued".
 *
 * Being out of window is NOT fatal and does not invalidate a signature — the
 * caller decides what to do with it (program spec §4: an expired cert must not
 * stop a recorder from recording).
 */
export type CertWindowStatus =
  | { in_window: true }
  | {
      in_window: false;
      reason: 'before_valid_from' | 'after_valid_until' | 'unparseable_timestamp';
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEX_128_RE = /^[0-9a-f]{128}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;

/**
 * Strict ISO 8601 / RFC 3339 grammar accepted by {@link parseIsoInstantMs}.
 *
 * Spelled out as an explicit grammar rather than delegated to `Date.parse` so
 * that the Kotlin and Lua ports implement the *same* accepting set. `Date.parse`
 * accepts a large, implementation-defined superset; Lua has no date parser at
 * all. Groups: y, m, d, [hh, mm, ss, [frac], [offset]].
 */
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Parse an ISO 8601 timestamp to epoch milliseconds, or return `null` if it does
 * not match {@link ISO_INSTANT_RE}.
 *
 * Two deliberate rules, both pinned by conformance vectors:
 *
 *  - A **date-only** string (`YYYY-MM-DD`) is the instant of UTC midnight that
 *    day. So `valid_until: "2027-01-15"` expires at `2027-01-15T00:00:00Z`, not
 *    at the end of that day. This is the least-surprising reading of a date as
 *    an instant, and the edge case is harmless because being out of window is
 *    non-fatal.
 *  - A timestamp with **no offset suffix** is treated as UTC.
 */
export function parseIsoInstantMs(value: string): number | null {
  const m = ISO_INSTANT_RE.exec(value);
  if (m === null) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  // Fractional seconds: pad/truncate to exactly 3 digits (milliseconds).
  const millis = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0').slice(0, 3));

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;

  // `Date.UTC` maps years 0-99 onto 1900-1999, so a four-digit year like '0026'
  // would silently become 1926. Build the date and set the full year explicitly.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  let ms = date.getTime();
  if (Number.isNaN(ms)) return null;

  // `Date` silently rolls invalid calendar dates forward (2026-02-31 becomes
  // 2026-03-03). Accepting that would put this parser's accepting set at the
  // mercy of JS date arithmetic, which the Kotlin (`java.time`, strict) and Lua
  // (hand-rolled) ports would not reproduce. Reject anything that did not
  // round-trip.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  const offset = m[8];
  if (offset !== undefined && offset !== 'Z') {
    const sign = offset.startsWith('-') ? 1 : -1;
    const offHours = Number(offset.slice(1, 3));
    const offMinutes = Number(offset.slice(4, 6));
    if (offHours > 23 || offMinutes > 59) return null;
    ms += sign * (offHours * 60 + offMinutes) * 60_000;
  }

  return ms;
}

/**
 * Build the canonical bytes the ROOT key signs.
 * `root_sig` is excluded; the four remaining fields are canonicalized (JCS
 * orders keys, so the literal order below is irrelevant).
 */
export function buildCourseCertSignedPayload(cert: Omit<CourseCert, 'root_sig'>): Uint8Array {
  const payload = canonicalize({
    course_id: cert.course_id,
    course_pubkey: cert.course_pubkey,
    valid_from: cert.valid_from,
    valid_until: cert.valid_until,
  });
  return new TextEncoder().encode(payload);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the shape of an already-JSON-parsed `course_cert` value.
 *
 * Takes `unknown` rather than text because the certificate travels **inline**
 * inside `.provenance-manifest` (program spec §2): one file to discover, one to
 * distribute, and no chance of the two being separated by a copy or a
 * `.gitignore`.
 *
 * Unknown keys are ignored for forward compatibility. Note this is safe:
 * canonicalization operates on the four named fields only, so an unknown key
 * cannot silently change the signed bytes.
 */
export function parseCourseCert(value: unknown): Result<CourseCert, CourseCertError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({ kind: 'invalid_shape', reason: 'must be an object' });
  }
  const obj = value as Record<string, unknown>;

  for (const field of ['course_id', 'valid_from', 'valid_until'] as const) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      return err({ kind: 'invalid_shape', field, reason: 'must be a non-empty string' });
    }
  }
  if (typeof obj['course_pubkey'] !== 'string' || !HEX_64_RE.test(obj['course_pubkey'])) {
    return err({
      kind: 'invalid_shape',
      field: 'course_pubkey',
      reason: 'must be a 64-char hex string',
    });
  }
  if (obj['root_sig'] === undefined) {
    return err({ kind: 'invalid_shape', field: 'root_sig', reason: 'missing' });
  }
  if (typeof obj['root_sig'] !== 'string' || !HEX_128_RE.test(obj['root_sig'])) {
    return err({
      kind: 'invalid_shape',
      field: 'root_sig',
      reason: 'must be a 128-char hex string',
    });
  }

  return ok({
    course_id: obj['course_id'] as string,
    course_pubkey: obj['course_pubkey'] as string,
    valid_from: obj['valid_from'] as string,
    valid_until: obj['valid_until'] as string,
    root_sig: obj['root_sig'] as string,
  });
}

/**
 * Sign a course certificate with the ROOT private key (inverse of
 * {@link verifyCourseCert}). Used by maintainer tooling and by the conformance
 * vector generator; never by a recorder.
 */
export async function signCourseCert(
  cert: Omit<CourseCert, 'root_sig'>,
  rootPrivkey: Uint8Array,
): Promise<string> {
  const sig = await ed.signAsync(buildCourseCertSignedPayload(cert), rootPrivkey);
  return bytesToHex(sig);
}

/**
 * Step 1 of the Manifest 2.0 verification order: verify `course_cert` minus
 * `root_sig` against the embedded root public key.
 *
 * @param cert          A certificate whose shape has already been validated.
 * @param rootPubkeyHex Hex ed25519 root public key (64 chars). A PARAMETER, not
 *                      a constant — see the module docstring.
 */
export async function verifyCourseCert(
  cert: CourseCert,
  rootPubkeyHex: string,
): Promise<Result<true, CourseCertError>> {
  if (!HEX_64_RE.test(rootPubkeyHex)) {
    return err({ kind: 'invalid_signature' });
  }
  if (!HEX_128_RE.test(cert.root_sig)) {
    return err({ kind: 'invalid_signature' });
  }

  let valid: boolean;
  try {
    valid = await ed.verifyAsync(
      hexToBytes(cert.root_sig),
      buildCourseCertSignedPayload(cert),
      hexToBytes(rootPubkeyHex),
    );
  } catch {
    return err({ kind: 'invalid_signature' });
  }

  if (!valid) return err({ kind: 'invalid_signature' });
  return ok(true as const);
}

/**
 * Step 4 of the Manifest 2.0 verification order: is `issuedAt` inside
 * `[valid_from, valid_until]` (both bounds inclusive)?
 *
 * `issuedAt` is the manifest's `issued_at`. Wall-clock now is never consulted.
 */
export function checkCertWindow(cert: CourseCert, issuedAt: string): CertWindowStatus {
  const from = parseIsoInstantMs(cert.valid_from);
  const until = parseIsoInstantMs(cert.valid_until);
  const issued = parseIsoInstantMs(issuedAt);

  if (from === null || until === null || issued === null) {
    return { in_window: false, reason: 'unparseable_timestamp' };
  }
  if (issued < from) return { in_window: false, reason: 'before_valid_from' };
  if (issued > until) return { in_window: false, reason: 'after_valid_until' };
  return { in_window: true };
}
