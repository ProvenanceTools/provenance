import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { createRecordingStatusBar, setEnrollmentState } from './status-bar.js';
import { ENROLL_URL } from './enroll-nudge.js';

describe('createRecordingStatusBar', () => {
  it('mounts NEUTRAL — never an enrollment claim it has not checked yet', () => {
    // The false-accusation guard. This item is mounted before any session has
    // built its identity block, so the enrollment answer is not yet known. If it
    // mounted as "(not enrolled)" and corrected itself a moment later, every
    // enrolled student would see themselves accused on every single launch.
    const disposables: vscode.Disposable[] = [];
    const item = createRecordingStatusBar(disposables);

    expect(item.text).toBe('$(record) Provenance: recording');
    expect(item.text).not.toContain('not enrolled');
    expect(item.command).toBeUndefined();
  });

  it('registers for disposal', () => {
    const disposables: vscode.Disposable[] = [];
    createRecordingStatusBar(disposables);
    expect(disposables).toHaveLength(1);
  });
});

describe('setEnrollmentState', () => {
  it('states the consequence and makes the item clickable when un-enrolled', () => {
    const item = createRecordingStatusBar([]);
    setEnrollmentState(item, true);

    expect(item.text).toContain('Provenance: recording');
    expect(item.text).toContain('(not enrolled)');
    expect(item.tooltip).toContain(ENROLL_URL);
    expect(item.command).toBe('provenance.showEnrollmentKey');
  });

  it('leaves an enrolled student the inert item they have always had', () => {
    const item = createRecordingStatusBar([]);
    setEnrollmentState(item, false);

    expect(item.text).toBe('$(record) Provenance: recording');
    expect(item.tooltip).toBe('Provenance recorder is active for this assignment.');
    expect(item.command).toBeUndefined();
  });

  it('is idempotent, and reversible when the student enrols mid-flight', () => {
    // rescan() re-renders on every workspace-folder change; importing a token
    // does not restart the extension, so the un-enrolled → enrolled transition
    // must fully clear, command included.
    const item = createRecordingStatusBar([]);
    setEnrollmentState(item, true);
    setEnrollmentState(item, true);
    expect(item.text).toContain('(not enrolled)');

    setEnrollmentState(item, false);
    expect(item.text).not.toContain('not enrolled');
    expect(item.command).toBeUndefined();
  });
});
