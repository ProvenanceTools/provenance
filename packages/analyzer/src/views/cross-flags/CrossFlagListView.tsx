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
import { exclusionCopy, EXCLUSION_PANEL_INTRO } from '@/lib/exclusion-copy.js';
import { PageContainer, PageHeader, Panel, EmptyState } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SeverityBadge } from './SeverityBadge.js';

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
      className="rounded-lg border border-gray-200 bg-gray-50 p-4"
      data-testid="cross-scope-exclusions"
    >
      <h2 id="cross-exclusions-heading" className="text-sm font-semibold text-gray-900">
        Not cross-compared
      </h2>
      <p className="mt-1 text-xs text-gray-600">{EXCLUSION_PANEL_INTRO}</p>
      <ul className="mt-3 space-y-2" role="list">
        {exclusions.map((ex) => {
          const copy = exclusionCopy({
            reason: ex.reason,
            sharedCommits: ex.shared_commits,
            // `?? []` covers a cached response written before migration 0032.
            sharedSessions: ex.shared_sessions ?? [],
          });
          return (
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
                {copy.label} —{' '}
                {ex.excluded_pair_count === 1
                  ? '1 comparison not applicable'
                  : `${ex.excluded_pair_count} comparisons not applicable`}
                . Established by {copy.evidence.length} {copy.evidenceNoun} {copy.evidenceClause}.
              </p>
              <ul className="mt-1.5 space-y-0.5" data-testid="cross-scope-exclusion-commits">
                {copy.evidence.slice(0, 5).map((key) => (
                  <li key={key} className="font-mono text-[11px] text-gray-500 break-all">
                    {key}
                  </li>
                ))}
                {copy.evidence.length > 5 && (
                  <li className="text-[11px] italic text-gray-500">
                    and {copy.evidence.length - 5} more
                  </li>
                )}
              </ul>
            </li>
          );
        })}
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
    <PageContainer data-testid="cross-flag-list-view">
      <PageHeader
        title="Cross-submission flags"
        description="Findings that link two or more submissions, such as the same paste appearing in several students' work. Open a row to see who is involved and the supporting events."
      />

      {/* Filter bar */}
      <Panel>
        <form
          className="flex flex-wrap items-end gap-3"
          data-testid="cross-flag-filters"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="cf-heuristic">Heuristic</Label>
            <Input
              id="cf-heuristic"
              type="text"
              value={heuristicId}
              onChange={(e) => setHeuristicId(e.target.value)}
              placeholder="e.g. paste_shared_across_students"
              className="w-72"
              data-testid="filter-heuristic-id"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cf-severity">Min severity</Label>
            <NativeSelect
              id="cf-severity"
              value={severityMin ?? ''}
              onChange={(e) => {
                setSeverityMin((e.target.value as CrossFlagFilters['severityMin']) || undefined);
              }}
              className="w-36"
              data-testid="filter-severity-min"
            >
              <option value="">Any</option>
              <option value="info">Info</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </NativeSelect>
          </div>

          <div className="min-w-[16rem] flex-1 space-y-1.5">
            <Label htmlFor="cf-submission">Submission ID</Label>
            <Input
              id="cf-submission"
              type="text"
              value={submissionId}
              onChange={(e) => setSubmissionId(e.target.value)}
              placeholder="UUID"
              className="font-mono"
              data-testid="filter-submission-id"
            />
          </div>

          <Button type="submit" variant="outline" size="sm" data-testid="apply-filters-btn">
            Apply filters
          </Button>
        </form>
      </Panel>

      {/* Table */}
      {isLoading ? (
        <Panel>
          <p
            className="py-6 text-center text-sm text-muted-foreground"
            data-testid="cross-flag-loading"
          >
            Loading cross-flags…
          </p>
        </Panel>
      ) : (
        <>
          {/* Above the table on purpose: "no findings" must not be read before
              the reason some comparisons were never made. */}
          <CrossScopeExclusionPanel exclusions={displayExclusions} />

          <Panel flush>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Heuristic</TableHead>
                  <TableHead className="w-32">Severity</TableHead>
                  <TableHead className="w-32 text-right">Participants</TableHead>
                  <TableHead className="w-36 text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody data-testid="cross-flag-rows">
                {displayItems.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <EmptyState
                        title="No cross-flags found."
                        description="Nothing links submissions under the current filters."
                      />
                    </td>
                  </tr>
                )}
                {displayItems.map((item) => (
                  <TableRow key={item.id} data-testid={`cross-flag-row-${item.id}`}>
                    <TableCell className="font-mono text-xs text-gray-900">
                      <RowLink
                        to={`${basePath}/cross-flags/${item.id}`}
                        className="block rounded-sm hover:text-berkeley-700 hover:underline"
                      >
                        {item.heuristic_id}
                      </RowLink>
                    </TableCell>
                    <TableCell>
                      <SeverityBadge severity={item.severity} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.participants.length}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {new Date(item.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>

          {data?.next_cursor && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={handleLoadMore}
                disabled={isFetching}
                data-testid="load-more-btn"
              >
                {isFetching ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
