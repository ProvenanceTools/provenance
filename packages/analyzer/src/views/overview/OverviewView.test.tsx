/**
 * OverviewView tests.
 *
 * Tests:
 * - Full render with all panels present.
 * - Early return (null) when index is null.
 * - Early return (null) when validationReport is null.
 * - Early return (null) when bundles is empty.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OverviewView } from './OverviewView.js';
import {
  fixtureReport,
  fixtureFlags,
  makeMinimalIndex,
  makeMinimalBundle,
} from './test-fixtures.js';

// ---------------------------------------------------------------------------
// Mock BundleContext
// ---------------------------------------------------------------------------

const mockUseBundle = vi.fn();

vi.mock('../../context/BundleContext.js', () => ({
  useBundle: () => mockUseBundle(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderView() {
  render(
    <MemoryRouter>
      <OverviewView />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OverviewView', () => {
  beforeEach(() => {
    mockUseBundle.mockReset();
  });

  it('renders all panels when fully loaded', () => {
    mockUseBundle.mockReturnValue({
      bundles: [makeMinimalBundle()],
      index: makeMinimalIndex(),
      validationReport: fixtureReport,
      flags: fixtureFlags,
    });

    renderView();

    expect(screen.getByTestId('overview-view')).toBeInTheDocument();
    expect(screen.getByTestId('overview-actions')).toBeInTheDocument();
    expect(screen.getByTestId('validation-report-panel')).toBeInTheDocument();
    expect(screen.getByTestId('summary-stats-panel')).toBeInTheDocument();
    expect(screen.getByTestId('flag-dashboard-panel')).toBeInTheDocument();
  });

  /**
   * `/local` has no server, so it runs the coverage stage in the browser. The
   * panel now takes the computed aggregate rather than a `Bundle`, and the
   * failure mode of that change is silent: passing `null` here would still
   * render a panel, just one saying "the server did not send them" — which is a
   * lie on a route that has no server and holds the bundle itself.
   */
  it('computes real coverage facts for /local, never "not available"', () => {
    mockUseBundle.mockReturnValue({
      bundles: [makeMinimalBundle()],
      index: makeMinimalIndex(),
      validationReport: fixtureReport,
      flags: fixtureFlags,
    });

    renderView();

    expect(screen.getByTestId('submission-coverage-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-not-available')).toBeNull();
  });

  it('renders nothing when index is null', () => {
    mockUseBundle.mockReturnValue({
      bundles: [makeMinimalBundle()],
      index: null,
      validationReport: fixtureReport,
      flags: [],
    });

    renderView();
    expect(screen.queryByTestId('overview-view')).not.toBeInTheDocument();
  });

  it('renders nothing when validationReport is null', () => {
    mockUseBundle.mockReturnValue({
      bundles: [makeMinimalBundle()],
      index: makeMinimalIndex(),
      validationReport: null,
      flags: [],
    });

    renderView();
    expect(screen.queryByTestId('overview-view')).not.toBeInTheDocument();
  });

  it('renders nothing when bundles is empty', () => {
    mockUseBundle.mockReturnValue({
      bundles: [],
      index: makeMinimalIndex(),
      validationReport: fixtureReport,
      flags: [],
    });

    renderView();
    expect(screen.queryByTestId('overview-view')).not.toBeInTheDocument();
  });

  it('renders with zero flags (no-flags message)', () => {
    mockUseBundle.mockReturnValue({
      bundles: [makeMinimalBundle()],
      index: makeMinimalIndex(),
      validationReport: fixtureReport,
      flags: [],
    });

    renderView();
    expect(screen.getByTestId('no-flags-message')).toBeInTheDocument();
  });

  it('renders the correct assignment id from the bundle manifest', () => {
    mockUseBundle.mockReturnValue({
      bundles: [makeMinimalBundle()],
      index: makeMinimalIndex(),
      validationReport: fixtureReport,
      flags: fixtureFlags,
    });

    renderView();
    expect(screen.getByTestId('stat-assignment').textContent).toBe('hw1');
  });

  it('summarizes the bundle matching selectedBundleId, not always bundles[0]', () => {
    const first = makeMinimalBundle();
    const second: typeof first = {
      ...first,
      id: 'bundle-2',
      manifest: { ...first.manifest, assignment_id: 'hw2' },
    };
    mockUseBundle.mockReturnValue({
      bundles: [first, second],
      selectedBundleId: 'bundle-2',
      index: makeMinimalIndex(),
      validationReport: fixtureReport,
      flags: fixtureFlags,
    });

    renderView();
    // Without the selectedBundleId fix this would read the first bundle → 'hw1'.
    expect(screen.getByTestId('stat-assignment').textContent).toBe('hw2');
  });
});
