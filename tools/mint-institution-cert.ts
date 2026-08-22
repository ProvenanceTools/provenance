/**
 * Deployment onboarding tool: mint the `InstitutionCert` that authorizes a
 * server-held institution signing key (identity `format_version` 2.1).
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §2. Structurally the sibling of `tools/mint-course-cert.ts` — read that one
 * first; this deliberately mirrors its arguments, its self-verification, and its
 * output shape.
 *
 * ## Why this tool has to exist
 *
 * `PROVENANCE_INSTITUTION_KEY` is `{ private_key_hex, cert }`, and `cert` must be
 * a ROOT-SIGNED `institution_cert`. Without one, `institutionKey()` returns
 * `undefined`, `issueStudentCredential` short-circuits, and
 * `POST /api/v1/identity/credential` (the `/enroll` page's only backend) answers
 * `503 CREDENTIAL_UNAVAILABLE` with `reason: "no_institution_key"` forever — so a
 * fresh deployment can never issue a student credential. This tool is the step
 * that produces that certificate.
 *
 * ## Where this sits
 *
 *   root key (offline) ──signs──▶ course_cert       (tools/mint-course-cert.ts)
 *   root key (offline) ──signs──▶ institution_cert  (THIS TOOL)
 *                                        │ authorizes
 *                                        ▼
 *                                 institution key   (on the server, in the env)
 *                                        │ signs
 *                                        ▼
 *                                 student_credential (the server, per student)
 *
 * Run this ONCE per deployment (or on institution-key rotation / cert renewal).
 * There is exactly ONE institution key per deployment — a `student_credential`
 * names no course, no semester and no assignment, so there is nothing to key a
 * map by. Course keys are unrelated and unaffected: they keep signing manifests.
 *
 * ## Getting the institution KEYPAIR itself
 *
 * This tool does NOT generate it, and only ever needs its PUBLIC half. There is
 * no dedicated institution-keygen script; the course-keypair generator emits a
 * plain ed25519 keypair in exactly the shape needed, so REUSE IT — the same
 * procedure the root keypair uses:
 *
 *   node --experimental-strip-types tools/generate-course-keypair.ts \
 *     /path/to/institution-keypair.json
 *
 * (positional path only — do NOT pass `--course-id`; that mints a COURSE cert,
 * which is a different artifact). It prints the 64-hex public key on stdout and
 * writes `{ public_key_hex, private_key_hex, generated_at, note }` at mode 0600.
 * The `note` field says "Course offline-signing key" because the generator is
 * shared; that is cosmetic and nothing reads it.
 *
 * Generate it ON THE SERVER (or wherever the API process will run), carry only
 * the public half to the offline root machine, run this tool there, and bring
 * the certificate back. The institution PRIVATE key must never touch the root
 * machine, and the ROOT private key must never touch the server.
 *
 * The server then wants both halves in one variable:
 *
 *   PROVENANCE_INSTITUTION_KEY='{"private_key_hex":"<64 hex from the keypair
 *     file>","cert":<the JSON this tool prints>}'
 *
 * ## Keep the window short
 *
 * There is no offline revocation (program spec §2; recorder PRD NG2), so
 * `--valid-until` is the only control limiting the damage of a stolen
 * institution key — and its blast radius is the whole institution: anyone
 * holding it can bind ANY public key to ANY `student_ref` and forge attribution
 * for as long as the window runs. One academic year is the intended shape.
 *
 * USAGE
 *   node --experimental-strip-types tools/mint-institution-cert.ts \
 *     --institution-id berkeley \
 *     --institution-pubkey <64-hex, from generate-course-keypair.ts stdout> \
 *     --valid-from 2026-08-20 \
 *     --valid-until 2027-08-19 \
 *     [--root-keypair /path/to/root-keypair.json]   (default: .notes/dev-root-keypair.json)
 *     [--out /path/to/institution-cert.json]        (default: print to stdout only)
 *
 * The ROOT private key is the highest-value secret in the system — it authorizes
 * every course AND every institution key. In production it must live offline on
 * a secured machine (see README "Course staff: key & manifest workflow") and
 * this tool must be pointed at that file via `--root-keypair`, never at the dev
 * default.
 *
 * The minted certificate is self-verified against the root public key
 * (`parseInstitutionCert` + `verifyInstitutionCert`, both from
 * `@provenance/log-core`) before being printed or written. A tool that hands out
 * a certificate that fails its own verification is worse than no tool.
 *
 * Nothing secret reaches stdout: the only input this tool holds that must stay
 * secret is the root private key, and it is never printed, echoed, or included
 * in an error message.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  parseInstitutionCert,
  verifyInstitutionCert,
  signInstitutionCert,
  parseIsoInstantMs,
  INSTITUTION_IDENTITY_FORMAT_VERSION,
} from '@provenance/log-core';
import type { InstitutionCert } from '@provenance/log-core';
import { ok, err } from '@provenance/log-core';
import type { Result } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Default root keypair location — the DEV root, same default as mint-course-cert.ts. */
export const DEFAULT_ROOT_KEYPAIR_PATH = path.join(REPO_ROOT, '.notes', 'dev-root-keypair.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MintInstitutionArgs = {
  institutionId: string;
  institutionPubkeyHex: string;
  validFrom: string;
  validUntil: string;
  rootKeypairPath: string;
  outPath: string | null;
};

export type MintInstitutionArgsError = { message: string };

export type StoredRootKeypair = {
  public_key_hex: string;
  private_key_hex: string;
};

export type MintInstitutionError =
  | { kind: 'invalid_input'; message: string }
  | { kind: 'self_verification_failed'; message: string };

const HEX_64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Argument parsing — pure, unit-tested.
// ---------------------------------------------------------------------------

const FLAGS = new Set([
  '--institution-id',
  '--institution-pubkey',
  '--valid-from',
  '--valid-until',
  '--root-keypair',
  '--out',
]);

/**
 * Parse CLI flags for `mint-institution-cert.ts`. Pure — no filesystem, no
 * crypto. `--institution-id`, `--institution-pubkey`, `--valid-from`, and
 * `--valid-until` are required; `--root-keypair` and `--out` are optional.
 */
export function parseMintInstitutionArgs(
  argv: readonly string[],
  defaultRootKeypairPath: string = DEFAULT_ROOT_KEYPAIR_PATH,
): Result<MintInstitutionArgs, MintInstitutionArgsError> {
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

  const institutionId = values['--institution-id'];
  if (institutionId === undefined || institutionId.length === 0) {
    return err({ message: 'Missing required --institution-id <id>' });
  }

  const institutionPubkeyHex = values['--institution-pubkey'];
  if (institutionPubkeyHex === undefined || institutionPubkeyHex.length === 0) {
    return err({ message: 'Missing required --institution-pubkey <64-hex>' });
  }
  if (!HEX_64_RE.test(institutionPubkeyHex)) {
    return err({
      message: `--institution-pubkey must be 64 lowercase hex chars, got ${institutionPubkeyHex.length} chars`,
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
    institutionId,
    institutionPubkeyHex,
    validFrom,
    validUntil,
    rootKeypairPath: values['--root-keypair'] ?? defaultRootKeypairPath,
    outPath: values['--out'] ?? null,
  });
}

// ---------------------------------------------------------------------------
// Minting — pure crypto, no filesystem.
// ---------------------------------------------------------------------------

/**
 * Sign an `InstitutionCert` with the root private key and self-verify the result
 * against the root public key before returning it.
 *
 * `format_version` is set from `INSTITUTION_IDENTITY_FORMAT_VERSION` rather than
 * taken as an argument: it is inside the signed payload, and a tool that can be
 * asked to stamp an arbitrary version is a tool that can mint a certificate no
 * verifier on this branch will route.
 */
export async function mintInstitutionCert(
  unsigned: {
    institutionId: string;
    institutionPubkeyHex: string;
    validFrom: string;
    validUntil: string;
  },
  rootKeypair: StoredRootKeypair,
): Promise<Result<InstitutionCert, MintInstitutionError>> {
  if (!HEX_64_RE.test(rootKeypair.public_key_hex)) {
    return err({
      kind: 'invalid_input',
      message: `Root keypair public_key_hex is malformed (expected 64 lowercase hex chars, got ${rootKeypair.public_key_hex.length})`,
    });
  }
  if (!HEX_64_RE.test(rootKeypair.private_key_hex)) {
    return err({
      kind: 'invalid_input',
      message: `Root keypair private_key_hex is malformed (expected 64 lowercase hex chars, got ${rootKeypair.private_key_hex.length})`,
    });
  }

  const unsignedCert = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: unsigned.institutionId,
    institution_pubkey: unsigned.institutionPubkeyHex,
    valid_from: unsigned.validFrom,
    valid_until: unsigned.validUntil,
  };

  const rootPrivkeyBytes = hexToBytes(rootKeypair.private_key_hex);
  const rootSig = await signInstitutionCert(unsignedCert, rootPrivkeyBytes);
  const cert: InstitutionCert = { ...unsignedCert, root_sig: rootSig };

  // Self-verify before handing it back: shape (parseInstitutionCert) and
  // signature (verifyInstitutionCert against the SAME root pubkey we just
  // signed with).
  const shapeChecked = parseInstitutionCert(cert);
  if (!shapeChecked.ok) {
    return err({
      kind: 'self_verification_failed',
      message: `Minted certificate failed shape validation: ${JSON.stringify(shapeChecked.error)}`,
    });
  }
  const sigChecked = await verifyInstitutionCert(shapeChecked.value, rootKeypair.public_key_hex);
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
  process.stderr.write(`[mint-institution-cert] ${message}\n`);
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
  const parsedArgs = parseMintInstitutionArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    die(
      `${parsedArgs.error.message}\n\n` +
        'Usage: node --experimental-strip-types tools/mint-institution-cert.ts \\\n' +
        '  --institution-id <id> --institution-pubkey <64-hex> \\\n' +
        '  --valid-from <ISO date> --valid-until <ISO date> \\\n' +
        '  [--root-keypair <path>] [--out <path>]',
    );
  }
  const args = parsedArgs.value;

  // Refuse to overwrite. A certificate file is the thing an operator pastes into
  // a deployment secret; silently replacing one is how a rotation gets mixed up
  // with the key it no longer matches.
  if (args.outPath !== null && fs.existsSync(args.outPath)) {
    die(
      `Refusing to overwrite an existing file at ${args.outPath}.\n` +
        'Choose a fresh path, or delete the existing certificate deliberately first.',
    );
  }

  const rootKeypair = loadRootKeypair(args.rootKeypairPath);

  const minted = await mintInstitutionCert(
    {
      institutionId: args.institutionId,
      institutionPubkeyHex: args.institutionPubkeyHex,
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
    process.stderr.write(`[mint-institution-cert] Wrote certificate to ${args.outPath}\n`);
  }

  process.stderr.write(
    `[mint-institution-cert] Minted + self-verified institution certificate for ` +
      `'${args.institutionId}' (root pubkey ${rootKeypair.public_key_hex}).\n` +
      '[mint-institution-cert] Set it on the API server together with the institution PRIVATE\n' +
      '[mint-institution-cert] key that pairs with the public key above:\n' +
      "[mint-institution-cert]   PROVENANCE_INSTITUTION_KEY='{\"private_key_hex\":\"<64 hex>\"," +
      '"cert":<this JSON>}\'\n' +
      '[mint-institution-cert] The certificate is public and travels inside bundles; the private\n' +
      '[mint-institution-cert] key never leaves the server. Restart the API to pick it up.\n',
  );
  process.stdout.write(certJson);
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error('[mint-institution-cert] Fatal error:', e);
    process.exit(1);
  });
}
