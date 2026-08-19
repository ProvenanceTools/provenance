/**
 * The root public key is the trust anchor for every `.provenance-manifest`/`provenance-manifest`
 * the recorder loads (PRD §4.1, program spec §2). A Manifest 2.0 file carries a
 * root-signed `course_cert` that authorizes the course key which signed the manifest
 * payload; a 1.x file has no chain and is verified against this key directly.
 *
 * Re-exported from a tiny sibling file so the production build (`npm run build:prod`)
 * can swap that file in place without touching anything else. See root-public-key.ts
 * and tools/embed-root-key.ts.
 */
export { ROOT_PUBLIC_KEY_HEX } from './root-public-key.js';
