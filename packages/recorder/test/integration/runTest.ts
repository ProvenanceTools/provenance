/**
 * Integration test runner for the Provenance Recorder extension.
 *
 * This script uses @vscode/test-electron to:
 *  1. Download VS Code (cached in .vscode-test/) if not already present.
 *  2. Resolve the REAL executable inside that download (see below).
 *  3. Launch VS Code with the recorder extension loaded, once per fixture
 *     workspace, running the matching suite file in each.
 *
 * Run via: npm run test:integration
 *
 * NOTE: This test harness requires mocha to be installed:
 *   npm install --save-dev mocha @types/mocha
 * It is NOT part of the default `npm run test` (which runs Vitest unit tests).
 *
 * @vscode/test-electron downloads VS Code on first run; subsequent runs use the
 * cached version in .vscode-test/. The test:integration script compiles this
 * harness via tsc before running it.
 *
 * ## Why there are two runs
 *
 * The capture policy (program spec §4) lives inside the course-signed manifest,
 * and a manifest belongs to a directory. Proving that a *restrictive* policy
 * reaches the running recorder therefore needs a second workspace with its own
 * signed manifest — `test-workspace-policy/`. Each run opens one fixture and
 * loads one suite file, selected by the PROVENANCE_IT_SUITE env var that
 * suite/index.ts reads.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

// ---------------------------------------------------------------------------
// Executable resolution
// ---------------------------------------------------------------------------

/**
 * Candidate basenames for the VS Code / Electron binary inside a download.
 *
 * Ordered most- to least-likely per platform; the whole list is tried on every
 * platform because the cost is a handful of `existsSync` calls and the benefit
 * is not having to special-case each OS.
 */
const EXECUTABLE_CANDIDATES = [
  // macOS: <app>.app/Contents/MacOS/<name>
  'Electron',
  'Code',
  'Code - Insiders',
  'Code - OSS',
  // Windows
  'Code.exe',
  'Code - Insiders.exe',
  // Linux
  'code',
  'code-insiders',
] as const;

/**
 * DO NOT DELETE THIS AS "REDUNDANT" — `runTests({ version })` cannot be used
 * on its own here.
 *
 * @vscode/test-electron@2.5.2 hard-codes the macOS binary name as
 * `Visual Studio Code.app/Contents/MacOS/Electron`
 * (node_modules/@vscode/test-electron/out/util.js, `downloadDirToExecutablePath`).
 * VS Code 1.134.0 darwin-arm64 ships that binary as `Contents/MacOS/Code`, so
 * the path the library computes does not exist and the whole suite dies with
 * `spawn .../MacOS/Electron ENOENT` before any extension code loads. Because
 * this harness pins `version: 'stable'`, that break arrived purely by upstream
 * drift — and it meant the integration suite silently stopped guarding anything.
 *
 * The fix, with no dependency change: download exactly as the library would,
 * take the path it hands back, and if that path does not exist, look for the
 * real binary next to it. The download layout is otherwise unchanged, so the
 * sibling lookup is enough for every platform's naming variant.
 *
 * Once `@vscode/test-electron` is bumped to a version that resolves the binary
 * correctly, this function becomes a no-op passthrough (the returned path will
 * simply exist) and can be removed — but only after verifying that, not before.
 */
async function resolveVSCodeExecutable(version: string): Promise<string> {
  const reported = await downloadAndUnzipVSCode(version);
  if (fs.existsSync(reported)) {
    return reported;
  }

  const dir = path.dirname(reported);
  for (const candidate of EXECUTABLE_CANDIDATES) {
    const full = path.join(dir, candidate);
    if (fs.existsSync(full)) {
      console.log(
        `[runTest] @vscode/test-electron reported a non-existent executable ` +
          `(${path.basename(reported)}); using ${candidate} in the same directory instead.`,
      );
      return full;
    }
  }

  const listing = fs.existsSync(dir) ? fs.readdirSync(dir).join(', ') : '<directory missing>';
  throw new Error(
    `Could not locate the VS Code executable. @vscode/test-electron reported ` +
      `${reported}, which does not exist, and none of ` +
      `[${EXECUTABLE_CANDIDATES.join(', ')}] were found in ${dir}. ` +
      `Directory contains: ${listing}`,
  );
}

// ---------------------------------------------------------------------------
// User-data directory
// ---------------------------------------------------------------------------

/**
 * Longest `--user-data-dir` we will leave alone.
 *
 * VS Code opens a unix domain socket at `<user-data-dir>/<n.nn>-main.sock`, and
 * the sockaddr_un path limit is 104 bytes on macOS / 108 on Linux. The suffix is
 * ~15 bytes, so a user-data-dir much beyond this makes VS Code fail to launch
 * with `listen EINVAL`. 85 leaves a few bytes of headroom for a longer version
 * prefix.
 */
const MAX_USER_DATA_DIR_LEN = 85;

/**
 * @vscode/test-electron puts the profile under `<cwd>/.vscode-test/user-data`.
 * That is fine for a normal checkout, but a deep working copy (a git worktree
 * under `.claude/worktrees/<id>/`, a nested CI workspace) pushes the socket path
 * past the OS limit and VS Code dies before the extension host starts.
 *
 * Returns a shorter replacement directory when the default is too long, or
 * `undefined` to leave the library's default in place — so a normal checkout
 * behaves exactly as before.
 */
function resolveShortUserDataDir(): string | undefined {
  // Mirrors download.ts's `defaultCachePath = path.resolve(process.cwd(), '.vscode-test')`.
  const defaultDir = path.resolve(process.cwd(), '.vscode-test', 'user-data');
  if (defaultDir.length <= MAX_USER_DATA_DIR_LEN) {
    return undefined;
  }

  const shortDir = path.join(os.tmpdir(), 'prov-vscode-test', 'user-data');
  if (shortDir.length > MAX_USER_DATA_DIR_LEN) {
    throw new Error(
      `Cannot find a short enough --user-data-dir: the default (${defaultDir.length} chars) ` +
        `and the temp-dir fallback (${shortDir.length} chars) both exceed ` +
        `${MAX_USER_DATA_DIR_LEN}. Check the repo out at a shallower path.`,
    );
  }

  fs.mkdirSync(shortDir, { recursive: true });
  console.log(
    `[runTest] Default --user-data-dir is ${defaultDir.length} chars, which would overflow ` +
      `the unix socket path limit; using ${shortDir} instead.`,
  );
  return shortDir;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Fixture = {
  /** Value of PROVENANCE_IT_SUITE — suite/index.ts loads `<suite>.test.js`. */
  suite: string;
  /** Directory (relative to the repo root) opened as the workspace folder. */
  workspaceDir: string;
};

const FIXTURES: readonly Fixture[] = [
  { suite: 'recorder', workspaceDir: 'test-workspace' },
  { suite: 'policy-gating', workspaceDir: 'test-workspace-policy' },
];

async function main(): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // At runtime, __dirname is packages/recorder/dist-integration/test/integration/.
  // Go up four levels to the recorder package root (where package.json lives).
  const extensionDevelopmentPath = path.resolve(__dirname, '../../../..');

  // The compiled suite index sits next to this file in dist-integration/test/integration/suite/.
  // Use a file:// URL so @vscode/test-electron's extension host can dynamic-import the ESM entry.
  const extensionTestsPath = path.resolve(__dirname, './suite/index.js');

  // The repo root, five levels up from the compiled harness.
  const repoRoot = path.resolve(__dirname, '../../../../../');

  try {
    // 'stable' always fetches the latest stable VS Code.
    const vscodeExecutablePath = await resolveVSCodeExecutable('stable');
    const shortUserDataDir = resolveShortUserDataDir();

    for (const fixture of FIXTURES) {
      const workspacePath = path.join(repoRoot, fixture.workspaceDir);
      console.log(`\n[runTest] === suite '${fixture.suite}' in ${fixture.workspaceDir} ===\n`);
      await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath,
        extensionTestsPath,
        extensionTestsEnv: { PROVENANCE_IT_SUITE: fixture.suite },
        launchArgs: [
          workspacePath,
          // Disable other extensions to avoid interference.
          '--disable-extensions',
          // Keep the Extension Host from asking for trust.
          '--disable-workspace-trust',
          // Only present when the default would overflow the socket path limit;
          // @vscode/test-electron leaves its own default off when we supply one.
          ...(shortUserDataDir === undefined ? [] : [`--user-data-dir=${shortUserDataDir}`]),
        ],
      });
    }
  } catch (err) {
    console.error('Integration tests failed:', err);
    process.exit(1);
  }
}

void main();
