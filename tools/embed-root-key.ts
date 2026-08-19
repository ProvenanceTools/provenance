/**
 * Embed the ROOT public key into the recorder source so that the built VSIX
 * trusts manifests from any course whose key the root has certified.
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §2. Formerly `tools/embed-course-key.ts`: at Manifest 1.x, the recorder embedded
 * ONE course's public key directly, so a new course meant a new VSIX. At 2.0 the
 * recorder embeds the ROOT public key only — one build serves every course, and a
 * course's authority comes from its root-signed `course_cert`, which travels inline
 * in the manifest instead (see `tools/mint-course-cert.ts`). There is now exactly
 * ONE production embedding to do, ever (per root-key rotation), not one per course.
 *
 * USAGE
 *   PROVENANCE_ROOT_PUBLIC_KEY_HEX=<64-hex> node --experimental-strip-types tools/embed-root-key.ts
 *
 * Typically invoked via `npm run build:prod --workspace packages/recorder`, which
 * runs this script, then `npm run build`, then `npm run package`, then restores the
 * source file via `git checkout`.
 *
 * Behavior:
 *   1. Reads PROVENANCE_ROOT_PUBLIC_KEY_HEX from the environment.
 *   2. Refuses to run if the env var is missing, malformed (not 64 lowercase hex),
 *      or equal to the dev root key checked into the repo (so a misconfigured
 *      release can never silently ship the dev key).
 *   3. Rewrites the recorder's embedded-key constant to the supplied value.
 *      Preserves the rest of the file verbatim.
 *
 * The script never logs the dev key in error messages. It does log the production
 * key (which is, by definition, public) for build-transparency confirmation.
 *
 * KNOWN INTERIM STATE: as of this tool's rework, the recorder source constant this
 * script rewrites is still named `COURSE_PUBLIC_KEY_HEX`, in
 * `packages/recorder/src/activation/course-public-key.ts` — renaming that constant
 * (and the file) to `ROOT_PUBLIC_KEY_HEX` / `root-public-key.ts` per program spec §2
 * is a `packages/recorder/src` change and out of this tool's scope (see repo
 * CLAUDE.md: `tools/` may not reach into recorder `src`). Update TARGET and the
 * regex below to match once that rename lands.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TARGET = path.join(REPO_ROOT, 'packages/recorder/src/activation/course-public-key.ts');

const HEX_64 = /^[0-9a-f]{64}$/;

// Dev ROOT key hardcoded here so the script can refuse to "embed" it as a no-op.
// Must be kept in sync with .notes/dev-root-keypair.json (the dev root key used for
// local builds and integration tests). If you rotate the dev root key, update this
// constant too.
const DEV_ROOT_PUBLIC_KEY_HEX = '80051f5bdb9064e0768bf2fca5cc9a4ee888502ab45472e0c6d0f4f704de4499';

function die(message: string): never {
  process.stderr.write(`[embed-root-key] ${message}\n`);
  process.exit(1);
}

function main(): void {
  const hex = process.env['PROVENANCE_ROOT_PUBLIC_KEY_HEX'];
  if (hex === undefined || hex === '') {
    die(
      'PROVENANCE_ROOT_PUBLIC_KEY_HEX is not set.\n' +
        'Set it to the production ROOT public key (64 lowercase hex chars) and re-run.',
    );
  }
  if (!HEX_64.test(hex)) {
    die(
      `PROVENANCE_ROOT_PUBLIC_KEY_HEX is malformed: expected 64 lowercase hex chars, got ${hex.length} chars.\n` +
        'The root keypair must be generated offline on a secured machine — see README ' +
        '"Course staff: key & manifest workflow".',
    );
  }
  if (hex === DEV_ROOT_PUBLIC_KEY_HEX) {
    die(
      'PROVENANCE_ROOT_PUBLIC_KEY_HEX equals the dev root key checked into the repo.\n' +
        'Production builds must use the real, offline-generated root key.',
    );
  }

  if (!fs.existsSync(TARGET)) {
    die(`Target file not found: ${TARGET}`);
  }

  const original = fs.readFileSync(TARGET, 'utf8');

  // Replace the constant. The source file commits to a single-line definition for
  // exactly this reason; a regex over multi-line bodies would be fragile.
  const pattern = /(export const COURSE_PUBLIC_KEY_HEX\s*=\s*)['"][0-9a-f]{64}['"]/;
  if (!pattern.test(original)) {
    die(
      `Could not locate the embedded-key constant in ${TARGET}.\n` +
        'The file shape may have drifted from what tools/embed-root-key.ts expects ' +
        '(see this file\'s "KNOWN INTERIM STATE" docstring note).\n' +
        'Either update the regex in this script or restore the file from git.',
    );
  }

  const rewritten = original.replace(pattern, `$1'${hex}'`);

  fs.writeFileSync(TARGET, rewritten, 'utf8');

  process.stderr.write(
    `[embed-root-key] Embedded production ROOT public key into:\n` +
      `  ${TARGET}\n` +
      `[embed-root-key] Embedded key (public, hex): ${hex}\n` +
      `[embed-root-key] Build the VSIX now; then \`git checkout ${path.relative(REPO_ROOT, TARGET)}\`\n` +
      `[embed-root-key] to restore the dev key for further local work.\n`,
  );
}

main();
