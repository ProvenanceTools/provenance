/**
 * Unit tests for loadAndVerifyManifest.
 * Tests exercise the file-not-found, parse-error, bad-sig, and happy-path branches.
 * CLAUDE.md: "Do not write tests that exercise VS Code APIs from unit tests. Mock at the seam."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';

// We need to import the function under test AND inject our own pubkey.
// loadAndVerifyManifest accepts an optional pubkeyHex argument, which we use here.
import {
  loadAndVerifyManifest,
  resolveVerifiedCapturePolicy,
  resolveVerifiedEnrollmentPolicy,
  verifiedCertWindow,
} from './manifest-loader.js';
import { ROOT_PUBLIC_KEY_HEX, LEGACY_COURSE_PUBLIC_KEY_HEX } from './course-keys.js';

// We also need to produce a canonicalized payload for signing (same logic as log-core).
import {
  canonicalize,
  signCourseCert,
  signManifest as coreSignManifest,
  DEFAULT_CAPTURE_POLICY,
} from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Test keypair generation helpers (inline — no log-core crypto, just noble + node)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  return Buffer.from(hex, 'hex');
}

/**
 * Generate a fresh ed25519 keypair for each test that needs signing.
 * Uses @noble/ed25519 directly (same library log-core uses) so the signature format matches.
 */
async function generateTestKeypair(): Promise<{ pubkeyHex: string; privkeyHex: string }> {
  // noble/ed25519 v3: utils.randomSecretKey() → 32-byte Uint8Array seed
  const secretKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(secretKey);
  return {
    pubkeyHex: bytesToHex(publicKey),
    privkeyHex: bytesToHex(secretKey),
  };
}

/**
 * Sign a .provenance-manifest file payload (the four content fields, JCS-canonicalized) with the given key.
 * Returns the 128-char hex signature.
 */
async function signManifest(
  manifest: {
    assignment_id: string;
    semester: string;
    issued_at: string;
    files_under_review: string[];
  },
  privkeyHex: string,
): Promise<string> {
  const payload = canonicalize({
    assignment_id: manifest.assignment_id,
    semester: manifest.semester,
    issued_at: manifest.issued_at,
    files_under_review: manifest.files_under_review,
  });
  const payloadBytes = new TextEncoder().encode(payload);
  const sigBytes = await ed.signAsync(payloadBytes, hexToBytes(privkeyHex));
  return bytesToHex(sigBytes);
}

// ---------------------------------------------------------------------------
// Minimal vscode.WorkspaceFolder mock
// ---------------------------------------------------------------------------

function makeWorkspaceFolder(fsPath: string): import('vscode').WorkspaceFolder {
  return {
    uri: {
      fsPath,
      scheme: 'file',
      authority: '',
      path: fsPath,
      query: '',
      fragment: '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    name: 'test-workspace',
    index: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadAndVerifyManifest', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns no_manifest_file when neither manifest name exists', async () => {
    const folder = makeWorkspaceFolder(tmpDir);
    const result = await loadAndVerifyManifest(folder, 'a'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('no_manifest_file');
    }
  });

  it('returns manifest_parse_error for malformed JSON', async () => {
    await fs.writeFile(path.join(tmpDir, '.provenance-manifest'), 'not valid json', 'utf8');
    const folder = makeWorkspaceFolder(tmpDir);
    const result = await loadAndVerifyManifest(folder, 'a'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('manifest_parse_error');
    }
  });

  it('returns manifest_parse_error for JSON that fails shape validation (missing sig)', async () => {
    const badManifest = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
      // sig: missing
    };
    await fs.writeFile(
      path.join(tmpDir, '.provenance-manifest'),
      JSON.stringify(badManifest),
      'utf8',
    );
    const folder = makeWorkspaceFolder(tmpDir);
    const result = await loadAndVerifyManifest(folder, 'a'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('manifest_parse_error');
    }
  });

  it('returns manifest_signature_invalid for a manifest with an invalid signature', async () => {
    const { pubkeyHex } = await generateTestKeypair();
    // Use a different key to sign than the one we verify with.
    const { privkeyHex: otherPrivkey } = await generateTestKeypair();

    const manifestData = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const sigHex = await signManifest(manifestData, otherPrivkey);
    const fullManifest = { ...manifestData, sig: sigHex };

    await fs.writeFile(
      path.join(tmpDir, '.provenance-manifest'),
      JSON.stringify(fullManifest),
      'utf8',
    );
    const folder = makeWorkspaceFolder(tmpDir);

    // Verify with pubkeyHex (from a different keypair than the signing key).
    const result = await loadAndVerifyManifest(folder, pubkeyHex);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('manifest_signature_invalid');
    }
  });

  it('returns manifest_signature_invalid for a manifest with a well-formed but wrong sig', async () => {
    const { pubkeyHex } = await generateTestKeypair();
    // All-zeros sig is 128 hex chars of zeros — valid shape, will fail verification.
    const manifest = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
      sig: '0'.repeat(128),
    };

    await fs.writeFile(path.join(tmpDir, '.provenance-manifest'), JSON.stringify(manifest), 'utf8');
    const folder = makeWorkspaceFolder(tmpDir);
    const result = await loadAndVerifyManifest(folder, pubkeyHex);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('manifest_signature_invalid');
    }
  });

  it('returns the parsed manifest when signature is valid', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const manifestData = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const sigHex = await signManifest(manifestData, privkeyHex);
    const fullManifest = { ...manifestData, sig: sigHex };

    await fs.writeFile(
      path.join(tmpDir, '.provenance-manifest'),
      JSON.stringify(fullManifest),
      'utf8',
    );
    const folder = makeWorkspaceFolder(tmpDir);

    const result = await loadAndVerifyManifest(folder, pubkeyHex);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.assignment_id).toBe('hw03');
      expect(result.value.semester).toBe('fa26');
      expect(result.value.files_under_review).toEqual(['hw03.py']);
      expect(result.value.sig).toBe(sigHex);
    }
  });

  it('accepts a plain provenance-manifest (no leading dot) when the dotfile is absent', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const manifestData = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const sigHex = await signManifest(manifestData, privkeyHex);
    const fullManifest = { ...manifestData, sig: sigHex };

    // Only the non-dotfile form exists.
    await fs.writeFile(
      path.join(tmpDir, 'provenance-manifest'),
      JSON.stringify(fullManifest),
      'utf8',
    );
    const folder = makeWorkspaceFolder(tmpDir);

    const result = await loadAndVerifyManifest(folder, pubkeyHex);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.assignment_id).toBe('hw03');
      expect(result.value.sig).toBe(sigHex);
    }
  });

  it('prefers the dotfile form when both manifest names are present', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();

    const dotManifestData = {
      assignment_id: 'hw03-dot',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const dotSig = await signManifest(dotManifestData, privkeyHex);
    await fs.writeFile(
      path.join(tmpDir, '.provenance-manifest'),
      JSON.stringify({ ...dotManifestData, sig: dotSig }),
      'utf8',
    );

    const plainManifestData = {
      assignment_id: 'hw03-plain',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const plainSig = await signManifest(plainManifestData, privkeyHex);
    await fs.writeFile(
      path.join(tmpDir, 'provenance-manifest'),
      JSON.stringify({ ...plainManifestData, sig: plainSig }),
      'utf8',
    );

    const folder = makeWorkspaceFolder(tmpDir);
    const result = await loadAndVerifyManifest(folder, pubkeyHex);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.assignment_id).toBe('hw03-dot');
    }
  });

  it('handles a read error (e.g. directory where file expected) as manifest_read_error', async () => {
    // Create a directory named .provenance-manifest instead of a file.
    await fs.mkdir(path.join(tmpDir, '.provenance-manifest'));
    const folder = makeWorkspaceFolder(tmpDir);
    const result = await loadAndVerifyManifest(folder, 'a'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Reading a directory as a file on Node produces EISDIR or similar.
      expect(['manifest_read_error', 'manifest_parse_error']).toContain(result.error.kind);
    }
  });
});

// ---------------------------------------------------------------------------
// Manifest 2.0 — two-level trust chain (program spec §3)
// ---------------------------------------------------------------------------

describe('loadAndVerifyManifest — Manifest 2.0 trust chain', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-test-2-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function keypair(): Promise<{ pub: string; priv: Uint8Array }> {
    const secretKey = ed.utils.randomSecretKey();
    const publicKey = await ed.getPublicKeyAsync(secretKey);
    return { pub: bytesToHex(publicKey), priv: secretKey };
  }

  /** Build a fully-signed 2.0 manifest: root signs the cert, course signs the payload. */
  async function buildV2Manifest(opts: {
    rootPrivkey: Uint8Array;
    coursePrivkey: Uint8Array;
    coursePubkeyHex: string;
    courseId?: string;
    certCourseId?: string;
    issuedAt?: string;
    policy?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const certBody = {
      course_id: opts.certCourseId ?? opts.courseId ?? 'berkeley-cs61b',
      course_pubkey: opts.coursePubkeyHex,
      valid_from: '2026-08-20',
      valid_until: '2027-01-15',
    };
    const rootSig = await signCourseCert(certBody, opts.rootPrivkey);

    const payload = {
      format_version: '2.0',
      assignment_id: 'proj2',
      semester: 'fa26',
      issued_at: opts.issuedAt ?? '2026-09-08T00:00:00Z',
      files_under_review: ['proj2.py'],
      ignore: [],
      attachments: [],
      course_id: opts.courseId ?? 'berkeley-cs61b',
      collaboration: 'solo' as const,
      submission: 'bundle' as const,
      scope: 'directory' as const,
      policy: opts.policy ?? {
        capture: {
          selection_change: true,
          focus_change: true,
          terminal: true,
          heartbeat_interval_ms: 30000,
        },
      },
      course_cert: { ...certBody, root_sig: rootSig },
    };
    const sig = await coreSignManifest(payload, opts.coursePrivkey);
    return { ...payload, sig };
  }

  async function write(manifest: unknown): Promise<import('vscode').WorkspaceFolder> {
    await fs.writeFile(path.join(tmpDir, '.provenance-manifest'), JSON.stringify(manifest), 'utf8');
    return makeWorkspaceFolder(tmpDir);
  }

  it('activates on a fully valid 2.0 chain, verified against the ROOT key', async () => {
    const root = await keypair();
    const course = await keypair();
    const folder = await write(
      await buildV2Manifest({
        rootPrivkey: root.priv,
        coursePrivkey: course.priv,
        coursePubkeyHex: course.pub,
      }),
    );

    const result = await loadAndVerifyManifest(folder, root.pub);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.format_version).toBe('2.0');
      expect(result.value.course_id).toBe('berkeley-cs61b');
      expect(result.value.course_cert?.course_pubkey).toBe(course.pub);
    }
  });

  it('refuses a 2.0 manifest whose cert is not signed by the embedded root key', async () => {
    const root = await keypair();
    const impostorRoot = await keypair();
    const course = await keypair();
    const folder = await write(
      await buildV2Manifest({
        rootPrivkey: impostorRoot.priv,
        coursePrivkey: course.priv,
        coursePubkeyHex: course.pub,
      }),
    );

    const result = await loadAndVerifyManifest(folder, root.pub);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'manifest_chain_invalid') {
      expect(result.error.detail.kind).toBe('invalid_root_signature');
    } else {
      expect.unreachable('expected manifest_chain_invalid');
    }
  });

  it('refuses a 2.0 manifest whose payload was not signed by the certified course key', async () => {
    const root = await keypair();
    const course = await keypair();
    const otherCourse = await keypair();
    // The cert vouches for `course`, but `otherCourse` signed the payload.
    const folder = await write(
      await buildV2Manifest({
        rootPrivkey: root.priv,
        coursePrivkey: otherCourse.priv,
        coursePubkeyHex: course.pub,
      }),
    );

    const result = await loadAndVerifyManifest(folder, root.pub);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'manifest_chain_invalid') {
      expect(result.error.detail.kind).toBe('invalid_course_signature');
    } else {
      expect.unreachable('expected manifest_chain_invalid');
    }
  });

  it('refuses a 2.0 manifest that claims a course its cert does not cover', async () => {
    const root = await keypair();
    const course = await keypair();
    const folder = await write(
      await buildV2Manifest({
        rootPrivkey: root.priv,
        coursePrivkey: course.priv,
        coursePubkeyHex: course.pub,
        courseId: 'berkeley-cs61c',
        certCourseId: 'berkeley-cs61b',
      }),
    );

    const result = await loadAndVerifyManifest(folder, root.pub);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'manifest_chain_invalid') {
      expect(result.error.detail.kind).toBe('course_id_mismatch');
    } else {
      expect.unreachable('expected manifest_chain_invalid');
    }
  });

  it('STILL ACTIVATES when the cert window has lapsed (program spec §4)', async () => {
    const root = await keypair();
    const course = await keypair();
    const folder = await write(
      await buildV2Manifest({
        rootPrivkey: root.priv,
        coursePrivkey: course.priv,
        coursePubkeyHex: course.pub,
        // A year past valid_until.
        issuedAt: '2028-03-01T00:00:00Z',
      }),
    );

    const result = await loadAndVerifyManifest(folder, root.pub);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(verifiedCertWindow(result.value)).toEqual({
        in_window: false,
        reason: 'after_valid_until',
      });
    }
  });

  it('resolves the signed capture policy for a chain-verified 2.0 manifest', async () => {
    const root = await keypair();
    const course = await keypair();
    const folder = await write(
      await buildV2Manifest({
        rootPrivkey: root.priv,
        coursePrivkey: course.priv,
        coursePubkeyHex: course.pub,
        policy: {
          capture: {
            selection_change: false,
            focus_change: false,
            terminal: false,
            heartbeat_interval_ms: 1_000,
          },
        },
      }),
    );

    const result = await loadAndVerifyManifest(folder, root.pub);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(resolveVerifiedCapturePolicy(result.value)).toEqual({
        selection_change: false,
        focus_change: false,
        terminal: false,
        // Clamped up from 1000 to the [5000, 120000] floor.
        heartbeat_interval_ms: 5_000,
      });
    }
  });

  it('ignores a policy stapled onto a 1.x manifest (the downgrade off-switch)', async () => {
    // A 1.x manifest signs only the four legacy fields, so a student can staple on
    // any `policy` block they like and the signature still verifies. It must never
    // be honoured — program spec §3 step 0.
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const manifestData = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const sigHex = await signManifest(manifestData, privkeyHex);
    const folder = await write({
      ...manifestData,
      sig: sigHex,
      policy: { capture: { selection_change: false, terminal: false } },
    });

    const result = await loadAndVerifyManifest(folder, pubkeyHex);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.format_version).toBe('1.0');
      expect(resolveVerifiedCapturePolicy(result.value)).toEqual(DEFAULT_CAPTURE_POLICY);
      expect(verifiedCertWindow(result.value)).toBeNull();
    }
  });

  it('resolves the signed enrollment policy for a chain-verified 2.0 manifest', async () => {
    const root = await keypair();
    const course = await keypair();
    const folder = await write(
      await buildV2Manifest({
        rootPrivkey: root.priv,
        coursePrivkey: course.priv,
        coursePubkeyHex: course.pub,
        policy: { enrollment: { required: false } },
      }),
    );

    const result = await loadAndVerifyManifest(folder, root.pub);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(resolveVerifiedEnrollmentPolicy(result.value)).toEqual({ required: false });
      // Independent of capture: waiving enrollment changes nothing about what is
      // recorded, and the bundle is byte-identical either way.
      expect(resolveVerifiedCapturePolicy(result.value)).toEqual(DEFAULT_CAPTURE_POLICY);
    }
  });

  it('defaults a 2.0 manifest with no enrollment block to required', async () => {
    const root = await keypair();
    const course = await keypair();
    const folder = await write(
      await buildV2Manifest({
        rootPrivkey: root.priv,
        coursePrivkey: course.priv,
        coursePubkeyHex: course.pub,
        policy: { capture: { terminal: false } },
      }),
    );

    const result = await loadAndVerifyManifest(folder, root.pub);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(resolveVerifiedEnrollmentPolicy(result.value)).toEqual({ required: true });
    }
  });

  it('ignores an enrollment waiver stapled onto a 1.x manifest', async () => {
    // Same downgrade rule as the capture policy: at 1.x the `policy` block is
    // outside the signed payload, so a student could waive their own course's
    // prompting. The knob is a COURSE decision or it is nothing.
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const manifestData = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const sigHex = await signManifest(manifestData, privkeyHex);
    const folder = await write({
      ...manifestData,
      sig: sigHex,
      policy: { enrollment: { required: false } },
    });

    const result = await loadAndVerifyManifest(folder, pubkeyHex);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.format_version).toBe('1.0');
      expect(resolveVerifiedEnrollmentPolicy(result.value)).toEqual({ required: true });
    }
  });

  it('refuses a 1.x manifest with a stapled course_cert (no chain below 2.0)', async () => {
    // Step 0 in reverse: stapling a genuine, root-signed cert onto a 1.x manifest
    // must not buy chain trust. The 1.x path verifies against the embedded key
    // only, and the embedded key is the ROOT key, which never signs a manifest.
    const root = await keypair();
    const course = await keypair();
    const certBody = {
      course_id: 'berkeley-cs61b',
      course_pubkey: course.pub,
      valid_from: '2026-08-20',
      valid_until: '2027-01-15',
    };
    const rootSig = await signCourseCert(certBody, root.priv);

    const manifestData = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const sigHex = await signManifest(manifestData, bytesToHex(course.priv));
    const folder = await write({
      ...manifestData,
      sig: sigHex,
      course_cert: { ...certBody, root_sig: rootSig },
    });

    const result = await loadAndVerifyManifest(folder, root.pub);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('manifest_signature_invalid');
    }
  });
});

// ---------------------------------------------------------------------------
// Legacy course key grandfathering — default routing with NO pubkeyHex override
// (program spec §2, §9; packages/recorder/src/activation/legacy-course-public-key.ts)
//
// Every other test in this file passes an explicit pubkeyHex override, which was
// always used as-is on whichever path the manifest's version selects — that part of
// loadAndVerifyManifest is unchanged. These tests instead call it with NO override,
// exercising the actual default routing: 2.0 -> ROOT_PUBLIC_KEY_HEX,
// 1.x -> LEGACY_COURSE_PUBLIC_KEY_HEX. That requires signing against the real
// embedded dev keys, so they use the checked-in dev private keys (deliberately
// public/insecure — see .notes/dev-keypair.json and .notes/dev-root-keypair.json)
// that pair with the ROOT_PUBLIC_KEY_HEX / LEGACY_COURSE_PUBLIC_KEY_HEX constants.
// ---------------------------------------------------------------------------

describe('loadAndVerifyManifest — legacy course key grandfathering (default routing)', () => {
  let tmpDir: string;

  // From .notes/dev-keypair.json — pairs with LEGACY_COURSE_PUBLIC_KEY_HEX.
  const DEV_LEGACY_COURSE_PRIVATE_KEY_HEX =
    'dbe2e454747b182cfe68ec58816d70e3b7cebbbb7ae303a1550090fa2e276ccf';
  // From .notes/dev-root-keypair.json — pairs with ROOT_PUBLIC_KEY_HEX.
  const DEV_ROOT_PRIVATE_KEY_HEX =
    '50aa5bf96ade428c6f68645b5fc3eedbc8e0c74985a9f0e437bf0e41452ef38b';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-test-legacy-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function write(manifest: unknown): Promise<import('vscode').WorkspaceFolder> {
    await fs.writeFile(path.join(tmpDir, '.provenance-manifest'), JSON.stringify(manifest), 'utf8');
    return makeWorkspaceFolder(tmpDir);
  }

  it('activates a 1.x manifest signed by the legacy course key, with no override', async () => {
    const manifestData = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    const sigHex = await signManifest(manifestData, DEV_LEGACY_COURSE_PRIVATE_KEY_HEX);
    const folder = await write({ ...manifestData, sig: sigHex });

    const result = await loadAndVerifyManifest(folder);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.format_version).toBe('1.0');
      expect(result.value.assignment_id).toBe('hw03');
    }
  });

  it('does NOT activate a 1.x manifest signed by the root key, with no override', async () => {
    const manifestData = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
    };
    // Signed by the ROOT key, not the legacy course key. The 1.x path must reject
    // this: the root key never signs a manifest, and a 1.x manifest's own routing
    // default is the legacy course key, not the root key.
    const sigHex = await signManifest(manifestData, DEV_ROOT_PRIVATE_KEY_HEX);
    const folder = await write({ ...manifestData, sig: sigHex });

    const result = await loadAndVerifyManifest(folder);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('manifest_signature_invalid');
    }
  });

  it('still activates a 2.0 manifest via the root-key chain, with no override', async () => {
    const course = { priv: ed.utils.randomSecretKey() };
    const coursePub = bytesToHex(await ed.getPublicKeyAsync(course.priv));
    const certBody = {
      course_id: 'berkeley-cs61b',
      course_pubkey: coursePub,
      valid_from: '2026-08-20',
      valid_until: '2027-01-15',
    };
    const rootSig = await signCourseCert(certBody, hexToBytes(DEV_ROOT_PRIVATE_KEY_HEX));
    const payload = {
      format_version: '2.0',
      assignment_id: 'proj2',
      semester: 'fa26',
      issued_at: '2026-09-08T00:00:00Z',
      files_under_review: ['proj2.py'],
      ignore: [],
      attachments: [],
      course_id: 'berkeley-cs61b',
      collaboration: 'solo' as const,
      submission: 'bundle' as const,
      scope: 'directory' as const,
      policy: {
        capture: {
          selection_change: true,
          focus_change: true,
          terminal: true,
          heartbeat_interval_ms: 30000,
        },
      },
      course_cert: { ...certBody, root_sig: rootSig },
    };
    const sig = await coreSignManifest(payload, course.priv);
    const folder = await write({ ...payload, sig });

    const result = await loadAndVerifyManifest(folder);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.format_version).toBe('2.0');
      expect(result.value.course_id).toBe('berkeley-cs61b');
    }
  });

  it('sanity-checks the dev private keys against the embedded public constants', async () => {
    // Guards the three tests above against silent bit-rot if either dev keypair file
    // is ever rotated without updating the hardcoded privkeys here.
    const legacyPub = bytesToHex(
      await ed.getPublicKeyAsync(hexToBytes(DEV_LEGACY_COURSE_PRIVATE_KEY_HEX)),
    );
    expect(legacyPub).toBe(LEGACY_COURSE_PUBLIC_KEY_HEX);
    const rootPub = bytesToHex(await ed.getPublicKeyAsync(hexToBytes(DEV_ROOT_PRIVATE_KEY_HEX)));
    expect(rootPub).toBe(ROOT_PUBLIC_KEY_HEX);
  });
});
