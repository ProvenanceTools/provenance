/**
 * Overview.test.tsx — accessibility regression test for the Overview tab's
 * async loading/error states (WCAG 4.1.3 Status Messages).
 *
 * Full behavioral coverage of the Overview tab's data rendering lives in
 * integration/e2e coverage; this file focuses on the loading/error regions
 * introduced in Task 14.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import {
  buildIndexFromEventRows,
  type ServerEventRow,
} from '@provenance/analysis-core/index/build-index.js';

import { SubmissionDataContext } from '../../data/SubmissionDataProvider.js';
import type {
  SubmissionDataProvider,
  ValidationResults,
  FileListResult,
  FileContentResult,
  FileProvenanceResult,
  SubmissionStats,
  SubmittedFileListResult,
  SubmittedFileContentResult,
} from '../../data/SubmissionDataProvider.js';
import type {
  SubmissionSummary,
  SubmissionContributor,
  FlagRow,
  EventRow,
} from '@provenance/shared/api-schemas';
import { UNNAMED_CONTRIBUTOR_LABEL } from '../../lib/contributor-display.js';
import { Overview } from './Overview.js';

// ---------------------------------------------------------------------------
// Mock useFullEventIndex so nothing hits the network, and so we can assert
// WHETHER it was enabled — the whole point of deferring it is that the default
// tab does not page the event stream until a drawer needs it.
// ---------------------------------------------------------------------------

const indexHook = {
  enabledCalls: [] as boolean[],
  result: null as UseQueryResult<EventIndex> | null,
};

vi.mock('../../data/useFullEventIndex.js', () => ({
  useFullEventIndex: (_id: string, options?: { enabled?: boolean }) => {
    indexHook.enabledCalls.push(options?.enabled ?? true);
    return (
      indexHook.result ?? { data: undefined, isLoading: false, isError: false, isSuccess: false }
    );
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryResult<T>(data: T): UseQueryResult<T> {
  return {
    data,
    isLoading: false,
    isError: false,
    isPending: false,
    isSuccess: true,
    error: null,
    status: 'success',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<T>;
}

function makeLoadingResult<T>(): UseQueryResult<T> {
  return {
    data: undefined,
    isLoading: true,
    isError: false,
    isPending: true,
    isSuccess: false,
    error: null,
    status: 'pending',
    fetchStatus: 'fetching',
  } as unknown as UseQueryResult<T>;
}

function makeErrorResult<T>(): UseQueryResult<T> {
  return {
    data: undefined,
    isLoading: false,
    isError: true,
    isPending: false,
    isSuccess: false,
    error: new Error('boom'),
    status: 'error',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<T>;
}

const DUMMY_SUMMARY: SubmissionSummary = {
  id: 'test',
  student: { sid: 'test', display_name: 'Test' },
  contributors: [
    {
      contributor_key: 'roster:30000000-0000-0000-0000-0000000000aa',
      kind: 'roster',
      student: { id: '30000000-0000-0000-0000-0000000000aa', sid: 'test', display_name: 'Test' },
      student_ref: null,
      session_count: 0,
      is_submitter: true,
      score_total: 0,
      score_max_severity: 'info',
      flag_counts: { info: 0, low: 0, medium: 0, high: 0 },
    },
  ],
  assignment: { assignment_id_str: 'hw1', label: 'HW1' },
  version_index: 1,
  score_total: 0,
  score_max_severity: null,
  validation_status: 'pass',
  validation_overall_detail: null,
  heuristic_config_version: 1,
  flag_count: 0,
  ingested_at: '2025-01-01T00:00:00.000Z',
};

const DUMMY_VALIDATION: ValidationResults = { overall: 'pass', checks: [] };

function makeProvider(
  summaryResult: UseQueryResult<SubmissionSummary>,
  overrides: { flags?: FlagRow[]; validation?: ValidationResults } = {},
): SubmissionDataProvider {
  return {
    useSummary: () => summaryResult,
    useEvents: () => makeQueryResult([] as EventRow[]),
    useEvent: () => makeQueryResult(null),
    useFlags: () => makeQueryResult(overrides.flags ?? ([] as FlagRow[])),
    useStats: () =>
      makeQueryResult({
        per_file: [],
        aggregate: { total_events: 0, total_saves: 0, total_sessions: 0, total_wall_ms: 0 },
      } as SubmissionStats),
    useValidation: () => makeQueryResult(overrides.validation ?? DUMMY_VALIDATION),
    useFiles: () => makeQueryResult({ files: [] } as FileListResult),
    useFileContent: () =>
      makeQueryResult({ content: '', at_seq: 0, computed_at_ms: 0 } as FileContentResult),
    useFileProvenance: () =>
      makeQueryResult({ length: 0, provenance: [], at_seq: 0 } as FileProvenanceResult),
    useSubmittedFiles: () =>
      makeQueryResult({ available: true, files: [] } as SubmittedFileListResult),
    useSubmittedFileContent: (_path: string) =>
      makeQueryResult({
        path: '',
        content: '',
        status: 'missing',
        verdict: 'unknown',
      } as SubmittedFileContentResult),
  };
}

function renderOverview(provider: SubmissionDataProvider) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SubmissionDataContext.Provider value={provider}>
          <Overview />
        </SubmissionDataContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  indexHook.enabledCalls = [];
  indexHook.result = null;
});

describe('Overview tab', () => {
  it('renders the summary once loaded', async () => {
    const provider = makeProvider(makeQueryResult(DUMMY_SUMMARY));
    renderOverview(provider);

    await waitFor(() => {
      expect(screen.getByTestId('submission-overview')).toBeInTheDocument();
    });
  });

  it('shows loading state announced via role=status', () => {
    const provider = makeProvider(makeLoadingResult<SubmissionSummary>());
    renderOverview(provider);

    const loadingEl = screen.getByTestId('overview-loading');
    expect(loadingEl).toBeInTheDocument();
    expect(loadingEl.closest('[role="status"]')).not.toBeNull();
  });

  it('shows error state announced via role=alert', () => {
    const provider = makeProvider(makeErrorResult<SubmissionSummary>());
    renderOverview(provider);

    const errorEl = screen.getByTestId('overview-error');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl.closest('[role="alert"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Flag drill-down
// ---------------------------------------------------------------------------

/** Two sessions, globally numbered as the events API numbers them. */
function twoSessionIndex(): EventIndex {
  const rows: ServerEventRow[] = [
    {
      seq: 0,
      session_id: 'sess-a',
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      kind: 'session.start',
      payload: {},
    },
    {
      seq: 1,
      session_id: 'sess-a',
      t: 100,
      wall: '2026-01-01T00:00:01.000Z',
      kind: 'paste',
      payload: { path: 'hw1.py' },
    },
    {
      seq: 2,
      session_id: 'sess-b',
      t: 0,
      wall: '2026-01-02T00:00:00.000Z',
      kind: 'session.start',
      payload: {},
    },
    {
      seq: 3,
      session_id: 'sess-b',
      t: 100,
      wall: '2026-01-02T00:00:01.000Z',
      kind: 'fs.external_change',
      payload: { path: 'hw1.py' },
    },
  ];
  return buildIndexFromEventRows(rows);
}

/** A flag whose evidence spans both sessions — session_id is '' in that case. */
const CROSS_SESSION_FLAG: FlagRow = {
  id: '00000000-0000-4000-8000-000000000001',
  heuristic_id: 'external_edits',
  severity: 'high',
  confidence: 0.9,
  score_contribution: 4.5,
  title: 'External edit in hw1.py',
  description: 'A file changed on disk between sessions.',
  detail: { path: 'hw1.py' },
  supporting_seqs: [1, 3],
  session_id: '',
};

const TWO_SESSION_SUMMARY: SubmissionSummary = {
  ...DUMMY_SUMMARY,
  session_ids: ['sess-a', 'sess-b'],
  sessions: [
    { session_id: 'sess-a', started_at: '2026-01-01T00:00:00.000Z', event_count: 2 },
    { session_id: 'sess-b', started_at: '2026-01-02T00:00:00.000Z', event_count: 2 },
  ],
};

function LocationCapture({ onLocation }: { onLocation: (l: string) => void }) {
  const loc = useLocation();
  onLocation(loc.pathname + loc.search);
  return null;
}

function renderAtRoute(provider: SubmissionDataProvider, search = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let lastLocation = '';
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/s/cs61a/fa26/sub/test-sub-id${search}`]}>
        <Routes>
          <Route
            path="/s/:courseSlug/:semesterSlug/sub/:submissionId"
            element={
              <SubmissionDataContext.Provider value={provider}>
                <Overview />
              </SubmissionDataContext.Provider>
            }
          />
        </Routes>
        <LocationCapture
          onLocation={(l) => {
            lastLocation = l;
          }}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { getLocation: () => lastLocation };
}

describe('Overview tab — flag drill-down', () => {
  it('renders flags as openable rows', () => {
    renderAtRoute(
      makeProvider(makeQueryResult(TWO_SESSION_SUMMARY), { flags: [CROSS_SESSION_FLAG] }),
    );
    expect(screen.getByTestId('flag-dashboard-panel')).toBeInTheDocument();
    // Persisted prose, not the bare heuristic id.
    expect(screen.getByText('External edit in hw1.py')).toBeInTheDocument();
  });

  it('does not load the event index until a drawer is opened', () => {
    indexHook.result = makeQueryResult(twoSessionIndex());
    renderAtRoute(
      makeProvider(makeQueryResult(TWO_SESSION_SUMMARY), { flags: [CROSS_SESSION_FLAG] }),
    );

    // Overview is the default tab; paging every event on arrival would be a
    // real regression on large submissions.
    expect(indexHook.enabledCalls.every((e) => e === false)).toBe(true);

    fireEvent.click(screen.getByTestId(`flag-row-${CROSS_SESSION_FLAG.id}`));
    expect(indexHook.enabledCalls.at(-1)).toBe(true);
  });

  it('jumps to the timeline at the supporting event', () => {
    indexHook.result = makeQueryResult(twoSessionIndex());
    const { getLocation } = renderAtRoute(
      makeProvider(makeQueryResult(TWO_SESSION_SUMMARY), { flags: [CROSS_SESSION_FLAG] }),
    );

    fireEvent.click(screen.getByTestId(`flag-row-${CROSS_SESSION_FLAG.id}`));
    fireEvent.click(screen.getByTestId('jump-btn-3'));

    expect(getLocation()).toContain('tab=timeline');
    expect(getLocation()).toContain('seq=sess-b%3A3');
  });

  it('jumps to replay in the session that actually holds the evidence', () => {
    // The regression: seq 3 lives in sess-b, but session_id is '' for this
    // cross-session flag, so anything keying off it would land in sess-a.
    indexHook.result = makeQueryResult(twoSessionIndex());
    const { getLocation } = renderAtRoute(
      makeProvider(makeQueryResult(TWO_SESSION_SUMMARY), { flags: [CROSS_SESSION_FLAG] }),
    );

    fireEvent.click(screen.getByTestId(`flag-row-${CROSS_SESSION_FLAG.id}`));
    fireEvent.click(screen.getByTestId('jump-replay-btn-3'));

    expect(getLocation()).toContain('tab=replay');
    expect(getLocation()).toContain('session=sess-b');
    expect(getLocation()).toContain('event=3');
  });

  it('keeps jump targets live before the index has loaded', () => {
    // indexHook.result stays null → no index. Evidence must still be listed and
    // navigable via the bare global seq.
    const { getLocation } = renderAtRoute(
      makeProvider(makeQueryResult(TWO_SESSION_SUMMARY), { flags: [CROSS_SESSION_FLAG] }),
    );

    fireEvent.click(screen.getByTestId(`flag-row-${CROSS_SESSION_FLAG.id}`));
    expect(screen.getByText('event #3')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('jump-replay-btn-3'));
    // No session named — Replay derives it from ?event= on arrival.
    expect(getLocation()).toContain('tab=replay');
    expect(getLocation()).toContain('event=3');
    expect(getLocation()).not.toContain('session=');
  });
});

describe('Overview tab — ?flag= dashboard deep-link', () => {
  const LOW_DUP: FlagRow = {
    id: '00000000-0000-4000-8000-0000000000aa',
    heuristic_id: 'large_paste',
    severity: 'low',
    confidence: 0.5,
    score_contribution: 1,
    title: 'Small paste in a.py',
    description: 'low one',
    detail: null,
    supporting_seqs: [1],
    session_id: 'sess-a',
  };
  const HIGH_DUP: FlagRow = {
    id: '00000000-0000-4000-8000-0000000000bb',
    heuristic_id: 'large_paste',
    severity: 'high',
    confidence: 0.9,
    score_contribution: 4,
    title: 'Huge paste in b.py',
    description: 'high one',
    detail: null,
    supporting_seqs: [3],
    session_id: 'sess-b',
  };

  it('auto-opens the matching flag drawer and loads the event index', () => {
    indexHook.result = makeQueryResult(twoSessionIndex());
    renderAtRoute(
      makeProvider(makeQueryResult(TWO_SESSION_SUMMARY), { flags: [CROSS_SESSION_FLAG] }),
      '?flag=external_edits',
    );

    const drawer = screen.getByTestId('heuristic-drawer');
    expect(within(drawer).getByText('External edit in hw1.py')).toBeInTheDocument();
    // Opening a drawer is exactly when the deferred index load is meant to fire.
    expect(indexHook.enabledCalls.at(-1)).toBe(true);
  });

  it('opens the highest-severity flag when several share the heuristic', () => {
    renderAtRoute(
      makeProvider(makeQueryResult(TWO_SESSION_SUMMARY), { flags: [LOW_DUP, HIGH_DUP] }),
      '?flag=large_paste',
    );

    const drawer = screen.getByTestId('heuristic-drawer');
    expect(within(drawer).getByText('Huge paste in b.py')).toBeInTheDocument();
    expect(within(drawer).queryByText('Small paste in a.py')).not.toBeInTheDocument();
  });

  it('opens nothing and does not load the index when the flag param matches no flag', () => {
    renderAtRoute(
      makeProvider(makeQueryResult(TWO_SESSION_SUMMARY), { flags: [CROSS_SESSION_FLAG] }),
      '?flag=does_not_exist',
    );

    expect(screen.queryByTestId('heuristic-drawer')).not.toBeInTheDocument();
    expect(screen.getByTestId('submission-overview')).toBeInTheDocument();
    expect(indexHook.enabledCalls.every((e) => e === false)).toBe(true);
  });
});

describe('Overview tab — sessions and validation labels', () => {
  it('lists sessions when there is more than one, and opens replay at one', () => {
    const { getLocation } = renderAtRoute(makeProvider(makeQueryResult(TWO_SESSION_SUMMARY)));

    expect(screen.getByTestId('sessions-section')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^session-row-/)).toHaveLength(2);

    fireEvent.click(screen.getByTestId('session-row-sess-b'));
    expect(getLocation()).toContain('tab=replay');
    expect(getLocation()).toContain('session=sess-b');
  });

  it('omits the sessions card for a single-session submission', () => {
    const single: SubmissionSummary = {
      ...DUMMY_SUMMARY,
      sessions: [{ session_id: 'sess-a', started_at: '2026-01-01T00:00:00.000Z', event_count: 2 }],
    };
    renderAtRoute(makeProvider(makeQueryResult(single)));
    expect(screen.queryByTestId('sessions-section')).not.toBeInTheDocument();
  });

  it('shows human check labels, falling back to the id when absent', () => {
    const validation: ValidationResults = {
      overall: 'warn',
      checks: [
        { id: 'monotonic_wall', label: 'Monotonic wall clock', status: 'pass' },
        { id: 'seq_gaps', status: 'pass' },
      ],
    };
    renderAtRoute(makeProvider(makeQueryResult(DUMMY_SUMMARY), { validation }));

    expect(screen.getByText('Monotonic wall clock')).toBeInTheDocument();
    expect(screen.getByText('seq_gaps')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Contributors (0029 cut-over)
// ---------------------------------------------------------------------------

function makeContributor(overrides: Partial<SubmissionContributor> = {}): SubmissionContributor {
  return {
    contributor_key: 'roster:30000000-0000-0000-0000-0000000000aa',
    kind: 'roster',
    student: {
      id: '30000000-0000-0000-0000-0000000000aa',
      sid: 'test',
      display_name: 'Test',
    },
    student_ref: null,
    session_count: 0,
    is_submitter: true,
    score_total: 0,
    score_max_severity: 'info',
    flag_counts: { info: 0, low: 0, medium: 0, high: 0 },
    ...overrides,
  };
}

describe('Overview tab — contributors', () => {
  it('renders a solo submission exactly as before: "Student" over "Name (sid)"', () => {
    renderAtRoute(makeProvider(makeQueryResult(DUMMY_SUMMARY)));

    expect(DUMMY_SUMMARY.contributors).toHaveLength(1);
    expect(screen.getByText('Student')).toBeInTheDocument();
    expect(screen.getByTestId('summary-student')).toHaveTextContent('Test(test)');
    expect(screen.queryByTestId('summary-contributors')).not.toBeInTheDocument();
  });

  it('lists every contributor of a group submission under the existing testid', () => {
    const group: SubmissionSummary = {
      ...DUMMY_SUMMARY,
      student: null,
      contributors: [
        makeContributor(),
        makeContributor({
          contributor_key: 'roster:30000000-0000-0000-0000-0000000000bb',
          student: {
            id: '30000000-0000-0000-0000-0000000000bb',
            sid: '3035678',
            display_name: 'Bob Cratchit',
          },
        }),
      ],
    };
    renderAtRoute(makeProvider(makeQueryResult(group)));

    expect(screen.getByText('Contributors')).toBeInTheDocument();
    expect(screen.getByTestId('summary-contributors')).toBeInTheDocument();
    const listed = screen.getAllByTestId('summary-contributor');
    expect(listed).toHaveLength(2);
    expect(listed[0]).toHaveTextContent('Test(test)');
    expect(listed[1]).toHaveTextContent('Bob Cratchit(3035678)');
  });

  it('renders an unnamed contributor neutrally and never invents a name', () => {
    const unnamed: SubmissionSummary = {
      ...DUMMY_SUMMARY,
      student: null,
      contributors: [
        makeContributor({
          contributor_key: 'attributed:abc',
          kind: 'attributed',
          student: null,
          student_ref: 'ref-abc',
          session_count: 3,
          is_submitter: false,
        }),
      ],
    };
    renderAtRoute(makeProvider(makeQueryResult(unnamed)));

    const cell = screen.getByTestId('summary-student');
    expect(cell).toHaveTextContent(UNNAMED_CONTRIBUTOR_LABEL);
    // No invented SID, and no parenthesised placeholder standing in for one.
    expect(cell.textContent).not.toContain('(');
    expect(cell.className).not.toMatch(/text-(red|orange|yellow)-/);
  });

  it('lists a mixed named/unnamed group without dropping the unnamed member', () => {
    const mixed: SubmissionSummary = {
      ...DUMMY_SUMMARY,
      student: null,
      contributors: [
        makeContributor(),
        makeContributor({
          contributor_key: 'attributed:xyz',
          kind: 'attributed',
          student: null,
          student_ref: 'ref-xyz',
        }),
      ],
    };
    renderAtRoute(makeProvider(makeQueryResult(mixed)));

    const listed = screen.getAllByTestId('summary-contributor');
    expect(listed).toHaveLength(2);
    expect(listed[1]).toHaveTextContent(UNNAMED_CONTRIBUTOR_LABEL);
  });
});

// ---------------------------------------------------------------------------
// Coverage — §6 Rule 3, and the three states it must keep apart
// ---------------------------------------------------------------------------

/**
 * The server-backed Overview used to pass `bundle={null}` unconditionally, so
 * this surface ALWAYS said "not available" while `/local` showed real facts.
 * The server now serves the coverage stage's output on the summary, and this
 * suite pins both halves of what that has to mean here:
 *
 *  - `coverage` present → the real sections render;
 *  - `coverage` absent → "the server did not send them", and NOT a page of
 *    zeroes and NOT "nothing to note". Absence and emptiness are different
 *    claims: a zeroed panel asserts "no commits observed, no contributors, no
 *    root key", which is stronger than, and false where, the truth is that we
 *    were never told.
 */
const COVERAGE_WITH_FACTS: NonNullable<SubmissionSummary['coverage']> = {
  identity: {
    resolved: true,
    rootKeyConfigured: true,
    attributed: 2,
    unverifiable: 0,
    unattributed: 1,
  },
  concurrentRecording: [
    {
      sessionA: 'session-a',
      sessionB: 'session-b',
      contributorA: 'alice',
      contributorB: 'bob',
      overlapMs: 3 * 3_600_000 + 12 * 60_000,
      crashBounded: false,
    },
  ],
  // One student on two enrolled machines (D5) — a separate fact from the
  // partner collaboration above, and empty here so this fixture keeps
  // describing exactly what it always did.
  multiMachineRecording: [],
  droppedArtifacts: [],
  unattestedTails: [],
  dagDefects: [],
  dagCoverage: {
    sessionsObserving: 0,
    observations: 0,
    commits: 0,
    observedCommits: 0,
    witnessedOnlyCommits: 0,
    commitsWithUnrecordedParents: 0,
    commitsWithConflictingParents: 0,
    recordedRoots: 0,
    gitEventsWithoutSha: 0,
    gitEventsWithUnreadableRepository: 0,
  },
  repositoryAssumedSingle: false,
};

describe('Overview coverage panel', () => {
  it('renders the facts the server sent, not "not available"', async () => {
    const withCoverage: SubmissionSummary = { ...DUMMY_SUMMARY, coverage: COVERAGE_WITH_FACTS };
    renderOverview(makeProvider(makeQueryResult(withCoverage)));

    await waitFor(() => {
      expect(screen.getByTestId('submission-coverage-panel')).toBeInTheDocument();
    });
    // The fact a suppressed overlap used to lose entirely, now on the
    // server-backed surface for the first time.
    expect(screen.getByTestId('coverage-concurrent-row').textContent).toMatch(/alice/);
    expect(screen.getByTestId('coverage-concurrent-row').textContent).toMatch(/bob/);
    expect(screen.getByTestId('coverage-identity-counts')).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-not-available')).toBeNull();
  });

  it('says the server did not send them when coverage is absent — never zeroes', async () => {
    // DUMMY_SUMMARY deliberately carries no `coverage`: an older server.
    expect(DUMMY_SUMMARY.coverage).toBeUndefined();
    renderOverview(makeProvider(makeQueryResult(DUMMY_SUMMARY)));

    await waitFor(() => {
      expect(screen.getByTestId('coverage-not-available-note')).toBeInTheDocument();
    });
    expect(screen.getByTestId('coverage-not-available-note').textContent).toMatch(
      /did not send the coverage facts/i,
    );
    // Not "nothing to note" — that would claim we checked and found nothing.
    expect(screen.queryByTestId('coverage-nothing-to-note')).toBeNull();
    // And not a single counting section, which is where zeroes would appear.
    for (const id of [
      'coverage-identity-counts',
      'coverage-no-root-key',
      'coverage-dag-counts',
      'coverage-concurrent-recording',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('says "nothing to note" for a submission whose facts are genuinely empty', async () => {
    // Same shape the server sends for a solo, fully attributed, classically
    // sealed bundle. This is the third state, and it must not be reachable by
    // an absent payload — that is the distinction the test above protects.
    const nothingToNote: NonNullable<SubmissionSummary['coverage']> = {
      ...COVERAGE_WITH_FACTS,
      identity: {
        resolved: true,
        rootKeyConfigured: true,
        attributed: 1,
        unverifiable: 0,
        unattributed: 0,
      },
      concurrentRecording: [],
      multiMachineRecording: [],
    };
    renderOverview(makeProvider(makeQueryResult({ ...DUMMY_SUMMARY, coverage: nothingToNote })));

    await waitFor(() => {
      expect(screen.getByTestId('coverage-nothing-to-note')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('coverage-not-available')).toBeNull();
  });
});
