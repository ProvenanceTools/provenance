/**
 * Embed the ROOT public key (and, if supplied, the grandfathered legacy course
 * public key) into the recorder source so the built VSIX trusts both Manifest 2.0
 * chains and any Manifest 1.x files still in the field.
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §2, §9. Formerly `tools/embed-course-key.ts`: at Manifest 1.x, the recorder embedded
 * ONE course's public key directly, so a new course meant a new VSIX. At 2.0 the
 * recorder embeds the ROOT public key — one build serves every course, and a
 * course's authority comes from its root-signed `course_cert`, which travels inline
 * in the manifest instead (see `tools/mint-course-cert.ts`). There is now exactly
 * ONE production embedding to do, ever (per root-key rotation), not one per course
 * — plus, for as long as any 1.x manifest signed by the OLD course key needs to keep
 * verifying, one legacy course-key embedding (see legacy-course-public-key.ts for
 * its removal condition).
 *
 * USAGE
 *   PROVENANCE_ROOT_PUBLIC_KEY_HEX=<64-hex> \
 *   [PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX=<64-hex>] \
 *     node --experimental-strip-types tools/embed-root-key.ts
 *
 * PROVENANCE_ROOT_PUBLIC_KEY_HEX is required. PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX
 * is OPTIONAL: a deployment with no 1.x manifests left in the field can build without
 * it, leaving legacy-course-public-key.ts's dev key in place (harmless — it is only
 * ever consulted as the 1.x-path default, and there is no 1.x manifest in the field
 * for it to wrongly accept). Omitting it every release is also how the constant
 * eventually gets deleted for good.
 *
 * Typically invoked via `npm run build:prod --workspace packages/recorder`, which
 * runs this script, then `npm run build`, then `npm run package`, then restores the
 * source file(s) via `git checkout`.
 *
 * Behavior, per key:
 *   1. Reads the key's env var.
 *   2. Root: dies if missing, malformed (not 64 lowercase hex), or equal to the dev
 *      root key checked into the repo. Legacy course key: skipped entirely if unset;
 *      otherwise the same malformed/dev-key checks apply.
 *   3. Rewrites the recorder's embedded-key constant to the supplied value.
 *      Preserves the rest of the file verbatim.
 *
 * The script never logs a dev key in error messages. It does log production keys
 * (which are, by definition, public) for build-transparency confirmation.
 *
 * The rename to `ROOT_PUBLIC_KEY_HEX` / `root-public-key.ts` (program spec §2) has
 * landed, so the ROOT target and regex below point at the real constant, and the
 * legacy course key follows the identical single-file, single-constant shape. Both
 * constants are kept as single-line, single-quoted 64-hex literals specifically so
 * their regexes keep matching — do not reformat either across lines.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ACTIVATION_DIR = path.join(REPO_ROOT, 'packages/recorder/src/activation');

const HEX_64 = /^[0-9a-f]{64}$/;

// Dev keys hardcoded here so the script can refuse to "embed" either as a no-op.
// Must be kept in sync with .notes/dev-root-keypair.json and .notes/dev-keypair.json
// (the dev keys used for local builds and integration tests). If you rotate either
// dev key, update the matching constant here too.
const DEV_ROOT_PUBLIC_KEY_HEX = '80051f5bdb9064e0768bf2fca5cc9a4ee888502ab45472e0c6d0f4f704de4499';
const DEV_LEGACY_COURSE_PUBLIC_KEY_HEX =
  '46f91d5902c53816110b05ddedd2b8caa95b452d51e696f5327b52bf90bf4838';

type KeySpec = {
  /** Log/error prefix, e.g. "ROOT" or "legacy course". */
  label: string;
  envVar: string;
  /** Whether the env var must be set. False for the legacy course key. */
  required: boolean;
  devKeyHex: string;
  constantName: string;
  targetFile: string;
};

const ROOT_SPEC: KeySpec = {
  label: 'ROOT',
  envVar: 'PROVENANCE_ROOT_PUBLIC_KEY_HEX',
  required: true,
  devKeyHex: DEV_ROOT_PUBLIC_KEY_HEX,
  constantName: 'ROOT_PUBLIC_KEY_HEX',
  targetFile: path.join(ACTIVATION_DIR, 'root-public-key.ts'),
};

const LEGACY_COURSE_SPEC: KeySpec = {
  label: 'legacy course',
  envVar: 'PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX',
  required: false,
  devKeyHex: DEV_LEGACY_COURSE_PUBLIC_KEY_HEX,
  constantName: 'LEGACY_COURSE_PUBLIC_KEY_HEX',
  targetFile: path.join(ACTIVATION_DIR, 'legacy-course-public-key.ts'),
};

function die(message: string): never {
  process.stderr.write(`[embed-root-key] ${message}\n`);
  process.exit(1);
}

/** Embeds one key per `spec`. Returns the touched file's repo-relative path, or null if skipped. */
function embedOne(spec: KeySpec): string | null {
  const hex = process.env[spec.envVar];

  if (hex === undefined || hex === '') {
    if (spec.required) {
      die(
        `${spec.envVar} is not set.\n` +
          `Set it to the production ${spec.label} public key (64 lowercase hex chars) and re-run.`,
      );
    }
    process.stderr.write(
      `[embed-root-key] ${spec.envVar} not set — leaving the dev ${spec.label} key in ` +
        `${spec.targetFile} untouched. That is fine as long as no 1.x manifest in the ` +
        `field still needs to verify against the real ${spec.label} key.\n`,
    );
    return null;
  }

  if (!HEX_64.test(hex)) {
    die(
      `${spec.envVar} is malformed: expected 64 lowercase hex chars, got ${hex.length} chars.\n` +
        `The ${spec.label} keypair must be generated offline on a secured machine — see README ` +
        '"Course staff: key & manifest workflow".',
    );
  }
  if (hex === spec.devKeyHex) {
    die(
      `${spec.envVar} equals the dev ${spec.label} key checked into the repo.\n` +
        `Production builds must use the real, offline-generated ${spec.label} key.`,
    );
  }

  if (!fs.existsSync(spec.targetFile)) {
    die(`Target file not found: ${spec.targetFile}`);
  }

  const original = fs.readFileSync(spec.targetFile, 'utf8');

  // Replace the constant. The source file commits to a single-line definition for
  // exactly this reason; a regex over multi-line bodies would be fragile.
  const pattern = new RegExp(`(export const ${spec.constantName}\\s*=\\s*)['"][0-9a-f]{64}['"]`);
  if (!pattern.test(original)) {
    die(
      `Could not locate the embedded-key constant in ${spec.targetFile}.\n` +
        'The file shape may have drifted from what tools/embed-root-key.ts expects ' +
        '(the constant must stay a single-line 64-hex literal).\n' +
        'Either update the regex in this script or restore the file from git.',
    );
  }

  const rewritten = original.replace(pattern, `$1'${hex}'`);
  fs.writeFileSync(spec.targetFile, rewritten, 'utf8');

  process.stderr.write(
    `[embed-root-key] Embedded production ${spec.label} public key into:\n` +
      `  ${spec.targetFile}\n` +
      `[embed-root-key] Embedded key (public, hex): ${hex}\n`,
  );

  return path.relative(REPO_ROOT, spec.targetFile);
}

function main(): void {
  const touched: string[] = [];
  const rootTouched = embedOne(ROOT_SPEC);
  if (rootTouched !== null) touched.push(rootTouched);
  const legacyTouched = embedOne(LEGACY_COURSE_SPEC);
  if (legacyTouched !== null) touched.push(legacyTouched);

  if (touched.length > 0) {
    process.stderr.write(
      `[embed-root-key] Build the VSIX now; then \`git checkout ${touched.join(' ')}\`\n` +
        `[embed-root-key] to restore the dev key(s) for further local work.\n`,
    );
  }
}

main();
