/**
 * Unit-level integration test for the activation path.
 * Does NOT use @vscode/test-electron. Uses activateImpl() with injected dependencies
 * so the real VS Code runtime is not required.
 *
 * Verifies the happy path: signed .provenance-manifest → status bar mount → session.start written
 * to a .slog file that round-trips through parseEntries + validateChain.
 *
 * CLAUDE.md: "test the event-to-log-entry transformation as a pure function,
 * separately from the VS Code wiring."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FixedClock, parseEntries, validateChain, canonicalize } from '@provenance/log-core';
import type { Manifest } from '@provenance/log-core';
import { activate, activateImpl, deactivate, fallbackActivationMessage } from '../extension.js';
import type { ActivationError } from './manifest-loader.js';
import { discoverManifests } from './manifest-discovery.js';
import { startSession, SessionRegistry } from '../session/session-registry.js';

// ---------------------------------------------------------------------------
// Helpers: test keypair + manifest
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  return Buffer.from(hex, 'hex');
}

async function generateTestKeypair(): Promise<{ pubkeyHex: string; privkeyHex: string }> {
  const secretKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(secretKey);
  return { pubkeyHex: bytesToHex(publicKey), privkeyHex: bytesToHex(secretKey) };
}

async function signManifest(
  fields: {
    assignment_id: string;
    semester: string;
    issued_at: string;
    files_under_review: string[];
  },
  privkeyHex: string,
): Promise<string> {
  const payload = canonicalize({
    assignment_id: fields.assignment_id,
    semester: fields.semester,
    issued_at: fields.issued_at,
    files_under_review: fields.files_under_review,
  });
  const bytes = new TextEncoder().encode(payload);
  const sig = await ed.signAsync(bytes, hexToBytes(privkeyHex));
  return bytesToHex(sig);
}

// ---------------------------------------------------------------------------
// vscode mock helpers
// ---------------------------------------------------------------------------

function makeWorkspaceFolder(fsPath: string): import('vscode').WorkspaceFolder {
  return {
    uri: { fsPath } as import('vscode').Uri,
    name: 'test',
    index: 0,
  };
}

function makeExtension(): import('vscode').Extension<unknown> {
  return {
    id: 'itsgeagle.provenance-recorder',
    extensionUri: { fsPath: '/fake/ext' } as import('vscode').Uri,
    extensionPath: '/fake/ext',
    isActive: true,
    packageJSON: {
      version: '0.0.0',
      publisher: 'itsgeagle',
      name: 'provenance-recorder',
    },
    exports: undefined,
    activate: () => Promise.resolve(undefined),
    extensionKind: 1 as import('vscode').ExtensionKind,
  };
}

/** Minimal vscode.StatusBarItem stub (no-op). */
function makeStatusBarItem(): import('vscode').StatusBarItem {
  return {
    id: 'test',
    alignment: 1 as import('vscode').StatusBarAlignment,
    priority: 0,
    name: 'test',
    text: '',
    tooltip: '',
    color: undefined,
    backgroundColor: undefined,
    command: undefined,
    accessibilityInformation: undefined,
    show(): void {
      /* no-op */
    },
    hide(): void {
      /* no-op */
    },
    dispose(): void {
      /* no-op */
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('activateImpl — integration', () => {
  let tmpDir: string;
  let provenanceDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-int-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    provenanceDir = path.join(tmpDir, 'provenance');
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when manifest file is missing', async () => {
    const { pubkeyHex } = await generateTestKeypair();
    // Don't write any .provenance-manifest file — simulates missing manifest.

    const disposables: import('vscode').Disposable[] = [];
    const result = await activateImpl({
      workspaceFolder: makeWorkspaceFolder(workspaceDir),
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      pubkeyHex,
      provenanceDirOverride: provenanceDir,
      clock: new FixedClock(0, new Date('2026-01-01T00:00:00.000Z')),
      disposables,
      createStatusBar: (d) => {
        const item = makeStatusBarItem();
        d.push(item);
        return item;
      },
    });

    expect(result).toBeNull();
  });

  it('creates .provenance/ dir and a .slog file with a valid session.start entry', async () => {
    // Arrange: create a signed .provenance-manifest in the workspace dir.
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const manifestFields = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    };
    const sig = await signManifest(manifestFields, privkeyHex);
    const manifest: Manifest = { ...manifestFields, sig };

    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));
    const disposables: import('vscode').Disposable[] = [];

    // Act: run activateImpl with a preloaded manifest (skips file I/O for manifest).
    const session = await activateImpl({
      workspaceFolder: makeWorkspaceFolder(workspaceDir),
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      pubkeyHex,
      provenanceDirOverride: provenanceDir,
      clock,
      disposables,
      createStatusBar: (d) => {
        const item = makeStatusBarItem();
        d.push(item);
        return item;
      },
      preloadedManifest: manifest,
    });

    expect(session).not.toBeNull();
    expect(session!.slogPath).toContain('session-');
    expect(session!.slogPath).toContain('.slog');

    // Trigger dispose in LIFO order (matching VS Code's contract) to simulate teardown.
    // VS Code disposes context.subscriptions in LIFO order. After all subscriptions are disposed,
    // deactivate() is called and awaited. In this test, we manually call session.end and dispose
    // the writer instead of relying on the module-level deactivate() (which requires the real
    // VS Code runtime).
    for (const d of [...disposables].reverse()) {
      const result = d.dispose();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        await result;
      }
    }

    // Manually trigger the deactivation path: emit session.end and flush the writer.
    session!.sessionHost.emit('session.end', { reason: 'test' });
    await session!.writer.dispose();

    // Assert: the .slog file exists.
    const slogContents = await fs.readFile(session!.slogPath, 'utf8');
    expect(slogContents.trim().length).toBeGreaterThan(0);

    // Assert: parse the entries.
    const parseResult = parseEntries(slogContents);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const entries = parseResult.value;
    expect(entries.length).toBeGreaterThanOrEqual(2); // session.start + session.end

    // Assert: first entry is session.start.
    expect(entries[0]?.kind).toBe('session.start');

    // Assert: last entry is session.end.
    const lastEntry = entries[entries.length - 1];
    expect(lastEntry?.kind).toBe('session.end');

    // Assert: session.start data has required PRD §5.1 fields.
    const startData = entries[0]?.data as {
      format_version: string;
      session_id: string;
      assignment: { id: string; semester: string };
    };
    expect(startData.format_version).toBe('1.0');
    expect(startData.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(startData.assignment.id).toBe('hw03');
    expect(startData.assignment.semester).toBe('fa26');

    // Assert: chain validates end-to-end.
    const chainResult = validateChain(entries as Parameters<typeof validateChain>[0]);
    expect(chainResult.ok).toBe(true);
  });

  it('registers a fallback stub command when the manifest is missing', async () => {
    const { pubkeyHex } = await generateTestKeypair();
    // No .provenance-manifest on disk — the recorder must not activate, but it
    // should still register a stub for provenance.prepareSubmissionBundle so the
    // palette entry explains itself instead of throwing "command not found".

    const registerSpy = vi.spyOn(vscode.commands, 'registerCommand');
    const warnSpy = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockResolvedValue(undefined as never);

    try {
      const disposables: import('vscode').Disposable[] = [];
      const result = await activateImpl({
        workspaceFolder: makeWorkspaceFolder(workspaceDir),
        extension: makeExtension(),
        vscodeVersion: '1.97.0',
        platform: 'darwin-arm64',
        pubkeyHex,
        provenanceDirOverride: provenanceDir,
        clock: new FixedClock(0, new Date('2026-01-01T00:00:00.000Z')),
        disposables,
      });

      // Recorder stays inactive (no session), but a stub is registered + tracked.
      expect(result).toBeNull();
      expect(disposables).toHaveLength(1);

      const stubCall = registerSpy.mock.calls.find(
        ([id]) => id === 'provenance.prepareSubmissionBundle',
      );
      expect(stubCall).toBeDefined();

      // The stub must not have created the .provenance dir (PRD §4.1: does nothing).
      const provExists = await fs
        .access(provenanceDir)
        .then(() => true)
        .catch(() => false);
      expect(provExists).toBe(false);

      // Invoking the stub explains the situation instead of failing silently.
      const handler = stubCall![1] as () => unknown;
      await handler();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('.provenance-manifest');
    } finally {
      registerSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('returns null when signature is invalid (signed by different keypair)', async () => {
    // Arrange: create a manifest signed with keypair A, but pass pubkey B to activateImpl.
    const { privkeyHex: privkeyA } = await generateTestKeypair();
    const { pubkeyHex: pubkeyB } = await generateTestKeypair();

    const manifestFields = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw.py'],
    };
    const sig = await signManifest(manifestFields, privkeyA);

    // Write the signed manifest to disk with keypair A's signature.
    const manifestPath = path.join(workspaceDir, '.provenance-manifest');
    const manifest: Manifest = { ...manifestFields, sig };
    await fs.writeFile(manifestPath, JSON.stringify(manifest) + '\n', 'utf8');

    const disposables: import('vscode').Disposable[] = [];

    // Act: activateImpl with pubkeyB, which doesn't match the signature.
    const result = await activateImpl({
      workspaceFolder: makeWorkspaceFolder(workspaceDir),
      extension: makeExtension(),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      pubkeyHex: pubkeyB, // Different keypair — signature won't verify.
      provenanceDirOverride: provenanceDir,
      clock: new FixedClock(0, new Date('2026-01-01T00:00:00.000Z')),
      disposables,
      createStatusBar: (d) => {
        const item = makeStatusBarItem();
        d.push(item);
        return item;
      },
    });

    // Assert: returns null (signature validation failed).
    expect(result).toBeNull();

    // Assert: .provenance dir was NOT created.
    const provExists = await fs
      .access(provenanceDir)
      .then(() => true)
      .catch(() => false);
    expect(provExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fallbackActivationMessage — pure guidance-text mapping
// ---------------------------------------------------------------------------

describe('fallbackActivationMessage', () => {
  const cases: Array<{ error: ActivationError; expects: string[] }> = [
    {
      error: { kind: 'no_manifest_file' },
      expects: ['No Provenance assignment', '.provenance-manifest'],
    },
    {
      error: { kind: 'no_workspace' },
      expects: ['No Provenance assignment', '.provenance-manifest'],
    },
    {
      error: { kind: 'manifest_signature_invalid' },
      expects: ['could not be verified', 'course staff'],
    },
    {
      error: { kind: 'manifest_parse_error', detail: 'bad' },
      expects: ['could not be verified', 'course staff'],
    },
    {
      error: { kind: 'manifest_read_error', message: 'EACCES: denied' },
      expects: ['could not read', 'EACCES: denied'],
    },
  ];

  for (const { error, expects } of cases) {
    it(`explains "${error.kind}" and never says "command not found"`, () => {
      const msg = fallbackActivationMessage(error);
      expect(msg).not.toContain('command not found');
      // Always tells the student recording did not happen.
      expect(msg.toLowerCase()).toContain('recording');
      for (const fragment of expects) {
        expect(msg).toContain(fragment);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// multi-session discovery — discoverManifests + startSession + SessionRegistry
// composed the same way activate() composes them in extension.ts. activate()
// itself isn't unit-testable without a real Extension Host (no seam to inject
// discoverManifests/findFiles into the module-level function), so these cases
// test the composition directly, mirroring the rest of this file's approach.
// ---------------------------------------------------------------------------

describe('multi-session discovery (nested manifests)', () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-multi-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('two nested manifests under one opened folder yield two independent sessions', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const catsFields = {
      assignment_id: 'cats',
      semester: 'fa26',
      issued_at: '2026-01-01T00:00:00Z',
      files_under_review: ['hw.py'],
    };
    const hogFields = {
      assignment_id: 'hog',
      semester: 'fa26',
      issued_at: '2026-01-01T00:00:00Z',
      files_under_review: ['hw.py'],
    };
    const catsSig = await signManifest(catsFields, privkeyHex);
    const hogSig = await signManifest(hogFields, privkeyHex);

    const catsDir = path.join(workspaceDir, 'cats');
    const hogDir = path.join(workspaceDir, 'hog');
    await fs.mkdir(catsDir, { recursive: true });
    await fs.mkdir(hogDir, { recursive: true });
    await fs.writeFile(
      path.join(catsDir, '.provenance-manifest'),
      JSON.stringify({ ...catsFields, sig: catsSig }),
      'utf8',
    );
    await fs.writeFile(
      path.join(hogDir, '.provenance-manifest'),
      JSON.stringify({ ...hogFields, sig: hogSig }),
      'utf8',
    );

    const { found, skipped } = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: workspaceDir } }],
      findFiles: async () => [
        { fsPath: path.join(catsDir, '.provenance-manifest') },
        { fsPath: path.join(hogDir, '.provenance-manifest') },
      ],
      pubkeyHex,
    });

    expect(skipped).toEqual([]);
    expect(found.map((f) => f.root).sort()).toEqual([catsDir, hogDir].sort());

    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));
    const registry = new SessionRegistry();
    for (const { root, manifest } of found) {
      const session = await startSession({
        assignmentRoot: root,
        manifest,
        extension: makeExtension(),
        vscodeVersion: '1.97.0',
        platform: 'darwin-arm64',
        clock,
      });
      registry.add(session);
    }

    expect(registry.all()).toHaveLength(2);
    expect(registry.resolveForPath(path.join(catsDir, 'x.py'))?.assignmentRoot).toBe(catsDir);
    expect(registry.resolveForPath(path.join(hogDir, 'y.py'))?.assignmentRoot).toBe(hogDir);
    expect(registry.resolveForPath(path.join(workspaceDir, 'notes.md'))).toBeUndefined();

    await registry.disposeAll();
  });

  it('a manifest at the opened root still yields exactly one session (regression)', async () => {
    const { pubkeyHex, privkeyHex } = await generateTestKeypair();
    const fields = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-01-01T00:00:00Z',
      files_under_review: ['hw.py'],
    };
    const sig = await signManifest(fields, privkeyHex);
    await fs.writeFile(
      path.join(workspaceDir, '.provenance-manifest'),
      JSON.stringify({ ...fields, sig }),
      'utf8',
    );

    const { found, skipped } = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: workspaceDir } }],
      findFiles: async () => [{ fsPath: path.join(workspaceDir, '.provenance-manifest') }],
      pubkeyHex,
    });

    expect(skipped).toEqual([]);
    expect(found).toHaveLength(1);
    expect(found[0]?.root).toBe(workspaceDir);
  });

  it('a folder with no manifest anywhere yields no sessions', async () => {
    const { pubkeyHex } = await generateTestKeypair();
    const { found, skipped } = await discoverManifests({
      workspaceFolders: [{ uri: { fsPath: workspaceDir } }],
      findFiles: async () => [],
      pubkeyHex,
    });
    expect(found).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// activate() — the REAL entry point, through the ActivateWiring seam.
//
// Regression coverage for the production failure where students saw
// "command 'provenance.prepareSubmissionBundle' not found" while the status bar
// read "Provenance: recording" and a .provenance/ existed on disk. The cause was
// registration ordering inside activate(): the seal command was registered only
// after `await startSession(...)` had run for EVERY discovered root, with the
// whole block under one catch. Any throw after startSession's opening
// `mkdir(.provenance/)` therefore skipped registration permanently.
//
// The multi-session cases above deliberately hand-composed discoverManifests +
// startSession "the same way activate() composes them" — and that replica did
// not reproduce the ordering, which is exactly why this shipped. These cases
// drive the real function instead.
// ---------------------------------------------------------------------------

describe('activate() command registration', () => {
  const SEAL_ID = 'provenance.prepareSubmissionBundle';

  type Registration = { id: string; handler: () => Promise<void> | void };
  let registrations: Registration[];
  let realRegisterCommand: typeof vscode.commands.registerCommand;

  function makeContext(): import('vscode').ExtensionContext {
    const store = new Map<string, unknown>();
    return {
      subscriptions: [] as import('vscode').Disposable[],
      extensionPath: '/fake/ext',
      extensionUri: { fsPath: '/fake/ext' },
      secrets: undefined,
      globalState: {
        get: (key: string) => store.get(key),
        update: (key: string, value: unknown) => {
          store.set(key, value);
          return Promise.resolve();
        },
      },
    } as unknown as import('vscode').ExtensionContext;
  }

  function fakeFound(roots: string[]): { root: string; manifest: Manifest }[] {
    return roots.map((root) => ({
      root,
      manifest: {
        assignment_id: path.basename(root),
        semester: 'fa26',
        issued_at: '2026-01-01T00:00:00Z',
        files_under_review: ['hw.py'],
        sig: 'deadbeef',
      } as unknown as Manifest,
    }));
  }

  /** Minimally-shaped ActiveSession — enough for registry.add()/all()/disposeAll(). */
  function fakeSession(root: string): Awaited<ReturnType<typeof startSession>> {
    return {
      assignmentRoot: root,
      provenanceDir: path.join(root, '.provenance'),
      ownDisposables: [] as import('vscode').Disposable[],
      manifest: fakeFound([root])[0]!.manifest,
      dispose: () => Promise.resolve(),
    } as unknown as Awaited<ReturnType<typeof startSession>>;
  }

  const sealRegistrations = (): Registration[] => registrations.filter((r) => r.id === SEAL_ID);

  beforeEach(() => {
    registrations = [];
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
      makeWorkspaceFolder('/fake/ws'),
    ];
    realRegisterCommand = vscode.commands.registerCommand;
    vscode.commands.registerCommand = ((id: string, handler: () => Promise<void> | void) => {
      registrations.push({ id, handler });
      return { dispose: () => undefined };
    }) as typeof vscode.commands.registerCommand;
  });

  afterEach(async () => {
    // Clears the module-level SessionRegistry that activate() writes into, so
    // each case starts from an empty one.
    await deactivate();
    vscode.commands.registerCommand = realRegisterCommand;
    vi.restoreAllMocks();
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it('registers the seal command even when every session fails to start', async () => {
    // The exact production shape: startSession throws after it has already
    // created .provenance/ (e.g. a OneDrive-synced folder rejecting the .slog
    // file handle). Before the fix this skipped registration entirely.
    await activate(makeContext(), {
      discoverManifests: () =>
        Promise.resolve({ found: fakeFound(['/fake/ws/lab00']), skipped: [] }),
      startSession: () => Promise.reject(new Error('EPERM: operation not permitted')),
    });

    expect(sealRegistrations()).toHaveLength(1);
  });

  it('does not claim "recording" when no session started', async () => {
    const statusSpy = vi.spyOn(vscode.window, 'createStatusBarItem');
    await activate(makeContext(), {
      discoverManifests: () =>
        Promise.resolve({ found: fakeFound(['/fake/ws/lab00']), skipped: [] }),
      startSession: () => Promise.reject(new Error('EPERM')),
    });

    expect(statusSpy).not.toHaveBeenCalled();
  });

  it('one failing root does not stop the others from recording', async () => {
    // The nested-discovery shape: a course folder opened at its root yields
    // Homework/hw01, Labs/lab00, Projects/hog. Before the fix, a throw on the
    // second abandoned the third AND skipped command registration for all.
    const roots = ['/fake/ws/Homework/hw01', '/fake/ws/Labs/lab00', '/fake/ws/Projects/hog'];
    const attempted: string[] = [];

    await activate(makeContext(), {
      discoverManifests: () => Promise.resolve({ found: fakeFound(roots), skipped: [] }),
      startSession: (deps) => {
        attempted.push(deps.assignmentRoot);
        return deps.assignmentRoot === roots[1]
          ? Promise.reject(new Error('EACCES'))
          : Promise.resolve(fakeSession(deps.assignmentRoot));
      },
    });

    // Root #3 was still attempted despite root #2 throwing.
    expect(attempted).toEqual(roots);
    expect(sealRegistrations()).toHaveLength(1);
  });

  it('registers the seal command exactly once when no manifest is found', async () => {
    // Previously this path registered a separate inactive STUB under the same
    // command id. With registration hoisted above discovery, a second
    // registration here would throw "command already exists" in the real host.
    await activate(makeContext(), {
      discoverManifests: () => Promise.resolve({ found: [], skipped: [] }),
    });

    expect(sealRegistrations()).toHaveLength(1);

    // And invoking it explains itself rather than failing.
    const warnSpy = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockResolvedValue(undefined as never);
    await sealRegistrations()[0]!.handler();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('.provenance-manifest');
  });

  it('registers the seal command before any session is started', async () => {
    // Ordering assertion, not just an outcome assertion: the command must exist
    // by the time the first startSession runs, so a hang inside startSession
    // cannot make the palette entry unusable either.
    let registeredBeforeFirstStart = false;

    await activate(makeContext(), {
      discoverManifests: () =>
        Promise.resolve({ found: fakeFound(['/fake/ws/lab00']), skipped: [] }),
      startSession: (deps) => {
        registeredBeforeFirstStart = sealRegistrations().length === 1;
        return Promise.resolve(fakeSession(deps.assignmentRoot));
      },
    });

    expect(registeredBeforeFirstStart).toBe(true);
  });
});
