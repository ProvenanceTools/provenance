/**
 * The Manifest 2.0 ROOT public key, as seen by server code.
 *
 * Program spec §2: the root key is the anchor of the trust chain
 * (root → `course_cert` → manifest → session). `analysis-core` never hardcodes
 * it — it is isomorphic and must stay pure — so every caller that verifies a
 * chain has to supply it. On the server it comes from
 * `PROVENANCE_ROOT_PUBLIC_KEY_HEX`.
 *
 * Not configured is a legitimate state, not an error: 1.0/1.1 bundles carry no
 * chain at all, and a deployment that has not yet issued a root key should get
 * a `skipped` check 2 rather than a crash or a false `pass`.
 */

import { getConfig } from './index.js';
import type { ValidationOptions } from '@provenance/analysis-core/validation/run-validation.js';

/** The configured root public key, or `undefined` when none is set. */
export function rootPublicKeyHex(): string | undefined {
  const hex = getConfig().PROVENANCE_ROOT_PUBLIC_KEY_HEX;
  return hex.length === 0 ? undefined : hex;
}

/**
 * Validation options carrying the root key, for `runValidation` /
 * `runAndStoreValidation`.
 */
export function configuredValidationOptions(): ValidationOptions {
  const hex = rootPublicKeyHex();
  return hex === undefined ? {} : { rootPubkeyHex: hex };
}
