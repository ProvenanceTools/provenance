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
import { personLabel } from '../../lib/contributor-display.js';

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
// Participant card
// ---------------------------------------------------------------------------

function ParticipantCard({ participant }: { participant: CrossFlagParticipant }) {
  return (
    <div
      className="bg-white border border-gray-200 rounded p-4"
      data-testid={`participant-${participant.submission_id}`}
    >
      <div className="mb-2">
        {/*
          `student` is null when this participant is not on the semester's
          roster. Since 0029 they are still LISTED (the join is LEFT, so the
          evidence no longer silently disappears) — just not named. Neutral
          wording and the same styling as any named participant: not being on
          the roster is an administrative gap, not a finding.
        */}
        <p className="text-sm font-medium text-gray-800">{personLabel(participant.student)}</p>
        <p className="text-xs text-gray-500">
          {participant.student ? `SID: ${participant.student.sid} · ` : ''}
          {participant.assignment.assignment_id_str}
        </p>
        <p className="text-xs text-gray-400 font-mono truncate">sub: {participant.submission_id}</p>
      </div>
      {participant.supporting_seqs.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 mb-1">Supporting event seqs:</p>
          <p className="text-xs font-mono text-gray-600 break-all">
            {participant.supporting_seqs.slice(0, 20).join(', ')}
            {participant.supporting_seqs.length > 20 &&
              ` … (${participant.supporting_seqs.length} total)`}
          </p>
        </div>
      )}
    </div>
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

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center h-64 text-gray-500"
        data-testid="cross-flag-detail-loading"
      >
        Loading…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-8 text-center text-red-600" data-testid="cross-flag-detail-error">
        Failed to load cross-flag detail.
        <button
          onClick={() => void navigate(`${basePath}/cross-flags`)}
          className="ml-2 text-blue-600 underline"
        >
          Back to list
        </button>
      </div>
    );
  }

  const { item } = data;

  return (
    <div className="p-6 max-w-5xl mx-auto" data-testid="cross-flag-detail-view">
      {/* Back link */}
      <button
        onClick={() => void navigate(`${basePath}/cross-flags`)}
        className="text-xs text-blue-600 hover:underline mb-4 block"
        data-testid="back-to-list"
      >
        ← Back to cross-flags
      </button>

      {/* Header */}
      <div className="bg-white border border-gray-200 rounded p-4 mb-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="font-mono text-sm font-medium text-gray-800">{item.heuristic_id}</span>
          <SeverityBadge severity={item.severity} />
          <span className="text-xs text-gray-400">
            confidence: {(item.confidence * 100).toFixed(0)}%
          </span>
        </div>
        <p className="text-xs text-gray-400">
          Created: {new Date(item.created_at).toLocaleString()}
        </p>
        {item.detail !== null && item.detail !== undefined && (
          <details className="mt-2">
            <summary className="text-xs text-gray-500 cursor-pointer hover:underline">
              Detail JSON
            </summary>
            <pre className="mt-1 text-xs bg-gray-50 rounded p-2 overflow-auto max-h-32">
              {JSON.stringify(item.detail, null, 2)}
            </pre>
          </details>
        )}
      </div>

      {/* Participants */}
      <h2 className="text-sm font-semibold text-gray-700 mb-3">
        Participants ({item.participants.length})
      </h2>

      {/* Two-column layout for pairs (Phase 24: simple listing) */}
      {/* Phase 25 carry-over: wire v2 CompareView primitives for side-by-side diff */}
      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: `repeat(${Math.min(item.participants.length, 2)}, 1fr)`,
        }}
        data-testid="participants-grid"
      >
        {item.participants.map((p) => (
          <ParticipantCard key={p.submission_id} participant={p} />
        ))}
      </div>

      {item.participants.length === 0 && (
        <p className="text-sm text-gray-400">No participants recorded.</p>
      )}
    </div>
  );
}
