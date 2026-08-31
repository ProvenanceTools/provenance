/**
 * DownloadSnapshot — save the active file exactly as it stood at the playhead.
 *
 * The replay engine has already reconstructed this content client-side, in both
 * the /local and the server-backed mounts, so this component only has to name
 * the bytes and hand them to the browser.
 *
 * ## What it refuses to do
 *
 * A downloaded file outlives the UI that produced it. It carries no banner, no
 * amber notice and no verdict badge — just a filename and some bytes, which a
 * reader will treat as "the student's code". That makes an EMPTY or AMBIGUOUS
 * reconstruction the dangerous case: `reconstructFile` empties `content` on an
 * unrecoverable taint, and a file whose lineage has two provably different
 * contributors (Tier 2.2 `concurrent` / `unknown`) has no single content at all.
 * Saving either one produces a plausible-looking artifact that means nothing.
 * So the button disables itself in both cases and says which one it hit.
 *
 * ## What the filename has to carry
 *
 * The instant, because a snapshot with no timestamp is indistinguishable from
 * the final state, and the whole point is that it is not. It is written in UTC
 * with the trailing `Z` kept: this file gets emailed, and a local-time stamp
 * with no zone is exactly the ambiguity that makes a deadline argument
 * unresolvable. The original extension is preserved so the file still opens as
 * code.
 */

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.js';
import { formatWallTitle } from '@/lib/format.js';

type DownloadSnapshotProps = {
  /** Path of the file on screen, or null when no file is selected. */
  filePath: string | null;
  /** Reconstructed content at the playhead. */
  content: string;
  /** Wall of the event the playhead sits on, if any. */
  wall: string | undefined;
  /**
   * Set when this file has no single content at the playhead — `concurrent`
   * (two provably different contributors on unordered lineages) or `unknown`
   * (the happens-before relation does not reach these events).
   */
  ambiguity: 'concurrent' | 'unknown' | undefined;
};

/**
 * `lab04.py` at 2026-08-31T21:14:07Z → `lab04@2026-08-31T21-14-07Z.py`.
 *
 * Colons are stripped because they are not portable in filenames (and are a
 * path separator in some contexts); the `T` and `Z` stay so the stamp is still
 * readable as an instant rather than a random digit run.
 */
export function snapshotFilename(filePath: string, wall: string | undefined): string {
  const base = filePath.split('/').pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  // A leading dot is the whole name of a dotfile, not an extension.
  const hasExt = dot > 0;
  const stem = hasExt ? base.slice(0, dot) : base;
  const ext = hasExt ? base.slice(dot) : '';

  const parsed = wall === undefined ? NaN : Date.parse(wall);
  const stamp = Number.isNaN(parsed)
    ? 'unknown-time'
    : new Date(parsed)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/:/g, '-');

  return `${stem}@${stamp}${ext}`;
}

/** Why the button is unavailable, or null when it is available. */
export function unavailableReason(
  filePath: string | null,
  content: string,
  ambiguity: 'concurrent' | 'unknown' | undefined,
): string | null {
  if (filePath === null) return 'Select a file to download its state at this point.';
  if (ambiguity === 'concurrent') {
    return 'Two contributors edited this file on lineages the evidence does not order, so there is no single content to save at this point.';
  }
  if (ambiguity === 'unknown') {
    return 'The recorded evidence does not order these edits, so there is no single content to save at this point.';
  }
  if (content === '') {
    return 'The reconstruction is empty at this point — there is nothing to save. An external change or an oversized paste can leave the replay with no content to show.';
  }
  return null;
}

export function DownloadSnapshot({ filePath, content, wall, ambiguity }: DownloadSnapshotProps) {
  const reason = unavailableReason(filePath, content, ambiguity);
  const disabled = reason !== null;
  const filename = filePath === null ? '' : snapshotFilename(filePath, wall);

  const handleDownload = () => {
    if (filePath === null || disabled) return;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const hint =
    reason ??
    `Saves ${filename} — this file as the recording says it stood at ` +
      `${wall === undefined ? 'this point' : formatWallTitle(wall)}. It is reconstructed from ` +
      `the recorded edits, not the bytes the student submitted, and the time is the recording ` +
      `machine's own clock.`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button fires no events, so the tooltip needs a live
              wrapper to hang off — otherwise the reason for the disabling is
              unreachable, which is the one thing worse than the disabling. */}
          <span className="inline-flex" data-testid="download-snapshot-wrap">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7"
              onClick={handleDownload}
              disabled={disabled}
              data-testid="download-snapshot"
              data-filename={filename}
            >
              <Download aria-hidden="true" />
              Download at this point
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
