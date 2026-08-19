/**
 * fs-watcher.ts — FileSystemWatcher for files_under_review.
 *
 * Emits fs.external_change events for on-disk modifications, creations,
 * and deletions of watched files when those happen outside VS Code's
 * editor surface. Covers the "file edited / created / deleted while VS
 * Code was unfocused or didn't have the file open" path (PRD §4.5). The
 * complementary path — VS Code auto-reload of an open clean buffer after
 * an external write — lives in doc-wiring.ts.
 *
 * Design notes:
 * - Each file in filesUnderReview gets its own FileSystemWatcher created via
 *   vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, path)).
 * - onDidChange (modify): if the change happened within recentDocChangeToleranceMs of
 *   the last doc.change OR the last doc.save for that file, we skip it — VS
 *   Code-mediated saves are already captured on the doc.* path. Only truly
 *   external modifies are reported. Beyond that window, the on-disk hash is
 *   additionally checked against the file's recent-buffer-state ring
 *   (ExpectedContent.hasRecentHash), so a late-delivered watcher event for the
 *   editor's own write is never reported as external.
 * - onDidCreate: read the file, emit operation:'create' with new_content, seed
 *   the expected-content registry.
 * - onDidDelete: emit operation:'delete' with old_hash from the registry and
 *   empty new_hash; drop the registry entry so a subsequent re-create starts
 *   from a clean baseline.
 * - We compare the new on-disk hash against registry.get(path)?.hash for modifies.
 *   If the file isn't in the registry (was never opened) we still report creates
 *   (no baseline needed) but skip modifies (nothing to compare against).
 * - After emitting a modify or create, we call expected.reset(newContent) so
 *   subsequent edits chain from reality (CLAUDE.md + PRD §4.5).
 *
 * Timing note: VS Code's FileSystemWatcher delivers events asynchronously
 * after the OS notifies it of a change. There may be a small delay between the
 * file being written and the event firing. The recentDocChangeToleranceMs guard
 * (default 250ms, modify path only) is deliberately conservative to avoid
 * double-reporting saves that VS Code processes right after a doc.change.
 */

import * as vscode from 'vscode';
import type { FsExternalChangePayload } from '@provenance/log-core';
import { sha256Hex } from '@provenance/log-core';
import type { ExpectedContentRegistry } from '../state/expected-content-registry.js';
import type { ExplanationTagger } from '../events/explanation-tags.js';
import { buildExternalChangeContent } from '../events/external-change-content.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FsExternalChangeData = FsExternalChangePayload;

export type FsWatcherDeps = {
  assignmentRoot: string;
  filesUnderReview: readonly string[];
  registry: ExpectedContentRegistry;
  emit: (data: FsExternalChangeData) => void;
  /** Returns the time of the last doc.change for path (monotonic ms), or -Infinity. */
  getLastDocChangeAt: (path: string) => number;
  /**
   * Returns the time of the last doc.save for path (monotonic ms), or -Infinity.
   * Required: VS Code's autosave delay (default 1000ms) routinely exceeds the
   * tolerance window, so a doc.change-anchored window alone never covers the
   * watcher event for the editor's own save.
   */
  getLastSaveAt: (path: string) => number;
  getNow: () => number;
  /**
   * Tolerance in ms. Modifies within this window of a doc.change *or* a doc.save
   * are ignored. Default 250.
   */
  recentDocChangeToleranceMs?: number;
  /** Read the on-disk file content (relative path within workspace). */
  readFile: (relativePath: string) => Promise<string>;
  explanationTagger?: ExplanationTagger;
};

// ---------------------------------------------------------------------------
// startFsWatcher
// ---------------------------------------------------------------------------

/**
 * Start a FileSystemWatcher for each file in filesUnderReview.
 * Returns a Disposable that disposes all watchers.
 */
export function startFsWatcher(deps: FsWatcherDeps): vscode.Disposable {
  const {
    assignmentRoot,
    filesUnderReview,
    registry,
    emit,
    getLastDocChangeAt,
    getLastSaveAt,
    getNow,
    readFile,
    explanationTagger,
  } = deps;
  const tolerance = deps.recentDocChangeToleranceMs ?? 250;

  const watchers: vscode.Disposable[] = [];

  for (const relativePath of filesUnderReview) {
    const pattern = new vscode.RelativePattern(assignmentRoot, relativePath);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = (_uri: vscode.Uri) => {
      // Check whether this change is too close to a recent editor touch — a
      // doc.change OR a doc.save — i.e. it was VS Code-mediated and is already
      // captured on the doc.* path. The save anchor is load-bearing: VS Code's
      // autoSaveDelay defaults to 1000ms, so a save routinely lands well outside
      // a doc.change-anchored 250ms window.
      const lastEditorTouch = Math.max(
        getLastDocChangeAt(relativePath),
        getLastSaveAt(relativePath),
      );
      if (getNow() - lastEditorTouch < tolerance) {
        // VS Code-mediated save — already captured via the doc.* handlers.
        return;
      }

      const expected = registry.get(relativePath);
      if (expected === undefined) {
        // File was never opened in VS Code — no baseline to compare against
        // for a modify. (Creates are handled separately by handleCreate.)
        return;
      }

      readFile(relativePath).then(
        (onDiskContent) => {
          const newHash = sha256Hex(onDiskContent);

          // Sample the expected hash HERE, after the read resolves, so both
          // sides of the comparison are read at the same moment. Pinning it
          // before the read (as this code used to, in the name of avoiding
          // TOCTOU) does the opposite: it compares a stale model hash against
          // fresher disk bytes and manufactures a mismatch whenever a
          // doc.change lands during the read.
          const oldHash = expected.hash;
          if (newHash === oldHash) {
            // No real change (e.g., file touched but content identical).
            return;
          }

          // Recent-state tolerance: if the disk holds a state this buffer
          // genuinely passed through, the write was the editor's own and we
          // merely observed it late. Emit nothing, and do NOT reset — the live
          // buffer is ahead and authoritative. Content the buffer never held
          // still falls through and is reported.
          if (expected.hasRecentHash(newHash)) {
            return;
          }

          const diff_size = Math.abs(onDiskContent.length - expected.content.length);
          const explanation = explanationTagger?.consume();

          const payload: FsExternalChangeData = {
            path: relativePath,
            operation: 'modify',
            old_hash: oldHash,
            new_hash: newHash,
            diff_size,
            ...buildExternalChangeContent(onDiskContent),
            ...(explanation !== undefined ? { explanation } : {}),
          };

          emit(payload);
          expected.reset(onDiskContent);
        },
        (_err) => {
          // File may have been deleted between the watcher event and the
          // read — onDidDelete will fire next and emit the delete event.
        },
      );
    };

    const handleCreate = (_uri: vscode.Uri) => {
      // A file appeared on disk where one wasn't before. This is the path
      // a `git checkout`, `mv`, `cp`, or `claude` CLI tool that writes a
      // brand-new file would hit. (When the file was previously deleted
      // and then re-created, handleDelete will have cleared the registry
      // entry; this branch then re-seeds it from the new content.)
      readFile(relativePath).then(
        (onDiskContent) => {
          const existing = registry.get(relativePath);
          const newHash = sha256Hex(onDiskContent);

          if (existing !== undefined) {
            // Race: doc.open beat onDidCreate to the registry (the file
            // was opened in VS Code before the FS watcher fired). If the
            // hashes match, the open path covered it — silent. If they
            // differ, treat as a modify against the doc.open baseline so
            // staff still see the divergence — unless the on-disk state is one
            // the buffer genuinely passed through, in which case this is the
            // editor's own write observed late (same recent-state tolerance as
            // handleChange; do not reset, the buffer is ahead).
            if (newHash === existing.hash) return;
            if (existing.hasRecentHash(newHash)) return;
            const diff_size = Math.abs(onDiskContent.length - existing.content.length);
            const explanation = explanationTagger?.consume();
            emit({
              path: relativePath,
              operation: 'modify',
              old_hash: existing.hash,
              new_hash: newHash,
              diff_size,
              ...buildExternalChangeContent(onDiskContent),
              ...(explanation !== undefined ? { explanation } : {}),
            });
            existing.reset(onDiskContent);
            return;
          }

          // No prior baseline — pure create.
          const explanation = explanationTagger?.consume();
          emit({
            path: relativePath,
            operation: 'create',
            old_hash: '',
            new_hash: newHash,
            diff_size: onDiskContent.length,
            ...buildExternalChangeContent(onDiskContent),
            ...(explanation !== undefined ? { explanation } : {}),
          });
          // Seed the registry so subsequent edits chain from this baseline.
          registry.getOrCreate(relativePath, onDiskContent);
        },
        (_err) => {
          // File disappeared again before we could read it; onDidDelete
          // will pick it up.
        },
      );
    };

    const handleDelete = (_uri: vscode.Uri) => {
      const expected = registry.get(relativePath);
      if (expected === undefined) {
        // File was never opened/known; nothing to compare against. Emit a
        // delete with empty old_hash so the timeline still shows the event.
        const explanation = explanationTagger?.consume();
        emit({
          path: relativePath,
          operation: 'delete',
          old_hash: '',
          new_hash: '',
          diff_size: 0,
          ...(explanation !== undefined ? { explanation } : {}),
        });
        return;
      }
      const explanation = explanationTagger?.consume();
      emit({
        path: relativePath,
        operation: 'delete',
        old_hash: expected.hash,
        new_hash: '',
        diff_size: expected.content.length,
        ...(explanation !== undefined ? { explanation } : {}),
      });
      // Drop the registry entry — a subsequent re-create will start clean.
      registry.delete(relativePath);
    };

    watcher.onDidChange(handleChange);
    watcher.onDidCreate(handleCreate);
    watcher.onDidDelete(handleDelete);
    watchers.push(watcher);
  }

  return {
    dispose() {
      for (const w of watchers) {
        w.dispose();
      }
      watchers.length = 0;
    },
  };
}
