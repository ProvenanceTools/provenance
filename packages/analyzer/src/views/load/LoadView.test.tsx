/**
 * LoadView tests.
 *
 * Tests:
 * - Drop event triggers the bundle loader.
 * - File picker change event triggers the loader.
 * - On status === 'loaded', navigates to /local/overview (Phase 25: /local prefix).
 * - LoadingPanel displays the current loading stage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { BundleProvider } from '../../context/BundleContext.js';
import { LoadView } from './LoadView.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';

// Wire SHA-512 override so ed25519 works in jsdom.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Helper: wrap LoadView with router and provider
// ---------------------------------------------------------------------------

function renderLoadView(initialEntries = ['/local/load']) {
  const overviewContent = <div data-testid="overview-reached">Overview</div>;

  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <BundleProvider>
        <Routes>
          <Route path="/local/load" element={<LoadView />} />
          <Route path="/local/overview" element={overviewContent} />
        </Routes>
      </BundleProvider>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoadView', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the drop zone', () => {
    renderLoadView();
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    expect(screen.getByTestId('choose-file-btn')).toBeInTheDocument();
    expect(screen.getByTestId('file-input')).toBeInTheDocument();
  });

  it('drop event on the drop zone triggers the loader and navigates to /local/overview', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    renderLoadView();

    const dropZone = screen.getByTestId('drop-zone');

    // Create a synthetic DataTransfer.
    const dataTransfer = {
      files: [file] as unknown as FileList,
    };

    act(() => {
      fireEvent.drop(dropZone, { dataTransfer });
    });

    // Should show loading panel while loading.
    await waitFor(() => {
      expect(screen.queryByTestId('loading-panel')).toBeInTheDocument();
    });

    // After load completes, should navigate to /local/overview.
    await waitFor(
      () => {
        expect(screen.getByTestId('overview-reached')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  it('file picker change event triggers the loader', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 1 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    renderLoadView();

    const fileInput = screen.getByTestId('file-input');

    act(() => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    // Should eventually navigate to /local/overview.
    await waitFor(
      () => {
        expect(screen.getByTestId('overview-reached')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  it('shows LoadingPanel with stage label during loading', async () => {
    // Drop a structurally-valid bundle and assert the panel + its stage label
    // appear together. Previously the stage-label assertion was a synchronous
    // expect AFTER waitFor on the panel — a 5-event bundle could complete
    // loading and navigate to overview between the panel appearing and the
    // second assertion firing, so the label was already gone. Wrapping both
    // checks inside a single waitFor makes them atomic with respect to
    // React's render cycle.
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    renderLoadView();

    act(() => {
      fireEvent.drop(screen.getByTestId('drop-zone'), {
        dataTransfer: { files: [file] as unknown as FileList },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('loading-panel')).toBeInTheDocument();
      expect(screen.getByTestId('loading-stage-label')).toBeInTheDocument();
    });
  });

  it('loads a flat bundle with no scope picker', async () => {
    // The path every existing user takes. Phase A must recognise a flat sealed
    // bundle as not repo-shaped and hand it straight to the unchanged loader.
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    renderLoadView();

    act(() => {
      fireEvent.drop(screen.getByTestId('drop-zone'), {
        dataTransfer: { files: [file] as unknown as FileList },
      });
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('overview-reached')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(screen.queryByTestId('scope-picker')).not.toBeInTheDocument();
  });

  it('shows ErrorPanel on an invalid file drop', async () => {
    const file = new File(['not a zip'], 'bad.zip', { type: 'application/zip' });

    renderLoadView();

    act(() => {
      fireEvent.drop(screen.getByTestId('drop-zone'), {
        dataTransfer: { files: [file] as unknown as FileList },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('error-panel')).toBeInTheDocument();
    });
  });

  it('retrying after error clears the error panel', async () => {
    const badFile = new File(['not a zip'], 'bad.zip', { type: 'application/zip' });

    renderLoadView();

    act(() => {
      fireEvent.drop(screen.getByTestId('drop-zone'), {
        dataTransfer: { files: [badFile] as unknown as FileList },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('error-panel')).toBeInTheDocument();
    });

    // Click "Try a different file" to retry.
    act(() => {
      screen.getByTestId('error-retry-btn').click();
    });

    // Drop zone should reappear.
    await waitFor(() => {
      expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    });
  });
});
