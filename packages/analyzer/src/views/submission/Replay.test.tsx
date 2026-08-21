/**
 * Replay tab smoke tests — verify wiring between provider/index hook and the
 * v2 ReplayInner. The inner's own behavior (transport, scrubbing, gutter
 * decorations, jump targets) is covered by views/replay/ReplayView.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';

import { SubmissionDataContext } from '../../data/SubmissionDataProvider.js';
import type {
  SubmissionDataProvider,
  FileListResult,
  FileContentResult,
  FileProvenanceResult,
  SubmissionStats,
  ValidationResults,
  SubmittedFileListResult,
  SubmittedFileContentResult,
} from '../../data/SubmissionDataProvider.js';
import type { SubmissionSummary, FlagRow, EventRow } from '@provenance/shared/api-schemas';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import {
  buildIndexFromEventRows,
  type ServerEventRow,
} from '@provenance/analysis-core/index/build-index.js';
import { Replay, toFlag } from './Replay.js';
import { buildGlobalSeqLookup } from '../../data/global-seq-lookup.js';

// ---------------------------------------------------------------------------
// Mock useFullEventIndex so we don't actually hit the network.
// ---------------------------------------------------------------------------

const mockIndexResult: { value: UseQueryResult<EventIndex> | null } = { value: null };

vi.mock('../../data/useFullEventIndex.js', () => ({
  useFullEventIndex: () => mockIndexResult.value,
}));

// Mock Monaco so the reconstructed file content is assertable via data-value
// (mirrors views/replay/ReplayView.test.tsx).
vi.mock('@monaco-editor/react', () => ({
  default: ({ value }: { value: string }) => <div data-testid="monaco-editor" data-value={value} />,
}));

function makeQueryResult<T>(data: T): UseQueryResult<T> {
  return {
    data,
    isLoading: false,
    isError: false,
    isPending: false,
    isSuccess: true,
    isFetching: false,
    isStale: false,
    error: null,
    status: 'success',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<T>;
}

function loadingResult<T>(): UseQueryResult<T> {
  return {
    data: undefined,
    isLoading: true,
    isError: false,
    isPending: true,
    isSuccess: false,
    isFetching: true,
    isStale: false,
    error: null,
    status: 'pending',
    fetchStatus: 'fetching',
  } as unknown as UseQueryResult<T>;
}

// ---------------------------------------------------------------------------
// Synthetic single-session, single-file index for ReplayInner to consume.
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-1';

function buildSyntheticIndex(): EventIndex {
  const wallBase = 1_700_000_000_000;
  const rows: ServerEventRow[] = [
    {
      seq: 0,
      session_id: SESSION_ID,
      t: 0,
      wall: new Date(wallBase).toISOString(),
      kind: 'session.start',
      payload: {},
    },
    {
      seq: 1,
      session_id: SESSION_ID,
      t: 100,
      wall: new Date(wallBase + 100).toISOString(),
      kind: 'doc.open',
      payload: { path: 'hw1.py', content: '' },
    },
    {
      seq: 2,
      session_id: SESSION_ID,
      t: 200,
      wall: new Date(wallBase + 200).toISOString(),
      kind: 'doc.change',
      payload: {
        path: 'hw1.py',
        source: 'typed',
        deltas: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            text: 'hello',
          },
        ],
      },
    },
  ];
  return buildIndexFromEventRows(rows);
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

function makeProvider(): SubmissionDataProvider {
  const stats: SubmissionStats = {
    per_file: [{ path: 'hw1.py', final_length: 5, saves: 0 }],
    aggregate: {
      total_events: 3,
      total_saves: 0,
      total_sessions: 1,
      total_wall_ms: 200,
    },
  };
  const summary: SubmissionSummary = {
    id: 'test-sub-id',
    student: { sid: 'test', display_name: 'Test Student' },
    contributors: [
      {
        contributor_key: 'roster:30000000-0000-0000-0000-0000000000aa',
        kind: 'roster',
        student: {
          id: '30000000-0000-0000-0000-0000000000aa',
          sid: 'test',
          display_name: 'Test Student',
        },
        student_ref: null,
        session_count: 0,
        is_submitter: true,
        score_total: 0,
        score_max_severity: 'info',
        flag_counts: { info: 0, low: 0, medium: 0, high: 0 },
      },
    ],
    assignment: { assignment_id_str: 'hw1', label: 'Homework 1' },
    version_index: 1,
    score_total: 0,
    score_max_severity: null,
    validation_status: 'pass',
    validation_overall_detail: null,
    heuristic_config_version: 1,
    flag_count: 0,
    ingested_at: '2025-01-01T00:00:00.000Z',
    source_filename: 'test.zip',
    session_ids: [SESSION_ID],
  };
  const files: FileListResult = { files: stats.per_file };
  const validation: ValidationResults = { overall: 'pass', checks: [] };

  return {
    useSummary: () => makeQueryResult(summary),
    useEvents: () => makeQueryResult([] as EventRow[]),
    useEvent: () => makeQueryResult(null),
    useFlags: () => makeQueryResult([] as FlagRow[]),
    useStats: () => makeQueryResult(stats),
    useValidation: () => makeQueryResult(validation),
    useFiles: () => makeQueryResult(files),
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

function renderReplay(provider: SubmissionDataProvider) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/s/cs61a/fa26/sub/test-sub-id']}>
        <Routes>
          <Route
            path="/s/:courseSlug/:semesterSlug/sub/:submissionId"
            element={
              <SubmissionDataContext.Provider value={provider}>
                <Replay />
              </SubmissionDataContext.Provider>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Replay tab (v3)', () => {
  beforeEach(() => {
    mockIndexResult.value = null;
  });

  it('shows loading state while the event index is being fetched, announced via role=status', () => {
    mockIndexResult.value = loadingResult<EventIndex>();
    renderReplay(makeProvider());
    const loadingEl = screen.getByTestId('replay-loading');
    expect(loadingEl).toBeInTheDocument();
    expect(loadingEl.closest('[role="status"]')).not.toBeNull();
  });

  it('shows error state announced via role=alert', () => {
    mockIndexResult.value = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
    } as unknown as UseQueryResult<EventIndex>;
    renderReplay(makeProvider());
    const errorEl = screen.getByTestId('replay-error');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl.closest('[role="alert"]')).not.toBeNull();
  });

  it('renders ReplayInner once index and summary are ready', async () => {
    mockIndexResult.value = makeQueryResult(buildSyntheticIndex());
    renderReplay(makeProvider());
    await waitFor(() => {
      expect(screen.getByTestId('replay-view')).toBeInTheDocument();
    });
  });

  it('shows no-session message when the picked session is missing from the index', async () => {
    // Index built without the SESSION_ID our summary points at.
    mockIndexResult.value = makeQueryResult(buildIndexFromEventRows([]));
    renderReplay(makeProvider());
    await waitFor(() => {
      expect(screen.getByTestId('replay-session-missing')).toBeInTheDocument();
    });
  });

  it('reconstructs the SECOND session’s own content in the full (server-backed) view', async () => {
    // Regression: the full analyzer view feeds the same ReplayInner/engine a
    // multi-session index. sess-2's events carry higher true globalIdx values
    // than their session-local positions. The pre-fix engine treated the
    // playhead as a session-local index and truncated reconstruction to the
    // first session, so every later session showed empty/first-session content.
    const wallBase = 1_700_000_000_000;
    const rows: ServerEventRow[] = [
      // sess-1 (earlier wall → lower globalIdx: 0,1,2)
      {
        seq: 0,
        session_id: 'sess-1',
        t: 0,
        wall: new Date(wallBase).toISOString(),
        kind: 'session.start',
        payload: {},
      },
      {
        seq: 1,
        session_id: 'sess-1',
        t: 100,
        wall: new Date(wallBase + 100).toISOString(),
        kind: 'doc.open',
        payload: { path: 'hw1.py', content: '' },
      },
      {
        seq: 2,
        session_id: 'sess-1',
        t: 200,
        wall: new Date(wallBase + 200).toISOString(),
        kind: 'doc.change',
        payload: {
          path: 'hw1.py',
          source: 'typed',
          deltas: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              text: 'hello',
            },
          ],
        },
      },
      // sess-2 (later wall → higher globalIdx: 3,4,5)
      {
        seq: 0,
        session_id: 'sess-2',
        t: 0,
        wall: new Date(wallBase + 1000).toISOString(),
        kind: 'session.start',
        payload: {},
      },
      {
        seq: 1,
        session_id: 'sess-2',
        t: 100,
        wall: new Date(wallBase + 1100).toISOString(),
        kind: 'doc.open',
        payload: { path: 'part2.py', content: '' },
      },
      {
        seq: 2,
        session_id: 'sess-2',
        t: 200,
        wall: new Date(wallBase + 1200).toISOString(),
        kind: 'doc.change',
        payload: {
          path: 'part2.py',
          source: 'typed',
          deltas: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              text: 'world',
            },
          ],
        },
      },
    ];
    mockIndexResult.value = makeQueryResult(buildIndexFromEventRows(rows));

    const provider = makeProvider();
    const twoSessionProvider: SubmissionDataProvider = {
      ...provider,
      useSummary: () =>
        makeQueryResult({
          ...(provider.useSummary().data as SubmissionSummary),
          session_ids: ['sess-1', 'sess-2'],
        }),
    };

    // ?session=sess-2 picks the later session; ?event=5 seeks to its doc.change
    // (true globalIdx 5). part2.py must reconstruct to 'world'.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/s/cs61a/fa26/sub/test-sub-id?session=sess-2&event=5']}>
          <Routes>
            <Route
              path="/s/:courseSlug/:semesterSlug/sub/:submissionId"
              element={
                <SubmissionDataContext.Provider value={twoSessionProvider}>
                  <Replay />
                </SubmissionDataContext.Provider>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor').getAttribute('data-value')).toBe('world');
    });
  });
});

// ---------------------------------------------------------------------------
// toFlag — FlagRow → Flag projection
//
// Flag.supportingSeqs are `${sessionId}:${seq}` keys that must resolve in
// index.bySeq for JumpControls to be able to land on the evidence. The server
// hands us globalIdx ints instead, so the keys are rebuilt from the index.
// ---------------------------------------------------------------------------

/**
 * Two sessions numbered the way the events API numbers them: `seq` is the
 * global chronological index. sess-a holds 0–1, sess-b holds 2–3.
 */
function crossSessionIndex(): EventIndex {
  const wallBase = 1_700_000_000_000;
  return buildIndexFromEventRows([
    {
      seq: 0,
      session_id: 'sess-a',
      t: 0,
      wall: new Date(wallBase).toISOString(),
      kind: 'session.start',
      payload: {},
    },
    {
      seq: 1,
      session_id: 'sess-a',
      t: 100,
      wall: new Date(wallBase + 100).toISOString(),
      kind: 'paste',
      payload: { path: 'hw1.py' },
    },
    {
      seq: 2,
      session_id: 'sess-b',
      t: 0,
      wall: new Date(wallBase + 1000).toISOString(),
      kind: 'session.start',
      payload: {},
    },
    {
      seq: 3,
      session_id: 'sess-b',
      t: 100,
      wall: new Date(wallBase + 1100).toISOString(),
      kind: 'fs.external_change',
      payload: { path: 'hw1.py' },
    },
  ]);
}

function flagRow(overrides: Partial<FlagRow> = {}): FlagRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    heuristic_id: 'external_edits',
    severity: 'high',
    confidence: 0.9,
    score_contribution: 4.5,
    title: 'External edit after paste in hw1.py',
    description: 'A file changed on disk between sessions.',
    detail: null,
    ...overrides,
  };
}

describe('toFlag', () => {
  it('resolves supporting seqs that span sessions into keys the index can find', () => {
    const index = crossSessionIndex();
    const bySeq = buildGlobalSeqLookup(index);

    // The regression this guards: session_id is '' precisely when a flag's
    // evidence spans sessions, so building keys from it produced ":1" / ":3",
    // which resolve to nothing and made "jump to next flag" a no-op.
    const flag = toFlag(flagRow({ supporting_seqs: [1, 3], session_id: '' }), bySeq);

    expect(flag.supportingSeqs).toEqual(['sess-a:1', 'sess-b:3']);
    for (const key of flag.supportingSeqs) {
      expect(index.bySeq.get(key)).toBeDefined();
    }
  });

  it('drops seqs no event carries rather than emitting unresolvable keys', () => {
    const bySeq = buildGlobalSeqLookup(crossSessionIndex());
    const flag = toFlag(flagRow({ supporting_seqs: [1, 999] }), bySeq);
    expect(flag.supportingSeqs).toEqual(['sess-a:1']);
  });

  it('yields no supporting seqs while the index is still loading', () => {
    const flag = toFlag(flagRow({ supporting_seqs: [1, 3] }), buildGlobalSeqLookup(null));
    expect(flag.supportingSeqs).toEqual([]);
  });

  it('carries the persisted prose through', () => {
    const flag = toFlag(
      flagRow({ supporting_seqs: [1] }),
      buildGlobalSeqLookup(crossSessionIndex()),
    );
    expect(flag.title).toBe('External edit after paste in hw1.py');
    expect(flag.description).toBe('A file changed on disk between sessions.');
  });

  it('falls back to the heuristic id when prose was never persisted', () => {
    // Flags stored before the server persisted title/description.
    const bySeq = buildGlobalSeqLookup(crossSessionIndex());
    const flag = toFlag(flagRow({ supporting_seqs: [1], title: '', description: '' }), bySeq);
    expect(flag.title).toBe('external_edits');
    expect(flag.description).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Session resolution from ?event= alone
// ---------------------------------------------------------------------------

describe('Replay tab — session resolution', () => {
  beforeEach(() => {
    mockIndexResult.value = null;
  });

  it('opens the session that holds ?event= when no ?session= is given', async () => {
    // The flag drawer deep-links by supporting seq, which names an event but
    // not a session — and for cross-session flags there is no single session to
    // name. Falling through to session_ids[0] would open the wrong session for
    // any evidence outside the first one.
    const wallBase = 1_700_000_000_000;
    mockIndexResult.value = makeQueryResult(
      buildIndexFromEventRows([
        {
          seq: 0,
          session_id: 'sess-1',
          t: 0,
          wall: new Date(wallBase).toISOString(),
          kind: 'session.start',
          payload: {},
        },
        {
          seq: 1,
          session_id: 'sess-1',
          t: 100,
          wall: new Date(wallBase + 100).toISOString(),
          kind: 'doc.open',
          payload: { path: 'hw1.py', content: 'first' },
        },
        {
          seq: 2,
          session_id: 'sess-2',
          t: 0,
          wall: new Date(wallBase + 1000).toISOString(),
          kind: 'session.start',
          payload: {},
        },
        {
          seq: 3,
          session_id: 'sess-2',
          t: 100,
          wall: new Date(wallBase + 1100).toISOString(),
          kind: 'doc.open',
          payload: { path: 'part2.py', content: 'second' },
        },
      ]),
    );

    const provider = makeProvider();
    const twoSessionProvider: SubmissionDataProvider = {
      ...provider,
      useSummary: () =>
        makeQueryResult({
          ...(provider.useSummary().data as SubmissionSummary),
          session_ids: ['sess-1', 'sess-2'],
        }),
    };

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/s/cs61a/fa26/sub/test-sub-id?event=3']}>
          <Routes>
            <Route
              path="/s/:courseSlug/:semesterSlug/sub/:submissionId"
              element={
                <SubmissionDataContext.Provider value={twoSessionProvider}>
                  <Replay />
                </SubmissionDataContext.Provider>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // globalIdx 3 lives in sess-2, whose only file is part2.py.
    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor').getAttribute('data-value')).toBe('second');
    });
  });
});

// ---------------------------------------------------------------------------
// Session select — owned by ReplayInner, shared with the /local route
// ---------------------------------------------------------------------------

/** Renders the router's current query string so tests can assert on it. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location-probe">{location.search}</span>;
}

describe('Replay tab — session select', () => {
  beforeEach(() => {
    mockIndexResult.value = null;
  });

  /** sess-1 owns globalIdx 0-1, sess-2 owns 2-3. */
  function renderTwoSessionTab(initialEntry: string) {
    const wallBase = 1_700_000_000_000;
    mockIndexResult.value = makeQueryResult(
      buildIndexFromEventRows([
        {
          seq: 0,
          session_id: 'sess-1',
          t: 0,
          wall: new Date(wallBase).toISOString(),
          kind: 'session.start',
          payload: {},
        },
        {
          seq: 1,
          session_id: 'sess-1',
          t: 100,
          wall: new Date(wallBase + 100).toISOString(),
          kind: 'doc.open',
          payload: { path: 'hw1.py', content: 'first' },
        },
        {
          seq: 2,
          session_id: 'sess-2',
          t: 0,
          wall: new Date(wallBase + 1000).toISOString(),
          kind: 'session.start',
          payload: {},
        },
        {
          seq: 3,
          session_id: 'sess-2',
          t: 100,
          wall: new Date(wallBase + 1100).toISOString(),
          kind: 'doc.open',
          payload: { path: 'part2.py', content: 'second' },
        },
      ]),
    );

    const provider = makeProvider();
    const twoSessionProvider: SubmissionDataProvider = {
      ...provider,
      useSummary: () =>
        makeQueryResult({
          ...(provider.useSummary().data as SubmissionSummary),
          session_ids: ['sess-1', 'sess-2'],
        }),
    };

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route
              path="/s/:courseSlug/:semesterSlug/sub/:submissionId"
              element={
                <SubmissionDataContext.Provider value={twoSessionProvider}>
                  <Replay />
                  <LocationProbe />
                </SubmissionDataContext.Provider>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('renders exactly one session select — the tab no longer owns its own bar', async () => {
    renderTwoSessionTab('/s/cs61a/fa26/sub/test-sub-id?session=sess-1');
    await waitFor(() => {
      expect(screen.getAllByTestId('replay-session-select')).toHaveLength(1);
    });
    // The tab's old bar carried a visible <label for=…>; ReplayInner's control
    // uses aria-label. Two controls would mean the bars were duplicated, not moved.
    expect(screen.getAllByTestId('replay-session-switcher')).toHaveLength(1);
  });

  it('seeks the playhead when a session is picked', async () => {
    renderTwoSessionTab('/s/cs61a/fa26/sub/test-sub-id?session=sess-1');

    const select = (await screen.findByTestId('replay-session-select')) as HTMLSelectElement;
    expect(select.value).toBe('sess-1');

    fireEvent.change(select, { target: { value: 'sess-2' } });

    // sess-2's first event is globalIdx 2 (its session.start).
    await waitFor(() => {
      expect(document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')).toBe('2');
    });
    await waitFor(() => {
      expect((screen.getByTestId('replay-session-select') as HTMLSelectElement).value).toBe(
        'sess-2',
      );
    });
  });

  it('does not write ?session= back into the URL', async () => {
    // ?session= is an entry anchor only. Rewriting it would leave the address
    // bar asserting a session the playhead had already left.
    renderTwoSessionTab('/s/cs61a/fa26/sub/test-sub-id?event=3');

    // The anchor resolved to sess-2 (globalIdx 3 lives there)…
    await waitFor(() => {
      expect((screen.getByTestId('replay-session-select') as HTMLSelectElement).value).toBe(
        'sess-2',
      );
    });

    // …and it did so without the router's URL ever gaining a ?session= param.
    // (window.location is useless here — MemoryRouter never touches it.)
    const search = screen.getByTestId('location-probe').textContent ?? '';
    expect(search).toContain('event=');
    expect(search).not.toContain('session=');
  });
});
