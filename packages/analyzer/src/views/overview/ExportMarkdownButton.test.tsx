/**
 * ExportMarkdownButton tests.
 *
 * - Disabled when no bundle is loaded.
 * - When clicked with a loaded bundle, triggers a download whose filename
 *   includes the assignment id and a timestamp.
 *
 * The pure renderer is covered by findings-markdown.test.ts; here we only
 * verify wiring: bundle/report/flags from context → renderFindings → blob →
 * downloadAs(filename, blob).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportMarkdownButton } from './ExportMarkdownButton.js';
import type { BundleContextValue } from '../../context/BundleContext.js';
import {
  makeMinimalBundle,
  makeMinimalIndex,
  fixtureReport,
  fixtureFlags,
} from './test-fixtures.js';

// ---------------------------------------------------------------------------
// Mock the BundleContext consumer
// ---------------------------------------------------------------------------

let mockValue: BundleContextValue;

vi.mock('@/context/BundleContext.js', () => ({
  useBundle: () => mockValue,
}));

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
// URL.createObjectURL / revokeObjectURL stubs (jsdom doesn't implement them)
// ---------------------------------------------------------------------------

const createdUrls: string[] = [];
const revokedUrls: string[] = [];
let urlCounter = 0;

beforeEach(() => {
  createdUrls.length = 0;
  revokedUrls.length = 0;
  urlCounter = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (_b: Blob) => {
    const u = `blob:fake-${++urlCounter}`;
    createdUrls.push(u);
    return u;
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u: string) => {
    revokedUrls.push(u);
  };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // The "clicking triggers a download" test spies on document.createElement;
  // restore so the spy doesn't leak into subsequent tests in this file (or
  // any later-added tests that expect a real anchor element).
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExportMarkdownButton', () => {
  it('is disabled when status is idle', () => {
    mockValue = defaultEmptyValue();
    render(<ExportMarkdownButton />);
    expect(screen.getByTestId('btn-export-findings')).toBeDisabled();
  });

  it('is disabled when status is loading', () => {
    mockValue = { ...defaultEmptyValue(), status: 'loading', loadingStage: 'unzip' };
    render(<ExportMarkdownButton />);
    expect(screen.getByTestId('btn-export-findings')).toBeDisabled();
  });

  it('is enabled when a bundle is loaded', () => {
    mockValue = loadedValue();
    render(<ExportMarkdownButton />);
    expect(screen.getByTestId('btn-export-findings')).not.toBeDisabled();
  });

  it('clicking triggers a download with an assignment-id + timestamp filename', () => {
    mockValue = loadedValue();
    const clickSpy = vi.fn();
    // Intercept <a>.click() before the component creates one.
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag.toLowerCase() === 'a') {
        (el as HTMLAnchorElement).click = clickSpy;
      }
      return el;
    });

    render(<ExportMarkdownButton />);
    const btn = screen.getByTestId('btn-export-findings');

    fireEvent.click(btn);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(createdUrls.length).toBe(1);

    // Filename was set on the anchor; capture it.
    const lastAnchorCall = (
      document.createElement as unknown as {
        mock: { results: Array<{ value: HTMLAnchorElement }> };
      }
    ).mock.results
      .map((r) => r.value)
      .filter((v): v is HTMLAnchorElement => v instanceof HTMLAnchorElement)
      .pop();
    expect(lastAnchorCall).toBeDefined();
    expect(lastAnchorCall?.download).toMatch(/^findings-hw1-\d{8}-\d{6}\.md$/);

    // Revoke runs on a deferred timer.
    vi.runAllTimers();
    expect(revokedUrls).toEqual(createdUrls);
  });
});
