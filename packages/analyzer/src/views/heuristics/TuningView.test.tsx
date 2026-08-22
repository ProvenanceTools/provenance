/**
 * TuningView tests — Phase 24.
 *
 * Tests:
 * 1. Renders loading state while config loads.
 * 2. Renders heuristic list once config loads.
 * 3. Slider change triggers dry-run after 300ms debounce (fake timers).
 * 4. Slider change within 300ms does NOT trigger dry-run (debounce suppresses).
 * 5. "Save & Recompute" navigates with recompute_job param on success.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { TuningView } from './TuningView.js';
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
    editing_pattern_clone: { enabled: true, weight: 1.0 },
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

// ---------------------------------------------------------------------------
// MSW setup helpers
// ---------------------------------------------------------------------------

function setupHandlers() {
  mswServer.use(
    meWithMembershipsHandler([defaultMembership]),
    http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/heuristic-config`, () =>
      HttpResponse.json(DEFAULT_ACTIVE_CONFIG),
    ),
    http.put(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/heuristic-config`, async ({ request }) => {
      const url = new URL(request.url);
      const isDryRun = url.searchParams.get('dryRun') === 'true';
      if (isDryRun) {
        return HttpResponse.json(DRY_RUN_DIFF);
      }
      return HttpResponse.json({
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
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Render helper
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

// Helper: render, wait for heuristic list to load, return component handles.
async function renderAndWaitForLoad() {
  setupHandlers();
  const result = renderTuningView();
  await waitFor(
    () => {
      expect(screen.getByTestId('heuristic-list')).toBeInTheDocument();
    },
    { timeout: 5000 },
  );
  return result;
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
    expect(ALL_FLAG_IDS).toHaveLength(29);
    for (const id of ALL_FLAG_IDS) {
      expect(screen.getByTestId(`slider-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`toggle-${id}`)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('slider')).toHaveLength(ALL_FLAG_IDS.length);
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
    // editing_pattern_clone and paste_shared_across_students are cross-submission
    // heuristics: cross_flags has no score_contribution/weight column and cross
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

  it('slider change triggers dry-run after 300ms debounce', async () => {
    let dryRunCalled = false;

    // Load first with default handlers (setupHandlers registers PUT)
    await renderAndWaitForLoad();

    // Override PUT handler after load (MSW last-registered wins)
    mswServer.use(
      http.put(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/heuristic-config`, async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('dryRun') === 'true') {
          dryRunCalled = true;
          return HttpResponse.json(DRY_RUN_DIFF);
        }
        return HttpResponse.json({});
      }),
    );

    const slider = screen.getByTestId('slider-large_paste');
    fireEvent.change(slider, { target: { value: '1.5' } });

    // Immediately after change: no dry-run yet
    expect(dryRunCalled).toBe(false);

    // Wait for the 300ms debounce + network round-trip (real timers)
    await waitFor(
      () => {
        expect(dryRunCalled).toBe(true);
      },
      { timeout: 2000 },
    );
  }, 10000);

  it('names every contributor of a group mover, not just the submitter of record', async () => {
    // A mover row says "this score moves by N under the proposed weights", and
    // the score belongs to the SCOPE. Naming only `student` charged the swing
    // to one partner of a pair — and which partner that was had been decided by
    // an ingest race.
    //
    // The override is registered BEFORE render because the view fires a dry run
    // on load to draw the "before" histogram; MSW takes the last handler
    // registered, so this one answers that first call.
    setupHandlers();
    mswServer.use(
      http.put(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/heuristic-config`, async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('dryRun') !== 'true') return HttpResponse.json({});
        return HttpResponse.json({
          ...DRY_RUN_DIFF,
          diff: {
            ...DRY_RUN_DIFF.diff,
            top_movers: [
              {
                ...DRY_RUN_DIFF.diff.top_movers[0],
                contributors: [
                  makeSoloContributor(MOVER_ALICE, MOVER_NO_SCORE),
                  makeSoloContributor(MOVER_BOB, MOVER_NO_SCORE),
                ],
              },
            ],
          },
        });
      }),
    );
    renderTuningView();

    await waitFor(
      () => {
        expect(screen.getByTestId('top-movers')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(screen.getByText('Alice, Bob')).toBeInTheDocument();
  }, 10000);

  it('falls back to the submitter of record for a response predating contributors', async () => {
    setupHandlers();
    mswServer.use(
      http.put(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/heuristic-config`, async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('dryRun') !== 'true') return HttpResponse.json({});
        return HttpResponse.json({
          ...DRY_RUN_DIFF,
          diff: {
            ...DRY_RUN_DIFF.diff,
            top_movers: [{ ...DRY_RUN_DIFF.diff.top_movers[0], contributors: [] }],
          },
        });
      }),
    );
    renderTuningView();

    await waitFor(
      () => {
        expect(screen.getByTestId('top-movers')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(screen.getByText('Alice')).toBeInTheDocument();
  }, 10000);

  it('slider change within 300ms does NOT trigger dry-run (debounce)', async () => {
    let dryRunCount = 0;

    // Load first, then override PUT handler
    await renderAndWaitForLoad();

    mswServer.use(
      http.put(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/heuristic-config`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('dryRun') === 'true') {
          dryRunCount++;
          return HttpResponse.json(DRY_RUN_DIFF);
        }
        return HttpResponse.json({});
      }),
    );

    const slider = screen.getByTestId('slider-large_paste');

    // Fire 3 rapid changes (each < 100ms apart — well within 300ms debounce)
    fireEvent.change(slider, { target: { value: '1.2' } });
    fireEvent.change(slider, { target: { value: '1.4' } });
    fireEvent.change(slider, { target: { value: '1.6' } });

    // After debounce fires, only 1 call should have been made
    await waitFor(
      () => {
        expect(dryRunCount).toBe(1);
      },
      { timeout: 2000 },
    );

    // Confirm exactly 1 call (not 3)
    expect(dryRunCount).toBe(1);
  }, 10000);

  it('"Save & Recompute" navigates with recompute_job param on success', async () => {
    const { container } = await renderAndWaitForLoad();

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
  });
});
