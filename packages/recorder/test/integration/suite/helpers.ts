/**
 * Shared helpers for the Provenance Recorder integration suites.
 *
 * Both suites (recorder.test.ts against `test-workspace`, policy-gating.test.ts
 * against `test-workspace-policy`) drive VS Code the same way and read back the
 * same `.slog`; only the fixture's signed capture policy differs. Keeping the
 * driving code identical is what makes the two suites a control/experiment
 * pair — if the policy suite sees no `selection.change` it is because the
 * policy suppressed it, not because the test forgot to move the cursor.
 *
 * Everything here uses the REAL log-core primitives (`parseEntries`,
 * `validateChain`, `verifyManifestChain`) rather than re-implementing them:
 * the point of an integration test is to check the artifact the extension
 * actually wrote against the code that actually reads it.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { parseEntries } from '@provenance/log-core';
import type { HashedEnvelope, SessionStartPayload } from '@provenance/log-core';

/**
 * Filename the suites write to. Deliberately NOT a tracked fixture file:
 * a test that edits `hw.py` leaves `git status` dirty after every run, which
 * is how the old suite behaved. This file is created in `suiteSetup`, deleted
 * in `suiteTeardown`, and gitignored as a backstop.
 */
export const SCRATCH_FILE = 'scratch.py';

export const POLL_INTERVAL_MS = 500;
export const ACTIVATION_TIMEOUT_MS = 15_000;

export const EXTENSION_ID = 'itsgeagle.provenance-recorder';

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

/** Poll until predicate returns true or timeout is reached. */
export function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (predicate()) {
        clearInterval(iv);
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`Timed out waiting for: ${label}`));
      }
    }, POLL_INTERVAL_MS);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Wait for the recorder extension to report itself active. */
export function waitForActivation(): Promise<void> {
  return waitUntil(
    () => vscode.extensions.getExtension(EXTENSION_ID)?.isActive === true,
    ACTIVATION_TIMEOUT_MS,
    'extension to become active',
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** Return the first workspace folder path, or throw. */
export function workspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error(
      'No workspace folder open in Extension Host — the fixture workspace was not ' +
        'opened as a workspace folder. Check runTest.ts launchArgs.',
    );
  }
  return folders[0]!.uri.fsPath;
}

/**
 * Find the most recently modified .slog file under .provenance/ in the workspace.
 *
 * The recorder writes one .slog per session, and .provenance/ is not cleared
 * between local test runs, so several may accumulate. We must read the session
 * THIS run just created — i.e. the newest by mtime — not whatever readdir
 * happens to list first (which is non-deterministic and would read a stale log).
 */
export async function findSlogFile(wsRoot: string): Promise<string | undefined> {
  const provenanceDir = path.join(wsRoot, '.provenance');
  try {
    const entries = await fs.readdir(provenanceDir);
    const slogs = entries.filter((e) => e.endsWith('.slog'));
    if (slogs.length === 0) return undefined;

    let newest: { file: string; mtimeMs: number } | undefined;
    for (const name of slogs) {
      const full = path.join(provenanceDir, name);
      const { mtimeMs } = await fs.stat(full);
      if (newest === undefined || mtimeMs > newest.mtimeMs) {
        newest = { file: full, mtimeMs };
      }
    }
    return newest?.file;
  } catch {
    return undefined;
  }
}

/**
 * Read this run's .slog and parse it with log-core's real ndjson parser.
 * Throws (rather than returning a Result) because every caller is a test that
 * cannot proceed without the entries.
 */
export async function readSlogEntries(wsRoot: string): Promise<readonly HashedEnvelope[]> {
  const slogPath = await findSlogFile(wsRoot);
  if (slogPath === undefined) {
    throw new Error(`No .slog file found in ${path.join(wsRoot, '.provenance')}`);
  }
  const contents = await fs.readFile(slogPath, 'utf8');
  const parsed = parseEntries(contents);
  if (!parsed.ok) {
    throw new Error(`.slog at ${slogPath} failed to parse: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/** All event kinds present in `entries`, as a Set. */
export function kindsIn(entries: readonly HashedEnvelope[]): Set<string> {
  return new Set(entries.map((e) => e.kind));
}

/** Every entry of the given kind, in log order. */
export function entriesOfKind(
  entries: readonly HashedEnvelope[],
  kind: string,
): readonly HashedEnvelope[] {
  return entries.filter((e) => e.kind === kind);
}

/** The single `session.start` payload, or throw. */
export function sessionStartPayload(entries: readonly HashedEnvelope[]): SessionStartPayload {
  const starts = entriesOfKind(entries, 'session.start');
  if (starts.length !== 1) {
    throw new Error(`Expected exactly one session.start entry, found ${starts.length}`);
  }
  const first = starts[0]!;
  if (first.seq !== 0) {
    throw new Error(`session.start must be seq 0, got ${first.seq}`);
  }
  return first.data as SessionStartPayload;
}

// ---------------------------------------------------------------------------
// Driving VS Code
// ---------------------------------------------------------------------------

/** Absolute path of the scratch file in the given workspace. */
export function scratchPath(wsRoot: string): string {
  return path.join(wsRoot, SCRATCH_FILE);
}

/** Create the scratch file on disk (idempotent). */
export async function createScratchFile(wsRoot: string): Promise<void> {
  await fs.writeFile(scratchPath(wsRoot), '# scratch\n', 'utf8');
}

/**
 * Delete the scratch file. Never throws — teardown must not turn a passing run
 * into a failing one, and a missing file is the desired end state anyway.
 */
export async function removeScratchFile(wsRoot: string): Promise<void> {
  try {
    await fs.rm(scratchPath(wsRoot), { force: true });
  } catch {
    // Best effort.
  }
}

/** Open the scratch file and show it in an editor. */
export async function openScratchEditor(wsRoot: string): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.file(scratchPath(wsRoot));
  const doc = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(doc);
}

/**
 * Move the cursor / selection several times. Under the default policy this
 * produces `selection.change` entries; under a policy with
 * `selection_change: false` it must produce none — the same driving code either
 * way, which is what makes the negative assertion meaningful.
 */
export async function driveSelectionChanges(editor: vscode.TextEditor): Promise<void> {
  const positions: readonly vscode.Position[] = [
    new vscode.Position(0, 0),
    new vscode.Position(0, 3),
    new vscode.Position(0, 1),
    new vscode.Position(0, 5),
  ];
  for (const pos of positions) {
    editor.selection = new vscode.Selection(pos, pos);
    // Selection events are delivered asynchronously; yield between moves so
    // each one is a distinct event rather than being coalesced.
    await delay(150);
  }
  // One real (non-empty) selection too.
  editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 4));
  await delay(150);
}

/** Insert text at the top of the editor's document and save it. */
export async function editAndSave(editor: vscode.TextEditor, text: string): Promise<void> {
  await editor.edit((builder) => {
    builder.insert(new vscode.Position(0, 0), text);
  });
  await editor.document.save();
}
