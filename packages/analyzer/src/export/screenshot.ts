/**
 * screenshot.ts — capture a static code snapshot for embedding in a PDF.
 *
 * PRD §7.5: the PDF export includes "screenshots of key replay moments."
 *
 * ## Screenshot strategy: static <pre> + CSS (not real Monaco)
 *
 * The Phase 19 spec offered two approaches:
 *
 *   A. Real Monaco off-screen: mount a hidden Monaco instance, apply state +
 *      decorations, capture via html2canvas. Problem: Monaco's tokenizer is
 *      async; html2canvas may capture before highlighting has settled, yielding
 *      an unstyled frame. The <Suspense>-lazy-load timing is also unpredictable
 *      off-screen.
 *
 *   B. Static <pre> + CSS: render the file content in a styled <pre> block with
 *      paste/external-change regions highlighted using inline background-color
 *      styles, then capture via html2canvas. Produces visually equivalent
 *      output for a static PDF (no interaction needed), avoids all race
 *      conditions, and is deterministic.
 *
 * We chose (B). The trade-off: no Monaco syntax highlighting in the screenshot.
 * In a case-file PDF the key visual is the coloring that shows WHERE paste
 * regions / external-change regions are, not the token colors. The static
 * approach delivers that reliably.
 *
 * ## API
 *
 *   screenshotReplayAt(index, filePath, globalIdx): Promise<string>
 *
 * Returns a base64 PNG data URL. Caller (findings-pdf.ts) embeds it via
 * FlagScreenshot into the PDF.
 *
 * ## Dependencies
 *
 * `html2canvas` is dynamically imported (lazy) so it does not bloat the main
 * bundle. The dynamic import is deferred until the first call.
 *
 * ## Test environment
 *
 * jsdom does not support canvas rendering. The function is designed so its
 * pure helper (`buildScreenshotHtml`) is testable without html2canvas, while
 * the DOM-touching outer function is tested via a mock of html2canvas.
 */

import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import {
  determinateValue,
  reconstructFileSegmentedWithProvenance,
  type ReconstructionScope,
} from '@provenance/analysis-core/index/reconstruct-segments.js';
import { runsFromProvenance } from '../views/replay/replay-decoration-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Return type from screenshotReplayAt — a base64 PNG data URL. */
export type DataUrl = string;

// ---------------------------------------------------------------------------
// Build the HTML for the static screenshot
// ---------------------------------------------------------------------------

/**
 * CSS color for each provenance kind. These match the replay UI's
 * globals.css classes (.replay-paste-region, .replay-external-region)
 * so the PDF looks consistent with what the reviewer sees in the replay
 * view.
 */
const KIND_BG: Record<'paste' | 'external_change', string> = {
  paste: 'rgba(251, 146, 60, 0.35)', // orange-400/35%
  external_change: 'rgba(239, 68, 68, 0.35)', // red-500/35%
};

type DecoRange = {
  startOffset: number;
  endOffset: number;
  kind: 'paste' | 'external_change';
};

/**
 * Convert provenance runs (line/column based from runsFromProvenance) back
 * to flat char offsets. We need flat offsets to insert <span> tags into the
 * content string.
 *
 * Pure function; testable.
 */
export function runsToFlatOffsets(
  content: string,
  runs: ReturnType<typeof runsFromProvenance>,
): DecoRange[] {
  if (content.length === 0 || runs.length === 0) return [];

  // Build a line-start offset table.
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x0a /* \n */) {
      lineStarts.push(i + 1);
    }
  }

  const result: DecoRange[] = [];
  for (const run of runs) {
    // Monaco line/col are 1-indexed.
    const lineIdx = run.startLineNumber - 1;
    const startLineOffset = lineStarts[lineIdx] ?? content.length;
    const startOffset = Math.min(startLineOffset + (run.startColumn - 1), content.length);

    const endLineIdx = run.endLineNumber - 1;
    const endLineOffset = lineStarts[endLineIdx] ?? content.length;
    // endColumn in Monaco is inclusive; we want exclusive end offset.
    // For a full line match endColumn = lineLength + 1; we cap at line end.
    const endLineText = content.slice(endLineOffset, lineStarts[endLineIdx + 1] ?? content.length);
    const rawEnd = endLineOffset + Math.min(run.endColumn - 1, endLineText.length);
    const endOffset = Math.min(rawEnd, content.length);

    if (endOffset > startOffset) {
      result.push({ startOffset, endOffset, kind: run.kind });
    }
  }
  return result;
}

/**
 * Build an HTML string for the screenshot container.
 *
 * The output is a self-contained <div> that can be appended to the document
 * body and captured by html2canvas. It renders the file content as a <pre>
 * with inline <span> tags for paste/external-change regions.
 *
 * ## Long line handling
 *
 * Files with lines exceeding ~95 characters (800px at 12px monospace) are
 * wrapped using `white-space:pre-wrap` to prevent silent clipping. The outer
 * div does not clip overflow; html2canvas captures the rendered size naturally.
 *
 * Pure function; testable without DOM.
 *
 * @param content   File content string.
 * @param ranges    Sorted, non-overlapping decoration ranges (flat offsets).
 * @param filePath  File path for the caption header.
 * @param globalIdx Global event index shown in the caption.
 */
export function buildScreenshotHtml(
  content: string,
  ranges: DecoRange[],
  filePath: string,
  globalIdx: number,
): string {
  // Build the <pre> content by inserting <span> tags around decorated regions.
  // We assume ranges are non-overlapping and sorted by startOffset.
  let html = '';
  let pos = 0;

  for (const range of ranges) {
    // Text before this range (plain).
    if (pos < range.startOffset) {
      html += escapeHtml(content.slice(pos, range.startOffset));
    }
    const bg = KIND_BG[range.kind];
    html += `<span style="background-color:${bg};">`;
    html += escapeHtml(content.slice(range.startOffset, range.endOffset));
    html += `</span>`;
    pos = range.endOffset;
  }
  // Remaining text after the last range.
  if (pos < content.length) {
    html += escapeHtml(content.slice(pos));
  }

  // Sanitize file path for HTML display (never contains < > based on OS
  // conventions, but be safe).
  const safeFilePath = escapeHtml(filePath);

  return `
<div style="
  background:#1e1e1e;
  color:#d4d4d4;
  font-family:'Courier New',Courier,monospace;
  font-size:12px;
  line-height:1.5;
  padding:12px 16px;
  width:800px;
  box-sizing:border-box;
  overflow:visible;
">
  <div style="
    color:#9cdcfe;
    font-size:11px;
    margin-bottom:8px;
    border-bottom:1px solid #3c3c3c;
    padding-bottom:6px;
  ">
    ${safeFilePath} — event #${globalIdx}
  </div>
  <pre style="
    margin:0;
    white-space:pre-wrap;
    color:#d4d4d4;
  ">${html}</pre>
</div>`.trim();
}

// ---------------------------------------------------------------------------
// html2canvas wrapper (lazy-loaded)
// ---------------------------------------------------------------------------

/**
 * Capture a DOM element to a PNG data URL using html2canvas.
 *
 * Dynamically imports html2canvas to avoid bloating the main bundle. The
 * `scale: 2` option produces a 2× DPI image for crisp PDF rendering
 * (Phase 19 spec: "2x device pixel ratio").
 *
 * Exported separately for mocking in tests.
 */
export async function captureElement(element: HTMLElement): Promise<string> {
  // Dynamic import so html2canvas is not in the main bundle.
  const { default: html2canvas } = await import('html2canvas');
  const canvas = await html2canvas(element, {
    scale: 2,
    backgroundColor: '#1e1e1e',
    logging: false,
    useCORS: false,
  });
  return canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Capture a static code screenshot at a given replay moment.
 *
 * Strategy:
 *   1. Reconstruct file content + provenance at `globalIdx` using
 *      `reconstructFileWithProvenance`.
 *   2. Convert provenance runs to flat character offsets.
 *   3. Build a self-contained HTML string (<pre> + inline <span> for
 *      paste/external-change regions).
 *   4. Mount the HTML in a hidden off-screen div (position:fixed; left:-9999px).
 *   5. Capture via html2canvas at 2× scale.
 *   6. Remove the div and return the data URL.
 *
 * Returns `null` when reconstruction has no single truth at that position —
 * two contributors' edits unordered, or events the happens-before relation does
 * not cover (Tier 2.2). This is the highest-consequence display site in the
 * product: the image is captioned with a file and an event number and embedded
 * in a findings PDF that leaves the tool and reaches an integrity panel. A
 * screenshot of one arbitrarily chosen branch would be a picture of a file that
 * never existed, presented as photographic evidence against a named student.
 * The caller omits the image rather than showing a guess.
 *
 * @param scope     Reconstruction scope for the bundle (see `reconstruct-segments`).
 * @param filePath  Which file to snapshot.
 * @param globalIdx Snapshot at this event position (exclusive — same semantics
 *                  as `upToGlobalIdx` in reconstructFileWithProvenance).
 * @returns         Promise<DataUrl | null> — base64 PNG data URL, or null.
 */
export async function screenshotReplayAt(
  scope: ReconstructionScope,
  filePath: string,
  globalIdx: number,
): Promise<DataUrl | null> {
  // Reconstruct file state at globalIdx.
  const fileState = determinateValue(
    reconstructFileSegmentedWithProvenance(scope, filePath, globalIdx),
  );
  if (fileState === null) return null;

  // Convert provenance runs to flat offsets for HTML building.
  const runs = runsFromProvenance(fileState);
  const ranges = runsToFlatOffsets(fileState.content, runs);

  // Build the HTML string.
  const html = buildScreenshotHtml(fileState.content, ranges, filePath, globalIdx);

  // Mount off-screen. Position fixed + large negative left keeps it out of
  // the visible viewport while still being in the document (html2canvas
  // requires the element to be in the document).
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-1;';
  container.innerHTML = html;
  document.body.appendChild(container);

  const target = container.firstElementChild as HTMLElement;

  try {
    const dataUrl = await captureElement(target);
    return dataUrl;
  } finally {
    container.remove();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape HTML special characters for safe embedding in HTML content.
 * Covers the four characters that matter in a <pre> context.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
