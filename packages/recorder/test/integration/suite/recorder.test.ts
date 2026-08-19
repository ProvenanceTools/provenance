/**
 * Integration smoke test for the Provenance Recorder extension.
 *
 * Runs inside VS Code's Extension Host via @vscode/test-electron.
 * Uses the Mocha TDD interface (suite / test) as required by the suite runner.
 *
 * What this tests (smoke):
 *  1. The extension activates within 10s.
 *  2. A .provenance/ directory is created in the test workspace.
 *  3. A .slog file exists and contains at least session.start, doc.open,
 *     doc.change (or paste), and doc.save after opening and editing hw.py.
 *
 * Limitations:
 *  - We cannot verify the status bar item directly (VS Code's test API doesn't
 *    expose status bar items; it's a known gap in the API).
 *  - The .provenance-manifest in test-workspace is a Manifest 2.0 file: its
 *    course_cert must be signed by the dev root keypair whose public key matches
 *    ROOT_PUBLIC_KEY_HEX in course-keys.ts, and its payload by the dev course key
 *    that cert vouches for.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { statSync } from 'node:fs';

const EXTENSION_ID = 'itsgeagle.provenance-recorder';
const POLL_INTERVAL_MS = 500;
const ACTIVATION_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll until predicate returns true or timeout is reached. */
function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
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

/** Return the first workspace folder path, or throw. */
function workspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder open in Extension Host');
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
async function findSlogFile(wsRoot: string): Promise<string | undefined> {
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Provenance Recorder integration smoke test', () => {
  test('extension activates within 15 seconds', async () => {
    await waitUntil(
      () => vscode.extensions.getExtension(EXTENSION_ID)?.isActive === true,
      ACTIVATION_TIMEOUT_MS,
      'extension to become active',
    );
  });

  test('.provenance/ directory is created in workspace root', async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error(
        'No workspace folder open in Extension Host — the test workspace was not opened as a workspace folder. Check runTest.ts launchArgs.',
      );
    }
    const wsRoot = folders[0]!.uri.fsPath;
    const provenanceDir = path.join(wsRoot, '.provenance');

    await waitUntil(
      () => {
        try {
          // Sync check — ok for polling in tests.
          statSync(provenanceDir).isDirectory();
          return true;
        } catch {
          return false;
        }
      },
      ACTIVATION_TIMEOUT_MS,
      `.provenance/ directory to exist at ${provenanceDir}`,
    );
  });

  test('opening hw.py and making an edit produces a .slog with expected event kinds', async function () {
    // eslint-disable-next-line @typescript-eslint/no-invalid-this
    this.timeout(30_000);

    const wsRoot = workspaceRoot();
    const hwPath = vscode.Uri.file(path.join(wsRoot, 'hw.py'));

    // Open the file.
    const doc = await vscode.workspace.openTextDocument(hwPath);
    const editor = await vscode.window.showTextDocument(doc);

    // Type some text.
    await editor.edit((editBuilder) => {
      editBuilder.insert(new vscode.Position(0, 0), '# integration test\n');
    });

    // Save.
    await doc.save();

    // Give the writer up to 5s to flush.
    await new Promise<void>((r) => setTimeout(r, 5_000));

    // Find the .slog file.
    const slogPath = await findSlogFile(wsRoot);
    if (slogPath === undefined) {
      throw new Error('No .slog file found in .provenance/');
    }

    const contents = await fs.readFile(slogPath, 'utf8');
    const lines = contents.trim().split('\n').filter(Boolean);

    const kinds = new Set(
      lines.map((l) => {
        try {
          const obj = JSON.parse(l) as { kind: string };
          return obj.kind;
        } catch {
          return null;
        }
      }),
    );

    // Verify the expected event kinds are present.
    if (!kinds.has('session.start')) {
      throw new Error(`Missing session.start in .slog. Kinds present: ${[...kinds].join(', ')}`);
    }
    if (!kinds.has('doc.open')) {
      throw new Error(`Missing doc.open in .slog. Kinds present: ${[...kinds].join(', ')}`);
    }
    if (!kinds.has('doc.change') && !kinds.has('paste')) {
      throw new Error(
        `Missing doc.change or paste in .slog. Kinds present: ${[...kinds].join(', ')}`,
      );
    }
    if (!kinds.has('doc.save')) {
      throw new Error(`Missing doc.save in .slog. Kinds present: ${[...kinds].join(', ')}`);
    }
  });
});
