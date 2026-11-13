/**
 * CohortView — top-level cohort page at /s/:courseSlug/:semesterSlug.
 *
 * Layout:
 * - Filter rail (left, ~280px)
 * - Main area:
 *   - Top bar: semester name, total count, tab toggle, export button, saved views
 *   - Table: CohortTable (by submission) or StudentRollupTable (by student)
 *
 * URL state:
 * - Filters via useCohortFilters (see use-cohort-filters.ts)
 * - tab via ?tab=submissions|students (default: submissions)
 * - Cursor pagination: load-more button appends cursor to the current page's
 *   accumulated rows; clear filters resets to page 1.
 *
 * Data flow:
 * - useCohortSubmissions / useCohortStudents via React Query
 * - Cursor from server response stored in component state (not URL)
 * - Filters + sort from URL
 *
 * Route: /s/:courseSlug/:semesterSlug (and /s/:courseSlug/:semesterSlug/*)
 */

import { useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCohortFilters } from './use-cohort-filters.js';
import {
  useCohortSubmissions,
  useCohortStudents,
  useAssignments,
  buildQueryString,
  buildSubmissionParams,
  buildStudentParams,
} from '../../api/queries.js';
import { apiFetch } from '../../api/client.js';
import { CohortTable } from './CohortTable.js';
import { StudentRollupTable } from './StudentRollupTable.js';
import { FilterRail } from './FilterRail.js';
import { SavedViews } from './SavedViews.js';
import { ExportCurrentView } from './ExportCurrentView.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import type { SubmissionRow, StudentRollupRow } from '@provenance/shared/api-schemas';
import type { CohortSort, StudentSort } from '../../api/queries.js';
import type { SavedView } from './SavedViews.js';
import {
  CohortListResponseSchema,
  StudentListResponseSchema,
} from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type Tab = 'submissions' | 'students';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CohortView() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Resolve semesterId from the (courseSlug, semesterSlug) URL pair.
  const { semesterId, semesterSlug, isLoading: semestersLoading } = useActiveSemester();

  // Tab
  const tabParam = searchParams.get('tab');
  const activeTab: Tab = tabParam === 'students' ? 'students' : 'submissions';

  function setTab(tab: Tab) {
    const next = new URLSearchParams(searchParams);
    if (tab === 'submissions') {
      next.delete('tab');
    } else {
      next.set('tab', tab);
    }
    setSearchParams(next, { replace: true });
  }

  // Filters + sort (URL state)
  const { filters, sort, setFilters, clearFilters } = useCohortFilters();

  // Student sort state (not in URL — simpler)
  const [studentSort, setStudentSort] = useState<StudentSort>('score_sum_desc');

  // Submission cursor-based load-more: accumulated rows + cursors
  const [submissionRows, setSubmissionRows] = useState<SubmissionRow[]>([]);
  const [submissionCursor, setSubmissionCursor] = useState<string | null>(null);
  const [loadingMoreSubmissions, setLoadingMoreSubmissions] = useState(false);

  // Student cursor-based load-more
  const [studentRows, setStudentRows] = useState<StudentRollupRow[]>([]);
  const [studentCursor, setStudentCursor] = useState<string | null>(null);
  const [loadingMoreStudents, setLoadingMoreStudents] = useState(false);

  // Primary queries (first page, re-runs when filters/sort change)
  const submissionsQuery = useCohortSubmissions(semesterId, filters, sort, null, 50);
  const studentsQuery = useCohortStudents(semesterId, filters, studentSort, null, 50);
  const assignmentsQuery = useAssignments(semesterId);

  // Sync accumulated rows with fresh query results (filter/sort change resets)
  const freshSubmissions = submissionsQuery.data?.items ?? [];
  const freshStudents = studentsQuery.data?.items ?? [];

  // Use accumulated rows only if we've started load-more; otherwise use fresh
  const displaySubmissions = submissionRows.length > 0 ? submissionRows : freshSubmissions;
  const displayStudents = studentRows.length > 0 ? studentRows : freshStudents;

  // When fresh query completes (filter changed), reset accumulated
  const handleFiltersApply = useCallback(
    (nextFilters: Parameters<typeof setFilters>[0], nextSort?: CohortSort) => {
      setSubmissionRows([]);
      setSubmissionCursor(null);
      setStudentRows([]);
      setStudentCursor(null);
      setFilters(nextFilters, nextSort);
    },
    [setFilters],
  );

  const handleClearFilters = useCallback(() => {
    setSubmissionRows([]);
    setSubmissionCursor(null);
    setStudentRows([]);
    setStudentCursor(null);
    clearFilters();
  }, [clearFilters]);

  // Load more: fetch next page of submissions, append to accumulated list.
  // Reuses buildSubmissionParams so EVERY active filter (severity, validation,
  // flag IDs, score range, etc.) is sent on subsequent pages — not just
  // assignment_id like the original implementation.
  async function handleLoadMoreSubmissions() {
    const cursor =
      (submissionRows.length > 0 ? submissionCursor : submissionsQuery.data?.next_cursor) ?? null;
    if (!cursor || loadingMoreSubmissions || !semesterId) return;
    setLoadingMoreSubmissions(true);
    try {
      const params = buildSubmissionParams(filters, sort, cursor, 50);
      const qs = buildQueryString(params);
      const result = await apiFetch(
        `/semesters/${semesterId}/submissions?${qs}`,
        undefined,
        CohortListResponseSchema,
      );
      const base = submissionRows.length > 0 ? submissionRows : freshSubmissions;
      setSubmissionRows([...base, ...result.items]);
      setSubmissionCursor(result.next_cursor);
    } finally {
      setLoadingMoreSubmissions(false);
    }
  }

  async function handleLoadMoreStudents() {
    const cursor =
      (studentRows.length > 0 ? studentCursor : studentsQuery.data?.next_cursor) ?? null;
    if (!cursor || loadingMoreStudents || !semesterId) return;
    setLoadingMoreStudents(true);
    try {
      const params = buildStudentParams(filters, studentSort, cursor, 50);
      const qs = buildQueryString(params);
      const result = await apiFetch(
        `/semesters/${semesterId}/students?${qs}`,
        undefined,
        StudentListResponseSchema,
      );
      const base = studentRows.length > 0 ? studentRows : freshStudents;
      setStudentRows([...base, ...result.items]);
      setStudentCursor(result.next_cursor);
    } finally {
      setLoadingMoreStudents(false);
    }
  }

  function handleSortChange(newSort: CohortSort) {
    setSubmissionRows([]);
    setSubmissionCursor(null);
    setFilters(filters, newSort);
  }

  function handleStudentSortChange(newSort: StudentSort) {
    setStudentRows([]);
    setStudentCursor(null);
    setStudentSort(newSort);
  }

  // Saved views
  function handleLoadSavedView(view: SavedView) {
    setSubmissionRows([]);
    setSubmissionCursor(null);
    setStudentRows([]);
    setStudentCursor(null);
    setFilters(view.filters, view.sort);
  }

  // Derived state
  const totalCount = submissionsQuery.data?.total_count ?? 0;
  const assignments = assignmentsQuery.data?.items ?? [];
  const nextSubmissionCursor =
    submissionRows.length > 0
      ? (submissionCursor ?? null)
      : (submissionsQuery.data?.next_cursor ?? null);
  const nextStudentCursor =
    studentRows.length > 0 ? (studentCursor ?? null) : (studentsQuery.data?.next_cursor ?? null);

  // Loading / error states — only consider the active tab's query
  const isLoading =
    activeTab === 'submissions' ? submissionsQuery.isLoading : studentsQuery.isLoading;
  const error = activeTab === 'submissions' ? submissionsQuery.error : studentsQuery.error;

  if (!semesterId) {
    // The slug is resolved against your membership list. While /me is still in
    // flight we genuinely don't know yet — show loading. Once it has resolved
    // and the slug isn't there, you're not a member (or it doesn't exist), so
    // say so instead of spinning forever.
    if (semestersLoading) {
      return (
        <div
          className="flex flex-1 items-center justify-center py-16 text-sm text-gray-600"
          data-testid="cohort-no-semester"
        >
          Loading semester…
        </div>
      );
    }
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-sm text-gray-500"
        data-testid="cohort-no-access"
      >
        <p>You don’t have access to this semester, or it doesn’t exist.</p>
        <Link to="/home" className="text-berkeley-700 hover:underline">
          ← Back to home
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden" data-testid="cohort-view">
      {/* Filter rail */}
      <FilterRail
        filters={filters}
        assignments={assignments}
        onApply={handleFiltersApply}
        onClear={handleClearFilters}
      />

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
          {/* Semester label */}
          <h1 className="text-sm font-semibold text-gray-900" data-testid="cohort-heading">
            {semesterSlug}
          </h1>

          {/* Total count */}
          <span className="text-xs text-gray-500" data-testid="cohort-total-count">
            {totalCount} submissions
          </span>

          <div className="flex-1" />

          {/* Tab toggle — 2-way view toggle using the toggle-button pattern
              (aria-pressed), not a tablist: this switches which table
              renders, not a sub-route. */}
          <div
            className="flex rounded-md border border-gray-300 text-xs overflow-hidden"
            role="group"
            aria-label="View mode"
          >
            <button
              type="button"
              aria-pressed={activeTab === 'submissions'}
              className={`px-3 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${activeTab === 'submissions' ? 'bg-gray-100 font-medium text-gray-900' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              onClick={() => setTab('submissions')}
              data-testid="tab-submissions"
            >
              By submission
            </button>
            <button
              type="button"
              aria-pressed={activeTab === 'students'}
              className={`border-l border-gray-300 px-3 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${activeTab === 'students' ? 'bg-gray-100 font-medium text-gray-900' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              onClick={() => setTab('students')}
              data-testid="tab-students"
            >
              By student
            </button>
          </div>

          {/* Export */}
          <ExportCurrentView
            semesterId={semesterId}
            semesterSlug={semesterSlug}
            filters={filters}
            sort={sort}
            disabled={activeTab !== 'submissions'}
          />

          {/* Saved views */}
          {semesterId && (
            <SavedViews
              semesterId={semesterId}
              currentFilters={filters}
              currentSort={sort}
              onLoadView={handleLoadSavedView}
            />
          )}
        </div>

        {/* Table area */}
        <div className="flex-1 overflow-auto p-4">
          {isLoading && (
            <div
              className="flex items-center justify-center py-16 text-sm text-gray-600"
              data-testid="cohort-loading"
            >
              Loading…
            </div>
          )}
          {error !== null && !isLoading && (
            <div
              className="flex items-center justify-center py-16 text-sm text-destructive"
              data-testid="cohort-error"
            >
              Failed to load data. Please try again.
            </div>
          )}
          {!isLoading && !error && activeTab === 'submissions' && (
            <CohortTable
              rows={displaySubmissions}
              sort={sort}
              onSortChange={handleSortChange}
              nextCursor={nextSubmissionCursor}
              onLoadMore={() => void handleLoadMoreSubmissions()}
              isLoadingMore={loadingMoreSubmissions}
            />
          )}
          {!isLoading && !error && activeTab === 'students' && (
            <StudentRollupTable
              rows={displayStudents}
              sort={studentSort}
              onSortChange={handleStudentSortChange}
              nextCursor={nextStudentCursor}
              onLoadMore={() => void handleLoadMoreStudents()}
              isLoadingMore={loadingMoreStudents}
            />
          )}
        </div>
      </div>
    </div>
  );
}
