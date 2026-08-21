/**
 * TuningView — heuristic weight + enable/disable tuning with dry-run preview.
 *
 * Phase 24. Route: /s/:courseSlug/:semesterSlug/tuning
 *
 * Layout:
 * - Left pane: scrollable heuristic list. Each row: name, enabled toggle, weight slider (0.0–2.0).
 * - Right pane: dry-run preview (histogram + top movers).
 * - Top bar: "Save & Recompute" button + "Reset to current" button.
 *
 * Design decisions:
 * - Slider drag debounces 300ms before triggering dry-run (avoids per-pixel API calls).
 * - Recompute progress tracked via URL query param ?recompute_job=<id> so refresh works.
 * - 409 CONFIG_VERSION_CONFLICT → toast + offer reload.
 * - If-Match header set to current active config version.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useActiveSemester } from '../../api/use-active-semester.js';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, Label } from 'recharts';
import { useActiveConfig, useCommitConfig, useDryRunConfig } from '../../api/queries.js';
import type { HeuristicConfigBody } from '@provenance/shared/api-schemas';
import {
  ALL_FLAG_IDS,
  CROSS_SUBMISSION_HEURISTIC_IDS,
} from '@provenance/analysis-core/heuristics/known-flag-ids.js';
import { RecomputeProgress } from './RecomputeProgress.js';
import { contributorsLabel, personLabel } from '../../lib/contributor-display.js';

// ---------------------------------------------------------------------------
// All known heuristic/flag IDs.
//
// A 2026-08 audit found this list had hand-drifted from the real set (it was
// missing `inter_session_external_change`) while looking internally
// consistent. Derived from analysis-core's known-flag-ids.ts — the single
// source of truth for every id the engine can produce — instead of a
// hand-maintained duplicate, so it cannot drift again. See
// heuristics-doc-sync.test.ts for the regression guard on docs/heuristics.md.
// ---------------------------------------------------------------------------

const KNOWN_HEURISTIC_IDS = ALL_FLAG_IDS;

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
// Helpers
// ---------------------------------------------------------------------------

function configFromActive(active: { config: HeuristicConfigBody }): HeuristicConfigBody {
  // Deep clone so mutations don't affect cached query data
  return JSON.parse(JSON.stringify(active.config)) as HeuristicConfigBody;
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

  // Dry-run preview
  const dryRunMutation = useDryRunConfig(semesterId);
  const commitMutation = useCommitConfig(semesterId);

  // Debounce timer ref
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tracks whether we've fired the initial "current distribution" dry-run.
  const initialDryRunFiredRef = useRef(false);

  // Recompute job tracking via URL query param
  const recomputeJobId = searchParams.get('recompute_job') ?? '';

  // Initialize candidate from active config + fire one immediate dry-run with
  // the unchanged config so the chart shows the CURRENT score distribution on
  // page load (the "Before" series), instead of an empty placeholder.
  useEffect(() => {
    if (activeConfig && candidate === null) {
      const initial = configFromActive(activeConfig);
      setCandidate(initial);

      if (!initialDryRunFiredRef.current) {
        initialDryRunFiredRef.current = true;
        dryRunMutation.mutate({ config: initial, currentVersion: activeConfig.version });
      }
    }
  }, [activeConfig, candidate, dryRunMutation]);

  // Trigger dry-run after 300ms debounce
  const triggerDryRun = useCallback(
    (config: HeuristicConfigBody) => {
      if (!activeConfig) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void dryRunMutation.mutate({
          config,
          currentVersion: activeConfig.version,
        });
      }, 300);
    },
    [activeConfig, dryRunMutation],
  );

  function handleToggle(heuristicId: string, enabled: boolean) {
    if (!candidate) return;
    const next: HeuristicConfigBody = {
      ...candidate,
      per_flag: {
        ...candidate.per_flag,
        [heuristicId]: { ...candidate.per_flag[heuristicId]!, enabled },
      },
    };
    setCandidate(next);
    triggerDryRun(next);
  }

  function handleWeight(heuristicId: string, weight: number) {
    if (!candidate) return;
    const next: HeuristicConfigBody = {
      ...candidate,
      per_flag: {
        ...candidate.per_flag,
        [heuristicId]: { ...candidate.per_flag[heuristicId]!, weight },
      },
    };
    setCandidate(next);
    triggerDryRun(next);
  }

  function handleReset() {
    if (!activeConfig) return;
    const reset = configFromActive(activeConfig);
    setCandidate(reset);
    if (debounceRef.current) clearTimeout(debounceRef.current);
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
        setToast('Config was updated by another admin. Click "Reset to current" to reload.');
      } else {
        setToast('Failed to save config. Please try again.');
      }
    }
  }

  if (configLoading || candidate === null) {
    return (
      <div
        className="flex items-center justify-center h-64 text-gray-500"
        data-testid="tuning-loading"
      >
        Loading heuristic config…
      </div>
    );
  }

  const dryRunData = dryRunMutation.data?.diff;

  // Build histogram data for recharts. Each bucket label is its score range
  // "lo–hi" using the server-provided upper bound so users can read the X
  // axis as actual score values instead of opaque bucket indices.
  const histogramData = dryRunData
    ? (() => {
        const upper = dryRunData.score_histogram_upper_bound;
        const width = upper / dryRunData.score_histogram_old.length;
        const fmt = (n: number) =>
          width >= 10 ? n.toFixed(0) : width >= 1 ? n.toFixed(1) : n.toFixed(2);
        return dryRunData.score_histogram_old.map((old, i) => ({
          bucket: `${fmt(i * width)}–${fmt((i + 1) * width)}`,
          before: old,
          after: dryRunData.score_histogram_new[i] ?? 0,
        }));
      })()
    : [];

  return (
    <div className="flex flex-col min-h-0" data-testid="tuning-view">
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

      {/* Action bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 bg-white">
        <h1 className="text-sm font-semibold text-gray-900 mr-4">Heuristic Tuning</h1>
        <button
          onClick={() => void handleSaveAndRecompute()}
          disabled={commitMutation.isPending || dryRunMutation.isPending || !candidate}
          className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
          data-testid="save-recompute-btn"
        >
          {commitMutation.isPending ? 'Saving…' : 'Save & Recompute'}
        </button>
        <button
          onClick={handleReset}
          className="px-4 py-1.5 border border-gray-300 text-sm rounded hover:bg-gray-50"
          data-testid="reset-btn"
        >
          Reset to current
        </button>
      </div>

      {/* Main layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left pane — heuristic list */}
        <div
          className="w-96 flex-shrink-0 overflow-y-auto border-r border-gray-200 bg-white"
          data-testid="heuristic-list"
        >
          {KNOWN_HEURISTIC_IDS.map((id) => {
            const flagCfg = candidate.per_flag[id] ?? { enabled: true, weight: 1.0 };
            const isCrossFlag = CROSS_SUBMISSION_HEURISTIC_ID_SET.has(id);
            const weightNoteId = `tuning-weight-note-${id}`;
            return (
              <div key={id} className="px-4 py-3 border-b border-gray-100">
                <div className="flex items-center justify-between mb-1">
                  <span
                    id={`tuning-label-${id}`}
                    className="text-xs font-medium text-gray-700 font-mono"
                  >
                    {id}
                  </span>
                  <label className="flex items-center gap-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={flagCfg.enabled}
                      onChange={(e) => handleToggle(id, e.target.checked)}
                      className="h-3 w-3"
                      data-testid={`toggle-${id}`}
                      aria-label={`Enable ${id}`}
                    />
                    <span className="text-xs text-gray-500">{flagCfg.enabled ? 'on' : 'off'}</span>
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={flagCfg.weight}
                    onChange={(e) => handleWeight(id, parseFloat(e.target.value))}
                    disabled={isCrossFlag}
                    className="flex-1 h-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid={`slider-${id}`}
                    aria-labelledby={`tuning-label-${id}`}
                    aria-valuetext={`${flagCfg.weight.toFixed(1)} weight`}
                    aria-describedby={isCrossFlag ? weightNoteId : undefined}
                  />
                  <span className="text-xs text-gray-500 w-8 text-right">
                    {flagCfg.weight.toFixed(1)}
                  </span>
                </div>
                {isCrossFlag && (
                  <p
                    id={weightNoteId}
                    className="mt-1 text-xs text-gray-600"
                    data-testid={`weight-note-${id}`}
                  >
                    Cross-submission flags are surfaced, not scored. Weight does not apply.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* Right pane — dry-run preview */}
        <div className="flex-1 overflow-y-auto bg-gray-50 p-4" data-testid="dryrun-preview">
          {dryRunMutation.isPending && (
            <div className="text-sm text-gray-500 mb-4">Computing dry-run diff…</div>
          )}

          {dryRunData && !dryRunMutation.isPending && (
            <>
              <div className="mb-4 p-3 bg-white border border-gray-200 rounded">
                <p className="text-sm font-medium text-gray-800">
                  Submissions with tier change:{' '}
                  <span className="text-blue-600">{dryRunData.submissions_with_tier_change}</span>
                </p>
              </div>

              {/* Histogram */}
              <div
                className="mb-4 bg-white border border-gray-200 rounded p-4"
                data-testid="score-histogram"
              >
                <h3 className="text-xs font-semibold text-gray-600 mb-2 uppercase tracking-wide">
                  Score Distribution
                </h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart
                    data={histogramData}
                    margin={{ top: 5, right: 10, left: 10, bottom: 28 }}
                  >
                    <XAxis
                      dataKey="bucket"
                      tick={{ fontSize: 10 }}
                      interval={0}
                      angle={-30}
                      textAnchor="end"
                      height={50}
                    >
                      <Label
                        value="Score range"
                        position="insideBottom"
                        offset={-2}
                        style={{ fontSize: 10, fill: '#6b7280' }}
                      />
                    </XAxis>
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false}>
                      <Label
                        value="Submissions"
                        angle={-90}
                        position="insideLeft"
                        style={{ fontSize: 10, fill: '#6b7280', textAnchor: 'middle' }}
                      />
                    </YAxis>
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="before" fill="#94a3b8" name="Before" />
                    <Bar dataKey="after" fill="#3b82f6" name="After" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Top movers */}
              {dryRunData.top_movers.length > 0 && (
                <div className="bg-white border border-gray-200 rounded" data-testid="top-movers">
                  <h3 className="text-xs font-semibold text-gray-600 px-4 py-2 border-b border-gray-100 uppercase tracking-wide">
                    Top Movers
                  </h3>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="px-4 py-2 text-left text-gray-500 font-medium">Student</th>
                        <th className="px-4 py-2 text-left text-gray-500 font-medium">
                          Assignment
                        </th>
                        <th className="px-4 py-2 text-right text-gray-500 font-medium">
                          Before → After
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {dryRunData.top_movers.slice(0, 20).map((m) => (
                        <tr key={m.submission_id} className="border-b border-gray-50">
                          {/*
                            EVERY contributor, not the submitter of record. A
                            mover row says "this score moves by N under the
                            proposed weights"; the score belongs to the whole
                            scope, so naming one partner of a group submission
                            charges the swing to an arbitrary person. Falls back
                            to `student` for a response predating
                            `contributors`.
                          */}
                          <td className="px-4 py-1.5">
                            {contributorsLabel(m.contributors, {
                              fallbackStudent: m.student,
                            }) || personLabel(null)}
                          </td>
                          <td className="px-4 py-1.5 text-gray-500">
                            {m.assignment.assignment_id_str}
                          </td>
                          <td className="px-4 py-1.5 text-right font-mono">
                            {m.old_score.toFixed(1)} → {m.new_score.toFixed(1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {!dryRunData && !dryRunMutation.isPending && (
            <p className="text-sm text-gray-400 text-center mt-16">
              Adjust sliders or toggles to see a dry-run preview.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
