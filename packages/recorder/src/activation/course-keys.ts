/**
 * The two verification anchors for every `.provenance-manifest`/`provenance-manifest`
 * the recorder loads (PRD §4.1, program spec §2, §9).
 *
 * - `ROOT_PUBLIC_KEY_HEX` — a Manifest 2.0 file carries a root-signed `course_cert`
 *   that authorizes the course key which signed the manifest payload; 2.0
 *   verification chains to this key.
 * - `LEGACY_COURSE_PUBLIC_KEY_HEX` — a 1.x file predates the trust chain and has no
 *   cert; it is verified against this grandfathered key directly. Scheduled for
 *   removal once every course has re-issued its manifests as 2.0 — see
 *   legacy-course-public-key.ts.
 *
 * Both are re-exported from tiny sibling files so the production build
 * (`npm run build:prod`) can swap either in place without touching anything else.
 * See root-public-key.ts, legacy-course-public-key.ts, and tools/embed-root-key.ts.
 */
export { ROOT_PUBLIC_KEY_HEX } from './root-public-key.js';
export { LEGACY_COURSE_PUBLIC_KEY_HEX } from './legacy-course-public-key.js';
