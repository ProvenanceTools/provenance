/**
 * The Manifest 2.0 ROOT public key, as seen by the browser.
 *
 * Program spec §2: the root key anchors the trust chain
 * (root → `course_cert` → manifest → session). `analysis-core` never hardcodes
 * it — it is isomorphic and must stay pure — so the browser has to supply it,
 * the same way the server supplies `PROVENANCE_ROOT_PUBLIC_KEY_HEX`.
 *
 * It is a PUBLIC key, so baking it into the client bundle at build time is
 * exactly right; there is nothing here to keep secret. Unset is a legitimate
 * state: the `/local` route then reports validation check 2 as `skipped` for a
 * 2.0 bundle rather than guessing, and 1.0/1.1 bundles never consult it.
 *
 * Reads the same `import.meta.env` shape as `getBaseUrl()` in `api/client.ts`.
 */

export function getRootPublicKeyHex(): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Vite injects import.meta.env at build time; type is `any` via Vite's glob typing
  const env = (typeof import.meta !== 'undefined' ? (import.meta as any).env : {}) as Record<
    string,
    string | undefined
  >;
  const hex = env['VITE_ROOT_PUBLIC_KEY_HEX'];
  return hex === undefined || hex.length === 0 ? undefined : hex;
}

/** Validation options carrying the root key, for `runValidation`. */
export function localValidationOptions(): { rootPubkeyHex?: string } {
  const hex = getRootPublicKeyHex();
  return hex === undefined ? {} : { rootPubkeyHex: hex };
}
