/**
 * Tests for sealBundle.
 *
 * Coverage:
 * 1. No .slog files in provenanceDir → no_sessions.
 * 2. provenanceDir does not exist → no_sessions.
 * 3. One valid complete session (session.start + session.end) → ok.
 *    Unzip the result and verify:
 *    - manifest.json exists, parses, validates via validateBundleManifestShape.
 *    - manifest.sig verifies under the supplied sessionPubkeyHex.
 *    - All .slog + .meta files are present in the ZIP.
 *    - slog_sha256 / meta_sha256 in the manifest match the actual file hashes.
 * 4. One session with a broken chain → ok with warnings.chainBroken (always seal).
 * 5. Session with malformed JSON → ok with warnings.unreadableSession (always seal).
 * 6. Bundle ZIP filename contains the assignment_id and a timestamp.
 * 7. Bundle includes present reviewed files at zip root; marks missing ones.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import {
  chainEntry,
  GENESIS_PREV_HASH,
  serializeEntry,
  sha256Hex,
  validateBundleManifestShape,
  canonicalize,
  generateSessionKeypair,
} from '@provenance/log-core';
import type { Envelope, ResolvedScope, BundleManifest } from '@provenance/log-core';
import { sealBundle, verifyManifestSig, sealDroppedArtifacts } from './seal.js';
import type { SealDeps } from './seal.js';

/** A scope that tracks nothing — the pre-path-scope default for most tests here. */
const EMPTY_SCOPE: ResolvedScope = { track: [], ignore: [], attachments: [] };

/** Convenience: a scope that tracks exactly the given exact paths (old filesUnderReview shape). */
function exactScope(paths: readonly string[]): ResolvedScope {
  return { track: paths, ignore: [], attachments: [] };
}

// ---------------------------------------------------------------------------
// Helpers: build fake .slog content
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = '00000000-0000-0000-0000-000000000042';
const TEST_ASSIGNMENT_ID = 'hw03';
const TEST_SEMESTER = 'fa26';

function makeStartEnvelope(
  sessionId: string = TEST_SESSION_ID,
  prevSessionId: string | null = null,
): Envelope<'session.start'> {
  return {
    seq: 0,
    t: 0,
    wall: '2026-01-01T00:00:00.000Z',
    kind: 'session.start',
    data: {
      format_version: '1.0',
      session_id: sessionId,
      prev_session_id: prevSessionId,
      assignment: { id: TEST_ASSIGNMENT_ID, semester: TEST_SEMESTER },
      manifest_sig: 'a'.repeat(128),
      machine_id: 'b'.repeat(64),
      vscode: { version: '1.97.0', commit: '', platform: 'darwin-arm64' },
      recorder: { version: '0.0.0', extension_id: 'itsgeagle.provenance-recorder' },
      session_pubkey: 'c'.repeat(64),
    },
  };
}

function makeEndEnvelope(seq: number): Envelope<'session.end'> {
  return {
    seq,
    t: 1000,
    wall: '2026-01-01T00:10:00.000Z',
    kind: 'session.end',
    data: { reason: 'deactivate' },
  };
}

/**
 * Build a complete, valid two-entry .slog (session.start + session.end).
 */
function buildCompleteSlog(sessionId?: string): string {
  const startEnv = makeStartEnvelope(sessionId);
  const startEntry = chainEntry(GENESIS_PREV_HASH, startEnv, sha256Hex);

  const endEnv = makeEndEnvelope(1);
  const endEntry = chainEntry(startEntry.hash, endEnv, sha256Hex);

  return serializeEntry(startEntry) + serializeEntry(endEntry);
}

/**
 * Build a .slog with a broken chain (second entry has wrong prev_hash).
 */
function buildBrokenChainSlog(): string {
  const startEnv = makeStartEnvelope();
  const startEntry = chainEntry(GENESIS_PREV_HASH, startEnv, sha256Hex);

  const endEnv = makeEndEnvelope(1);
  // Chain with a wrong previous hash to break the chain.
  const endEntry = chainEntry('dead'.repeat(16), endEnv, sha256Hex);

  return serializeEntry(startEntry) + serializeEntry(endEntry);
}

/**
 * SHA-256 of a string (UTF-8).
 */
function sha256OfString(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

// ---------------------------------------------------------------------------
// Helpers: build SealDeps
// ---------------------------------------------------------------------------

async function buildDeps(
  provenanceDir: string,
  outputDir: string,
  keypair: Awaited<ReturnType<typeof generateSessionKeypair>>,
  scope: ResolvedScope = EMPTY_SCOPE,
  scopeCapped = false,
): Promise<SealDeps> {
  return {
    assignmentRoot: outputDir,
    provenanceDir,
    assignmentId: TEST_ASSIGNMENT_ID,
    semester: TEST_SEMESTER,
    scope,
    scopeCapped,
    sessionPrivkey: keypair.privateKey,
    sessionPubkeyHex: keypair.publicKeyHex,
    computeExtensionHash: async () => 'a'.repeat(64),
    outputDir,
    now: () => new Date('2026-05-19T14:30:00.000Z'),
  };
}

// ---------------------------------------------------------------------------
// Workspace helpers for B1/B2 tests (workspace root = outputDir for simplicity)
// ---------------------------------------------------------------------------

/**
 * Build a workspace with a single valid session. Returns deps with
 * workspaceFolder.uri.fsPath pointing at the outputDir (which is also the
 * workspace root used to resolve filesUnderReview).
 * Exposes slogPath for B2's corruption test.
 */
async function makeWorkspaceWithValidSession(): Promise<{
  root: string;
  slogPath: string;
  deps: SealDeps;
}> {
  const keypair = await generateSessionKeypair();
  const slogContent = buildCompleteSlog(TEST_SESSION_ID);
  const slogFilename = 'session-ws.slog';
  const slogPath = path.join(provenanceDir, slogFilename);
  await fsPromises.writeFile(slogPath, slogContent, 'utf8');

  const deps: SealDeps = {
    assignmentRoot: outputDir,
    provenanceDir,
    assignmentId: TEST_ASSIGNMENT_ID,
    semester: TEST_SEMESTER,
    scope: EMPTY_SCOPE,
    scopeCapped: false,
    sessionPrivkey: keypair.privateKey,
    sessionPubkeyHex: keypair.publicKeyHex,
    computeExtensionHash: async () => 'a'.repeat(64),
    outputDir,
    now: () => new Date('2026-05-19T14:30:00.000Z'),
  };
  return { root: outputDir, slogPath, deps };
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let provenanceDir: string;
let outputDir: string;

beforeEach(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'provenance-seal-test-'));
  provenanceDir = path.join(tmpDir, '.provenance');
  outputDir = path.join(tmpDir, 'output');
  await fsPromises.mkdir(provenanceDir, { recursive: true });
  await fsPromises.mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sealBundle', () => {
  it('returns no_sessions when provenanceDir does not exist', async () => {
    const keypair = await generateSessionKeypair();
    const nonExistentDir = path.join(tmpDir, 'does-not-exist');
    const deps = await buildDeps(nonExistentDir, outputDir, keypair);

    const result = await sealBundle(deps);

    expect(result.kind).toBe('no_sessions');
  });

  it('returns no_sessions when provenanceDir has no .slog files', async () => {
    // provenanceDir exists but is empty.
    const keypair = await generateSessionKeypair();
    const deps = await buildDeps(provenanceDir, outputDir, keypair);

    const result = await sealBundle(deps);

    expect(result.kind).toBe('no_sessions');
  });

  it('returns no_sessions when provenanceDir has only non-slog files', async () => {
    await fsPromises.writeFile(path.join(provenanceDir, 'something.txt'), 'not a slog');
    const keypair = await generateSessionKeypair();
    const deps = await buildDeps(provenanceDir, outputDir, keypair);

    const result = await sealBundle(deps);

    expect(result.kind).toBe('no_sessions');
  });

  it('produces a bundle with warnings.chainBroken for a .slog with broken chain', async () => {
    const brokenSlog = buildBrokenChainSlog();
    await fsPromises.writeFile(path.join(provenanceDir, 'session-bad.slog'), brokenSlog, 'utf8');

    const keypair = await generateSessionKeypair();
    const deps = await buildDeps(provenanceDir, outputDir, keypair);

    const result = await sealBundle(deps);

    // Behavior change (spec deliberate): broken chain no longer aborts. Bundle is always sealed.
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.warnings.chainBroken).toBe(true);
    expect(result.warnings.unreadableSession).toBe(false);

    // The bundle is still written and the .slog bytes are included.
    const zip = await JSZip.loadAsync(await fsPromises.readFile(result.bundlePath));
    expect(Object.keys(zip.files).some((n) => n.endsWith('.slog'))).toBe(true);
  });

  it('produces a bundle with warnings.unreadableSession for a .slog with malformed JSON', async () => {
    await fsPromises.writeFile(
      path.join(provenanceDir, 'session-malformed.slog'),
      'not json at all\n',
      'utf8',
    );

    const keypair = await generateSessionKeypair();
    const deps = await buildDeps(provenanceDir, outputDir, keypair);

    const result = await sealBundle(deps);

    // Behavior change (spec deliberate): unreadable session no longer aborts.
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.warnings.unreadableSession).toBe(true);
  });

  it('does NOT pack .provenance/.gitattributes into the bundle', async () => {
    // The recorder writes a `.gitattributes` into `.provenance/` so git cannot
    // rewrite the signed bytes (see `log-core/git-attributes.ts`). The bundle's
    // contents are a CLOSED SET, so packing it would reach `loader/unzip.ts` as
    // `unexpected_file` and kill the whole submission. This test is the guard on
    // that interaction — the prevention fix must not break the seal path.
    const slogContent = buildCompleteSlog(TEST_SESSION_ID);
    const slogFilename = 'session-00000000.slog';
    await fsPromises.writeFile(path.join(provenanceDir, slogFilename), slogContent, 'utf8');
    await fsPromises.writeFile(
      path.join(provenanceDir, `${slogFilename}.meta`),
      JSON.stringify({ format_version: '1.0', session_id: TEST_SESSION_ID }),
      'utf8',
    );
    await fsPromises.writeFile(path.join(provenanceDir, '.gitattributes'), '* -text\n', 'utf8');

    const keypair = await generateSessionKeypair();
    const result = await sealBundle(await buildDeps(provenanceDir, outputDir, keypair));

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const zip = await JSZip.loadAsync(await fsPromises.readFile(result.bundlePath));
    expect(zip.file('.gitattributes')).toBeNull();
    // ...and the session itself is still packed, so the exclusion is narrow.
    expect(zip.file(slogFilename)).not.toBeNull();
  });

  it('produces a valid bundle for a complete session', async () => {
    // Write a valid .slog.
    const slogContent = buildCompleteSlog(TEST_SESSION_ID);
    const slogFilename = 'session-00000000.slog';
    const slogPath = path.join(provenanceDir, slogFilename);
    await fsPromises.writeFile(slogPath, slogContent, 'utf8');

    // Write a companion .meta file.
    const metaFilename = `${slogFilename}.meta`;
    const metaContent = JSON.stringify({ format_version: '1.0', session_id: TEST_SESSION_ID });
    await fsPromises.writeFile(path.join(provenanceDir, metaFilename), metaContent, 'utf8');

    const keypair = await generateSessionKeypair();
    const deps = await buildDeps(provenanceDir, outputDir, keypair);

    const result = await sealBundle(deps);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return; // narrow for TS

    // Verify bundlePath exists on disk.
    await expect(fsPromises.access(result.bundlePath)).resolves.toBeUndefined();

    // Verify the ZIP filename contains assignment_id and timestamp.
    const basename = path.basename(result.bundlePath);
    expect(basename).toContain(TEST_ASSIGNMENT_ID);
    expect(basename).toContain('bundle');
    expect(basename.endsWith('.zip')).toBe(true);

    // -------------------------------------------------------------------
    // Unzip and validate contents.
    // -------------------------------------------------------------------
    const zipBytes = await fsPromises.readFile(result.bundlePath);
    const zip = await JSZip.loadAsync(zipBytes);

    // manifest.json must be present.
    expect(zip.file('manifest.json')).not.toBeNull();

    // manifest.sig must be present.
    expect(zip.file('manifest.sig')).not.toBeNull();

    // .slog file must be present.
    expect(zip.file(slogFilename)).not.toBeNull();

    // .meta file must be present.
    expect(zip.file(metaFilename)).not.toBeNull();

    // -------------------------------------------------------------------
    // Validate manifest shape.
    // -------------------------------------------------------------------
    const manifestRaw = await zip.file('manifest.json')!.async('string');
    const manifestParsed = JSON.parse(manifestRaw) as unknown;
    const shapeResult = validateBundleManifestShape(manifestParsed);

    expect(shapeResult.ok).toBe(true);
    if (!shapeResult.ok) return;

    const manifest = shapeResult.value;
    expect(manifest.format_version).toBe('1.1');
    expect(manifest.assignment_id).toBe(TEST_ASSIGNMENT_ID);
    expect(manifest.semester).toBe(TEST_SEMESTER);
    expect(manifest.extension_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.sessions).toHaveLength(1);
    expect(manifest.sessions[0]!.session_id).toBe(TEST_SESSION_ID);

    // -------------------------------------------------------------------
    // Validate manifest signature.
    // -------------------------------------------------------------------
    const sigHex = await zip.file('manifest.sig')!.async('string');

    // The sig must verify against the canonical manifest JSON.
    const canonicalManifest = canonicalize(manifest);
    const sigValid = await verifyManifestSig(canonicalManifest, sigHex, keypair.publicKeyHex);
    expect(sigValid).toBe(true);

    // -------------------------------------------------------------------
    // Validate slog_sha256 and meta_sha256 in the manifest session entry.
    // -------------------------------------------------------------------
    const session = manifest.sessions[0]!;
    const expectedSlogSha256 = sha256OfString(slogContent);
    expect(session.slog_sha256).toBe(expectedSlogSha256);

    const expectedMetaSha256 = sha256OfString(metaContent);
    expect(session.meta_sha256).toBe(expectedMetaSha256);
  });

  it('signature fails to verify under a different keypair', async () => {
    const slogContent = buildCompleteSlog();
    await fsPromises.writeFile(path.join(provenanceDir, 'session-good.slog'), slogContent, 'utf8');

    const keypair = await generateSessionKeypair();
    const differentKeypair = await generateSessionKeypair();

    const deps = await buildDeps(provenanceDir, outputDir, keypair);
    const result = await sealBundle(deps);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const zipBytes = await fsPromises.readFile(result.bundlePath);
    const zip = await JSZip.loadAsync(zipBytes);

    const manifestRaw = await zip.file('manifest.json')!.async('string');
    const manifest = JSON.parse(manifestRaw) as unknown;
    const sigHex = await zip.file('manifest.sig')!.async('string');

    // Canonical form for verification.
    const shapeResult = validateBundleManifestShape(manifest);
    expect(shapeResult.ok).toBe(true);
    if (!shapeResult.ok) return;
    const canonicalManifest = canonicalize(shapeResult.value);

    // Signature must NOT verify under a different public key.
    const sigValid = await verifyManifestSig(
      canonicalManifest,
      sigHex,
      differentKeypair.publicKeyHex,
    );
    expect(sigValid).toBe(false);
  });

  it('handles a session with no .meta file gracefully (meta_sha256 is sha256 of empty)', async () => {
    const slogContent = buildCompleteSlog();
    const slogFilename = 'session-nometa.slog';
    await fsPromises.writeFile(path.join(provenanceDir, slogFilename), slogContent, 'utf8');
    // Intentionally do NOT write a .meta file.

    const keypair = await generateSessionKeypair();
    const deps = await buildDeps(provenanceDir, outputDir, keypair);
    const result = await sealBundle(deps);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const zipBytes = await fsPromises.readFile(result.bundlePath);
    const zip = await JSZip.loadAsync(zipBytes);

    const manifestRaw = await zip.file('manifest.json')!.async('string');
    const shapeResult = validateBundleManifestShape(JSON.parse(manifestRaw) as unknown);
    expect(shapeResult.ok).toBe(true);
    if (!shapeResult.ok) return;

    // meta_sha256 should be sha256 of '' (empty bytes).
    const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(shapeResult.value.sessions[0]!.meta_sha256).toBe(SHA256_EMPTY);
  });

  it('returns manifestSha256 matching the actual manifest.json content', async () => {
    const slogContent = buildCompleteSlog();
    await fsPromises.writeFile(path.join(provenanceDir, 'session-sha.slog'), slogContent, 'utf8');

    const keypair = await generateSessionKeypair();
    const deps = await buildDeps(provenanceDir, outputDir, keypair);
    const result = await sealBundle(deps);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    // Read the manifest.json from disk (not from the ZIP — it was written atomically).
    const manifestPath = path.join(provenanceDir, 'manifest.json');
    const manifestOnDisk = await fsPromises.readFile(manifestPath, 'utf8');

    // The returned manifestSha256 must match sha256(canonical manifest bytes).
    // Since atomicWriteFile writes the canonical string, sha256(manifestOnDisk) should match.
    const actualSha256 = sha256Hex(new TextEncoder().encode(manifestOnDisk));
    expect(result.manifestSha256).toBe(actualSha256);
  });

  it('uses outputDir from deps (not workspace root) for the ZIP', async () => {
    const slogContent = buildCompleteSlog();
    await fsPromises.writeFile(path.join(provenanceDir, 'session-out.slog'), slogContent, 'utf8');

    const keypair = await generateSessionKeypair();
    const customOutputDir = path.join(tmpDir, 'custom-output');
    await fsPromises.mkdir(customOutputDir, { recursive: true });

    const deps = await buildDeps(provenanceDir, customOutputDir, keypair);
    const result = await sealBundle(deps);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.bundlePath.startsWith(customOutputDir)).toBe(true);
    await expect(fsPromises.access(result.bundlePath)).resolves.toBeUndefined();
  });

  // B1: bundle reviewed files at zip root, mark missing ones
  it('bundles present reviewed files at the zip root and marks missing ones', async () => {
    const ws = await makeWorkspaceWithValidSession();
    // hw03.py lives in the workspace root (= outputDir in test setup).
    await fsPromises.writeFile(path.join(ws.root, 'hw03.py'), 'print(1)\n', 'utf8');

    const result = await sealBundle({
      ...ws.deps,
      scope: exactScope(['hw03.py', 'missing.py']),
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    // No chain/session issues.
    expect(result.warnings.chainBroken).toBe(false);
    expect(result.warnings.unreadableSession).toBe(false);

    const zip = await JSZip.loadAsync(await fsPromises.readFile(result.bundlePath));
    const manifestRaw = await zip.file('manifest.json')!.async('string');
    const manifest = JSON.parse(manifestRaw) as {
      format_version: string;
      submission_files: Array<{
        path: string;
        status: string;
        sha256: string | null;
        role?: string;
      }>;
    };

    // Manifest must be 1.1 with submission_files.
    expect(manifest.format_version).toBe('1.1');
    const byPath = Object.fromEntries(manifest.submission_files.map((f) => [f.path, f]));
    expect(byPath['hw03.py']!.status).toBe('present');
    expect(byPath['hw03.py']!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(byPath['hw03.py']!.role).toBe('reviewed');
    expect(byPath['missing.py']).toEqual({
      path: 'missing.py',
      status: 'missing',
      sha256: null,
      role: 'reviewed',
    });

    // Bytes at the zip root.
    expect(zip.file('hw03.py')).not.toBeNull();
    expect(await zip.file('hw03.py')!.async('string')).toBe('print(1)\n');
    expect(zip.file('missing.py')).toBeNull();
  });

  // B2: still produces a bundle when a slog chain is broken
  it('still produces a bundle when a slog chain is broken, and warns', async () => {
    const ws = await makeWorkspaceWithValidSession();
    await fsPromises.writeFile(path.join(ws.root, 'hw03.py'), 'x=1\n', 'utf8');

    // Corrupt the chain: flip the hash field of the second entry.
    const lines = (await fsPromises.readFile(ws.slogPath, 'utf8')).split('\n').filter(Boolean);
    const obj = JSON.parse(lines[1]!) as Record<string, unknown>;
    obj['hash'] = 'f'.repeat(64); // wrong hash → chain break at this entry
    lines[1] = JSON.stringify(obj);
    await fsPromises.writeFile(ws.slogPath, lines.join('\n') + '\n', 'utf8');

    const result = await sealBundle({ ...ws.deps, scope: exactScope(['hw03.py']) });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.warnings.chainBroken).toBe(true);

    // Bundle still contains the (tampered) slog bytes.
    const zip = await JSZip.loadAsync(await fsPromises.readFile(result.bundlePath));
    expect(Object.keys(zip.files).some((n) => n.endsWith('.slog'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Path scope at seal time
// ---------------------------------------------------------------------------

/**
 * Write a fresh valid single session into `provenanceDir` (the shared
 * per-test tmp dir from the outer `beforeEach`) and the given files under
 * `outputDir` (this suite's stand-in for the workspace/assignment root).
 * Returns the assignment root and a keypair to build SealDeps against.
 */
async function makeWorkspace(
  files: Record<string, string>,
): Promise<{ root: string; keypair: Awaited<ReturnType<typeof generateSessionKeypair>> }> {
  const keypair = await generateSessionKeypair();
  const slogContent = buildCompleteSlog();
  await fsPromises.writeFile(path.join(provenanceDir, 'session-scope.slog'), slogContent, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(outputDir, rel);
    await fsPromises.mkdir(path.dirname(abs), { recursive: true });
    await fsPromises.writeFile(abs, content, 'utf8');
  }
  return { root: outputDir, keypair };
}

/** SealDeps for the path-scope suite: `root` is the assignment root (= workspace). */
function sealDeps(
  ws: { root: string; keypair: Awaited<ReturnType<typeof generateSessionKeypair>> },
  opts: { scope: ResolvedScope; scopeCapped?: boolean },
): SealDeps {
  return {
    assignmentRoot: ws.root,
    provenanceDir,
    assignmentId: TEST_ASSIGNMENT_ID,
    semester: TEST_SEMESTER,
    scope: opts.scope,
    scopeCapped: opts.scopeCapped ?? false,
    sessionPrivkey: ws.keypair.privateKey,
    sessionPubkeyHex: ws.keypair.publicKeyHex,
    computeExtensionHash: async () => 'a'.repeat(64),
    outputDir: ws.root,
    now: () => new Date('2026-05-19T14:30:00.000Z'),
  };
}

/** The sealed manifest.json, read straight off disk (written atomically by sealBundle). */
async function readSealedManifest(): Promise<BundleManifest> {
  const raw = await fsPromises.readFile(path.join(provenanceDir, 'manifest.json'), 'utf8');
  return JSON.parse(raw) as BundleManifest;
}

describe('path scope at seal time', () => {
  it('walks the workspace and seals every rule-matched file with its role', async () => {
    const ws = await makeWorkspace({
      'src/Main.java': 'class Main {}',
      'src/A.class': 'BINARY',
      'logs/run.log': 'output',
      'README.md': 'notes',
    });
    const result = await sealBundle(
      sealDeps(ws, {
        scope: { track: ['src/'], ignore: ['*.class'], attachments: ['logs/'] },
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const manifest = await readSealedManifest();
    const byPath = new Map((manifest.submission_files ?? []).map((f) => [f.path, f]));

    expect(byPath.get('src/Main.java')?.role).toBe('reviewed');
    expect(byPath.get('logs/run.log')?.role).toBe('attachment');
    // ignored and unscoped files are not in the bundle at all
    expect(byPath.has('src/A.class')).toBe(false);
    expect(byPath.has('README.md')).toBe(false);

    // The property that DEFINES an attachment: its bytes are actually sealed
    // into the ZIP, at the workspace-relative path, not just named in the
    // manifest as a role label.
    const zip = await JSZip.loadAsync(await fsPromises.readFile(result.bundlePath));
    expect(zip.file('logs/run.log')).not.toBeNull();
    expect(await zip.file('logs/run.log')!.async('string')).toBe('output');
  });

  it('never seals a hard-excluded path, however greedy the manifest', async () => {
    const ws = await makeWorkspace({
      'src/Main.java': 'x',
      '.provenance/should-not-appear.txt': 'x',
      '.git/objects/pack-abc.pack': 'x',
    });
    await sealBundle(sealDeps(ws, { scope: { track: ['*'], ignore: [], attachments: [] } }));
    const manifest = await readSealedManifest();
    for (const f of manifest.submission_files ?? []) {
      expect(f.path.startsWith('.provenance/')).toBe(false);
      expect(f.path.startsWith('.git/')).toBe(false);
    }
  });

  it('marks an absent EXACT entry missing, and says nothing about rule entries', async () => {
    // R2. A course writing "*.java" asserts nothing about any particular file
    // existing, so a .java file the student did not write is not a fact about
    // the student. Only an exact entry is a claim that can go unmet.
    const ws = await makeWorkspace({ 'Present.java': 'x' });
    await sealBundle(
      sealDeps(ws, {
        scope: { track: ['*.java', 'Required.java'], ignore: [], attachments: [] },
      }),
    );
    const manifest = await readSealedManifest();
    const missing = (manifest.submission_files ?? []).filter((f) => f.status === 'missing');
    expect(missing.map((f) => f.path)).toEqual(['Required.java']);
  });

  it('records scope_capped when the recorder says its registry filled', async () => {
    const ws = await makeWorkspace({ 'a.java': 'x' });
    await sealBundle(
      sealDeps(ws, {
        scope: { track: ['*.java'], ignore: [], attachments: [] },
        scopeCapped: true,
      }),
    );
    expect((await readSealedManifest()).scope_capped).toBe(true);
  });

  it('omits scope_capped entirely when the cap did not bite', async () => {
    const ws = await makeWorkspace({ 'a.java': 'x' });
    await sealBundle(
      sealDeps(ws, {
        scope: { track: ['*.java'], ignore: [], attachments: [] },
        scopeCapped: false,
      }),
    );
    expect('scope_capped' in (await readSealedManifest())).toBe(false);
  });

  it('drops (never reports missing) a walk-discovered file it cannot read, and warns', async () => {
    // A rule entry (`src/`) asserts nothing about any particular file, so a
    // file the walk SAW but could not re-open a moment later (edited away,
    // permission denied, a transient I/O error) must not become a `missing`
    // finding — that would falsely say the student's file is absent AND imply
    // a rule entry can make an existence claim, neither of which is true.
    const ws = await makeWorkspace({ 'src/Locked.java': 'secret' });
    const lockedPath = path.join(ws.root, 'src/Locked.java');
    await fsPromises.chmod(lockedPath, 0o000);
    try {
      const result = await sealBundle(
        sealDeps(ws, { scope: { track: ['src/'], ignore: [], attachments: [] } }),
      );
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.warnings.unreadableInScopeFile).toBe(true);

      const manifest = await readSealedManifest();
      // Not present, not missing — simply absent from the bundle entirely.
      expect((manifest.submission_files ?? []).some((f) => f.path === 'src/Locked.java')).toBe(
        false,
      );
    } finally {
      await fsPromises.chmod(lockedPath, 0o644);
    }
  });

  it('reads an EXACT entry the walk itself cannot classify as a file, instead of declaring it missing', async () => {
    // Existence for an exact entry must be decided by ATTEMPTING the read, not
    // by Set membership in the walk's output. `Dirent.isFile()` is false for a
    // symlink entry (lstat-flavoured, does not follow the link), so the walk
    // never lists `Main.java` here even though `readReviewedFile` opens it
    // successfully — exactly the same shape of bug as a case-folding mismatch
    // on a case-insensitive filesystem (not asserted directly here since that
    // behaviour is OS/filesystem-dependent and would not be portable across
    // CI platforms; the fix is the same attempt-the-read code path either way).
    const ws = await makeWorkspace({ 'real/Target.java': 'class Target {}' });
    const linkPath = path.join(ws.root, 'Main.java');
    await fsPromises.symlink(path.join(ws.root, 'real/Target.java'), linkPath);

    const result = await sealBundle(
      sealDeps(ws, { scope: { track: ['Main.java'], ignore: [], attachments: [] } }),
    );
    expect(result.kind).toBe('ok');

    const manifest = await readSealedManifest();
    const entry = (manifest.submission_files ?? []).find((f) => f.path === 'Main.java');
    expect(entry?.status).toBe('present');
    expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never walks into a NESTED .git/ or .provenance/, wherever it appears', async () => {
    // `isHardExcluded` is root-anchored (pinned by tools/path-scope-vectors.json
    // and hand-reimplemented in two other recorders), so it does not answer this
    // question. Under nested/concurrent multi-assignment recording, a sibling
    // assignment's `.provenance/manifest.json` sitting inside THIS workspace
    // must never be walked into and sealed as this student's evidence, however
    // greedy the manifest's rule is.
    const ws = await makeWorkspace({
      'hw3/.provenance/manifest.json': '{"leaked":true}',
      'vendor/lib/.git/config': 'leaked',
      'src/Main.java': 'x',
    });
    const result = await sealBundle(
      sealDeps(ws, { scope: { track: ['*'], ignore: [], attachments: [] } }),
    );
    expect(result.kind).toBe('ok');

    const manifest = await readSealedManifest();
    const paths = (manifest.submission_files ?? []).map((f) => f.path);
    expect(paths.some((p) => p.includes('/.provenance/'))).toBe(false);
    expect(paths.some((p) => p.includes('/.git/'))).toBe(false);
    // The exclusion is narrow: an ordinary file elsewhere is still sealed.
    expect(paths).toContain('src/Main.java');
  });

  it('warns when an in-scope directory cannot be listed, rather than silently sealing nothing from it', async () => {
    const ws = await makeWorkspace({ 'src/Main.java': 'x' });
    const dirPath = path.join(ws.root, 'src');
    await fsPromises.chmod(dirPath, 0o000);
    try {
      const result = await sealBundle(
        sealDeps(ws, { scope: { track: ['src/'], ignore: [], attachments: [] } }),
      );
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      // Never aborts — the bundle is still produced — but the gap is disclosed.
      expect(result.warnings.unreadableScopeDirectory).toBe(true);
    } finally {
      await fsPromises.chmod(dirPath, 0o755);
    }
  });

  it('does not recurse into a symlinked directory (lstat-flavoured Dirent classification)', async () => {
    // Dirent.isDirectory() does not follow symlinks, so a symlink to a
    // directory (including one pointing back at an ancestor, which would
    // otherwise cycle forever) is classified as neither a directory nor a file
    // by this walk and is simply skipped.
    const ws = await makeWorkspace({ 'real/Nested.java': 'class Nested {}' });
    const cyclePath = path.join(ws.root, 'loop');
    await fsPromises.symlink(ws.root, cyclePath);

    const result = await sealBundle(
      sealDeps(ws, { scope: { track: ['*'], ignore: [], attachments: [] } }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const manifest = await readSealedManifest();
    const paths = (manifest.submission_files ?? []).map((f) => f.path);
    expect(paths).toContain('real/Nested.java');
    // Nothing was walked through the `loop/` symlink at all.
    expect(paths.some((p) => p.startsWith('loop/'))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Fix round 2 regressions
  // ---------------------------------------------------------------------------

  it('drops (never reports missing) an EXACT entry the walk sighted but could not read', async () => {
    // Fix round 2, Important 1. Round 1's fix built the exact-entry loop's
    // skip-set from SUCCESSFUL reads, so a file the walk sighted but could not
    // re-open (chmod 0 here) was absent from that set and fell through to the
    // exact-entry loop, which read-failed again and minted a false `missing`.
    // Every 1.x manifest's files_under_review is nothing BUT exact entries, so
    // this was the whole protection, void. Uses the EXACT-entry form
    // (`track: ['src/Main.java']`), not a rule, because the rule form does not
    // exercise the exact-entry loop's skip-set at all.
    const ws = await makeWorkspace({ 'src/Main.java': 'secret' });
    const lockedPath = path.join(ws.root, 'src/Main.java');
    await fsPromises.chmod(lockedPath, 0o000);
    try {
      const result = await sealBundle(
        sealDeps(ws, { scope: { track: ['src/Main.java'], ignore: [], attachments: [] } }),
      );
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.warnings.unreadableInScopeFile).toBe(true);

      const manifest = await readSealedManifest();
      // Not present, not missing — absent from the bundle entirely, exactly
      // like the rule-entry case round 1 already covered.
      expect((manifest.submission_files ?? []).some((f) => f.path === 'src/Main.java')).toBe(false);
    } finally {
      await fsPromises.chmod(lockedPath, 0o644);
    }
  });

  it('never seals an EXACT entry naming a path inside a nested .git/ or .provenance/', async () => {
    // Fix round 2, Important 2. Round 1's I3 fix pruned the WALK from ever
    // entering a nested .git/.provenance, but an exact track entry reads
    // directly by string and never passes through the walk's pruning — so
    // naming the leak exactly still sealed it.
    const ws = await makeWorkspace({
      'hw3/.provenance/manifest.json': '{"leaked":true}',
    });
    const result = await sealBundle(
      sealDeps(ws, {
        scope: { track: ['hw3/.provenance/manifest.json'], ignore: [], attachments: [] },
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const manifest = await readSealedManifest();
    expect(
      (manifest.submission_files ?? []).some((f) => f.path === 'hw3/.provenance/manifest.json'),
    ).toBe(false);

    // Confirm the bytes never made it into the zip either.
    const zip = await JSZip.loadAsync(await fsPromises.readFile(result.bundlePath));
    expect(zip.file('hw3/.provenance/manifest.json')).toBeNull();
  });

  it('never reads or seals an EXACT entry that resolves outside the workspace root', async () => {
    // Fix round 2, Important 3. `validateScopeEntry` deliberately never runs
    // against a 1.x manifest's files_under_review (1.x parsing must never
    // reject), so a `..`-shaped entry reaches the seal unfiltered. Gated only
    // by the course signature (staff-error/key-compromise, not
    // student-reachable), but the seal must not read outside its own root
    // regardless.
    const ws = await makeWorkspace({ 'src/Main.java': 'x' });
    // A real file OUTSIDE the workspace root, i.e. directly in `tmpDir`.
    await fsPromises.writeFile(path.join(tmpDir, 'ESCAPE.txt'), 'not the students', 'utf8');

    const result = await sealBundle(
      sealDeps(ws, { scope: { track: ['../ESCAPE.txt'], ignore: [], attachments: [] } }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const manifest = await readSealedManifest();
    const entry = (manifest.submission_files ?? []).find((f) => f.path === '../ESCAPE.txt');
    // Reported, if at all, as missing — never as present with the outside
    // file's real bytes/hash.
    expect(entry?.status ?? 'missing').toBe('missing');

    // And definitely not sealed into the zip under any spelling.
    const zip = await JSZip.loadAsync(await fsPromises.readFile(result.bundlePath));
    expect(Object.keys(zip.files).some((n) => n.endsWith('ESCAPE.txt'))).toBe(false);
  });

  it('wires the new scope-walk warnings into sealDroppedArtifacts and its student-facing branch', async () => {
    // Fix round 2, Important 4. `extension.ts`'s two seal-command call sites
    // both gate the "mention this to course staff" warning on
    // `sealDroppedArtifacts(result.warnings)`; this test pins that the two new
    // flags actually participate, not just that they exist on the type.
    expect(
      sealDroppedArtifacts({
        chainBroken: false,
        unreadableSession: false,
        orphanedMeta: false,
        emptySession: false,
        orphanedRollingSeal: false,
        unreadableInScopeFile: true,
        unreadableScopeDirectory: false,
      }),
    ).toBe(true);
    expect(
      sealDroppedArtifacts({
        chainBroken: false,
        unreadableSession: false,
        orphanedMeta: false,
        emptySession: false,
        orphanedRollingSeal: false,
        unreadableInScopeFile: false,
        unreadableScopeDirectory: true,
      }),
    ).toBe(true);
    expect(
      sealDroppedArtifacts({
        chainBroken: false,
        unreadableSession: false,
        orphanedMeta: false,
        emptySession: false,
        orphanedRollingSeal: false,
        unreadableInScopeFile: false,
        unreadableScopeDirectory: false,
      }),
    ).toBe(false);
  });

  it('dedupes an exact entry against a walk-captured file that resolves to the same real path', async () => {
    // Fix round 2, Moderate 5. A symlink lets us exercise the "two spellings,
    // one underlying file" shape portably (case-insensitive-filesystem
    // collisions are the same bug but OS/filesystem-dependent, so not asserted
    // directly — see the round-1 symlink test's comment for the same reasoning).
    const ws = await makeWorkspace({ 'src/Main.java': 'class Main {}' });
    const aliasPath = path.join(ws.root, 'Alias.java');
    await fsPromises.symlink(path.join(ws.root, 'src/Main.java'), aliasPath);

    const result = await sealBundle(
      sealDeps(ws, {
        // `src/` (rule) captures src/Main.java via the walk; `Alias.java`
        // (exact) is a symlink to the SAME underlying bytes.
        scope: { track: ['src/', 'Alias.java'], ignore: [], attachments: [] },
      }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const manifest = await readSealedManifest();
    const present = (manifest.submission_files ?? []).filter((f) => f.status === 'present');
    // Exactly one present record for this file's bytes, not two.
    expect(present).toHaveLength(1);
    expect(present[0]!.path).toBe('src/Main.java');

    const zip = await JSZip.loadAsync(await fsPromises.readFile(result.bundlePath));
    expect(zip.file('src/Main.java')).not.toBeNull();
    expect(zip.file('Alias.java')).toBeNull();
  });
});
