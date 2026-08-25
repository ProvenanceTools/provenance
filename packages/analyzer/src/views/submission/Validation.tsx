/**
 * Validation tab — full implementation (Phase 23).
 *
 * Reads provider.useValidation() and renders all 8 check rows + overall status.
 * Replaces ValidationStub.
 *
 * These results are NOT computed on view. The server runs validation once, at
 * ingest, and every read serves that stored `validation_results` row — which is
 * deliberate (a re-run per page load would be expensive and non-deterministic
 * across code changes). But a verdict with no date on it reads as current, so
 * the panel prints when it was computed. `validated_at` was on the wire and in
 * the OpenAPI schema all along; the client Zod schema was dropping it, which
 * left staleness impossible to display even in principle.
 */

import { CheckCircle2, XCircle, AlertCircle, Circle } from 'lucide-react';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';
import type { ValidationCheckResult } from '../../data/SubmissionDataProvider.js';
import { StatusRegion } from '../../components/a11y/StatusRegion.js';
import { ErrorRegion } from '../../components/a11y/ErrorRegion.js';

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const overallVariant: Record<string, string> = {
  pass: 'bg-green-100 text-green-800 border-green-200',
  warn: 'bg-amber-100 text-amber-800 border-amber-200',
  fail: 'bg-red-100 text-red-800 border-red-200',
};

const overallLabel: Record<string, string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
};

// ---------------------------------------------------------------------------
// validated_at formatting
// ---------------------------------------------------------------------------

/**
 * Local-time rendering of the ISO timestamp, matching SessionsCard. Falls back
 * to the raw string rather than printing "Invalid Date" if the server ever sends
 * something unparseable.
 */
function formatValidatedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// ---------------------------------------------------------------------------
// CheckRow
// ---------------------------------------------------------------------------

function CheckRow({ check }: { check: ValidationCheckResult }) {
  const icon =
    check.status === 'pass' ? (
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
    ) : check.status === 'fail' ? (
      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
    ) : check.status === 'warn' ? (
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
    ) : (
      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
    );

  const rowBg =
    check.status === 'pass'
      ? 'bg-green-50'
      : check.status === 'fail'
        ? 'bg-red-50'
        : check.status === 'warn'
          ? 'bg-amber-50'
          : '';

  return (
    <div
      className={`flex items-start gap-3 rounded-md px-3 py-2.5 ${rowBg}`}
      data-testid={`check-row-${check.id}`}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <p
          className={`text-sm font-medium ${
            check.status === 'pass'
              ? 'text-green-700'
              : check.status === 'fail'
                ? 'text-red-700'
                : check.status === 'warn'
                  ? 'text-amber-700'
                  : 'text-gray-500'
          }`}
        >
          {check.id}
        </p>
        {check.detail != null && <p className="mt-0.5 text-xs text-gray-500">{check.detail}</p>}
      </div>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
          check.status === 'pass'
            ? 'bg-green-100 text-green-700'
            : check.status === 'fail'
              ? 'bg-red-100 text-red-700'
              : check.status === 'warn'
                ? 'bg-amber-100 text-amber-700'
                : 'bg-gray-100 text-gray-500'
        }`}
        data-testid={`check-status-${check.id}`}
      >
        {check.status.toUpperCase()}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function Validation() {
  const provider = useSubmissionData();
  const { data, isLoading, isError } = provider.useValidation();

  if (isLoading) {
    return (
      <StatusRegion className="container mx-auto py-12 text-center text-gray-600">
        <p className="text-sm" data-testid="validation-loading">
          Loading validation results…
        </p>
      </StatusRegion>
    );
  }

  if (isError || !data) {
    return (
      <ErrorRegion className="container mx-auto py-12 text-center text-red-400">
        <p className="text-sm" data-testid="validation-error">
          Failed to load validation results.
        </p>
      </ErrorRegion>
    );
  }

  const badgeClass = overallVariant[data.overall] ?? 'bg-gray-100 text-gray-700 border-gray-200';
  const badgeLabel = overallLabel[data.overall] ?? data.overall.toUpperCase();

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8" data-testid="validation-panel">
      {/* Overall status */}
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Validation Report</h2>
        <span
          className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-semibold ${badgeClass}`}
          data-testid="overall-validation-badge"
        >
          {badgeLabel}
        </span>
      </div>

      {/* When these results were computed. Absent only on the in-browser
          provider, which recomputes on load and so has no staleness to state. */}
      {data.validated_at !== undefined && (
        <p className="mb-4 text-xs text-gray-500" data-testid="validation-computed-at">
          Computed once at ingest, on {formatValidatedAt(data.validated_at)}. These results are
          served as recorded then, not recomputed for this page.
        </p>
      )}

      {/* Check rows */}
      <div className="space-y-1 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        {data.checks.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">No validation checks available.</p>
        ) : (
          data.checks.map((check) => <CheckRow key={check.id} check={check} />)
        )}
      </div>
    </div>
  );
}
