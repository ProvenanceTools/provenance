// Focused tests for scripts/update-extension-hash-allowlist.mjs's argument
// parsing, env-var parsing, and keypair-file reading — the parts with real
// branching under the Manifest 2.0 root-key model. Deliberately NOT an
// end-to-end harness: every case here exits before spawning `build:prod` (a
// real build is slow and out of scope for a unit test — see CLAUDE.md /
// the task instructions), and none of them mutate the checked-in allowlist
// file, since the script only writes it after all validation succeeds.
//
// The script has no exported functions (it's a `main().catch(...)` CLI
// entry point), so these tests drive it as a subprocess and assert on
// stdout/stderr/exit code — the natural seam for a CLI wrapper.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = join(__dirname, 'update-extension-hash-allowlist.mjs');
const ALLOWLIST_PATH = resolve(
  REPO_ROOT,
  'packages/analysis-core/src/heuristics/config/known-good-extension-hashes.json',
);

const VALID_ROOT_HEX = 'a'.repeat(64);

let tmpDir;
// Safety net: every test below is designed to exit before the script's write
// step runs, but if one ever slips (e.g. --no-build finding a pre-built
// packages/recorder/dist and actually adding its hash), this restores the
// checked-in allowlist so a test run never leaves a real edit behind.
let allowlistSnapshot;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'update-hashes-test-'));
  allowlistSnapshot = readFileSync(ALLOWLIST_PATH, 'utf8');
});

afterEach(() => {
  const current = readFileSync(ALLOWLIST_PATH, 'utf8');
  if (current !== allowlistSnapshot) {
    writeFileSync(ALLOWLIST_PATH, allowlistSnapshot);
    throw new Error(
      'A test wrote to the real known-good-extension-hashes.json — restored it, but this ' +
        'test needs to be fixed so it never reaches the write path.',
    );
  }
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Run the script with the given argv and env overlay. Never triggers a real build. */
function run(args, envOverlay = {}) {
  const env = { ...process.env, ...envOverlay };
  // Make sure ambient legacy/root vars from the developer's shell never leak
  // into a test that doesn't set them explicitly.
  if (!('PROVENANCE_ROOT_PUBLIC_KEY_HEX' in envOverlay)) delete env.PROVENANCE_ROOT_PUBLIC_KEY_HEX;
  if (!('PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX' in envOverlay)) {
    delete env.PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX;
  }
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  });
}

function writeKeypairFile(name, contents) {
  const p = join(tmpDir, name);
  writeFileSync(p, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return p;
}

describe('--help', () => {
  it('describes the root-key model, not the retired per-course model', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--root-keypair');
    expect(r.stdout).toContain('PROVENANCE_ROOT_PUBLIC_KEY_HEX');
    expect(r.stdout).toContain('PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX');
    expect(r.stdout).not.toContain('--keypair <path>');
    expect(r.stdout).not.toContain('PROVENANCE_COURSE_PUBLIC_KEY_HEX');
    expect(r.stdout).not.toContain('per-course');
  });
});

describe('unknown / retired flags', () => {
  it('rejects the retired --keypair flag instead of silently accepting it', () => {
    const r = run(['--keypair', '/dev/null']);
    expect(r.status).toBe(0); // unknown arg routes to help mode, which exits 0
    expect(r.stderr).toContain('Unknown argument: --keypair');
    expect(r.stdout).toContain('Usage:');
  });
});

describe('--root-keypair file reading', () => {
  it('errors on a missing file', () => {
    const r = run(['--root-keypair', join(tmpDir, 'does-not-exist.json')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Could not read keypair file');
  });

  it('errors on invalid JSON', () => {
    const p = writeKeypairFile('bad.json', '{ not json');
    const r = run(['--root-keypair', p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not valid JSON');
  });

  it('errors when public_key_hex is missing', () => {
    const p = writeKeypairFile('no-pubkey.json', { private_key_hex: 'x'.repeat(64) });
    const r = run(['--root-keypair', p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("has no string 'public_key_hex' field");
  });

  it('errors when public_key_hex is malformed hex', () => {
    const p = writeKeypairFile('short-pubkey.json', { public_key_hex: 'not-hex' });
    const r = run(['--root-keypair', p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("malformed 'public_key_hex'");
  });

  it(
    'accepts the same shape tools/generate-course-keypair.ts writes and reaches the ' +
      'legacy-key check next (proving the root key parsed and validated)',
    () => {
      // Give it a valid root key but an invalid legacy key, so the script fails at
      // the legacy-key validation step — which only happens AFTER the root keypair
      // file was read and validated successfully — and, crucially, BEFORE it would
      // spawn a real `build:prod`. This proves keypair-file reading works without
      // ever triggering a build.
      const p = writeKeypairFile('valid-root.json', {
        public_key_hex: VALID_ROOT_HEX,
        private_key_hex: 'c'.repeat(64),
        generated_at: '2026-08-19T00:00:00.000Z',
      });
      const r = run(['--root-keypair', p], {
        PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX: 'not-valid-hex',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX is malformed');
      // Must NOT have gotten as far as invoking the build.
      expect(r.stdout).not.toContain('Building recorder with production root public key');
    },
  );
});

describe('PROVENANCE_ROOT_PUBLIC_KEY_HEX env var', () => {
  it('errors when malformed', () => {
    const r = run([], { PROVENANCE_ROOT_PUBLIC_KEY_HEX: 'too-short' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PROVENANCE_ROOT_PUBLIC_KEY_HEX is malformed');
  });

  it(
    'takes effect only when --root-keypair is not given, and reaches the same ' +
      'legacy-key gate as the file-based path',
    () => {
      const r = run([], {
        PROVENANCE_ROOT_PUBLIC_KEY_HEX: VALID_ROOT_HEX,
        PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX: 'nope',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX is malformed');
    },
  );

  it('is not consulted when --root-keypair is given (file wins)', () => {
    const p = writeKeypairFile('root-wins.json', { public_key_hex: VALID_ROOT_HEX });
    const r = run(['--root-keypair', p], {
      // A malformed env var would blow up if it were read; it must not be.
      PROVENANCE_ROOT_PUBLIC_KEY_HEX: 'ignored-and-malformed',
      PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX: 'still-invalid',
    });
    expect(r.status).toBe(1);
    // Fails at the legacy check, not at "PROVENANCE_ROOT_PUBLIC_KEY_HEX is malformed" —
    // proving the (malformed) env var was never read once --root-keypair was given.
    expect(r.stderr).toContain('PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX is malformed');
    expect(r.stderr).not.toContain('PROVENANCE_ROOT_PUBLIC_KEY_HEX is malformed');
  });
});

describe('--hash validation (no keypair / build involved)', () => {
  it('rejects a malformed literal hash before writing anything', () => {
    const r = run(['--hash', 'not-a-valid-hash']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid hash');
  });
});

describe('--show', () => {
  it('is read-only and exits 0', () => {
    const r = run(['--show']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Current allowlist');
  });
});
