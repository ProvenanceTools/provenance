/**
 * TuningView — heuristic weight + enable/disable tuning with an impact preview.
 *
 * Phase 24. Route: /s/:courseSlug/:semesterSlug/tuning
 *
 * Layout (a full-width workspace page):
 * - Header: title + one-line explanation of what weight and on/off do.
 * - Body: every tunable id, grouped into three panels (event-stream
 *   heuristics, integrity flags, cross-submission). Each row is a
 *   `HeuristicRow`: name, weight slider, on/off switch, and a modified dot +
 *   per-row reset when it differs from the active config.
 * - Sticky footer, only while there are unsaved changes: change count, the
 *   impact summary, [Details] (histogram + top movers), [Discard] and
 *   [Save & recompute].
 *
 * When a dry-run runs:
 * - Never on page open, and never for a candidate equal to the active config
 *   — that compares the config with itself and can take minutes server-side.
 * - Automatically (400ms debounce) when the candidate only changes weights
 *   and/or turns heuristics off: the server answers those from stored flags.
 * - Only on an explicit [Preview impact] click when any heuristic goes from
 *   disabled (active) to enabled (candidate): that forces the server to re-run
 *   heuristics over every submission.
 * - Each result is stored under the key of the candidate it was requested
 *   for and only displayed while the candidate still has that key; a result
 *   from a superseded request is dropped, so it can never overwrite a newer one.
 *
 * Commit:
 * - Recompute progress tracked via URL query param ?recompute_job=<id> so refresh works.
 * - 409 CONFIG_VERSION_CONFLICT → toast.
 * - If-Match header set to current active config version.
 */

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useActiveSemester } from '../../api/use-active-semester.js';
import { useActiveConfig, useCommitConfig, useDryRunConfig } from '../../api/queries.js';
import type { HeuristicConfigBody } from '@provenance/shared/api-schemas';
import {
  ALL_FLAG_IDS,
  CROSS_SUBMISSION_HEURISTIC_IDS,
  INTEGRITY_FLAG_IDS,
  PER_SUBMISSION_HEURISTIC_IDS,
} from '@provenance/analysis-core/heuristics/known-flag-ids.js';
import { PageHeader, Panel } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { RecomputeProgress } from './RecomputeProgress.js';
import { HeuristicRow } from './HeuristicRow.js';
import { ImpactDetailsDialog } from './ImpactDetailsDialog.js';
import {
  candidateKey,
  flagSetting,
  humanizeId,
  impactSummary,
  isFlagModified,
  modifiedIds,
  reEnabledIds,
  resetFlag,
  updateFlag,
  type DryRunDiffBody,
} from './tuning-model.js';

// ---------------------------------------------------------------------------
// All known heuristic/flag IDs.
//
// A 2026-08 audit found this list had hand-drifted from the real set (it was
// missing `inter_session_external_change`) while looking internally
// consistent. Derived from analysis-core's known-flag-ids.ts — the single
// source of truth for every id the engine can produce — instead of a
// hand-maintained duplicate, so it cannot drift again. See
// heuristics-doc-sync.test.ts for the regression guard on docs/heuristics.md.
//
// ALL_FLAG_IDS is exactly the concatenation of the three groups below, so
// the grouped panels render the same set of ids. Retired ids
// (RETIRED_FLAG_IDS) are deliberately absent: nothing emits them, but a
// stored config's entry for one is carried through untouched on save.
// ---------------------------------------------------------------------------

const KNOWN_HEURISTIC_IDS = ALL_FLAG_IDS;

const GROUPS: { slug: string; title: string; description: string; ids: readonly string[] }[] = [
  {
    slug: 'event-stream',
    title: 'Event-stream heuristics',
    description: "Detections computed from each submission's recorded event stream.",
    ids: PER_SUBMISSION_HEURISTIC_IDS,
  },
  {
    slug: 'integrity',
    title: 'Integrity flags',
    description: 'Raised when a bundle fails a validation or bundle-integrity check.',
    ids: INTEGRITY_FLAG_IDS,
  },
  {
    slug: 'cross-submission',
    title: 'Cross-submission',
    description: 'Compare submissions with each other.',
    ids: CROSS_SUBMISSION_HEURISTIC_IDS,
  },
];

// ---------------------------------------------------------------------------
// Cross-submission heuristics: weight does not apply.
//
// `cross_flags` has no `score_contribution`/`weight_at_compute` column, and
// cross flags feed no score anywhere — only per-submission `flags` rows reach
// computeScore → submissions.score_total. So for these ids the weight slider
// cannot do anything; dragging it would let staff believe they'd changed how
// a cross flag is weighted when nothing downstream reads that value. The
// enable/disable toggle (per_flag.enabled, honoured by run-cross.ts) is real
// and stays fully functional. Derived from analysis-core's
// CROSS_HEURISTIC_REGISTRY via known-flag-ids.ts so a future third cross
// heuristic inherits this automatically.
const CROSS_SUBMISSION_HEURISTIC_ID_SET = new Set(CROSS_SUBMISSION_HEURISTIC_IDS);

// ---------------------------------------------------------------------------
// paste_matches_known_source: no corpus source exists, so it can never fire.
//
// The heuristic matches pastes against `config.pasteMatchesKnownSource.corpus`
// (see analysis-core/heuristics/config.ts), which defaults to `[]` and has no
// upload path, storage, or config plumbing anywhere in packages/server/src or
// packages/analyzer/src — course staff have no way to populate it. Ships
// registered (so a future corpus feature can wire it up) but is inert in
// every deployed semester today.
//
// Unlike the cross-submission case, BOTH controls are meaningless here, not
// just weight: with an empty corpus the heuristic emits 0 flags regardless of
// enabled/disabled, so letting staff flip either control would imply a lever
// that does nothing. Both are disabled, with a visible explanation — see
// docs/heuristics.md for the staff-facing version of this note.
const INERT_HEURISTIC_IDS = new Set<string>(['paste_matches_known_source']);

/** Debounce between the last edit and an automatic (fast-path) dry-run. */
export const AUTO_PREVIEW_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configFromActive(active: { config: HeuristicConfigBody }): HeuristicConfigBody {
  // Deep clone so mutations don't affect cached query data
  return JSON.parse(JSON.stringify(active.config)) as HeuristicConfigBody;
}

function reEnableMessage(ids: readonly string[]): string {
  const first = humanizeId(ids[0]!);
  const others = ids.length - 1;
  const subject =
    others === 0
      ? first
      : `${first} and ${others} other ${others === 1 ? 'heuristic' : 'heuristics'}`;
  return `Re-enabling ${subject} requires re-running heuristics on every submission (can take minutes).`;
}

// ---------------------------------------------------------------------------
// TuningView
// ---------------------------------------------------------------------------

export function TuningView() {
  const { semesterId, semesterSlug } = useActiveSemester();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: activeConfig, isLoading: configLoading } = useActiveConfig(semesterId);

  // Local candidate config — initialized from active config once it loads.
  const [candidate, setCandidate] = useState<HeuristicConfigBody | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Dry-run results, each tagged with the candidate key it was computed for.
  const [preview, setPreview] = useState<{ key: string; diff: DryRunDiffBody } | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const dryRunMutation = useDryRunConfig(semesterId);
  const commitMutation = useCommitConfig(semesterId);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request id: only the latest dry-run request may write results.
  const requestSeqRef = useRef(0);

  // Recompute job tracking via URL query param
  const recomputeJobId = searchParams.get('recompute_job') ?? '';

  // Initialize candidate from active config. No dry-run: the candidate equals
  // the active config, so there is nothing to preview.
  useEffect(() => {
    if (activeConfig && candidate === null) {
      setCandidate(configFromActive(activeConfig));
    }
  }, [activeConfig, candidate]);

  // Shutdown path for the debounce timer and any in-flight request.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      requestSeqRef.current++;
    },
    [],
  );

  function clearDebounce() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
  }

  function runDryRun(config: HeuristicConfigBody) {
    if (!activeConfig) return;
    const key = candidateKey(KNOWN_HEURISTIC_IDS, config);
    const seq = ++requestSeqRef.current;
    setPendingKey(key);
    setErrorKey(null);
    dryRunMutation.mutateAsync({ config, currentVersion: activeConfig.version }).then(
      (result) => {
        if (seq !== requestSeqRef.current) return; // superseded
        setPreview({ key, diff: result.diff });
        setPendingKey(null);
      },
      () => {
        if (seq !== requestSeqRef.current) return; // superseded
        setErrorKey(key);
        setPendingKey(null);
      },
    );
  }

  /** After an edit: debounce a dry-run only when the server's fast path applies. */
  function scheduleAutoPreview(next: HeuristicConfigBody) {
    clearDebounce();
    if (!activeConfig) return;
    const active = activeConfig.config;
    if (modifiedIds(KNOWN_HEURISTIC_IDS, active, next).length === 0) return;
    if (reEnabledIds(KNOWN_HEURISTIC_IDS, active, next).length > 0) return;
    if (preview?.key === candidateKey(KNOWN_HEURISTIC_IDS, next)) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      runDryRun(next);
    }, AUTO_PREVIEW_DEBOUNCE_MS);
  }

  function applyEdit(next: HeuristicConfigBody) {
    setCandidate(next);
    scheduleAutoPreview(next);
  }

  function handleToggle(heuristicId: string, enabled: boolean) {
    if (!candidate) return;
    applyEdit(updateFlag(candidate, heuristicId, { enabled }));
  }

  function handleWeight(heuristicId: string, weight: number) {
    if (!candidate) return;
    applyEdit(updateFlag(candidate, heuristicId, { weight }));
  }

  function handleRowReset(heuristicId: string) {
    if (!candidate || !activeConfig) return;
    applyEdit(resetFlag(activeConfig.config, candidate, heuristicId));
  }

  function handleDiscard() {
    if (!activeConfig) return;
    clearDebounce();
    requestSeqRef.current++; // drop any in-flight dry-run
    setPendingKey(null);
    setErrorKey(null);
    setPreview(null);
    setDetailsOpen(false);
    setCandidate(configFromActive(activeConfig));
    dryRunMutation.reset();
  }

  async function handleSaveAndRecompute() {
    if (!candidate || !activeConfig) return;
    try {
      const result = await commitMutation.mutateAsync({
        config: candidate,
        currentVersion: activeConfig.version,
      });
      // Navigate to same page with recompute_job param
      const next = new URLSearchParams(searchParams);
      next.set('recompute_job', result.recompute_job.id);
      setSearchParams(next, { replace: true });
    } catch (err: unknown) {
      const errorObj = err as { code?: string };
      if (errorObj?.code === 'CONFIG_VERSION_CONFLICT') {
        setToast(
          'Config was updated by another admin. Reload the page to get the latest version, then reapply your changes.',
        );
      } else {
        setToast('Failed to save config. Please try again.');
      }
    }
  }

  if (configLoading || candidate === null || !activeConfig) {
    return (
      <div
        className="flex items-center justify-center h-64 text-gray-500"
        data-testid="tuning-loading"
      >
        Loading heuristic config…
      </div>
    );
  }

  const active = activeConfig.config;
  const changed = modifiedIds(KNOWN_HEURISTIC_IDS, active, candidate);
  const reEnabled = reEnabledIds(KNOWN_HEURISTIC_IDS, active, candidate);
  const key = candidateKey(KNOWN_HEURISTIC_IDS, candidate);
  const currentDiff = preview?.key === key ? preview.diff : null;
  const isComputing = pendingKey === key;
  const hasError = errorKey === key && !isComputing;
  const dirty = changed.length > 0;

  return (
    <div className="flex flex-1 flex-col" data-testid="tuning-view">
      <div className="border-b bg-white px-6 py-6">
        <PageHeader
          title="Heuristic tuning"
          meta={`Active config v${activeConfig.version}`}
          description="Weights scale each flag's contribution to the submission score; turning a heuristic off removes its flags from scoring."
        />
      </div>

      {/* In-flight recompute banner */}
      {recomputeJobId && (
        <RecomputeProgress
          semesterId={semesterId}
          jobId={recomputeJobId}
          semesterSlug={semesterSlug}
          onClose={() => {
            const next = new URLSearchParams(searchParams);
            next.delete('recompute_job');
            setSearchParams(next, { replace: true });
          }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          className="mx-4 mt-2 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800 flex justify-between"
          data-testid="tuning-toast"
        >
          <span>{toast}</span>
          <button onClick={() => setToast(null)} className="ml-4 text-yellow-600 hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Heuristic list */}
      <div className="flex-1 space-y-6 px-6 py-6" data-testid="heuristic-list">
        {GROUPS.map((group) => (
          <Panel
            key={group.slug}
            title={group.title}
            description={group.description}
            flush
            data-testid={`heuristic-group-${group.slug}`}
          >
            <div className="divide-y divide-gray-100">
              {group.ids.map((id) => (
                <HeuristicRow
                  key={id}
                  id={id}
                  setting={flagSetting(candidate, id)}
                  modified={isFlagModified(active, candidate, id)}
                  weightDisabled={CROSS_SUBMISSION_HEURISTIC_ID_SET.has(id)}
                  inert={INERT_HEURISTIC_IDS.has(id)}
                  onWeightChange={(w) => handleWeight(id, w)}
                  onEnabledChange={(e) => handleToggle(id, e)}
                  onReset={() => handleRowReset(id)}
                />
              ))}
            </div>
          </Panel>
        ))}
      </div>

      {/* Sticky footer — only while there are unsaved changes */}
      {dirty && (
        <div
          className="sticky bottom-0 z-10 border-t bg-white/95 px-6 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] backdrop-blur"
          data-testid="tuning-footer"
          role="region"
          aria-label="Unsaved changes"
        >
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span className="font-medium text-gray-900" data-testid="unsaved-count">
                {changed.length} unsaved {changed.length === 1 ? 'change' : 'changes'}
              </span>

              <div
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2"
                aria-live="polite"
              >
                {isComputing ? (
                  <span
                    className="inline-flex items-center gap-2 text-muted-foreground"
                    data-testid="impact-computing"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Computing impact…
                  </span>
                ) : currentDiff ? (
                  <>
                    <span className="text-gray-700" data-testid="impact-summary">
                      {impactSummary(currentDiff)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDetailsOpen(true)}
                      data-testid="details-btn"
                    >
                      Details
                    </Button>
                  </>
                ) : hasError || reEnabled.length > 0 ? (
                  <>
                    <span
                      className={hasError ? 'text-red-700' : 'text-gray-700'}
                      data-testid={hasError ? 'impact-error' : 'reenable-note'}
                    >
                      {hasError
                        ? "Couldn't compute the impact preview."
                        : reEnableMessage(reEnabled)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        clearDebounce();
                        runDryRun(candidate);
                      }}
                      data-testid="preview-impact-btn"
                    >
                      {hasError ? 'Try again' : 'Preview impact'}
                    </Button>
                  </>
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleDiscard} data-testid="discard-btn">
                Discard
              </Button>
              <Button
                size="sm"
                onClick={() => void handleSaveAndRecompute()}
                disabled={commitMutation.isPending || isComputing}
                data-testid="save-recompute-btn"
              >
                {commitMutation.isPending ? 'Saving…' : 'Save & recompute'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {currentDiff && (
        <ImpactDetailsDialog open={detailsOpen} onOpenChange={setDetailsOpen} diff={currentDiff} />
      )}
    </div>
  );
}
