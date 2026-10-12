/**
 * use-cohort-filters — URL <-> CohortFilters + CohortSort state sync.
 *
 * Reads filter state from URL search params via react-router useSearchParams.
 * Returns [filters, sort, setFilters, setSort]. Calling setFilters or setSort
 * writes back to the URL (replacing the current history entry so that the
 * browser back button skips intermediate filter states).
 *
 * URL encoding strategy:
 * - Single-value params: standard key=value (e.g. severity_min=medium)
 * - Multi-value params: repeated keys (e.g. flag_id=ai_ext&flag_id=large_paste)
 * - Boolean params: 'true' / 'false' strings
 * - Missing param = filter not active (not the same as false)
 *
 * All filter reads are tolerant: unknown enum values are ignored rather than
 * crashing the page.
 */

import { useSearchParams } from 'react-router-dom';
import { useCallback } from 'react';
import type { CohortFilters, CohortSort } from '../../api/queries.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { CohortFilters, CohortSort };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SORTS: Set<CohortSort> = new Set([
  'score_desc',
  'score_asc',
  'ingested_desc',
  'student_asc',
  'student_desc',
  'assignment_asc',
]);

const VALID_SEVERITIES = new Set(['info', 'low', 'medium', 'high']);
const VALID_VALIDATION_STATUSES = new Set(['pass', 'warn', 'fail']);

function parseBool(value: string | null): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function parseNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return isNaN(n) ? undefined : n;
}

// ---------------------------------------------------------------------------
// Decode URL -> CohortFilters
// ---------------------------------------------------------------------------

export function decodeFilters(params: URLSearchParams): CohortFilters {
  // Build as a loose object first, then narrow for exactOptionalPropertyTypes.
  // We never set a property to undefined — we only set it when the value is present.
  const assignmentId = params.get('assignment_id') ?? undefined;
  const flagIds = params.getAll('flag_id');
  const rawSeverityMin = params.get('severity_min');
  const severityMin =
    rawSeverityMin && VALID_SEVERITIES.has(rawSeverityMin)
      ? (rawSeverityMin as NonNullable<CohortFilters['severityMin']>)
      : undefined;
  const rawValidationStatus = params.get('validation_status');
  const validationStatus =
    rawValidationStatus && VALID_VALIDATION_STATUSES.has(rawValidationStatus)
      ? (rawValidationStatus as NonNullable<CohortFilters['validationStatus']>)
      : undefined;
  const scoreMin = parseNumber(params.get('score_min'));
  const scoreMax = parseNumber(params.get('score_max'));
  const activeMinutesMin = parseNumber(params.get('active_minutes_min'));
  const activeMinutesMax = parseNumber(params.get('active_minutes_max'));
  const totalMinutesMin = parseNumber(params.get('total_minutes_min'));
  const totalMinutesMax = parseNumber(params.get('total_minutes_max'));
  const hasExternalEdits = parseBool(params.get('has_external_edits'));
  const hasLargePaste = parseBool(params.get('has_large_paste'));
  const recorderVersion = params.get('recorder_version') ?? undefined;
  const rawIncludeSuperseded = parseBool(params.get('include_superseded'));
  const includeSuperseded = rawIncludeSuperseded !== undefined ? rawIncludeSuperseded : undefined;
  const q = params.get('q') ?? undefined;

  return {
    ...(assignmentId !== undefined && { assignmentId }),
    ...(flagIds.length > 0 && { flagIds }),
    ...(severityMin !== undefined && { severityMin }),
    ...(validationStatus !== undefined && { validationStatus }),
    ...(scoreMin !== undefined && { scoreMin }),
    ...(scoreMax !== undefined && { scoreMax }),
    ...(activeMinutesMin !== undefined && { activeMinutesMin }),
    ...(activeMinutesMax !== undefined && { activeMinutesMax }),
    ...(totalMinutesMin !== undefined && { totalMinutesMin }),
    ...(totalMinutesMax !== undefined && { totalMinutesMax }),
    ...(hasExternalEdits !== undefined && { hasExternalEdits }),
    ...(hasLargePaste !== undefined && { hasLargePaste }),
    ...(recorderVersion !== undefined && { recorderVersion }),
    ...(includeSuperseded !== undefined && { includeSuperseded }),
    ...(q !== undefined && { q }),
  };
}

// ---------------------------------------------------------------------------
// Encode CohortFilters -> URLSearchParams
// ---------------------------------------------------------------------------

export function encodeFilters(filters: CohortFilters, sort: CohortSort): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.assignmentId) params.set('assignment_id', filters.assignmentId);
  if (filters.flagIds?.length) {
    for (const id of filters.flagIds) params.append('flag_id', id);
  }
  if (filters.severityMin) params.set('severity_min', filters.severityMin);
  if (filters.validationStatus) params.set('validation_status', filters.validationStatus);
  if (filters.scoreMin !== undefined) params.set('score_min', String(filters.scoreMin));
  if (filters.scoreMax !== undefined) params.set('score_max', String(filters.scoreMax));
  if (filters.activeMinutesMin !== undefined)
    params.set('active_minutes_min', String(filters.activeMinutesMin));
  if (filters.activeMinutesMax !== undefined)
    params.set('active_minutes_max', String(filters.activeMinutesMax));
  if (filters.totalMinutesMin !== undefined)
    params.set('total_minutes_min', String(filters.totalMinutesMin));
  if (filters.totalMinutesMax !== undefined)
    params.set('total_minutes_max', String(filters.totalMinutesMax));
  if (filters.hasExternalEdits !== undefined)
    params.set('has_external_edits', String(filters.hasExternalEdits));
  if (filters.hasLargePaste !== undefined)
    params.set('has_large_paste', String(filters.hasLargePaste));
  if (filters.recorderVersion) params.set('recorder_version', filters.recorderVersion);
  if (filters.includeSuperseded) params.set('include_superseded', 'true');
  if (filters.q) params.set('q', filters.q);
  if (sort !== 'score_desc') params.set('sort', sort); // default omitted

  return params;
}

// ---------------------------------------------------------------------------
// useCohortFilters hook
// ---------------------------------------------------------------------------

/**
 * Reads cohort filters and sort from URL params. Returns:
 * - filters: decoded CohortFilters
 * - sort: decoded CohortSort (default 'score_desc')
 * - setFilters: writes filters + sort to URL (replace navigation)
 * - setSort: writes only the sort param to URL (replace navigation)
 * - clearFilters: resets filters to empty (keeps sort)
 */
export function useCohortFilters() {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = decodeFilters(searchParams);

  const sortParam = searchParams.get('sort');
  const sort: CohortSort =
    sortParam && VALID_SORTS.has(sortParam as CohortSort)
      ? (sortParam as CohortSort)
      : 'score_desc';

  const setFilters = useCallback(
    (nextFilters: CohortFilters, nextSort?: CohortSort) => {
      const encoded = encodeFilters(nextFilters, nextSort ?? sort);
      setSearchParams(encoded, { replace: true });
    },
    [sort, setSearchParams],
  );

  const setSort = useCallback(
    (nextSort: CohortSort) => {
      const encoded = encodeFilters(filters, nextSort);
      setSearchParams(encoded, { replace: true });
    },
    [filters, setSearchParams],
  );

  const clearFilters = useCallback(() => {
    const empty = new URLSearchParams();
    if (sort !== 'score_desc') empty.set('sort', sort);
    setSearchParams(empty, { replace: true });
  }, [sort, setSearchParams]);

  return { filters, sort, setFilters, setSort, clearFilters };
}
