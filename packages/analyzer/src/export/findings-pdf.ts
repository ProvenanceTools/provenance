/**
 * findings-pdf.ts — orchestrate the full PDF findings export.
 *
 * PRD §7.5: the PDF includes screenshots of key replay moments for flags of
 * severity >= medium.
 *
 * Orchestration flow:
 *   1. Filter flags to severity >= medium (high + medium).
 *   2. For each qualifying flag, pick its first supporting event's globalIdx.
 *   3. Resolve the file path from the supporting event via the EventIndex.
 *   4. Call screenshotReplayAt (sequential — screenshots are expensive; parallel
 *      would swamp memory per the Phase 19 spec).
 *   5. Build a FlagScreenshot[] mapping flagId → data URL.
 *   6. Call renderPdf with the screenshots and return the jsPDF doc.
 *
 * Progress is reported via a `onProgress` callback so ExportPdfButton can
 * display "N of M screenshots" to the user.
 *
 * This module does not touch the DOM directly (that's screenshot.ts's job).
 * It is tested by mocking screenshotReplayAt.
 */

import type { jsPDF } from 'jspdf';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { ValidationReport } from '@provenance/analysis-core/validation/check-types.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import { renderPdf, pdfFilenameFor } from './pdf-renderer.js';
import type { FlagScreenshot, PdfRenderInput } from './pdf-renderer.js';
import { screenshotReplayAt } from './screenshot.js';
import { buildReconstructionScope } from '@provenance/analysis-core/index/reconstruct-segments.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Progress callback for the screenshot capture loop.
 *
 * `completed` — number of screenshots taken so far (including the current one).
 * `total`     — total number of screenshots to take.
 *
 * Called after each screenshot completes, so the caller can update a progress
 * indicator. Not called before any screenshot is taken.
 */
export type PdfProgressCallback = (completed: number, total: number) => void;

export type GeneratePdfInput = {
  bundle: Bundle;
  index: EventIndex;
  report: ValidationReport;
  flags: Flag[];
  generatedAt: Date;
  bundleSha256?: string;
  /** Called after each screenshot completes. May be undefined (no-op). */
  onProgress?: PdfProgressCallback;
};

export type GeneratePdfResult = {
  doc: jsPDF;
  filename: string;
};

// ---------------------------------------------------------------------------
// Severity filter
// ---------------------------------------------------------------------------

const SCREENSHOT_SEVERITIES = new Set(['high', 'medium']);

function requiresScreenshot(flag: Flag): boolean {
  return SCREENSHOT_SEVERITIES.has(flag.severity);
}

// ---------------------------------------------------------------------------
// Resolve file path for a supporting event
// ---------------------------------------------------------------------------

/**
 * Given a supporting seq key (`${sessionId}:${seq}`), find the file path
 * of the corresponding event in the EventIndex.
 *
 * Returns null if the key is not found or the event has no file attribute.
 */
function resolveFilePath(index: EventIndex, seqKey: string): string | null {
  const event = index.bySeq.get(seqKey);
  return event?.file ?? null;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Generate the full PDF findings report, including screenshots for
 * flags of severity >= medium.
 *
 * Screenshots are taken sequentially to avoid memory pressure. Each
 * screenshot appended to `screenshots[]` before moving to the next flag.
 *
 * @param input  Bundle, index, report, flags, and options.
 * @returns      jsPDF instance and the recommended filename.
 */
export async function generatePdf(input: GeneratePdfInput): Promise<GeneratePdfResult> {
  const { bundle, index, report, flags, generatedAt, bundleSha256, onProgress } = input;
  const scope = buildReconstructionScope(bundle, index);

  // Determine which flags need screenshots and how many.
  const flagsNeedingScreenshot = flags.filter(requiresScreenshot);
  const total = flagsNeedingScreenshot.length;

  const screenshots: FlagScreenshot[] = [];

  for (let i = 0; i < flagsNeedingScreenshot.length; i++) {
    const flag = flagsNeedingScreenshot[i]!;

    // Pick the first supporting event.
    const firstKey = flag.supportingSeqs[0];
    if (firstKey === undefined) {
      // No supporting events — no screenshot for this flag.
      onProgress?.(i + 1, total);
      continue;
    }

    // Resolve file path.
    const filePath = resolveFilePath(index, firstKey);
    if (filePath === null) {
      // Event not found or has no file — skip screenshot.
      onProgress?.(i + 1, total);
      continue;
    }

    // Resolve globalIdx from the index.
    const event = index.bySeq.get(firstKey);
    if (event === undefined) {
      onProgress?.(i + 1, total);
      continue;
    }

    // Take screenshot at globalIdx (exclusive end — snapshot shows state AFTER the event).
    try {
      const dataUrl = await screenshotReplayAt(scope, filePath, event.globalIdx + 1);
      // `null` = no single file state at that position (Tier 2.2). Omit the
      // image; the flag is still rendered, just without a picture of a file
      // that may never have existed.
      if (dataUrl !== null) {
        screenshots.push({
          flagId: flag.id,
          dataUrl,
          label: `${filePath} — event #${event.globalIdx} (seq ${firstKey}) @ ${event.wall}`,
        });
      }
    } catch {
      // Screenshot failed — skip, do not abort the whole export.
      // The flag will be rendered without an image.
    }

    onProgress?.(i + 1, total);
  }

  // Render the PDF with all screenshots collected.
  // Build pdfInput in two steps to satisfy exactOptionalPropertyTypes: only
  // include bundleSha256 when defined (never assign `undefined` to an optional
  // property — same pattern as A50 in the progress notes).
  const pdfInput: PdfRenderInput = {
    bundle,
    report,
    flags,
    screenshots,
    generatedAt,
  };
  if (bundleSha256 !== undefined) {
    pdfInput.bundleSha256 = bundleSha256;
  }

  const doc = renderPdf(pdfInput);
  const filename = pdfFilenameFor(bundle, generatedAt);

  return { doc, filename };
}
