/**
 * ExportPdfButton tests.
 *
 * - Disabled when no bundle is loaded.
 * - Enabled when a bundle is loaded.
 * - Shows progress text while exporting.
 * - Triggers a download on click.
 *
 * The PDF generation itself is mocked so we only verify the wiring and UI
 * state transitions. generatePdf, download.ts, and the underlying orchestrator
 * are each covered by their own test files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ExportPdfButton } from './ExportPdfButton.js';
import type { BundleContextValue } from '../../context/BundleContext.js';
import {
  makeMinimalBundle,
  makeMinimalIndex,
  fixtureReport,
  fixtureFlags,
} from './test-fixtures.js';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

// Mock generatePdf to avoid DOM/html2canvas.
vi.mock('@/export/findings-pdf.js', () => ({
  generatePdf: vi.fn().mockResolvedValue({
    doc: {
      output: vi.fn().mockReturnValue(new Blob(['%PDF-fake'], { type: 'application/pdf' })),
    },
    filename: 'findings-hw1-20260519-120000.pdf',
  }),
}));

// Mock downloadAs to avoid jsdom Blob URL limitations in this test.
vi.mock('@/export/download.js', () => ({
  downloadAs: vi.fn(),
}));

// Mock BundleContext.
let mockValue: BundleContextValue;
vi.mock('@/context/BundleContext.js', () => ({
  useBundle: () => mockValue,
}));

// ---------------------------------------------------------------------------
// Context fixtures
// ---------------------------------------------------------------------------

function defaultEmptyValue(): BundleContextValue {
  return {
    bundles: [],
    selectedBundleId: null,
    selectBundle: () => {},
    indicesByBundle: new Map(),
    validationReportByBundle: new Map(),
    flagsByBundle: new Map(),
    index: null,
    validationReport: null,
    flags: [],
    crossFlags: [],
    crossScopeExclusions: [],
    status: 'idle',
    loadingStage: null,
    loadError: null,
    partialLoadErrors: [],
    loadBundleFile: async () => {},
    loadBundleFiles: async () => {},
    clearBundle: () => {},
  };
}

function loadedValue(): BundleContextValue {
  const bundle = makeMinimalBundle();
  const idx = makeMinimalIndex();
  return {
    bundles: [bundle],
    selectedBundleId: bundle.id,
    selectBundle: () => {},
    indicesByBundle: new Map([[bundle.id, idx]]),
    validationReportByBundle: new Map([[bundle.id, fixtureReport]]),
    flagsByBundle: new Map([[bundle.id, fixtureFlags]]),
    index: idx,
    validationReport: fixtureReport,
    flags: fixtureFlags,
    crossFlags: [],
    crossScopeExclusions: [],
    status: 'loaded',
    loadingStage: null,
    loadError: null,
    partialLoadErrors: [],
    loadBundleFile: async () => {},
    loadBundleFiles: async () => {},
    clearBundle: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExportPdfButton', () => {
  it('is disabled when status is idle', () => {
    mockValue = defaultEmptyValue();
    render(<ExportPdfButton />);
    expect(screen.getByTestId('btn-export-pdf')).toBeDisabled();
  });

  it('is disabled when status is loading', () => {
    mockValue = { ...defaultEmptyValue(), status: 'loading', loadingStage: 'unzip' };
    render(<ExportPdfButton />);
    expect(screen.getByTestId('btn-export-pdf')).toBeDisabled();
  });

  it('is enabled when a bundle is loaded', () => {
    mockValue = loadedValue();
    render(<ExportPdfButton />);
    expect(screen.getByTestId('btn-export-pdf')).not.toBeDisabled();
  });

  it('shows default label when idle', () => {
    mockValue = loadedValue();
    render(<ExportPdfButton />);
    expect(screen.getByTestId('btn-export-pdf')).toHaveTextContent('Export Findings (PDF)');
  });

  it('becomes disabled during export and shows progress label', async () => {
    mockValue = loadedValue();

    // Make generatePdf pause so we can observe the in-progress state.
    let resolveExport!: () => void;
    const { generatePdf } = await import('@/export/findings-pdf.js');
    vi.mocked(generatePdf).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveExport = () =>
            resolve({
              doc: { output: () => new Blob(['%PDF'], { type: 'application/pdf' }) },
              filename: 'findings-hw1.pdf',
            } as unknown as Awaited<ReturnType<typeof generatePdf>>);
        }),
    );

    render(<ExportPdfButton />);
    const btn = screen.getByTestId('btn-export-pdf');

    await act(async () => {
      fireEvent.click(btn);
    });

    // During export: disabled + "Preparing PDF…"
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Preparing PDF');

    // Complete the export.
    await act(async () => {
      resolveExport();
    });

    await waitFor(() => {
      expect(btn).not.toBeDisabled();
      expect(btn).toHaveTextContent('Export Findings (PDF)');
    });
  });

  it('triggers a download on successful export', async () => {
    mockValue = loadedValue();
    const { downloadAs } = await import('@/export/download.js');
    render(<ExportPdfButton />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-export-pdf'));
    });

    await waitFor(() => {
      expect(downloadAs).toHaveBeenCalledTimes(1);
    });
  });
});
