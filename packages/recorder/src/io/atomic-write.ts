/**
 * Atomic file write: write-temp → fsync → rename.
 *
 * CLAUDE.md: "Atomic writes. Write-temp-then-rename. Never partial-write the live log file."
 * PRD §4.6: "Both files are written atomically (write to `.tmp`, fsync, rename)."
 *
 * Used for `.meta` file updates and any other single-write files.
 * The `.slog` itself is append-only (SessionWriter); this helper is for whole-file writes.
 */

import * as fsPromises from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Injectable fs seam (for testing rename-failure cleanup)
// ---------------------------------------------------------------------------

/**
 * Subset of `node:fs/promises` needed by atomicWriteFile.
 * Production callers pass nothing (defaults to the real fs).
 * Tests can inject a mock to simulate rename/unlink failures.
 */
export type AtomicWriteFs = {
  open: typeof fsPromises.open;
  rename: typeof fsPromises.rename;
  unlink: typeof fsPromises.unlink;
};

/**
 * Write `contents` to `targetPath` atomically.
 *
 * Algorithm:
 *   1. Write to `<targetPath>.<pid>.<randomHex>.tmp`.
 *   2. fsync the file handle to flush to disk.
 *   3. Rename the temp file to `targetPath` (atomic on POSIX).
 *   4. On any error: silently attempt to unlink the temp file, then re-throw
 *      the original error (never mask the original error).
 *
 * @param _fs  Injectable fs operations; defaults to the real `node:fs/promises`.
 *             Tests inject a mock to simulate rename failures without ESM-spy issues.
 *
 * Throws on error (callers that use this for meta-file writes want to know).
 */
export async function atomicWriteFile(
  targetPath: string,
  contents: string | Uint8Array,
  _fs: AtomicWriteFs = fsPromises,
): Promise<void> {
  await atomicWriteFilePair([{ targetPath, contents }], _fs);
}

/**
 * Atomically write a SET of files that must agree with one another.
 *
 * POSIX has no multi-file rename, so this cannot be a true transaction. What it
 * does is stage every file (write + fsync) BEFORE renaming any of them, so the
 * only work left between the renames is the renames themselves. That shrinks the
 * window in which an observer can see a mixed old/new set from "one whole file
 * write plus an fsync" down to a single syscall.
 *
 * That window matters for the rolling seal: `manifest-<id>.json` and
 * `manifest-<id>.sig` are a signature over a payload, so a reader that catches a
 * NEW json beside an OLD sig sees a seal that does not verify. The window cannot
 * be closed entirely (see rolling-seal-writer.ts), only minimised.
 *
 * On any failure — staging or renaming — every temp file this call created is
 * best-effort unlinked and the original error is re-thrown unmasked. Files
 * already renamed are NOT rolled back: they are complete, valid, fsynced files,
 * and un-renaming them could only replace good bytes with older ones.
 */
export async function atomicWriteFilePair(
  files: ReadonlyArray<{ targetPath: string; contents: string | Uint8Array }>,
  _fs: AtomicWriteFs = fsPromises,
): Promise<void> {
  const staged: Array<{ tmpPath: string; targetPath: string }> = [];
  /** How many of `staged` have already been renamed onto their target. */
  let committed = 0;

  const cleanupUncommitted = async (): Promise<void> => {
    for (const { tmpPath } of staged.slice(committed)) {
      try {
        await _fs.unlink(tmpPath);
      } catch {
        // Silently ignore — the temp file may already be gone.
      }
    }
  };

  try {
    // Phase 1 — stage. Every byte is on disk and fsynced before any rename runs.
    for (const { targetPath, contents } of files) {
      const randomHex = randomBytes(8).toString('hex');
      const tmpPath = `${targetPath}.${process.pid}.${randomHex}.tmp`;

      let fh: fsPromises.FileHandle | undefined;
      try {
        // Open with 'w' to create/truncate and get a FileHandle for fsync.
        fh = await _fs.open(tmpPath, 'w');
        // Narrow the union so TypeScript can pick the right FileHandle.write overload.
        if (typeof contents === 'string') {
          await fh.write(contents, null, 'utf8');
        } else {
          await fh.write(contents);
        }
        await fh.sync();
        await fh.close();
        fh = undefined; // Successfully closed; don't close again below.
        staged.push({ tmpPath, targetPath });
      } catch (e) {
        // This temp file never made it into `staged`, so unlink it here.
        try {
          await _fs.unlink(tmpPath);
        } catch {
          // Silently ignore — open() itself may have failed.
        }
        if (fh !== undefined) {
          try {
            await fh.close();
          } catch {
            // Silently ignore secondary close error.
          }
        }
        throw e;
      }
    }

    // Phase 2 — commit. Back-to-back renames, no intervening I/O.
    for (const { tmpPath, targetPath } of staged) {
      await _fs.rename(tmpPath, targetPath);
      committed++;
    }
  } catch (originalError) {
    // Best-effort unlink of every temp file that was staged but never renamed.
    // Never mask the original error.
    await cleanupUncommitted();
    throw originalError;
  }
}
