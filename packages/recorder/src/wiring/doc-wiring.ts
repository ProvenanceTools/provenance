/**
 * Doc wiring — registers VS Code subscriptions for doc.*, selection.change, focus.change.
 * Logic lives in doc-events.ts (pure); this file is the seam between VS Code and that logic.
 *
 * PRD §4.2: record doc.open/change/save/close for ANY file in the workspace.
 * PRD §4.3: paste detection (three-signal). Signal 1 (classifier) and signal 2
 *           (command intercept) are integrated here; signal 3 (reconciler) runs
 *           in extension.ts independently.
 * PRD §4.5: maintain ExpectedContent ONLY for files in files_under_review.
 */

import * as vscode from 'vscode';
import { sep as pathSep } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { MANIFEST_FILE_NAMES } from '../activation/manifest-loader.js';
import type {
  DocOpenPayload,
  DocChangePayload,
  DocSavePayload,
  DocClosePayload,
  PastePayload,
  SelectionChangePayload,
  FocusChangePayload,
  FsExternalChangePayload,
} from '@provenance/log-core';
import {
  transformDocOpen,
  transformDocChange,
  transformDocSave,
  transformDocClose,
  transformSelectionChange,
  transformFocusChange,
  transformPaste,
  type WorkspaceLike,
} from '../events/doc-events.js';
import { classifyChange } from '../events/paste-classifier.js';
import { buildPastePayload } from '../events/paste-payload.js';
import { MAX_INLINE_BYTES } from '../events/inline-content-limits.js';
import { ExpectedContentRegistry } from '../state/expected-content-registry.js';
import type { PasteIntercept } from './paste-command-intercept.js';
import { compareSavedContent } from '../events/external-change-detector.js';
import { buildExternalChangeContent } from '../events/external-change-content.js';
import type { ExplanationTagger } from '../events/explanation-tags.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal counter shared between doc-wiring and the paste reconciler. */
export type LargeInsertCounter = {
  increment(): void;
  count(): number;
};

export type DocWiringDeps = {
  workspace: WorkspaceLike;
  emitDocOpen: (data: DocOpenPayload) => void;
  emitDocChange: (data: DocChangePayload) => void;
  emitDocSave: (data: DocSavePayload) => void;
  emitDocClose: (data: DocClosePayload) => void;
  emitPaste: (data: PastePayload) => void;
  emitSelectionChange: (data: SelectionChangePayload) => void;
  emitFocusChange: (data: FocusChangePayload) => void;
  emitFsExternalChange: (data: FsExternalChangePayload) => void;
  /** Relative paths from the `.provenance-manifest`/`provenance-manifest` file. */
  filesUnderReview: readonly string[];
  /**
   * Absolute path to the `.provenance/` directory for this session. Files inside it
   * (the live `.slog`/`.slog.meta`, `manifest.json`, `manifest.sig`) are NEVER recorded,
   * along with the activation manifest at the workspace root. Optional so tests that
   * don't exercise the exclusion can omit it; production always passes it.
   */
  provenanceDir?: string;
  /** Registry for expected-content model. */
  expectedContent: ExpectedContentRegistry;
  /** Signal 2: command-intercept handle. Null if not available (tests can omit). */
  pasteIntercept: PasteIntercept | null;
  /** Counter shared with the paste reconciler (signal 3). */
  largeInsertCounter: LargeInsertCounter;
  /** Clock.now() for comparing paste-intercept timestamps. */
  getNow: () => number;
  /**
   * Read the on-disk content of a file after save. Path is relative to the workspace.
   * Used by Phase 7 external-change detection on the doc.save path.
   * In production: reads via node:fs/promises. In tests: stub.
   */
  readFile: (relativePath: string) => Promise<string>;
  /**
   * Synchronously read the on-disk content of a file. Path is relative to the workspace.
   * Used ONLY by the reload-from-disk discriminator in the doc.change handler to tell a
   * genuine auto-reload (buffer converged to disk) from a user's first edit on a still-clean
   * buffer (buffer diverged from disk). VS Code fires the content change before flipping
   * document.isDirty, so isDirty alone can't distinguish the two. This runs at most once per
   * clean→dirty transition (never on the keystroke firehose), so the sync read is cheap and
   * keeps event ordering intact. In production: node:fs.readFileSync. In tests: stub.
   */
  readFileSync: (relativePath: string) => string;
  /** Optional explanation tagger (Phase 8 will hook formatters/git into it). */
  explanationTagger?: ExplanationTagger;
  /**
   * Ownership filter (spec Design §3): returns true if the given absolute fsPath
   * belongs to THIS session's assignment root (per nearest-ancestor resolution —
   * see session/session-router.ts). Defaults to "always owned" so single-session
   * callers/tests that don't care about multi-root routing need not supply it.
   */
  isOwnedByThisRoot?: (fsPath: string) => boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeHash(content: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(content)));
}

// ---------------------------------------------------------------------------
// startDocWiring
// ---------------------------------------------------------------------------

export type DocWiringHandle = vscode.Disposable & {
  /** Returns the monotonic time of the last doc.change for a relative path, or -Infinity. */
  getLastDocChangeAt: (relativePath: string) => number;
  /** Returns the monotonic time of the last doc.save for a relative path, or -Infinity. */
  getLastSaveAt: (relativePath: string) => number;
};

/**
 * Register all doc-event subscriptions and return a DocWiringHandle that tears them all down.
 */
export function startDocWiring(deps: DocWiringDeps): DocWiringHandle {
  const {
    workspace,
    emitDocOpen,
    emitDocChange,
    emitDocSave,
    emitDocClose,
    emitPaste,
    emitSelectionChange,
    emitFocusChange,
    emitFsExternalChange,
    provenanceDir,
    expectedContent,
    pasteIntercept,
    largeInsertCounter,
    getNow,
    readFile,
    readFileSync,
    explanationTagger,
  } = deps;

  const isOwnedByThisRoot = deps.isOwnedByThisRoot ?? (() => true);

  // Track the most recent doc.change time per relative path (for fs-watcher tolerance).
  const lastDocChangeAt = new Map<string, number>();

  // Track the most recent doc.save time per relative path (for fs-watcher tolerance).
  const lastSaveAt = new Map<string, number>();

  // Track previous focus state for transition detection
  let prevFocused = vscode.window.state.focused;

  // -------------------------------------------------------------------------
  // Recordability filter (PRD §4.1, §4.2)
  //
  // The recorder MUST NOT record activity outside the assignment workspace.
  // This guard is the single source of truth for "is this document inside
  // the workspace and is it a real on-disk file?" It is applied at the top
  // of every live subscription handler (open/change/save/close/selection).
  //
  // Two checks:
  //   1. scheme === 'file'  — excludes 'vscode-userdata', 'output', 'git',
  //      'untitled', and any other virtual scheme.
  //   2. asRelativePath(uri) !== uri.fsPath  — VS Code's asRelativePath
  //      returns the absolute fsPath verbatim when the file is OUTSIDE the
  //      workspace folder. A successful relative-path conversion means the
  //      file is inside the workspace.
  //   3. NOT one of the recorder's own artifacts (see isProvenanceArtifact).
  //
  // The startup catch-up loop at the bottom of this function applies the
  // same filter inline; the helper here covers live events.
  // -------------------------------------------------------------------------

  // Normalized `.provenance/` prefix (dir + separator) for prefix matching.
  // Computed once; undefined when no provenanceDir was supplied (test-only).
  const provenanceDirPrefix =
    provenanceDir === undefined
      ? undefined
      : provenanceDir.endsWith(pathSep)
        ? provenanceDir
        : provenanceDir + pathSep;

  // -------------------------------------------------------------------------
  // The recorder must NEVER record reads or edits of its OWN artifacts:
  //   - everything under the `.provenance/` directory (the live `.slog`,
  //     `.slog.meta`, `manifest.json`, `manifest.sig`), and
  //   - the activation manifest at the workspace root (`.provenance-manifest`
  //     / `provenance-manifest`).
  //
  // Without this exclusion, a student opening the live log in the editor would
  // (a) emit a `doc.open` that inlines the log's own content, and (b) trigger a
  // self-feeding loop: the SessionWriter appends to the `.slog` on disk, VS Code
  // auto-reverts the still-clean editor buffer to match, that revert surfaces as
  // an `onDidChangeTextDocument` (see the reload-from-disk note in the doc.change
  // handler), and the appended bytes get re-recorded as a `doc.change`/`paste` —
  // which appends again, and so on. The `.provenance/` files are also not in
  // files_under_review, so the reload-from-disk discriminator never covered them.
  //
  // `fsPath` prefix match (not asRelativePath) so it's robust to the
  // provenanceDirOverride case; the manifest is matched by workspace-relative
  // name since it lives at the workspace root.
  // -------------------------------------------------------------------------
  function isProvenanceArtifact(fsPath: string, rel: string): boolean {
    if ((MANIFEST_FILE_NAMES as readonly string[]).includes(rel)) return true;
    if (provenanceDirPrefix === undefined) return false;
    return fsPath === provenanceDir || fsPath.startsWith(provenanceDirPrefix);
  }

  function isRecordable(uri: { fsPath: string; scheme: string }): boolean {
    if (uri.scheme !== 'file') return false;
    const rel = workspace.asRelativePath(uri as import('vscode').Uri);
    if (rel === uri.fsPath) return false;
    if (isProvenanceArtifact(uri.fsPath, rel)) return false;
    if (!isOwnedByThisRoot(uri.fsPath)) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // doc.open
  // -------------------------------------------------------------------------
  // Track documents we've already emitted doc.open for. VS Code should not
  // re-fire onDidOpenTextDocument for documents already open, but we add a
  // defensive guard anyway: if a future VS Code API change or version causes
  // a re-fire for an already-seen document, this Set prevents a double-emit.
  const seenDocs = new Set<string>();

  /**
   * Emit a doc.open event for `document`.
   * Reads the document text ONCE (via getText()) and passes it to both the
   * expected-content registry (for hash computation) and transformDocOpen
   * (for content inlining). This avoids a second getText() call.
   */
  function emitDocOpenForDocument(document: {
    uri: { fsPath: string; scheme: string };
    lineCount: number;
    getText(): string;
  }): void {
    const relativePath = workspace.asRelativePath(document.uri as import('vscode').Uri);

    // Defensive de-dup: skip if we've already emitted doc.open for this path.
    if (seenDocs.has(relativePath)) {
      return;
    }
    seenDocs.add(relativePath);

    const text = document.getText();
    let hash: string;

    if (expectedContent.isWatched(relativePath)) {
      // Create (or restore) expected-content state for this file
      const ec = expectedContent.getOrCreate(relativePath, text);
      hash = ec.hash;
    } else {
      hash = computeHash(text);
    }

    emitDocOpen(transformDocOpen(document as import('vscode').TextDocument, workspace, hash, text));
  }

  const openSub = vscode.workspace.onDidOpenTextDocument((document) => {
    if (!isRecordable(document.uri)) return;
    emitDocOpenForDocument(document);
  });

  // -------------------------------------------------------------------------
  // doc.change — integrates paste detection (PRD §4.3)
  // -------------------------------------------------------------------------
  const changeSub = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!isRecordable(event.document.uri)) return;
    const relativePath = workspace.asRelativePath(event.document.uri);

    // Track last doc.change time for this path BEFORE checking contentChanges length.
    // Empty-delta events (dirty-flag toggles, encoding/EOL changes) still represent a
    // document touch and should update the fs-watcher tolerance clock. We skip emitting
    // doc.change for non-content changes, but we do track the timestamp.
    lastDocChangeAt.set(relativePath, getNow());

    // VS Code fires onDidChangeTextDocument for non-content reasons too
    // (dirty-flag toggles, encoding/EOL changes). These events have no
    // contentChanges and are noise to the analyzer — drop them early.
    if (event.contentChanges.length === 0) {
      return;
    }

    // ---------------------------------------------------------------------
    // Reload-from-disk detection (PRD §4.5).
    //
    // When an external tool writes a watched file while VS Code has it
    // open with a clean buffer (e.g. a student runs `claude` in a separate
    // terminal), VS Code auto-reloads the buffer from disk. The reload
    // surfaces here as onDidChangeTextDocument with reason === undefined
    // and document.isDirty === false.
    //
    // BUT that signature is necessary, not sufficient: VS Code delivers the
    // content-change event BEFORE it flips document.isDirty, so a student's
    // FIRST edit on a still-clean buffer (freshly opened, or just saved)
    // also arrives as reason === undefined && isDirty === false. The dirty
    // flag only flips on the following (empty-delta) event. Keying solely on
    // isDirty therefore misroutes real edits (e.g. cmd+delete right after a
    // save) to fs.external_change.
    //
    // The decisive test is whether the new buffer MATCHES what's on disk:
    //   - genuine reload  → buffer converged to disk  → buffer == disk
    //   - real user edit  → disk still holds the old, unsaved content → buffer != disk
    // We read disk synchronously here. This branch only runs on the first
    // content change after a buffer goes clean (once dirty, edits carry
    // isDirty === true and skip it), never on the keystroke firehose, so the
    // sync read is cheap and keeps event ordering intact.
    //
    // The fs-watcher path (fs-watcher.ts) covers the other half of §4.5:
    // writes that happen with no buffer open at all.
    // ---------------------------------------------------------------------
    const maybeReloadFromDisk = event.reason === undefined && !event.document.isDirty;
    if (maybeReloadFromDisk && expectedContent.isWatched(relativePath)) {
      const ec = expectedContent.get(relativePath);
      if (ec !== undefined) {
        const newContent = event.document.getText();
        const newHash = computeHash(newContent);

        let onDiskContent: string | undefined;
        try {
          onDiskContent = readFileSync(relativePath);
        } catch {
          // Can't read disk (transient error / file vanished). Fall through to
          // normal user-edit handling rather than risk relabeling a real edit
          // as external; the fs-watcher still covers genuine external writes.
          onDiskContent = undefined;
        }

        const isGenuineReload =
          onDiskContent !== undefined && computeHash(onDiskContent) === newHash;
        if (isGenuineReload) {
          const oldHash = ec.hash;
          const oldLength = ec.content.length;
          if (newHash !== oldHash) {
            const explanation = explanationTagger?.consume();
            emitFsExternalChange({
              path: relativePath,
              operation: 'modify',
              old_hash: oldHash,
              new_hash: newHash,
              diff_size: Math.abs(newContent.length - oldLength),
              ...buildExternalChangeContent(newContent),
              ...(explanation !== undefined ? { explanation } : {}),
            });
            ec.reset(newContent);
          }
          return;
        }
        // Not a reload (buffer diverged from disk) — fall through to normal
        // user-edit handling below so the edit is recorded as doc.change/paste.
      }
    }

    // Build log-core delta representation
    const deltas = event.contentChanges.map((c) => ({
      range: {
        start: { line: c.range.start.line, character: c.range.start.character },
        end: { line: c.range.end.line, character: c.range.end.character },
      },
      text: c.text,
    }));

    // Apply deltas to expected content if watched (unchanged from Phase 5)
    if (expectedContent.isWatched(relativePath)) {
      const ec = expectedContent.get(relativePath);
      if (ec !== undefined) {
        ec.applyDeltas(deltas);
      }
    }

    // --- Signal 1: size-based classification ---
    const classification = classifyChange(deltas);

    if (classification === 'paste_likely') {
      // Increment large-insert counter for signal 3 (reconciler)
      largeInsertCounter.increment();

      // --- Signal 2: check if a paste command was intercepted just before this ---
      const now = getNow();
      const isConfirmed = pasteIntercept !== null && pasteIntercept.consumeIfPasteExpected(now);
      // Note: isConfirmed vs paste_likely distinction is not in the PRD paste payload;
      // both produce a 'paste' event. The reconciler (signal 3) handles discrepancy tracking.
      void isConfirmed; // intentionally unused in v1 per PRD analysis in task spec

      // Two emit paths. The governing rule: NEVER emit a `paste` event the
      // analyzer cannot replay. A `paste` whose payload lost its content is
      // strictly worse than a `doc.change` that kept it — `applyPaste` returns
      // `applied: false` and reconstruction for that file dies from that point
      // on, while the deltas on a `doc.change` always replay faithfully.
      //
      // (a) `paste` — a single delta with an empty range, whose text is small
      //     enough to be inlined. Both conditions are required, for the two
      //     independent reasons a paste can fail to replay:
      //
      //       SHAPE. PastePayload carries exactly one range + one text, so a
      //       multi-delta WorkspaceEdit spanning disjoint ranges cannot be
      //       expressed without collapsing them — `applyPaste` cannot reproduce
      //       it.
      //
      //       SIZE. `buildPastePayload` only inlines up to MAX_INLINE_BYTES;
      //       past that it truncates to a head/tail preview (paste-payload.ts).
      //       A `paste` built from truncated content is unreplayable for the
      //       same reason. This condition is read from the shared constant, not
      //       hardcoded, so it tracks the cap forever — raising the cap narrows
      //       this hole but only the gate closes it.
      //
      // (b) Anything else — emit `doc.change` with source='paste_likely' so the
      //     analyzer applies the deltas faithfully (preserves reconstruction).
      //     Nothing is lost by doing so: analysis-core's `iterateCandidatePastes`
      //     treats a `doc.change` with source='paste_likely'/'paste_confirmed'
      //     as a candidate paste, so every paste heuristic still sees it.
      //
      // Byte length, not string length — matching the unit the cap itself uses.
      // A multi-byte codepoint counts as more than one byte.
      const pasteDelta = deltas.length === 1 ? deltas[0]! : null;
      const isSinglePasteShaped =
        pasteDelta !== null &&
        pasteDelta.range.start.line === pasteDelta.range.end.line &&
        pasteDelta.range.start.character === pasteDelta.range.end.character;
      const isInlineable =
        pasteDelta !== null && Buffer.byteLength(pasteDelta.text, 'utf8') <= MAX_INLINE_BYTES;

      if (isSinglePasteShaped && isInlineable) {
        const fields = buildPastePayload(pasteDelta.text);
        const pastePayload = transformPaste(relativePath, pasteDelta.range, fields);
        emitPaste(pastePayload);
      } else {
        // Not replayable as a `paste` (wrong shape, or too large to inline):
        // emit as doc.change with paste_likely source so reconstruction stays
        // faithful and heuristics can still see the signal.
        const payload = transformDocChange(event, workspace);
        payload.source = 'paste_likely';
        emitDocChange(payload);
      }
    } else {
      // typed path — emit doc.change as before
      emitDocChange(transformDocChange(event, workspace));
    }
  });

  // -------------------------------------------------------------------------
  // doc.save — Phase 7: compare on-disk content against expected for watched files.
  // -------------------------------------------------------------------------
  const saveSub = vscode.workspace.onDidSaveTextDocument((document) => {
    if (!isRecordable(document.uri)) return;
    const relativePath = workspace.asRelativePath(document.uri);

    // Anchor the fs-watcher's tolerance window on the SAVE, not just on the last
    // doc.change. VS Code's autoSaveDelay defaults to 1000ms while the watcher
    // tolerance is 250ms, so a doc.change-anchored window never covers the
    // watcher event for the editor's own autosave. Recorded synchronously, before
    // any async work, so the watcher sees it no matter when the OS notifies us.
    lastSaveAt.set(relativePath, getNow());

    if (expectedContent.isWatched(relativePath)) {
      const ec = expectedContent.get(relativePath);
      if (ec !== undefined) {
        // Read the actual on-disk content to compare with expected.
        // We must use readFile rather than doc.getText() because the VS Code
        // buffer may differ from what a concurrent tool wrote (PRD §4.5).
        readFile(relativePath).then(
          (onDiskContent) => {
            const result = compareSavedContent(ec, onDiskContent);

            // Recent-state tolerance (PRD §4.5).
            //
            // `readFile` opens an async gap between the physical write and this
            // comparison. A keystroke landing in that gap advances `ec` past the
            // snapshot we just read, so a naive hash compare reports the student's
            // own save as an external write — and the historical `ec.reset(...)`
            // below then rolled the model BACKWARDS onto the stale snapshot,
            // guaranteeing the next save mismatched too (the mirrored-pair bug).
            //
            // If the on-disk hash is a state this buffer genuinely passed through,
            // the write was ours and we merely observed it late. Emit nothing, and
            // crucially do NOT reset: the live buffer is ahead and authoritative.
            // Content the buffer never held is still reported, so a real external
            // write (git checkout, another editor, an agentic CLI tool) is
            // unaffected.
            if (result.kind === 'external_change' && ec.hasRecentHash(result.new_hash)) {
              emitDocSave(transformDocSave(document, workspace, result.new_hash));
              return;
            }

            if (result.kind === 'external_change') {
              // Emit fs.external_change FIRST, then reset, then emit doc.save.
              // Order matters: doc.save's hash represents the post-reset state.
              const explanation = explanationTagger?.consume();
              emitFsExternalChange({
                path: relativePath,
                operation: 'modify',
                old_hash: result.old_hash,
                new_hash: result.new_hash,
                diff_size: result.diff_size,
                ...buildExternalChangeContent(onDiskContent),
                ...(explanation !== undefined ? { explanation } : {}),
              });
              // Reset expected content to the on-disk reality before emitting doc.save.
              ec.reset(onDiskContent);
            }

            // Always emit doc.save with the actual on-disk hash.
            const saveHash = result.kind === 'clean_save' ? result.new_hash : result.new_hash;
            emitDocSave(transformDocSave(document, workspace, saveHash));
          },
          (_err) => {
            // Fallback: use expected hash if we can't read the file.
            emitDocSave(transformDocSave(document, workspace, ec.hash));
          },
        );
        return; // async path; doc.save emitted inside the promise handler
      }
    }

    // Unwatched file or no expected-content entry: use doc.getText() hash.
    const hash = computeHash(document.getText());
    emitDocSave(transformDocSave(document, workspace, hash));
  });

  // -------------------------------------------------------------------------
  // doc.close
  // -------------------------------------------------------------------------
  const closeSub = vscode.workspace.onDidCloseTextDocument((document) => {
    if (!isRecordable(document.uri)) return;
    // CLAUDE.md: do not delete registry entry on close; close+reopen is common.
    emitDocClose(transformDocClose(document, workspace));
  });

  // -------------------------------------------------------------------------
  // selection.change
  // -------------------------------------------------------------------------
  const selectionSub = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!isRecordable(event.textEditor.document.uri)) return;
    emitSelectionChange(transformSelectionChange(event, workspace));
  });

  // -------------------------------------------------------------------------
  // focus.change (window state transitions only)
  // -------------------------------------------------------------------------
  const focusSub = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused !== prevFocused) {
      emitFocusChange(transformFocusChange(state, prevFocused));
      prevFocused = state.focused;
    }
  });

  // -------------------------------------------------------------------------
  // Issue A fix: emit synthetic doc.open for documents already open at
  // activation time.
  //
  // VS Code's onDidOpenTextDocument fires only for documents that open AFTER
  // the extension activates. Any file that was already open when the extension
  // started (e.g., the student had hw.py open before hitting "Start Session")
  // never triggers the subscription. We cover the gap by iterating
  // vscode.workspace.textDocuments synchronously.
  //
  // Filter: only `file`-scheme URIs whose relative path differs from the
  // absolute fsPath (i.e., the document is inside the workspace folder).
  // This excludes untitled buffers, git-extension overlays, output panels,
  // and any virtual-document schemes that should not appear in the log.
  //
  // Ordering: subscriptions are wired before this block executes, so any
  // document that opens between subscription-registration and here would be
  // handled by the live `openSub`. The `seenDocs` Set in
  // `emitDocOpenForDocument` prevents double-emits for such a race.
  // -------------------------------------------------------------------------
  for (const doc of vscode.workspace.textDocuments) {
    if (!isRecordable(doc.uri)) continue;
    emitDocOpenForDocument(doc);
  }

  return {
    dispose() {
      openSub.dispose();
      changeSub.dispose();
      saveSub.dispose();
      closeSub.dispose();
      selectionSub.dispose();
      focusSub.dispose();
    },
    getLastDocChangeAt(relativePath: string): number {
      return lastDocChangeAt.get(relativePath) ?? -Infinity;
    },
    getLastSaveAt(relativePath: string): number {
      return lastSaveAt.get(relativePath) ?? -Infinity;
    },
  };
}
