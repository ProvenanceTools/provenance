/**
 * CohortTable — virtualized table of submission rows.
 *
 * Backed by @tanstack/react-table for column definitions + sorting and
 * @tanstack/react-virtual for row virtualization (300px row height pool,
 * 52px per row).
 *
 * Columns per PRD §8.8 SubmissionRow:
 * - Student (sid + display_name)
 * - Assignment (assignment_id_str + label)
 * - Score (score_total) + max severity badge
 * - Flag counts (badges by severity; click opens that severity's flags)
 * - Active / Idle time (60s event-gap; em dash if not yet computed)
 * - Top flags (up to 3 heuristic ids)
 * - Validation status
 * - Ingested at (relative time)
 * - Recompute status badge
 *
 * Sorting: clicking a header changes the sort in the parent via onSortChange.
 * Load more: explicit "Load more" button when next_cursor is non-null.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { FlagRowSchema, type SubmissionRow } from '@provenance/shared/api-schemas';
import type { CohortSort } from '../../api/queries.js';
import { apiFetch } from '../../api/client.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import { RowLink } from '../../components/a11y/RowLink.js';
import { SortableHeader, type SortDirection } from '../../components/a11y/SortableHeader.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { formatDuration } from '../../lib/format.js';

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

const SEV_COLOR: Record<string, string> = {
  high: 'bg-red-100 text-red-800',
  medium: 'bg-orange-100 text-orange-800',
  low: 'bg-yellow-100 text-yellow-800',
  info: 'bg-gray-100 text-gray-700',
};

const FlagListResponseSchema = z.object({ flags: z.array(FlagRowSchema) });

type SeverityKey = 'high' | 'medium' | 'low' | 'info';

function flagLabel(heuristicId: string, title: string | undefined): string {
  if (title !== undefined && title.length > 0) return title;
  return heuristicId.replace(/_/g, ' ');
}

export function FlagCountBadge({
  submissionId,
  sev,
  count,
  basePath,
  defaultOpen = false,
}: {
  submissionId: string;
  sev: SeverityKey;
  count: number;
  basePath: string;
  /** Test-only: Radix menus don't open from fireEvent.click in jsdom. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const query = useQuery({
    queryKey: ['submission', submissionId, 'flags'],
    queryFn: async () => {
      const resp = await apiFetch(
        `/submissions/${submissionId}/flags`,
        undefined,
        FlagListResponseSchema,
      );
      return resp.flags;
    },
    enabled: open,
    staleTime: 30 * 1000,
  });

  if (count === 0) return null;

  const matching = (query.data ?? []).filter((f) => f.severity === sev);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${SEV_COLOR[sev] ?? SEV_COLOR['info']}`}
          data-testid={`flag-count-${sev}-${submissionId}`}
          aria-label={`${count} ${sev} flags`}
        >
          {count}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 min-w-[12rem] overflow-auto">
        {query.isPending && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
        )}
        {query.isError && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Couldn't load flags</div>
        )}
        {query.isSuccess && matching.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No flags</div>
        )}
        {query.isSuccess &&
          matching.map((f) => {
            const label = flagLabel(f.heuristic_id, f.title);
            if (!basePath) {
              return (
                <DropdownMenuItem key={f.id} disabled>
                  {label}
                </DropdownMenuItem>
              );
            }
            return (
              <DropdownMenuItem key={f.id} asChild>
                <Link to={`${basePath}/sub/${submissionId}?tab=overview&flag=${f.heuristic_id}`}>
                  {label}
                </Link>
              </DropdownMenuItem>
            );
          })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Validation status badge
// ---------------------------------------------------------------------------

const VAL_COLOR: Record<string, string> = {
  pass: 'bg-green-100 text-green-800',
  warn: 'bg-yellow-100 text-yellow-800',
  fail: 'bg-red-100 text-red-800',
};

function ValidationBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-gray-600">—</span>;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${VAL_COLOR[status] ?? 'bg-gray-100 text-gray-700'}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Recompute status badge
// ---------------------------------------------------------------------------

const RECOMPUTE_COLOR: Record<string, string> = {
  fresh: 'text-green-700',
  stale: 'text-yellow-600',
  recomputing: 'text-blue-600',
  error: 'text-red-600',
};

function RecomputeBadge({ status }: { status: string }) {
  return <span className={`text-xs ${RECOMPUTE_COLOR[status] ?? 'text-gray-500'}`}>{status}</span>;
}

// ---------------------------------------------------------------------------
// Sort column map: tanstack column id -> CohortSort value
// ---------------------------------------------------------------------------

const COLUMN_TO_SORT: Record<string, { asc: CohortSort; desc: CohortSort } | undefined> = {
  score: { asc: 'score_asc', desc: 'score_desc' },
  student: { asc: 'student_asc', desc: 'student_desc' },
  assignment: { asc: 'assignment_asc', desc: 'assignment_asc' },
  ingested: { asc: 'ingested_desc', desc: 'ingested_desc' }, // only desc is valid
};

/**
 * Current sort direction for a sortable column, derived from the sort
 * value's own `_asc`/`_desc` suffix rather than from COLUMN_TO_SORT's
 * asc/desc entries directly — for `assignment` and `ingested` those entries
 * intentionally alias to the same single valid CohortSort value, so
 * comparing against sortMap.asc/sortMap.desc in a fixed order would report
 * the wrong direction for one of them.
 */
function getSortDirection(columnId: string, sort: CohortSort): SortDirection {
  if (!(columnId in COLUMN_TO_SORT)) return null;
  if (sort === `${columnId}_asc`) return 'asc';
  if (sort === `${columnId}_desc`) return 'desc';
  return null;
}

// ---------------------------------------------------------------------------
// Column helper
// ---------------------------------------------------------------------------

const ch = createColumnHelper<SubmissionRow>();

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CohortTableProps {
  rows: SubmissionRow[];
  sort: CohortSort;
  onSortChange: (sort: CohortSort) => void;
  nextCursor: string | null;
  onLoadMore: () => void;
  isLoadingMore: boolean;
}

export function CohortTable({
  rows,
  sort,
  onSortChange,
  nextCursor,
  onLoadMore,
  isLoadingMore,
}: CohortTableProps) {
  const { basePath } = useActiveSemester();

  // Infinite-scroll sentinel: lives INSIDE the scrollable table container
  // (see parentRef below) so it's only visible to the IntersectionObserver
  // once the user has actually scrolled near the bottom. Observer roots
  // against parentRef rather than the document so an unscrolled table doesn't
  // immediately trip the sentinel just because it fits in the viewport.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Forward-declared here; assigned by the JSX below.
  const parentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    const root = parentRef.current;
    if (!node || !root || nextCursor === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !isLoadingMore) {
            onLoadMore();
          }
        }
      },
      { root, rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [nextCursor, isLoadingMore, onLoadMore]);

  const columns = useMemo(
    () => [
      ch.accessor((r) => r.student.display_name, {
        id: 'student',
        header: 'Student',
        cell: (info) => {
          const content = (
            <div>
              <div className="text-sm font-medium text-gray-900">{info.getValue()}</div>
              <div className="text-xs text-gray-500">{info.row.original.student.sid}</div>
            </div>
          );
          // basePath is only '' when courseSlug/semesterSlug are unresolved,
          // which never happens while CohortTable is actually mounted (the
          // parent CohortView doesn't render it until semesterId resolves).
          // Fall back to plain (non-link) content rather than a broken href.
          if (!basePath) return content;
          return <RowLink to={`${basePath}/sub/${info.row.original.id}`}>{content}</RowLink>;
        },
      }),
      ch.accessor((r) => r.assignment.label, {
        id: 'assignment',
        header: 'Assignment',
        cell: (info) => (
          <div>
            <div className="text-sm text-gray-900">{info.getValue()}</div>
            <div className="text-xs text-gray-500">
              {info.row.original.assignment.assignment_id_str}
            </div>
          </div>
        ),
      }),
      ch.accessor('score_total', {
        id: 'score',
        header: 'Score',
        cell: (info) => (
          <div className="flex items-center gap-1.5">
            <span className="text-sm tabular-nums">{info.getValue().toFixed(1)}</span>
            <span
              className={`inline-flex h-2 w-2 rounded-full ${
                info.row.original.score_max_severity === 'high'
                  ? 'bg-red-500'
                  : info.row.original.score_max_severity === 'medium'
                    ? 'bg-orange-400'
                    : info.row.original.score_max_severity === 'low'
                      ? 'bg-yellow-400'
                      : 'bg-gray-300'
              }`}
              role="img"
              aria-label={`Max severity: ${info.row.original.score_max_severity}`}
              title={info.row.original.score_max_severity}
            />
          </div>
        ),
      }),
      ch.accessor('flag_counts', {
        id: 'flags',
        header: 'Flags',
        cell: (info) => {
          const fc = info.getValue();
          const submissionId = info.row.original.id;
          return (
            <div className="flex items-center gap-1">
              <FlagCountBadge
                submissionId={submissionId}
                sev="high"
                count={fc.high}
                basePath={basePath}
              />
              <FlagCountBadge
                submissionId={submissionId}
                sev="medium"
                count={fc.medium}
                basePath={basePath}
              />
              <FlagCountBadge
                submissionId={submissionId}
                sev="low"
                count={fc.low}
                basePath={basePath}
              />
              <FlagCountBadge
                submissionId={submissionId}
                sev="info"
                count={fc.info}
                basePath={basePath}
              />
            </div>
          );
        },
      }),
      ch.accessor('total_active_ms', {
        id: 'active',
        header: () => <span title="Gaps under 60s between events">Active</span>,
        cell: (info) => {
          const ms = info.getValue();
          return (
            <span
              className="text-xs tabular-nums text-gray-700"
              data-testid={`active-time-${info.row.original.id}`}
            >
              {ms === null ? '—' : formatDuration(ms)}
            </span>
          );
        },
      }),
      ch.accessor('total_idle_ms', {
        id: 'idle',
        header: () => <span title="Gaps of 60s or more">Idle</span>,
        cell: (info) => {
          const ms = info.getValue();
          return (
            <span
              className="text-xs tabular-nums text-gray-700"
              data-testid={`idle-time-${info.row.original.id}`}
            >
              {ms === null ? '—' : formatDuration(ms)}
            </span>
          );
        },
      }),
      ch.accessor('top_flags', {
        id: 'top_flags',
        header: 'Top Flags',
        cell: (info) => {
          const flags = info.getValue();
          if (flags.length === 0) return <span className="text-xs text-gray-600">—</span>;
          const submissionId = info.row.original.id;
          return (
            <div className="flex flex-wrap gap-1">
              {flags.map((f) => {
                const label = f.heuristic_id.replace(/_/g, ' ');
                const chipClass = `inline-flex items-center rounded px-1 py-0.5 text-xs ${SEV_COLOR[f.severity] ?? SEV_COLOR['info']}`;
                // basePath is '' only before slugs resolve (never while mounted,
                // see the student cell). Fall back to a plain chip over a broken
                // link.
                if (!basePath) {
                  return (
                    <span key={f.heuristic_id} className={chipClass}>
                      {label}
                    </span>
                  );
                }
                return (
                  <Link
                    key={f.heuristic_id}
                    to={`${basePath}/sub/${submissionId}?tab=overview&flag=${f.heuristic_id}`}
                    className={`${chipClass} transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                    title={`Jump to “${label}” on this submission`}
                  >
                    {label}
                  </Link>
                );
              })}
            </div>
          );
        },
      }),
      ch.accessor('validation_status', {
        id: 'validation',
        header: 'Validation',
        cell: (info) => <ValidationBadge status={info.getValue()} />,
      }),
      ch.accessor('ingested_at', {
        id: 'ingested',
        header: 'Ingested',
        cell: (info) => {
          const d = new Date(info.getValue());
          return (
            <span className="text-xs text-gray-500" title={info.getValue()}>
              {formatDistanceToNow(d, { addSuffix: true })}
            </span>
          );
        },
      }),
      ch.accessor('recompute_status', {
        id: 'recompute',
        header: 'Recompute',
        cell: (info) => <RecomputeBadge status={info.getValue()} />,
      }),
    ],
    [basePath],
  );

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Server-side sorting: manual = true disables client sorting
    manualSorting: true,
  });

  // Virtualization setup. parentRef is declared above (alongside the
  // infinite-scroll observer setup) so both pieces share the same scroll
  // container reference.
  const ROW_HEIGHT = 52;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? (virtualRows[0]?.start ?? 0) : 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - (virtualRows[virtualRows.length - 1]?.end ?? 0) : 0;

  function handleHeaderClick(columnId: string) {
    const sortMap = COLUMN_TO_SORT[columnId];
    if (!sortMap) return;
    // Toggle: if currently sorted desc by this column, switch to asc; otherwise desc
    const isDescNow = sort === sortMap.desc && sortMap.desc !== sortMap.asc;
    onSortChange(isDescNow ? sortMap.asc : sortMap.desc);
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={parentRef}
        className="overflow-auto rounded-md border border-gray-200 bg-white"
        style={{ maxHeight: '70vh' }}
        data-testid="cohort-table-scroll"
      >
        <table className="min-w-full text-left text-sm">
          <thead className="sticky top-0 bg-gray-50">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const isSortable = header.column.id in COLUMN_TO_SORT;
                  if (isSortable) {
                    return (
                      <SortableHeader
                        key={header.id}
                        label={String(header.column.columnDef.header)}
                        direction={getSortDirection(header.column.id, sort)}
                        onSort={() => handleHeaderClick(header.column.id)}
                        className="cursor-pointer select-none border-b border-gray-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-600 hover:bg-gray-100"
                      />
                    );
                  }
                  return (
                    <th
                      key={header.id}
                      className="border-b border-gray-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-600"
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr>
                <td colSpan={columns.length} style={{ height: paddingTop }} />
              </tr>
            )}
            {virtualRows.map((vRow) => {
              const row = table.getRowModel().rows[vRow.index];
              if (!row) return null;
              return (
                <tr
                  key={row.id}
                  className="border-b border-gray-100 hover:bg-gray-50"
                  data-testid={`cohort-row-${row.original.id}`}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-3 align-top">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr>
                <td colSpan={columns.length} style={{ height: paddingBottom }} />
              </tr>
            )}
          </tbody>
        </table>
        {/* Infinite-scroll sentinel lives INSIDE the scrollable parent so the
            IntersectionObserver (rooted on parentRef) only sees it after the
            user has actually scrolled near the bottom of the table. */}
        {nextCursor !== null && (
          <div
            ref={sentinelRef}
            className="flex justify-center py-3 text-xs text-gray-600"
            data-testid="cohort-load-more-sentinel"
          >
            {isLoadingMore ? 'Loading more…' : 'Scroll for more'}
          </div>
        )}
      </div>
    </div>
  );
}
