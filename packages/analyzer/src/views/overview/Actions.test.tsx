/**
 * Actions tests.
 *
 * Tests:
 * - "View Replay" button: disabled when no bundle, enabled when loaded,
 *   navigates to /replay/<first-session-id>.
 * - "Open Raw Timeline" button navigates to /timeline.
 * - "Export Findings (Markdown)" button is present.
 * - Export button is disabled when no bundle is loaded.
 *
 * Export-button click behavior (download trigger) is covered separately
 * in ExportMarkdownButton.test.tsx.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Actions } from './Actions.js';
import type { BundleContextValue } from '../../context/BundleContext.js';
import {
  makeMinimalBundle,
  makeMinimalIndex,
  fixtureReport,
  fixtureFlags,
} from './test-fixtures.js';

// ---------------------------------------------------------------------------
// Mock the BundleContext consumer so we can drive the bundle state directly.
// ---------------------------------------------------------------------------

let mockValue: BundleContextValue;

vi.mock('@/context/BundleContext.js', () => ({
  useBundle: () => mockValue,
  // BundleProvider is still imported by other modules but Actions only
  // consumes useBundle(); provide a passthrough to keep imports valid.
  BundleProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function emptyValue(): BundleContextValue {
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
    pendingScopes: null,
    beginLoad: async () => {},
    chooseScopes: async () => {},
    cancelChoice: () => {},
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
    pendingScopes: null,
    beginLoad: async () => {},
    chooseScopes: async () => {},
    cancelChoice: () => {},
    clearBundle: () => {},
  };
}

function LocationCapture({ onLocation }: { onLocation: (l: string) => void }) {
  const loc = useLocation();
  onLocation(loc.pathname + loc.search);
  return null;
}

function renderActions() {
  let lastLocation = '';
  render(
    <MemoryRouter initialEntries={['/overview']}>
      <Routes>
        <Route path="/overview" element={<Actions />} />
        <Route path="/timeline" element={<div data-testid="timeline-page" />} />
        <Route path="/replay/:sessionId" element={<div data-testid="replay-page" />} />
      </Routes>
      <LocationCapture
        onLocation={(l) => {
          lastLocation = l;
        }}
      />
    </MemoryRouter>,
  );
  return { getLocation: () => lastLocation };
}

describe('Actions', () => {
  it('renders the actions bar', () => {
    mockValue = emptyValue();
    renderActions();
    expect(screen.getByTestId('overview-actions')).toBeInTheDocument();
  });

  it('Open Raw Timeline button is present', () => {
    mockValue = emptyValue();
    renderActions();
    expect(screen.getByTestId('btn-open-timeline')).toBeInTheDocument();
  });

  it('clicking Open Raw Timeline navigates to /local/timeline', () => {
    mockValue = emptyValue();
    const { getLocation } = renderActions();
    fireEvent.click(screen.getByTestId('btn-open-timeline'));
    expect(getLocation()).toBe('/local/timeline');
  });

  it('View Replay button is present', () => {
    mockValue = emptyValue();
    renderActions();
    expect(screen.getByTestId('btn-view-replay')).toBeInTheDocument();
  });

  it('View Replay button is disabled when no bundle is loaded', () => {
    mockValue = emptyValue();
    renderActions();
    expect(screen.getByTestId('btn-view-replay')).toBeDisabled();
  });

  it('View Replay button is enabled when a bundle is loaded', () => {
    mockValue = loadedValue();
    renderActions();
    expect(screen.getByTestId('btn-view-replay')).not.toBeDisabled();
  });

  it('clicking View Replay navigates to /local/replay/<first-session-id>', () => {
    mockValue = loadedValue();
    const { getLocation } = renderActions();
    fireEvent.click(screen.getByTestId('btn-view-replay'));
    // makeMinimalBundle()'s first session has sessionId 'abc'.
    expect(getLocation()).toBe('/local/replay/abc');
  });

  it('Export Findings (Markdown) button is present', () => {
    mockValue = emptyValue();
    renderActions();
    expect(screen.getByTestId('btn-export-findings')).toBeInTheDocument();
  });

  it('Export Findings (Markdown) button is disabled when no bundle is loaded', () => {
    mockValue = emptyValue();
    renderActions();
    const btn = screen.getByTestId('btn-export-findings');
    expect(btn).toBeDisabled();
  });
});
