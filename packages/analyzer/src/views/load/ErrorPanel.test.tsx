/**
 * ErrorPanel tests — parameterized over all LoaderError + SessionParseError variants.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorPanel } from './ErrorPanel.js';
import type { LoaderError, SessionParseError } from '@provenance/analysis-core/loader/types.js';

type AnyError = LoaderError | SessionParseError;

// ---------------------------------------------------------------------------
// Fixture table — one entry per discriminated union variant.
// ---------------------------------------------------------------------------

const ERROR_FIXTURES: Array<{
  label: string;
  error: AnyError;
  expectTitle: string;
  expectSuggestionFragment: string;
}> = [
  {
    label: 'not_a_zip',
    error: { kind: 'not_a_zip' },
    expectTitle: "We couldn't read that file.",
    expectSuggestionFragment: '.zip bundle',
  },
  {
    label: 'not_a_zip (with detail)',
    error: { kind: 'not_a_zip', detail: 'End of central directory record signature not found' },
    expectTitle: "We couldn't read that file.",
    expectSuggestionFragment: '.zip bundle',
  },
  {
    label: 'missing_manifest',
    error: { kind: 'missing_manifest' },
    expectTitle: 'The bundle is missing its manifest.',
    expectSuggestionFragment: '.slog files alone',
  },
  {
    label: 'invalid_manifest',
    error: { kind: 'invalid_manifest', detail: 'missing_field: assignment_id' },
    expectTitle: 'The bundle manifest is malformed.',
    expectSuggestionFragment: 'corrupted or from an incompatible',
  },
  {
    label: 'missing_signature',
    error: { kind: 'missing_signature' },
    expectTitle: 'The bundle is missing its signature.',
    expectSuggestionFragment: 'Prepare Submission Bundle',
  },
  {
    label: 'no_sessions',
    error: { kind: 'no_sessions' },
    expectTitle: 'The bundle contains no sessions.',
    expectSuggestionFragment: 'recorder was active',
  },
  {
    label: 'orphaned_meta',
    error: { kind: 'orphaned_meta', sessionId: 'abc-123' },
    expectTitle: 'A session is incomplete.',
    expectSuggestionFragment: 'Prepare Submission Bundle',
  },
  {
    label: 'orphaned_slog',
    error: { kind: 'orphaned_slog', sessionId: 'def-456' },
    expectTitle: 'A session is incomplete.',
    expectSuggestionFragment: 'Prepare Submission Bundle',
  },
  {
    label: 'unexpected_file',
    error: { kind: 'unexpected_file', filename: 'README.md' },
    expectTitle: 'The bundle contains unexpected files.',
    expectSuggestionFragment: 'Only drop bundles produced',
  },
  {
    label: 'unknown_failure',
    error: { kind: 'unknown_failure', detail: 'buildIndex threw: RangeError at line 42' },
    expectTitle: 'Something went wrong while loading the bundle.',
    expectSuggestionFragment: 'try loading the bundle again',
  },
  {
    label: 'ndjson_parse_failed',
    error: { kind: 'ndjson_parse_failed', line: 5, detail: 'Unexpected token' },
    expectTitle: 'A session log is corrupted.',
    expectSuggestionFragment: 'chain integrity violation',
  },
  {
    label: 'meta_invalid_shape',
    error: { kind: 'meta_invalid_shape', detail: 'missing session_id' },
    expectTitle: 'A session metadata file is malformed.',
    expectSuggestionFragment: 'incompatible recorder version',
  },
  {
    label: 'first_event_not_session_start',
    error: { kind: 'first_event_not_session_start', actualKind: 'doc.open' },
    expectTitle: 'A session log has an invalid format.',
    expectSuggestionFragment: '.slog file may have been edited',
  },
  {
    label: 'session_id_mismatch',
    error: { kind: 'session_id_mismatch', slogSessionId: 'a-1', metaSessionId: 'b-2' },
    expectTitle: 'A session has mismatched identifiers.',
    expectSuggestionFragment: 'may have been mixed up',
  },
];

describe('ErrorPanel', () => {
  it.each(ERROR_FIXTURES)(
    'renders distinct title and suggestion for $label',
    ({ error, expectTitle, expectSuggestionFragment }) => {
      render(<ErrorPanel error={error} />);

      expect(screen.getByTestId('error-panel')).toBeInTheDocument();
      expect(screen.getByTestId('error-title').textContent).toBe(expectTitle);

      const suggestionText = screen.getByTestId('error-suggestion').textContent ?? '';
      expect(suggestionText).toContain(expectSuggestionFragment);
    },
  );

  it('renders the retry button when onRetry is provided', () => {
    let clicked = false;
    render(
      <ErrorPanel
        error={{ kind: 'not_a_zip' }}
        onRetry={() => {
          clicked = true;
        }}
      />,
    );
    const btn = screen.getByTestId('error-retry-btn');
    expect(btn).toBeInTheDocument();
    btn.click();
    expect(clicked).toBe(true);
  });

  it('does not render the retry button when onRetry is absent', () => {
    render(<ErrorPanel error={{ kind: 'no_sessions' }} />);
    expect(screen.queryByTestId('error-retry-btn')).not.toBeInTheDocument();
  });

  it('shows the raw detail in the expandable section', () => {
    render(<ErrorPanel error={{ kind: 'invalid_manifest', detail: 'field: foo' }} />);
    // The <details> is closed by default; the raw-detail pre should still be in DOM.
    expect(screen.getByTestId('error-raw-detail').textContent).toContain('invalid_manifest');
  });

  // -------------------------------------------------------------------------
  // The two orphan variants name a FILE, not a session.
  //
  // `error.sessionId` on both is the uuid in the `.slog` FILENAME, minted by the
  // recorder's writer. It is NOT a session id: no `session.start` in the archive
  // carries that value. These used to render "Session <id> has a .slog.meta
  // file...", so a staff member reading a FAILURE panel — exactly when they go
  // looking — searched the bundle for a session that does not exist under that
  // id and found nothing.
  // -------------------------------------------------------------------------
  it.each([
    { kind: 'orphaned_meta' as const, id: 'abc-123' },
    { kind: 'orphaned_slog' as const, id: 'def-456' },
  ])('renders $kind as a filename, never as "Session <id>"', ({ kind, id }) => {
    render(<ErrorPanel error={{ kind, sessionId: id }} />);
    const text = screen.getByTestId('error-panel').textContent ?? '';

    // The mislabel, in the exact shape it used to take.
    expect(text).not.toContain(`Session ${id}`);
    // The id is named as what it actually identifies: a file on disk.
    expect(text).toContain(`session-${id}.slog`);
    // And the reader is told which space it is, since they cannot be expected
    // to know there are two.
    expect(text).toMatch(/names the log FILE/);
  });
});
