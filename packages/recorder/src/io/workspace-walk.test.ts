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
  });
});
