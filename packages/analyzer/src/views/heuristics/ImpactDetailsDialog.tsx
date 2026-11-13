/**
 * ImpactDetailsDialog — the dry-run's full result for the Tuning page.
 *
 * Opened from the footer's [Details] button. Shows the before/after score
 * histogram and the top movers whose score actually changes (the server also
 * lists submissions that move 0.0 → 0.0, which say nothing).
 */

import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, Label } from 'recharts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/layout/Page';
import { cn } from '@/lib/utils';
import { contributorsLabel, personLabel } from '../../lib/contributor-display.js';
import { changedMovers, type DryRunDiffBody } from './tuning-model.js';

/**
 * Histogram rows for recharts. Each bucket label is its score range "lo–hi"
 * using the server-provided upper bound so users can read the X axis as
 * actual score values instead of opaque bucket indices.
 */
export function histogramRows(diff: DryRunDiffBody) {
  const upper = diff.score_histogram_upper_bound;
  const width = upper / diff.score_histogram_old.length;
  const fmt = (n: number) =>
    width >= 10 ? n.toFixed(0) : width >= 1 ? n.toFixed(1) : n.toFixed(2);
  return diff.score_histogram_old.map((old, i) => ({
    bucket: `${fmt(i * width)}–${fmt((i + 1) * width)}`,
    before: old,
    after: diff.score_histogram_new[i] ?? 0,
  }));
}

/** Signed Δ. Two decimals below 0.05 so a small real move never reads as "+0.0". */
export function formatDelta(delta: number): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const abs = Math.abs(delta);
  return `${sign}${abs < 0.05 ? abs.toFixed(2) : abs.toFixed(1)}`;
}

export function ImpactDetailsDialog({
  open,
  onOpenChange,
  diff,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diff: DryRunDiffBody;
}) {
  const movers = changedMovers(diff.top_movers);
  const tier = diff.submissions_with_tier_change;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] max-w-4xl overflow-y-auto"
        data-testid="impact-details"
      >
        <DialogHeader>
          <DialogTitle>Impact of unsaved changes</DialogTitle>
          <DialogDescription>
            {tier} {tier === 1 ? 'submission changes' : 'submissions change'} tier under the
            proposed weights. Nothing is saved until you choose Save &amp; recompute.
          </DialogDescription>
        </DialogHeader>

        <section data-testid="score-histogram" className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-900">Score distribution</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={histogramRows(diff)}
              margin={{ top: 5, right: 10, left: 10, bottom: 28 }}
            >
              <XAxis
                dataKey="bucket"
                tick={{ fontSize: 10 }}
                interval={0}
                angle={-30}
                textAnchor="end"
                height={50}
              >
                <Label
                  value="Score range"
                  position="insideBottom"
                  offset={-2}
                  style={{ fontSize: 10, fill: '#6b7280' }}
                />
              </XAxis>
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false}>
                <Label
                  value="Submissions"
                  angle={-90}
                  position="insideLeft"
                  style={{ fontSize: 10, fill: '#6b7280', textAnchor: 'middle' }}
                />
              </YAxis>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="before" fill="#94a3b8" name="Before" />
              <Bar dataKey="after" fill="#3b82f6" name="After" />
            </BarChart>
          </ResponsiveContainer>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-900">Top movers</h3>
          {movers.length === 0 ? (
            <div className="rounded-lg border" data-testid="top-movers-empty">
              <EmptyState
                title="No submission's score changes"
                description="Among the largest movers the server reported, every score stays the same."
              />
            </div>
          ) : (
            <div className="rounded-lg border" data-testid="top-movers">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Student</TableHead>
                    <TableHead>Assignment</TableHead>
                    <TableHead className="text-right">Before → After</TableHead>
                    <TableHead className="text-right">Δ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movers.map((m) => {
                    const delta = m.new_score - m.old_score;
                    return (
                      <TableRow key={m.submission_id} data-testid="top-mover-row">
                        {/*
                          EVERY contributor, not the submitter of record. A
                          mover row says "this score moves by N under the
                          proposed weights"; the score belongs to the whole
                          scope, so naming one partner of a group submission
                          charges the swing to an arbitrary person. Falls back
                          to `student` for a response predating
                          `contributors`.
                        */}
                        <TableCell>
                          {contributorsLabel(m.contributors, {
                            fallbackStudent: m.student,
                          }) || personLabel(null)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {m.assignment.assignment_id_str}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {m.old_score.toFixed(1)} → {m.new_score.toFixed(1)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-mono tabular-nums',
                            delta > 0 ? 'text-red-700' : 'text-emerald-700',
                          )}
                        >
                          {formatDelta(delta)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
