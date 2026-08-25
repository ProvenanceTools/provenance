/**
 * Tests for the shared workspace walk (task 13, fix round 1, Minor 4).
 *
 * Moved here from `commands/seal.test.ts`:
 *   - `'never seals a hard-excluded path, however greedy the manifest'`
 *   - `'does not recurse into a symlinked directory (lstat-flavoured Dirent
 *     classification)'`
 *
 * Both previously exercised `walkWorkspace`'s own directory-pruning and
 * symlink-safety properties only INDIRECTLY, by running the whole
 * `sealBundle` pipeline and inspecting the resulting manifest. Now that
 * `walkWorkspace` is a standalone shared module imported by both seals, its
 * own behaviour belongs here, called directly, rather than covered only
 * incidentally through one of its two callers. Converted from the
 * `sealBundle`-mediated assertions to direct calls; no behaviour asserted has
 * changed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { walkWorkspace } from './workspace-walk.js';

describe('walkWorkspace', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prov-walk-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  async function write(rel: string, content: string): Promise<void> {
    const abs = path.join(tmpDir, rel);
    await fsPromises.mkdir(path.dirname(abs), { recursive: true });
    await fsPromises.writeFile(abs, content, 'utf8');
  }

  it('never walks into .provenance/ or .git/ at the workspace root, however much else is there', async () => {
    await write('src/Main.java', 'x');
    await write('.provenance/should-not-appear.txt', 'x');
    await write('.git/objects/pack-abc.pack', 'x');

    const result = await walkWorkspace(tmpDir);

    expect(result.paths).toContain('src/Main.java');
    expect(result.paths.some((p) => p.startsWith('.provenance/'))).toBe(false);
    expect(result.paths.some((p) => p.startsWith('.git/'))).toBe(false);
  });

  it('does not recurse into a symlinked directory (lstat-flavoured Dirent classification)', async () => {
    // Dirent.isDirectory() does not follow symlinks, so a symlink to a
    // directory (including one pointing back at an ancestor, which would
    // otherwise cycle forever) is classified as neither a directory nor a
    // file by this walk and is simply skipped.
    await write('real/Nested.java', 'class Nested {}');
    const cyclePath = path.join(tmpDir, 'loop');
    await fsPromises.symlink(tmpDir, cyclePath);

    const result = await walkWorkspace(tmpDir);

    expect(result.paths).toContain('real/Nested.java');
    // Nothing was walked through the `loop/` symlink at all.
    expect(result.paths.some((p) => p.startsWith('loop/'))).toBe(false);
    // …but the entry is REPORTED, so the caller can disclose the drop.
    expect(result.symlinkPaths).toContain('loop');
  });

  it('reports a symlinked FILE in symlinkPaths rather than dropping it silently', async () => {
    // `d.isFile()` is false for a symlink entry, so a symlinked file never
    // reaches `paths`. Before this list existed, an in-scope one just vanished
    // from the bundle with no flag anywhere — the only drop in the seal that
    // left no trace at all.
    await write('logs/real.log', 'output');
    await fsPromises.symlink(path.join(tmpDir, 'logs/real.log'), path.join(tmpDir, 'logs/lnk.log'));

    const result = await walkWorkspace(tmpDir);

    expect(result.paths).toContain('logs/real.log');
    expect(result.paths).not.toContain('logs/lnk.log');
    expect(result.symlinkPaths).toEqual(['logs/lnk.log']);
  });

  it('does not report a hard-excluded symlink', async () => {
    // A link the protocol excludes is not in scope and never was; reporting it
    // would make the caller warn about a drop that is the protocol working.
    await write('real-manifest', '{}');
    await fsPromises.symlink(
      path.join(tmpDir, 'real-manifest'),
      path.join(tmpDir, '.provenance-manifest'),
    );

    const result = await walkWorkspace(tmpDir);

    expect(result.symlinkPaths).toEqual([]);
  });

  it('reports no symlinks and an empty list for an ordinary workspace', async () => {
    await write('src/Main.java', 'class Main {}');
    const result = await walkWorkspace(tmpDir);
    expect(result.symlinkPaths).toEqual([]);
  });
});
