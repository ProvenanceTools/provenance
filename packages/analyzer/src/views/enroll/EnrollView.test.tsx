/**
 * EnrollView tests.
 *
 * The happy path is one test. The rest are the ways this goes wrong for a real
 * student, because that is where the page earns its keep:
 *  - every server refusal (not on the roster, duplicate roster rows, no
 *    enrollment key configured, API-token principal, dead link, rate limit)
 *  - no server at all (wifi dropped)
 *  - a session that expired between loading the page and pressing the button
 *  - a key that is short, long, uppercased, wrapped, or buried in prose
 *  - a token pasted back mangled
 *
 * One property is asserted more than once on purpose: NOTHING private is ever
 * put on the wire. The request body is captured and checked to carry the public
 * key and nothing else.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { ENROLLMENT_FORMAT_VERSION } from '@provenance/log-core';
import { EnrollmentResponseSchema } from '@provenance/shared/api-schemas';
import { mswServer } from '../../test-setup.js';
import { meNoSemestersHandler } from '../../test/msw-handlers.js';
import { ApiError, UnauthorizedError } from '../../api/client.js';
import { EnrollView, describeMintError } from './EnrollView.js';
import { buildRecorderPasteText } from './enrollment-token.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEMESTER_ID = '00000000-0000-0000-0000-000000000010';
const PUBKEY = 'a'.repeat(64);

const RESPONSE = {
  enrollment: {
    format_version: ENROLLMENT_FORMAT_VERSION,
    student_ref: '3f0b7c22-9a1e-4a55-8b3d-2c6e1f4a8d90',
    course_id: 'berkeley-cs61b-fa26',
    student_pubkey: PUBKEY,
    issued_at: '2026-08-19T17:00:00.000Z',
    expires_at: '2026-12-20',
    enrollment_sig: 'c'.repeat(128),
  },
  enrollment_cert: {
    format_version: ENROLLMENT_FORMAT_VERSION,
    course_id: 'berkeley-cs61b-fa26',
    enrollment_pubkey: 'b'.repeat(64),
    valid_from: '2026-08-01',
    valid_until: '2026-12-31',
    course_sig: 'd'.repeat(128),
  },
  course_id: 'berkeley-cs61b-fa26',
  student_ref: '3f0b7c22-9a1e-4a55-8b3d-2c6e1f4a8d90',
  reissued: false,
};

// The fixture is the contract: if it stops matching the schema the server
// promises, these tests are lying about what the page will receive.
EnrollmentResponseSchema.parse(RESPONSE);

const ENROLL_PATH = `/api/v1/semesters/${SEMESTER_ID}/enrollment`;

/** Mint handler that records the body it was given. */
function mintHandler(body: Record<string, unknown> = RESPONSE, status = 200) {
  const seen: { body?: unknown } = {};
  const handler = http.post(ENROLL_PATH, async ({ request }) => {
    seen.body = await request.json();
    return HttpResponse.json(body, { status });
  });
  return { handler, seen };
}

function errorHandler(code: string, status: number, message = 'nope') {
  return http.post(ENROLL_PATH, () => HttpResponse.json({ error: { code, message } }, { status }));
}

function renderEnroll(search = `?semester=${SEMESTER_ID}`) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/enroll${search}`]}>
        <Routes>
          <Route path="/enroll" element={<EnrollView />} />
          <Route path="/login" element={<div data-testid="login-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Fill the key field and submit. */
function submitKey(key = PUBKEY) {
  fireEvent.change(screen.getByTestId('enroll-pubkey-input'), { target: { value: key } });
  fireEvent.click(screen.getByTestId('enroll-submit'));
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('EnrollView — minting', () => {
  it('mints a token and shows the exact text the recorder accepts', async () => {
    mswServer.use(meNoSemestersHandler());
    const { handler, seen } = mintHandler();
    mswServer.use(handler);

    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());

    submitKey();

    await waitFor(() => expect(screen.getByTestId('enroll-token-panel')).toBeInTheDocument());

    const shown = (screen.getByTestId('enroll-token-value') as HTMLTextAreaElement).value;
    expect(shown).toBe(buildRecorderPasteText(RESPONSE));
    expect(shown).not.toMatch(/[\n\r]/);
    expect(JSON.parse(shown)).toEqual({
      enrollment: RESPONSE.enrollment,
      enrollment_cert: RESPONSE.enrollment_cert,
    });

    // Only the PUBLIC key went out. Nothing else, ever.
    expect(seen.body).toEqual({ student_pubkey: PUBKEY });
  });

  it('tells the student the exact words the recorder will say on success', async () => {
    mswServer.use(meNoSemestersHandler(), mintHandler().handler);
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();

    await waitFor(() =>
      expect(screen.getByTestId('enroll-expected-message')).toHaveTextContent(
        'Provenance: enrolled in berkeley-cs61b-fa26',
      ),
    );
  });

  it('normalizes an uppercased, wrapped key before sending it', async () => {
    mswServer.use(meNoSemestersHandler());
    const { handler, seen } = mintHandler();
    mswServer.use(handler);

    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey(`  ${PUBKEY.slice(0, 20).toUpperCase()}\n${PUBKEY.slice(20).toUpperCase()}  `);

    await waitFor(() => expect(screen.getByTestId('enroll-token-panel')).toBeInTheDocument());
    expect(seen.body).toEqual({ student_pubkey: PUBKEY });
  });

  it('shows the opaque student ref, and explains it is not an SID', async () => {
    mswServer.use(meNoSemestersHandler(), mintHandler().handler);
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();

    await waitFor(() =>
      expect(screen.getByTestId('enroll-student-ref')).toHaveTextContent(RESPONSE.student_ref),
    );
    expect(screen.getByText(/not your student number/i)).toBeInTheDocument();
  });

  it('explains a re-issue instead of looking like a duplicate', async () => {
    mswServer.use(meNoSemestersHandler(), mintHandler({ ...RESPONSE, reissued: true }).handler);
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();

    await waitFor(() => expect(screen.getByTestId('enroll-token-panel')).toBeInTheDocument());
    expect(screen.getByText(/already enrolled, so the token was re-issued/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Step 1 — key validation, before a request is spent
// ---------------------------------------------------------------------------

describe('EnrollView — key validation', () => {
  it('does not call the server when the key is malformed', async () => {
    mswServer.use(meNoSemestersHandler());
    let called = false;
    mswServer.use(
      http.post(ENROLL_PATH, () => {
        called = true;
        return HttpResponse.json(RESPONSE);
      }),
    );

    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey(PUBKEY.slice(0, 63));

    await waitFor(() => expect(screen.getByTestId('enroll-pubkey-error')).toBeInTheDocument());
    expect(screen.getByTestId('enroll-pubkey-error')).toHaveTextContent('63');
    expect(called).toBe(false);
  });

  it('confirms a good key as you type, before you submit', async () => {
    mswServer.use(meNoSemestersHandler());
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('enroll-pubkey-input'), { target: { value: PUBKEY } });
    expect(screen.getByTestId('enroll-pubkey-ok')).toBeInTheDocument();
  });

  it('does not nag about an empty key before the first submit', async () => {
    mswServer.use(meNoSemestersHandler());
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());

    expect(screen.queryByTestId('enroll-pubkey-error')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('enroll-submit'));
    expect(screen.getByTestId('enroll-pubkey-error')).toBeInTheDocument();
  });

  it('warns that an identity secret must never be pasted here', async () => {
    mswServer.use(meNoSemestersHandler());
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());

    expect(screen.getByText(/not your identity secret/i)).toBeInTheDocument();
    expect(screen.getByText(/never be typed into a website/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Step 2 — the semester
// ---------------------------------------------------------------------------

describe('EnrollView — semester', () => {
  it('uses the semester from the course link without asking', async () => {
    mswServer.use(meNoSemestersHandler());
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());

    expect(screen.getByTestId('enroll-semester-from-link')).toBeInTheDocument();
    expect(screen.queryByTestId('enroll-semester-input')).not.toBeInTheDocument();
  });

  it('asks for the id when the link has no semester, and blocks submit until valid', async () => {
    mswServer.use(meNoSemestersHandler());
    renderEnroll('');
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());

    expect((screen.getByTestId('enroll-submit') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('enroll-semester-input'), { target: { value: 'cs61b' } });
    expect(screen.getByTestId('enroll-semester-error')).toBeInTheDocument();
    expect((screen.getByTestId('enroll-submit') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('enroll-semester-input'), {
      target: { value: SEMESTER_ID },
    });
    expect(screen.queryByTestId('enroll-semester-error')).not.toBeInTheDocument();
    expect((screen.getByTestId('enroll-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('treats a malformed semester in the link as no semester at all', async () => {
    mswServer.use(meNoSemestersHandler());
    renderEnroll('?semester=not-a-uuid');
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());

    expect(screen.getByTestId('enroll-semester-input')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe('EnrollView — server refusals', () => {
  const cases: ReadonlyArray<readonly [string, number, RegExp]> = [
    ['ENROLLMENT_NOT_ON_ROSTER', 403, /not on the roster/i],
    ['ENROLLMENT_ROSTER_AMBIGUOUS', 409, /lists this email twice/i],
    ['ENROLLMENT_UNAVAILABLE', 503, /not ready to issue tokens/i],
    ['ENROLLMENT_SESSION_REQUIRED', 403, /interactive login/i],
    ['NOT_FOUND', 404, /does not point at a real semester/i],
    ['VALIDATION', 400, /rejected that key/i],
    ['RATE_LIMITED', 429, /too many attempts/i],
  ];

  it.each(cases)('explains %s to the student', async (code, status, expected) => {
    mswServer.use(meNoSemestersHandler(), errorHandler(code, status));

    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();

    await waitFor(() => expect(screen.getByTestId('enroll-error-title')).toBeInTheDocument());
    const panel = screen.getByTestId('enroll-error-title').parentElement;
    expect(panel?.textContent ?? '').toMatch(expected);
    // A failure must never leave a half-rendered token on screen.
    expect(screen.queryByTestId('enroll-token-panel')).not.toBeInTheDocument();
  });

  it('offers a way back in when the session expired mid-flow', async () => {
    mswServer.use(
      meNoSemestersHandler(),
      errorHandler('AUTH_REQUIRED', 401, 'Authentication required'),
    );

    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();

    await waitFor(() => expect(screen.getByTestId('enroll-error-title')).toBeInTheDocument());
    expect(screen.getByTestId('enroll-error-title')).toHaveTextContent(/session expired/i);
    expect(screen.getByTestId('enroll-error-signin')).toBeInTheDocument();
  });

  it('reports a dead network without claiming anything was issued', async () => {
    mswServer.use(
      meNoSemestersHandler(),
      http.post(ENROLL_PATH, () => HttpResponse.error()),
    );

    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();

    await waitFor(() => expect(screen.getByTestId('enroll-error-title')).toBeInTheDocument());
    expect(screen.getByTestId('enroll-error-title')).toHaveTextContent(
      /could not reach the server/i,
    );
    expect(screen.getByTestId('enroll-error-detail')).toHaveTextContent(
      /safe to press the button/i,
    );
  });

  it('rejects a response body that does not match the contract', async () => {
    // A proxy that truncates the body must not hand a student a broken token.
    mswServer.use(
      meNoSemestersHandler(),
      mintHandler({ ...RESPONSE, enrollment: { format_version: '2.0' } }).handler,
    );

    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();

    await waitFor(() => expect(screen.getByTestId('enroll-error-title')).toBeInTheDocument());
    expect(screen.queryByTestId('enroll-token-panel')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Step 3 — checking the paste
// ---------------------------------------------------------------------------

describe('EnrollView — paste check', () => {
  async function mintThen() {
    mswServer.use(meNoSemestersHandler(), mintHandler().handler);
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();
    await waitFor(() => expect(screen.getByTestId('enroll-token-panel')).toBeInTheDocument());
  }

  it('confirms an exact paste', async () => {
    await mintThen();
    fireEvent.change(screen.getByTestId('enroll-verify-input'), {
      target: { value: buildRecorderPasteText(RESPONSE) },
    });
    expect(screen.getByTestId('enroll-verify-ok')).toBeInTheDocument();
  });

  it('catches a truncated paste and says it is cut off', async () => {
    await mintThen();
    const text = buildRecorderPasteText(RESPONSE);
    fireEvent.change(screen.getByTestId('enroll-verify-input'), {
      target: { value: text.slice(0, text.length - 30) },
    });
    expect(screen.getByTestId('enroll-verify-error')).toHaveTextContent(/cut off/i);
  });

  it('catches a mangled paste that is no longer JSON', async () => {
    await mintThen();
    fireEvent.change(screen.getByTestId('enroll-verify-input'), {
      target: { value: '{"enrollment": oops}' },
    });
    expect(screen.getByTestId('enroll-verify-error')).toBeInTheDocument();
  });

  it('flags a valid token that belongs to a different course', async () => {
    await mintThen();
    const other = JSON.stringify({
      enrollment: { ...RESPONSE.enrollment, course_id: 'berkeley-cs61c-fa26' },
      enrollment_cert: { ...RESPONSE.enrollment_cert, course_id: 'berkeley-cs61c-fa26' },
    });
    fireEvent.change(screen.getByTestId('enroll-verify-input'), { target: { value: other } });
    expect(screen.getByTestId('enroll-verify-other')).toHaveTextContent('berkeley-cs61c-fa26');
  });

  it('publishes the character count so a short paste is visible', async () => {
    await mintThen();
    expect(screen.getByTestId('enroll-token-length')).toHaveTextContent(
      String(buildRecorderPasteText(RESPONSE).length),
    );
  });

  it('goes back to the form when the student asks to enroll another key', async () => {
    await mintThen();
    fireEvent.click(screen.getByTestId('enroll-reset'));
    expect(screen.getByTestId('enroll-form')).toBeInTheDocument();
    expect(screen.queryByTestId('enroll-token-panel')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('EnrollView — account', () => {
  it('shows which account the token will be issued to', async () => {
    mswServer.use(meNoSemestersHandler());
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-signed-in-as')).toBeInTheDocument());
    expect(screen.getByTestId('enroll-signed-in-as')).toHaveTextContent('ta@berkeley.edu');
  });
});

// ---------------------------------------------------------------------------
// describeMintError — the branches, directly
// ---------------------------------------------------------------------------

describe('describeMintError', () => {
  it('maps an unknown ApiError to its server message rather than swallowing it', () => {
    const failure = describeMintError(new ApiError(500, 'BOOM', 'Internal explosion'));
    expect(failure.detail).toContain('Internal explosion');
  });

  it('treats a 401 as an expired session, not a roster problem', () => {
    expect(describeMintError(new UnauthorizedError()).title).toMatch(/session expired/i);
  });

  it('treats a non-ApiError as a transport failure', () => {
    expect(describeMintError(new TypeError('Failed to fetch')).title).toMatch(
      /could not reach the server/i,
    );
  });
});
