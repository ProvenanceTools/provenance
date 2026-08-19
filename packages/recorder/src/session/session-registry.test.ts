import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FixedClock, parseEntries, validateChain, canonicalize } from '@provenance/log-core';
import type { Manifest } from '@provenance/log-core';
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
