/**
 * WRITE-DIRECTION GATE for the VS Code recorder.
 *
 * The recorder is the REFERENCE implementation of the log format, and until this
 * file it was the only one of the three recorders whose written output was never
 * validated end to end. `packages/recorder/src/commands/seal.test.ts` does drive
 * the real `sealBundle`, but it hand-builds the `.slog` envelopes and then reads
 * the result back with raw JSZip + log-core only. Nothing ever fed a
 * recorder-produced bundle into the analyzer's real loader and validator.
 *
 * This gate closes that. It is a COMPOSITION test: every byte in the bundle is
 * produced by production recorder code —
 *
 *   log-core   generateSessionKeypair / encryptSessionPrivkey   (per-session keys)
 *   recorder   createSessionHost                               (seq + hash chain)
 *   recorder   SessionWriter                                    (.slog bytes)
 *   recorder   MetaWriter                                       (.slog.meta bytes)
 *   recorder   sealBundle                                       (manifest + sig + zip)
 *
 * — and it is then read back by the analyzer's real
 *
 *   analysis-core  loadBundle
 *   analysis-core  runValidation                                (PRD §5.4 checks 1–8)
 *
 * Nothing here reconstructs, stubs, or re-implements any of that. If you find
 * yourself hand-building an envelope or a manifest in this file, you have
 * rebuilt seal.test.ts and lost the point of the gate.
 *
 * ## Why this file lives in tools/ and not in packages/recorder/
 *
 * CLAUDE.md pins the recorder's dependency graph: `log-core`, `vscode`, and a
 * small fixed set of approved libraries. `analysis-core` is deliberately NOT
 * among them, so a test inside `packages/recorder` that imports `analysis-core`
 * — even as a devDependency — would change the graph that CLAUDE.md pins. The
 * mirror option is just as bad: `analysis-core` is lint-enforced isomorphic
 * (no `node:fs`, no `node:path`), and driving `sealBundle` requires both.
 *
 * `tools/` is the repo's established home for exactly this kind of cross-cutting
 * dev-time code, and the precedent is `tools/export-conformance-vectors.ts`,
 * which already spans BOTH graphs in one module using the same technique used
 * here: `analysis-core` by its workspace package specifier, and the recorder by
 * relative path into its build output. `tools/` has no package.json, so neither
 * package acquires a dependency edge and the pinned graph is untouched.
 *
 * ## Requires a build
 *
 * The recorder is imported from `packages/recorder/dist/` — deriving the gate
 * from the SHIPPED code is the whole point, exactly as the conformance exporter
 * does. Run `npm run build` first.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  FixedClock,
  canonicalize,
  chainEntry,
  generateSessionKeypair,
  encryptSessionPrivkey,
  serializeEntry,
  signCheckpoint,
} from '@provenance/log-core';
import type { SessionKeypair } from '@provenance/log-core';

// The analyzer's REAL read path.
import { loadBundle, runValidation } from '@provenance/analysis-core';
import type { ValidationCheckId } from '@provenance/analysis-core';

// The recorder's REAL write path, from its build output.
import { createSessionHost } from '../packages/recorder/dist/session/session-host.js';
import { SessionWriter } from '../packages/recorder/dist/io/session-writer.js';
import { MetaWriter } from '../packages/recorder/dist/io/meta-writer.js';
import { sealBundle } from '../packages/recorder/dist/commands/seal.js';
import { writeRollingSeal } from '../packages/recorder/dist/io/rolling-seal-writer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSIGNMENT_ID = 'hw03';
const SEMESTER = 'fa26';
/** Shared across every session in a bundle — validation check 2 requires equality. */
const MANIFEST_SIG = 'a'.repeat(128);
const EXTENSION_HASH = 'e'.repeat(64);

/** PRD §5.4 checks 1–8, in spec order. */
const EXPECTED_CHECK_IDS: ValidationCheckId[] = [
  'manifest_sig',
  'session_binding',
  'chain_integrity',
  'seq_gaps',
  'monotonic_t',
  'monotonic_wall',
  'doc_save_hashes',
  'submitted_code_match',
];

/**
 * Bundle-level tamper detections — NOT among the PRD §5.4 eight.
 *
 * They ride on `ValidationReport.bundleDetections` rather than in `checks`,
 * because the eight are a frozen persisted contract (the server has eight
 * `check_N_status` columns and asserts `checks.length === 8`). They enforce the
 * two commitments the format always made and never checked: the signed
 * manifest's `slog_sha256` / `meta_sha256`, and the signed `.slog.meta`
 * checkpoints.
 */
const EXPECTED_DETECTION_IDS: ValidationCheckId[] = [
  'log_bytes_match',
  'checkpoint_chain_valid',
  'manifest_downgrade',
];

function sha256OfString(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

/** A deterministic v4-shaped uuid, so `session-<uuid>.slog` matches the loader's regex. */
function uuid(n: number): string {
  const h = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
}

// ---------------------------------------------------------------------------
// The write direction: drive the recorder's real session pipeline.
// ---------------------------------------------------------------------------

type RecordedSession = {
  sessionId: string;
  keypair: SessionKeypair;
  /** Final content per workspace-relative path, as the recording left it. */
  finalContent: Map<string, string>;
};

/**
 * Record one real session into `provenanceDir`, using the recorder's own
 * SessionHost + SessionWriter + MetaWriter.
 *
 * The event script is deliberately a realistic minimum that still exercises
 * every check: doc.open seeds check 7's reconstruction with inline content,
 * doc.change mutates it, and doc.save pins the resulting hash — which is also
 * what check 8 compares the sealed bytes against.
 */
async function recordSession(opts: {
  provenanceDir: string;
  sessionId: string;
  prevSessionId: string | null;
  /** workspace-relative path -> { initial, append } */
  files: Array<{ path: string; initial: string; append: string }>;
}): Promise<RecordedSession> {
  const { provenanceDir, sessionId, prevSessionId, files } = opts;

  // Real per-session keypair (PRD §4.6). This is the key whose PRIVATE half
  // signs the bundle manifest and whose PUBLIC half is recorded inside
  // session.start — validation check 1 verifies the seal signature against the
  // pubkey it finds in session.start, so these two MUST be the same key. That
  // identity is precisely what seal.test.ts cannot check, because it writes a
  // placeholder pubkey into its hand-built session.start.
  const keypair = await generateSessionKeypair();
  const encryptedPrivkey = await encryptSessionPrivkey(keypair.privateKey, MANIFEST_SIG, sessionId);

  const slogPath = path.join(provenanceDir, `session-${sessionId}.slog`);

  const clock = new FixedClock(0, new Date('2026-05-19T14:00:00.000Z'));
  const writer = await SessionWriter.open({ slogPath, clock });
  const meta = await MetaWriter.create({
    metaPath: `${slogPath}.meta`,
    sessionId,
    sessionPubkeyHex: keypair.publicKeyHex,
    encryptedPrivkey,
  });

  const host = createSessionHost({
    sessionId,
    clock,
    onEntry: (entry) => writer.append(entry),
  });

  host.emit('session.start', {
    format_version: '1.0',
    session_id: sessionId,
    prev_session_id: prevSessionId,
    assignment: { id: ASSIGNMENT_ID, semester: SEMESTER },
    manifest_sig: MANIFEST_SIG,
    machine_id: 'b'.repeat(64),
    vscode: { version: '1.100.0', commit: '', platform: 'darwin-arm64' },
    recorder: { version: '1.2.0', extension_id: 'itsgeagle.provenance-recorder' },
    session_pubkey: keypair.publicKeyHex,
  });

  const finalContent = new Map<string, string>();

  for (const f of files) {
    clock.advance(1000);
    host.emit('doc.open', {
      path: f.path,
      sha256: sha256OfString(f.initial),
      line_count: f.initial.split('\n').length,
      content: f.initial,
    });

    // Append at the very end of the initial content. Check 7 replays this
    // delta against the doc.open seed and must land on the doc.save hash.
    const lines = f.initial.split('\n');
    const endLine = lines.length - 1;
    const endChar = lines[endLine]!.length;

    clock.advance(1000);
    host.emit('doc.change', {
      path: f.path,
      deltas: [
        {
          range: {
            start: { line: endLine, character: endChar },
            end: { line: endLine, character: endChar },
          },
          text: f.append,
        },
      ],
      source: 'typed',
    });

    const final = f.initial + f.append;
    finalContent.set(f.path, final);

    clock.advance(1000);
    const saved = host.emit('doc.save', { path: f.path, sha256: sha256OfString(final) });

    // Checkpoint through the real MetaWriter, signed with the real session key
    // via log-core's real signCheckpoint (PRD §4.6).
    if (saved !== null) {
      await meta.appendCheckpoint(await signCheckpoint(saved.seq, saved.hash, keypair.privateKey));
    }
  }

  clock.advance(1000);
  host.emit('session.end', { reason: 'deactivate' });

  await writer.flush();
  await writer.dispose();
  await meta.dispose();

  return { sessionId, keypair, finalContent };
}

/** Materialize the recording's final content on disk, so seal reads real bytes. */
async function writeWorkspaceFiles(
  root: string,
  content: Map<string, string>,
  skip: Set<string> = new Set(),
): Promise<void> {
  for (const [rel, text] of content) {
    if (skip.has(rel)) continue;
    const abs = path.join(root, rel);
    await fsPromises.mkdir(path.dirname(abs), { recursive: true });
    await fsPromises.writeFile(abs, text, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// The read direction: the analyzer's real loader + validator.
// ---------------------------------------------------------------------------

type Verified = {
  bundlePath: string;
  report: Awaited<ReturnType<typeof runValidation>>;
  bundle: Extract<Awaited<ReturnType<typeof loadBundle>>, { ok: true }>['value'];
};

/**
 * Read a sealed zip off disk and run it through the real loader + validator.
 *
 * Node's `Blob` is not readable by JSZip (it needs the browser FileReader), so
 * an ArrayBuffer is passed — the same thing the server does. `loadBundle`
 * accepts either.
 */
async function loadAndValidate(bundlePath: string): Promise<Verified> {
  const bytes = await fsPromises.readFile(bundlePath);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  const loaded = await loadBundle(buf, path.basename(bundlePath), () => '2026-05-19T15:00:00.000Z');
  if (!loaded.ok) {
    throw new Error(`loadBundle failed: ${JSON.stringify(loaded.error)}`);
  }

  const report = await runValidation(loaded.value);
  return { bundlePath, report, bundle: loaded.value };
}

/** Assert every one of the 8 checks passed, with a readable diff when not. */
function expectAllChecksPass(report: Verified['report']): void {
  const summary = report.checks.map(
    (c) => `${c.id}=${c.status}${c.detail ? ` (${c.detail})` : ''}`,
  );
  expect(report.checks.map((c) => c.id)).toEqual(EXPECTED_CHECK_IDS);
  expect(summary.filter((s) => !s.includes('=pass'))).toEqual([]);
  expect(report.overall).toBe('pass');
}

// ---------------------------------------------------------------------------
// Scenario builder
// ---------------------------------------------------------------------------

type SealedScenario = {
  root: string;
  provenanceDir: string;
  sessions: RecordedSession[];
  bundlePath: string;
  manifestSha256: string;
};

/**
 * Record N sessions (chained by prev_session_id), materialize the workspace,
 * and seal — all through production code.
 *
 * `omitFromDisk` lets a scenario exercise a `files_under_review` entry that is
 * absent at seal time, which is the 'missing' branch of the manifest's
 * submission_files.
 */
async function buildSealedBundle(opts: {
  root: string;
  sessionCount: number;
  files: Array<{ path: string; initial: string; append: string }>;
  filesUnderReview?: string[];
  omitFromDisk?: string[];
}): Promise<SealedScenario> {
  const { root, sessionCount, files, omitFromDisk = [] } = opts;
  const provenanceDir = path.join(root, '.provenance');
  await fsPromises.mkdir(provenanceDir, { recursive: true });

  const sessions: RecordedSession[] = [];
  let prev: string | null = null;
  for (let i = 0; i < sessionCount; i++) {
    const sessionId = uuid(i + 1);
    // Ordered on purpose: each session's prev_session_id points at the previous
    // one, which is the chain the manifest is expected to reproduce.
    const recorded = await recordSession({
      provenanceDir,
      sessionId,
      prevSessionId: prev,
      // Later sessions keep editing the same files, so the LAST session's
      // doc.save is the hash check 8 must land on.
      files: files.map((f) => ({ ...f, append: `${f.append}// session ${i + 1}\n` })),
    });
    sessions.push(recorded);
    prev = sessionId;
  }

  // The final on-disk state is whatever the last session recorded.
  const finalContent = sessions[sessions.length - 1]!.finalContent;
  await writeWorkspaceFiles(root, finalContent, new Set(omitFromDisk));

  const filesUnderReview = opts.filesUnderReview ?? [...finalContent.keys()];

  const result = await sealBundle({
    assignmentRoot: root,
    provenanceDir,
    assignmentId: ASSIGNMENT_ID,
    semester: SEMESTER,
    filesUnderReview,
    // The seal signs with the ACTIVE (most recent) session's private key.
    sessionPrivkey: sessions[sessions.length - 1]!.keypair.privateKey,
    sessionPubkeyHex: sessions[sessions.length - 1]!.keypair.publicKeyHex,
    computeExtensionHash: async () => EXTENSION_HASH,
    outputDir: root,
    now: () => new Date('2026-05-19T14:30:00.000Z'),
  });

  if (result.kind !== 'ok') {
    throw new Error(`sealBundle did not succeed: ${JSON.stringify(result)}`);
  }
  expect(result.warnings).toEqual({ chainBroken: false, unreadableSession: false });

  return {
    root,
    provenanceDir,
    sessions,
    bundlePath: result.bundlePath,
    manifestSha256: result.manifestSha256,
  };
}

// ---------------------------------------------------------------------------
// Temp dirs
// ---------------------------------------------------------------------------

let tmpRoots: string[] = [];

async function makeRoot(label: string): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `prov-seal-${label}-`));
  tmpRoots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tmpRoots) {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
  tmpRoots = [];
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe('recorder seal → analysis-core load + validate (write-direction gate)', () => {
  describe('single-session bundle', () => {
    let scenario: SealedScenario;
    let verified: Verified;

    beforeAll(async () => {
      const root = await makeRoot('single');
      scenario = await buildSealedBundle({
        root,
        sessionCount: 1,
        files: [{ path: 'main.py', initial: 'def solve():\n    pass\n', append: 'solve()\n' }],
      });
      verified = await loadAndValidate(scenario.bundlePath);
    });

    it('loads cleanly through the real loadBundle', () => {
      expect(verified.bundle.sessions).toHaveLength(1);
      expect(verified.bundle.manifest.format_version).toBe('1.1');
      expect(verified.bundle.manifest.assignment_id).toBe(ASSIGNMENT_ID);
      expect(verified.bundle.manifest.semester).toBe(SEMESTER);
      expect(verified.bundle.manifest.extension_hash).toBe(EXTENSION_HASH);
    });

    it('passes all 8 validation checks', () => {
      expectAllChecksPass(verified.report);
    });

    it('satisfies the bundle-level tamper detections the manifest commits to', () => {
      // The signed manifest's log-byte digests and the signed .slog.meta
      // checkpoints, both produced by real recorder code, must verify against
      // the analyzer's real readers. A recorder that wrote a digest it did not
      // honour, or a checkpoint that did not verify, would fail here.
      const report = verified.report;
      expect((report.bundleDetections ?? []).map((c) => c.id)).toEqual(EXPECTED_DETECTION_IDS);

      expect(detectionStatusOf(report, 'log_bytes_match')).toBe('pass');
      expect(detectionStatusOf(report, 'checkpoint_chain_valid')).toBe('pass');
      // No embedded assignment manifest in this fixture, so nothing to inspect.
      expect(detectionStatusOf(report, 'manifest_downgrade')).toBe('skipped');
    });

    it('binds the sealed manifest signature to the pubkey inside session.start', () => {
      // The heart of the gate. seal.test.ts verifies the signature against the
      // pubkey it passes in as a dep; the analyzer verifies against the pubkey
      // recorded in session.start. Only the second one proves the recorder wrote
      // a self-consistent bundle.
      const recorded = verified.bundle.sessions[0]!.firstEvent.data.session_pubkey;
      expect(recorded).toBe(scenario.sessions[0]!.keypair.publicKeyHex);

      const check1 = verified.report.checks.find((c) => c.id === 'manifest_sig')!;
      expect(check1.status).toBe('pass');
      expect(check1.detail).toContain(scenario.sessions[0]!.sessionId);
    });

    it('reproduces the on-disk log hashes in the signed manifest', () => {
      // The manifest's slog_sha256 / meta_sha256 must describe the bytes the
      // SessionWriter and MetaWriter actually wrote.
      expect(scenario.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
      const entry = verified.bundle.manifest.sessions[0]!;
      expect(entry.session_id).toBe(scenario.sessions[0]!.sessionId);
      expect(entry.slog_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.meta_sha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('multi-session bundle with a prev_session_id chain', () => {
    let scenario: SealedScenario;
    let verified: Verified;

    beforeAll(async () => {
      const root = await makeRoot('multi');
      scenario = await buildSealedBundle({
        root,
        sessionCount: 3,
        files: [{ path: 'src/solution.js', initial: 'const a = 1;\n', append: 'const b = 2;\n' }],
      });
      verified = await loadAndValidate(scenario.bundlePath);
    });

    it('loads all three sessions', () => {
      expect(verified.bundle.sessions).toHaveLength(3);
    });

    it('records an unbroken prev_session_id chain in the signed manifest', () => {
      const bySession = new Map(
        verified.bundle.manifest.sessions.map((s) => [s.session_id, s.prev_session_id]),
      );
      expect(bySession.get(uuid(1))).toBeNull();
      expect(bySession.get(uuid(2))).toBe(uuid(1));
      expect(bySession.get(uuid(3))).toBe(uuid(2));
    });

    it('passes all 8 validation checks', () => {
      expectAllChecksPass(verified.report);
    });

    it('verifies the seal against the most recent session key', () => {
      const check1 = verified.report.checks.find((c) => c.id === 'manifest_sig')!;
      expect(check1.detail).toContain(uuid(3));
    });
  });

  describe('files_under_review with a present file and a missing one', () => {
    let verified: Verified;

    beforeAll(async () => {
      const root = await makeRoot('missing');
      const scenario = await buildSealedBundle({
        root,
        sessionCount: 1,
        files: [
          { path: 'present.py', initial: 'x = 1\n', append: 'y = 2\n' },
          { path: 'gone.py', initial: 'z = 3\n', append: 'w = 4\n' },
        ],
        // Recorded, but deleted before seal — the student removed it.
        omitFromDisk: ['gone.py'],
      });
      verified = await loadAndValidate(scenario.bundlePath);
    });

    it('marks the present file present and the absent file missing', () => {
      const files = verified.bundle.manifest.submission_files!;
      const byPath = new Map(files.map((f) => [f.path, f]));

      expect(byPath.get('present.py')!.status).toBe('present');
      expect(byPath.get('present.py')!.sha256).toMatch(/^[0-9a-f]{64}$/);

      expect(byPath.get('gone.py')!.status).toBe('missing');
      expect(byPath.get('gone.py')!.sha256).toBeNull();
    });

    it('omits the missing file from the zip but keeps the present one', async () => {
      const zip = await JSZip.loadAsync(await fsPromises.readFile(verified.bundlePath));
      expect(zip.file('present.py')).not.toBeNull();
      expect(zip.file('gone.py')).toBeNull();
    });

    it('passes all 8 checks — a missing file is skipped, not a failure', () => {
      // Check 8 fails only on a genuine mismatch. A file listed in
      // files_under_review but absent at seal time yields 'unknown' for that
      // file, and the check still passes on the strength of the present one.
      expectAllChecksPass(verified.report);
      const check8 = verified.report.checks.find((c) => c.id === 'submitted_code_match')!;
      expect(check8.detail).toContain('1 submitted file(s) match');
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation tests — prove the gate actually bites.
//
// Each case takes a REAL sealed bundle, corrupts exactly one thing inside the
// zip, and asserts that the specific check responsible goes red. A gate that
// passes a corrupted bundle is worse than no gate.
// ---------------------------------------------------------------------------

/** Rewrite one entry of a sealed zip and return the mutated bytes. */
async function mutateZip(
  bundlePath: string,
  mutate: (zip: JSZip) => Promise<void> | void,
): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(await fsPromises.readFile(bundlePath));
  await mutate(zip);
  const out = await zip.generateAsync({ type: 'nodebuffer' });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

async function validateMutated(buf: ArrayBuffer): Promise<Verified['report']> {
  const loaded = await loadBundle(buf, 'mutated.zip', () => '2026-05-19T15:00:00.000Z');
  if (!loaded.ok) {
    throw new Error(`loadBundle failed: ${JSON.stringify(loaded.error)}`);
  }
  return runValidation(loaded.value);
}

function statusOf(report: Verified['report'], id: ValidationCheckId): string {
  return report.checks.find((c) => c.id === id)!.status;
}

/** Status of a bundle-level detection (report.bundleDetections). */
function detectionStatusOf(report: Verified['report'], id: ValidationCheckId): string {
  const found = (report.bundleDetections ?? []).find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(
      `no bundle-level detection '${id}' in report; got ` +
        `[${(report.bundleDetections ?? []).map((c) => c.id).join(', ')}]`,
    );
  }
  return found.status;
}

describe('mutation tests: a corrupted recorder bundle must be caught', () => {
  let bundlePath: string;
  let slogName: string;

  beforeAll(async () => {
    const root = await makeRoot('mutate');
    const scenario = await buildSealedBundle({
      root,
      sessionCount: 1,
      files: [
        {
          path: 'main.py',
          initial: 'def f():\n    return 1\n',
          append: 'print(f())\n',
        },
      ],
    });
    bundlePath = scenario.bundlePath;
    slogName = `session-${scenario.sessions[0]!.sessionId}.slog`;

    // Sanity: the un-mutated bundle is green, so every red below is caused by
    // the mutation and not by a broken fixture.
    const clean = await loadAndValidate(bundlePath);
    expectAllChecksPass(clean.report);
  });

  it('flipping a byte in manifest.sig fails check 1 (manifest_sig)', async () => {
    const buf = await mutateZip(bundlePath, async (zip) => {
      const sig = await zip.file('manifest.sig')!.async('string');
      // Flip the first hex nibble — still valid hex, so this tests the
      // signature check and not the hex parser.
      const flipped = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
      zip.file('manifest.sig', flipped);
    });
    const report = await validateMutated(buf);
    expect(statusOf(report, 'manifest_sig')).toBe('fail');
    expect(report.overall).toBe('fail');
  });

  it('mutating the signed manifest body fails check 1 (manifest_sig)', async () => {
    const buf = await mutateZip(bundlePath, async (zip) => {
      const raw = await zip.file('manifest.json')!.async('string');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed['extension_hash'] = 'f'.repeat(64);
      zip.file('manifest.json', JSON.stringify(parsed));
    });
    const report = await validateMutated(buf);
    expect(statusOf(report, 'manifest_sig')).toBe('fail');
  });

  it('tampering an entry payload fails check 3 (chain_integrity)', async () => {
    // Check 3's actual contract: an entry is broken iff
    // sha256(prev_hash + canonical(entry without hash)) != entry.hash. So edit
    // the payload and leave the hash field alone.
    const buf = await mutateZip(bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const idx = lines.findIndex((l) => (JSON.parse(l) as { kind: string }).kind === 'doc.change');
      const entry = JSON.parse(lines[idx]!) as { data: { deltas: Array<{ text: string }> } };
      entry.data.deltas[0]!.text = 'tampered\n';
      lines[idx] = JSON.stringify(entry);
      zip.file(slogName, `${lines.join('\n')}\n`);
    });
    const report = await validateMutated(buf);
    expect(statusOf(report, 'chain_integrity')).toBe('fail');
    expect(report.overall).toBe('fail');
  });

  it('dropping an entry from the chain is caught by checks 4 and 7', async () => {
    // NOTE the division of labour, which this gate pins deliberately.
    //
    // Check 3 does NOT catch a deleted entry, and that is by design:
    // `verify-chain.ts` validates each entry against its OWN `prev_hash` rather
    // than against a tracked running hash, specifically so that entries after a
    // gap are not cascade-reported. Every surviving entry therefore still
    // self-verifies and check 3 reports `pass`.
    //
    // The deletion is caught instead by check 4 (the seq becomes
    // non-contiguous) and, here, by check 7 (the removed doc.change no longer
    // replays into the recorded doc.save hash). `overall` is `fail`, which is
    // what actually matters — but asserting the specific checks documents WHERE
    // the tamper-evidence lives, so a future refactor cannot quietly move it.
    const buf = await mutateZip(bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      lines.splice(2, 1);
      zip.file(slogName, `${lines.join('\n')}\n`);
    });
    const report = await validateMutated(buf);
    expect(statusOf(report, 'seq_gaps')).toBe('fail');
    expect(statusOf(report, 'doc_save_hashes')).toBe('fail');
    expect(statusOf(report, 'chain_integrity')).toBe('pass');
    expect(report.overall).toBe('fail');
  });

  it('skewing a seq fails check 4 (seq_gaps)', async () => {
    const buf = await mutateZip(bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const entry = JSON.parse(lines[3]!) as Record<string, unknown>;
      entry['seq'] = (entry['seq'] as number) + 5;
      lines[3] = JSON.stringify(entry);
      zip.file(slogName, `${lines.join('\n')}\n`);
    });
    const report = await validateMutated(buf);
    expect(statusOf(report, 'seq_gaps')).toBe('fail');
  });

  it('rewinding t fails check 5 (monotonic_t)', async () => {
    const buf = await mutateZip(bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const entry = JSON.parse(lines[3]!) as Record<string, unknown>;
      entry['t'] = -1;
      lines[3] = JSON.stringify(entry);
      zip.file(slogName, `${lines.join('\n')}\n`);
    });
    const report = await validateMutated(buf);
    expect(statusOf(report, 'monotonic_t')).toBe('fail');
  });

  it('rewinding wall fails check 6 (monotonic_wall)', async () => {
    const buf = await mutateZip(bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const entry = JSON.parse(lines[3]!) as Record<string, unknown>;
      entry['wall'] = '2000-01-01T00:00:00.000Z';
      lines[3] = JSON.stringify(entry);
      zip.file(slogName, `${lines.join('\n')}\n`);
    });
    const report = await validateMutated(buf);
    expect(statusOf(report, 'monotonic_wall')).toBe('fail');
  });

  it('corrupting a doc.save hash fails check 7 (doc_save_hashes)', async () => {
    const buf = await mutateZip(bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const idx = lines.findIndex((l) => (JSON.parse(l) as { kind: string }).kind === 'doc.save');
      const entry = JSON.parse(lines[idx]!) as { data: { sha256: string } };
      entry.data.sha256 = 'd'.repeat(64);
      lines[idx] = JSON.stringify(entry);
      zip.file(slogName, `${lines.join('\n')}\n`);
    });
    const report = await validateMutated(buf);
    expect(statusOf(report, 'doc_save_hashes')).toBe('fail');
  });

  it('editing a submitted file after seal fails check 8 (submitted_code_match)', async () => {
    // The bytes in the zip no longer hash to the sha256 recorded for them in
    // the signed manifest — the tamper sub-check of check 8.
    const buf = await mutateZip(bundlePath, (zip) => {
      zip.file('main.py', 'print("not what was recorded")\n');
    });
    const report = await validateMutated(buf);
    expect(statusOf(report, 'submitted_code_match')).toBe('fail');
    expect(report.overall).toBe('fail');
  });

  /** Append a well-formed, correctly re-chained entry to the sealed .slog. */
  async function appendWellFormedEntry(): Promise<ArrayBuffer> {
    return mutateZip(bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]!) as {
        seq: number;
        t: number;
        wall: string;
        hash: string;
      };
      const appended = chainEntry(last.hash, {
        seq: last.seq + 1,
        t: last.t + 1000,
        wall: new Date(new Date(last.wall).getTime() + 1000).toISOString(),
        kind: 'session.heartbeat',
        data: { focused: true, active_file: null, idle_since_ms: 0 },
      });
      zip.file(slogName, `${lines.join('\n')}\n${serializeEntry(appended)}`);
    });
  }

  it('CHARACTERIZATION: appending a well-formed entry is still not caught by any of the 8 checks', async () => {
    // UNCHANGED, and deliberately so. The eight are a frozen persisted
    // contract, and this records that they do not — and still do not — catch
    // an append. The appended entry is chained with log-core's real
    // `chainEntry`, so it self-verifies (check 3), keeps seq contiguous
    // (check 4) and t/wall non-decreasing (checks 5–6), and touches no file
    // (checks 7–8). Every one of the eight reads the parsed event stream; not
    // one reads the file.
    //
    // The fix was NOT to add a ninth check. See the test immediately below for
    // what now catches this.
    const report = await validateMutated(await appendWellFormedEntry());
    expect(report.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(report.overall).toBe('pass');
  });

  it('THE FIX: the same append IS caught by the log_bytes_match detection', async () => {
    // The before/after on the characterization above. The eight still pass —
    // and `log_bytes_match` fails, because `sessions[].slog_sha256` in the
    // SIGNED manifest commits to the exact .slog bytes and those bytes moved.
    //
    // Note it is this detection and not the checkpoints that catches an
    // append: the appended entry sits PAST the last checkpoint, so every
    // signed checkpoint still verifies. The two defences are complements.
    const report = await validateMutated(await appendWellFormedEntry());

    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('fail');
    expect(detectionStatusOf(report, 'checkpoint_chain_valid')).toBe('pass');

    const detection = report.bundleDetections!.find((c) => c.id === 'log_bytes_match')!;
    expect(detection.detail).toContain('modified after sealing');
  });

  it('flipping a byte in a .slog fails log_bytes_match', async () => {
    const buf = await mutateZip(bundlePath, async (zip) => {
      // Flip one nibble INSIDE a quoted 64-hex value, so the file stays valid
      // NDJSON and the loader still parses it. A flip that broke JSON would be
      // caught by the parser rather than by this detection, proving nothing.
      const text = await zip.file(slogName)!.async('string');
      const flipped = text.replace(
        /"([0-9a-f]{64})"/,
        (_m, hex: string) => `"${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}"`,
      );
      expect(flipped).not.toBe(text);
      zip.file(slogName, flipped);
    });
    const report = await validateMutated(buf);
    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('fail');
  });

  it('truncating a .slog fails log_bytes_match AND checkpoint_chain_valid', async () => {
    // Truncation is the case the two defences overlap on: the bytes move (so
    // the manifest digest breaks) and a signed checkpoint is left pointing
    // past the end of the log.
    const buf = await mutateZip(bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      // Keep session.start so the bundle still loads; drop everything after it.
      zip.file(slogName, `${lines[0]!}\n`);
    });
    const report = await validateMutated(buf);

    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('fail');
    expect(detectionStatusOf(report, 'checkpoint_chain_valid')).toBe('fail');
    const cp = report.bundleDetections!.find((c) => c.id === 'checkpoint_chain_valid')!;
    expect(cp.detail).toContain('no entry with that seq is present');
  });

  it('tampering a .slog.meta fails log_bytes_match', async () => {
    const buf = await mutateZip(bundlePath, async (zip) => {
      const name = `${slogName}.meta`;
      const meta = JSON.parse(await zip.file(name)!.async('string')) as Record<string, unknown>;
      // Keep the shape valid so the loader still parses it; only bytes move.
      meta['info'] = 'tampered';
      zip.file(name, JSON.stringify(meta));
    });
    const report = await validateMutated(buf);

    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('fail');
    const detection = report.bundleDetections!.find((c) => c.id === 'log_bytes_match')!;
    expect(detection.detail).toContain('.slog.meta');
  });

  it('forging a checkpoint signature fails checkpoint_chain_valid', async () => {
    // The .slog.meta digest is repaired after the edit, so log_bytes_match is
    // satisfied and ONLY the checkpoint verification can catch this. That is
    // the point of having both defences.
    const buf = await mutateZip(bundlePath, async (zip) => {
      const name = `${slogName}.meta`;
      const meta = JSON.parse(await zip.file(name)!.async('string')) as {
        checkpoints: Array<{ seq: number; hash: string; sig: string }>;
      };
      expect(meta.checkpoints.length).toBeGreaterThan(0);
      meta.checkpoints[0]!.sig = 'f'.repeat(128);
      const text = JSON.stringify(meta);
      zip.file(name, text);

      // Re-point the SIGNED manifest at the new meta bytes. (A real attacker
      // cannot do this — they have no signing key — but doing it here isolates
      // the checkpoint defence from the log-bytes one.)
      const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
        sessions: Array<{ meta_sha256: string }>;
      };
      manifest.sessions[0]!.meta_sha256 = sha256OfString(text);
      zip.file('manifest.json', JSON.stringify(manifest));
    });
    const report = await validateMutated(buf);

    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('pass');
    expect(detectionStatusOf(report, 'checkpoint_chain_valid')).toBe('fail');
    const cp = report.bundleDetections!.find((c) => c.id === 'checkpoint_chain_valid')!;
    expect(cp.detail).toContain('does not verify against the session public key');
  });

  it('the clean bundle is still green after all mutations (no shared-state leak)', async () => {
    const again = await loadAndValidate(bundlePath);
    expectAllChecksPass(again.report);
  });
});

// ---------------------------------------------------------------------------
// THE ROLLING SEAL (program spec §8) — same gate, git-submitted shape.
//
// A git-submitted assignment never runs `seal`, so there is no `manifest.json`
// at all. The recorder instead rewrites `manifest-<session_id>.json` + `.sig` on
// every checkpoint. This section drives the REAL `writeRollingSeal` from the
// recorder's build output and reads the result back with the REAL loadBundle +
// runValidation, exactly as the classic path above.
//
// The one thing the test supplies is the ZIP. That is deliberate and it is not
// a hand-built artifact: for a git submission the archive is produced by the
// grader cloning the repo, not by any recorder code, so there is no production
// zipper to call. Every byte INSIDE it — manifest, signature, .slog, .meta —
// comes from production code.
// ---------------------------------------------------------------------------

/** ZIP a `.provenance/` plus the workspace files, as a grader's clone would. */
async function zipRepo(opts: {
  root: string;
  provenanceDir: string;
  submissionFiles: Map<string, string>;
  outputPath: string;
  /** Entries to leave out, for the "seal was deleted" mutations. */
  omitProvenanceEntries?: Set<string>;
}): Promise<string> {
  const { root, provenanceDir, submissionFiles, outputPath } = opts;
  const omit = opts.omitProvenanceEntries ?? new Set<string>();
  const zip = new JSZip();

  for (const filename of await fsPromises.readdir(provenanceDir)) {
    if (filename.includes('.corrupt-') || filename.endsWith('.tmp')) continue;
    if (omit.has(filename)) continue;
    zip.file(filename, await fsPromises.readFile(path.join(provenanceDir, filename)));
  }
  for (const rel of submissionFiles.keys()) {
    zip.file(rel, await fsPromises.readFile(path.join(root, rel)));
  }

  const out = await zip.generateAsync({ type: 'nodebuffer' });
  await fsPromises.writeFile(outputPath, out);
  return outputPath;
}

type RollingScenario = {
  root: string;
  provenanceDir: string;
  sessions: RecordedSession[];
  bundlePath: string;
  finalContent: Map<string, string>;
};

/**
 * Record N sessions and roll a seal for each, through production code.
 *
 * Each session is sealed AFTER its own content is materialized, mirroring what
 * the live recorder does: a session's rolling manifest records the on-disk state
 * as of that session's last checkpoint. The union the loader synthesizes then
 * takes the newest session's hash for each file, which is what check 8 compares
 * the zipped bytes against.
 */
async function buildRollingSealedBundle(opts: {
  root: string;
  sessionCount: number;
  files: Array<{ path: string; initial: string; append: string }>;
  filesUnderReview?: string[];
  /**
   * Mark each seal FINAL, as the recorder's `dispose()` does.
   *
   * Defaults to TRUE because that is genuinely the ordering here: `recordSession`
   * emits session.end and disposes both writers before the roll, so this seal is
   * taken over a finished log — precisely the state `dispose()` seals and the
   * only one a whole-file digest can honestly describe.
   *
   * The mid-session shape, where the seal is signed while the log is still
   * growing, is exercised by `openLiveSession` further down and stays non-final.
   */
  final?: boolean;
}): Promise<RollingScenario> {
  const { root, sessionCount, files } = opts;
  const sealIsFinal = opts.final !== false;
  const provenanceDir = path.join(root, '.provenance');
  await fsPromises.mkdir(provenanceDir, { recursive: true });

  const sessions: RecordedSession[] = [];
  let prev: string | null = null;
  let finalContent = new Map<string, string>();

  for (let i = 0; i < sessionCount; i++) {
    const sessionId = uuid(i + 1);
    const recorded = await recordSession({
      provenanceDir,
      sessionId,
      prevSessionId: prev,
      files: files.map((f) => ({ ...f, append: `${f.append}// session ${i + 1}\n` })),
    });
    sessions.push(recorded);
    finalContent = recorded.finalContent;
    await writeWorkspaceFiles(root, finalContent);

    const filesUnderReview = opts.filesUnderReview ?? [...finalContent.keys()];

    // The REAL write path, signing with THIS session's own key.
    const result = await writeRollingSeal({
      provenanceDir,
      sessionId,
      prevSessionId: prev,
      slogPath: path.join(provenanceDir, `session-${sessionId}.slog`),
      assignmentRoot: root,
      assignmentId: ASSIGNMENT_ID,
      semester: SEMESTER,
      filesUnderReview,
      sessionPrivkey: recorded.keypair.privateKey,
      extensionHash: EXTENSION_HASH,
      ...(sealIsFinal ? { final: true } : {}),
    });
    if (result.kind !== 'written') {
      throw new Error(`writeRollingSeal did not succeed: ${JSON.stringify(result)}`);
    }

    prev = sessionId;
  }

  const bundlePath = await zipRepo({
    root,
    provenanceDir,
    submissionFiles: finalContent,
    outputPath: path.join(root, 'git-clone.zip'),
  });

  return { root, provenanceDir, sessions, bundlePath, finalContent };
}

describe('rolling seal → analysis-core load + validate (git-submitted shape)', () => {
  describe('single-session repo with no manifest.json at all', () => {
    let scenario: RollingScenario;
    let verified: Verified;

    beforeAll(async () => {
      const root = await makeRoot('rolling-single');
      scenario = await buildRollingSealedBundle({
        root,
        sessionCount: 1,
        files: [{ path: 'main.py', initial: 'def solve():\n    pass\n', append: 'solve()\n' }],
      });
      verified = await loadAndValidate(scenario.bundlePath);
    });

    it('carries no classic seal whatsoever', async () => {
      const zip = await JSZip.loadAsync(await fsPromises.readFile(scenario.bundlePath));
      expect(zip.file('manifest.json')).toBeNull();
      expect(zip.file('manifest.sig')).toBeNull();
      expect(zip.file(`manifest-${scenario.sessions[0]!.sessionId}.json`)).not.toBeNull();
      expect(zip.file(`manifest-${scenario.sessions[0]!.sessionId}.sig`)).not.toBeNull();
    });

    it('loads through the real loadBundle as a 1.2 rolling bundle', () => {
      expect(verified.bundle.sessions).toHaveLength(1);
      expect(verified.bundle.manifest.format_version).toBe('1.2');
      expect(verified.bundle.manifest.assignment_id).toBe(ASSIGNMENT_ID);
      expect(verified.bundle.manifest.semester).toBe(SEMESTER);
      expect(verified.bundle.manifest.extension_hash).toBe(EXTENSION_HASH);
      // The loader recorded a rolling seal, and found nothing wrong with it.
      expect(verified.bundle.rollingSeal?.seals).toHaveLength(1);
      expect(verified.bundle.rollingSeal?.defects).toEqual([]);
    });

    it('passes all 8 validation checks', () => {
      expectAllChecksPass(verified.report);
    });

    it('verifies the seal against the session’s OWN key, named in the detail', () => {
      const check1 = verified.report.checks.find((c) => c.id === 'manifest_sig')!;
      expect(check1.status).toBe('pass');
      expect(check1.detail).toContain('1 rolling manifest(s) verified');
      expect(check1.detail).toContain(scenario.sessions[0]!.sessionId);
    });
  });

  describe('multi-session repo — one seal per session, each with its own key', () => {
    let scenario: RollingScenario;
    let verified: Verified;

    beforeAll(async () => {
      const root = await makeRoot('rolling-multi');
      scenario = await buildRollingSealedBundle({
        root,
        sessionCount: 3,
        files: [{ path: 'main.py', initial: 'x = 1\n', append: 'y = 2\n' }],
      });
      verified = await loadAndValidate(scenario.bundlePath);
    });

    it('produces one seal per session, each covering exactly itself', async () => {
      const zip = await JSZip.loadAsync(await fsPromises.readFile(scenario.bundlePath));
      for (const s of scenario.sessions) {
        const raw = await zip.file(`manifest-${s.sessionId}.json`)!.async('string');
        const parsed = JSON.parse(raw) as {
          format_version: string;
          sessions: Array<{ session_id: string }>;
        };
        expect(parsed.format_version).toBe('1.2');
        expect(parsed.sessions).toHaveLength(1);
        expect(parsed.sessions[0]!.session_id).toBe(s.sessionId);
      }
    });

    it('synthesizes a union manifest spanning all three sessions', () => {
      expect(verified.bundle.manifest.sessions.map((s) => s.session_id)).toEqual(
        scenario.sessions.map((s) => s.sessionId),
      );
      expect(verified.bundle.rollingSeal?.defects).toEqual([]);
    });

    it('passes all 8 validation checks', () => {
      expectAllChecksPass(verified.report);
      expect(verified.report.checks.find((c) => c.id === 'manifest_sig')!.detail).toContain(
        '3 rolling manifest(s) verified',
      );
    });
  });

  // -------------------------------------------------------------------------
  // The classic seal must be exactly what it was. This is the regression that
  // matters most: rolling seals now sit in the same `.provenance/` a classic
  // seal is taken over.
  // -------------------------------------------------------------------------
  describe('the classic seal is unaffected by rolling seals sharing its directory', () => {
    it('produces byte-identical manifest.json and manifest.sig either way', async () => {
      // ONE recording, sealed classically twice: once with no rolling manifests
      // in the directory, once after they are there. Two separate recordings
      // could not answer this — the per-session keypair is random, so their
      // .slog bytes (and therefore their slog_sha256) legitimately differ.
      const root = await makeRoot('classic-unaffected');
      const provenanceDir = path.join(root, '.provenance');
      await fsPromises.mkdir(provenanceDir, { recursive: true });

      const sessionId = uuid(1);
      const recorded = await recordSession({
        provenanceDir,
        sessionId,
        prevSessionId: null,
        files: [{ path: 'main.py', initial: 'a = 1\n', append: 'b = 2\n' }],
      });
      await writeWorkspaceFiles(root, recorded.finalContent);

      const seal = async (): Promise<string> => {
        const result = await sealBundle({
          assignmentRoot: root,
          provenanceDir,
          assignmentId: ASSIGNMENT_ID,
          semester: SEMESTER,
          filesUnderReview: [...recorded.finalContent.keys()],
          sessionPrivkey: recorded.keypair.privateKey,
          sessionPubkeyHex: recorded.keypair.publicKeyHex,
          computeExtensionHash: async () => EXTENSION_HASH,
          outputDir: root,
          now: () => new Date('2026-05-19T14:30:00.000Z'),
        });
        if (result.kind !== 'ok') throw new Error('sealBundle failed');
        return result.manifestSha256;
      };

      const shaBefore = await seal();
      const manifestBefore = await fsPromises.readFile(
        path.join(provenanceDir, 'manifest.json'),
        'utf8',
      );
      const sigBefore = await fsPromises.readFile(path.join(provenanceDir, 'manifest.sig'), 'utf8');

      // Now roll a seal into the very same directory — what every recorder does
      // from this change on — and seal again.
      const rolled = await writeRollingSeal({
        provenanceDir,
        sessionId,
        prevSessionId: null,
        slogPath: path.join(provenanceDir, `session-${sessionId}.slog`),
        assignmentRoot: root,
        assignmentId: ASSIGNMENT_ID,
        semester: SEMESTER,
        filesUnderReview: [...recorded.finalContent.keys()],
        sessionPrivkey: recorded.keypair.privateKey,
        extensionHash: EXTENSION_HASH,
      });
      expect(rolled.kind).toBe('written');
      expect((await fsPromises.readdir(provenanceDir)).sort()).toContain(
        `manifest-${sessionId}.json`,
      );

      const shaAfter = await seal();

      // Byte-for-byte. The rolling seal contributes nothing to the classic
      // manifest: it is not a session, and it is not a submission file.
      expect(await fsPromises.readFile(path.join(provenanceDir, 'manifest.json'), 'utf8')).toBe(
        manifestBefore,
      );
      expect(await fsPromises.readFile(path.join(provenanceDir, 'manifest.sig'), 'utf8')).toBe(
        sigBefore,
      );
      expect(shaAfter).toBe(shaBefore);
    });

    it('a both-shapes bundle still passes all 8 checks, satisfying BOTH seals', async () => {
      const root = await makeRoot('both-shapes');
      const scenario = await buildRollingSealedBundle({
        root,
        sessionCount: 1,
        files: [{ path: 'main.py', initial: 'a = 1\n', append: 'b = 2\n' }],
      });

      // Now take a classic seal over the same directory — which is exactly what
      // "Prepare Submission Bundle" does on a recorder that rolls seals.
      const sealed = await sealBundle({
        assignmentRoot: root,
        provenanceDir: scenario.provenanceDir,
        assignmentId: ASSIGNMENT_ID,
        semester: SEMESTER,
        filesUnderReview: [...scenario.finalContent.keys()],
        sessionPrivkey: scenario.sessions[0]!.keypair.privateKey,
        sessionPubkeyHex: scenario.sessions[0]!.keypair.publicKeyHex,
        computeExtensionHash: async () => EXTENSION_HASH,
        outputDir: root,
        now: () => new Date('2026-05-19T14:30:00.000Z'),
      });
      if (sealed.kind !== 'ok') throw new Error('sealBundle failed');

      const zip = await JSZip.loadAsync(await fsPromises.readFile(sealed.bundlePath));
      expect(zip.file('manifest.json')).not.toBeNull();
      expect(zip.file(`manifest-${scenario.sessions[0]!.sessionId}.json`)).not.toBeNull();

      const verified = await loadAndValidate(sealed.bundlePath);
      // The classic manifest still wins as `bundle.manifest`…
      expect(verified.bundle.manifest.format_version).toBe('1.1');
      // …and the rolling seal is verified alongside it, not instead of it.
      expect(verified.report.checks.find((c) => c.id === 'manifest_sig')!.detail).toContain(
        'Classic manifest.json also verified',
      );
      expectAllChecksPass(verified.report);
    });
  });

  // -------------------------------------------------------------------------
  // Mutations. Each breaks exactly one rolling-seal rule and must go red.
  // -------------------------------------------------------------------------
  describe('mutations: a broken rolling seal must be caught', () => {
    let scenario: RollingScenario;
    let sessionId: string;
    let otherKey: SessionKeypair;

    beforeAll(async () => {
      const root = await makeRoot('rolling-mutate');
      scenario = await buildRollingSealedBundle({
        root,
        sessionCount: 2,
        files: [{ path: 'main.py', initial: 'a = 1\n', append: 'b = 2\n' }],
      });
      sessionId = scenario.sessions[0]!.sessionId;
      otherKey = await generateSessionKeypair();

      // Sanity: green before every mutation below.
      expectAllChecksPass((await loadAndValidate(scenario.bundlePath)).report);
    });

    it('flipping a byte in a rolling .sig fails check 1', async () => {
      const buf = await mutateZip(scenario.bundlePath, async (zip) => {
        const sig = await zip.file(`manifest-${sessionId}.sig`)!.async('string');
        zip.file(`manifest-${sessionId}.sig`, (sig[0] === '0' ? '1' : '0') + sig.slice(1));
      });
      const report = await validateMutated(buf);
      expect(statusOf(report, 'manifest_sig')).toBe('fail');
      expect(report.checks.find((c) => c.id === 'manifest_sig')!.detail).toContain(sessionId);
    });

    it('signing with the WRONG session key fails check 1', async () => {
      const buf = await mutateZip(scenario.bundlePath, async (zip) => {
        const json = await zip.file(`manifest-${sessionId}.json`)!.async('string');
        // A perfectly valid signature — over the right bytes, by the wrong key.
        const resigned = await ed.signAsync(new TextEncoder().encode(json), otherKey.privateKey);
        zip.file(`manifest-${sessionId}.sig`, bytesToHex(resigned));
      });
      const report = await validateMutated(buf);
      expect(statusOf(report, 'manifest_sig')).toBe('fail');
      expect(report.checks.find((c) => c.id === 'manifest_sig')!.detail).toContain(
        `did not verify against session ${sessionId}`,
      );
    });

    it('renaming a seal to manifest.json (the classic name) breaks the bundle', async () => {
      // The mutation the writer must never make: emit the classic filename.
      // A 1.2 manifest at `manifest.json` has no matching `.sig`, and the loader
      // rejects a classic manifest with no classic signature outright.
      const buf = await mutateZip(scenario.bundlePath, async (zip) => {
        const json = await zip.file(`manifest-${sessionId}.json`)!.async('string');
        zip.remove(`manifest-${sessionId}.json`);
        zip.remove(`manifest-${sessionId}.sig`);
        zip.file('manifest.json', json);
      });
      await expect(validateMutated(buf)).rejects.toThrow(/missing_signature/);
    });

    it('a manifest covering TWO sessions in one file fails check 1', async () => {
      const buf = await mutateZip(scenario.bundlePath, async (zip) => {
        const mine = JSON.parse(
          await zip.file(`manifest-${sessionId}.json`)!.async('string'),
        ) as Record<string, unknown>;
        const theirs = JSON.parse(
          await zip.file(`manifest-${scenario.sessions[1]!.sessionId}.json`)!.async('string'),
        ) as { sessions: unknown[] };
        mine['sessions'] = [...(mine['sessions'] as unknown[]), ...theirs.sessions];
        zip.file(`manifest-${sessionId}.json`, JSON.stringify(mine));
      });
      const report = await validateMutated(buf);
      expect(statusOf(report, 'manifest_sig')).toBe('fail');
      expect(report.checks.find((c) => c.id === 'manifest_sig')!.detail).toContain(
        'must cover exactly one session',
      );
    });

    it('a seal copied sideways under another session’s filename fails check 1', async () => {
      // manifest-A.json holding B's seal: it IS B's manifest, signed by B's key,
      // so only the filename ↔ session_id binding catches it.
      const other = scenario.sessions[1]!.sessionId;
      const buf = await mutateZip(scenario.bundlePath, async (zip) => {
        const theirJson = await zip.file(`manifest-${other}.json`)!.async('string');
        const theirSig = await zip.file(`manifest-${other}.sig`)!.async('string');
        zip.file(`manifest-${sessionId}.json`, theirJson);
        zip.file(`manifest-${sessionId}.sig`, theirSig);
      });
      const report = await validateMutated(buf);
      expect(statusOf(report, 'manifest_sig')).toBe('fail');
      expect(report.checks.find((c) => c.id === 'manifest_sig')!.detail).toContain(
        'but the manifest covers',
      );
    });

    it('deleting a session’s .sig fails check 1 (an unsigned manifest is not a seal)', async () => {
      const buf = await mutateZip(scenario.bundlePath, (zip) => {
        zip.remove(`manifest-${sessionId}.sig`);
      });
      const report = await validateMutated(buf);
      expect(statusOf(report, 'manifest_sig')).toBe('fail');
      expect(report.checks.find((c) => c.id === 'manifest_sig')!.detail).toContain(
        'the manifest is unsigned',
      );
    });

    it('deleting a session’s whole seal fails check 1 (unsealed_session)', async () => {
      const buf = await mutateZip(scenario.bundlePath, (zip) => {
        zip.remove(`manifest-${sessionId}.json`);
        zip.remove(`manifest-${sessionId}.sig`);
      });
      const report = await validateMutated(buf);
      expect(statusOf(report, 'manifest_sig')).toBe('fail');
      expect(report.checks.find((c) => c.id === 'manifest_sig')!.detail).toContain(
        'is not covered by any seal',
      );
    });

    it('editing a submitted file after the roll fails check 8', async () => {
      const buf = await mutateZip(scenario.bundlePath, (zip) => {
        zip.file('main.py', '# swapped out after the seal\n');
      });
      const report = await validateMutated(buf);
      expect(statusOf(report, 'submitted_code_match')).toBe('fail');
    });

    it('the clean rolling bundle is still green after all mutations', async () => {
      expectAllChecksPass((await loadAndValidate(scenario.bundlePath)).report);
    });
  });
});

// ===========================================================================
// THE COMPOSITION GAP: a rolling seal whose subject is still growing.
//
// `buildRollingSealedBundle` above rolls each seal AFTER its session has
// emitted session.end and disposed its writer. That is the one ordering in
// which a whole-file digest can possibly be exact, and it is NOT the ordering a
// git-submitted assignment produces. There is no seal step: the student pushes
// whenever, the grader clones whenever, and `dispose()` may never run at all.
//
// The rolling seal is rewritten at session start, at each checkpoint, and at
// dispose(). Between those writes its `slog_sha256` / `meta_sha256` describe a
// PREFIX of a file that has since grown. Every scenario below is an honest
// student, and every one of them archives a `.slog` that is longer than the
// digest its own signed manifest names.
//
// These assert on `bundleDetections`, NOT on the eight. `log_bytes_match` is a
// bundleDetection, so `expectAllChecksPass` — which the existing both-shapes
// test relies on — structurally cannot see it.
// ===========================================================================

type LiveSession = {
  sessionId: string;
  keypair: SessionKeypair;
  slogPath: string;
  /** Final content per workspace-relative path, as the recording has left it. */
  finalContent: Map<string, string>;
  /** doc.open + doc.change + doc.save for one file, with a signed checkpoint. */
  work(file: { path: string; initial: string; append: string }): Promise<void>;
  /** N session.heartbeat entries: they grow the `.slog` and touch no file. */
  idle(n: number): void;
  /** Push the SessionWriter's buffer to disk. */
  flush(): Promise<void>;
  /** The REAL rolling-seal writer, signing with this session's own key. */
  roll(): Promise<void>;
  /** Graceful shutdown: session.end, flush, close. Deliberately no final roll. */
  close(opts?: { emitSessionEnd?: boolean }): Promise<void>;
};

/**
 * Open a real recorder session and hand back the controls, so a test can
 * interleave recording and sealing the way the live recorder does.
 *
 * Same production parts as `recordSession` — SessionHost, SessionWriter,
 * MetaWriter, the real per-session keypair, log-core's real signCheckpoint —
 * just not driven to completion up front.
 */
async function openLiveSession(opts: {
  provenanceDir: string;
  sessionId: string;
  prevSessionId: string | null;
}): Promise<LiveSession> {
  const { provenanceDir, sessionId, prevSessionId } = opts;

  const keypair = await generateSessionKeypair();
  const encryptedPrivkey = await encryptSessionPrivkey(keypair.privateKey, MANIFEST_SIG, sessionId);
  const slogPath = path.join(provenanceDir, `session-${sessionId}.slog`);

  const clock = new FixedClock(0, new Date('2026-05-19T14:00:00.000Z'));
  const writer = await SessionWriter.open({ slogPath, clock });
  const meta = await MetaWriter.create({
    metaPath: `${slogPath}.meta`,
    sessionId,
    sessionPubkeyHex: keypair.publicKeyHex,
    encryptedPrivkey,
  });

  const host = createSessionHost({
    sessionId,
    clock,
    onEntry: (entry) => writer.append(entry),
  });

  host.emit('session.start', {
    format_version: '1.0',
    session_id: sessionId,
    prev_session_id: prevSessionId,
    assignment: { id: ASSIGNMENT_ID, semester: SEMESTER },
    manifest_sig: MANIFEST_SIG,
    machine_id: 'b'.repeat(64),
    vscode: { version: '1.100.0', commit: '', platform: 'darwin-arm64' },
    recorder: { version: '1.2.0', extension_id: 'itsgeagle.provenance-recorder' },
    session_pubkey: keypair.publicKeyHex,
  });

  const finalContent = new Map<string, string>();

  return {
    sessionId,
    keypair,
    slogPath,
    finalContent,

    async work(f) {
      clock.advance(1000);
      host.emit('doc.open', {
        path: f.path,
        sha256: sha256OfString(f.initial),
        line_count: f.initial.split('\n').length,
        content: f.initial,
      });

      const lines = f.initial.split('\n');
      const endLine = lines.length - 1;
      const endChar = lines[endLine]!.length;

      clock.advance(1000);
      host.emit('doc.change', {
        path: f.path,
        deltas: [
          {
            range: {
              start: { line: endLine, character: endChar },
              end: { line: endLine, character: endChar },
            },
            text: f.append,
          },
        ],
        source: 'typed',
      });

      const final = f.initial + f.append;
      finalContent.set(f.path, final);

      clock.advance(1000);
      const saved = host.emit('doc.save', { path: f.path, sha256: sha256OfString(final) });
      if (saved !== null) {
        await meta.appendCheckpoint(
          await signCheckpoint(saved.seq, saved.hash, keypair.privateKey),
        );
      }
    },

    idle(n) {
      for (let i = 0; i < n; i++) {
        clock.advance(30_000);
        host.emit('session.heartbeat', { focused: true, active_file: null, idle_since_ms: 0 });
      }
    },

    async flush() {
      await writer.flush();
    },

    async roll() {
      const result = await writeRollingSeal({
        provenanceDir,
        sessionId,
        prevSessionId,
        slogPath,
        assignmentRoot: path.dirname(provenanceDir),
        assignmentId: ASSIGNMENT_ID,
        semester: SEMESTER,
        filesUnderReview: [...finalContent.keys()],
        sessionPrivkey: keypair.privateKey,
        extensionHash: EXTENSION_HASH,
      });
      if (result.kind !== 'written') {
        throw new Error(`writeRollingSeal did not succeed: ${JSON.stringify(result)}`);
      }
    },

    async close(closeOpts) {
      if (closeOpts?.emitSessionEnd !== false) {
        clock.advance(1000);
        host.emit('session.end', { reason: 'deactivate' });
      }
      await writer.flush();
      await writer.dispose();
      await meta.dispose();
    },
  };
}

/**
 * Assert no bundle-level detection is reporting a finding.
 *
 * This is the assertion the existing rolling tests never made.
 * `expectAllChecksPass` only looks at `report.checks`, and `log_bytes_match`
 * is not one of the eight — so a bundle can pass all eight while shouting
 * "tampered" at high severity, confidence 1.0.
 */
function expectNoBundleDetections(report: Verified['report']): void {
  const firing = (report.bundleDetections ?? [])
    .filter((d) => d.status !== 'pass' && d.status !== 'skipped')
    .map((d) => `${d.id}=${d.status} (${d.detail ?? ''})`);
  expect(firing).toEqual([]);
}

describe('HONEST STUDENT: a rolling seal whose .slog kept growing after it', () => {
  /**
   * Record a session, roll its seal, then keep recording — and archive the repo
   * without any further seal. This is a `git add . && git commit && git push`
   * from an editor that is still open.
   */
  async function midFlightRepo(opts: {
    label: string;
    /** Emit session.end + close cleanly, or simulate a power loss. */
    graceful: boolean;
    /** Do post-roll work that also rewrites a submission file. */
    touchFilesAfterRoll: boolean;
  }): Promise<{ bundlePath: string; sessionId: string }> {
    const root = await makeRoot(opts.label);
    const provenanceDir = path.join(root, '.provenance');
    await fsPromises.mkdir(provenanceDir, { recursive: true });

    const live = await openLiveSession({
      provenanceDir,
      sessionId: uuid(1),
      prevSessionId: null,
    });

    await live.work({ path: 'main.py', initial: 'def solve():\n    pass\n', append: 'solve()\n' });
    await live.flush();

    // The seal the recorder rolls at this checkpoint.
    await live.roll();

    // …and then the student keeps working. Nothing rolls another seal until the
    // next checkpoint, 100 entries away.
    if (opts.touchFilesAfterRoll) {
      await live.work({
        path: 'main.py',
        initial: 'def solve():\n    pass\nsolve()\n',
        append: '# more work\n',
      });
    } else {
      live.idle(5);
    }

    await live.close({ emitSessionEnd: opts.graceful });
    await writeWorkspaceFiles(root, live.finalContent);

    const bundlePath = await zipRepo({
      root,
      provenanceDir,
      submissionFiles: live.finalContent,
      outputPath: path.join(root, 'git-clone.zip'),
    });

    return { bundlePath, sessionId: live.sessionId };
  }

  it('does not accuse a student whose session was still open at archive time', async () => {
    const { bundlePath } = await midFlightRepo({
      label: 'mid-flight-open',
      graceful: true,
      touchFilesAfterRoll: false,
    });
    const verified = await loadAndValidate(bundlePath);
    expectNoBundleDetections(verified.report);
  });

  it('does not accuse a student whose machine died between checkpoint and dispose', async () => {
    // No session.end, no dispose()-time roll — a force-quit or a power cut.
    // The seal left behind is whatever the last checkpoint wrote.
    const { bundlePath } = await midFlightRepo({
      label: 'mid-flight-crash',
      graceful: false,
      touchFilesAfterRoll: false,
    });
    const verified = await loadAndValidate(bundlePath);
    expectNoBundleDetections(verified.report);
  });

  it('does not accuse a student who edited a reviewed file after the last roll', async () => {
    const { bundlePath } = await midFlightRepo({
      label: 'mid-flight-edits',
      graceful: true,
      touchFilesAfterRoll: true,
    });
    const verified = await loadAndValidate(bundlePath);
    expectNoBundleDetections(verified.report);
  });

  it('does not accuse a partner whose repo was cloned mid-session', async () => {
    // Two contributors, one shared `.provenance/`. A finished her session and
    // its dispose-time seal covers her whole log. B is still typing.
    const root = await makeRoot('partner-mid-flight');
    const provenanceDir = path.join(root, '.provenance');
    await fsPromises.mkdir(provenanceDir, { recursive: true });

    const a = await openLiveSession({ provenanceDir, sessionId: uuid(1), prevSessionId: null });
    await a.work({ path: 'main.py', initial: 'a = 1\n', append: 'b = 2\n' });
    await a.close();
    await a.roll(); // the dispose()-time roll: exact, covers everything

    const b = await openLiveSession({ provenanceDir, sessionId: uuid(2), prevSessionId: uuid(1) });
    await b.work({ path: 'main.py', initial: 'a = 1\nb = 2\n', append: 'c = 3\n' });
    await b.flush();
    await b.roll(); // B's checkpoint roll…
    b.idle(4); // …and B keeps working
    await b.close();

    await writeWorkspaceFiles(root, b.finalContent);

    const bundlePath = await zipRepo({
      root,
      provenanceDir,
      submissionFiles: b.finalContent,
      outputPath: path.join(root, 'git-clone.zip'),
    });

    const verified = await loadAndValidate(bundlePath);
    expectNoBundleDetections(verified.report);
  });

  it('does not accuse a session whose .slog.meta gained a checkpoint after its roll', async () => {
    // The `.slog.meta` is written by a different writer on a different cadence
    // from the seal. A checkpoint that lands after the roll moves
    // `meta_sha256` exactly the way a trailing entry moves `slog_sha256`.
    const root = await makeRoot('meta-after-roll');
    const provenanceDir = path.join(root, '.provenance');
    await fsPromises.mkdir(provenanceDir, { recursive: true });

    const live = await openLiveSession({
      provenanceDir,
      sessionId: uuid(1),
      prevSessionId: null,
    });
    await live.work({ path: 'main.py', initial: 'a = 1\n', append: 'b = 2\n' });
    await live.flush();
    await live.roll();

    // A save-triggered checkpoint, appended to the .meta after the roll.
    await live.work({ path: 'main.py', initial: 'a = 1\nb = 2\n', append: 'c = 3\n' });
    await live.close();
    await writeWorkspaceFiles(root, live.finalContent);

    const bundlePath = await zipRepo({
      root,
      provenanceDir,
      submissionFiles: live.finalContent,
      outputPath: path.join(root, 'git-clone.zip'),
    });

    const verified = await loadAndValidate(bundlePath);
    expectNoBundleDetections(verified.report);
  });

  it('reports how much of the log the rolling seal actually covers', () => {
    // Passing is not the same as fully sealed, and the verdict has to say which
    // one it is. The tail past the last roll is covered by the chain and the
    // checkpoints but by no bundle-level signature, and staff are entitled to
    // know that rather than read "pass" as "signed end to end".
    return midFlightRepo({
      label: 'mid-flight-detail',
      graceful: true,
      touchFilesAfterRoll: false,
    }).then(async ({ bundlePath }) => {
      const verified = await loadAndValidate(bundlePath);
      const detection = verified.report.bundleDetections!.find((d) => d.id === 'log_bytes_match')!;
      expect(detection.status).toBe('pass');
      expect(detection.detail).toContain('written after the last seal');
      expect(detection.detail).toMatch(/\d+ of \d+ bytes sealed/);
    });
  });
});

// ===========================================================================
// …and the same mid-flight bundle must still catch real tampering.
//
// Reading a rolling digest as a PREFIX commitment is only defensible if the
// sealed region is still enforced at full strength. Each mutation below breaks
// the sealed prefix in a different way and must go red.
//
// The one thing it CANNOT catch is stated as a characterization test rather
// than hidden: a rolling seal is signed before the trailing bytes exist, so it
// can never attest to them. That residual belongs to the rolling design, not to
// this reading of it — and the classic seal, which is terminal, still catches
// exactly that append (see the both-shapes test at the end).
// ===========================================================================

describe('mutations: the sealed PREFIX of a mid-flight rolling bundle is still enforced', () => {
  let bundlePath: string;
  let slogName: string;

  beforeAll(async () => {
    const root = await makeRoot('rolling-prefix-mutate');
    const provenanceDir = path.join(root, '.provenance');
    await fsPromises.mkdir(provenanceDir, { recursive: true });

    const live = await openLiveSession({
      provenanceDir,
      sessionId: uuid(1),
      prevSessionId: null,
    });
    await live.work({ path: 'main.py', initial: 'a = 1\n', append: 'b = 2\n' });
    await live.flush();
    await live.roll(); // seals the prefix that exists right now
    // …and then keeps going, so the archived log runs past its own seal and
    // there is both a sealed region and an unsealed tail to aim mutations at.
    await live.work({ path: 'main.py', initial: 'a = 1\nb = 2\n', append: 'c = 3\n' });
    await live.close();
    await writeWorkspaceFiles(root, live.finalContent);

    slogName = `session-${live.sessionId}.slog`;
    bundlePath = await zipRepo({
      root,
      provenanceDir,
      submissionFiles: live.finalContent,
      outputPath: path.join(root, 'git-clone.zip'),
    });

    // Green before every mutation, and genuinely partial rather than exact —
    // otherwise these mutations would be testing the classic path by accident.
    const verified = await loadAndValidate(bundlePath);
    expectNoBundleDetections(verified.report);
    const coverage = verified.bundle.rollingSeal!.coverage!;
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.slog.kind).toBe('partial');
    expect(coverage[0]!.meta.kind).toBe('partial');
  });

  it('flipping a byte INSIDE the sealed prefix fails log_bytes_match', async () => {
    const buf = await mutateZip(bundlePath, async (zip) => {
      // session.start's machine_id is 64 hex chars and sits in the first entry,
      // which is comfortably inside the sealed prefix. Flipping a nibble inside
      // a quoted hex value keeps the file valid NDJSON, so the loader still
      // parses it and this detection — not the parser — is what catches it.
      const text = await zip.file(slogName)!.async('string');
      const flipped = text.replace(
        /"([0-9a-f]{64})"/,
        (_m, hex: string) => `"${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}"`,
      );
      expect(flipped).not.toBe(text);
      zip.file(slogName, flipped);
    });
    const report = await validateMutated(buf);
    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('fail');
    const detection = report.bundleDetections!.find((c) => c.id === 'log_bytes_match')!;
    expect(detection.detail).toContain('no state this file could have passed through');
  });

  it('truncating BELOW the sealed prefix fails log_bytes_match', async () => {
    const buf = await mutateZip(bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      // Keep session.start so the bundle still loads; drop the rest, which
      // takes the file below the point the seal committed to.
      zip.file(slogName, `${lines[0]!}\n`);
    });
    const report = await validateMutated(buf);
    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('fail');
  });

  it('rewriting an entry inside the sealed prefix fails log_bytes_match', async () => {
    // Not a byte flip but a re-chained rewrite: the attacker replaces an entry
    // and re-chains everything after it, which defeats check 3. Only a
    // commitment to the sealed bytes can catch this.
    const buf = await mutateZip(bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      // Rewrite the doc.change payload (entry 2), then re-chain the tail.
      let prev = entries[0]!['hash'] as string;
      const rebuilt = [lines[0]!];
      for (const e of entries.slice(1)) {
        const { hash: _h, prev_hash: _p, ...rest } = e;
        if (rest['kind'] === 'doc.change') {
          const data = rest['data'] as { deltas: Array<{ text: string }> };
          data.deltas[0]!.text = '# rewritten\n';
        }
        const rechained = chainEntry(prev, rest as Parameters<typeof chainEntry>[1]);
        prev = rechained.hash;
        rebuilt.push(serializeEntry(rechained).trimEnd());
      }
      zip.file(slogName, `${rebuilt.join('\n')}\n`);
    });
    const report = await validateMutated(buf);
    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('fail');
  });

  it('deleting a checkpoint from the sealed part of .slog.meta fails log_bytes_match', async () => {
    // The meta is re-serialized whole on every checkpoint, so its coverage is
    // read as "the first k checkpoints", not as a byte prefix. Removing a
    // checkpoint the seal already committed to reproduces no truncation of the
    // archived list, so it must not slip through as honest growth.
    const buf = await mutateZip(bundlePath, async (zip) => {
      const name = `${slogName}.meta`;
      const meta = JSON.parse(await zip.file(name)!.async('string')) as {
        checkpoints: unknown[];
      };
      expect(meta.checkpoints.length).toBeGreaterThan(1);
      meta.checkpoints = meta.checkpoints.slice(1); // drop the SEALED one
      zip.file(name, JSON.stringify(meta));
    });
    const report = await validateMutated(buf);
    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('fail');
    const detection = report.bundleDetections!.find((c) => c.id === 'log_bytes_match')!;
    expect(detection.detail).toContain('.slog.meta');
  });

  it('editing a non-checkpoint field of .slog.meta fails log_bytes_match', async () => {
    // Only `checkpoints` changes over a session's life. Anything else moving
    // means the file is not a later state of what was sealed.
    const buf = await mutateZip(bundlePath, async (zip) => {
      const name = `${slogName}.meta`;
      const meta = JSON.parse(await zip.file(name)!.async('string')) as Record<string, unknown>;
      meta['info'] = 'tampered';
      zip.file(name, JSON.stringify(meta));
    });
    const report = await validateMutated(buf);
    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('fail');
  });

  it('CHARACTERIZATION: an append PAST the sealed prefix is not caught, and cannot be', async () => {
    // The residual, recorded rather than papered over. The seal was signed
    // before these bytes existed, so no reading of it can attest to them —
    // this is a property of rolling seals, not of how they are verified.
    //
    // It is also exactly what an honest mid-session archive looks like, which
    // is why it must not be a high/1.0 finding. What DOES still cover this
    // region: the hash chain (check 3), seq/t/wall monotonicity (checks 4–6),
    // doc_save_hashes (check 7), submitted_code_match (check 8), and every
    // event-stream heuristic. And the verdict states the unattested size.
    const buf = await mutateZip(bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]!) as {
        seq: number;
        t: number;
        wall: string;
        hash: string;
      };
      const appended = chainEntry(last.hash, {
        seq: last.seq + 1,
        t: last.t + 1000,
        wall: new Date(new Date(last.wall).getTime() + 1000).toISOString(),
        kind: 'session.heartbeat',
        data: { focused: true, active_file: null, idle_since_ms: 0 },
      });
      zip.file(slogName, `${lines.join('\n')}\n${serializeEntry(appended)}`);
    });
    const report = await validateMutated(buf);
    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('pass');
    const detection = report.bundleDetections!.find((c) => c.id === 'log_bytes_match')!;
    expect(detection.detail).toContain('written after the last seal');
  });

  it('the mid-flight bundle is still clean after all mutations', async () => {
    expectNoBundleDetections((await loadAndValidate(bundlePath)).report);
  });
});

// ===========================================================================
// The gate: prefix semantics belong to a PURELY rolling bundle.
//
// A classic seal is terminal — taken once, by an explicit command, over a
// finished log — so it commits to the whole file and a post-seal append must
// still fail. `parse-bundle.ts` computes coverage only when there is no
// `manifest.json`, and a both-shapes bundle uses the classic manifest. This is
// the test that stops bug 3's "seal everything" behaviour from quietly
// downgrading every classic course's append detection.
// ===========================================================================

describe('a both-shapes bundle keeps WHOLE-FILE semantics', () => {
  it('carries no rolling coverage, and an append past the classic seal still fails', async () => {
    const root = await makeRoot('both-shapes-append');
    const scenario = await buildRollingSealedBundle({
      root,
      sessionCount: 1,
      files: [{ path: 'main.py', initial: 'a = 1\n', append: 'b = 2\n' }],
    });

    const sealed = await sealBundle({
      assignmentRoot: root,
      provenanceDir: scenario.provenanceDir,
      assignmentId: ASSIGNMENT_ID,
      semester: SEMESTER,
      filesUnderReview: [...scenario.finalContent.keys()],
      sessionPrivkey: scenario.sessions[0]!.keypair.privateKey,
      sessionPubkeyHex: scenario.sessions[0]!.keypair.publicKeyHex,
      computeExtensionHash: async () => EXTENSION_HASH,
      outputDir: root,
      now: () => new Date('2026-05-19T14:30:00.000Z'),
    });
    if (sealed.kind !== 'ok') throw new Error('sealBundle failed');

    const verified = await loadAndValidate(sealed.bundlePath);
    expect(verified.bundle.manifest.format_version).toBe('1.1');
    // Rolling seals are present and verified, but they do NOT get to relax the
    // classic manifest's whole-file commitment.
    expect(verified.bundle.rollingSeal!.seals).toHaveLength(1);
    expect(verified.bundle.rollingSeal!.coverage).toBeUndefined();
    expectNoBundleDetections(verified.report);

    const slogName = `session-${scenario.sessions[0]!.sessionId}.slog`;
    const buf = await mutateZip(sealed.bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]!) as {
        seq: number;
        t: number;
        wall: string;
        hash: string;
      };
      const appended = chainEntry(last.hash, {
        seq: last.seq + 1,
        t: last.t + 1000,
        wall: new Date(new Date(last.wall).getTime() + 1000).toISOString(),
        kind: 'session.heartbeat',
        data: { focused: true, active_file: null, idle_since_ms: 0 },
      });
      zip.file(slogName, `${lines.join('\n')}\n${serializeEntry(appended)}`);
    });
    const report = await validateMutated(buf);
    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('fail');
    expect(report.bundleDetections!.find((c) => c.id === 'log_bytes_match')!.detail).toContain(
      'modified after sealing',
    );
  });
});

// ===========================================================================
// THE FINAL SEAL — closing the last gap in rolling-seal append detection.
//
// A rolling seal is signed BEFORE the log's trailing bytes exist, so it can
// only commit to a PREFIX. That is what stops an honest mid-session archive
// being read as tampering (the HONEST STUDENT section above), and it is also
// what left an append past the final checkpoint indistinguishable from honest
// growth (the CHARACTERIZATION above).
//
// `dispose()` takes one last roll after session.end is emitted and both writers
// are closed, and marks it `final: true` INSIDE the signed payload. That seal
// has no future left to be incapable of attesting to, so it is read whole-file
// and the append fails.
//
// Everything below runs the REAL writeRollingSeal over the REAL recorder's
// output and reads it back with the REAL loadBundle + runValidation.
// ===========================================================================

describe('a FINAL rolling seal closes the append hole', () => {
  let scenario: RollingScenario;
  let verified: Verified;
  let slogName: string;

  beforeAll(async () => {
    const root = await makeRoot('rolling-final');
    // A full clean session: record, emit session.end, dispose both writers, and
    // only then seal — the ordering dispose() produces.
    scenario = await buildRollingSealedBundle({
      root,
      sessionCount: 1,
      files: [{ path: 'main.py', initial: 'def solve():\n    pass\n', append: 'solve()\n' }],
    });
    verified = await loadAndValidate(scenario.bundlePath);
    slogName = `session-${scenario.sessions[0]!.sessionId}.slog`;
  });

  it('writes a seal marked final, signed by the session’s own key', async () => {
    const sessionId = scenario.sessions[0]!.sessionId;
    const json = await fsPromises.readFile(
      path.join(scenario.provenanceDir, `manifest-${sessionId}.json`),
      'utf8',
    );
    expect((JSON.parse(json) as { final?: boolean }).final).toBe(true);

    // Check 1 verifies the rolling seal against the session pubkey in
    // session.start, so a passing check 1 IS the proof that `final` is signed.
    expect(statusOf(verified.report, 'manifest_sig')).toBe('pass');
  });

  it('the loader reads it whole-file, with no prefix search', () => {
    const coverage = verified.bundle.rollingSeal!.coverage!;
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.final).toBe(true);
    // `exact`, never `partial` — a final seal covers every byte.
    expect(coverage[0]!.slog).toEqual({ kind: 'exact' });
    expect(coverage[0]!.meta).toEqual({ kind: 'exact' });
  });

  it('is clean end-to-end: all 8 checks pass and no detection fires', () => {
    expectAllChecksPass(verified.report);
    expectNoBundleDetections(verified.report);
  });

  it('reports the log as covered in full rather than merely sealed', () => {
    const detection = verified.report.bundleDetections!.find((c) => c.id === 'log_bytes_match')!;
    expect(detection.status).toBe('pass');
    expect(detection.detail).toContain('covered in full');
    expect(detection.detail).not.toContain('written after the last seal');
  });

  // -------------------------------------------------------------------------
  // THE DECISIVE ONE. This is the case the previously-failing test in
  // analysis-core recorded, driven end-to-end through real recorder output.
  // -------------------------------------------------------------------------

  it('FAILS log_bytes_match on an entry appended after the session ended', async () => {
    const buf = await mutateZip(scenario.bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]!) as {
        seq: number;
        t: number;
        wall: string;
        hash: string;
      };
      // A genuinely re-chained, well-formed entry — the strongest version of
      // the attack. It self-verifies under check 3 and keeps seq/t/wall
      // monotonic, so nothing in the event stream contradicts it.
      const appended = chainEntry(last.hash, {
        seq: last.seq + 1,
        t: last.t + 1000,
        wall: new Date(new Date(last.wall).getTime() + 1000).toISOString(),
        kind: 'session.heartbeat',
        data: { focused: true, active_file: null, idle_since_ms: 0 },
      });
      zip.file(slogName, `${lines.join('\n')}\n${serializeEntry(appended)}`);
    });

    const report = await validateMutated(buf);
    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('fail');

    const detection = report.bundleDetections!.find((c) => c.id === 'log_bytes_match')!;
    expect(detection.detail).toContain(scenario.sessions[0]!.sessionId);
    expect(detection.detail).toContain('FINAL');
    expect(detection.detail).toContain('after the session ended');
  });

  it('and the eight checks STILL do not see it — the final seal is the only thing that does', async () => {
    // The same append, measured against the eight. This is why the detection
    // has to exist at all: a correctly-chained append contradicts none of them.
    const buf = await mutateZip(scenario.bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]!) as {
        seq: number;
        t: number;
        wall: string;
        hash: string;
      };
      const appended = chainEntry(last.hash, {
        seq: last.seq + 1,
        t: last.t + 1000,
        wall: new Date(new Date(last.wall).getTime() + 1000).toISOString(),
        kind: 'session.heartbeat',
        data: { focused: true, active_file: null, idle_since_ms: 0 },
      });
      zip.file(slogName, `${lines.join('\n')}\n${serializeEntry(appended)}`);
    });

    const report = await validateMutated(buf);
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
  });

  it('still catches a truncation, and a flipped byte, in the finished log', async () => {
    const truncated = await mutateZip(scenario.bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      zip.file(slogName, `${lines.slice(0, -1).join('\n')}\n`);
    });
    expect(detectionStatusOf(await validateMutated(truncated), 'log_bytes_match')).toBe('fail');

    const flipped = await mutateZip(scenario.bundlePath, async (zip) => {
      // Flip a nibble inside a quoted 64-hex value (session.start's machine_id),
      // which keeps the file valid NDJSON — so this detection, not the parser,
      // is what catches it.
      const text = await zip.file(slogName)!.async('string');
      const out = text.replace(
        /"([0-9a-f]{64})"/,
        (_m, hex: string) => `"${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}"`,
      );
      expect(out).not.toBe(text);
      zip.file(slogName, out);
    });
    expect(detectionStatusOf(await validateMutated(flipped), 'log_bytes_match')).toBe('fail');
  });

  it('STRIPPING the final marker to buy back prefix semantics fails check 1', async () => {
    // The obvious attack: delete one key from the manifest so the reader falls
    // back to the lenient prefix reading, then append freely. `final` is inside
    // the signed payload, so removing it changes the canonical bytes and the
    // seal no longer verifies against the session's own public key.
    const buf = await mutateZip(scenario.bundlePath, async (zip) => {
      const name = `manifest-${scenario.sessions[0]!.sessionId}.json`;
      const manifest = JSON.parse(await zip.file(name)!.async('string')) as Record<string, unknown>;
      expect(manifest['final']).toBe(true);
      delete manifest['final'];
      zip.file(name, canonicalize(manifest));
    });

    const report = await validateMutated(buf);
    expect(statusOf(report, 'manifest_sig')).toBe('fail');
  });

  it('FLIPPING the final marker to false also fails check 1', async () => {
    const buf = await mutateZip(scenario.bundlePath, async (zip) => {
      const name = `manifest-${scenario.sessions[0]!.sessionId}.json`;
      const manifest = JSON.parse(await zip.file(name)!.async('string')) as Record<string, unknown>;
      manifest['final'] = false;
      zip.file(name, canonicalize(manifest));
    });

    const report = await validateMutated(buf);
    expect(statusOf(report, 'manifest_sig')).toBe('fail');
  });

  it('the final-sealed bundle is still clean after all mutations', async () => {
    expectNoBundleDetections((await loadAndValidate(scenario.bundlePath)).report);
  });
});

// ===========================================================================
// THE CONTROL, and the DOWNGRADE.
//
// The append above must fail ONLY because the seal claimed to be final. The
// identical bytes under a non-final seal are an honest student whose editor was
// still open, and accusing them is the failure mode this whole design exists to
// prevent.
//
// It is also what a student gets by restoring an earlier, genuinely-signed
// non-final seal in place of their final one. Nothing crypto can refute that —
// both seals are true statements by the same key — and it is byte-for-byte
// identical to the honest case. So it stays a PASS, and the unattested tail is
// REPORTED rather than passing silently as "sealed".
// ===========================================================================

describe('the same append under a NON-final seal is not a finding', () => {
  let scenario: RollingScenario;
  let slogName: string;

  beforeAll(async () => {
    const root = await makeRoot('rolling-nonfinal');
    scenario = await buildRollingSealedBundle({
      root,
      sessionCount: 1,
      files: [{ path: 'main.py', initial: 'def solve():\n    pass\n', append: 'solve()\n' }],
      final: false,
    });
    slogName = `session-${scenario.sessions[0]!.sessionId}.slog`;
  });

  it('carries no final marker and is read as a prefix commitment', async () => {
    const sessionId = scenario.sessions[0]!.sessionId;
    const json = await fsPromises.readFile(
      path.join(scenario.provenanceDir, `manifest-${sessionId}.json`),
      'utf8',
    );
    expect(JSON.parse(json)).not.toHaveProperty('final');

    const verified = await loadAndValidate(scenario.bundlePath);
    expect(verified.bundle.rollingSeal!.coverage![0]!.final).toBe(false);
    expectAllChecksPass(verified.report);
    expectNoBundleDetections(verified.report);
  });

  it('does NOT accuse, and names the unattested tail and the missing final seal', async () => {
    const buf = await mutateZip(scenario.bundlePath, async (zip) => {
      const lines = (await zip.file(slogName)!.async('string')).trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]!) as {
        seq: number;
        t: number;
        wall: string;
        hash: string;
      };
      const appended = chainEntry(last.hash, {
        seq: last.seq + 1,
        t: last.t + 1000,
        wall: new Date(new Date(last.wall).getTime() + 1000).toISOString(),
        kind: 'session.heartbeat',
        data: { focused: true, active_file: null, idle_since_ms: 0 },
      });
      zip.file(slogName, `${lines.join('\n')}\n${serializeEntry(appended)}`);
    });

    const report = await validateMutated(buf);
    expect(detectionStatusOf(report, 'log_bytes_match')).toBe('pass');

    const detection = report.bundleDetections!.find((c) => c.id === 'log_bytes_match')!;
    expect(detection.detail).toContain('written after the last seal');
    expect(detection.detail).toContain('NOT marked');
    expect(detection.detail).toContain('could not be detected');
  });

  it('but the sealed PREFIX is still enforced', async () => {
    // Making finality the trigger for strictness must not cost the enforcement
    // that already existed. Editing inside the sealed region reproduces no
    // state the file ever passed through.
    const buf = await mutateZip(scenario.bundlePath, async (zip) => {
      const text = await zip.file(slogName)!.async('string');
      const out = text.replace(
        /"([0-9a-f]{64})"/,
        (_m, hex: string) => `"${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}"`,
      );
      expect(out).not.toBe(text);
      zip.file(slogName, out);
    });
    expect(detectionStatusOf(await validateMutated(buf), 'log_bytes_match')).toBe('fail');
  });
});
