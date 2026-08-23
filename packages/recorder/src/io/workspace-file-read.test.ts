/**
 * Tests for `readWorkspaceFile` — the single point through which every
 * `missing` decision in BOTH seals now flows.
 *
 * `missing` is an AFFIRMATIVE claim about a student ("this file was named and
 * is not there") that is rendered into academic-integrity proceedings, and this
 * module's contract is that exactly ONE condition may mint it: ENOENT. Until
 * now that contract was covered only indirectly, through `seal.test.ts` and
 * `rolling-seal-writer.test.ts` running the whole pipeline — so a regression
 * here could only be caught by whichever caller happened to exercise the
 * branch. These tests call it directly, one outcome per condition.
 *
 * The `withBytes` pair at the bottom is not a formality: the rolling seal
 * relies on `bytes` being ABSENT rather than `undefined`, because a stray key
 * shifts the JCS canonical bytes of a SIGNED manifest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readWorkspaceFile } from './workspace-file-read.js';

describe('readWorkspaceFile', () => {
  let tmpDir: string;
  /** `tmpDir` with every symlink resolved — on macOS `/var` is itself a link. */
  let realRoot: string;
  /** Directories chmod'd 0 during a test, restored in afterEach so `rm` works. */
  let restoreModes: string[];

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prov-read-'));
    realRoot = await fsPromises.realpath(tmpDir);
    restoreModes = [];
  });

  afterEach(async () => {
    for (const dir of restoreModes) {
      try {
        await fsPromises.chmod(dir, 0o755);
      } catch {
        // Already gone, or never applied — nothing to restore.
      }
    }
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  async function write(rel: string, content: string): Promise<void> {
    const abs = path.join(tmpDir, rel);
    await fsPromises.mkdir(path.dirname(abs), { recursive: true });
    await fsPromises.writeFile(abs, content, 'utf8');
  }

  const read = (rel: string) => readWorkspaceFile(tmpDir, realRoot, rel);

  // -------------------------------------------------------------------------
  // present
  // -------------------------------------------------------------------------

  it('reports an ordinary readable file as present, with its sha256', async () => {
    await write('src/Main.java', 'class Main {}');
    const result = await read('src/Main.java');
    expect(result.status).toBe('present');
    expect(result).toMatchObject({
      path: 'src/Main.java',
      sha256: createHash('sha256').update('class Main {}').digest('hex'),
    });
  });

  // -------------------------------------------------------------------------
  // missing — the ONE condition
  // -------------------------------------------------------------------------

  it('reports genuine absence as missing', async () => {
    const result = await read('NotThere.java');
    expect(result).toEqual({ path: 'NotThere.java', status: 'missing', sha256: null });
  });

  // -------------------------------------------------------------------------
  // unreadable — everything else
  // -------------------------------------------------------------------------

  it('reports an EACCES file as unreadable, never missing', async () => {
    await write('secret.txt', 'x');
    const abs = path.join(tmpDir, 'secret.txt');
    await fsPromises.chmod(abs, 0o000);
    // Running as root defeats every permission bit; skip rather than assert a
    // falsehood about the environment.
    let denied = true;
    try {
      await fsPromises.readFile(abs);
      denied = false;
    } catch {
      denied = true;
    }
    if (!denied) return;

    const result = await read('secret.txt');
    expect(result).toEqual({ path: 'secret.txt', status: 'unreadable' });
  });

  it('reports a file under an unreadable PARENT directory as unreadable, never missing', async () => {
    // The one that matters most: a file the student definitely has, made
    // unreachable by a directory mode. `missing` here would say "you did not
    // submit it" about a file sitting on disk.
    await write('locked/Main.java', 'class Main {}');
    const dir = path.join(tmpDir, 'locked');
    await fsPromises.chmod(dir, 0o000);
    restoreModes.push(dir);

    let denied = true;
    try {
      await fsPromises.readFile(path.join(dir, 'Main.java'));
      denied = false;
    } catch {
      denied = true;
    }
    if (!denied) return;

    const result = await read('locked/Main.java');
    expect(result).toEqual({ path: 'locked/Main.java', status: 'unreadable' });
  });

  it('reports a DIRECTORY named as a file as unreadable (the staff manifest typo)', async () => {
    // `files_under_review: ["src"]` instead of `"src/"`. A real, ordinary
    // mistake, and neither `present` nor `missing` is a true answer for it.
    await write('src/Main.java', 'class Main {}');
    const result = await read('src');
    expect(result).toEqual({ path: 'src', status: 'unreadable' });
  });

  it('reports a FIFO as unreadable and does NOT hang', async () => {
    // `readFile` on a FIFO blocks forever waiting for a writer, with no timeout
    // anywhere in this call stack — the `stat` gate is what prevents that, and
    // this test is what proves the gate is still there. The assertion is the
    // absence of a hang as much as the value.
    const fifo = path.join(tmpDir, 'pipe.txt');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      // No mkfifo (Windows, or a stripped image) — nothing to assert.
      return;
    }

    const result = await Promise.race([
      read('pipe.txt'),
      new Promise<'HUNG'>((resolve) => setTimeout(() => resolve('HUNG'), 3000)),
    ]);
    expect(result).toEqual({ path: 'pipe.txt', status: 'unreadable' });
  }, 10_000);

  // -------------------------------------------------------------------------
  // out_of_workspace — its own third outcome, never folded into missing
  // -------------------------------------------------------------------------

  it('reports a symlink resolving OUTSIDE the workspace as out_of_workspace', async () => {
    // The overwhelmingly common way to reach this is innocent:
    // `ln -s ~/shared/data.csv data.csv`. Minting `missing` for it told staff
    // the student did not submit a file that is on disk and fully readable.
    const outside = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prov-outside-'));
    try {
      await fsPromises.writeFile(path.join(outside, 'data.csv'), 'a,b\n', 'utf8');
      await fsPromises.symlink(path.join(outside, 'data.csv'), path.join(tmpDir, 'data.csv'));

      const result = await read('data.csv');
      expect(result).toEqual({ path: 'data.csv', status: 'out_of_workspace' });
    } finally {
      await fsPromises.rm(outside, { recursive: true, force: true });
    }
  });

  it('reports a ".." entry as out_of_workspace, never missing', async () => {
    await fsPromises.writeFile(path.join(path.dirname(tmpDir), 'escaped.txt'), 'x', 'utf8');
    try {
      const result = await read('../escaped.txt');
      expect(result).toEqual({ path: '../escaped.txt', status: 'out_of_workspace' });
    } finally {
      await fsPromises.rm(path.join(path.dirname(tmpDir), 'escaped.txt'), { force: true });
    }
  });

  it('follows a symlink that stays INSIDE the workspace and reports it present', async () => {
    // The containment check must not reject an ordinary in-workspace link —
    // rejecting it would drop a file the student really did submit.
    await write('real/Main.java', 'class Main {}');
    await fsPromises.symlink(
      path.join(tmpDir, 'real', 'Main.java'),
      path.join(tmpDir, 'link.java'),
    );
    const result = await read('link.java');
    expect(result.status).toBe('present');
  });

  // -------------------------------------------------------------------------
  // withBytes — absent, not undefined
  // -------------------------------------------------------------------------

  it('attaches raw bytes when withBytes: true', async () => {
    await write('a.txt', 'hello');
    const result = await readWorkspaceFile(tmpDir, realRoot, 'a.txt', { withBytes: true });
    expect(result.status).toBe('present');
    if (result.status !== 'present') throw new Error('unreachable');
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('hello');
  });

  it('OMITS the bytes key entirely when withBytes is not asked for', async () => {
    // ABSENT, not `undefined`. The rolling seal spreads this result into a
    // `SubmissionFileEntry` inside a manifest that is JCS-canonicalized and
    // SIGNED; a `bytes: undefined` key that survives a spread would shift the
    // canonical bytes of the signed message.
    await write('a.txt', 'hello');
    const result = await readWorkspaceFile(tmpDir, realRoot, 'a.txt');
    expect('bytes' in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual(['path', 'sha256', 'status']);
  });
});
