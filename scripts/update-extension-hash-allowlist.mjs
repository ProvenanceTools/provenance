#!/usr/bin/env node
/**
 * Update the analyzer's known-good extension-hash allowlist.
 *
 *   packages/analysis-core/src/heuristics/config/known-good-extension-hashes.json
 *
 * The allowlist is consulted by the `extension_hash_mismatch` heuristic. Any
 * bundle whose `manifest.extension_hash` is NOT in the list gets flagged.
 *
 * Under the Manifest 2.0 root-key trust hierarchy (see
 * `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md` §2, §9),
 * the recorder embeds ONE root public key that serves every course — a course's
 * authority comes from its root-signed `course_cert`, not from a key baked into
 * the VSIX. There is therefore exactly ONE production build (and one hash) per
 * ROOT-key rotation, not one per course. `tools/embed-root-key.ts` also embeds an
 * OPTIONAL grandfathered `LEGACY_COURSE_PUBLIC_KEY_HEX`, needed only while
 * Manifest 1.x files signed by the old single course key are still in the field.
 *
 * IMPORTANT: this script's *build* modes (--root-keypair / --no-build / bare run)
 * only automate the VS Code recorder — they produce the hash that an installed
 * VSIX reports at seal time, i.e. the hash over the **bundled** `dist/` (single
 * `extension.js` + sourcemap), NOT the hash of a `tsc`-emitted dev-install
 * `dist/` (many .js / .d.ts files). Those are structurally different and a
 * dev-install hash will never appear in a real student submission. Prior
 * versions of this script hashed the tsc output by mistake.
 *
 * IMPORTANT — legacy key changes the hash: the extension_hash covers the built
 * `dist/` file tree byte-for-byte, and `PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX`
 * (when set) gets embedded into that tree by `tools/embed-root-key.ts` alongside
 * the root key. A build WITH the legacy key embedded therefore produces a
 * DIFFERENT hash than an otherwise-identical build WITHOUT it. This script does
 * not try to reconcile the two — it builds exactly once per invocation, using
 * whatever `PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX` happens to be set to in the
 * environment (or unset), and computes the hash from that build's actual `dist/`
 * output. That is the only correct approach: the recorded hash always matches
 * what the VSIX you are about to ship will actually report, because it's hashed
 * from that exact `dist/`, not derived from the env vars. If you ship two VSIX
 * variants (with and without 1.x support), run this script once per variant and
 * both hashes will land in the allowlist.
 *
 * The JetBrains recorder is a separate repo with its own JVM/Gradle toolchain
 * (this monorepo has none), so its hash is NOT built here. Compute it there with
 * `./gradlew :recorder:computeExtensionHash` (or `:recorder:buildProd` for a
 * release) and add the value via `--hash <hex>` below. Both producers hash the
 * same thing — a SHA-256 over the installed distribution file tree — so a
 * JetBrains hash is a first-class allowlist entry, just sourced manually.
 *
 * Same story for the Neovim recorder (provnvim): it's a separate repo, and
 * for a Neovim plugin the installed `lua/` source tree IS the distribution
 * (no build step). Its hash is computed in that repo via the recorder's
 * `compute_installed()` and added here the same way, via `--hash <hex>`.
 *
 * USAGE
 *   # Bundle with the current source key (dev key when nothing is overridden)
 *   # and add that hash. Useful for local dev only — emits a warning that the
 *   # hash won't match any production release.
 *   node scripts/update-extension-hash-allowlist.mjs
 *
 *   # Production: read public_key_hex from a root keypair JSON (same shape
 *   # tools/generate-course-keypair.ts writes — see .notes/dev-root-keypair.json
 *   # for the dev fixture) and run the full build:prod pipeline (embed key →
 *   # bundle → package). This produces the actual VSIX hash that students will
 *   # report. A .vsix is left at packages/recorder/provenance-recorder-<version>.vsix
 *   # as a side effect.
 *   node scripts/update-extension-hash-allowlist.mjs --root-keypair /path/to/root-keypair.json
 *
 *   # Same as --root-keypair but reads the public key hex directly. Equivalent
 *   # to exporting PROVENANCE_ROOT_PUBLIC_KEY_HEX yourself.
 *   PROVENANCE_ROOT_PUBLIC_KEY_HEX=<64-hex> node scripts/update-extension-hash-allowlist.mjs
 *
 *   # If this build must also activate against Manifest 1.x files still in the
 *   # field, additionally set the legacy course key (read directly from the
 *   # environment — there is no --legacy-keypair flag, since it's optional and
 *   # rarely rotated independently of a specific course's own keypair file).
 *   # Remember: this changes the resulting hash (see IMPORTANT note above).
 *   PROVENANCE_ROOT_PUBLIC_KEY_HEX=<64-hex> \
 *   PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX=<64-hex> \
 *     node scripts/update-extension-hash-allowlist.mjs
 *
 *   # Skip the rebuild — hash whatever is currently in packages/recorder/dist.
 *   # Useful if you already ran `npm run build:prod` separately.
 *   node scripts/update-extension-hash-allowlist.mjs --no-build
 *
 *   # Add / remove / inspect specific entries.
 *   node scripts/update-extension-hash-allowlist.mjs --hash <hex>
 *   node scripts/update-extension-hash-allowlist.mjs --remove <hex>
 *   node scripts/update-extension-hash-allowlist.mjs --clear
 *   node scripts/update-extension-hash-allowlist.mjs --show
 *   node scripts/update-extension-hash-allowlist.mjs --help
 *
 * The placeholder sentinel
 *   "PLACEHOLDER_EXTENSION_HASH_REPLACE_BEFORE_DEPLOYMENT_..."
 * is stripped automatically the first time a real hash lands in the list.
 *
 * After every write, the script prints the resulting list with +/- markers.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = resolve(
  REPO_ROOT,
  'packages/analysis-core/src/heuristics/config/known-good-extension-hashes.json',
);
const RECORDER_DIST = resolve(REPO_ROOT, 'packages/recorder/dist');
const PLACEHOLDER_PREFIX = 'PLACEHOLDER_EXTENSION_HASH';

const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    mode: 'add-from-dist',
    build: true,
    hash: null,
    rootKeypairPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.mode = 'help';
    else if (a === '--show') opts.mode = 'show';
    else if (a === '--clear') opts.mode = 'clear';
    else if (a === '--no-build') opts.build = false;
    else if (a === '--hash') {
      opts.mode = 'add-literal';
      opts.hash = argv[++i];
    } else if (a === '--remove') {
      opts.mode = 'remove';
      opts.hash = argv[++i];
    } else if (a === '--root-keypair') {
      opts.rootKeypairPath = argv[++i];
    } else {
      console.error(`Unknown argument: ${a}`);
      opts.mode = 'help';
      break;
    }
  }
  return opts;
}

function usage() {
  console.log(`Usage: node scripts/update-extension-hash-allowlist.mjs [options]

Default action: bundle packages/recorder via esbuild (the same path that
produces the VSIX), compute its extension_hash, and add it to the analyzer's
known-good list (stripping the placeholder).

Under the Manifest 2.0 root-key trust hierarchy, one VSIX build serves every
course, so there is one production hash per ROOT-key rotation — not one per
course. See docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md
§2, §9.

Options:
  --root-keypair <path>
                     Read public_key_hex from a root keypair JSON file (the
                     same shape tools/generate-course-keypair.ts writes; see
                     .notes/dev-root-keypair.json for the dev fixture) and
                     run the full build:prod pipeline (embed key, bundle,
                     package VSIX). Produces the hash a real installed VSIX
                     will report. Leaves a .vsix in packages/recorder/.
  --no-build         Use existing packages/recorder/dist (no rebuild). Must
                     be a bundled dist (run 'npm run bundle' or
                     'npm run build:prod' first).
  --hash <hex>       Add a specific 64-char lowercase hex hash (no dist read).
  --remove <hex>     Remove a specific hash from the allowlist.
  --clear            Remove all entries.
  --show             Print the current allowlist and exit.
  --help, -h         Show this help.

Env vars:
  PROVENANCE_ROOT_PUBLIC_KEY_HEX
                     64-char lowercase hex root public key. When set (and
                     --root-keypair isn't given), triggers the full
                     build:prod pipeline just like --root-keypair.
  PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX
                     Optional 64-char lowercase hex legacy course public key.
                     Only consulted when a production build is happening
                     (--root-keypair given, or PROVENANCE_ROOT_PUBLIC_KEY_HEX
                     set). When set, it is passed through to build:prod so
                     the built VSIX also activates against Manifest 1.x
                     files. IMPORTANT: this changes the resulting
                     extension_hash — a build with the legacy key embedded is
                     byte-for-byte different from one without. This script
                     always hashes the dist/ the build actually produced, so
                     the recorded hash is correct for whichever variant you
                     just built; it does not compute both. Ship both variants
                     by running this script twice, once with the var set and
                     once without.

Allowlist file: ${ALLOWLIST_PATH}`);
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

async function readAllowlist() {
  const raw = await readFile(ALLOWLIST_PATH, 'utf8');
  const obj = JSON.parse(raw);
  if (!Array.isArray(obj.hashes)) {
    throw new Error(`Malformed allowlist: 'hashes' is not an array`);
  }
  return obj;
}

async function writeAllowlist(obj) {
  // Preserve top-level field order to keep the diff clean.
  const out = {
    $schema: obj.$schema ?? 'https://json-schema.org/draft/2020-12/schema',
    $id: obj.$id ?? 'known-good-extension-hashes',
    description: obj.description,
    hashes: obj.hashes,
  };
  await writeFile(ALLOWLIST_PATH, JSON.stringify(out, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function isPlaceholder(s) {
  return typeof s === 'string' && s.startsWith(PLACEHOLDER_PREFIX);
}

function stripPlaceholders(hashes) {
  return hashes.filter((h) => !isPlaceholder(h));
}

function dedup(hashes) {
  return Array.from(new Set(hashes));
}

function validateHash(h) {
  if (!HEX64.test(h)) {
    throw new Error(`Invalid hash '${h}'. Expected 64-char lowercase hex (got ${h.length} chars).`);
  }
}

/**
 * Load `public_key_hex` from a root keypair JSON file (the same shape
 * `tools/generate-course-keypair.ts` writes — see `.notes/dev-root-keypair.json`
 * for the dev fixture; the maintainer's real root keypair follows the same
 * shape, generated offline per README "Course staff: key & manifest workflow").
 */
async function loadRootKeypairPubkey(jsonPath) {
  let raw;
  try {
    raw = await readFile(jsonPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read keypair file ${jsonPath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Keypair file ${jsonPath} is not valid JSON: ${err.message}`);
  }
  const hex = parsed?.public_key_hex;
  if (typeof hex !== 'string') {
    throw new Error(`Keypair file ${jsonPath} has no string 'public_key_hex' field.`);
  }
  if (!HEX64.test(hex)) {
    throw new Error(
      `Keypair file ${jsonPath} has malformed 'public_key_hex' ` +
        `(expected 64 lowercase hex chars, got ${hex.length}).`,
    );
  }
  return hex;
}

/**
 * Read and validate PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX from the current
 * environment, if set. Returns null when unset (no 1.x-manifest support in
 * this build). There is no CLI flag for this — it's optional, rarely rotated
 * on its own, and only meaningful alongside a production root-key build, so
 * reading it straight from the env (same as `tools/embed-root-key.ts` does)
 * keeps the two scripts' inputs identical.
 */
function resolveLegacyCourseKeyHex() {
  const hex = process.env['PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX'];
  if (!hex) return null;
  if (!HEX64.test(hex)) {
    throw new Error(
      `PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX is malformed ` +
        `(expected 64 lowercase hex, got ${hex.length} chars).`,
    );
  }
  return hex;
}

/**
 * Bundle the recorder with a production root public key embedded (and,
 * optionally, the legacy course public key for 1.x-manifest support). Runs
 * `npm run build:prod --workspace=packages/recorder` with
 * PROVENANCE_ROOT_PUBLIC_KEY_HEX (and PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX,
 * if supplied) in the environment. That script handles embed → bundle →
 * package → git restore, leaving a fresh VSIX in packages/recorder/ and a
 * bundled dist in packages/recorder/dist/.
 *
 * IMPORTANT: whether `legacyPubkeyHex` is set or not changes the bytes in
 * dist/, and therefore changes extension_hash. This function does not try to
 * normalize that away — it builds exactly the variant requested, and the
 * caller hashes whatever dist/ this produces. See the file-header comment
 * for the full reasoning.
 */
function buildRecorderProd(rootPubkeyHex, legacyPubkeyHex) {
  console.log(
    `Building recorder with production root public key ${rootPubkeyHex.slice(0, 16)}… ...`,
  );
  if (legacyPubkeyHex) {
    console.log(
      '[update-hashes] Also embedding PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX — this VSIX ' +
        'will activate against Manifest 1.x files. NOTE: this makes the resulting ' +
        'extension_hash different from a build without the legacy key. The hash recorded ' +
        'below is correct for THIS build only.',
    );
  } else {
    console.log(
      '[update-hashes] PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX is not set — this VSIX will ' +
        'NOT activate against Manifest 1.x files (Manifest 2.0 only).',
    );
  }
  const env = { ...process.env, PROVENANCE_ROOT_PUBLIC_KEY_HEX: rootPubkeyHex };
  if (legacyPubkeyHex) {
    env.PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX = legacyPubkeyHex;
  }
  const r = spawnSync('npm', ['run', 'build:prod', '--workspace=packages/recorder'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env,
  });
  if (r.status !== 0) {
    throw new Error(`recorder build:prod failed (exit ${r.status})`);
  }
}

/**
 * Bundle the recorder with whatever key is currently in source (dev key
 * unless someone manually edited course-public-key.ts). Produces the same
 * bundled dist shape as build:prod but does NOT package a VSIX or touch
 * the source file.
 *
 * Use this path for local-dev convenience only. The resulting hash will
 * NOT match any released VSIX and is only useful for analyzer tests that
 * exercise dev bundles.
 */
function bundleRecorderDev() {
  console.warn(
    '[update-hashes] WARNING: bundling with the dev root key (no --root-keypair or ' +
      'PROVENANCE_ROOT_PUBLIC_KEY_HEX set).',
  );
  console.warn('[update-hashes]   The resulting hash will NOT match any production VSIX.');
  console.warn(
    '[update-hashes]   Use --root-keypair <path> or set PROVENANCE_ROOT_PUBLIC_KEY_HEX ' +
      'to record a release hash.',
  );
  console.log('Bundling packages/recorder/dist (dev key) ...');
  const r = spawnSync('npm', ['run', 'bundle', '--workspace=packages/recorder'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(`recorder bundle failed (exit ${r.status})`);
  }
}

/**
 * Recursively collect every regular file under `dir`, returning absolute paths.
 * Mirrors `collectFiles` in packages/recorder/src/commands/extension-hash.ts.
 */
async function collectFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectFiles(p)));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Compute the recorder's extension_hash from a dist/ directory.
 *
 * Algorithm (kept in lockstep with computeExtensionHash in
 * packages/recorder/src/commands/extension-hash.ts):
 *
 *   sha256(
 *     for each file in dist/ (sorted by relative path, locale-compare):
 *       relative-path-bytes (utf8)
 *       || 0x00
 *       || file-content-bytes
 *   )
 *
 * If you change this, change the recorder too — and audit existing hashes in
 * the allowlist, since they're algorithm-dependent.
 */
async function computeExtensionHash(distPath) {
  const absolutePaths = await collectFiles(distPath);
  if (absolutePaths.length === 0) {
    throw new Error(
      `No files found under ${distPath}. The recorder hasn't been built. ` +
        `Run without --no-build, or run 'npm run bundle --workspace=packages/recorder' first.`,
    );
  }

  const rels = absolutePaths.map((abs) => ({ abs, rel: relative(distPath, abs) }));
  rels.sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = createHash('sha256');
  for (const { abs, rel } of rels) {
    const bytes = await readFile(abs);
    hash.update(Buffer.from(rel, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function printList(label, hashes) {
  console.log(`${label}:`);
  if (hashes.length === 0) {
    console.log('  (empty)');
  } else {
    for (const h of hashes) {
      const tag = isPlaceholder(h) ? ' [placeholder]' : '';
      console.log(`  ${h}${tag}`);
    }
  }
}

function printDiff(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((h) => !beforeSet.has(h));
  const removed = before.filter((h) => !afterSet.has(h));

  console.log('');
  console.log('Allowlist updated:');
  for (const h of removed) console.log(`  - ${h}${isPlaceholder(h) ? ' [placeholder]' : ''}`);
  for (const h of added) console.log(`  + ${h}`);
  if (added.length === 0 && removed.length === 0) {
    console.log('  (no changes)');
  }
  console.log('');
  printList('Current allowlist', after);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'help') {
    usage();
    return;
  }

  const obj = await readAllowlist();
  const before = [...obj.hashes];

  if (opts.mode === 'show') {
    printList('Current allowlist', before);
    return;
  }

  let next;

  if (opts.mode === 'clear') {
    next = [];
  } else if (opts.mode === 'add-literal') {
    if (!opts.hash) throw new Error('--hash requires a value');
    validateHash(opts.hash);
    next = dedup([...stripPlaceholders(before), opts.hash]);
  } else if (opts.mode === 'remove') {
    if (!opts.hash) throw new Error('--remove requires a value');
    next = before.filter((h) => h !== opts.hash);
  } else if (opts.mode === 'add-from-dist') {
    if (opts.build) {
      // Decide prod-vs-dev path:
      //   --root-keypair <path>   → load JSON, extract public_key_hex, prod build
      //   env var set             → prod build
      //   neither                 → dev bundle, warn
      let pubkeyHex = null;
      if (opts.rootKeypairPath !== null) {
        pubkeyHex = await loadRootKeypairPubkey(opts.rootKeypairPath);
      } else if (process.env['PROVENANCE_ROOT_PUBLIC_KEY_HEX']) {
        pubkeyHex = process.env['PROVENANCE_ROOT_PUBLIC_KEY_HEX'];
        if (!HEX64.test(pubkeyHex)) {
          throw new Error(
            `PROVENANCE_ROOT_PUBLIC_KEY_HEX is malformed ` +
              `(expected 64 lowercase hex, got ${pubkeyHex.length}).`,
          );
        }
      }

      if (pubkeyHex !== null) {
        const legacyPubkeyHex = resolveLegacyCourseKeyHex();
        buildRecorderProd(pubkeyHex, legacyPubkeyHex);
      } else {
        bundleRecorderDev();
      }
    }

    const hash = await computeExtensionHash(RECORDER_DIST);
    validateHash(hash);
    console.log('');
    console.log(`Computed extension_hash from ${RECORDER_DIST}:\n  ${hash}`);
    next = dedup([...stripPlaceholders(before), hash]);
  } else {
    throw new Error(`Unknown mode: ${opts.mode}`);
  }

  obj.hashes = next;
  await writeAllowlist(obj);
  printDiff(before, next);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
