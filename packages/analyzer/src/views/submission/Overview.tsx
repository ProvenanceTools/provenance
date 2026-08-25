/**
 * Overview tab — summary card, sessions, validation summary, flags, files list.
 *
 * Phase 23. Consumes SubmissionDataProvider via useSubmissionData().
 * Works with both ApiSubmissionDataProvider and InMemorySubmissionDataProvider.
 *
 * Flags render through the same FlagDashboardPanel / HeuristicDetailDrawer that
 * /local uses, so a reviewer can open a flag and jump to the events behind it
 * instead of reading an inert list of heuristic ids.
 *
 * ## Loading the event index
 *
 * The drawer wants each supporting event's kind, file, time and session, which
 * means the full event index — the most expensive fetch in the app, and Overview
 * is the default tab. So the index is requested only once a drawer is actually
 * opened (`needsIndex`). Until it lands, supporting rows show their bare global
 * event number and their jump buttons still work: a supporting seq is a
 * globalIdx, which is all either destination needs to resolve the event, and
 * the session along with it.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';
import { useFullEventIndex } from '../../data/useFullEventIndex.js';
import { buildGlobalSeqLookup } from '../../data/global-seq-lookup.js';
import { FlagDashboardPanel } from '../overview/FlagDashboardPanel.js';
import {
  toFlagViewFromRow,
  pickFlagByHeuristic,
  type SupportingRef,
} from '../overview/flag-view.js';
import { SessionsCard } from './SessionsCard.js';
import { collectActiveExtensions } from '../../extensions/collect-active-extensions.js';
import { ActiveExtensionsCard } from '../../extensions/ActiveExtensionsCard.js';
import { AssignmentManifestCard } from '../../components/AssignmentManifestCard.js';
import { CoveragePanel } from '../coverage/CoveragePanel.js';
import { StatusRegion } from '../../components/a11y/StatusRegion.js';
import { ErrorRegion } from '../../components/a11y/ErrorRegion.js';
import {
  contributorLabel,
  contributorSid,
  contributorsLabel,
  contributorsSidLabel,
} from '../../lib/contributor-display.js';

// ---------------------------------------------------------------------------
// Severity chip
// ---------------------------------------------------------------------------

const SEVERITY_CLASSES: Record<string, string> = {
  high: 'bg-red-100 text-red-800',
  medium: 'bg-orange-100 text-orange-800',
  low: 'bg-yellow-100 text-yellow-800',
  info: 'bg-blue-100 text-blue-800',
};

function SeverityChip({ severity }: { severity: string }) {
  const cls = SEVERITY_CLASSES[severity] ?? 'bg-gray-100 text-gray-800';
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}
      data-testid={`severity-chip-${severity}`}
    >
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ValidationStatusBadge
// ---------------------------------------------------------------------------

function ValidationStatusBadge({ status }: { status: string }) {
  const label = status.toUpperCase();
  const cls =
    status === 'pass'
      ? 'bg-green-100 text-green-800'
      : status === 'warn'
        ? 'bg-yellow-100 text-yellow-800'
        : status === 'fail'
          ? 'bg-red-100 text-red-800'
          : 'bg-gray-100 text-gray-800';
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${cls}`}
      data-testid="validation-status-badge"
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Overview tab component
// ---------------------------------------------------------------------------

export function Overview() {
  const { submissionId = '' } = useParams<{ submissionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const provider = useSubmissionData();
  const summaryQuery = provider.useSummary();
  const flagsQuery = provider.useFlags();
  const validationQuery = provider.useValidation();
  const filesQuery = provider.useFiles();
  const extEventsQuery = provider.useEvents({ kind: ['ext.snapshot', 'ext.activate'] });

  // Deferred until a flag drawer is opened — see the module comment. Cached
  // under the same query key the Timeline and Replay tabs use, so this is at
  // worst a prefetch of work those tabs would do anyway.
  const [needsIndex, setNeedsIndex] = useState(false);
  const indexQuery = useFullEventIndex(submissionId, { enabled: needsIndex });
  const bySeq = useMemo(() => buildGlobalSeqLookup(indexQuery.data ?? null), [indexQuery.data]);

  const activeExtensions = useMemo(() => {
    const events = extEventsQuery.data ?? [];
    return collectActiveExtensions(
      events.filter((e) => e.kind === 'ext.snapshot'),
      events.filter((e) => e.kind === 'ext.activate'),
    );
  }, [extEventsQuery.data]);

  const flagViews = useMemo(
    () => (flagsQuery.data ?? []).map((row) => toFlagViewFromRow(row, bySeq)),
    [flagsQuery.data, bySeq],
  );

  // Dashboard deep-link: `?flag=<heuristic>` opens that flag's drawer on
  // arrival. Resolving to the flag's own id survives the index loading later
  // (the id comes off the flag row, not the event stream), and opening the
  // drawer needs the event index — the same load a manual click triggers.
  const flagParam = searchParams.get('flag');
  const openFlagId = useMemo(
    () => (flagParam ? pickFlagByHeuristic(flagViews, flagParam) : null),
    [flagParam, flagViews],
  );
  useEffect(() => {
    if (openFlagId) setNeedsIndex(true);
  }, [openFlagId]);

  const sessions = useMemo(() => summaryQuery.data?.sessions ?? [], [summaryQuery.data]);

  // Session id → 1-based ordinal, matching the numbering SessionsCard shows.
  const sessionOrdinals = useMemo(() => {
    const map = new Map<string, number>();
    sessions.forEach((s, i) => map.set(s.session_id, i + 1));
    return map;
  }, [sessions]);

  // Navigation is a tab switch on the current route, not a route change: the
  // submission shell is driven by ?tab=.
  const setTabParams = useCallback(
    (params: Record<string, string>) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(params)) next.set(key, value);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const handleJumpToTimeline = useCallback(
    (ref: SupportingRef) => setTabParams({ tab: 'timeline', seq: ref.timelineSeq }),
    [setTabParams],
  );

  const handleJumpToReplay = useCallback(
    (ref: SupportingRef) => {
      // Session is deliberately omitted when unresolved: Replay derives it from
      // ?event=, so this lands correctly even for a flag spanning sessions.
      if (ref.event !== null) {
        setTabParams({
          tab: 'replay',
          session: ref.event.sessionId,
          event: String(ref.event.globalIdx),
        });
      } else if (ref.globalIdx !== null) {
        setTabParams({ tab: 'replay', event: String(ref.globalIdx) });
      }
    },
    [setTabParams],
  );

  const handleOpenSession = useCallback(
    (sessionId: string) => setTabParams({ tab: 'replay', session: sessionId }),
    [setTabParams],
  );

  const handleDrawerOpen = useCallback(() => setNeedsIndex(true), []);

  if (summaryQuery.isLoading) {
    return (
      <StatusRegion className="p-8 text-gray-600">
        <div data-testid="overview-loading">Loading submission…</div>
      </StatusRegion>
    );
  }

  if (summaryQuery.isError) {
    return (
      <ErrorRegion className="p-8 text-red-600">
        <div data-testid="overview-error">Failed to load submission summary.</div>
      </ErrorRegion>
    );
  }

  const summary = summaryQuery.data;
  if (!summary) return null;

  // `contributors` is the authoritative "who is this submission about";
  // `student` is only the fallback for a response that predates it.
  const soloName = contributorsLabel(summary.contributors, { fallbackStudent: summary.student });
  const soloSid = contributorsSidLabel(summary.contributors, { fallbackStudent: summary.student });

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="submission-overview">
      {/* Summary card */}
      <section
        className="bg-white rounded-lg border border-gray-200 p-5 space-y-3"
        data-testid="summary-card"
      >
        <h2 className="text-xl font-semibold text-gray-900">Submission</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-sm">
          <div>
            <dt className="text-gray-500">
              {summary.contributors.length > 1 ? 'Contributors' : 'Student'}
            </dt>
            {/*
              Solo submissions keep the exact markup they had before the 0029
              cut-over: `contributors` holds one entry, the same person as
              `student`, so the label and sid below are byte-identical to
              `student.display_name` / `student.sid`. Only a group submission
              takes the list branch.
            */}
            <dd className="font-medium" data-testid="summary-student">
              {summary.contributors.length > 1 ? (
                <ul data-testid="summary-contributors" className="space-y-0.5">
                  {summary.contributors.map((c) => (
                    <li key={c.contributor_key} data-testid="summary-contributor">
                      {contributorLabel(c)}
                      {contributorSid(c) && (
                        <span className="ml-1 text-gray-600">({contributorSid(c)})</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <>
                  {soloName}
                  {soloSid && <span className="ml-1 text-gray-600">({soloSid})</span>}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Assignment</dt>
            <dd className="font-medium" data-testid="summary-assignment">
              {summary.assignment.label ?? summary.assignment.assignment_id_str}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Score</dt>
            <dd className="font-medium" data-testid="summary-score">
              {summary.score_total !== null ? summary.score_total.toFixed(1) : '—'}
              {summary.score_max_severity && (
                <span className="ml-2">
                  <SeverityChip severity={summary.score_max_severity} />
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Validation</dt>
            <dd data-testid="summary-validation">
              {summary.validation_status ? (
                <ValidationStatusBadge status={summary.validation_status} />
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Flag count</dt>
            <dd className="font-medium" data-testid="summary-flag-count">
              {summary.flag_count}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Ingested</dt>
            <dd className="font-medium" data-testid="summary-ingested-at">
              {new Date(summary.ingested_at).toLocaleDateString()}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Version</dt>
            <dd className="font-medium" data-testid="summary-version">
              v{summary.version_index}
            </dd>
          </div>
        </dl>
      </section>

      {/*
        Coverage — §6 Rule 3, per scope and always visible, above the verdict
        surfaces because it is the context a grader needs in order to READ them.

        The server now computes these facts on the bundle it already parsed for
        `sessions[]` and serves them on the summary, so this route shows the
        SAME facts `/local` does, from the same function.

        `?? null` is the honest answer for the one case that remains, and is not
        a stub: a server older than the `coverage` field sends nothing, and the
        panel says the facts were not sent. Synthesising an empty object here
        instead would render zeroes — "no commits observed, no contributors, no
        root key" — which is a stronger and FALSE claim than "not available".
      */}
      <CoveragePanel facts={summary.coverage ?? null} />

      {/* Manifest 2.0 metadata — renders nothing for a 1.x bundle with no
          disabled capture signals. */}
      <AssignmentManifestCard manifest={summary.assignment_manifest} />

      {/* Sessions — only rendered when there's more than one. */}
      <SessionsCard sessions={sessions} onOpenSession={handleOpenSession} />

      {/* Active extensions */}
      <ActiveExtensionsCard extensions={activeExtensions} />

      {/* Validation summary */}
      {validationQuery.data && (
        <section
          className="bg-white rounded-lg border border-gray-200 p-5"
          data-testid="validation-section"
        >
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Validation</h2>
            <ValidationStatusBadge status={validationQuery.data.overall} />
          </div>
          <div className="space-y-1">
            {validationQuery.data.checks.map((check) => (
              <div key={check.id} className="flex items-start gap-2 text-sm py-1">
                <span
                  className={
                    check.status === 'pass'
                      ? 'text-green-600'
                      : check.status === 'fail'
                        ? 'text-red-600'
                        : check.status === 'warn'
                          ? 'text-yellow-600'
                          : 'text-gray-600'
                  }
                  data-testid={`check-status-${check.id}`}
                >
                  {check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '–'}
                </span>
                {/* label is stored alongside every check; id is the fallback
                    for rows written before the API surfaced it. */}
                <span className="font-medium text-gray-700">{check.label ?? check.id}</span>
                {check.detail && <span className="text-gray-500 truncate">{check.detail}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Flags — same panel/drawer as /local, so each row opens its evidence. */}
      {flagsQuery.data && flagsQuery.data.length > 0 && (
        <div data-testid="flags-section">
          <FlagDashboardPanel
            flags={flagViews}
            onJumpToTimeline={handleJumpToTimeline}
            onJumpToReplay={handleJumpToReplay}
            sessionOrdinals={sessionOrdinals}
            onDrawerOpen={handleDrawerOpen}
            openFlagId={openFlagId}
          />
        </div>
      )}

      {/* Files list */}
      {filesQuery.data && filesQuery.data.files.length > 0 && (
        <section
          className="bg-white rounded-lg border border-gray-200 p-5"
          data-testid="files-section"
        >
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Files ({filesQuery.data.files.length})
          </h2>
          <div className="space-y-1">
            {filesQuery.data.files.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-3 text-sm py-1.5"
                data-testid={`file-row-${file.path}`}
              >
                <code className="text-gray-700 flex-1">{file.path}</code>
                <span className="text-gray-500 text-xs">{file.saves} saves</span>
                {file.reconstruction_tainted && (
                  <span
                    className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded"
                    title="File reconstruction tainted (external edits or large paste)"
                  >
                    tainted
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
