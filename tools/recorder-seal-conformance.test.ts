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

import {
  FixedClock,
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
