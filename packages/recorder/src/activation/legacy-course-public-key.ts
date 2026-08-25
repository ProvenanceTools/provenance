/**
 * The LEGACY course public key, hex-encoded ed25519 (32 bytes => 64 hex chars).
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md` §2, §9.
 *
 * Manifest 2.0 moved the recorder's trust anchor to a single embedded ROOT key
 * (see root-public-key.ts): a course's authority now comes from its root-signed
 * `course_cert`, not from a course-specific VSIX build. But every Manifest 1.x
 * file already in the field was signed directly by a course's OLD signing key,
 * with no cert and no chain — verifying those against the root key fails closed,
 * which means silent non-activation for every unreissued 1.x manifest.
 *
 * This constant grandfathers that one key back in so 1.x manifests keep working
 * (manifest-loader.ts routes 1.x verification here, 2.0 verification stays on
 * ROOT_PUBLIC_KEY_HEX). It is a SECOND permanent trust anchor only until every
 * course has re-issued its manifests as 2.0 — which is exactly what the root-key
 * hierarchy exists to make unnecessary.
 *
 * **Scheduled for removal.** Once program spec §9's migration has completed for
 * every course with manifests still active in the field (no 1.x manifest anyone
 * still needs to verify remains unreissued as 2.0), delete this file, its
 * `course-keys.ts` re-export, the 1.x-routing branch in manifest-loader.ts that
 * reads it, and the corresponding embedding step in tools/embed-root-key.ts.
 *
 * The constant below is the DEV course keypair from .notes/dev-keypair.json; that's
 * what the recorder uses during local development and integration tests. To produce
 * a production VSIX with the real legacy course public key, run:
 *
 *   PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX=<hex> npm run build:prod --workspace packages/recorder
 *
 * (Omit the var entirely once no 1.x manifests remain in the field — see above.)
 *
 * `build:prod` invokes tools/embed-root-key.ts to overwrite the constant below
 * before building and packaging, then `git checkout`'s this file to restore the dev
 * key for further local work. See tools/embed-root-key.ts for the contract this file
 * must honor: a single-line constant definition, this exact constant name, and a
 * quoted 64-char lowercase hex literal.
 */
export const LEGACY_COURSE_PUBLIC_KEY_HEX =
  '46f91d5902c53816110b05ddedd2b8caa95b452d51e696f5327b52bf90bf4838';
