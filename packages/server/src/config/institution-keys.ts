/**
 * The server's INSTITUTION key material — identity `format_version` 2.1.
 *
 * The structural twin of `enrollment-keys.ts`, which stays live forever for the
 * 2.0 course-scoped chain. The 2.1 chain is one delegation shorter:
 *
 *   root key (offline) ──▶ institution_cert
 *                                 │ authorizes
 *                                 ▼
 *                          institution key  ◄── HERE, on the server
 *                                 │ signs
 *                                 ▼
 *                          student_credential
 *
 * 2.0 needed the extra `course_cert → enrollment_cert` hop purely because the
 * course key is offline and cannot mint per-student tokens on demand. The
 * institution key is certified by root DIRECTLY and lives on the server, so
 * that hop has nothing left to do. Course keys are unaffected — they keep
 * signing manifests and capture policy exactly as before.
 *
 * ## One key, not a map
 *
 * `enrollment-keys.ts` is keyed by semester because an enrollment cert names a
 * `course_id` and every course rotates independently. A `student_credential`
 * names no course, no semester, and no assignment, so there is exactly one
 * institution key per deployment and this module returns a single value. The
 * `institution_id` is read off the certificate rather than configured
 * separately: it is inside the root-signed payload, so it cannot be set to
 * something the root key did not authorize.
 *
 * ## Where it lives, and why not in Postgres
 *
 * In the environment: `PROVENANCE_INSTITUTION_KEY`. That is where every other
 * secret this server holds already lives, so it inherits the deployment's
 * existing secret handling rather than inventing a second mechanism.
 *
 * Explicitly NOT a database row. Database dumps travel — nightly backups, the
 * restore drill in `docs/admin-guide.md`, an operator debugging a copy — and
 * the one secret whose theft forges student attribution must not ride along.
 * Keeping it out of Postgres also means a read-only SQL injection or a leaked
 * backup cannot mint anything.
 *
 * ## What its compromise buys an attacker
 *
 * Everything this layer exists to prevent, for the WHOLE INSTITUTION, for the
 * length of the certificate's window: they can mint a credential binding ANY
 * public key they control to ANY `student_ref`, then countersign session keys
 * as that student. Attribution in every bundle recorded afterwards becomes
 * forgeable, and the forgery verifies — the signatures are genuine. This is a
 * strictly larger blast radius than the 2.0 enrollment key, whose reach stopped
 * at one course's roster; short `valid_until` windows are the only offline
 * mitigation, since an offline recorder cannot learn about revocation without a
 * network call (recorder PRD NG2).
 *
 * What it does NOT buy: signing a manifest (that needs the offline course key),
 * or reaching a second institution — `institution_id` is inside both signed
 * payloads and every verifier asserts credential, cert, and root-verified
 * anchor all agree. Recovery is to sign a fresh `institution_cert` for a new
 * key with the offline root key and rotate this variable.
 *
 * ## Handling rules, which the code below enforces
 *
 *  - the private key is never logged, never put in an error, never serialized
 *    into an API response;
 *  - parse failures name the offending FIELD, never a value;
 *  - the key is not trusted to be the right one: a minted credential is
 *    verified against `cert.institution_pubkey` before it is stored or returned
 *    (see `services/enrollment/mint-credential.ts`), so a stale or mismatched
 *    secret fails loudly instead of issuing credentials nothing can verify.
 */

import { parseInstitutionCert, INSTITUTION_IDENTITY_FORMAT_VERSION } from '@provenance/log-core';
import type { InstitutionCert } from '@provenance/log-core';
import { getConfig } from './index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstitutionKeyMaterial = {
  /**
   * The institution this key speaks for, read off the ROOT-SIGNED certificate
   * rather than configured separately — so it cannot name an institution the
   * root key did not authorize this key for.
   */
  institution_id: string;
  /** The root-signed authorization for this key. Public; travels in bundles. */
  cert: InstitutionCert;
  /**
   * The institution private key, 64 lowercase hex.
   *
   * NEVER log this, never include it in an error, never return it over HTTP.
   * The only legitimate consumer is `signStudentCredential`.
   */
  private_key_hex: string;
};

export type InstitutionKeyError = {
  /** Names the offending field. Never contains a configured value. */
  reason: string;
};

export type InstitutionKeyResult =
  | { ok: true; value: InstitutionKeyMaterial | undefined }
  | { ok: false; error: InstitutionKeyError };

const HEX_64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the raw `PROVENANCE_INSTITUTION_KEY` value.
 *
 * Pure: no filesystem, no clock, no crypto. Every error path is written so that
 * `JSON.stringify(error)` cannot contain a configured secret — the tests assert
 * exactly that, because a config error surfaces on stderr during a failed boot
 * where it is likely to be pasted into a chat window.
 *
 * An EMPTY object is `{ ok: true, value: undefined }`, not an error: "this
 * deployment issues no student credentials" is a legitimate state and the env
 * schema defaults the variable to `{}` when unset.
 */
export function parseInstitutionKey(raw: string): InstitutionKeyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: { reason: 'not valid JSON' } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: { reason: 'must be a JSON object' } };
  }

  const obj = parsed as Record<string, unknown>;

  // Unset / `{}` — no institution key configured.
  if (Object.keys(obj).length === 0) return { ok: true, value: undefined };

  const privateKeyHex = obj['private_key_hex'];
  if (typeof privateKeyHex !== 'string' || !HEX_64_RE.test(privateKeyHex)) {
    return {
      ok: false,
      error: { reason: 'private_key_hex must be 64 lowercase hex characters' },
    };
  }

  // Version gate before shape, mirroring verifyIdentityChain step 0 and
  // enrollment-keys.ts: a future 3.0 certificate must be refused outright, not
  // read under 2.1 rules. Routing on the SIGNED version rather than on which
  // fields happen to be present is the rule institution.ts spells out — a
  // present-field heuristic is attacker-controlled and ambiguous.
  const declaredVersion = (obj['cert'] as Partial<InstitutionCert> | undefined)?.format_version;
  if (declaredVersion !== INSTITUTION_IDENTITY_FORMAT_VERSION) {
    return {
      ok: false,
      error: {
        reason: `cert.format_version must be "${INSTITUTION_IDENTITY_FORMAT_VERSION}"`,
      },
    };
  }

  const cert = parseInstitutionCert(obj['cert']);
  if (!cert.ok) {
    const field = cert.error.kind === 'invalid_shape' ? cert.error.field : undefined;
    return {
      ok: false,
      error: {
        reason:
          field !== undefined
            ? `cert.${field} is invalid`
            : `cert is not a valid ${INSTITUTION_IDENTITY_FORMAT_VERSION} institution cert`,
      },
    };
  }

  return {
    ok: true,
    value: {
      institution_id: cert.value.institution_id,
      cert: cert.value,
      private_key_hex: privateKeyHex,
    },
  };
}

// ---------------------------------------------------------------------------
// Cached lookup
// ---------------------------------------------------------------------------

let _cache: InstitutionKeyMaterial | undefined;
let _cachedRaw: string | undefined;
let _cacheLoaded = false;

/**
 * The institution key material, or `undefined` when this deployment issues no
 * student credentials.
 *
 * `undefined` is a legitimate state, so callers turn it into a 503 telling the
 * student credential issuance is not open, not a crash.
 *
 * A MALFORMED configuration is different and throws: silently behaving as if no
 * key were configured would turn an operator typo into "enrollment is closed",
 * which is exactly the failure a course would not notice until students
 * complained.
 */
export function institutionKey(): InstitutionKeyMaterial | undefined {
  const raw = getConfig().PROVENANCE_INSTITUTION_KEY;
  if (!_cacheLoaded || _cachedRaw !== raw) {
    const parsed = parseInstitutionKey(raw);
    if (!parsed.ok) {
      throw new Error(
        `Invalid PROVENANCE_INSTITUTION_KEY institution key configuration: ${parsed.error.reason}`,
      );
    }
    _cache = parsed.value;
    _cachedRaw = raw;
    _cacheLoaded = true;
  }
  return _cache;
}

/** Test-only: drop the memoised parse so a new config is picked up. */
export function _resetInstitutionKeyForTest(): void {
  _cache = undefined;
  _cachedRaw = undefined;
  _cacheLoaded = false;
}
