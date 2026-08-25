/**
 * Generate the course's offline ed25519 keypair — course onboarding, step 1
 * of 2 (or all-in-one with the flags below).
 *
 * USE THIS ONLY ON A SECURED MACHINE.
 *
 * The private key produced by this script is what authorizes every `.provenance-manifest` manifest
 * the course distributes. Anyone with it can forge a valid manifest, which would let
 * an attacker run the recorder on arbitrary folders and produce convincing logs.
 * Treat it like the course's most sensitive credential:
 *
 *   - run on an air-gapped or otherwise hardened machine
 *   - never paste the private key into chat, email, CI, or any logging system
 *   - back it up to physical media (USB / printed paper) before deleting from disk
 *   - rotate per-semester or sooner if you suspect exposure
 *
 * What the script does:
 *   1. Generates a fresh ed25519 keypair via `node:crypto.generateKeyPairSync`.
 *   2. Prints the public key (64 hex chars) to stdout — this is what a root-key
 *      holder needs to mint the course's certificate (`tools/mint-course-cert.ts`),
 *      either as a separate step or automatically via the flags below.
 *   3. Writes the private key to a path you specify on the command line. Refuses to
 *      overwrite, refuses to write inside the repo, and emits no other output on
 *      stdout besides the public key (so it's still safe to pipe/paste).
 *
 * Usage (keypair only — original behavior, unchanged):
 *   node --experimental-strip-types tools/generate-course-keypair.ts <privkey-out-path>
 *
 * Usage (keypair + minted certificate in one step — program spec §2, §3):
 *   node --experimental-strip-types tools/generate-course-keypair.ts <privkey-out-path> \
 *     --course-id berkeley-cs61b \
 *     --valid-from 2026-08-20 --valid-until 2027-01-15 \
 *     [--root-keypair /path/to/root-keypair.json]  (default: .notes/dev-root-keypair.json)
 *     [--cert-out /path/to/cert.json]               (default: <privkey-out-path> with a
 *                                                     .cert.json suffix instead of .json)
 *
 * `--course-id` is what triggers minting; `--valid-from` / `--valid-until` are then
 * required. Whoever runs this needs the ROOT private key at `--root-keypair` (or the
 * dev default) — normally that means running this on the maintainer's secured
 * machine, or running the two steps separately (course staff generate the keypair
 * and hand only the PUBLIC key to whoever holds the root key, who runs
 * `tools/mint-course-cert.ts` on their own machine instead).
 *
 * Example:
 *   node --experimental-strip-types tools/generate-course-keypair.ts /Volumes/COURSE-KEY/cs61a-fa26.json
 *
 * The output file is JSON:
 *   {
 *     "public_key_hex": "<64 hex chars>",
 *     "private_key_hex": "<64 hex chars>",
 *     "generated_at": "<ISO 8601 UTC>",
 *     "note": "Course offline-signing key. Keep secret. See tools/generate-course-keypair.ts."
 *   }
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, err } from '@provenance/log-core';
import type { Result } from '@provenance/log-core';
import { mintCourseCert, DEFAULT_ROOT_KEYPAIR_PATH } from './mint-course-cert.ts';
import type { StoredRootKeypair } from './mint-course-cert.ts';

function bytesToHex(buf: Buffer): string {
  return buf.toString('hex');
}

function generateKeypair(): { privateKeyHex: string; publicKeyHex: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });

  // PKCS8 DER for ed25519: raw 32-byte seed at byte offset 16.
  // SPKI DER for ed25519: raw 32-byte public key at byte offset 12.
  const seedBytes = (privateKey as Buffer).subarray(16, 48);
  const pubkeyBytes = (publicKey as Buffer).subarray(12, 44);

  return {
    privateKeyHex: bytesToHex(seedBytes),
    publicKeyHex: bytesToHex(pubkeyBytes),
  };
}

// ---------------------------------------------------------------------------
// Argument parsing — pure, unit-tested.
// ---------------------------------------------------------------------------

export type MintRequest = {
  courseId: string;
  validFrom: string;
  validUntil: string;
  rootKeypairPath: string;
  certOutPath: string;
};

export type GenerateArgs = {
  outPath: string;
  mint: MintRequest | null;
};

export type GenerateArgsError = { message: string };

const MINT_FLAGS = new Set([
  '--course-id',
  '--valid-from',
  '--valid-until',
  '--root-keypair',
  '--cert-out',
]);

/** `cs61a-fa26.json` → `cs61a-fa26.cert.json`. `cs61a-fa26` → `cs61a-fa26.cert.json`. */
export function deriveCertOutPath(outPath: string): string {
  return outPath.endsWith('.json')
    ? outPath.slice(0, -'.json'.length) + '.cert.json'
    : outPath + '.cert.json';
}

/**
 * Parse argv for `generate-course-keypair.ts`. The first positional argument
 * is always the private-key output path (unchanged from the original
 * behavior). Everything after it is optional cert-minting flags, present
 * only when `--course-id` is given.
 */
export function parseGenerateArgs(
  argv: readonly string[],
  defaultRootKeypairPath: string = DEFAULT_ROOT_KEYPAIR_PATH,
): Result<GenerateArgs, GenerateArgsError> {
  const outPath = argv[0];
  if (outPath === undefined || outPath.length === 0) {
    return err({ message: 'Missing output path.' });
  }

  const values: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === undefined || !MINT_FLAGS.has(flag)) {
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
  if (courseId === undefined) {
    // No minting requested. Flags that only make sense alongside --course-id
    // are a mistake worth failing loudly on rather than silently ignoring.
    const strayFlag = ['--valid-from', '--valid-until', '--root-keypair', '--cert-out'].find(
      (f) => values[f] !== undefined,
    );
    if (strayFlag !== undefined) {
      return err({ message: `${strayFlag} requires --course-id (it has no effect without it)` });
    }
    return ok({ outPath, mint: null });
  }

  const validFrom = values['--valid-from'];
  if (validFrom === undefined) {
    return err({ message: '--course-id requires --valid-from <ISO 8601 date/timestamp>' });
  }
  const validUntil = values['--valid-until'];
  if (validUntil === undefined) {
    return err({ message: '--course-id requires --valid-until <ISO 8601 date/timestamp>' });
  }

  return ok({
    outPath,
    mint: {
      courseId,
      validFrom,
      validUntil,
      rootKeypairPath: values['--root-keypair'] ?? defaultRootKeypairPath,
      certOutPath: values['--cert-out'] ?? deriveCertOutPath(outPath),
    },
  });
}

// ---------------------------------------------------------------------------
// CLI wrapper — I/O only, not unit-tested.
// ---------------------------------------------------------------------------

function die(message: string): never {
  process.stderr.write(`[generate-course-keypair] ${message}\n`);
  process.exit(1);
}

function loadRootKeypair(keypairPath: string): StoredRootKeypair {
  if (!fs.existsSync(keypairPath)) {
    die(
      `Root keypair not found at ${keypairPath}.\n` +
        'Pass --root-keypair pointing at the real (offline, secured) root keypair, or omit ' +
        '--course-id and mint the certificate separately via tools/mint-course-cert.ts.',
    );
  }
  const raw = fs.readFileSync(keypairPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<StoredRootKeypair>;
  if (typeof parsed.public_key_hex !== 'string' || typeof parsed.private_key_hex !== 'string') {
    die(`Root keypair file ${keypairPath} is missing public_key_hex / private_key_hex.`);
  }
  return { public_key_hex: parsed.public_key_hex, private_key_hex: parsed.private_key_hex };
}

async function main(): Promise<void> {
  const parsedArgs = parseGenerateArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    die(
      `${parsedArgs.error.message}\n` +
        'Usage: node --experimental-strip-types tools/generate-course-keypair.ts <privkey-out-path>\n' +
        '  [--course-id <id> --valid-from <date> --valid-until <date> ' +
        '[--root-keypair <path>] [--cert-out <path>]]\n' +
        'Example: ... /Volumes/COURSE-KEY/cs61a-fa26.json',
    );
  }
  const { outPath: outPathArg, mint } = parsedArgs.value;

  const outPath = path.resolve(outPathArg);

  // Refuse to write inside the repo. Anyone running this script should be writing
  // to a USB drive or another secured volume — never into the source tree.
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  if (outPath.startsWith(repoRoot + path.sep) || outPath === repoRoot) {
    die(
      `Refusing to write the private key inside the repo (${outPath}).\n` +
        'Choose a path on a secured/removable volume.',
    );
  }

  // Refuse to overwrite. If the destination exists, the caller likely intended a
  // different path and we don't want to clobber an existing offline key.
  if (fs.existsSync(outPath)) {
    die(
      `Refusing to overwrite an existing file at ${outPath}.\n` +
        'Choose a fresh path, or delete the existing file deliberately first.',
    );
  }

  // Ensure the parent directory exists. Don't auto-create deep paths — fail
  // loudly so the operator knows where they're writing.
  const parent = path.dirname(outPath);
  if (!fs.existsSync(parent)) {
    die(`Parent directory does not exist: ${parent}\nCreate it first, then re-run.`);
  }

  // Generate.
  const { privateKeyHex, publicKeyHex } = generateKeypair();

  // Write the private key to the secured path with restrictive permissions.
  const fileContents = {
    public_key_hex: publicKeyHex,
    private_key_hex: privateKeyHex,
    generated_at: new Date().toISOString(),
    note: 'Course offline-signing key. Keep secret. See tools/generate-course-keypair.ts.',
  };
  fs.writeFileSync(outPath, JSON.stringify(fileContents, null, 2) + '\n', { mode: 0o600 });

  // Print only the public key to stdout. Anything else goes to stderr so the
  // operator can pipe stdout straight into a clipboard or a build script.
  process.stdout.write(publicKeyHex + '\n');

  process.stderr.write(
    `[generate-course-keypair] Wrote private key to: ${outPath} (mode 0600)\n` +
      `[generate-course-keypair] Public key (stdout above): ${publicKeyHex}\n`,
  );

  if (mint === null) {
    process.stderr.write(
      `[generate-course-keypair] Next steps:\n` +
        `  1. Back up ${outPath} to physical media. Verify the backup.\n` +
        `  2. Get this public key root-signed into a certificate: tools/mint-course-cert.ts\n` +
        `     (program spec §2 — the recorder now embeds a ROOT public key, never a course key,\n` +
        `     so there is no per-course "embed" step any more; the certificate travels inline\n` +
        `     in the manifest instead).\n` +
        `  3. Sign your first .provenance-manifest file with tools/sign-manifest.ts, pointing it at\n` +
        `     this file and the minted certificate instead of the dev defaults.\n` +
        `  4. Once you're satisfied with the backup, securely delete the local copy of ${outPath}.\n`,
    );
    return;
  }

  // One-step onboarding: mint the certificate too, using the ROOT keypair.
  const rootKeypair = loadRootKeypair(mint.rootKeypairPath);
  const minted = await mintCourseCert(
    {
      courseId: mint.courseId,
      coursePubkeyHex: publicKeyHex,
      validFrom: mint.validFrom,
      validUntil: mint.validUntil,
    },
    rootKeypair,
  );
  if (!minted.ok) {
    die(minted.error.message);
  }

  const certOutPath = path.resolve(mint.certOutPath);
  fs.writeFileSync(certOutPath, JSON.stringify(minted.value, null, 2) + '\n', { mode: 0o644 });

  process.stderr.write(
    `[generate-course-keypair] Minted + self-verified course_cert for '${mint.courseId}':\n` +
      `  ${certOutPath}\n` +
      `[generate-course-keypair] Next steps:\n` +
      `  1. Back up ${outPath} to physical media. Verify the backup.\n` +
      `  2. Sign your first .provenance-manifest file with tools/sign-manifest.ts, pointing\n` +
      `     --course-keypair at ${outPath} and --course-cert at ${certOutPath}.\n` +
      `  3. Once you're satisfied with the backup, securely delete the local copy of ${outPath}.\n`,
  );
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error('[generate-course-keypair] Fatal error:', e);
    process.exit(1);
  });
}
