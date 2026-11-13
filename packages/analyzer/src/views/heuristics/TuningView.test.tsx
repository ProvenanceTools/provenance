/**
 * TuningView tests — Phase 24, redesigned 2026-11.
 *
 * Covers:
 * - Loading state; the full ALL_FLAG_IDS row set; accessible names; the
 *   cross-submission and inert-heuristic control rules.
 * - No dry-run on page open (it compared the active config with itself).
 * - Fast-path candidates (weights / turning off) auto-preview after a 400ms
 *   debounce; rapid edits collapse to one request.
 * - A candidate that turns a disabled heuristic ON never auto-previews; the
 *   footer explains why and offers an explicit [Preview impact].
 * - A result from a superseded request never overwrites a newer one.
 * - Footer only with unsaved changes; per-row reset; Discard.
 * - Details dialog: contributors label logic, zero-delta movers excluded.
 * - Save & recompute: recompute_job param + progress banner; retired ids
 *   round-trip untouched.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { TuningView, AUTO_PREVIEW_DEBOUNCE_MS } from './TuningView.js';
import {
  ALL_FLAG_IDS,
  CROSS_SUBMISSION_HEURISTIC_IDS,
} from '@provenance/analysis-core/heuristics/known-flag-ids.js';
import {
  DEFAULT_COURSE_SLUG,
  DEFAULT_SEMESTER_ID,
  DEFAULT_SEMESTER_SLUG,
  defaultMembership,
  makeSoloContributor,
  meWithMembershipsHandler,
} from '../../test/msw-handlers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  per_flag: {
    large_paste: { enabled: true, weight: 1.0 },
    external_edits: { enabled: true, weight: 1.0 },
    low_typing_high_output: { enabled: true, weight: 1.0 },
    chain_broken: { enabled: true, weight: 1.0 },
    paste_is_solution: { enabled: true, weight: 1.0 },
    mass_external_replacement: { enabled: true, weight: 1.0 },
    time_to_first_save_anomaly: { enabled: true, weight: 1.0 },
    idle_then_complete: { enabled: true, weight: 1.0 },
    no_intermediate_errors: { enabled: true, weight: 1.0 },
    paste_matches_known_source: { enabled: true, weight: 1.0 },
    ai_extension_active: { enabled: true, weight: 1.0 },
    extension_hash_mismatch: { enabled: true, weight: 1.0 },
    extension_set_changed_mid_assignment: { enabled: true, weight: 1.0 },
    clock_jumps: { enabled: true, weight: 1.0 },
    gap_in_heartbeats: { enabled: true, weight: 1.0 },
    manifest_sig_invalid: { enabled: true, weight: 1.0 },
    session_binding_invalid: { enabled: true, weight: 1.0 },
    monotonic_t_regression: { enabled: true, weight: 1.0 },
    monotonic_wall_regression: { enabled: true, weight: 1.0 },
    shell_integration_disabled: { enabled: true, weight: 1.0 },
    terminal_active_during_external_change: { enabled: true, weight: 1.0 },
    multiple_sessions_overlap: { enabled: true, weight: 1.0 },
    // Retired 2026-09, but every config stored before then still carries it —
    // exactly what the server returns for those semesters. Kept here so the
    // fixture is the real shape; see the round-trip test at the end.
    editing_pattern_clone: { enabled: false, weight: 1.0 },
    paste_shared_across_students: { enabled: true, weight: 1.0 },
  },
  severity_weights: { info: 0, low: 1, medium: 3, high: 8 },
  config_format_version: 1 as const,
};

const DEFAULT_ACTIVE_CONFIG = {
  id: 'cc000000-0000-0000-0000-000000000001',
  version: 3,
  config: DEFAULT_CONFIG,
  set_at: '2025-01-10T12:00:00.000Z',
  note: 'initial config',
  is_active: true,
};

/** Same as the default, but `large_paste` is disabled in the ACTIVE config. */
const ACTIVE_CONFIG_LARGE_PASTE_OFF = {
  ...DEFAULT_ACTIVE_CONFIG,
  config: {
    ...DEFAULT_CONFIG,
    per_flag: { ...DEFAULT_CONFIG.per_flag, large_paste: { enabled: false, weight: 1.0 } },
  },
};

const MOVER_ALICE = {
  id: '30000000-0000-0000-0000-000000000001',
  sid: '3031234',
  display_name: 'Alice',
};
const MOVER_BOB = {
  id: '30000000-0000-0000-0000-000000000002',
  sid: '3032345',
  display_name: 'Bob',
};
const MOVER_NO_SCORE = {
  score_total: 0,
  score_max_severity: 'info' as const,
  flag_counts: { info: 0, low: 0, medium: 0, high: 0 },
};

const DRY_RUN_DIFF = {
  candidate_version: 4,
  diff: {
    submissions_with_tier_change: 2,
    top_movers: [
      {
        submission_id: 'aa000000-0000-0000-0000-000000000001',
        student: { sid: '3031234', display_name: 'Alice' },
        contributors: [makeSoloContributor(MOVER_ALICE, MOVER_NO_SCORE)],
        assignment: { assignment_id_str: 'hw1', label: 'Homework 1' },
        old_score: 3.0,
        new_score: 5.0,
        old_tier: null,
        new_tier: null,
      },
    ],
    score_histogram_old: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    score_histogram_new: [0, 1, 2, 4, 4, 5, 6, 7, 8, 9],
    score_histogram_upper_bound: 50,
  },
};

type Mover = (typeof DRY_RUN_DIFF.diff.top_movers)[number];

function diffWith(overrides: Partial<typeof DRY_RUN_DIFF.diff>) {
  return { ...DRY_RUN_DIFF, diff: { ...DRY_RUN_DIFF.diff, ...overrides } };
}

const COMMIT_RESPONSE = {
  new_config: {
    id: 'cc000000-0000-0000-0000-000000000002',
    version: 4,
    set_at: '2025-01-11T00:00:00.000Z',
    note: '',
    is_active: true,
  },
  recompute_job: {
    id: 'a1000000-0000-4000-8000-000000000099',
    status: 'queued',
  },
};

// ---------------------------------------------------------------------------
// MSW setup helpers
// ---------------------------------------------------------------------------

interface Recorded {
  dryRuns: Record<string, unknown>[];
  commits: Record<string, unknown>[];
}

/**
 * Registers the default handlers and returns a live record of every dry-run
 * and commit body the view sends. `dryRun` may answer per call (1-based).
 */
function setupHandlers(
  opts: {
    activeConfig?: typeof DEFAULT_ACTIVE_CONFIG;
    dryRun?: (callNumber: number) => unknown | Promise<unknown>;
  } = {},
): Recorded {
  const recorded: Recorded = { dryRuns: [], commits: [] };
  mswServer.use(
    meWithMembershipsHandler([defaultMembership]),
    http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/heuristic-config`, () =>
      HttpResponse.json(opts.activeConfig ?? DEFAULT_ACTIVE_CONFIG),
    ),
    http.put(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/heuristic-config`, async ({ request }) => {
      const url = new URL(request.url);
      const body = (await request.json()) as Record<string, unknown>;
      if (url.searchParams.get('dryRun') === 'true') {
        recorded.dryRuns.push(body);
        const answer = opts.dryRun ? await opts.dryRun(recorded.dryRuns.length) : DRY_RUN_DIFF;
        return HttpResponse.json(answer as Record<string, unknown>);
      }
      recorded.commits.push(body);
      return HttpResponse.json(COMMIT_RESPONSE);
    }),
  );
  return recorded;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderTuningView(
  initialPath = `/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}/tuning`,
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/s/:courseSlug/:semesterSlug/tuning" element={<TuningView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Helper: render, wait for heuristic list to load, return handles + the
// recorded request bodies.
async function renderAndWaitForLoad(opts: Parameters<typeof setupHandlers>[0] = {}) {
  const recorded = setupHandlers(opts);
  const result = renderTuningView();
  await waitFor(
    () => {
      expect(screen.getByTestId('heuristic-list')).toBeInTheDocument();
    },
    { timeout: 5000 },
  );
  return { ...result, recorded };
}

/**
 * Fake timers that still advance with real time, so React Query's and MSW's
 * internal scheduling (and `waitFor`) keep working while the test controls
 * the debounce explicitly.
 */
function useDebounceTimers() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setWeight(id: string, value: string) {
  fireEvent.change(screen.getByTestId(`slider-${id}`), { target: { value } });
}

/** Make a fast-path edit, let the debounce fire, and open the Details dialog. */
async function previewAndOpenDetails() {
  setWeight('large_paste', '1.5');
  await advance(AUTO_PREVIEW_DEBOUNCE_MS);
  const details = await screen.findByTestId('details-btn', {}, { timeout: 5000 });
  fireEvent.click(details);
  return screen.findByTestId('impact-details');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.useRealTimers();
});

describe('TuningView', () => {
  it('renders loading state while config is loading', () => {
    // Slow handler — never resolves
    mswServer.use(
      http.get(`/api/v1/me`, async () => {
        await new Promise(() => {});
        return HttpResponse.json({});
      }),
    );
    renderTuningView();
    expect(screen.getByTestId('tuning-loading')).toBeInTheDocument();
  });

  it('renders heuristic list once config loads', async () => {
    await renderAndWaitForLoad();
    expect(screen.getByTestId('slider-large_paste')).toBeInTheDocument();
    expect(screen.getByTestId('toggle-large_paste')).toBeInTheDocument();
  });

  it('renders exactly one row per known flag id — the full ALL_FLAG_IDS set, no more, no less', async () => {
    // Regression guard for the 2026-08 audit finding: TuningView used to
    // hand-maintain its own id list, which silently drifted (it was missing
    // `inter_session_external_change`). It now imports ALL_FLAG_IDS
    // directly, so this asserts the render surface actually reflects that
    // canonical list — not just that the import exists.
    await renderAndWaitForLoad();
    expect(ALL_FLAG_IDS).toHaveLength(28);
    for (const id of ALL_FLAG_IDS) {
      expect(screen.getByTestId(`slider-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`toggle-${id}`)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('slider')).toHaveLength(ALL_FLAG_IDS.length);
  });

  it('groups rows into event-stream, integrity, and cross-submission panels with humanized names', async () => {
    await renderAndWaitForLoad();
    const eventStream = screen.getByTestId('heuristic-group-event-stream');
    const integrity = screen.getByTestId('heuristic-group-integrity');
    const cross = screen.getByTestId('heuristic-group-cross-submission');

    expect(within(eventStream).getByTestId('slider-large_paste')).toBeInTheDocument();
    expect(within(integrity).getByTestId('slider-chain_broken')).toBeInTheDocument();
    for (const id of CROSS_SUBMISSION_HEURISTIC_IDS) {
      expect(within(cross).getByTestId(`slider-${id}`)).toBeInTheDocument();
    }
    // Humanized name, with the raw id beneath it.
    const row = screen.getByTestId('heuristic-row-large_paste');
    expect(within(row).getByText('Large paste')).toBeInTheDocument();
    expect(within(row).getByText('large_paste')).toBeInTheDocument();
  });

  it('gives each weight slider and enable checkbox an accessible name', async () => {
    await renderAndWaitForLoad();

    // Representative slider: retrievable by accessible name matching its heuristic id.
    const slider = screen.getByRole('slider', { name: 'large_paste' });
    expect(slider).toBe(screen.getByTestId('slider-large_paste'));

    // Enable checkbox: retrievable by accessible name.
    const checkbox = screen.getByRole('checkbox', { name: 'Enable large_paste' });
    expect(checkbox).toBe(screen.getByTestId('toggle-large_paste'));

    // Every heuristic's slider must have a unique accessible name (no duplicates/collisions).
    const allSliders = screen.getAllByRole('slider');
    expect(allSliders.length).toBeGreaterThan(1);
    for (const s of allSliders) {
      expect(s).toHaveAccessibleName();
    }
  });

  it('disables the weight slider for cross-submission heuristics and explains why, while keeping the toggle functional', async () => {
    // paste_shared_across_students is a cross-submission heuristic: cross_flags has no score_contribution/weight column and cross
    // flags feed no score anywhere (only per-submission `flags` rows reach
    // computeScore). The weight slider for these ids cannot do anything, so it
    // must be disabled with a visible (non-color-only) explanation. The
    // enable/disable toggle genuinely works server-side and must stay usable.
    await renderAndWaitForLoad();

    expect(CROSS_SUBMISSION_HEURISTIC_IDS.length).toBeGreaterThan(0);

    for (const id of CROSS_SUBMISSION_HEURISTIC_IDS) {
      const slider = screen.getByTestId(`slider-${id}`);
      expect(slider).toBeDisabled();

      // The explanation must be visible text, not just an attribute or color.
      const note = screen.getByTestId(`weight-note-${id}`);
      expect(note).toBeVisible();
      expect(note).toHaveTextContent(/cross-submission flags are surfaced, not scored/i);

      // The slider must be programmatically associated with the explanation.
      expect(slider).toHaveAccessibleDescription(/cross-submission flags are surfaced/i);

      // The toggle must remain fully functional.
      const toggle = screen.getByTestId(`toggle-${id}`);
      expect(toggle).not.toBeDisabled();
      expect(toggle).toBeChecked();
      fireEvent.click(toggle);
      expect(toggle).not.toBeChecked();
    }

    // A regular per-submission heuristic must be unaffected.
    expect(screen.getByTestId('slider-large_paste')).not.toBeDisabled();
    expect(screen.queryByTestId('weight-note-large_paste')).not.toBeInTheDocument();
  });

  it('disables both the weight slider and enable toggle for paste_matches_known_source and explains why', async () => {
    // paste_matches_known_source matches pastes against a course-supplied
    // corpus (analysis-core/heuristics/config.ts: pasteMatchesKnownSource.corpus,
    // default []). Nothing in packages/server/src or packages/analyzer/src
    // populates that corpus — no upload path, no config plumbing, no storage —
    // so the heuristic emits 0 flags in every deployed semester today. Unlike
    // the cross-submission case, toggling `enabled` is ALSO inert here (0
    // flags either way), so both controls must be disabled, not just weight.
    // The row itself must still render — the flag stays a known, tunable id
    // in the catalogue (ALL_FLAG_IDS/known-flag-ids.ts) for when a corpus
    // feature ships; only the ability to set a no-op weight/toggle is removed.
    await renderAndWaitForLoad();

    const id = 'paste_matches_known_source';
    expect(ALL_FLAG_IDS).toContain(id);

    const slider = screen.getByTestId(`slider-${id}`);
    expect(slider).toBeDisabled();

    const toggle = screen.getByTestId(`toggle-${id}`);
    expect(toggle).toBeDisabled();

    const note = screen.getByTestId(`inert-note-${id}`);
    expect(note).toBeVisible();
    expect(note).toHaveTextContent(/no corpus source exists yet/i);

    // Both disabled controls must be programmatically associated with the
    // explanation, not just visually adjacent to it.
    expect(slider).toHaveAccessibleDescription(/no corpus source exists yet/i);
    expect(toggle).toHaveAccessibleDescription(/no corpus source exists yet/i);

    // A regular per-submission heuristic must be unaffected.
    expect(screen.getByTestId('toggle-large_paste')).not.toBeDisabled();
    expect(screen.queryByTestId('inert-note-large_paste')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // When dry-runs fire
  // -------------------------------------------------------------------------

  it('does not fire a dry-run on page open', async () => {
    // The old page dry-ran the active config against itself on load — a
    // heavy server call with nothing to show.
    useDebounceTimers();
    const { recorded } = await renderAndWaitForLoad();
    await advance(AUTO_PREVIEW_DEBOUNCE_MS * 5);
    expect(recorded.dryRuns).toHaveLength(0);
  });

  it('auto-runs a dry-run 400ms after a weight change, and not before', async () => {
    useDebounceTimers();
    const { recorded } = await renderAndWaitForLoad();

    setWeight('large_paste', '1.5');

    // Well inside the debounce window: nothing sent yet.
    await advance(AUTO_PREVIEW_DEBOUNCE_MS - 100);
    expect(recorded.dryRuns).toHaveLength(0);

    await advance(100);
    await waitFor(() => expect(recorded.dryRuns).toHaveLength(1), { timeout: 2000 });
    const perFlag = recorded.dryRuns[0]!['per_flag'] as Record<string, { weight: number }>;
    expect(perFlag['large_paste']!.weight).toBe(1.5);

    // The footer then carries the honest summary.
    expect(await screen.findByTestId('impact-summary')).toHaveTextContent(
      '2 submissions change tier · 1 score moves by more than 0.05',
    );
  }, 10000);

  it('collapses rapid slider changes into a single dry-run (debounce)', async () => {
    useDebounceTimers();
    const { recorded } = await renderAndWaitForLoad();

    // Three rapid changes, each well within the debounce window.
    setWeight('large_paste', '1.2');
    await advance(100);
    setWeight('large_paste', '1.4');
    await advance(100);
    setWeight('large_paste', '1.6');

    await advance(AUTO_PREVIEW_DEBOUNCE_MS);
    await waitFor(() => expect(recorded.dryRuns).toHaveLength(1), { timeout: 2000 });

    // Let any stray timer fire: still exactly 1 call (not 3), for the last value.
    await advance(AUTO_PREVIEW_DEBOUNCE_MS * 3);
    expect(recorded.dryRuns).toHaveLength(1);
    const perFlag = recorded.dryRuns[0]!['per_flag'] as Record<string, { weight: number }>;
    expect(perFlag['large_paste']!.weight).toBe(1.6);
  }, 10000);

  it('auto-previews turning a heuristic off (server fast path)', async () => {
    useDebounceTimers();
    const { recorded } = await renderAndWaitForLoad();

    fireEvent.click(screen.getByTestId('toggle-large_paste'));
    await advance(AUTO_PREVIEW_DEBOUNCE_MS);
    await waitFor(() => expect(recorded.dryRuns).toHaveLength(1), { timeout: 2000 });
    expect(screen.queryByTestId('reenable-note')).not.toBeInTheDocument();
  }, 10000);

  it('does not auto-run when a heuristic goes off → on; offers an explicit Preview impact instead', async () => {
    useDebounceTimers();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { recorded } = await renderAndWaitForLoad({
      activeConfig: ACTIVE_CONFIG_LARGE_PASTE_OFF,
      dryRun: async () => {
        await gate;
        return DRY_RUN_DIFF;
      },
    });

    // Re-enable a heuristic that is disabled in the active config…
    fireEvent.click(screen.getByTestId('toggle-large_paste'));
    // …and also move a weight, which on its own would be fast-path.
    setWeight('external_edits', '1.5');

    await advance(AUTO_PREVIEW_DEBOUNCE_MS * 5);
    expect(recorded.dryRuns).toHaveLength(0);

    expect(screen.getByTestId('reenable-note')).toHaveTextContent(
      'Re-enabling Large paste requires re-running heuristics on every submission (can take minutes).',
    );

    // Explicit preview: spinner while pending, then the summary.
    fireEvent.click(screen.getByTestId('preview-impact-btn'));
    expect(await screen.findByTestId('impact-computing')).toHaveTextContent('Computing impact…');
    await waitFor(() => expect(recorded.dryRuns).toHaveLength(1), { timeout: 2000 });
    // Save is held while the current candidate's impact is still computing.
    expect(screen.getByTestId('save-recompute-btn')).toBeDisabled();

    release();
    expect(await screen.findByTestId('impact-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('impact-computing')).not.toBeInTheDocument();
    expect(screen.getByTestId('save-recompute-btn')).not.toBeDisabled();
  }, 10000);

  it('never lets a superseded dry-run result overwrite a newer one', async () => {
    useDebounceTimers();
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { recorded } = await renderAndWaitForLoad({
      dryRun: async (n) => {
        if (n === 1) {
          await firstGate;
          return diffWith({ submissions_with_tier_change: 111 });
        }
        return diffWith({ submissions_with_tier_change: 7 });
      },
    });

    // Request 1 (held open), then request 2 for a newer candidate.
    setWeight('large_paste', '1.5');
    await advance(AUTO_PREVIEW_DEBOUNCE_MS);
    await waitFor(() => expect(recorded.dryRuns).toHaveLength(1), { timeout: 2000 });
    setWeight('large_paste', '1.8');
    await advance(AUTO_PREVIEW_DEBOUNCE_MS);
    await waitFor(() => expect(recorded.dryRuns).toHaveLength(2), { timeout: 2000 });
    expect(await screen.findByTestId('impact-summary')).toHaveTextContent(
      /^7 submissions change tier/,
    );

    // The stale request lands last; the newer result must stand.
    releaseFirst();
    await advance(50);
    await waitFor(() => expect(screen.getByTestId('impact-summary')).toBeInTheDocument());
    expect(screen.getByTestId('impact-summary')).toHaveTextContent(/^7 submissions change tier/);
    expect(screen.queryByText(/111 submissions/)).not.toBeInTheDocument();
  }, 10000);

  // -------------------------------------------------------------------------
  // Unsaved-changes footer, per-row reset, Discard
  // -------------------------------------------------------------------------

  it('hides the footer when there are no unsaved changes', async () => {
    await renderAndWaitForLoad();
    expect(screen.queryByTestId('tuning-footer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('save-recompute-btn')).not.toBeInTheDocument();

    setWeight('large_paste', '1.5');
    expect(screen.getByTestId('tuning-footer')).toBeInTheDocument();
    expect(screen.getByTestId('unsaved-count')).toHaveTextContent('1 unsaved change');

    // Dragging back to the active value is not a change.
    setWeight('large_paste', '1');
    expect(screen.queryByTestId('tuning-footer')).not.toBeInTheDocument();
  });

  it('shows a modified dot and per-row reset only on a changed row, and reset restores it', async () => {
    await renderAndWaitForLoad();
    expect(screen.queryByTestId('modified-large_paste')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reset-large_paste')).not.toBeInTheDocument();

    setWeight('large_paste', '1.5');
    fireEvent.click(screen.getByTestId('toggle-external_edits'));
    expect(screen.getByTestId('modified-large_paste')).toBeInTheDocument();
    expect(screen.getByTestId('reset-large_paste')).toBeInTheDocument();
    expect(screen.queryByTestId('reset-low_typing_high_output')).not.toBeInTheDocument();
    expect(screen.getByTestId('unsaved-count')).toHaveTextContent('2 unsaved changes');

    fireEvent.click(
      screen.getByRole('button', { name: 'Reset Large paste to the active setting' }),
    );
    expect(screen.getByTestId('slider-large_paste')).toHaveValue('1');
    expect(screen.queryByTestId('modified-large_paste')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reset-large_paste')).not.toBeInTheDocument();
    // Only the other row stays modified.
    expect(screen.getByTestId('unsaved-count')).toHaveTextContent('1 unsaved change');

    fireEvent.click(screen.getByTestId('reset-external_edits'));
    expect(screen.getByTestId('toggle-external_edits')).toBeChecked();
    expect(screen.queryByTestId('tuning-footer')).not.toBeInTheDocument();
  });

  it('Discard restores every row to the active config, cancels the pending preview, and hides the footer', async () => {
    useDebounceTimers();
    const { recorded } = await renderAndWaitForLoad();

    setWeight('large_paste', '1.5');
    fireEvent.click(screen.getByTestId('toggle-external_edits'));
    expect(screen.getByTestId('unsaved-count')).toHaveTextContent('2 unsaved changes');

    fireEvent.click(screen.getByTestId('discard-btn'));
    expect(screen.getByTestId('slider-large_paste')).toHaveValue('1');
    expect(screen.getByTestId('toggle-external_edits')).toBeChecked();
    expect(screen.queryByTestId('tuning-footer')).not.toBeInTheDocument();

    // The debounced preview for the discarded candidate never fires.
    await advance(AUTO_PREVIEW_DEBOUNCE_MS * 3);
    expect(recorded.dryRuns).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Details dialog
  // -------------------------------------------------------------------------

  it('Details shows the score histogram and the movers table', async () => {
    useDebounceTimers();
    await renderAndWaitForLoad();
    const dialog = await previewAndOpenDetails();
    expect(within(dialog).getByTestId('score-histogram')).toBeInTheDocument();
    const table = within(dialog).getByTestId('top-movers');
    expect(within(table).getByText('hw1')).toBeInTheDocument();
    expect(within(table).getByText('3.0 → 5.0')).toBeInTheDocument();
    expect(within(table).getByText('+2.0')).toBeInTheDocument();
  }, 10000);

  it('names every contributor of a group mover, not just the submitter of record', async () => {
    // A mover row says "this score moves by N under the proposed weights", and
    // the score belongs to the SCOPE. Naming only `student` charged the swing
    // to one partner of a pair — and which partner that was had been decided by
    // an ingest race.
    useDebounceTimers();
    await renderAndWaitForLoad({
      dryRun: () =>
        diffWith({
          top_movers: [
            {
              ...DRY_RUN_DIFF.diff.top_movers[0]!,
              contributors: [
                makeSoloContributor(MOVER_ALICE, MOVER_NO_SCORE),
                makeSoloContributor(MOVER_BOB, MOVER_NO_SCORE),
              ],
            },
          ],
        }),
    });
    const dialog = await previewAndOpenDetails();
    expect(within(dialog).getByTestId('top-movers')).toBeInTheDocument();
    expect(within(dialog).getByText('Alice, Bob')).toBeInTheDocument();
  }, 10000);

  it('falls back to the submitter of record for a response predating contributors', async () => {
    useDebounceTimers();
    await renderAndWaitForLoad({
      dryRun: () =>
        diffWith({ top_movers: [{ ...DRY_RUN_DIFF.diff.top_movers[0]!, contributors: [] }] }),
    });
    const dialog = await previewAndOpenDetails();
    expect(within(dialog).getByTestId('top-movers')).toBeInTheDocument();
    expect(within(dialog).getByText('Alice')).toBeInTheDocument();
  }, 10000);

  it('excludes movers whose score does not change from the movers table', async () => {
    useDebounceTimers();
    const unchanged: Mover = {
      ...DRY_RUN_DIFF.diff.top_movers[0]!,
      submission_id: 'aa000000-0000-0000-0000-000000000002',
      student: { sid: '3032345', display_name: 'Bob' },
      contributors: [makeSoloContributor(MOVER_BOB, MOVER_NO_SCORE)],
      assignment: { assignment_id_str: 'hw2', label: 'Homework 2' },
      old_score: 0,
      new_score: 0,
    };
    await renderAndWaitForLoad({
      dryRun: () => diffWith({ top_movers: [DRY_RUN_DIFF.diff.top_movers[0]!, unchanged] }),
    });
    const dialog = await previewAndOpenDetails();
    const table = within(dialog).getByTestId('top-movers');
    expect(within(table).getAllByTestId('top-mover-row')).toHaveLength(1);
    expect(within(table).getByText('Alice')).toBeInTheDocument();
    expect(within(table).queryByText('Bob')).not.toBeInTheDocument();
    expect(within(table).queryByText('hw2')).not.toBeInTheDocument();
  }, 10000);

  // -------------------------------------------------------------------------
  // Save & recompute
  // -------------------------------------------------------------------------

  it('"Save & recompute" navigates with recompute_job param on success', async () => {
    const { container, recorded } = await renderAndWaitForLoad();

    setWeight('large_paste', '1.5');
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-recompute-btn'));
    });

    // After commit, URL gets recompute_job param and progress banner appears
    await waitFor(
      () => {
        const banner = container.querySelector('[data-testid="recompute-progress-loading"]');
        const banner2 = container.querySelector('[data-testid="recompute-progress"]');
        expect(banner ?? banner2).toBeTruthy();
      },
      { timeout: 5000 },
    );
    const perFlag = recorded.commits[0]!['per_flag'] as Record<string, { weight: number }>;
    expect(perFlag['large_paste']!.weight).toBe(1.5);
  });

  it('does not offer a retired id, but sends its stored entry back untouched on save', async () => {
    // A config stored while editing_pattern_clone existed still carries its
    // entry. There is nothing to tune — nothing emits it — but the server keeps
    // the staff setting on read and accepts it on write, so the UI must neither
    // render it nor drop it.
    const { recorded } = await renderAndWaitForLoad();

    expect(screen.queryByTestId('slider-editing_pattern_clone')).toBeNull();
    expect(screen.queryByTestId('toggle-editing_pattern_clone')).toBeNull();

    // Save is only offered with an unsaved change, so make an unrelated one.
    setWeight('large_paste', '1.5');
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-recompute-btn'));
    });

    await waitFor(() => expect(recorded.commits).toHaveLength(1), { timeout: 5000 });
    const perFlag = recorded.commits[0]!['per_flag'] as Record<string, unknown>;
    expect(perFlag['editing_pattern_clone']).toEqual({ enabled: false, weight: 1.0 });
  });
});
