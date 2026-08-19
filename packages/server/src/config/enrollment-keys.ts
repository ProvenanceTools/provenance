/**
 * The server's ENROLLMENT key material — the only private key it holds.
 *
 * Program spec §5a. The trust chain is:
 *
 *   root key (offline) ──▶ course_cert ──▶ course key (OFFLINE)
 *                                              │ signs
 *                                              ▼
 *                                        enrollment_cert
 *                                              │ authorizes
 *                                              ▼
 *                                     enrollment key  ◄── HERE, on the server
 *                                              │ signs
 *                                              ▼
 *                                       enrollment token
 *
 * ## Where it lives, and why not in Postgres
 *
 * In the environment: `PROVENANCE_ENROLLMENT_KEYS`, a JSON object keyed by
 * semester id, each value `{ private_key_hex, cert }`. That is where every
 * other secret this server holds already lives, so it inherits the deployment's
 * existing handling of secrets rather than inventing a second mechanism.
 *
 * Explicitly NOT a database row. Database dumps travel — nightly backups, the
 * restore drill in `docs/admin-guide.md`, an operator debugging a copy — and
 * the one secret whose theft forges student identity should not ride along.
 * Keeping it out of Postgres also means a read-only SQL injection or a leaked
 * backup cannot mint anything.
 *
 * ## What its compromise buys an attacker
 *
 * Everything this layer exists to prevent, for one course, for the length of
 * the certificate's window: they can mint a token binding ANY public key they
 * control to ANY student on that roster, then countersign session keys as that
 * student. Attribution in every bundle recorded afterwards becomes forgeable,
 * and the forgery verifies — the signatures are genuine.
 *
 * What it does NOT buy: signing a manifest (that needs the offline course key),
 * reaching a second course (`course_id` is inside the signed cert and every
 * verifier cross-checks all three links), or outliving `valid_until`. Recovery
 * is to mint a fresh `enrollment_cert` for a new key with
 * `tools/mint-enrollment-cert.ts` — an offline operation the course already
 * performs — and rotate this variable.
 *
 * ## Handling rules, which the code below enforces
 *
 *  - the private key is never logged, never put in an error, never serialized
 *    into an API response;
 *  - parse failures name the semester and the offending FIELD, never a value;
 *  - the key is not trusted to be the right one: a minted token is verified
 *    against `cert.enrollment_pubkey` before it is returned (see
 *    `services/enrollment/mint.ts`), so a stale or mismatched secret fails
 *    loudly instead of issuing tokens nothing can verify.
 */

import { parseEnrollmentCert, ENROLLMENT_FORMAT_VERSION } from '@provenance/log-core';
import type { EnrollmentCert } from '@provenance/log-core';
import { getConfig } from './index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnrollmentKeyMaterial = {
  /** The semester this key mints tokens for. */
  semester_id: string;
  /** The course-signed authorization for this key. Public; travels in bundles. */
  cert: EnrollmentCert;
  /**
   * The enrollment private key, 64 lowercase hex.
   *
   * NEVER log this, never include it in an error, never return it over HTTP.
   * The only legitimate consumer is `signEnrollmentToken`.
   */
  private_key_hex: string;
};

export type EnrollmentKeysError = {
  /** Which semester's entry is bad, when the failure is attributable to one. */
  semester_id?: string;
  /** Names the offending field. Never contains a configured value. */
  reason: string;
};

export type EnrollmentKeysResult =
  | { ok: true; value: Map<string, EnrollmentKeyMaterial> }
  | { ok: false; error: EnrollmentKeysError };

const HEX_64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the raw `PROVENANCE_ENROLLMENT_KEYS` value into per-semester material.
 *
 * Pure: no filesystem, no clock, no crypto. Every error path is written so that
 * `JSON.stringify(error)` cannot contain a configured secret — the tests assert
 * exactly that, because a config error surfaces on stderr during a failed boot
 * where it is likely to be pasted into a chat window.
 */
export function parseEnrollmentKeys(raw: string): EnrollmentKeysResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { reason: 'not valid JSON' } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: { reason: 'must be a JSON object keyed by semester id' } };
  }

  const out = new Map<string, EnrollmentKeyMaterial>();

  for (const [semesterId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return {
        ok: false,
        error: { semester_id: semesterId, reason: 'entry must be an object' },
      };
    }
    const obj = entry as Record<string, unknown>;

    const privateKeyHex = obj['private_key_hex'];
    if (typeof privateKeyHex !== 'string' || !HEX_64_RE.test(privateKeyHex)) {
      return {
        ok: false,
        error: {
          semester_id: semesterId,
          reason: 'private_key_hex must be 64 lowercase hex characters',
        },
      };
    }

    // Version gate before shape, mirroring verifyIdentityChain step 0: a future
    // 3.0 certificate must be refused outright, not read under 2.0 rules.
    const declaredVersion = (obj['cert'] as Partial<EnrollmentCert> | undefined)?.format_version;
    if (declaredVersion !== ENROLLMENT_FORMAT_VERSION) {
      return {
        ok: false,
        error: {
          semester_id: semesterId,
          reason: `cert.format_version must be "${ENROLLMENT_FORMAT_VERSION}"`,
        },
      };
    }

    const cert = parseEnrollmentCert(obj['cert']);
    if (!cert.ok) {
      const field = cert.error.kind === 'invalid_shape' ? cert.error.field : undefined;
      return {
        ok: false,
        error: {
          semester_id: semesterId,
          reason: field !== undefined ? `cert.${field} is invalid` : 'cert is not a valid 2.0 cert',
        },
      };
    }

    out.set(semesterId, {
      semester_id: semesterId,
      cert: cert.value,
      private_key_hex: privateKeyHex,
    });
  }

  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Cached lookup
// ---------------------------------------------------------------------------

let _cache: Map<string, EnrollmentKeyMaterial> | undefined;
let _cachedRaw: string | undefined;

/**
 * The enrollment key material for a semester, or `undefined` when this
 * deployment mints no tokens for it.
 *
 * `undefined` is a legitimate state — every semester predating S2 is in it —
 * so callers turn it into a 503 telling the student enrollment is not open,
 * not a crash.
 *
 * A MALFORMED configuration is different and throws: silently behaving as if
 * no key were configured would turn an operator typo into "enrollment is
 * closed for the semester", which is exactly the failure a course would not
 * notice until students complained.
 */
export function enrollmentKeyForSemester(semesterId: string): EnrollmentKeyMaterial | undefined {
  const raw = getConfig().PROVENANCE_ENROLLMENT_KEYS;
  if (_cache === undefined || _cachedRaw !== raw) {
    const parsed = parseEnrollmentKeys(raw);
    if (!parsed.ok) {
      const where =
        parsed.error.semester_id !== undefined ? ` for semester ${parsed.error.semester_id}` : '';
      throw new Error(
        `Invalid PROVENANCE_ENROLLMENT_KEYS enrollment key configuration${where}: ${parsed.error.reason}`,
      );
    }
    _cache = parsed.value;
    _cachedRaw = raw;
  }
  return _cache.get(semesterId);
}

/** Test-only: drop the memoised parse so a new config is picked up. */
export function _resetEnrollmentKeysForTest(): void {
  _cache = undefined;
  _cachedRaw = undefined;
}

// ---------------------------------------------------------------------------
// Hex helper
// ---------------------------------------------------------------------------

/**
 * Decode 64 lowercase hex characters into 32 bytes.
 *
 * Local rather than imported from `@noble/hashes` because the server does not
 * depend on the noble packages directly and this is four lines.
 */
export function hex64ToBytes(hex: string): Uint8Array {
  if (!HEX_64_RE.test(hex)) throw new TypeError('hex64ToBytes: expected 64 lowercase hex chars');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
