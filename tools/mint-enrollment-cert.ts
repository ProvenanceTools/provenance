/**
 * Course onboarding tool: mint an `EnrollmentCert` authorizing a server-held
 * enrollment signing key.
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §2, §S2. Structurally the sibling of `tools/mint-course-cert.ts` — read that
 * one first; this deliberately mirrors its arguments, its self-verification, and
 * its output shape.
 *
 * WHERE THIS SITS
 *
 *   root key    ──signs──►  course_cert       (tools/mint-course-cert.ts)
 *   course key  ──signs──►  enrollment_cert   (THIS TOOL)
 *   course key  ──signs──►  .provenance-manifest (tools/sign-manifest.ts)
 *   enrolment key ─signs──► enrollment tokens (the SERVER, per student, on demand)
 *
 * Run this ONCE per course per semester (or on enrollment-key rotation). The
 * course's private key is used here and then goes back offline; the certificate
 * this produces is what lets the SERVER mint per-student enrollment tokens
 * without ever holding the course key.
 *
 * This tool does NOT generate the enrollment keypair. Generate that on the
 * server (or wherever the enrollment signer will run) and bring only its PUBLIC
 * half here — the enrollment private key should never touch this machine.
 *
 * USAGE
 *   node --experimental-strip-types tools/mint-enrollment-cert.ts \
 *     --course-id berkeley-cs61b \
 *     --enrollment-pubkey <64-hex, the server's enrollment signing pubkey> \
 *     --valid-from 2026-08-20 \
 *     --valid-until 2027-01-15 \
 *     [--course-keypair /path/to/course-keypair.json]  (default: .notes/dev-keypair.json)
 *     [--out /path/to/enrollment-cert.json]            (default: print to stdout only)
 *
 * KEEP THE WINDOW SHORT. There is no offline revocation (program spec §2), so
 * the validity window is the only control that limits the damage of a stolen
 * enrollment key. One semester, matching the course cert, is the intended shape.
 *
 * The minted certificate is self-verified against the course public key
 * (`parseEnrollmentCert` + `verifyEnrollmentCert`, both from
 * `@provenance/log-core`) before being printed or written. A tool that hands out
 * a certificate that fails its own verification is worse than no tool.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  parseEnrollmentCert,
  verifyEnrollmentCert,
  signEnrollmentCert,
  parseIsoInstantMs,
  ENROLLMENT_FORMAT_VERSION,
} from '@provenance/log-core';
import type { EnrollmentCert } from '@provenance/log-core';
import { ok, err } from '@provenance/log-core';
import type { Result } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Default course keypair location — the same dev keypair `sign-manifest.ts` uses. */
export const DEFAULT_COURSE_KEYPAIR_PATH = path.join(REPO_ROOT, '.notes', 'dev-keypair.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MintEnrollmentArgs = {
  courseId: string;
  enrollmentPubkeyHex: string;
  validFrom: string;
  validUntil: string;
  courseKeypairPath: string;
  outPath: string | null;
};

export type MintEnrollmentArgsError = { message: string };

export type StoredCourseKeypair = {
  public_key_hex: string;
  private_key_hex: string;
};

export type MintEnrollmentError =
  | { kind: 'invalid_input'; message: string }
  | { kind: 'self_verification_failed'; message: string };

const HEX_64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Argument parsing — pure, unit-tested.
// ---------------------------------------------------------------------------

const FLAGS = new Set([
  '--course-id',
  '--enrollment-pubkey',
  '--valid-from',
  '--valid-until',
  '--course-keypair',
  '--out',
]);

/**
 * Parse CLI flags for `mint-enrollment-cert.ts`. Pure — no filesystem, no crypto.
 * `--course-id`, `--enrollment-pubkey`, `--valid-from`, and `--valid-until` are
 * required; `--course-keypair` and `--out` are optional.
 */
export function parseMintEnrollmentArgs(
  argv: readonly string[],
  defaultCourseKeypairPath: string = DEFAULT_COURSE_KEYPAIR_PATH,
): Result<MintEnrollmentArgs, MintEnrollmentArgsError> {
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

  const enrollmentPubkeyHex = values['--enrollment-pubkey'];
  if (enrollmentPubkeyHex === undefined || enrollmentPubkeyHex.length === 0) {
    return err({ message: 'Missing required --enrollment-pubkey <64-hex>' });
  }
  if (!HEX_64_RE.test(enrollmentPubkeyHex)) {
    return err({
      message: `--enrollment-pubkey must be 64 lowercase hex chars, got ${enrollmentPubkeyHex.length} chars`,
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
    enrollmentPubkeyHex,
    validFrom,
    validUntil,
    courseKeypairPath: values['--course-keypair'] ?? defaultCourseKeypairPath,
    outPath: values['--out'] ?? null,
  });
}

// ---------------------------------------------------------------------------
// Minting — pure crypto, no filesystem.
// ---------------------------------------------------------------------------

/**
 * Sign an `EnrollmentCert` with the course private key and self-verify the
 * result against the course public key before returning it.
 */
export async function mintEnrollmentCert(
  unsigned: {
    courseId: string;
    enrollmentPubkeyHex: string;
    validFrom: string;
    validUntil: string;
  },
  courseKeypair: StoredCourseKeypair,
): Promise<Result<EnrollmentCert, MintEnrollmentError>> {
  if (!HEX_64_RE.test(courseKeypair.public_key_hex)) {
    return err({
      kind: 'invalid_input',
      message: `Course keypair public_key_hex is malformed (expected 64 lowercase hex chars, got ${courseKeypair.public_key_hex.length})`,
    });
  }
  if (!HEX_64_RE.test(courseKeypair.private_key_hex)) {
    return err({
      kind: 'invalid_input',
      message: `Course keypair private_key_hex is malformed (expected 64 lowercase hex chars, got ${courseKeypair.private_key_hex.length})`,
    });
  }

  const unsignedCert = {
    format_version: ENROLLMENT_FORMAT_VERSION,
    course_id: unsigned.courseId,
    enrollment_pubkey: unsigned.enrollmentPubkeyHex,
    valid_from: unsigned.validFrom,
    valid_until: unsigned.validUntil,
  };

  const coursePrivkeyBytes = hexToBytes(courseKeypair.private_key_hex);
  const courseSig = await signEnrollmentCert(unsignedCert, coursePrivkeyBytes);
  const cert: EnrollmentCert = { ...unsignedCert, course_sig: courseSig };

  // Self-verify before handing it back: shape (parseEnrollmentCert) and
  // signature (verifyEnrollmentCert against the SAME course pubkey we signed with).
  const shapeChecked = parseEnrollmentCert(cert);
  if (!shapeChecked.ok) {
    return err({
      kind: 'self_verification_failed',
      message: `Minted enrollment certificate failed shape validation: ${JSON.stringify(shapeChecked.error)}`,
    });
  }
  const sigChecked = await verifyEnrollmentCert(shapeChecked.value, courseKeypair.public_key_hex);
  if (!sigChecked.ok) {
    return err({
      kind: 'self_verification_failed',
      message:
        'Minted enrollment certificate did not verify against the course public key it was just signed with.',
    });
  }

  return ok(shapeChecked.value);
}

// ---------------------------------------------------------------------------
// CLI wrapper — I/O only, not unit-tested.
// ---------------------------------------------------------------------------

function die(message: string): never {
  process.stderr.write(`[mint-enrollment-cert] ${message}\n`);
  process.exit(1);
}

function loadCourseKeypair(keypairPath: string): StoredCourseKeypair {
  if (!fs.existsSync(keypairPath)) {
    die(
      `Course keypair not found at ${keypairPath}.\n` +
        'Generate one with tools/generate-course-keypair.ts, or pass --course-keypair ' +
        'pointing at the offline course key.',
    );
  }
  const raw = fs.readFileSync(keypairPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    die(`Course keypair file ${keypairPath} is not valid JSON: ${String(e)}`);
  }
  const obj = parsed as Partial<StoredCourseKeypair>;
  if (typeof obj.public_key_hex !== 'string' || typeof obj.private_key_hex !== 'string') {
    die(`Course keypair file ${keypairPath} is missing public_key_hex / private_key_hex.`);
  }
  return { public_key_hex: obj.public_key_hex, private_key_hex: obj.private_key_hex };
}

async function main(): Promise<void> {
  const parsedArgs = parseMintEnrollmentArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    die(
      `${parsedArgs.error.message}\n\n` +
        'Usage: node --experimental-strip-types tools/mint-enrollment-cert.ts \\\n' +
        '  --course-id <id> --enrollment-pubkey <64-hex> \\\n' +
        '  --valid-from <ISO date> --valid-until <ISO date> \\\n' +
        '  [--course-keypair <path>] [--out <path>]',
    );
  }
  const args = parsedArgs.value;

  const courseKeypair = loadCourseKeypair(args.courseKeypairPath);

  const minted = await mintEnrollmentCert(
    {
      courseId: args.courseId,
      enrollmentPubkeyHex: args.enrollmentPubkeyHex,
      validFrom: args.validFrom,
      validUntil: args.validUntil,
    },
    courseKeypair,
  );
  if (!minted.ok) {
    die(minted.error.message);
  }

  const certJson = JSON.stringify(minted.value, null, 2) + '\n';

  if (args.outPath !== null) {
    fs.writeFileSync(args.outPath, certJson, { mode: 0o644 });
    process.stderr.write(`[mint-enrollment-cert] Wrote certificate to ${args.outPath}\n`);
  }

  process.stderr.write(
    `[mint-enrollment-cert] Minted + self-verified enrollment certificate for '${args.courseId}' ` +
      `(course pubkey ${courseKeypair.public_key_hex}).\n` +
      '[mint-enrollment-cert] Install this on the enrollment server: it travels beside every\n' +
      '[mint-enrollment-cert] enrollment token the server mints, in session.start `identity`.\n' +
      '[mint-enrollment-cert] The COURSE private key can now go back offline.\n',
  );
  process.stdout.write(certJson);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error('[mint-enrollment-cert] Fatal error:', e);
    process.exit(1);
  });
}
