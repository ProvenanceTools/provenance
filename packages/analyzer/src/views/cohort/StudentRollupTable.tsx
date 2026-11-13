/**
 * StudentRollupTable — virtualized table of per-student rollup rows.
 *
 * Columns per PRD §8.8 students endpoint (~line 1110):
 * - Student (sid + display_name)
 * - Submissions (submission_count)
 * - Score (score_sum / score_max)
 * - Flag counts (badges by severity)
 * - Worst submission link
 * - Recompute status
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useNavigate } from 'react-router-dom';
import type { StudentRollupRow } from '@provenance/shared/api-schemas';
import type { StudentSort } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import { SortableHeader, type SortDirection } from '../../components/a11y/SortableHeader.js';

// ---------------------------------------------------------------------------
// Severity badge (local copy to keep import-free)
// ---------------------------------------------------------------------------

const SEV_COLOR: Record<string, string> = {
  high: 'bg-red-100 text-red-800',
  medium: 'bg-orange-100 text-orange-800',
  low: 'bg-yellow-100 text-yellow-800',
  info: 'bg-gray-100 text-gray-700',
};

function SeverityBadge({ sev, count }: { sev: string; count: number }) {
  if (count === 0) return null;
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${SEV_COLOR[sev] ?? SEV_COLOR['info']}`}
    >
      {count}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Column helper
// ---------------------------------------------------------------------------

const ch = createColumnHelper<StudentRollupRow>();

// ---------------------------------------------------------------------------
// Sort column map
// ---------------------------------------------------------------------------

const COLUMN_TO_SORT: Record<string, StudentSort | undefined> = {
  student: 'student_asc',
  score: 'score_sum_desc',
  score_max: 'score_max_desc',
};

/**
 * Current sort direction for a sortable column. Each StudentSort value has
 * exactly one valid direction (student is asc-only, the score columns are
 * desc-only — there is no toggle), so this just checks whether `sort` equals
 * the column's single mapped value.
 */
function getSortDirection(columnId: string, sort: StudentSort): SortDirection {
  const mapped = COLUMN_TO_SORT[columnId];
  if (!mapped || sort !== mapped) return null;
  return mapped === 'student_asc' ? 'asc' : 'desc';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface StudentRollupTableProps {
  rows: StudentRollupRow[];
  sort: StudentSort;
  onSortChange: (sort: StudentSort) => void;
  nextCursor: string | null;
  onLoadMore: () => void;
  isLoadingMore: boolean;
}

export function StudentRollupTable({
  rows,
  sort,
  onSortChange,
  nextCursor,
  onLoadMore,
  isLoadingMore,
}: StudentRollupTableProps) {
  const navigate = useNavigate();
  const { basePath } = useActiveSemester();

  // Infinite-scroll sentinel — same pattern as CohortTable. The sentinel
  // div lives INSIDE parentRef's scroll container and the observer roots
  // against parentRef so unscrolled tables don't auto-trip.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
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
        cell: (info) => (
          <div>
            <div className="text-sm font-medium text-gray-900">{info.getValue()}</div>
            <div className="text-xs text-gray-500">{info.row.original.student.sid}</div>
          </div>
        ),
      }),
      ch.accessor('submission_count', {
        id: 'count',
        header: 'Submissions',
        cell: (info) => <span className="text-sm tabular-nums">{info.getValue()}</span>,
      }),
      ch.accessor('score_sum', {
        id: 'score',
        header: 'Score Sum',
        cell: (info) => <span className="text-sm tabular-nums">{info.getValue().toFixed(1)}</span>,
      }),
      ch.accessor('score_max', {
        id: 'score_max',
        header: 'Score Max',
        cell: (info) => <span className="text-sm tabular-nums">{info.getValue().toFixed(1)}</span>,
      }),
      ch.accessor('flag_counts', {
        id: 'flags',
        header: 'Flags',
        cell: (info) => {
          const fc = info.getValue();
          return (
            <div className="flex items-center gap-1">
              <SeverityBadge sev="high" count={fc.high} />
              <SeverityBadge sev="medium" count={fc.medium} />
              <SeverityBadge sev="low" count={fc.low} />
              <SeverityBadge sev="info" count={fc.info} />
            </div>
          );
        },
      }),
      ch.accessor('worst_submission', {
        id: 'worst',
        header: 'Worst Submission',
        cell: (info) => {
          const ws = info.getValue();
          if (!ws || !basePath) return <span className="text-xs text-gray-600">—</span>;
          return (
            <button
              className="text-xs text-berkeley-700 hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                void navigate(`${basePath}/sub/${ws.id}`);
              }}
              data-testid={`worst-submission-${ws.id}`}
            >
              {ws.assignment.label || ws.assignment.assignment_id_str}
            </button>
          );
        },
      }),
      ch.accessor('recompute_status', {
        id: 'recompute',
        header: 'Recompute',
        cell: (info) => <span className="text-xs text-gray-500">{info.getValue()}</span>,
      }),
    ],
    [navigate, basePath],
  );

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
  });

  // parentRef declared above (alongside the infinite-scroll observer setup)
  // so both pieces share the same scroll container reference.
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
    const newSort = COLUMN_TO_SORT[columnId];
    if (!newSort) return;
    // If already on this sort, don't toggle — student sort is one-directional
    if (sort !== newSort) onSortChange(newSort);
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={parentRef}
        className="overflow-auto rounded-md border border-gray-200 bg-white"
        style={{ maxHeight: '70vh' }}
        data-testid="student-table-scroll"
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
                  className="border-b border-gray-100"
                  data-testid={`student-row-${row.original.student.id}`}
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
        {/* Sentinel lives inside the scrollable parent so it only intersects
            once the user has scrolled near the bottom. */}
        {nextCursor !== null && (
          <div
            ref={sentinelRef}
            className="flex justify-center py-3 text-xs text-gray-600"
            data-testid="student-load-more-sentinel"
          >
            {isLoadingMore ? 'Loading more…' : 'Scroll for more'}
          </div>
        )}
      </div>
    </div>
  );
}
