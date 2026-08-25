/**
 * Tests for ContributorRibbons.tsx.
 *
 * Covers the geometry math (shared with the seam ticks), the idle-vs-active
 * distinction, the one-event-run minimum width, the overlap band's wording
 * (and its pluralisation), the `sliderMax <= 0` guard, and non-collision with
 * `seam-tick-*` testids.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContributorRibbons, type RibbonRow } from './ContributorRibbons.js';
import type { ActivityRun, OverlapInterval } from './contributor-activity.js';

function run(
  contributorKey: string,
  startGlobalIdx: number,
  endGlobalIdx: number,
  idle = false,
): ActivityRun {
  return { contributorKey, startGlobalIdx, endGlobalIdx, idle };
}

function row(key: string, runs: ActivityRun[], overrides: Partial<RibbonRow> = {}): RibbonRow {
  return {
    key,
    label: key,
    hue: 'rgba(59, 130, 246, 0.9)',
    soft: 'rgba(59, 130, 246, 0.16)',
    runs,
    ...overrides,
  };
}

function overlap(
  startGlobalIdx: number,
  endGlobalIdx: number,
  contributorKeys: readonly string[],
): OverlapInterval {
  return { startGlobalIdx, endGlobalIdx, contributorKeys };
}

describe('ContributorRibbons — the sliderMax <= 0 guard', () => {
  it('renders nothing when sliderMax is 0', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', [run('alice', 0, 0)])]}
        overlaps={[]}
        sliderMax={0}
      />,
    );
    expect(screen.queryByTestId('contributor-ribbons')).not.toBeInTheDocument();
  });

  it('renders nothing when sliderMax is negative', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', [run('alice', 0, 0)])]}
        overlaps={[]}
        sliderMax={-1}
      />,
    );
    expect(screen.queryByTestId('contributor-ribbons')).not.toBeInTheDocument();
  });
});

describe('ContributorRibbons — rows and geometry', () => {
  it('renders one row per RibbonRow, keyed by contributor', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', [run('alice', 0, 5)]), row('bob', [run('bob', 6, 10)])]}
        overlaps={[]}
        sliderMax={20}
      />,
    );
    expect(screen.getByTestId('ribbon-row-alice')).toBeInTheDocument();
    expect(screen.getByTestId('ribbon-row-bob')).toBeInTheDocument();
  });

  it('positions a run with the same left%/width% math as the seam ticks', () => {
    // sliderMax 20: start 5 -> 25%, span 5..15 -> width 50%.
    render(
      <ContributorRibbons
        rows={[row('alice', [run('alice', 5, 15)])]}
        overlaps={[]}
        sliderMax={20}
      />,
    );
    const el = screen.getByTestId('ribbon-run-alice-5');
    expect(el).toHaveStyle({ left: '25%', width: '50%' });
  });

  it('renders an active run with the row hue', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', [run('alice', 0, 5, false)])]}
        overlaps={[]}
        sliderMax={10}
      />,
    );
    expect(screen.getByTestId('ribbon-run-alice-0')).toHaveStyle({
      backgroundColor: 'rgba(59, 130, 246, 0.9)',
    });
  });

  it('renders an idle run fainter, with the row soft colour instead of hue', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', [run('alice', 0, 5, true)])]}
        overlaps={[]}
        sliderMax={10}
      />,
    );
    expect(screen.getByTestId('ribbon-run-alice-0')).toHaveStyle({
      backgroundColor: 'rgba(59, 130, 246, 0.16)',
    });
  });

  it('gives a one-event-wide run (start === end, 0% computed width) a visible minimum width', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', [run('alice', 7, 7)])]}
        overlaps={[]}
        sliderMax={20}
      />,
    );
    const el = screen.getByTestId('ribbon-run-alice-7');
    expect(el).toHaveStyle({ width: '0%', minWidth: '3px' });
  });

  it('renders a blank row (no spans) for a contributor with no runs', () => {
    render(<ContributorRibbons rows={[row('alice', [])]} overlaps={[]} sliderMax={10} />);
    const rowEl = screen.getByTestId('ribbon-row-alice');
    expect(rowEl.querySelectorAll('[data-testid^="ribbon-run-"]')).toHaveLength(0);
  });
});

describe('ContributorRibbons — overlap band wording', () => {
  it('labels a two-contributor overlap "both recording", never "unordered"/"concurrent"/"conflict"', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', []), row('bob', [])]}
        overlaps={[overlap(2, 8, ['alice', 'bob'])]}
        sliderMax={20}
      />,
    );
    const band = screen.getByTestId('ribbon-overlap-2');
    expect(band).toHaveAttribute('title', 'both recording');
    expect(band.getAttribute('title')).not.toMatch(/unordered|concurrent|conflict/i);
  });

  it('labels a three-or-more-contributor overlap "N recording"', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', []), row('bob', []), row('carol', [])]}
        overlaps={[overlap(3, 9, ['alice', 'bob', 'carol'])]}
        sliderMax={20}
      />,
    );
    expect(screen.getByTestId('ribbon-overlap-3')).toHaveAttribute('title', '3 recording');
  });

  it('positions the overlap band with the same index-space math as runs', () => {
    // sliderMax 20: start 4 -> 20%, span 4..14 -> width 50%.
    render(
      <ContributorRibbons
        rows={[row('alice', []), row('bob', [])]}
        overlaps={[overlap(4, 14, ['alice', 'bob'])]}
        sliderMax={20}
      />,
    );
    expect(screen.getByTestId('ribbon-overlap-4')).toHaveStyle({ left: '20%', width: '50%' });
  });

  it('gives a one-index-wide overlap a visible minimum width too', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', []), row('bob', [])]}
        overlaps={[overlap(6, 6, ['alice', 'bob'])]}
        sliderMax={20}
      />,
    );
    expect(screen.getByTestId('ribbon-overlap-6')).toHaveStyle({ width: '0%', minWidth: '3px' });
  });

  it('renders no overlap band when there is no overlap', () => {
    render(<ContributorRibbons rows={[row('alice', [])]} overlaps={[]} sliderMax={20} />);
    expect(screen.queryAllByTestId(/^ribbon-overlap-/)).toHaveLength(0);
  });
});

describe('ContributorRibbons — accessibility and testid isolation', () => {
  it('gives the container a meaningful, non-empty aria-label', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', [], { label: 'Alice' }), row('bob', [], { label: 'Bob' })]}
        overlaps={[]}
        sliderMax={20}
      />,
    );
    const container = screen.getByTestId('contributor-ribbons');
    const label = container.getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(label).toContain('Alice');
    expect(label).toContain('Bob');
  });

  it('marks run spans and the overlap band aria-hidden and pointer-events-none', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', [run('alice', 0, 5)])]}
        overlaps={[overlap(0, 5, ['alice', 'bob'])]}
        sliderMax={20}
      />,
    );
    const runEl = screen.getByTestId('ribbon-run-alice-0');
    expect(runEl).toHaveAttribute('aria-hidden', 'true');
    expect(runEl).toHaveClass('pointer-events-none');

    const overlapEl = screen.getByTestId('ribbon-overlap-0');
    expect(overlapEl).toHaveAttribute('aria-hidden', 'true');
    expect(overlapEl).toHaveClass('pointer-events-none');
  });

  it('never produces a seam-tick-* testid', () => {
    render(
      <ContributorRibbons
        rows={[row('alice', [run('alice', 0, 5)])]}
        overlaps={[overlap(0, 5, ['alice', 'bob'])]}
        sliderMax={20}
      />,
    );
    expect(screen.queryAllByTestId(/^seam-tick-/)).toHaveLength(0);
  });
});
