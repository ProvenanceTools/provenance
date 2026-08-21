import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  FixedClock,
  parseEntries,
  validateChain,
  canonicalize,
  rollingManifestFilenames,
  validateBundleManifestShape,
  validateRollingSessionManifest,
} from '@provenance/log-core';
import type { Manifest } from '@provenance/log-core';
import * as vscodeMock from 'vscode';
import { startSession, SessionRegistry } from './session-registry.js';
import type { ActiveSession } from './session-registry.js';

function makeExtension(): import('vscode').Extension<unknown> {
  return {
    id: 'itsgeagle.provenance-recorder',
    extensionUri: { fsPath: '/fake/ext' } as import('vscode').Uri,
    extensionPath: '/fake/ext',
    isActive: true,
    packageJSON: { version: '0.0.0', publisher: 'itsgeagle', name: 'provenance-recorder' },
    exports: undefined,
    activate: () => Promise.resolve(undefined),
    extensionKind: 1 as import('vscode').ExtensionKind,
  };
}

async function signedManifest(fields: {
  assignment_id: string;
  semester: string;
  issued_at: string;
  files_under_review: string[];
}): Promise<Manifest> {
  const secretKey = ed.utils.randomSecretKey();
  const payload = canonicalize(fields);
  const sig = await ed.signAsync(new TextEncoder().encode(payload), secretKey);
  return { ...fields, sig: bytesToHex(sig) };
}

describe('startSession', () => {
  let tmpDir: string;
  let assignmentRoot: string;
  let provenanceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-session-'));
    assignmentRoot = path.join(tmpDir, 'workspace');
    provenanceDir = path.join(tmpDir, 'provenance');
    await fs.mkdir(assignmentRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates .provenance/ dir and a .slog file with a valid session.start entry', async () => {
    const manifest = await signedManifest({
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    });

    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const session = await startSession({
      assignmentRoot,
      manifest,
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      clock,
      provenanceDirOverride: provenanceDir,
    });

    expect(session.slogPath).toContain('session-');
    expect(session.assignmentRoot).toBe(assignmentRoot);

    await session.dispose();

    const slogContents = await fs.readFile(session.slogPath, 'utf8');
    const parseResult = parseEntries(slogContents);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const entries = parseResult.value;
    expect(entries[0]?.kind).toBe('session.start');
    expect(entries[entries.length - 1]?.kind).toBe('session.end');

    const chainResult = validateChain(entries);
    expect(chainResult.ok).toBe(true);
  });

  it('two independent calls to startSession produce independently chained sessions', async () => {
    const manifestA = await signedManifest({
      assignment_id: 'cats',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    });
    const manifestB = await signedManifest({
      assignment_id: 'hog',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    });

    const rootA = path.join(tmpDir, 'cats');
    const rootB = path.join(tmpDir, 'hog');
    await fs.mkdir(rootA, { recursive: true });
    await fs.mkdir(rootB, { recursive: true });

    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const sessionA = await startSession({
      assignmentRoot: rootA,
      manifest: manifestA,
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      clock,
      provenanceDirOverride: path.join(rootA, '.provenance'),
    });
    const sessionB = await startSession({
      assignmentRoot: rootB,
      manifest: manifestB,
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      clock,
      provenanceDirOverride: path.join(rootB, '.provenance'),
    });

    expect(sessionA.sessionHost.sessionId).not.toBe(sessionB.sessionHost.sessionId);
    expect(sessionA.provenanceDir).not.toBe(sessionB.provenanceDir);

    await sessionA.dispose();
    await sessionB.dispose();

    // Each session's .slog only contains ITS OWN manifest's assignment id.
    const contentsA = await fs.readFile(sessionA.slogPath, 'utf8');
    const contentsB = await fs.readFile(sessionB.slogPath, 'utf8');
    expect(contentsA).toContain('"cats"');
    expect(contentsA).not.toContain('"hog"');
    expect(contentsB).toContain('"hog"');
    expect(contentsB).not.toContain('"cats"');
  });
});

describe('SessionRegistry', () => {
  it('resolveForPath routes to the nearest-ancestor session', async () => {
    const registry = new SessionRegistry();
    const fakeSession = (root: string): ActiveSession =>
      ({ assignmentRoot: root, dispose: async () => {} }) as unknown as ActiveSession;

    const cats = path.join('/ws', '61a', 'cats');
    const hog = path.join('/ws', '61a', 'hog');
    registry.add(fakeSession(cats));
    registry.add(fakeSession(hog));

    expect(registry.resolveForPath(path.join(cats, 'x.py'))?.assignmentRoot).toBe(cats);
    expect(registry.resolveForPath(path.join(hog, 'y.py'))?.assignmentRoot).toBe(hog);
    expect(registry.resolveForPath(path.join('/ws', '61a', 'notes.md'))).toBeUndefined();
  });

  it('all() returns every added session; get() looks up by exact root', () => {
    const registry = new SessionRegistry();
    const fakeSession = (root: string): ActiveSession =>
      ({ assignmentRoot: root, dispose: async () => {} }) as unknown as ActiveSession;
    const a = fakeSession('/ws/a');
    const b = fakeSession('/ws/b');
    registry.add(a);
    registry.add(b);

    expect(registry.all()).toEqual([a, b]);
    expect(registry.get('/ws/a')).toBe(a);
    expect(registry.get('/ws/missing')).toBeUndefined();
  });

  it('disposeAll() disposes every session and empties the registry', async () => {
    const registry = new SessionRegistry();
    let disposedCount = 0;
    const fakeSession = (root: string): ActiveSession =>
      ({
        assignmentRoot: root,
        dispose: async () => {
          disposedCount++;
        },
      }) as unknown as ActiveSession;
    registry.add(fakeSession('/ws/a'));
    registry.add(fakeSession('/ws/b'));

    await registry.disposeAll();

    expect(disposedCount).toBe(2);
    expect(registry.all()).toEqual([]);
  });

  it('pruneToRoots disposes sessions no longer under any current root', async () => {
    const registry = new SessionRegistry();
    const disposed: string[] = [];
    const fakeSession = (root: string): ActiveSession =>
      ({
        assignmentRoot: root,
        dispose: async () => {
          disposed.push(root);
        },
      }) as unknown as ActiveSession;
    const kept = path.join('/ws', 'keep');
    const removed = path.join('/ws', 'removed');
    registry.add(fakeSession(kept));
    registry.add(fakeSession(removed));

    await registry.pruneToRoots([path.join('/ws', 'keep')]);

    expect(disposed).toEqual([removed]);
    expect(registry.all().map((s) => s.assignmentRoot)).toEqual([kept]);
  });
});

// ---------------------------------------------------------------------------
// Capture policy end-to-end (program spec §4)
// ---------------------------------------------------------------------------

describe('startSession — capture policy', () => {
  let tmpDir: string;
  let assignmentRoot: string;
  let provenanceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-policy-'));
    assignmentRoot = path.join(tmpDir, 'workspace');
    provenanceDir = path.join(tmpDir, 'provenance');
    await fs.mkdir(assignmentRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * A 2.0 manifest carrying a policy. The signature is not re-checked by
   * startSession — activation/manifest-loader.ts has already chain-verified it by
   * the time it gets here — so a placeholder cert/sig is faithful to the seam.
   */
  function manifestWithPolicy(capture: Record<string, unknown>): Manifest {
    return {
      format_version: '2.0',
      assignment_id: 'proj2',
      semester: 'fa26',
      issued_at: '2026-09-08T00:00:00Z',
      files_under_review: ['hw.py'],
      sig: 'a'.repeat(128),
      course_id: 'berkeley-cs61b',
      collaboration: 'solo',
      submission: 'bundle',
      scope: 'directory',
      policy: { capture },
      course_cert: {
        course_id: 'berkeley-cs61b',
        course_pubkey: 'b'.repeat(64),
        valid_from: '2026-08-20',
        valid_until: '2027-01-15',
        root_sig: 'c'.repeat(128),
      },
    };
  }

  async function start(manifest: Manifest): Promise<ActiveSession> {
    return startSession({
      assignmentRoot,
      manifest,
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      clock: new FixedClock(0, new Date('2026-01-01T00:00:00.000Z')),
      provenanceDirOverride: provenanceDir,
    });
  }

  it('drops policy-disabled kinds but keeps every floor kind, chain intact', async () => {
    const session = await start(
      manifestWithPolicy({
        selection_change: false,
        focus_change: false,
        terminal: false,
      }),
    );

    // Emit one of each through the live session host, exactly as the wiring does.
    session.sessionHost.emit('selection.change', {
      path: 'hw.py',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      was_selection: true,
    });
    // doc.open is on the hard floor — no policy key can switch it off, because
    // its `content` is the reconstruction seed.
    session.sessionHost.emit('doc.open', { path: 'hw.py', sha256: 'd'.repeat(64), line_count: 1 });
    session.sessionHost.emit('terminal.command', { terminal_id: 't1', command: 'ls' });
    session.sessionHost.emit('doc.change', { path: 'hw.py', deltas: [], source: 'typed' });

    await session.dispose();

    const parsed = parseEntries(await fs.readFile(session.slogPath, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const kinds = parsed.value.map((e) => e.kind);

    expect(kinds).toContain('doc.change');
    expect(kinds).toContain('session.start');
    expect(kinds).toContain('session.end');
    expect(kinds).toContain('doc.open');
    expect(kinds).not.toContain('selection.change');
    expect(kinds).not.toContain('terminal.command');

    // The dropped events must leave no seq gap, or validation check 3 reads the
    // log as tampered.
    expect(parsed.value.map((e) => e.seq)).toEqual(parsed.value.map((_, i) => i));
    expect(validateChain(parsed.value).ok).toBe(true);
  });

  it('carries the policy into session.start so the analyzer can tell absent from disabled', async () => {
    const manifest = manifestWithPolicy({ selection_change: false, heartbeat_interval_ms: 60_000 });
    const session = await start(manifest);
    await session.dispose();

    const parsed = parseEntries(await fs.readFile(session.slogPath, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const start0 = parsed.value.find((e) => e.kind === 'session.start');
    const data = start0?.data as { manifest?: Manifest };
    expect(data.manifest?.policy).toEqual({
      capture: { selection_change: false, heartbeat_interval_ms: 60_000 },
    });
  });

  /** Run a session for `elapsedMs` of fake time and count its session.heartbeat entries. */
  async function heartbeatsAfter(manifest: Manifest, elapsedMs: number): Promise<number> {
    vi.useFakeTimers();
    let session: ActiveSession;
    try {
      session = await start(manifest);
      await vi.advanceTimersByTimeAsync(elapsedMs);
    } finally {
      // Restore before dispose(): teardown awaits real file I/O.
      vi.useRealTimers();
    }
    await session.dispose();
    const parsed = parseEntries(await fs.readFile(session.slogPath, 'utf8'));
    if (!parsed.ok) throw new Error('slog did not parse');
    return parsed.value.filter((e) => e.kind === 'session.heartbeat').length;
  }

  it('honours policy.capture.heartbeat_interval_ms, clamped to the [5s, 120s] range', async () => {
    // 1000 is below the clamp floor, so the effective cadence is 5000: three ticks
    // in 15.5s. The default 30s cadence would produce none in the same span, which
    // is what makes this an assertion about the policy and not about the clock.
    expect(
      await heartbeatsAfter(manifestWithPolicy({ heartbeat_interval_ms: 1_000 }), 15_500),
    ).toBe(3);
  });

  it('leaves the heartbeat at its 30s default when the policy does not set an interval', async () => {
    expect(await heartbeatsAfter(manifestWithPolicy({ selection_change: false }), 15_500)).toBe(0);
  });

  it('records the full event set for a 1.x manifest (no policy possible)', async () => {
    const session = await start(
      await signedManifest({
        assignment_id: 'hw03',
        semester: 'fa26',
        issued_at: '2026-09-15T00:00:00Z',
        files_under_review: ['hw.py'],
      }),
    );
    session.sessionHost.emit('selection.change', {
      path: 'hw.py',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      was_selection: true,
    });
    await session.dispose();

    const parsed = parseEntries(await fs.readFile(session.slogPath, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.map((e) => e.kind)).toContain('selection.change');
  });
});

// ---------------------------------------------------------------------------
// The ROLLING SEAL, wired into the live session (program spec §8).
// ---------------------------------------------------------------------------

describe('startSession — rolling seal', () => {
  let tmpDir: string;
  let assignmentRoot: string;
  let provenanceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-rolling-'));
    assignmentRoot = path.join(tmpDir, 'workspace');
    provenanceDir = path.join(tmpDir, 'provenance');
    await fs.mkdir(assignmentRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function start(
    root: string = assignmentRoot,
    submission?: 'bundle' | 'git',
  ): Promise<ActiveSession> {
    const base = await signedManifest({
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    });
    // `submission` reaches startSession only from an already-verified 2.0
    // manifest: parseManifestValue returns early for 1.x and the object it
    // hands back has no `submission` at all, so this field can never carry an
    // unsigned value in production.
    const manifest = submission === undefined ? base : { ...base, submission };
    return startSession({
      assignmentRoot: root,
      manifest,
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      clock: new FixedClock(0, new Date('2026-01-01T00:00:00.000Z')),
      provenanceDirOverride: provenanceDir,
    });
  }

  /** The session_id recorded in session.start — the id the analyzer keys on. */
  async function sessionIdOf(session: ActiveSession): Promise<string> {
    // The writer buffers (PRD §4.7), so session.start is not on disk until a flush.
    await session.writer.flush();
    const parsed = parseEntries(await fs.readFile(session.slogPath, 'utf8'));
    if (!parsed.ok) throw new Error('slog did not parse');
    return (parsed.value[0]!.data as { session_id: string }).session_id;
  }

  /** Emit enough hard-floor events to cross CHECKPOINT_INTERVAL (100). */
  function emitPastCheckpoint(session: ActiveSession, count = 120): void {
    for (let i = 0; i < count; i++) {
      session.sessionHost.emit('doc.open', {
        path: 'hw.py',
        sha256: 'd'.repeat(64),
        line_count: 1,
      });
    }
  }

  // -------------------------------------------------------------------------
  // The submission-mode gate. `submission` is in the 2.0 SIGNED payload, so it
  // is the one trustworthy way to know whether this course submits by git.
  // -------------------------------------------------------------------------

  it('writes NO rolling seal when the course signed submission: bundle', async () => {
    const session = await start(assignmentRoot, 'bundle');
    const sessionId = await sessionIdOf(session);
    emitPastCheckpoint(session);
    await session.dispose();

    // Not at session start, not at a checkpoint, not at dispose.
    const names = rollingManifestFilenames(sessionId);
    const entries = await fs.readdir(provenanceDir);
    expect(entries).not.toContain(names.json);
    expect(entries).not.toContain(names.sig);
    // The recording itself is untouched.
    expect(entries.some((e) => e.endsWith('.slog'))).toBe(true);
  });

  it('writes a rolling seal when the course signed submission: git', async () => {
    const session = await start(assignmentRoot, 'git');
    const sessionId = await sessionIdOf(session);
    const names = rollingManifestFilenames(sessionId);
    const entries = await fs.readdir(provenanceDir);
    expect(entries).toContain(names.json);
    expect(entries).toContain(names.sig);
    await session.dispose();
  });

  it('FAILS OPEN: a 1.x manifest, which cannot sign a submission mode, still seals', async () => {
    // A course that has not migrated to a 2.0 manifest has no signed statement
    // either way. Suppressing the seal there would leave every session
    // `unsealed_session` — check 1 failing on a student who did nothing wrong —
    // whereas rolling unnecessarily costs two files the classic manifest
    // overrides anyway.
    const session = await start(assignmentRoot);
    const sessionId = await sessionIdOf(session);
    const entries = await fs.readdir(provenanceDir);
    expect(entries).toContain(rollingManifestFilenames(sessionId).json);
    await session.dispose();
  });

  it('seals a session that never reaches a checkpoint (zero events past session.start)', async () => {
    const session = await start();
    const sessionId = await sessionIdOf(session);

    // No dispose yet: the seal must already be on disk from session start, or a
    // short git-submitted session would be committed with nothing covering it.
    const names = rollingManifestFilenames(sessionId);
    const entries = await fs.readdir(provenanceDir);
    expect(entries).toContain(names.json);
    expect(entries).toContain(names.sig);

    await session.dispose();
  });

  it('names the manifest after session.start.session_id, not the .slog filename uuid', async () => {
    const session = await start();
    const sessionId = await sessionIdOf(session);
    await session.dispose();

    // These genuinely differ in the recorder — the .slog gets its own uuid.
    const slogFileUuid = path.basename(session.slogPath).replace(/^session-|\.slog$/g, '');
    expect(slogFileUuid).not.toBe(sessionId);

    // The analyzer reconciles seals against session.start ids, so the manifest
    // must be named after that one.
    const entries = await fs.readdir(provenanceDir);
    expect(entries).toContain(`manifest-${sessionId}.json`);
    expect(entries).not.toContain(`manifest-${slogFileUuid}.json`);
  });

  it('the sealed manifest obeys the rolling-seal rules and verifies against the session key', async () => {
    const session = await start();
    const sessionId = await sessionIdOf(session);
    await session.dispose();

    const json = await fs.readFile(path.join(provenanceDir, `manifest-${sessionId}.json`), 'utf8');
    const sigHex = await fs.readFile(path.join(provenanceDir, `manifest-${sessionId}.sig`), 'utf8');

    const shape = validateBundleManifestShape(JSON.parse(json));
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(validateRollingSessionManifest(shape.value, sessionId).ok).toBe(true);

    // Signed by THIS session's key — the same one whose pubkey is in session.start.
    expect(
      await ed.verifyAsync(
        hexToBytes(sigHex),
        new TextEncoder().encode(json),
        hexToBytes(session.sessionKeypair.publicKeyHex),
      ),
    ).toBe(true);
  });

  it('rewrites the seal on a checkpoint, tracking the growing .slog', async () => {
    const session = await start();
    const sessionId = await sessionIdOf(session);
    const manifestPath = path.join(provenanceDir, `manifest-${sessionId}.json`);
    const atStart = await fs.readFile(manifestPath, 'utf8');

    emitPastCheckpoint(session);
    await session.writer.flush();
    await session.getPendingCheckpoint();

    const afterCheckpoint = await fs.readFile(manifestPath, 'utf8');
    expect(afterCheckpoint).not.toBe(atStart);

    // Still exactly one session, still bound to its filename.
    const shape = validateBundleManifestShape(JSON.parse(afterCheckpoint));
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(validateRollingSessionManifest(shape.value, sessionId).ok).toBe(true);

    await session.dispose();
  });

  // -------------------------------------------------------------------------
  // The `final` marker, bound to the ONE moment it is true.
  //
  // A final seal promotes the reader to whole-file semantics, so an append past
  // it fails. That is only honest at dispose(), after session.end is emitted,
  // the writer flushed and the checkpoint drained. Claiming it any earlier
  // would make the student's next keystroke a finding.
  // -------------------------------------------------------------------------

  /** Read the rolling manifest this session has on disk right now. */
  async function readSeal(sessionId: string): Promise<Record<string, unknown>> {
    const json = await fs.readFile(path.join(provenanceDir, `manifest-${sessionId}.json`), 'utf8');
    return JSON.parse(json) as Record<string, unknown>;
  }

  it('does NOT mark the session-start seal final', async () => {
    const session = await start();
    const sessionId = await sessionIdOf(session);

    // The log is one entry old and about to grow for the rest of the session.
    expect(await readSeal(sessionId)).not.toHaveProperty('final');

    await session.dispose();
  });

  it('does NOT mark a checkpoint seal final', async () => {
    const session = await start();
    const sessionId = await sessionIdOf(session);

    emitPastCheckpoint(session);
    await session.writer.flush();
    await session.getPendingCheckpoint();

    // A checkpoint says "here is where I am", not "I am finished". The student
    // is still typing.
    expect(await readSeal(sessionId)).not.toHaveProperty('final');

    await session.dispose();
  });

  it('marks the dispose() seal final, so an append after the session fails', async () => {
    const session = await start();
    const sessionId = await sessionIdOf(session);
    emitPastCheckpoint(session);
    await session.dispose();

    const seal = await readSeal(sessionId);
    expect(seal['final']).toBe(true);

    // Still a well-formed rolling seal bound to its filename, and the claim is
    // signed by this session's own key — a student cannot strip it.
    const shape = validateBundleManifestShape(seal);
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(validateRollingSessionManifest(shape.value, sessionId).ok).toBe(true);

    const json = await fs.readFile(path.join(provenanceDir, `manifest-${sessionId}.json`), 'utf8');
    const sigHex = await fs.readFile(path.join(provenanceDir, `manifest-${sessionId}.sig`), 'utf8');
    expect(
      await ed.verifyAsync(
        hexToBytes(sigHex),
        new TextEncoder().encode(json),
        hexToBytes(session.sessionKeypair.publicKeyHex),
      ),
    ).toBe(true);
  });

  it('the final seal commits to the WHOLE log, session.end included', async () => {
    // The claim and the digest have to agree. If dispose() sealed before the
    // final flush, `final: true` would assert whole-file coverage of bytes the
    // digest does not cover — and the reader would then fail an honest bundle.
    const session = await start();
    const sessionId = await sessionIdOf(session);
    await session.dispose();

    const seal = await readSeal(sessionId);
    const sessions = seal['sessions'] as Array<{ slog_sha256: string; meta_sha256: string }>;
    const slogBytes = await fs.readFile(session.slogPath);
    const metaBytes = await fs.readFile(`${session.slogPath}.meta`);

    expect(sessions[0]!.slog_sha256).toBe(createHash('sha256').update(slogBytes).digest('hex'));
    expect(sessions[0]!.meta_sha256).toBe(createHash('sha256').update(metaBytes).digest('hex'));
  });

  it('leaves NO final seal when the session dies without dispose()', async () => {
    // A crash, a power cut, a full disk, a `git checkout` that removed
    // `.provenance/`. The last non-final seal simply stands, and the reader
    // keeps prefix semantics with the unattested tail reported. This is a
    // coverage gap, never a tamper finding — which is exactly why finality is a
    // claim the writer makes rather than something the reader infers from a
    // trailing session.end entry.
    const session = await start();
    const sessionId = await sessionIdOf(session);
    emitPastCheckpoint(session);
    await session.writer.flush();
    await session.getPendingCheckpoint();

    // Deliberately no dispose() — the process "died" here.
    const seal = await readSeal(sessionId);
    expect(seal).not.toHaveProperty('final');

    await session.dispose();
  });

  it('the final seal after dispose() covers the fully flushed .slog', async () => {
    const session = await start();
    const sessionId = await sessionIdOf(session);
    await session.dispose();

    const json = await fs.readFile(path.join(provenanceDir, `manifest-${sessionId}.json`), 'utf8');
    const manifest = JSON.parse(json) as { sessions: Array<{ slog_sha256: string }> };

    // dispose() emits session.end, flushes the writer, drains the checkpoint and
    // only then re-seals — so the recorded hash is of the final .slog bytes.
    const slogBytes = await fs.readFile(session.slogPath);
    expect(manifest.sessions[0]!.slog_sha256).toBe(
      createHash('sha256').update(slogBytes).digest('hex'),
    );

    const parsed = parseEntries(slogBytes.toString('utf8'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value[parsed.value.length - 1]!.kind).toBe('session.end');
  });

  it('never writes manifest.json or manifest.sig, and leaves no temp files', async () => {
    const session = await start();
    emitPastCheckpoint(session);
    await session.writer.flush();
    await session.getPendingCheckpoint();
    await session.dispose();

    const entries = await fs.readdir(provenanceDir);
    expect(entries).not.toContain('manifest.json');
    expect(entries).not.toContain('manifest.sig');
    expect(entries.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps recording when the seal cannot be written (degraded, never fatal)', async () => {
    const session = await start();

    // Simulate a `git checkout` removing .provenance/ out from under a live
    // session. The SessionWriter's fd survives the unlink and keeps chaining;
    // the seal has nowhere to land. Recording must win.
    await fs.rm(provenanceDir, { recursive: true, force: true });

    const entries = [];
    for (let i = 0; i < 120; i++) {
      entries.push(
        session.sessionHost.emit('doc.open', {
          path: 'hw.py',
          sha256: 'd'.repeat(64),
          line_count: 1,
        }),
      );
    }

    // Every event was still accepted and chained — the seal failure did not
    // interrupt, degrade or short-circuit the event path.
    expect(entries.every((e) => e !== null)).toBe(true);
    const seqs = entries.map((e) => e!.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(120);
    // Each entry still links to the one before it — the hash chain never
    // faltered while the seal was failing underneath it.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.prev_hash).toBe(entries[i - 1]!.hash);
      expect(entries[i]!.seq).toBe(entries[i - 1]!.seq + 1);
    }

    // Neither the checkpoint chain nor teardown rejects.
    await expect(session.getPendingCheckpoint()).resolves.toBeUndefined();
    await expect(session.dispose()).resolves.toBeUndefined();

    // And the seal never resurrected the directory git deleted.
    await expect(fs.stat(provenanceDir)).rejects.toThrow(/ENOENT/);
  });

  it('two sessions sharing one .provenance/ seal to disjoint paths', async () => {
    const rootA = path.join(tmpDir, 'partner-a');
    const rootB = path.join(tmpDir, 'partner-b');
    await fs.mkdir(rootA, { recursive: true });
    await fs.mkdir(rootB, { recursive: true });

    // Both partners' recorders share ONE .provenance/ — the 61B group case.
    // A is flushed before B starts on purpose: B's chain recovery reads every
    // .slog in the shared directory at startup, and an unflushed (still empty)
    // one reads as corrupt and gets quarantined. That interaction predates the
    // rolling seal and belongs to the git-collaboration workstream; it is
    // sidestepped here so this test measures only seal-path disjointness.
    const a = await start(rootA);
    const idA = await sessionIdOf(a);
    const b = await start(rootB);
    const idB = await sessionIdOf(b);
    expect(idA).not.toBe(idB);

    await a.dispose();
    await b.dispose();

    // Add-only: both seals present, neither clobbered.
    const entries = await fs.readdir(provenanceDir);
    for (const id of [idA, idB]) {
      expect(entries).toContain(`manifest-${id}.json`);
      expect(entries).toContain(`manifest-${id}.sig`);
    }

    // Each seal verifies against its OWN session's key, and only its own.
    for (const [id, mine, theirs] of [
      [idA, a, b],
      [idB, b, a],
    ] as const) {
      const json = await fs.readFile(path.join(provenanceDir, `manifest-${id}.json`), 'utf8');
      const sig = hexToBytes(
        await fs.readFile(path.join(provenanceDir, `manifest-${id}.sig`), 'utf8'),
      );
      const msg = new TextEncoder().encode(json);
      expect(await ed.verifyAsync(sig, msg, hexToBytes(mine.sessionKeypair.publicKeyHex))).toBe(
        true,
      );
      expect(await ed.verifyAsync(sig, msg, hexToBytes(theirs.sessionKeypair.publicKeyHex))).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The §5.6 capability reports, as they reach the chain
// ---------------------------------------------------------------------------

describe('startSession — the §5.6 capability reports', () => {
  let tmpDir: string;
  let assignmentRoot: string;
  let provenanceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-cap-'));
    assignmentRoot = path.join(tmpDir, 'workspace');
    provenanceDir = path.join(tmpDir, 'provenance');
    await fs.mkdir(assignmentRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** The `session.start` payload actually written to disk, parsed back. */
  async function sessionStartOnDisk(
    extra: Partial<Parameters<typeof startSession>[0]> = {},
    files: string[] = ['hw.py'],
  ): Promise<Record<string, unknown>> {
    const manifest = await signedManifest({
      assignment_id: 'proj2',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: files,
    });
    const session = await startSession({
      assignmentRoot,
      manifest,
      extension: makeExtension(),
      vscodeVersion: '1.100.0',
      platform: 'darwin-arm64',
      clock: new FixedClock(0, new Date('2026-01-01T00:00:00.000Z')),
      provenanceDirOverride: provenanceDir,
      ...extra,
    });
    await session.dispose();
    const parsed = parseEntries(await fs.readFile(session.slogPath, 'utf8'));
    if (!parsed.ok) throw new Error('slog did not parse');
    const start = parsed.value[0]!;
    expect(start.kind).toBe('session.start');
    return start.data as Record<string, unknown>;
  }

  it('reports the file scope it actually watched, and it chains', async () => {
    const data = await sessionStartOnDisk({}, ['hw.py', 'src/helpers.py']);
    expect(data['file_scope']).toEqual({
      watched: ['hw.py', 'src/helpers.py'],
      complete: true,
    });
  });

  it('reports git as UNAVAILABLE when there is no git extension to observe with', async () => {
    // The mock host publishes no `vscode.git`, which is exactly the condition on
    // which `startGitWiring` returns an inert wiring. The absence of any
    // `git.event` in this session is therefore FULLY EXPLAINED, and this field
    // is the only thing that says so.
    const data = await sessionStartOnDisk();
    expect(data['git_capture']).toBe('unavailable');
  });

  it('reports git as AVAILABLE when a repository this session owns is open', async () => {
    const repo = { rootUri: { fsPath: assignmentRoot }, state: { onDidChange: () => ({ dispose: () => undefined }) } };
    const gitExtension = {
      id: 'vscode.git',
      exports: {
        getAPI: () => ({
          repositories: [repo],
          onDidOpenRepository: () => ({ dispose: () => undefined }),
          onDidCloseRepository: () => ({ dispose: () => undefined }),
        }),
      },
      packageJSON: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock
    } as any;
    const spy = vi
      .spyOn(vscodeMock.extensions, 'getExtension')
      .mockImplementation((id: string) => (id === 'vscode.git' ? gitExtension : undefined));
    try {
      const data = await sessionStartOnDisk();
      expect(data['git_capture']).toBe('available');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports git as NOT_OWNED when git works and nothing it sees is in scope', async () => {
    // Distinct from `unavailable`, and the difference is what a grader acts on:
    // git observation was live, the assignment simply sat outside every
    // repository git could see, so every git.event was dropped by the ownership
    // gate rather than never produced.
    const stranger = {
      rootUri: { fsPath: path.join(tmpDir, 'unrelated-repo') },
      state: { onDidChange: () => ({ dispose: () => undefined }) },
    };
    const gitExtension = {
      id: 'vscode.git',
      exports: {
        getAPI: () => ({
          repositories: [stranger],
          onDidOpenRepository: () => ({ dispose: () => undefined }),
          onDidCloseRepository: () => ({ dispose: () => undefined }),
        }),
      },
      packageJSON: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal mock
    } as any;
    const spy = vi
      .spyOn(vscodeMock.extensions, 'getExtension')
      .mockImplementation((id: string) => (id === 'vscode.git' ? gitExtension : undefined));
    try {
      const data = await sessionStartOnDisk({
        isRepoOwnedByThisRoot: (p: string) => p === assignmentRoot,
      });
      expect(data['git_capture']).toBe('not_owned');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports witnessing as AVAILABLE when the .provenance/ watcher was created', async () => {
    const data = await sessionStartOnDisk();
    expect(data['witness_capture']).toBe('available');
  });

  it('reports witnessing as UNAVAILABLE when the watcher could not be created', async () => {
    // The capability IS the artifact: one watcher, one answer. There is no way
    // for the report to say "available" while the wiring watches nothing.
    const data = await sessionStartOnDisk({
      createProvenanceDirWatcher: () => {
        throw new Error('no file system watcher here');
      },
    });
    expect(data['witness_capture']).toBe('unavailable');
  });

  it('records witnessing UNAVAILABLE rather than crashing the session', async () => {
    // A watcher that cannot be created costs witnessing, never recording.
    const manifest = await signedManifest({
      assignment_id: 'proj2',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    });
    const session = await startSession({
      assignmentRoot,
      manifest,
      extension: makeExtension(),
      vscodeVersion: '1.100.0',
      platform: 'darwin-arm64',
      clock: new FixedClock(0, new Date('2026-01-01T00:00:00.000Z')),
      provenanceDirOverride: provenanceDir,
      createProvenanceDirWatcher: () => {
        throw new Error('no file system watcher here');
      },
    });
    await session.dispose();
    const parsed = parseEntries(await fs.readFile(session.slogPath, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateChain(parsed.value).ok).toBe(true);
    expect(parsed.value[parsed.value.length - 1]!.kind).toBe('session.end');
  });

  it('never writes null for a capability it cannot establish', async () => {
    // Omission and `null` canonicalize differently and therefore chain to
    // different hashes, so a `null` here would make this recorder's entries hash
    // differently from every other recorder's for the same session.
    const data = await sessionStartOnDisk();
    for (const field of ['git_capture', 'witness_capture', 'file_scope']) {
      if (field in data) expect(data[field]).not.toBeNull();
    }
  });

  it('OMITS file_scope rather than writing a path the format forbids', async () => {
    // S14(b): an absolute path in a course manifest must not reach a signed log.
    const data = await sessionStartOnDisk({}, ['/Users/student/proj2/hw.py']);
    expect('file_scope' in data).toBe(false);
  });
});
