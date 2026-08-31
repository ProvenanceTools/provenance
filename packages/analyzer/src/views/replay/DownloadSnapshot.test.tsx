/**
 * The refusals are the important assertions here. A downloaded file carries no
 * caveat with it, so saving an empty or ambiguous reconstruction produces an
 * artifact that looks like evidence and is not — the exact outcome the disabled
 * states exist to prevent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DownloadSnapshot, snapshotFilename, unavailableReason } from './DownloadSnapshot.js';

const WALL = '2026-08-31T21:14:07.123Z';

describe('snapshotFilename', () => {
  it('stamps the instant before the extension, in UTC', () => {
    expect(snapshotFilename('src/lab04.py', WALL)).toBe('lab04@2026-08-31T21-14-07Z.py');
  });

  it('uses the basename, not the whole path', () => {
    expect(snapshotFilename('a/b/c/main.js', WALL)).toBe('main@2026-08-31T21-14-07Z.js');
  });

  it('handles a file with no extension', () => {
    expect(snapshotFilename('Makefile', WALL)).toBe('Makefile@2026-08-31T21-14-07Z');
  });

  it('treats a dotfile name as a name, not an extension', () => {
    expect(snapshotFilename('.gitignore', WALL)).toBe('.gitignore@2026-08-31T21-14-07Z');
  });

  it('says so rather than inventing a time when the wall is missing or broken', () => {
    expect(snapshotFilename('lab04.py', undefined)).toBe('lab04@unknown-time.py');
    expect(snapshotFilename('lab04.py', 'not-a-date')).toBe('lab04@unknown-time.py');
  });

  it('contains no colons, which are not portable in filenames', () => {
    expect(snapshotFilename('src/lab04.py', WALL)).not.toContain(':');
  });
});

describe('unavailableReason', () => {
  it('is null for an ordinary determinate reconstruction', () => {
    expect(unavailableReason('lab04.py', 'print(1)', undefined)).toBeNull();
  });

  it('refuses when no file is selected', () => {
    expect(unavailableReason(null, 'print(1)', undefined)).toContain('Select a file');
  });

  it('refuses on an empty reconstruction', () => {
    expect(unavailableReason('lab04.py', '', undefined)).toContain('nothing to save');
  });

  it('refuses on concurrent lineages, and names contributors as the reason', () => {
    const r = unavailableReason('lab04.py', 'print(1)', 'concurrent');
    expect(r).toContain('no single content');
    expect(r).toContain('contributors');
  });

  it('refuses on unknown ordering WITHOUT claiming a raced edit', () => {
    // The absence of a record is not two people editing at once; conflating
    // them is how an unwitnessed gap turns into an accusation.
    const r = unavailableReason('lab04.py', 'print(1)', 'unknown');
    expect(r).toContain('does not order');
    expect(r).not.toContain('contributors');
  });
});

describe('DownloadSnapshot', () => {
  let clickSpy: ReturnType<typeof vi.spyOn>;
  let saved: { download: string; href: string }[] = [];

  beforeEach(() => {
    saved = [];
    // jsdom implements neither object URLs nor navigation, so the anchor is
    // observed at the moment it is clicked.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push({ download: this.download, href: this.href });
    });
  });

  afterEach(() => {
    clickSpy.mockRestore();
  });

  it('saves the content under a timestamped filename', () => {
    render(
      <DownloadSnapshot
        filePath="src/lab04.py"
        content="print(1)"
        wall={WALL}
        ambiguity={undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('download-snapshot'));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.download).toBe('lab04@2026-08-31T21-14-07Z.py');
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('leaves no anchor behind in the document', () => {
    render(
      <DownloadSnapshot filePath="lab04.py" content="print(1)" wall={WALL} ambiguity={undefined} />,
    );
    fireEvent.click(screen.getByTestId('download-snapshot'));
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });

  it('is disabled with no file selected', () => {
    render(<DownloadSnapshot filePath={null} content="" wall={WALL} ambiguity={undefined} />);
    expect(screen.getByTestId('download-snapshot')).toBeDisabled();
  });

  it('is disabled on an empty reconstruction', () => {
    render(<DownloadSnapshot filePath="lab04.py" content="" wall={WALL} ambiguity={undefined} />);
    expect(screen.getByTestId('download-snapshot')).toBeDisabled();
  });

  it.each(['concurrent', 'unknown'] as const)('is disabled on %s ambiguity', (kind) => {
    render(
      <DownloadSnapshot filePath="lab04.py" content="print(1)" wall={WALL} ambiguity={kind} />,
    );
    expect(screen.getByTestId('download-snapshot')).toBeDisabled();
  });

  it('writes nothing when clicked while disabled', () => {
    render(<DownloadSnapshot filePath="lab04.py" content="" wall={WALL} ambiguity={undefined} />);
    fireEvent.click(screen.getByTestId('download-snapshot'));
    expect(saved).toHaveLength(0);
  });
});
