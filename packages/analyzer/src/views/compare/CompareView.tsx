/**
 * CompareView — cross-submission analysis landing page.
 *
 * Phase 11 shipped only the shell: bundle selector + placeholder stub.
 * Phase 18 fills in the cross-submission heuristic table.
 *
 * Layout:
 *   1. Bundle selector — checkbox list (unchanged from Phase 11).
 *   2. Cross-submission findings table — one row per CrossFlag. Clicking a
 *      row opens a side-by-side static pane showing, for each involved bundle,
 *      the seq key list for the supporting events (deep-links into /timeline).
 *      Animated split-replay is deferred to v2.1 per spec.
 *   3. "No findings" empty state when crossFlags is empty.
 *
 * Cross-flags are computed by BundleContext's useEffect and stored in
 * `ctx.crossFlags`. This component filters them by the currently-selected
 * bundle subset (the user's checkbox selection) and renders the result.
 *
 * PRD refs: §7.4 cross-submission heuristics, §8 v2.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBundle } from '../../context/BundleContext.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { CrossFlag } from '@provenance/analysis-core/heuristics/cross/types.js';
import type { SameScopeExclusion } from '@provenance/analysis-core/coverage/cross-scope.js';

// ---------------------------------------------------------------------------
// Severity chip colours (same mapping as SeverityChip in overview)
// ---------------------------------------------------------------------------

const SEVERITY_CLASSES: Record<string, string> = {
  high: 'bg-red-100 text-red-800 border-red-300',
  medium: 'bg-amber-100 text-amber-800 border-amber-300',
  low: 'bg-blue-100 text-blue-800 border-blue-300',
  info: 'bg-gray-100 text-gray-700 border-gray-300',
};

function SeverityChip({ severity }: { severity: string }) {
  const cls = SEVERITY_CLASSES[severity] ?? SEVERITY_CLASSES['info']!;
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// CrossFlagDetailPane — side-by-side static state for a selected cross-flag.
//
// Shows: for each involved bundle, the list of supporting seq keys as
// deep-links into /timeline?seq=<key>. Animated split-replay is v2.1 polish.
// ---------------------------------------------------------------------------

type CrossFlagDetailPaneProps = {
  flag: CrossFlag;
  bundles: Bundle[];
  onClose(): void;
};

function CrossFlagDetailPane({ flag, bundles, onClose }: CrossFlagDetailPaneProps) {
  const bundleMap = new Map(bundles.map((b) => [b.id, b]));
  const navigate = useNavigate();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      data-testid="cross-flag-detail-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={flag.title}
    >
      <div className="bg-background border rounded-lg shadow-lg w-full max-w-3xl mx-4 p-6 space-y-4 max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <SeverityChip severity={flag.severity} />
              <span className="text-xs text-muted-foreground font-mono">{flag.heuristic}</span>
            </div>
            <h2 className="break-words text-base font-semibold">{flag.title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 rounded"
            aria-label="Close"
            data-testid="cross-flag-detail-close"
          >
            ✕
          </button>
        </div>

        {/* Description */}
        <p className="break-words text-sm text-muted-foreground">{flag.description}</p>

        {/* Side-by-side bundle evidence */}
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: `repeat(${flag.bundleIds.length}, 1fr)` }}
          data-testid="cross-flag-bundle-panels"
        >
          {flag.bundleIds.map((bundleId) => {
            const bundle = bundleMap.get(bundleId);
            const seqKeys = flag.eventsPerBundle[bundleId] ?? [];
            return (
              <div key={bundleId} className="rounded border p-3 space-y-2">
                <p className="text-xs font-semibold truncate" title={bundle?.sourceFilename}>
                  {bundle?.sourceFilename ?? bundleId}
                </p>
                {seqKeys.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No supporting events.</p>
                ) : (
                  <ul className="space-y-1" data-testid={`cross-flag-events-${bundleId}`}>
                    {seqKeys.map((key) => (
                      <li key={key}>
                        <button
                          type="button"
                          onClick={() =>
                            void navigate(`/local/timeline?seq=${encodeURIComponent(key)}`)
                          }
                          className="text-xs font-mono text-blue-600 hover:underline focus:outline-none focus:underline"
                          data-testid={`cross-flag-seq-link-${key}`}
                        >
                          {key}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>

        {/* Detail JSON */}
        {flag.detail !== undefined && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Detail
            </summary>
            <pre className="mt-2 rounded bg-muted p-3 overflow-x-auto text-xs font-mono">
              {JSON.stringify(flag.detail, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SameScopeExclusionPanel — what was NOT compared, and why.
//
// Spec S20 requires excluded pairs be VISIBLY excluded rather than silently
// dropped, or the system has just become quieter with no explanation. §6 Rule 3
// fixes the register: a statement about the recording ("these two archives are
// one repository"), never a finding about anyone. So this is not a flag, has no
// severity, carries no score, and deliberately renders in the neutral coverage
// styling rather than the finding styling used by the table below.
// ---------------------------------------------------------------------------

function SameScopeExclusionPanel({ exclusions }: { exclusions: SameScopeExclusion[] }) {
  if (exclusions.length === 0) return null;

  return (
    <section aria-labelledby="cross-exclusions-heading" data-testid="cross-scope-exclusions">
      <h2 id="cross-exclusions-heading" className="text-base font-semibold mb-1">
        Not cross-compared
      </h2>
      <p className="text-sm text-muted-foreground mb-3">
        These submissions are the same repository: each archive contains the other&rsquo;s recorded
        sessions, so a match between them says nothing about sharing between students.
        Cross-comparison between them is not applicable. Every other pair was compared normally.
      </p>
      <ul className="space-y-3" role="list">
        {exclusions.map((ex) => (
          <li
            key={ex.bundleIds.join('|')}
            className="rounded border bg-muted/30 p-3"
            data-testid={`cross-scope-exclusion-${ex.bundleIds.join('|')}`}
          >
            <p className="text-sm font-medium">{ex.sourceFilenames.join(' · ')}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Same repository lineage —{' '}
              {ex.excludedPairCount === 1
                ? '1 comparison not applicable'
                : `${ex.excludedPairCount} comparisons not applicable`}
              . Established by {ex.sharedCommits.length}{' '}
              {ex.sharedCommits.length === 1 ? 'commit reference' : 'commit references'} shared
              across these archives.
            </p>
            <ul className="mt-2 space-y-0.5" data-testid="cross-scope-exclusion-commits">
              {ex.sharedCommits.slice(0, 5).map((key) => (
                <li key={key} className="font-mono text-[11px] text-muted-foreground break-all">
                  {key}
                </li>
              ))}
              {ex.sharedCommits.length > 5 && (
                <li className="text-[11px] text-muted-foreground italic">
                  and {ex.sharedCommits.length - 5} more
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
// CrossFlagTable
// ---------------------------------------------------------------------------

type CrossFlagTableProps = {
  flags: CrossFlag[];
  bundles: Bundle[];
};

function CrossFlagTable({ flags, bundles }: CrossFlagTableProps) {
  const [selectedFlag, setSelectedFlag] = useState<CrossFlag | null>(null);
  const bundleMap = new Map(bundles.map((b) => [b.id, b]));

  if (flags.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic" data-testid="cross-flags-empty">
        No cross-submission findings for the selected bundles.
      </p>
    );
  }

  return (
    <>
      <div className="overflow-x-auto rounded border" data-testid="cross-flags-table">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Severity</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Heuristic</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Finding</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Bundles</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {flags.map((flag) => (
              <tr
                key={flag.id}
                className="border-b last:border-0 hover:bg-muted/30 cursor-pointer"
                onClick={() => setSelectedFlag(flag)}
                data-testid={`cross-flag-row-${flag.id}`}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelectedFlag(flag);
                }}
              >
                <td className="px-4 py-2">
                  <SeverityChip severity={flag.severity} />
                </td>
                <td className="max-w-[180px] px-4 py-2 font-mono text-xs text-muted-foreground">
                  <span className="block truncate" title={flag.heuristic}>
                    {flag.heuristic}
                  </span>
                </td>
                <td className="max-w-[300px] px-4 py-2">
                  <span className="block truncate" title={flag.title}>
                    {flag.title}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <ul className="space-y-0.5">
                    {flag.bundleIds.map((id) => (
                      <li key={id} className="text-xs text-muted-foreground truncate max-w-[160px]">
                        {bundleMap.get(id)?.sourceFilename ?? id}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-4 py-2 text-xs">{(flag.confidence * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail pane overlay (click-a-row → open) */}
      {selectedFlag !== null && (
        <CrossFlagDetailPane
          flag={selectedFlag}
          bundles={bundles}
          onClose={() => setSelectedFlag(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// CompareView
// ---------------------------------------------------------------------------

export function CompareView() {
  const { bundles, crossFlags, crossScopeExclusions, selectBundle, selectedBundleId } = useBundle();

  // Locally track which bundles are selected for comparison (multi-select).
  // Default: all loaded bundles selected.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(bundles.map((b) => b.id)),
  );

  // Auto-check bundles that arrive after mount (e.g. user loads a 3rd bundle
  // via the Header while CompareView is already mounted). Without this, the new
  // bundle's id is never added to selectedIds, so cross-flags involving it are
  // silently hidden (the `every` filter in visibleCrossFlags requires all
  // involved bundles to be selected).
  //
  // Functional-updater + changed flag: preserves reference equality when
  // nothing changed, avoiding spurious re-renders.
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const b of bundles) {
        if (!next.has(b.id)) {
          next.add(b.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [bundles]);

  const toggleBundle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectedBundles: Bundle[] = bundles.filter((b) => selectedIds.has(b.id));

  // Filter cross-flags to only those where ALL involved bundles are selected.
  const selectedIdSet = selectedIds;
  const visibleCrossFlags = crossFlags.filter((f) =>
    f.bundleIds.every((id) => selectedIdSet.has(id)),
  );

  // An exclusion is shown once at least TWO of its members are selected —
  // that is the point at which the user is looking at a comparison that did not
  // happen. Filtering on `every` would hide the explanation for a partly
  // selected group, which is the silence S20 forbids.
  const visibleExclusions: SameScopeExclusion[] = [];
  for (const ex of crossScopeExclusions) {
    const kept = ex.bundleIds
      .map((id, i) => ({ id, name: ex.sourceFilenames[i] ?? id }))
      .filter((m) => selectedIdSet.has(m.id));
    if (kept.length < 2) continue;
    visibleExclusions.push({
      ...ex,
      bundleIds: kept.map((m) => m.id),
      sourceFilenames: kept.map((m) => m.name),
      excludedPairCount: (kept.length * (kept.length - 1)) / 2,
    });
  }

  return (
    <div className="container mx-auto py-8 space-y-8" data-testid="compare-view">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Cross-Submission Comparison</h1>
        <p className="text-muted-foreground mt-1">
          Select bundles to compare. Cross-submission heuristic findings appear below.
        </p>
      </div>

      {/* Bundle selector */}
      <section aria-labelledby="bundle-selector-heading">
        <h2 id="bundle-selector-heading" className="text-base font-semibold mb-3">
          Select bundles to compare
        </h2>
        <ul className="space-y-2" role="list" data-testid="compare-bundle-list">
          {bundles.map((b) => {
            const isChecked = selectedIds.has(b.id);
            const isActive = b.id === selectedBundleId;
            return (
              <li key={b.id} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id={`compare-bundle-${b.id}`}
                  checked={isChecked}
                  onChange={() => toggleBundle(b.id)}
                  data-testid={`compare-checkbox-${b.id}`}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300"
                  aria-label={`Include ${b.sourceFilename} in comparison`}
                />
                <label htmlFor={`compare-bundle-${b.id}`} className="flex flex-col cursor-pointer">
                  <span className="text-sm font-medium">
                    {b.sourceFilename}
                    {isActive && (
                      <span className="ml-2 text-xs text-muted-foreground">(active)</span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {b.manifest.assignment_id} · {b.sessions.length}{' '}
                    {b.sessions.length === 1 ? 'session' : 'sessions'} · loaded{' '}
                    {new Date(b.loadedAt).toLocaleTimeString()}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => selectBundle(b.id)}
                  className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline focus:outline-none focus:underline"
                  data-testid={`compare-activate-${b.id}`}
                >
                  View
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Comparison summary */}
      {selectedBundles.length >= 2 && (
        <section aria-labelledby="compare-summary-heading">
          <h2 id="compare-summary-heading" className="text-base font-semibold mb-3">
            Comparing {selectedBundles.length} bundles
          </h2>
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
            {selectedBundles.map((b) => (
              <li key={b.id}>{b.sourceFilename}</li>
            ))}
          </ul>
        </section>
      )}

      {selectedBundles.length < 2 && (
        <p className="text-sm text-amber-700" data-testid="compare-need-more">
          Select at least 2 bundles above to enable comparison.
        </p>
      )}

      {/* Cross-submission heuristic findings */}
      <section aria-labelledby="cross-heuristics-heading">
        <h2 id="cross-heuristics-heading" className="text-base font-semibold mb-3">
          Cross-submission findings
        </h2>
        {selectedBundles.length < 2 ? (
          <p className="text-sm text-muted-foreground italic" data-testid="cross-flags-need-more">
            Select at least 2 bundles to see cross-submission findings.
          </p>
        ) : (
          <CrossFlagTable flags={visibleCrossFlags} bundles={selectedBundles} />
        )}
      </section>

      {/* What was deliberately NOT compared, and why (spec S20). */}
      {selectedBundles.length >= 2 && <SameScopeExclusionPanel exclusions={visibleExclusions} />}
    </div>
  );
}
