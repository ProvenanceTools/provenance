/**
 * CrossFlagListView — list of cross-submission flags for a semester.
 *
 * Phase 24. Route: /s/:courseSlug/:semesterSlug/cross-flags
 *
 * Features:
 * - Filters: heuristic_id, severity_min, submission_id.
 * - Cursor pagination via load-more button.
 * - Row → navigate to /s/:courseSlug/:semesterSlug/cross-flags/:id via a
 *   keyboard-reachable RowLink in the primary cell (WCAG 2.1.1).
 */

import { useState } from 'react';
import { useCrossFlagList } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import { RowLink } from '../../components/a11y/RowLink.js';
import type { CrossFlagDetailItem, CrossScopeExclusionItem } from '@provenance/shared/api-schemas';
import type { CrossFlagFilters } from '../../api/queries.js';
import { contributorsLabel } from '../../lib/contributor-display.js';

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    high: 'bg-red-100 text-red-700',
    medium: 'bg-orange-100 text-orange-700',
    low: 'bg-yellow-100 text-yellow-700',
    info: 'bg-gray-100 text-gray-600',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[severity] ?? 'bg-gray-100 text-gray-600'}`}
    >
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// CrossScopeExclusionPanel — what was NOT compared, and why.
//
// The same register the `/local` CompareView renders, in the same visual
// language, now that the server persists it (migration 0031). Deliberately not
// a row in the findings table: spec S20 requires suppressed comparisons be
// VISIBLY suppressed, and §6 Rule 3 fixes what a register entry is — a
// statement about the recording ("these archives are the same repository"),
// never a finding about a person. So it has no severity badge, no confidence,
// no link to a detail page, and it renders in neutral styling above the table
// rather than inside it.
//
// Without this, a grader looking at the server-backed view saw the suppression
// with no explanation for it: an absence that reads exactly like a clean result.
// ---------------------------------------------------------------------------

function CrossScopeExclusionPanel({ exclusions }: { exclusions: CrossScopeExclusionItem[] }) {
  if (exclusions.length === 0) return null;

  return (
    <section
      aria-labelledby="cross-exclusions-heading"
      className="mb-4 rounded border border-gray-200 bg-gray-50 p-3"
      data-testid="cross-scope-exclusions"
    >
      <h2 id="cross-exclusions-heading" className="text-sm font-semibold text-gray-900">
        Not cross-compared
      </h2>
      <p className="mt-1 text-xs text-gray-600">
        These submissions are the same repository: each archive contains the other&rsquo;s recorded
        sessions, so a match between them says nothing about sharing between students.
        Cross-comparison between them is not applicable. Every other pair was compared normally.
      </p>
      <ul className="mt-3 space-y-2" role="list">
        {exclusions.map((ex) => (
          <li
            key={ex.id}
            className="rounded border border-gray-200 bg-white p-2"
            data-testid={`cross-scope-exclusion-${ex.id}`}
          >
            <p className="text-xs font-medium text-gray-900">
              {ex.members
                .map(
                  (m) =>
                    // `fallbackStudent` covers a response that predates `contributors`.
                    contributorsLabel(m.contributors, { fallbackStudent: m.student }) ||
                    m.source_filename,
                )
                .join(' · ')}
            </p>
            <p className="mt-1 text-xs text-gray-600">
              Same repository lineage —{' '}
              {ex.excluded_pair_count === 1
                ? '1 comparison not applicable'
                : `${ex.excluded_pair_count} comparisons not applicable`}
              {/* "commit references", not "commits": a mixed-scope proof lists
                  the SAME sha under two repository keys, because neither key
                  was observed by both sides. Counting those as two commits
                  recorded in more than one archive would be a false claim, in
                  the one place a grader looks for the evidence. */}
              . Established by {ex.shared_commits.length}{' '}
              {ex.shared_commits.length === 1 ? 'commit reference' : 'commit references'} shared
              across these archives.
            </p>
            <ul className="mt-1.5 space-y-0.5" data-testid="cross-scope-exclusion-commits">
              {ex.shared_commits.slice(0, 5).map((key) => (
                <li key={key} className="font-mono text-[11px] text-gray-500 break-all">
                  {key}
                </li>
              ))}
              {ex.shared_commits.length > 5 && (
                <li className="text-[11px] italic text-gray-500">
                  and {ex.shared_commits.length - 5} more
                </li>
              )}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// CrossFlagListView
// ---------------------------------------------------------------------------

export function CrossFlagListView() {
  const { semesterId, basePath } = useActiveSemester();

  // Filters
  const [heuristicId, setHeuristicId] = useState('');
  const [severityMin, setSeverityMin] = useState<CrossFlagFilters['severityMin']>(undefined);
  const [submissionId, setSubmissionId] = useState('');

  // Accumulated items across pages
  const [allItems, setAllItems] = useState<CrossFlagDetailItem[]>([]);
  const [activeCursor, setActiveCursor] = useState<string | undefined>(undefined);
  // The exclusion register arrives with the FIRST page only (it is not
  // paginated). Held here so it stays on screen as the user pages through the
  // findings — the register explains the whole list, not one page of it.
  const [pageOneExclusions, setPageOneExclusions] = useState<CrossScopeExclusionItem[]>([]);

  const filters: CrossFlagFilters = {
    ...(heuristicId ? { heuristicId } : {}),
    ...(severityMin ? { severityMin } : {}),
    ...(submissionId ? { submissionId } : {}),
    ...(activeCursor ? { cursor: activeCursor } : {}),
    limit: 25,
  };

  const { data, isLoading, isFetching } = useCrossFlagList(semesterId, filters);

  // When filter changes, reset accumulated list
  function applyFilters() {
    setActiveCursor(undefined);
    setAllItems([]);
    setPageOneExclusions([]);
  }

  // Merge new page into accumulated list
  const currentItems = data?.items ?? [];
  const displayItems = activeCursor !== undefined ? [...allItems, ...currentItems] : currentItems;
  const displayExclusions =
    activeCursor === undefined ? (data?.exclusions ?? []) : pageOneExclusions;

  function handleLoadMore() {
    if (data?.next_cursor) {
      const prevItems = displayItems;
      setAllItems(prevItems);
      // Capture the register on the way off page one; later pages carry an
      // empty array and must not blank it.
      if (activeCursor === undefined) setPageOneExclusions(data.exclusions ?? []);
      setActiveCursor(data.next_cursor);
    }
  }

  return (
    <div className="flex flex-col min-h-0 p-4" data-testid="cross-flag-list-view">
      <h1 className="text-lg font-semibold text-gray-900 mb-4">Cross-Submission Flags</h1>

      {/* Filter bar */}
      <div className="flex gap-3 mb-4 flex-wrap" data-testid="cross-flag-filters">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Heuristic ID</label>
          <input
            type="text"
            value={heuristicId}
            onChange={(e) => setHeuristicId(e.target.value)}
            placeholder="e.g. paste_shared_across_students"
            className="border border-gray-200 rounded px-2 py-1 text-xs w-56"
            data-testid="filter-heuristic-id"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Min Severity</label>
          <select
            value={severityMin ?? ''}
            onChange={(e) => {
              setSeverityMin((e.target.value as CrossFlagFilters['severityMin']) || undefined);
            }}
            className="border border-gray-200 rounded px-2 py-1 text-xs"
            data-testid="filter-severity-min"
          >
            <option value="">Any</option>
            <option value="info">Info</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Submission ID</label>
          <input
            type="text"
            value={submissionId}
            onChange={(e) => setSubmissionId(e.target.value)}
            placeholder="UUID"
            className="border border-gray-200 rounded px-2 py-1 text-xs w-72"
            data-testid="filter-submission-id"
          />
        </div>

        <div className="flex flex-col gap-1 justify-end">
          <button
            onClick={applyFilters}
            className="px-3 py-1 border border-gray-300 text-xs rounded hover:bg-gray-50"
            data-testid="apply-filters-btn"
          >
            Apply
          </button>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-sm text-gray-500" data-testid="cross-flag-loading">
          Loading cross-flags…
        </div>
      ) : (
        <>
          {/* Above the table on purpose: "no findings" must not be read before
              the reason some comparisons were never made. */}
          <CrossScopeExclusionPanel exclusions={displayExclusions} />

          <div className="bg-white border border-gray-200 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">
                    Heuristic
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">
                    Severity
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">
                    Participants
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Created</th>
                </tr>
              </thead>
              <tbody data-testid="cross-flag-rows">
                {displayItems.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-gray-600 text-sm">
                      No cross-flags found.
                    </td>
                  </tr>
                )}
                {displayItems.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-gray-100 hover:bg-gray-50"
                    data-testid={`cross-flag-row-${item.id}`}
                  >
                    <td className="px-4 py-2 font-mono text-xs">
                      <RowLink to={`${basePath}/cross-flags/${item.id}`} className="block">
                        {item.heuristic_id}
                      </RowLink>
                    </td>
                    <td className="px-4 py-2">
                      <SeverityBadge severity={item.severity} />
                    </td>
                    <td className="px-4 py-2 text-gray-600">{item.participants.length}</td>
                    <td className="px-4 py-2 text-gray-600 text-xs">
                      {new Date(item.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data?.next_cursor && (
            <div className="mt-3 flex justify-center">
              <button
                onClick={handleLoadMore}
                disabled={isFetching}
                className="px-4 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                data-testid="load-more-btn"
              >
                {isFetching ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
