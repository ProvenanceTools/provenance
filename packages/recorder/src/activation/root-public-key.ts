/**
 * The Provenance ROOT public key, hex-encoded ed25519 (32 bytes => 64 hex chars).
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md` §2.
 *
 * At Manifest 1.x the recorder embedded ONE course's signing key, so every course
 * needed its own VSIX. At Manifest 2.0 it embeds the ROOT key only: a course's
 * authority comes from its root-signed `course_cert`, which travels inline in the
 * `.provenance-manifest`. One build serves every course.
 *
 * The constant below is the DEV root key from .notes/dev-root-keypair.json; that's
 * what the recorder uses during local development and integration tests. To produce
 * a production VSIX with the real root public key, run:
 *
 *   PROVENANCE_ROOT_PUBLIC_KEY_HEX=<hex> npm run build:prod --workspace packages/recorder
 *
 * `build:prod` invokes tools/embed-root-key.ts to overwrite the constant below
 * before building and packaging, then `git checkout`'s this file to restore the dev
 * key for further local work. See tools/embed-root-key.ts for the contract this file
 * must honor: a single-line constant definition, this exact constant name, and a
 * quoted 64-char lowercase hex literal.
 */
export const ROOT_PUBLIC_KEY_HEX =
  '80051f5bdb9064e0768bf2fca5cc9a4ee888502ab45472e0c6d0f4f704de4499';
