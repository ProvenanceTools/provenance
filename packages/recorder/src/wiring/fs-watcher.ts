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
 * - Each entry in scope.track gets its own FileSystemWatcher created via
 *   vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern)),
 *   where pattern is the entry widened by watcherPatternFor — a coarse
 *   pre-filter only (design spec §4.2). VS Code's glob engine is not our
 *   matcher, so every path a watcher delivers is re-checked with
 *   resolvePathRole before anything is emitted.
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
import type { FsExternalChangePayload, ResolvedScope } from '@provenance/log-core';
import { sha256Hex, resolvePathRole } from '@provenance/log-core';
import type { ExpectedContentRegistry } from '../state/expected-content-registry.js';
import type { ExplanationTagger } from '../events/explanation-tags.js';
import { buildExternalChangeContent } from '../events/external-change-content.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FsExternalChangeData = FsExternalChangePayload;

export type FsWatcherDeps = {
  assignmentRoot: string;
  /** The resolved scope. Watchers are built from `scope.track`; every delivered path is re-checked. */
  scope: ResolvedScope;
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Widen a scope entry into an editor watcher glob.
 *
 * This is a COARSE PRE-FILTER and nothing more (design spec §4.2). VS Code's
 * glob engine is not our matcher, and JetBrains' and Neovim's are two more; a
 * port that emitted on its watcher's verdict alone would make the same manifest
 * watch different files on different editors. Every path a watcher delivers is
 * re-checked with `resolvePathRole` before anything is emitted, so widening
 * here is safe and narrowing here would be a bug.
 */
export function watcherPatternFor(entry: string): string {
  if (entry.endsWith('/')) return `${entry}**`;
  if (entry.startsWith('*')) return `**/${entry}`;
  return entry;
}

/**
 * The workspace-relative, forward-slash path for a watcher URI, or `null` when
 * the URI does not sit under `assignmentRoot` at all.
 *
 * Forward slashes always: the whole protocol — `doc.*` payload paths,
 * `files_under_review`, the matcher — is forward-slash, and a Windows recorder
 * emitting backslashes would join against nothing.
 *
 * ## The case-insensitive fallback
 *
 * VS Code does not promise that `uri.fsPath` and the string a
 * `WorkspaceFolder` was opened with agree on CASE. On Windows the drive letter
 * routinely diverges (`C:\Users\...` vs `c:\Users\...`), and macOS is
 * case-insensitive on disk, so the same directory reaches us under two
 * spellings. The prefix test is therefore retried case-insensitively before
 * giving up — the slice still uses the ORIGINAL bytes, so the returned path
 * keeps whatever spelling the filesystem handed us, which is the spelling the
 * `doc.*` handlers use.
 *
 * ## Why `null`, and never the absolute path
 *
 * This used to return the FULL ABSOLUTE PATH when the prefix did not match.
 * That is worse than useless in both directions. Usually the absolute path
 * resolves to `'unscoped'` and the `fs.external_change` emit is suppressed
 * entirely — silent loss of external-change detection, the one signal that
 * catches a file edited outside the editor. Occasionally it is worse than
 * silent: an absolute path still ENDS with `.java`, so a `*.java` suffix rule
 * matches it, and the recorder emits an event whose `path` is an absolute
 * location on the student's machine that joins against nothing downstream.
 *
 * `null` says the one true thing — this URI is not under the assignment root,
 * so there is no workspace-relative path to report — and each handler returns
 * on it. A watcher built from `RelativePattern(assignmentRoot, …)` should never
 * deliver one, so this is a guard, not a code path with expected traffic.
 */
export function relativePathOf(assignmentRoot: string, uri: { fsPath: string }): string | null {
  const full = uri.fsPath.split('\\').join('/');
  const normalizedRoot = assignmentRoot.split('\\').join('/');
  const root = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  if (full.startsWith(root)) return full.slice(root.length);
  if (full.toLowerCase().startsWith(root.toLowerCase())) return full.slice(root.length);
  return null;
}

// ---------------------------------------------------------------------------
// startFsWatcher
// ---------------------------------------------------------------------------

/**
 * Start a FileSystemWatcher for each entry in scope.track.
 * Returns a Disposable that disposes all watchers.
 */
export function startFsWatcher(deps: FsWatcherDeps): vscode.Disposable {
  const {
    assignmentRoot,
    scope,
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

  for (const entry of scope.track) {
    const pattern = new vscode.RelativePattern(assignmentRoot, watcherPatternFor(entry));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = (uri: vscode.Uri) => {
      const relativePath = relativePathOf(assignmentRoot, uri);
      if (relativePath === null) return;
      if (resolvePathRole(relativePath, scope) !== 'reviewed') return;

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
          const explanation = explanationTagger?.consume(relativePath);

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

    const handleCreate = (uri: vscode.Uri) => {
      const relativePath = relativePathOf(assignmentRoot, uri);
      if (relativePath === null) return;
      if (resolvePathRole(relativePath, scope) !== 'reviewed') return;

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
            const explanation = explanationTagger?.consume(relativePath);
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
          const explanation = explanationTagger?.consume(relativePath);
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

    const handleDelete = (uri: vscode.Uri) => {
      const relativePath = relativePathOf(assignmentRoot, uri);
      if (relativePath === null) return;
      if (resolvePathRole(relativePath, scope) !== 'reviewed') return;

      const expected = registry.get(relativePath);
      if (expected === undefined) {
        // File was never opened/known; nothing to compare against. Emit a
        // delete with empty old_hash so the timeline still shows the event.
        const explanation = explanationTagger?.consume(relativePath);
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
      const explanation = explanationTagger?.consume(relativePath);
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
