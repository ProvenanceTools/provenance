import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ImpactDetailsDialog, formatDelta, histogramRows } from './ImpactDetailsDialog.js';
import type { DryRunDiffBody, TopMover } from './tuning-model.js';
import { makeSoloContributor } from '../../test/msw-handlers.js';

const NO_SCORE = {
  score_total: 0,
  score_max_severity: 'info' as const,
  flag_counts: { info: 0, low: 0, medium: 0, high: 0 },
};

function mover(n: number, name: string, old_score: number, new_score: number): TopMover {
  return {
    submission_id: `aa000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    student: { sid: `30300${n}`, display_name: name },
    contributors: [
      makeSoloContributor(
        {
          id: `30000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
          sid: `30300${n}`,
          display_name: name,
        },
        NO_SCORE,
      ),
    ],
    assignment: { assignment_id_str: `hw${n}`, label: null },
    old_score,
    new_score,
    old_tier: null,
    new_tier: null,
  };
}

function diff(movers: TopMover[]): DryRunDiffBody {
  return {
    submissions_with_tier_change: 3,
    top_movers: movers,
    score_histogram_old: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    score_histogram_new: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11],
    score_histogram_upper_bound: 50,
  };
}

describe('ImpactDetailsDialog', () => {
  it('lists only movers whose score changes, with signed deltas', () => {
    render(
      <ImpactDetailsDialog
        open
        onOpenChange={() => {}}
        diff={diff([mover(1, 'Alice', 3, 5), mover(2, 'Bob', 4, 2.5), mover(3, 'Carol', 0, 0)])}
      />,
    );
    const table = screen.getByTestId('top-movers');
    expect(within(table).getAllByTestId('top-mover-row')).toHaveLength(2);
    expect(within(table).getByText('+2.0')).toHaveClass('text-red-700');
    expect(within(table).getByText('−1.5')).toHaveClass('text-emerald-700');
    expect(within(table).queryByText('Carol')).not.toBeInTheDocument();
    expect(screen.getByTestId('score-histogram')).toBeInTheDocument();
    expect(screen.getByText(/3 submissions change tier/)).toBeInTheDocument();
  });

  it('shows an empty state when no listed mover changes', () => {
    render(<ImpactDetailsDialog open onOpenChange={() => {}} diff={diff([mover(1, 'A', 0, 0)])} />);
    expect(screen.queryByTestId('top-movers')).not.toBeInTheDocument();
    expect(screen.getByTestId('top-movers-empty')).toHaveTextContent(
      /no submission's score changes/i,
    );
  });

  it('renders nothing while closed', () => {
    render(<ImpactDetailsDialog open={false} onOpenChange={() => {}} diff={diff([])} />);
    expect(screen.queryByTestId('impact-details')).not.toBeInTheDocument();
  });

  it('labels histogram buckets by score range', () => {
    const rows = histogramRows(diff([]));
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual({ bucket: '0.0–5.0', before: 1, after: 1 });
    expect(rows[9]).toEqual({ bucket: '45.0–50.0', before: 10, after: 11 });
  });

  it('formats small deltas with two decimals so they never read as zero', () => {
    expect(formatDelta(0.03)).toBe('+0.03');
    expect(formatDelta(-1.26)).toBe('−1.3');
  });
});
