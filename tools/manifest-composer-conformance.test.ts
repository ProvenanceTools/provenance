/**
 * BYTE-IDENTITY GATE between the browser manifest composer and the CLI.
 *
 * The analyzer's `/compose/manifest` page is a second implementation of
 * `tools/sign-manifest.ts`. Two implementations of a signing format is exactly
 * the situation where a difference nobody notices becomes a manifest that
 * verifies on one path and not the other — and the failure surfaces days later,
 * in a student's editor, as "signature invalid".
 *
 * So the two are not compared against a description of each other. This test
 * runs the REAL CLI as a subprocess over a real temp file, and compares the
 * bytes it writes with the bytes `composeSignedManifest` returns for the same
 * inputs. Byte for byte, including the trailing newline, at 2.0 and at 1.0.
 *
 * ## Why this file lives in tools/
 *
 * The precedent is `tools/recorder-seal-conformance.test.ts` and
 * `tools/enrollment-paste-conformance.test.ts`. `tools/` has no package.json,
 * so it is the one place allowed to span both dependency graphs; neither
 * package acquires an edge. The analyzer end is imported as pure source (no
 * DOM, no Vite specifics); the CLI end is spawned, not imported, because the
 * thing under test is what the CLI actually writes to disk.
 *
 * ## What would break this
 *
 * Hand-rolling canonicalization on either side; adding, dropping or renaming a
 * field on one side only; a different trailing-newline convention; a number
 * formatted differently. Each of those is a real, plausible edit, and each
 * produces a different signature or different bytes. The unicode and ordering
 * in the fixture below are there on purpose — JCS sorts keys by UTF-16 code
 * unit and escapes strings in a specific way, and a naive `JSON.stringify`
 * would pass a test built from ASCII and sorted input.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize } from '@provenance/log-core';

// The ANALYZER end — pure source, no DOM.
import {
  buildPolicyBlock,
  composeSignedManifest,
} from '../packages/analyzer/src/views/compose/manifest-composer.js';
import type { ComposerForm } from '../packages/analyzer/src/views/compose/manifest-composer.js';
import {
  makeCourseCert,
  makeKeypair,
} from '../packages/analyzer/src/views/compose/composer.fixture.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'tools', 'sign-manifest.ts');

// ---------------------------------------------------------------------------
// The fixture — deliberately awkward to canonicalize
// ---------------------------------------------------------------------------

/**
 * Values chosen so a naive serializer diverges:
 *
 *  - `assignment_id` carries non-ASCII, which JCS escapes and orders by UTF-16
 *    code unit. (Only KEYS must stay ASCII — see `course-cert.ts`. Values are
 *    unconstrained, and a course id or assignment id with an accent in it is
 *    entirely plausible.)
 *  - `files_under_review` is NOT in sorted order, and JCS must not reorder an
 *    array. A canonicalizer that sorted arrays as well as keys would pass an
 *    already-sorted fixture.
 *  - `heartbeat_interval_ms` is a number, so number formatting is exercised.
 */
const FORM_BASE = {
  assignment_id: 'proj2-café',
  semester: 'fa26',
  issued_at: '2026-09-08T00:00:00Z',
  files_under_review: ['src/zeta.py', 'src/alpha.py', 'src/Ünicode.py', 'src/alpha.py.bak'],
  course_id: 'berkeley-cs61b',
  collaboration: 'solo',
  submission: 'bundle',
  scope: 'directory',
  policy: {
    selection_change: false,
    focus_change: true,
    terminal: false,
    heartbeat_interval_ms: 45_000,
    // Exercised as `false`: the interesting value, and the one whose bytes both
    // ends must agree on.
    enrollment_required: false,
  },
  // Not in sorted order either, for the same reason files_under_review isn't.
  ignore: ['*.class', 'build/', '.Ünicode-cache/'],
  attachments: ['logs/', '*.log'],
} as const;

type Fixture = {
  dir: string;
  keypairPath: string;
  certPath: string;
  keypairText: string;
  certText: string;
  rootPubkeyHex: string;
};

let fx: Fixture;

beforeAll(async () => {
  const root = await makeKeypair(0x51);
  const rootPrivate = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    rootPrivate[i] = Number.parseInt(root.privateKeyHex.slice(i * 2, i * 2 + 2), 16);
  }
  const course = await makeKeypair(0x22);
  const cert = await makeCourseCert({
    courseId: FORM_BASE.course_id,
    coursePubkeyHex: course.publicKeyHex,
    rootPrivateKey: rootPrivate,
  });

  const dir = mkdtempSync(join(tmpdir(), 'provenance-composer-conformance-'));
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

// ---------------------------------------------------------------------------
// Driving each end
// ---------------------------------------------------------------------------

/**
 * Run the real CLI over an unsigned manifest file and return the bytes it wrote.
 *
 * The unsigned file is the hand-written JSON the CLI's docstring describes as
 * its input — the very thing this page exists to stop staff from writing.
 */
function runCli(unsigned: Record<string, unknown>, format: '1.0' | '2.0', name: string): string {
  const manifestPath = join(fx.dir, name);
  writeFileSync(manifestPath, JSON.stringify(unsigned, null, 2) + '\n');

  const args = [
    '--experimental-strip-types',
    CLI,
    manifestPath,
    '--format',
    format,
    '--course-keypair',
    fx.keypairPath,
  ];
  if (format === '2.0') {
    args.push('--course-cert', fx.certPath, '--root-pubkey', fx.rootPubkeyHex);
  }

  execFileSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8' });
  return readFileSync(manifestPath, 'utf8');
}

function form(format: '1.0' | '2.0'): ComposerForm {
  return { ...FORM_BASE, format };
}

async function runBrowser(format: '1.0' | '2.0'): Promise<string> {
  const composed = await composeSignedManifest({
    form: form(format),
    keypairFileText: fx.keypairText,
    certFileText: format === '2.0' ? fx.certText : null,
    rootPubkeyHex: format === '2.0' ? fx.rootPubkeyHex : null,
  });
  if (!composed.ok) {
    throw new Error(`browser compose failed: ${JSON.stringify(composed.error)}`);
  }
  return composed.value.fileText;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('manifest composer ↔ sign-manifest.ts byte identity', () => {
  it('produces byte-identical output at format 2.0', async () => {
    const cli = runCli(
      {
        format_version: '2.0',
        course_id: FORM_BASE.course_id,
        assignment_id: FORM_BASE.assignment_id,
        semester: FORM_BASE.semester,
        issued_at: FORM_BASE.issued_at,
        files_under_review: FORM_BASE.files_under_review,
        collaboration: FORM_BASE.collaboration,
        submission: FORM_BASE.submission,
        scope: FORM_BASE.scope,
        policy: buildPolicyBlock(FORM_BASE.policy),
        ignore: FORM_BASE.ignore,
        attachments: FORM_BASE.attachments,
      },
      '2.0',
      'v2.provenance-manifest',
    );

    const browser = await runBrowser('2.0');
    expect(browser).toBe(cli);
    // And byte-for-byte at the octet level, not merely string-equal after any
    // normalization a comparison might apply.
    expect([...Buffer.from(browser, 'utf8')]).toEqual([...Buffer.from(cli, 'utf8')]);
  });

  it('produces byte-identical output at format 1.0', async () => {
    const cli = runCli(
      {
        assignment_id: FORM_BASE.assignment_id,
        semester: FORM_BASE.semester,
        issued_at: FORM_BASE.issued_at,
        files_under_review: FORM_BASE.files_under_review,
      },
      '1.0',
      'v1.provenance-manifest',
    );

    const browser = await runBrowser('1.0');
    expect(browser).toBe(cli);
    expect([...Buffer.from(browser, 'utf8')]).toEqual([...Buffer.from(cli, 'utf8')]);
  });

  it('produces the identical signature, not merely identical bytes elsewhere', async () => {
    // ed25519 is deterministic, so the same key over the same payload gives the
    // same 128 hex chars. A drift in the SIGNED payload — a field present on
    // one side only — shows up here even if the two files happened to agree on
    // everything else.
    for (const format of ['1.0', '2.0'] as const) {
      const browser = JSON.parse(await runBrowser(format)) as { sig: string };
      const cliPath = join(
        fx.dir,
        format === '2.0' ? 'v2.provenance-manifest' : 'v1.provenance-manifest',
      );
      const cli = JSON.parse(readFileSync(cliPath, 'utf8')) as { sig: string };
      expect(browser.sig).toBe(cli.sig);
      expect(browser.sig).toMatch(/^[0-9a-f]{128}$/);
    }
  });

  it('the CLI rewrites any pre-existing sig, and the composer agrees with the rewrite', async () => {
    // The CLI's documented behaviour: strip any existing `sig`/`course_cert`
    // and rebuild. Feed it a file that already carries a bogus pair.
    const cli = runCli(
      {
        format_version: '2.0',
        course_id: FORM_BASE.course_id,
        assignment_id: FORM_BASE.assignment_id,
        semester: FORM_BASE.semester,
        issued_at: FORM_BASE.issued_at,
        files_under_review: FORM_BASE.files_under_review,
        collaboration: FORM_BASE.collaboration,
        submission: FORM_BASE.submission,
        scope: FORM_BASE.scope,
        policy: buildPolicyBlock(FORM_BASE.policy),
        ignore: FORM_BASE.ignore,
        attachments: FORM_BASE.attachments,
        sig: 'f'.repeat(128),
        course_cert: { course_id: 'somewhere-else' },
      },
      '2.0',
      'restamped.provenance-manifest',
    );

    expect(await runBrowser('2.0')).toBe(cli);
  });

  it('emits canonical bytes plus exactly one trailing newline, on both paths', async () => {
    const cli = readFileSync(join(fx.dir, 'v2.provenance-manifest'), 'utf8');
    const browser = await runBrowser('2.0');
    for (const [name, text] of [
      ['cli', cli],
      ['browser', browser],
    ] as const) {
      expect(text.endsWith('\n'), name).toBe(true);
      expect(text.endsWith('\n\n'), name).toBe(false);
      expect(canonicalize(JSON.parse(text)) + '\n', name).toBe(text);
    }
  });
});
