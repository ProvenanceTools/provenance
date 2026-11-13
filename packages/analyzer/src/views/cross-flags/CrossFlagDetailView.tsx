/**
 * CrossFlagDetailView — single cross-flag detail page.
 *
 * Phase 24. Route: /s/:courseSlug/:semesterSlug/cross-flags/:crossFlagId
 *
 * Shows:
 * - Heuristic ID, severity, confidence, detail jsonb.
 * - Participants list — student + assignment + supporting_seqs.
 * - Two-column listing of supporting_seqs per participant pair.
 *
 * NOTE: v2 CompareView integration is deferred to Phase 25.
 * This renders a simple two-column layout of supporting_seqs per participant.
 */

import { useParams, useNavigate } from 'react-router-dom';
import { useCrossFlagDetail } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import type { CrossFlagParticipant } from '@provenance/shared/api-schemas';
import {
  contributorsLabel,
  contributorsSidLabel,
  personLabel,
} from '../../lib/contributor-display.js';
import { ArrowLeft } from 'lucide-react';
import { PageContainer, PageHeader, Panel } from '@/components/layout/Page';
import { Card } from '@/components/ui/card';
import { SeverityBadge } from './SeverityBadge.js';

// ---------------------------------------------------------------------------
// Participant card
// ---------------------------------------------------------------------------

function ParticipantCard({ participant }: { participant: CrossFlagParticipant }) {
  // Empty when nobody in the list is on the roster — the SID line is then
  // dropped entirely rather than rendering a bare "SID: ".
  const sids = contributorsSidLabel(participant.contributors, {
    fallbackStudent: participant.student,
  })
    .split(', ')
    .filter((s) => s !== '')
    .join(', ');

  return (
    <Card className="p-4" data-testid={`participant-${participant.submission_id}`}>
      <div className="mb-3 space-y-0.5">
        {/*
          EVERY contributor, not the submitter of record.
          `participant.student` is one person; a group submission is
          attributable to several, so naming only that one puts a cross-flag —
          a finding about sharing between students — against an arbitrary
          partner while hiding the rest.

          A contributor with no `student` is not on the semester's roster.
          They are still LISTED (the join is LEFT, so the evidence no longer
          silently disappears) — just not named, with neutral wording and the
          same styling as any named participant: not being on the roster is an
          administrative gap, not a finding.

          `fallbackStudent` covers a response that predates `contributors`.
        */}
        <p className="text-sm font-semibold text-gray-900">
          {contributorsLabel(participant.contributors, {
            fallbackStudent: participant.student,
          }) || personLabel(null)}
        </p>
        <p className="text-xs text-gray-500">
          {sids ? `SID: ${sids} · ` : ''}
          {participant.assignment.assignment_id_str}
        </p>
        <p className="truncate font-mono text-xs text-gray-400">sub: {participant.submission_id}</p>
      </div>
      {participant.supporting_seqs.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
            Supporting event seqs
          </p>
          <p className="break-all rounded-md bg-gray-50 p-2 font-mono text-xs text-gray-700">
            {participant.supporting_seqs.slice(0, 20).join(', ')}
            {participant.supporting_seqs.length > 20 &&
              ` … (${participant.supporting_seqs.length} total)`}
          </p>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// CrossFlagDetailView
// ---------------------------------------------------------------------------

export function CrossFlagDetailView() {
  const { crossFlagId = '' } = useParams<{ crossFlagId: string }>();
  const navigate = useNavigate();
  const { basePath } = useActiveSemester();

  const { data, isLoading, isError } = useCrossFlagDetail(crossFlagId);

  const backLink = (
    <button
      onClick={() => void navigate(`${basePath}/cross-flags`)}
      className="inline-flex items-center gap-1 text-sm text-berkeley-700 hover:underline"
      data-testid="back-to-list"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Back to cross-flags
    </button>
  );

  if (isLoading) {
    return (
      <PageContainer>
        <p
          className="flex h-64 items-center justify-center text-sm text-muted-foreground"
          data-testid="cross-flag-detail-loading"
        >
          Loading…
        </p>
      </PageContainer>
    );
  }

  if (isError || !data) {
    return (
      <PageContainer>
        {backLink}
        <Panel>
          <p
            className="py-6 text-center text-sm text-red-600"
            data-testid="cross-flag-detail-error"
          >
            Failed to load cross-flag detail.
          </p>
        </Panel>
      </PageContainer>
    );
  }

  const { item } = data;

  return (
    <PageContainer data-testid="cross-flag-detail-view">
      <PageHeader
        eyebrow={backLink}
        title={<span className="font-mono text-xl">{item.heuristic_id}</span>}
      />

      {/* Summary */}
      <Panel>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <div className="space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Severity</dt>
            <dd>
              <SeverityBadge severity={item.severity} />
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Confidence
            </dt>
            <dd className="text-sm font-medium text-gray-900 tabular-nums">
              {(item.confidence * 100).toFixed(0)}%
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Participants
            </dt>
            <dd className="text-sm font-medium text-gray-900 tabular-nums">
              {item.participants.length}
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Created</dt>
            <dd className="text-sm text-gray-900">{new Date(item.created_at).toLocaleString()}</dd>
          </div>
        </dl>
        {item.detail !== null && item.detail !== undefined && (
          <details className="mt-4 border-t pt-3">
            <summary className="cursor-pointer text-xs font-medium text-gray-600 hover:text-gray-900">
              Detail JSON
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-gray-50 p-3 text-xs">
              {JSON.stringify(item.detail, null, 2)}
            </pre>
          </details>
        )}
      </Panel>

      {/* Participants */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-gray-900">Participants</h2>

        {/* Phase 25 carry-over: wire v2 CompareView primitives for side-by-side diff */}
        <div className="grid gap-4 md:grid-cols-2" data-testid="participants-grid">
          {item.participants.map((p) => (
            <ParticipantCard key={p.submission_id} participant={p} />
          ))}
        </div>

        {item.participants.length === 0 && (
          <p className="text-sm text-muted-foreground">No participants recorded.</p>
        )}
      </section>
    </PageContainer>
  );
}
