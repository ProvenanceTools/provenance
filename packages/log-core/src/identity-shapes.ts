/**
 * Shape-validation and window primitives shared by the two identity families.
 *
 * INTERNAL to log-core — deliberately NOT re-exported from `index.ts`. It exists
 * because `enrollment.ts` (the legacy course-scoped chain) and `institution.ts`
 * (the institution-scoped chain that replaces it) must validate their artifacts
 * with byte-identical rules. Two copies of "is this an ISO 8601 bound" is exactly
 * how two ports of the same rule drift apart, and this repo is the reference
 * implementation three recorders are held against.
 *
 * Nothing here does signature work. Everything here runs BEFORE signature work,
 * for the reason spelled out in both callers: `canonicalize` OMITS keys whose
 * value is `undefined`, so an artifact missing a required field would otherwise
 * sign and verify perfectly while carrying nothing at that field.
 */

import { ok, err } from './result.js';
import type { Result } from './result.js';
import { parseIsoInstantMs, resolveValidUntilExclusiveMs } from './course-cert.js';
import type { CertWindowStatus } from './course-cert.js';

/** 64-byte ed25519 signature, lowercase hex. */
export const HEX_128_RE = /^[0-9a-f]{128}$/;
/** 32-byte ed25519 public key or seed, lowercase hex. */
export const HEX_64_RE = /^[0-9a-f]{64}$/;

/**
 * The one shape-failure value both identity families report. Kept structurally
 * identical to the `invalid_shape` member of `EnrollmentError` so it is directly
 * assignable into either family's error union.
 */
export type IdentityShapeError = { kind: 'invalid_shape'; field?: string; reason?: string };

/**
 * Validate a required non-empty string field.
 *
 * A missing key and an `undefined`-valued key are treated identically —
 * `canonicalize` erases the difference, so nothing downstream may rely on it.
 */
export function requireString(
  obj: Record<string, unknown>,
  field: string,
): Result<string, IdentityShapeError> {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    return err({ kind: 'invalid_shape', field, reason: 'must be a non-empty string' });
  }
  return ok(value);
}

/** Validate a required lowercase-hex field of an exact length. */
export function requireHex(
  obj: Record<string, unknown>,
  field: string,
  re: RegExp,
  chars: number,
): Result<string, IdentityShapeError> {
  const value = obj[field];
  if (typeof value !== 'string' || !re.test(value)) {
    return err({ kind: 'invalid_shape', field, reason: `must be a ${chars}-char hex string` });
  }
  return ok(value);
}

/**
 * Validate an ordered pair of ISO 8601 bounds.
 *
 * Both bounds MUST parse. Short validity windows are the only offline mitigation
 * either identity scheme has for the absence of revocation, so a bound that
 * silently never binds would undercut the sole control there is. These artifacts
 * are new, so unlike `manifest.issued_at` there is no archived-data
 * compatibility cost to enforcing it.
 */
export function requireOrderedBounds(
  obj: Record<string, unknown>,
  lowerField: string,
  upperField: string,
): Result<{ lower: string; upper: string }, IdentityShapeError> {
  const parsed: Record<string, number> = {};
  for (const field of [lowerField, upperField]) {
    const asString = requireString(obj, field);
    if (!asString.ok) return asString;
    const ms = parseIsoInstantMs(asString.value);
    if (ms === null) {
      return err({ kind: 'invalid_shape', field, reason: 'must be an ISO 8601 date or timestamp' });
    }
    parsed[field] = ms;
  }
  if ((parsed[lowerField] as number) > (parsed[upperField] as number)) {
    return err({
      kind: 'invalid_shape',
      field: upperField,
      reason: `must not be earlier than ${lowerField}`,
    });
  }
  return ok({
    lower: obj[lowerField] as string,
    upper: obj[upperField] as string,
  });
}

/**
 * Shared window arithmetic: is `at` inside `[lower, upper]`?
 *
 * `lower` is inclusive from its first instant; a date-only `upper` is inclusive
 * through the END of that day, via `resolveValidUntilExclusiveMs`. Identical
 * semantics to `checkCertWindow`, so a port implements the rule once.
 *
 * `at` is always a RELEVANT ISSUE TIME, never wall-clock now — see the callers.
 */
export function checkWindow(lower: string, upper: string, at: string): CertWindowStatus {
  const from = parseIsoInstantMs(lower);
  const untilExclusive = resolveValidUntilExclusiveMs(upper);
  const instant = parseIsoInstantMs(at);

  if (from === null || untilExclusive === null || instant === null) {
    return { in_window: false, reason: 'unparseable_timestamp' };
  }
  if (instant < from) return { in_window: false, reason: 'before_valid_from' };
  if (instant >= untilExclusive) return { in_window: false, reason: 'after_valid_until' };
  return { in_window: true };
}
