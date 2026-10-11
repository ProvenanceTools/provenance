/**
 * FilterRail — left-side filter panel for the cohort view.
 *
 * Per PRD §8.8 filters:
 * - Validation status checkboxes (pass, warn, fail)
 * - Flag presence multi-select (heuristic ids) — shown as checkboxes with
 *   a small list of the most common heuristic IDs
 * - Severity threshold radio buttons (info / low / medium / high)
 * - Score range (min/max number inputs)
 * - Signal toggles: has_external_edits, has_large_paste
 * - Recorder version text input
 * - Include superseded checkbox (default off)
 * - Free-text search input (q)
 * - Assignment dropdown (single-select, populated from useAssignments)
 * - Apply / Clear buttons
 *
 * Filter changes are staged locally until "Apply" is pressed, then written
 * to URL via setFilters.
 *
 * exactOptionalPropertyTypes: all setState updaters use conditional spread
 * ({ ...prev, ...(cond && { key: value }) }) rather than setting properties
 * to undefined, which is disallowed under exactOptionalPropertyTypes: true.
 */

import { useState } from 'react';
import type { CohortFilters } from '../../api/queries.js';
import type { AssignmentSummary } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Well-known heuristic IDs shown in the flag checkboxes
// (full 25-id set from the Phase 13a backfill)
// ---------------------------------------------------------------------------

const COMMON_FLAG_IDS = [
  'large_paste',
  'external_edits',
  'low_typing_high_output',
  'paste_is_solution',
  'ai_extension_active',
  'chain_broken',
  'idle_then_complete',
  'extension_hash_mismatch',
  'paste_shared_across_students',
];

// ---------------------------------------------------------------------------
// Section heading helper
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FilterRailProps {
  filters: CohortFilters;
  assignments: AssignmentSummary[];
  onApply: (filters: CohortFilters) => void;
  onClear: () => void;
}

// ---------------------------------------------------------------------------
// patch — type-safe partial update that avoids exactOptionalPropertyTypes issues
// ---------------------------------------------------------------------------

function patch(prev: CohortFilters, update: CohortFilters): CohortFilters {
  // Merge: start from prev, then layer update on top.
  // Because both sides are already CohortFilters (no undefined values for
  // optional keys), spreading is safe under exactOptionalPropertyTypes.
  return { ...prev, ...update };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FilterRail({ filters, assignments, onApply, onClear }: FilterRailProps) {
  // Stage a local copy; only writes to URL on Apply
  const [draft, setDraft] = useState<CohortFilters>(filters);

  function patchDraft(update: CohortFilters) {
    setDraft((prev) => patch(prev, update));
  }

  function removeDraftKey<K extends keyof CohortFilters>(key: K) {
    setDraft((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function toggleFlagId(id: string) {
    setDraft((prev) => {
      const current = prev.flagIds ?? [];
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      if (next.length === 0) {
        const copy = { ...prev };
        delete copy.flagIds;
        return copy;
      }
      return patch(prev, { flagIds: next });
    });
  }

  function handleApply() {
    onApply(draft);
  }

  function handleClear() {
    setDraft({});
    onClear();
  }

  return (
    <aside
      className="flex w-72 flex-shrink-0 flex-col gap-4 overflow-y-auto border-r border-gray-200 bg-white p-4"
      data-testid="filter-rail"
    >
      {/* Free-text search */}
      <div>
        <SectionLabel>Search</SectionLabel>
        <input
          type="text"
          placeholder="Student name or SID…"
          value={draft.q ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            if (val) {
              patchDraft({ q: val });
            } else {
              removeDraftKey('q');
            }
          }}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm placeholder-gray-400 focus:border-orange-500 focus:outline-none"
          data-testid="filter-q"
        />
      </div>

      {/* Assignment dropdown */}
      <div>
        <SectionLabel>Assignment</SectionLabel>
        <select
          value={draft.assignmentId ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            if (val) {
              patchDraft({ assignmentId: val });
            } else {
              removeDraftKey('assignmentId');
            }
          }}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-orange-500 focus:outline-none"
          data-testid="filter-assignment"
        >
          <option value="">All assignments</option>
          {assignments.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label || a.assignment_id_str}
            </option>
          ))}
        </select>
      </div>

      {/* Validation status */}
      <div>
        <SectionLabel>Validation Status</SectionLabel>
        <div className="flex flex-col gap-1">
          {(['pass', 'warn', 'fail'] as const).map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={draft.validationStatus === s}
                onChange={() => {
                  if (draft.validationStatus === s) {
                    removeDraftKey('validationStatus');
                  } else {
                    patchDraft({ validationStatus: s });
                  }
                }}
                data-testid={`filter-validation-${s}`}
              />
              <span className="capitalize">{s}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Severity threshold */}
      <div>
        <SectionLabel>Max Severity at least</SectionLabel>
        <div className="flex flex-col gap-1">
          {(['info', 'low', 'medium', 'high'] as const).map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name="severity_min"
                checked={draft.severityMin === s}
                onChange={() => patchDraft({ severityMin: s })}
                data-testid={`filter-severity-${s}`}
              />
              <span className="capitalize">{s}</span>
            </label>
          ))}
          {/* Clear severity */}
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="radio"
              name="severity_min"
              checked={draft.severityMin === undefined}
              onChange={() => removeDraftKey('severityMin')}
              data-testid="filter-severity-none"
            />
            Any
          </label>
        </div>
      </div>

      {/* Score range */}
      <div>
        <SectionLabel>Score Range</SectionLabel>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            placeholder="Min"
            value={draft.scoreMin ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              if (val) {
                patchDraft({ scoreMin: Number(val) });
              } else {
                removeDraftKey('scoreMin');
              }
            }}
            className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-orange-500 focus:outline-none"
            data-testid="filter-score-min"
          />
          <span className="text-xs text-gray-600">to</span>
          <input
            type="number"
            min={0}
            placeholder="Max"
            value={draft.scoreMax ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              if (val) {
                patchDraft({ scoreMax: Number(val) });
              } else {
                removeDraftKey('scoreMax');
              }
            }}
            className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-orange-500 focus:outline-none"
            data-testid="filter-score-max"
          />
        </div>
      </div>

      {/* Signal toggles */}
      <div>
        <SectionLabel>Signals</SectionLabel>
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={draft.hasExternalEdits === true}
              onChange={(e) => {
                if (e.target.checked) {
                  patchDraft({ hasExternalEdits: true });
                } else {
                  removeDraftKey('hasExternalEdits');
                }
              }}
              data-testid="filter-has-external-edits"
            />
            Has external edits
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={draft.hasLargePaste === true}
              onChange={(e) => {
                if (e.target.checked) {
                  patchDraft({ hasLargePaste: true });
                } else {
                  removeDraftKey('hasLargePaste');
                }
              }}
              data-testid="filter-has-large-paste"
            />
            Has large paste
          </label>
        </div>
      </div>

      {/* Flag presence checkboxes */}
      <div>
        <SectionLabel>Flag Presence</SectionLabel>
        <div className="flex flex-col gap-1">
          {COMMON_FLAG_IDS.map((id) => (
            <label key={id} className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={(draft.flagIds ?? []).includes(id)}
                onChange={() => toggleFlagId(id)}
                data-testid={`filter-flag-${id}`}
              />
              <span>{id.replace(/_/g, ' ')}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Recorder version */}
      <div>
        <SectionLabel>Recorder Version</SectionLabel>
        <input
          type="text"
          placeholder="e.g. 1.2.3"
          value={draft.recorderVersion ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            if (val) {
              patchDraft({ recorderVersion: val });
            } else {
              removeDraftKey('recorderVersion');
            }
          }}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm placeholder-gray-400 focus:border-orange-500 focus:outline-none"
          data-testid="filter-recorder-version"
        />
      </div>

      {/* Include superseded */}
      <div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={draft.includeSuperseded === true}
            onChange={(e) => {
              if (e.target.checked) {
                patchDraft({ includeSuperseded: true });
              } else {
                removeDraftKey('includeSuperseded');
              }
            }}
            data-testid="filter-include-superseded"
          />
          Include superseded submissions
        </label>
      </div>

      {/* Apply / Clear */}
      <div className="flex gap-2">
        <button
          onClick={handleApply}
          className="flex-1 rounded-md bg-orange-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-800"
          data-testid="filter-apply"
        >
          Apply
        </button>
        <button
          onClick={handleClear}
          className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          data-testid="filter-clear"
        >
          Clear
        </button>
      </div>
    </aside>
  );
}
