/**
 * Tests for scripts/compose-manifest.mjs.
 *
 * Pure helpers are imported from the script. End-to-end signing is driven as a
 * subprocess so we assert on the bytes the CLI actually writes. Byte identity
 * with the browser composer (`composeSignedManifest`) is the load-bearing
 * property — same inputs must produce the same signed file.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseComposeArgs,
  resolveComposeOptions,
  coercePathList,
  parsePathListFlag,
  parseConfigObject,
  issuedAtFrom,
} from './compose-manifest.mjs';
import { composeSignedManifest } from '../packages/analyzer/src/views/compose/manifest-composer.js';
import {
  makeCourseCert,
  makeKeypair,
} from '../packages/analyzer/src/views/compose/composer.fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = join(__dirname, 'compose-manifest.mjs');

// ---------------------------------------------------------------------------
// parseComposeArgs
// ---------------------------------------------------------------------------

describe('parseComposeArgs', () => {
  it('parses the required flags and accumulates repeated path lists', () => {
    const result = parseComposeArgs([
      '--out',
      'out.manifest',
      '--assignment-id',
      'hw03',
      '--semester',
      'fa26',
      '--files-under-review',
      'a.py,b.py',
      '--files-under-review',
      'c.py',
      '--course-id',
      'berkeley-cs61a',
      '--ignore',
      '*.class',
      '--attachments',
      'logs/',
      '--no-terminal',
      '--preview',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outPath).toBe('out.manifest');
    expect(result.value.assignmentId).toBe('hw03');
    expect(result.value.filesUnderReview).toEqual(['a.py', 'b.py', 'c.py']);
    expect(result.value.ignore).toEqual(['*.class']);
    expect(result.value.attachments).toEqual(['logs/']);
    expect(result.value.terminal).toBe(false);
    expect(result.value.preview).toBe(true);
  });

  it('rejects unknown flags and missing values', () => {
    expect(parseComposeArgs(['--wat']).ok).toBe(false);
    expect(parseComposeArgs(['--out']).ok).toBe(false);
    expect(parseComposeArgs(['positional']).ok).toBe(false);
  });

  it('parses explicit --capture-* bool flags', () => {
    const result = parseComposeArgs([
      '--capture-selection-change',
      'false',
      '--capture-focus-change',
      'on',
      '--capture-terminal',
      '0',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectionChange).toBe(false);
    expect(result.value.focusChange).toBe(true);
    expect(result.value.terminal).toBe(false);
  });
});

describe('parsePathListFlag / coercePathList', () => {
  it('splits on commas and newlines and drops blanks/duplicates', () => {
    expect(parsePathListFlag('a.py, b.py\nc.py\n,a.py')).toEqual(['a.py', 'b.py', 'c.py']);
  });

  it('accepts arrays and strings from config', () => {
    expect(coercePathList(['x.py', 'y.py'], 'files_under_review')).toEqual({
      ok: true,
      value: ['x.py', 'y.py'],
    });
    expect(coercePathList('x.py,y.py', 'files_under_review')).toEqual({
      ok: true,
      value: ['x.py', 'y.py'],
    });
    expect(coercePathList([1], 'files_under_review').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveComposeOptions
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-09-08T12:34:56.789Z');

function baseRaw(overrides = {}) {
  return {
    help: false,
    preview: false,
    configPath: undefined,
    outPath: 'out.manifest',
    format: undefined,
    assignmentId: 'hw03',
    semester: 'fa26',
    issuedAt: undefined,
    filesUnderReview: ['hw03.py'],
    courseId: 'berkeley-cs61a',
    collaboration: undefined,
    submission: undefined,
    scope: undefined,
    ignore: undefined,
    attachments: undefined,
    selectionChange: undefined,
    focusChange: undefined,
    terminal: undefined,
    heartbeatIntervalMs: undefined,
    courseKeypairPath: '/kp.json',
    courseCertPath: '/cert.json',
    rootPubkeyHex: 'a'.repeat(64),
    ...overrides,
  };
}

describe('resolveComposeOptions', () => {
  it('defaults issued_at to now (whole seconds UTC) and policy to all-on', () => {
    const resolved = resolveComposeOptions(baseRaw(), null, {}, FIXED_NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.form.issued_at).toBe(issuedAtFrom(FIXED_NOW));
    expect(resolved.value.form.issued_at).toBe('2026-09-08T12:34:56Z');
    expect(resolved.value.form.collaboration).toBe('solo');
    expect(resolved.value.form.submission).toBe('bundle');
    expect(resolved.value.form.scope).toBe('directory');
    expect(resolved.value.form.policy).toEqual({
      selection_change: true,
      focus_change: true,
      terminal: true,
      heartbeat_interval_ms: 30_000,
    });
  });

  it('lets flags override config, and config supply missing fields', () => {
    const config = parseConfigObject({
      assignment_id: 'from-config',
      semester: 'fa26',
      files_under_review: ['cfg.py'],
      course_id: 'berkeley-cs61a',
      collaboration: 'group',
      policy: { terminal: false, heartbeat_interval_ms: 45_000 },
    });
    expect(config.ok).toBe(true);
    if (!config.ok) return;

    const resolved = resolveComposeOptions(
      baseRaw({
        assignmentId: 'from-flag',
        filesUnderReview: undefined,
        collaboration: undefined,
        terminal: undefined,
      }),
      config.value,
      {},
      FIXED_NOW,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.form.assignment_id).toBe('from-flag');
    expect(resolved.value.form.files_under_review).toEqual(['cfg.py']);
    expect(resolved.value.form.collaboration).toBe('group');
    expect(resolved.value.form.policy.terminal).toBe(false);
    expect(resolved.value.form.policy.heartbeat_interval_ms).toBe(45_000);
  });

  it('requires --out unless --preview, and course_id at 2.0', () => {
    expect(resolveComposeOptions(baseRaw({ outPath: undefined }), null, {}, FIXED_NOW).ok).toBe(
      false,
    );
    expect(
      resolveComposeOptions(baseRaw({ outPath: undefined, preview: true }), null, {}, FIXED_NOW).ok,
    ).toBe(true);
    expect(resolveComposeOptions(baseRaw({ courseId: undefined }), null, {}, FIXED_NOW).ok).toBe(
      false,
    );
    expect(
      resolveComposeOptions(baseRaw({ courseId: undefined, format: '1.0' }), null, {}, FIXED_NOW)
        .ok,
    ).toBe(true);
  });

  it('rejects illegal enum values', () => {
    expect(
      resolveComposeOptions(baseRaw({ collaboration: 'pair' }), null, {}, FIXED_NOW).ok,
    ).toBe(false);
    expect(resolveComposeOptions(baseRaw({ submission: 'zip' }), null, {}, FIXED_NOW).ok).toBe(
      false,
    );
    expect(resolveComposeOptions(baseRaw({ scope: 'workspace' }), null, {}, FIXED_NOW).ok).toBe(
      false,
    );
    expect(resolveComposeOptions(baseRaw({ format: '3.0' }), null, {}, FIXED_NOW).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Subprocess: byte identity with composeSignedManifest
// ---------------------------------------------------------------------------

let fx;

const FORM_BASE = {
  assignment_id: 'proj2-café',
  semester: 'fa26',
  issued_at: '2026-09-08T00:00:00Z',
  files_under_review: ['src/zeta.py', 'src/alpha.py', 'src/Ünicode.py'],
  course_id: 'berkeley-cs61b',
  collaboration: 'solo',
  submission: 'bundle',
  scope: 'directory',
  policy: {
    selection_change: false,
    focus_change: true,
    terminal: false,
    heartbeat_interval_ms: 45_000,
  },
  ignore: ['*.class', 'build/'],
  attachments: ['logs/', '*.log'],
};

beforeAll(async () => {
  const root = await makeKeypair(0x61);
  const rootPrivate = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    rootPrivate[i] = Number.parseInt(root.privateKeyHex.slice(i * 2, i * 2 + 2), 16);
  }
  const course = await makeKeypair(0x42);
  const cert = await makeCourseCert({
    courseId: FORM_BASE.course_id,
    coursePubkeyHex: course.publicKeyHex,
    rootPrivateKey: rootPrivate,
  });

  const dir = mkdtempSync(join(tmpdir(), 'provenance-compose-manifest-cli-'));
  mkdirSync(dir, { recursive: true });
  const keypairPath = join(dir, 'course-keypair.json');
  const certPath = join(dir, 'course-cert.json');
  writeFileSync(keypairPath, course.fileText);
  writeFileSync(certPath, cert.fileText);

  fx = {
    dir,
    keypairPath,
    certPath,
    keypairText: course.fileText,
    certText: cert.fileText,
    rootPubkeyHex: root.publicKeyHex,
  };
});

function runCli(extraArgs, outName) {
  const outPath = join(fx.dir, outName);
  const args = [
    SCRIPT,
    '--out',
    outPath,
    '--assignment-id',
    FORM_BASE.assignment_id,
    '--semester',
    FORM_BASE.semester,
    '--issued-at',
    FORM_BASE.issued_at,
    '--files-under-review',
    FORM_BASE.files_under_review.join(','),
    '--course-id',
    FORM_BASE.course_id,
    '--collaboration',
    FORM_BASE.collaboration,
    '--submission',
    FORM_BASE.submission,
    '--scope',
    FORM_BASE.scope,
    '--ignore',
    FORM_BASE.ignore.join(','),
    '--attachments',
    FORM_BASE.attachments.join(','),
    '--no-selection-change',
    '--no-terminal',
    '--heartbeat-interval-ms',
    String(FORM_BASE.policy.heartbeat_interval_ms),
    '--course-keypair',
    fx.keypairPath,
    '--course-cert',
    fx.certPath,
    '--root-pubkey',
    fx.rootPubkeyHex,
    ...extraArgs,
  ];
  execFileSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8' });
  return readFileSync(outPath, 'utf8');
}

describe('compose-manifest.mjs ↔ composeSignedManifest byte identity', () => {
  it('produces byte-identical output at format 2.0', async () => {
    const form = { ...FORM_BASE, format: '2.0' };
    const browser = await composeSignedManifest({
      form,
      keypairFileText: fx.keypairText,
      certFileText: fx.certText,
      rootPubkeyHex: fx.rootPubkeyHex,
    });
    expect(browser.ok).toBe(true);
    if (!browser.ok) return;

    const cli = runCli(['--format', '2.0'], 'signed-2.0.manifest');
    expect(cli).toBe(browser.value.fileText);
  });

  it('produces byte-identical output at format 1.0', async () => {
    const form = {
      ...FORM_BASE,
      format: '1.0',
      course_id: '',
      ignore: [],
      attachments: [],
    };
    const browser = await composeSignedManifest({
      form,
      keypairFileText: fx.keypairText,
      certFileText: null,
      rootPubkeyHex: null,
    });
    expect(browser.ok).toBe(true);
    if (!browser.ok) return;

    const outPath = join(fx.dir, 'signed-1.0.manifest');
    execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--out',
        outPath,
        '--format',
        '1.0',
        '--assignment-id',
        FORM_BASE.assignment_id,
        '--semester',
        FORM_BASE.semester,
        '--issued-at',
        FORM_BASE.issued_at,
        '--files-under-review',
        FORM_BASE.files_under_review.join(','),
        '--course-keypair',
        fx.keypairPath,
      ],
      { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8' },
    );
    expect(readFileSync(outPath, 'utf8')).toBe(browser.value.fileText);
  });

  it('--preview prints unsigned JSON and does not require keys', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--preview',
        '--assignment-id',
        'hw03',
        '--semester',
        'fa26',
        '--issued-at',
        '2026-09-15T00:00:00Z',
        '--files-under-review',
        'hw03.py',
        '--course-id',
        'berkeley-cs61a',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.assignment_id).toBe('hw03');
    expect(parsed.format_version).toBe('2.0');
  });

  it('accepts a --config JSON and lets flags override', () => {
    const configPath = join(fx.dir, 'assignment.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        assignment_id: 'from-config',
        semester: 'fa26',
        issued_at: FORM_BASE.issued_at,
        files_under_review: FORM_BASE.files_under_review,
        course_id: FORM_BASE.course_id,
        collaboration: FORM_BASE.collaboration,
        submission: FORM_BASE.submission,
        scope: FORM_BASE.scope,
        ignore: FORM_BASE.ignore,
        attachments: FORM_BASE.attachments,
        policy: FORM_BASE.policy,
      }) + '\n',
    );

    const outPath = join(fx.dir, 'from-config.manifest');
    execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--config',
        configPath,
        '--out',
        outPath,
        '--assignment-id',
        FORM_BASE.assignment_id,
        '--course-keypair',
        fx.keypairPath,
        '--course-cert',
        fx.certPath,
        '--root-pubkey',
        fx.rootPubkeyHex,
      ],
      { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8' },
    );
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(written.assignment_id).toBe(FORM_BASE.assignment_id);
  });

  it('--help exits 0 and mentions standalone usage', () => {
    const result = execFileSync(process.execPath, [SCRIPT, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result).toContain('compose-manifest.mjs');
    expect(result).toContain('--files-under-review');
  });
});
