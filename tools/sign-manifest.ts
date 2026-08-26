/**
 * Dev/course-staff tooling: sign a `.provenance-manifest` file.
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §3. Emits Manifest 2.0 by default (course-signed payload + a root-signed
 * `course_cert` stapled inline); pass `--format 1.0` for the legacy shape,
 * which remains fully supported (log-core parses 1.x manifests permanently —
 * see `packages/log-core/src/manifest.ts`).
 *
 * USAGE (2.0 — default)
 *   node --experimental-strip-types tools/sign-manifest.ts [manifestPath] \
 *     [--course-keypair <path>]   (default: PROVENANCE_COURSE_KEYPAIR_PATH env,
 *                                  else .notes/dev-keypair.json)
 *     [--course-cert <path>]      (default: PROVENANCE_COURSE_CERT_PATH env,
 *                                  else .notes/dev-course-cert.json — minted via
 *                                  tools/mint-course-cert.ts)
 *     [--root-pubkey <64-hex>]    (default: PROVENANCE_ROOT_PUBLIC_KEY_HEX env,
 *                                  else public_key_hex from .notes/dev-root-keypair.json;
 *                                  used ONLY to self-verify the chain before writing —
 *                                  the recorder embeds this key itself, this tool does
 *                                  not distribute it)
 *
 *   The target manifest file must already contain, unsigned: `assignment_id`,
 *   `semester`, `issued_at`, `files_under_review`, `course_id`, `collaboration`,
 *   `submission`, `scope`, `policy`, `ignore`, `attachments`. `course_id` MUST
 *   equal the course_cert's `course_id` (chain step 3) or signing will succeed
 *   but self-verification — and therefore this tool — will refuse to write the
 *   file.
 *
 *   The `policy` block is the professor-facing course control, and it is signed:
 *
 *     "policy": {
 *       "capture": {
 *         "selection_change":      true,
 *         "focus_change":          true,
 *         "terminal":              true,
 *         "heartbeat_interval_ms": 30000
 *       },
 *       "enrollment": { "required": true }
 *     }
 *
 *   `capture` narrows what the recorder records; every other event kind is on
 *   the floor and has no key at all (`log-core/policy.ts`). `enrollment.required`
 *   is NOT a capture knob — set it `false` and the recorder stops telling
 *   un-enrolled students they are un-enrolled: no "(not enrolled)" status bar,
 *   no enrollment prompt. Recording is completely unaffected and the bundle is
 *   byte-identical; what you give up is ATTRIBUTION, i.e. nothing in the
 *   submission says who produced it. Reasonable for a course of solo
 *   assignments; wrong for one with group work.
 *
 *   Every key in this block is optional and omitting one means its default
 *   (capture on, 30s heartbeat, enrollment required) — so a manifest that
 *   predates a key keeps working. This tool passes `policy` through VERBATIM
 *   rather than rebuilding it from a known key set, which is what lets a course
 *   use a key this tool has never heard of. Do not "tighten" that into an
 *   enumeration: it would silently drop keys, producing a manifest that signs
 *   cleanly and does not do what the course asked.
 *
 * USAGE (1.0 — legacy, permanently supported)
 *   node --experimental-strip-types tools/sign-manifest.ts [manifestPath] --format 1.0 \
 *     [--course-keypair <path>]
 *
 *   The target manifest file must contain: `assignment_id`, `semester`, `issued_at`,
 *   `files_under_review`. No `course_id` / `collaboration` / `submission` / `scope` /
 *   `policy` / `course_cert` — those fields do not exist at 1.0.
 *
 * Both paths: any existing `sig` (and, at 2.0, `course_cert`) in the target file is
 * stripped and rebuilt. The result is self-verified — `verifyManifestChain` at 2.0,
 * `verifyManifest` at 1.0 — before anything is written. A tool that emits a manifest
 * that fails its own check is worse than no tool.
 *
 * The course keypair defaults to `.notes/dev-keypair.json`, the same dev keypair
 * `tools/generate-course-keypair.ts` and the old version of this script used. Course
 * staff signing a real assignment should set `PROVENANCE_COURSE_KEYPAIR_PATH` to the
 * offline-generated key (produced by `tools/generate-course-keypair.ts`) and, at 2.0,
 * `PROVENANCE_COURSE_CERT_PATH` to the certificate minted for that key
 * (`tools/mint-course-cert.ts`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  canonicalize,
  signManifest,
  verifyManifest,
  verifyManifestChain,
  MANIFEST_FORMAT_VERSION_2,
  MANIFEST_FORMAT_VERSION_LEGACY,
  ok,
  err,
} from '@provenance/log-core';
import type { Manifest, CourseCert, Result } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Paths / env defaults
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const DEFAULT_COURSE_KEYPAIR_PATH = path.join(REPO_ROOT, '.notes', 'dev-keypair.json');
const DEFAULT_COURSE_CERT_PATH = path.join(REPO_ROOT, '.notes', 'dev-course-cert.json');
const DEFAULT_ROOT_KEYPAIR_PATH = path.join(REPO_ROOT, '.notes', 'dev-root-keypair.json');
const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, 'test-workspace', '.provenance-manifest');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StoredKeypair = {
  public_key_hex: string;
  private_key_hex: string;
};

export type SignFormat = '1.0' | '2.0';

export type RawSignArgs = {
  manifestPath: string | undefined;
  format: string | undefined;
  courseKeypairPath: string | undefined;
  courseCertPath: string | undefined;
  rootPubkeyHex: string | undefined;
};

export type SignOptions = {
  manifestPath: string;
  format: SignFormat;
  courseKeypairPath: string;
  /** Only meaningful at format 2.0. */
  courseCertPath: string;
  /** Only meaningful at format 2.0 — used to self-verify, never embedded by this tool. */
  rootPubkeyHex: string | null;
};

export type SignArgsError = { message: string };

// ---------------------------------------------------------------------------
// Argument parsing — pure, unit-tested.
// ---------------------------------------------------------------------------

const FLAGS = new Set(['--format', '--course-keypair', '--course-cert', '--root-pubkey']);

/**
 * Parse argv. The first bare (non-flag) token, if present, is the manifest
 * path — matching the original script's `argv[2]` positional convention.
 */
export function parseSignArgs(argv: readonly string[]): Result<RawSignArgs, SignArgsError> {
  const values: Record<string, string> = {};
  let manifestPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value === undefined) {
        return err({ message: `${token} requires a value` });
      }
      values[token] = value;
      i++;
      continue;
    }
    if (token.startsWith('--')) {
      return err({ message: `Unknown argument: ${token}` });
    }
    if (manifestPath !== undefined) {
      return err({ message: `Unexpected extra positional argument: ${token}` });
    }
    manifestPath = token;
  }

  return ok({
    manifestPath,
    format: values['--format'],
    courseKeypairPath: values['--course-keypair'],
    courseCertPath: values['--course-cert'],
    rootPubkeyHex: values['--root-pubkey'],
  });
}

export type SignEnv = {
  PROVENANCE_COURSE_KEYPAIR_PATH?: string;
  PROVENANCE_COURSE_CERT_PATH?: string;
  PROVENANCE_ROOT_PUBLIC_KEY_HEX?: string;
};

export type SignDefaults = {
  manifestPath: string;
  courseKeypairPath: string;
  courseCertPath: string;
};

/**
 * Apply CLI-flag > env-var > built-in-default precedence and validate
 * `--format`. Pure — no filesystem access, no crypto.
 */
export function resolveSignOptions(
  raw: RawSignArgs,
  env: SignEnv,
  defaults: SignDefaults = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    courseKeypairPath: DEFAULT_COURSE_KEYPAIR_PATH,
    courseCertPath: DEFAULT_COURSE_CERT_PATH,
  },
): Result<SignOptions, SignArgsError> {
  const format = raw.format ?? '2.0';
  if (format !== '1.0' && format !== '2.0') {
    return err({ message: `--format must be '1.0' or '2.0', got '${format}'` });
  }

  return ok({
    manifestPath: raw.manifestPath ?? defaults.manifestPath,
    format,
    courseKeypairPath:
      raw.courseKeypairPath ?? env.PROVENANCE_COURSE_KEYPAIR_PATH ?? defaults.courseKeypairPath,
    courseCertPath:
      raw.courseCertPath ?? env.PROVENANCE_COURSE_CERT_PATH ?? defaults.courseCertPath,
    rootPubkeyHex: raw.rootPubkeyHex ?? env.PROVENANCE_ROOT_PUBLIC_KEY_HEX ?? null,
  });
}

// ---------------------------------------------------------------------------
// Unsigned-manifest construction — pure, unit-tested.
// ---------------------------------------------------------------------------

export type BuildManifestError = { message: string };

/**
 * Strip any previously-attached `sig` / `course_cert` and pull the fields a
 * manifest of the given format requires out of an already-JSON-parsed,
 * author-supplied object. Presence-only validation — deep shape/type
 * validation is `verifyManifest` / `verifyManifestChain`'s job (via
 * `parseManifestValue` internally), not duplicated here.
 */
export function buildUnsignedManifest(
  format: SignFormat,
  raw: unknown,
): Result<Omit<Manifest, 'sig'>, BuildManifestError> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err({ message: 'Manifest file does not contain a JSON object' });
  }
  const obj = raw as Record<string, unknown>;

  const required1x = ['assignment_id', 'semester', 'issued_at', 'files_under_review'] as const;
  for (const field of required1x) {
    if (obj[field] === undefined) {
      return err({ message: `Manifest is missing required field '${field}'` });
    }
  }

  const base = {
    assignment_id: obj['assignment_id'],
    semester: obj['semester'],
    issued_at: obj['issued_at'],
    files_under_review: obj['files_under_review'],
  } as Pick<Manifest, 'assignment_id' | 'semester' | 'issued_at' | 'files_under_review'>;

  if (format === MANIFEST_FORMAT_VERSION_LEGACY) {
    return ok(base);
  }

  const required2x = [
    'course_id',
    'collaboration',
    'submission',
    'scope',
    'policy',
    'ignore',
    'attachments',
  ] as const;
  for (const field of required2x) {
    if (obj[field] === undefined) {
      return err({
        message: `Manifest is missing required 2.0 field '${field}' (or pass --format 1.0)`,
      });
    }
  }

  return ok({
    ...base,
    format_version: MANIFEST_FORMAT_VERSION_2,
    course_id: obj['course_id'],
    collaboration: obj['collaboration'],
    submission: obj['submission'],
    scope: obj['scope'],
    policy: obj['policy'],
    ignore: obj['ignore'],
    attachments: obj['attachments'],
  } as Omit<Manifest, 'sig'>);
}

// ---------------------------------------------------------------------------
// CLI wrapper — I/O only, not unit-tested.
// ---------------------------------------------------------------------------

function die(message: string): never {
  process.stderr.write(`[sign-manifest] ${message}\n`);
  process.exit(1);
}

function readJsonFile(filePath: string, label: string): unknown {
  if (!fs.existsSync(filePath)) {
    die(`${label} not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`${label} at ${filePath} is not valid JSON: ${String(e)}`);
  }
}

function loadKeypair(keypairPath: string, label: string): StoredKeypair {
  const parsed = readJsonFile(keypairPath, label) as Partial<StoredKeypair>;
  if (typeof parsed.public_key_hex !== 'string' || typeof parsed.private_key_hex !== 'string') {
    die(`${label} file ${keypairPath} is missing public_key_hex / private_key_hex.`);
  }
  return { public_key_hex: parsed.public_key_hex, private_key_hex: parsed.private_key_hex };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function main(): Promise<void> {
  const parsedArgs = parseSignArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    die(
      `${parsedArgs.error.message}\n\n` +
        'Usage: node --experimental-strip-types tools/sign-manifest.ts [manifestPath] \\\n' +
        '  [--format 1.0|2.0] [--course-keypair <path>] [--course-cert <path>] [--root-pubkey <hex>]',
    );
  }

  const resolved = resolveSignOptions(parsedArgs.value, process.env as SignEnv);
  if (!resolved.ok) {
    die(resolved.error.message);
  }
  const opts = resolved.value;

  console.log(`[sign-manifest] Format: ${opts.format}`);
  console.log(`[sign-manifest] Manifest: ${opts.manifestPath}`);
  console.log(`[sign-manifest] Course keypair: ${opts.courseKeypairPath}`);

  const keypair = loadKeypair(opts.courseKeypairPath, 'Course keypair');
  console.log(`[sign-manifest] Course public key: ${keypair.public_key_hex}`);

  const rawManifest = readJsonFile(opts.manifestPath, 'Manifest');
  const built = buildUnsignedManifest(opts.format, rawManifest);
  if (!built.ok) {
    die(built.error.message);
  }
  const unsigned = built.value;

  const sig = await signManifest(unsigned, hexToBytes(keypair.private_key_hex));

  if (opts.format === MANIFEST_FORMAT_VERSION_LEGACY) {
    const signed: Manifest = { ...unsigned, sig };

    const verified = await verifyManifest(signed, keypair.public_key_hex);
    if (!verified.ok) {
      die(
        `Refusing to write: the manifest this tool just signed did not verify ` +
          `(${JSON.stringify(verified.error)}). This is a bug — please report it.`,
      );
    }

    const canonicalOutput = canonicalize(signed);
    fs.writeFileSync(opts.manifestPath, canonicalOutput + '\n');
    console.log(`[sign-manifest] Manifest signed and written to ${opts.manifestPath}`);
    console.log(`[sign-manifest] sig (128 hex chars): ${sig}`);
    return;
  }

  console.log(`[sign-manifest] Course cert: ${opts.courseCertPath}`);
  const cert = readJsonFile(opts.courseCertPath, 'Course certificate') as CourseCert;

  const signed: Manifest = { ...unsigned, sig, course_cert: cert };

  const rootPubkeyHex =
    opts.rootPubkeyHex ?? loadKeypair(DEFAULT_ROOT_KEYPAIR_PATH, 'Root keypair').public_key_hex;

  const chainResult = await verifyManifestChain(signed, rootPubkeyHex);
  if (!chainResult.ok) {
    die(
      `Refusing to write: the manifest this tool just signed does not verify its own trust ` +
        `chain (${JSON.stringify(chainResult.error)}).\n` +
        'Common causes: manifest.course_id does not match course_cert.course_id, the course ' +
        'keypair does not match the certificate, or --root-pubkey does not match the root key ' +
        'that signed the certificate.',
    );
  }

  const canonicalOutput = canonicalize(signed);
  fs.writeFileSync(opts.manifestPath, canonicalOutput + '\n');
  console.log(`[sign-manifest] Manifest signed and written to ${opts.manifestPath}`);
  console.log(`[sign-manifest] sig (128 hex chars): ${sig}`);
  console.log(`[sign-manifest] Chain verified: course_id=${chainResult.value.course_id}`);
  if (!chainResult.value.window.in_window) {
    console.log(
      `[sign-manifest] WARNING: cert is out of its validity window at issued_at ` +
        `(${chainResult.value.window.reason}). The recorder will still record (program spec §4); ` +
        `re-mint the certificate if this is unexpected.`,
    );
  }
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error('[sign-manifest] Fatal error:', e);
    process.exit(1);
  });
}
