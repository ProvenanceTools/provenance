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
  verifiedCertWindow,
} from './manifest-loader.js';

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
      course_id: opts.courseId ?? 'berkeley-cs61b',
      collaboration: 'solo' as const,
      submission: 'bundle' as const,
      scope: 'directory' as const,
      policy: opts.policy ?? {
        capture: {
          selection_change: true,
          focus_change: true,
          terminal: true,
          doc_open_close: true,
          inline_content: true,
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
            doc_open_close: false,
            inline_content: false,
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
        doc_open_close: false,
        inline_content: false,
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
      policy: { capture: { selection_change: false, terminal: false, inline_content: false } },
    });

    const result = await loadAndVerifyManifest(folder, pubkeyHex);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.format_version).toBe('1.0');
      expect(resolveVerifiedCapturePolicy(result.value)).toEqual(DEFAULT_CAPTURE_POLICY);
      expect(verifiedCertWindow(result.value)).toBeNull();
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
