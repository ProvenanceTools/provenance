/**
 * Course onboarding tool: mint a `CourseCert` for a new course.
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §2, §3. Run this ONCE per course (or on cert renewal — a fresh window,
 * same or rotated course key). The output is handed to course staff: it
 * travels inline inside every `.provenance-manifest` the course signs
 * (see `tools/sign-manifest.ts`), authorizing their course key against the
 * embedded root public key that every recorder build trusts.
 *
 * This tool does NOT generate the course keypair — that's
 * `tools/generate-course-keypair.ts` (which can now also call straight into
 * this module's `mintCourseCert` to do both steps in one run). This tool
 * only needs the course's PUBLIC key.
 *
 * USAGE
 *   node --experimental-strip-types tools/mint-course-cert.ts \
 *     --course-id berkeley-cs61b \
 *     --course-pubkey <64-hex, from generate-course-keypair.ts stdout> \
 *     --valid-from 2026-08-20 \
 *     --valid-until 2027-01-15 \
 *     [--root-keypair /path/to/root-keypair.json]   (default: .notes/dev-root-keypair.json)
 *     [--out /path/to/cert.json]                     (default: print to stdout only)
 *
 * The ROOT private key is the highest-value secret in the system — it
 * authorizes every course. In production it must be generated offline on a
 * secured machine (see README "Course staff: key & manifest workflow") and
 * this tool must be pointed at that file via `--root-keypair`, never at the
 * dev default.
 *
 * The minted certificate is self-verified against the root public key
 * (`parseCourseCert` + `verifyCourseCert`, both from `@provenance/log-core`)
 * before being printed or written. A tool that hands out a certificate that
 * fails its own verification is worse than no tool.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  parseCourseCert,
  verifyCourseCert,
  signCourseCert,
  parseIsoInstantMs,
} from '@provenance/log-core';
import type { CourseCert } from '@provenance/log-core';
import { ok, err } from '@provenance/log-core';
import type { Result } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Default root keypair location — the DEV root, matching `.notes/dev-keypair.json`. */
export const DEFAULT_ROOT_KEYPAIR_PATH = path.join(REPO_ROOT, '.notes', 'dev-root-keypair.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MintArgs = {
  courseId: string;
  coursePubkeyHex: string;
  validFrom: string;
  validUntil: string;
  rootKeypairPath: string;
  outPath: string | null;
};

export type MintArgsError = { message: string };

export type StoredRootKeypair = {
  public_key_hex: string;
  private_key_hex: string;
};

export type MintError =
  | { kind: 'invalid_input'; message: string }
  | { kind: 'self_verification_failed'; message: string };

const HEX_64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Argument parsing — pure, unit-tested.
// ---------------------------------------------------------------------------

const FLAGS = new Set([
  '--course-id',
  '--course-pubkey',
  '--valid-from',
  '--valid-until',
  '--root-keypair',
  '--out',
]);

/**
 * Parse CLI flags for `mint-course-cert.ts`. Pure — no filesystem, no crypto.
 * `--course-id`, `--course-pubkey`, `--valid-from`, and `--valid-until` are
 * required; `--root-keypair` and `--out` are optional.
 */
export function parseMintArgs(
  argv: readonly string[],
  defaultRootKeypairPath: string = DEFAULT_ROOT_KEYPAIR_PATH,
): Result<MintArgs, MintArgsError> {
  const values: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === undefined || !FLAGS.has(flag)) {
      return err({ message: `Unknown argument: ${flag ?? '(empty)'}` });
    }
    const value = argv[i + 1];
    if (value === undefined) {
      return err({ message: `${flag} requires a value` });
    }
    values[flag] = value;
    i++;
  }

  const courseId = values['--course-id'];
  if (courseId === undefined || courseId.length === 0) {
    return err({ message: 'Missing required --course-id <id>' });
  }

  const coursePubkeyHex = values['--course-pubkey'];
  if (coursePubkeyHex === undefined || coursePubkeyHex.length === 0) {
    return err({ message: 'Missing required --course-pubkey <64-hex>' });
  }
  if (!HEX_64_RE.test(coursePubkeyHex)) {
    return err({
      message: `--course-pubkey must be 64 lowercase hex chars, got ${coursePubkeyHex.length} chars`,
    });
  }

  const validFrom = values['--valid-from'];
  if (validFrom === undefined || validFrom.length === 0) {
    return err({ message: 'Missing required --valid-from <ISO 8601 date/timestamp>' });
  }
  if (parseIsoInstantMs(validFrom) === null) {
    return err({ message: `--valid-from is not a valid ISO 8601 date/timestamp: '${validFrom}'` });
  }

  const validUntil = values['--valid-until'];
  if (validUntil === undefined || validUntil.length === 0) {
    return err({ message: 'Missing required --valid-until <ISO 8601 date/timestamp>' });
  }
  if (parseIsoInstantMs(validUntil) === null) {
    return err({
      message: `--valid-until is not a valid ISO 8601 date/timestamp: '${validUntil}'`,
    });
  }
  if ((parseIsoInstantMs(validFrom) as number) > (parseIsoInstantMs(validUntil) as number)) {
    return err({ message: '--valid-until must not be earlier than --valid-from' });
  }

  return ok({
    courseId,
    coursePubkeyHex,
    validFrom,
    validUntil,
    rootKeypairPath: values['--root-keypair'] ?? defaultRootKeypairPath,
    outPath: values['--out'] ?? null,
  });
}

// ---------------------------------------------------------------------------
// Minting — pure crypto, no filesystem. Shared with generate-course-keypair.ts.
// ---------------------------------------------------------------------------

/**
 * Sign a `CourseCert` with the root private key and self-verify the result
 * against the root public key before returning it. Used by both this tool's
 * CLI and `tools/generate-course-keypair.ts`'s one-step onboarding path.
 */
export async function mintCourseCert(
  unsigned: { courseId: string; coursePubkeyHex: string; validFrom: string; validUntil: string },
  rootKeypair: StoredRootKeypair,
): Promise<Result<CourseCert, MintError>> {
  if (!HEX_64_RE.test(rootKeypair.public_key_hex)) {
    return err({
      kind: 'invalid_input',
      message: `Root keypair public_key_hex is malformed (expected 64 lowercase hex chars, got ${rootKeypair.public_key_hex.length})`,
    });
  }
  if (!/^[0-9a-f]{64}$/.test(rootKeypair.private_key_hex)) {
    return err({
      kind: 'invalid_input',
      message: `Root keypair private_key_hex is malformed (expected 64 lowercase hex chars, got ${rootKeypair.private_key_hex.length})`,
    });
  }

  const unsignedCert = {
    course_id: unsigned.courseId,
    course_pubkey: unsigned.coursePubkeyHex,
    valid_from: unsigned.validFrom,
    valid_until: unsigned.validUntil,
  };

  const rootPrivkeyBytes = hexToBytes(rootKeypair.private_key_hex);
  const rootSig = await signCourseCert(unsignedCert, rootPrivkeyBytes);
  const cert: CourseCert = { ...unsignedCert, root_sig: rootSig };

  // Self-verify before handing it back: shape (parseCourseCert) and signature
  // (verifyCourseCert against the SAME root pubkey we just signed with).
  const shapeChecked = parseCourseCert(cert);
  if (!shapeChecked.ok) {
    return err({
      kind: 'self_verification_failed',
      message: `Minted certificate failed shape validation: ${JSON.stringify(shapeChecked.error)}`,
    });
  }
  const sigChecked = await verifyCourseCert(shapeChecked.value, rootKeypair.public_key_hex);
  if (!sigChecked.ok) {
    return err({
      kind: 'self_verification_failed',
      message:
        'Minted certificate did not verify against the root public key it was just signed with.',
    });
  }

  return ok(shapeChecked.value);
}

// ---------------------------------------------------------------------------
// CLI wrapper — I/O only, not unit-tested.
// ---------------------------------------------------------------------------

function die(message: string): never {
  process.stderr.write(`[mint-course-cert] ${message}\n`);
  process.exit(1);
}

function loadRootKeypair(keypairPath: string): StoredRootKeypair {
  if (!fs.existsSync(keypairPath)) {
    die(
      `Root keypair not found at ${keypairPath}.\n` +
        'Generate one offline (see README "Course staff: key & manifest workflow"), or pass ' +
        '--root-keypair pointing at .notes/dev-root-keypair.json for local dev.',
    );
  }
  const raw = fs.readFileSync(keypairPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    die(`Root keypair file ${keypairPath} is not valid JSON: ${String(e)}`);
  }
  const obj = parsed as Partial<StoredRootKeypair>;
  if (typeof obj.public_key_hex !== 'string' || typeof obj.private_key_hex !== 'string') {
    die(`Root keypair file ${keypairPath} is missing public_key_hex / private_key_hex.`);
  }
  return { public_key_hex: obj.public_key_hex, private_key_hex: obj.private_key_hex };
}

async function main(): Promise<void> {
  const parsedArgs = parseMintArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    die(
      `${parsedArgs.error.message}\n\n` +
        'Usage: node --experimental-strip-types tools/mint-course-cert.ts \\\n' +
        '  --course-id <id> --course-pubkey <64-hex> \\\n' +
        '  --valid-from <ISO date> --valid-until <ISO date> \\\n' +
        '  [--root-keypair <path>] [--out <path>]',
    );
  }
  const args = parsedArgs.value;

  const rootKeypair = loadRootKeypair(args.rootKeypairPath);

  const minted = await mintCourseCert(
    {
      courseId: args.courseId,
      coursePubkeyHex: args.coursePubkeyHex,
      validFrom: args.validFrom,
      validUntil: args.validUntil,
    },
    rootKeypair,
  );
  if (!minted.ok) {
    die(minted.error.message);
  }

  const certJson = JSON.stringify(minted.value, null, 2) + '\n';

  if (args.outPath !== null) {
    fs.writeFileSync(args.outPath, certJson, { mode: 0o644 });
    process.stderr.write(`[mint-course-cert] Wrote certificate to ${args.outPath}\n`);
  }

  process.stderr.write(
    `[mint-course-cert] Minted + self-verified certificate for '${args.courseId}' ` +
      `(root pubkey ${rootKeypair.public_key_hex}).\n` +
      '[mint-course-cert] Hand this JSON to course staff; sign-manifest.ts staples it into every\n' +
      '[mint-course-cert] manifest via --course-cert.\n',
  );
  process.stdout.write(certJson);
}

// Only run when invoked directly (not when imported by generate-course-keypair.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error('[mint-course-cert] Fatal error:', e);
    process.exit(1);
  });
}
