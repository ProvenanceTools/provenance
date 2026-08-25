/**
 * Non-dismissible status bar item indicating that recording is active.
 * PRD §4.1: "shows a non-dismissible status bar item ('Provenance: recording')
 * so the student is always aware that telemetry is active."
 *
 * The item also carries the ENROLLMENT state, because "recording" alone is a
 * half-truth for a student who never enrolled: telemetry is active, but nothing
 * in the bundle says it was theirs. The wording itself lives in
 * `enroll-nudge.ts` so it can be tested without the VS Code runtime; this module
 * is the glue that renders it.
 */

import * as vscode from 'vscode';
import { enrollmentStatusBar } from './enroll-nudge.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create and show the "Provenance: recording" status bar item.
 * The item is pushed onto the disposables list so it's cleaned up on deactivate.
 *
 * Mounts in the NEUTRAL state — plain "recording", no enrollment claim. Whether
 * the student is enrolled is not known until the first session has built its
 * identity block, and this item is mounted before that (activation order: status
 * bar, then sessions). Starting neutral and refining via
 * {@link setEnrollmentState} means the student never sees a "(not enrolled)" that
 * turns out to be wrong; the reverse order would flash a false accusation at
 * every enrolled student on every launch.
 *
 * @param disposables  List to push the StatusBarItem onto.
 */
export function createRecordingStatusBar(disposables: vscode.Disposable[]): vscode.StatusBarItem {
  // Priority 100 keeps it visible at the left side, ahead of most extensions.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const { text, tooltip } = enrollmentStatusBar(false);
  item.text = text;
  item.tooltip = tooltip;
  item.show();

  disposables.push(item);
  return item;
}

/**
 * Re-render the item for a known enrollment state.
 *
 * Called once per activation, after every session has started and reported
 * whether it could claim an identity. Idempotent, so a later rescan (a workspace
 * folder added or removed) can simply call it again.
 *
 * The item is given a `command` in the un-enrolled state ONLY: clicking it opens
 * the enrollment key, which is the first step of the flow the tooltip describes.
 * An enrolled student's status bar stays inert, as it has always been — there is
 * nothing for them to do.
 */
export function setEnrollmentState(item: vscode.StatusBarItem, unenrolled: boolean): void {
  const { text, tooltip } = enrollmentStatusBar(unenrolled);
  item.text = text;
  item.tooltip = tooltip;
  item.command = unenrolled ? 'provenance.showEnrollmentKey' : undefined;
}
