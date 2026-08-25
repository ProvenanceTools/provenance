/**
 * Reads and verifies the manifest file from a workspace folder. The file is named
 * `.provenance-manifest` (canonical) or `provenance-manifest`.
 * PRD §4.1: "If the signature doesn't verify, the extension does nothing."
 *
 * Two verification paths, chosen by `format_version` (program spec §3):
 *
 *  - **2.0** — walk the full trust chain via `verifyManifestChain`: root key signs
 *    the inline `course_cert`, the certified course key signs the payload, and the
 *    two `course_id`s must agree. The manifest's `policy` block is inside the
 *    course-signed payload, so only this path may be trusted to carry one.
 *  - **1.x** — the legacy `verifyManifest` path, byte for byte as it has always
 *    worked, against the grandfathered `LEGACY_COURSE_PUBLIC_KEY_HEX` — 1.x
 *    manifests were signed by the old course key, not the root key, and never
 *    will be reissued for submissions already in the field. 1.x support is
 *    permanent (program spec §9); the legacy key itself is not — see
 *    legacy-course-public-key.ts for its removal condition.
 *
 * The version gate is a security control, not a formality: at 1.x, `course_id` and
 * `policy` are NOT in the signed payload, so a student holding a genuinely signed
 * 1.x manifest could staple on their course's (public, freely copyable) certificate
 * and an invented capture-disabling `policy`. `verifyManifestChain` refuses any
 * manifest below 2.0 for exactly that reason, and `parseManifest` drops 2.0-only
 * fields from a 1.x file so nothing downstream can see the stapled block either.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
  parseManifest,
  verifyManifest,
  verifyManifestChain,
  manifestFormatVersion,
  checkCertWindow,
  resolveCapturePolicy,
  DEFAULT_CAPTURE_POLICY,
  MANIFEST_FORMAT_VERSION_2,
} from '@provenance/log-core';
import type {
  Manifest,
  ManifestChainError,
  CapturePolicy,
  CertWindowStatus,
  Result,
} from '@provenance/log-core';
import { ROOT_PUBLIC_KEY_HEX, LEGACY_COURSE_PUBLIC_KEY_HEX } from './course-keys.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivationError =
  | { kind: 'no_workspace' }
  | { kind: 'no_manifest_file' }
  | { kind: 'manifest_read_error'; message: string }
  | { kind: 'manifest_parse_error'; detail: unknown }
  /** 1.x path: the payload does not verify against the embedded key. */
  | { kind: 'manifest_signature_invalid' }
  /**
   * 2.0 path: the trust chain does not hold. Distinct from
   * `manifest_signature_invalid` so the console line names which link broke —
   * a bad root signature, a bad course signature, and a `course_id` mismatch
   * need very different answers from course staff.
   *
   * An out-of-window certificate is NOT here: it is non-fatal by design (program
   * spec §4) and reported via {@link verifiedCertWindow} instead.
   */
  | { kind: 'manifest_chain_invalid'; detail: ManifestChainError };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Candidate manifest file names, in precedence order. The dotfile form is the
 * canonical name; the plain form is accepted for workspaces (e.g. some archive
 * tools or platforms) that drop or hide leading-dot files.
 */
export const MANIFEST_FILE_NAMES = ['.provenance-manifest', 'provenance-manifest'] as const;

/**
 * Read, parse, and cryptographically verify the manifest file in the given workspace folder.
 * Accepts either `.provenance-manifest` (canonical) or `provenance-manifest`, preferring the
 * former when both are present.
 *
 * @param workspaceFolder  The workspace folder (or folder-like directory) to look in.
 * @param pubkeyHex        Optional override for the embedded verification key (used in
 *                         tests). When omitted, the key is chosen by `format_version`:
 *                         ROOT_PUBLIC_KEY_HEX at 2.0 (the key the `course_cert` must
 *                         chain to) and the grandfathered LEGACY_COURSE_PUBLIC_KEY_HEX
 *                         at 1.x (the key the payload signature is checked against
 *                         directly — see legacy-course-public-key.ts). An explicit
 *                         override, when given, is used as-is on whichever path the
 *                         manifest's version selects.
 *
 * On any error, returns a Result<never, ActivationError> describing what went wrong.
 * Callers should silently exit on any error (PRD §4.1).
 */
/** Minimal structural type — a vscode.WorkspaceFolder already satisfies this. */
export type FolderLike = { uri: { fsPath: string } };

export async function loadAndVerifyManifest(
  workspaceFolder: FolderLike,
  pubkeyHex?: string,
): Promise<Result<Manifest, ActivationError>> {
  // Step 1: Read the file. Try each candidate name in precedence order; only
  // treat the manifest as missing if none of them exist.
  let rawText: string | undefined;
  for (const fileName of MANIFEST_FILE_NAMES) {
    const manifestFilePath = path.join(workspaceFolder.uri.fsPath, fileName);
    try {
      rawText = await fsPromises.readFile(manifestFilePath, 'utf8');
      break;
    } catch (e) {
      const isNotFound =
        e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT';
      if (isNotFound) {
        continue;
      }
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { kind: 'manifest_read_error', message } };
    }
  }

  if (rawText === undefined) {
    return { ok: false, error: { kind: 'no_manifest_file' } };
  }

  // Step 2: Parse JSON + validate shape. parseManifest resolves an absent
  // format_version to '1.0' and drops every 2.0-only field from a 1.x file.
  const parseResult = parseManifest(rawText);
  if (!parseResult.ok) {
    return { ok: false, error: { kind: 'manifest_parse_error', detail: parseResult.error } };
  }
  const manifest = parseResult.value;

  // Step 3: Verify, on the path this manifest's version selects. An explicit
  // pubkeyHex override (tests) applies on whichever path is taken; absent an
  // override, each path has its own trust anchor — they are NOT interchangeable.
  if (isManifest2(manifest)) {
    const chain = await verifyManifestChain(manifest, pubkeyHex ?? ROOT_PUBLIC_KEY_HEX);
    if (!chain.ok) {
      return { ok: false, error: { kind: 'manifest_chain_invalid', detail: chain.error } };
    }
    // chain.value.window is deliberately NOT consulted here. An expired cert must
    // not stop a whole class from recording (program spec §4); the recorder records
    // and the analyzer decides, from the manifest carried in session.start.
    return { ok: true, value: manifest };
  }

  const verifyResult = await verifyManifest(manifest, pubkeyHex ?? LEGACY_COURSE_PUBLIC_KEY_HEX);
  if (!verifyResult.ok) {
    return { ok: false, error: { kind: 'manifest_signature_invalid' } };
  }

  return { ok: true, value: manifest };
}

/**
 * Is this a Manifest 2.0 — i.e. does it take the trust-chain path?
 *
 * Exported because the recorder asks the same question in more than one place and
 * the answer must never be spelled differently in two of them.
 */
export function isManifest2(manifest: Manifest): boolean {
  return manifestFormatVersion(manifest) === MANIFEST_FORMAT_VERSION_2;
}

/**
 * The effective capture policy for a manifest that {@link loadAndVerifyManifest}
 * has ALREADY verified.
 *
 * **Only a 2.0 manifest may carry a policy.** Below 2.0 the `policy` block is not
 * inside the signed payload, so honouring one would hand students the capture off
 * switch that program spec §3 step 0 exists to deny them. This function therefore
 * gates on the format version itself rather than trusting the caller to have done
 * so — a 1.x manifest always resolves to {@link DEFAULT_CAPTURE_POLICY}, which is
 * exactly the v1.x capture set.
 *
 * Never call this on a manifest that has not been verified.
 */
export function resolveVerifiedCapturePolicy(manifest: Manifest): CapturePolicy {
  if (!isManifest2(manifest)) return { ...DEFAULT_CAPTURE_POLICY };
  return resolveCapturePolicy(manifest.policy);
}

/**
 * The certificate validity-window status for a verified 2.0 manifest, or `null`
 * for a 1.x manifest (which has no certificate).
 *
 * Evaluated against `issued_at`, never wall-clock now: "was the cert valid when
 * this manifest was issued" is the only question that still has a stable answer
 * during an adjudication years later. Non-fatal by design — see program spec §4.
 */
export function verifiedCertWindow(manifest: Manifest): CertWindowStatus | null {
  if (!isManifest2(manifest) || manifest.course_cert === undefined) return null;
  return checkCertWindow(manifest.course_cert, manifest.issued_at);
}
