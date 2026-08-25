/**
 * ExportCurrentView — exports ALL submissions matching the current filters,
 * not just the rows already loaded in the table.
 *
 * On click, walks the server's cursor-paginated list endpoint with the same
 * filters + sort as the visible view, accumulates every page, then writes a
 * single CSV. Bounded by MAX_EXPORT_ROWS to avoid runaway downloads if the
 * filter is too broad.
 *
 * Filename: `cohort-<semester>-<YYYYMMDD>.csv`
 */

import { useState } from 'react';
import { apiFetch } from '../../api/client.js';
import { buildSubmissionParams, buildQueryString } from '../../api/queries.js';
import type { CohortSort } from '../../api/queries.js';
import type { CohortFilters } from './use-cohort-filters.js';
import { CohortListResponseSchema, type SubmissionRow } from '@provenance/shared/api-schemas';
import { formatDuration } from '../../lib/format.js';
import { contributorsLabel, contributorsSidLabel } from '../../lib/contributor-display.js';

const PAGE_LIMIT = 200;
const MAX_EXPORT_ROWS = 10_000;

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Exported for tests: the CSV column contract is consumed by graders'
 * spreadsheets, so the exact header order and the exact cell values for a
 * solo row are behaviour worth pinning.
 */
export function buildCsv(rows: SubmissionRow[]): string {
  const headers = [
    'submission_id',
    'student_sid',
    'student_name',
    'assignment',
    'score_total',
    'score_max_severity',
    'flags_high',
    'flags_medium',
    'flags_low',
    'flags_info',
    'top_flags',
    'active_time',
    'idle_time',
    'validation_status',
    'ingested_at',
    'recompute_status',
    'superseded',
    // Appended at the END so every existing consumer's column positions are
    // unchanged. `student_sid`/`student_name` above carry the same people as
    // `contributor_sids`/`contributor_names`; the pair is kept because the
    // column positions are the contract, and `contributor_count` is the only
    // thing here a consumer cannot derive from them.
    'contributor_count',
    'contributor_sids',
    'contributor_names',
  ];

  const lines = [headers.join(',')];

  for (const row of rows) {
    const topFlagsStr = row.top_flags.map((f) => f.heuristic_id).join(';');
    const cells = [
      row.id,
      // Every contributor, not `row.student`.
      //
      // `student` is the SUBMITTER of record, and on a group submission it is
      // one of several people who worked on the artifact — so a spreadsheet
      // column headed `student_name` was naming one partner and hiding the
      // other. The column NAMES and POSITIONS are the contract here (graders'
      // sheets index them), so they are untouched: what changes is that a
      // multi-contributor cell becomes a `;`-separated list rather than one
      // arbitrary name. A solo submission has exactly one contributor, equal to
      // `student`, so its two cells are byte-identical to before.
      contributorsSidLabel(row.contributors, { fallbackStudent: row.student, separator: ';' }),
      contributorsLabel(row.contributors, { fallbackStudent: row.student, separator: ';' }),
      row.assignment.label || row.assignment.assignment_id_str,
      String(row.score_total),
      row.score_max_severity,
      String(row.flag_counts.high),
      String(row.flag_counts.medium),
      String(row.flag_counts.low),
      String(row.flag_counts.info),
      topFlagsStr,
      row.total_active_ms === null ? '' : formatDuration(row.total_active_ms),
      row.total_idle_ms === null ? '' : formatDuration(row.total_idle_ms),
      row.validation_status ?? '',
      row.ingested_at,
      row.recompute_status,
      String(row.superseded),
      String(row.contributors.length),
      contributorsSidLabel(row.contributors, { separator: ';' }),
      contributorsLabel(row.contributors, { separator: ';' }),
    ];
    lines.push(cells.map(csvEscape).join(','));
  }

  return lines.join('\n');
}

function formatDateYYYYMMDD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function downloadCsv(rows: SubmissionRow[], semesterSlug: string): void {
  const csv = buildCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const filename = `cohort-${semesterSlug}-${formatDateYYYYMMDD(new Date())}.csv`;
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Cursor walker
// ---------------------------------------------------------------------------

async function fetchAllSubmissions(
  semesterId: string,
  filters: CohortFilters,
  sort: CohortSort,
): Promise<{ rows: SubmissionRow[]; truncated: boolean }> {
  const accumulated: SubmissionRow[] = [];
  let cursor: string | null = null;

  // Iterate until the server returns no more pages OR we hit the safety cap.
  for (let page = 0; page < Math.ceil(MAX_EXPORT_ROWS / PAGE_LIMIT) + 1; page++) {
    const params = buildSubmissionParams(filters, sort, cursor, PAGE_LIMIT);
    const qs = buildQueryString(params);
    const result = await apiFetch(
      `/semesters/${semesterId}/submissions${qs ? `?${qs}` : ''}`,
      undefined,
      CohortListResponseSchema,
    );
    accumulated.push(...result.items);

    if (accumulated.length >= MAX_EXPORT_ROWS) {
      return { rows: accumulated.slice(0, MAX_EXPORT_ROWS), truncated: true };
    }

    if (!result.next_cursor) {
      return { rows: accumulated, truncated: false };
    }
    cursor = result.next_cursor;
  }

  return { rows: accumulated, truncated: true };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ExportCurrentViewProps {
  semesterId: string;
  semesterSlug: string;
  filters: CohortFilters;
  sort: CohortSort;
  /** Disable when the student tab is active (CSV is submission-shaped). */
  disabled?: boolean;
}

export function ExportCurrentView({
  semesterId,
  semesterSlug,
  filters,
  sort,
  disabled,
}: ExportCurrentViewProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  async function handleExport() {
    if (isExporting || disabled) return;
    setIsExporting(true);
    setWarning(null);
    try {
      const { rows, truncated } = await fetchAllSubmissions(semesterId, filters, sort);
      if (rows.length === 0) {
        setWarning('No rows to export.');
        return;
      }
      downloadCsv(rows, semesterSlug);
      if (truncated) {
        setWarning(
          `Export capped at ${MAX_EXPORT_ROWS.toLocaleString()} rows. Narrow your filters to export the rest.`,
        );
      }
    } catch (e) {
      setWarning(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => void handleExport()}
        disabled={isExporting || disabled}
        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        data-testid="export-button"
        title={disabled ? 'Switch to the submissions tab to export' : 'Export all matching rows'}
      >
        {isExporting ? 'Exporting…' : 'Export CSV'}
      </button>
      {warning && (
        <span className="text-[11px] text-amber-600" data-testid="export-warning">
          {warning}
        </span>
      )}
    </div>
  );
}
