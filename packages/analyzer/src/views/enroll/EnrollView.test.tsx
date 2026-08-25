/**
 * EnrollView tests, at identity `format_version` 2.1.
 *
 * The happy path is one test. The rest are the ways this goes wrong for a real
 * student, because that is where the page earns its keep:
 *  - every server refusal (no institution key, API-token principal, view-as,
 *    rate limit)
 *  - no server at all (wifi dropped)
 *  - a session that expired between loading the page and pressing the button
 *  - a key that is short, long, uppercased, wrapped, or buried in prose
 *  - a credential pasted back mangled
 *
 * One property is asserted more than once on purpose: NOTHING private is ever
 * put on the wire. The request body is captured and checked to carry the public
 * key and nothing else.
 *
 * The roster and semester suites are GONE, not weakened: the route they
 * exercised (`POST /semesters/:id/enrollment`) no longer exists, and a 2.1
 * credential names no course or semester, so there is no roster precondition
 * to fail and no semester id to be wrong. That deadlock is what 2.1 removes.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { INSTITUTION_IDENTITY_FORMAT_VERSION } from '@provenance/log-core';
import { StudentCredentialResponseSchema } from '@provenance/shared/api-schemas';
import { mswServer } from '../../test-setup.js';
import { meNoSemestersHandler } from '../../test/msw-handlers.js';
import { ApiError, UnauthorizedError } from '../../api/client.js';
import { EnrollView, describeMintError, describeIssuance } from './EnrollView.js';
import { buildRecorderPasteText } from './enrollment-token.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBKEY = 'a'.repeat(64);
const STUDENT_REF = '3f0b7c22-9a1e-4a55-8b3d-2c6e1f4a8d90';

const RESPONSE = {
  credential: {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: 'berkeley',
    student_ref: STUDENT_REF,
    student_pubkey: PUBKEY,
    issued_at: '2026-08-19T17:00:00.000Z',
    expires_at: '2026-12-20',
    institution_sig: 'c'.repeat(128),
  },
  institution_cert: {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: 'berkeley',
    institution_pubkey: 'b'.repeat(64),
    valid_from: '2026-08-01',
    valid_until: '2026-12-31',
    root_sig: 'd'.repeat(128),
  },
  institution_id: 'berkeley',
  student_ref: STUDENT_REF,
  reissued: false,
  machine_count: 1,
  key_first_issued: true,
};

// The fixture is the contract: if it stops matching the schema the server
// promises, these tests are lying about what the page will receive.
StudentCredentialResponseSchema.parse(RESPONSE);

// No semester, no course: the 2.1 route takes no path parameter at all.
const ENROLL_PATH = '/api/v1/identity/credential';

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

function renderEnroll(search = '') {
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
      enrollment: RESPONSE.credential,
      enrollment_cert: RESPONSE.institution_cert,
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
        'Provenance: enrolled at berkeley',
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

  // -------------------------------------------------------------------------
  // The second machine reads as normal, not as a duplicate
  // -------------------------------------------------------------------------

  it('greets a second machine as a machine being added, not as a duplicate enrolment', async () => {
    // `reissued` is true here, and presenting THAT as "you have already
    // enrolled" is exactly what alarms a student doing the supported thing.
    mswServer.use(
      meNoSemestersHandler(),
      mintHandler({ ...RESPONSE, reissued: true, machine_count: 2, key_first_issued: true })
        .handler,
    );
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();

    await waitFor(() => expect(screen.getByTestId('enroll-token-panel')).toBeInTheDocument());
    const note = screen.getByTestId('enroll-issuance-note');
    expect(note).toHaveTextContent(/2 machines set up/i);
    expect(note).toHaveTextContent(/other ones keep working/i);
    expect(note).toHaveTextContent(/same ref/i);
    // Nothing that reads as a problem.
    expect(note).not.toHaveTextContent(/already had a credential/i);
    expect(screen.getByTestId('enroll-success-heading')).toHaveTextContent(/machine is set up/i);
    expect(screen.getByTestId('enroll-machine-count')).toHaveTextContent('2');
  });

  it('tells a student who re-enrolled the SAME machine that nothing broke', async () => {
    mswServer.use(
      meNoSemestersHandler(),
      mintHandler({ ...RESPONSE, reissued: true, machine_count: 1, key_first_issued: false })
        .handler,
    );
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();

    await waitFor(() => expect(screen.getByTestId('enroll-token-panel')).toBeInTheDocument());
    const note = screen.getByTestId('enroll-issuance-note');
    expect(note).toHaveTextContent(/already set up/i);
    expect(note).toHaveTextContent(/still works until it expires/i);
    // A single machine is not worth a machine count.
    expect(screen.queryByTestId('enroll-machine-count')).not.toBeInTheDocument();
  });

  it('invites a first-time student to come back for their next machine', async () => {
    mswServer.use(meNoSemestersHandler(), mintHandler().handler);
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();

    await waitFor(() => expect(screen.getByTestId('enroll-token-panel')).toBeInTheDocument());
    expect(screen.getByTestId('enroll-issuance-note')).toHaveTextContent(
      /another machine later\?.*come back here/is,
    );
  });

  it('does not tell a student to move their identity secret to add a machine', async () => {
    // The regression this guards: the page used to say moving to another
    // machine "means exporting your identity secret", which is both untrue now
    // and an instruction to hand-carry the one value that can sign as them.
    // The explanatory section that carried the corrected wording has since been
    // removed, so what is asserted now is the invariant itself — nowhere on the
    // page may suggest exporting or carrying the secret to add a machine.
    mswServer.use(meNoSemestersHandler(), mintHandler().handler);
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());

    expect(document.body.textContent ?? '').not.toMatch(/export.{0,40}identity secret/i);
    expect(document.body.textContent ?? '').not.toMatch(/move your identity secret/i);
  });
});

// ---------------------------------------------------------------------------
// describeIssuance — the branch table, without a render
// ---------------------------------------------------------------------------

describe('describeIssuance', () => {
  it('reads as a new machine only when the key is genuinely new', () => {
    expect(
      describeIssuance({ ...RESPONSE, reissued: true, machine_count: 3, key_first_issued: true }),
    ).toMatch(/3 machines set up/);
    // Same key, several machines on the account: this is not a new machine, so
    // the count must not be announced as if one was just added.
    expect(
      describeIssuance({ ...RESPONSE, reissued: true, machine_count: 3, key_first_issued: false }),
    ).toMatch(/already set up/);
  });

  it('never tells a student their earlier credential stopped working', () => {
    for (const machine_count of [1, 2, 5]) {
      for (const key_first_issued of [true, false]) {
        const text = describeIssuance({
          ...RESPONSE,
          reissued: machine_count > 1,
          machine_count,
          key_first_issued,
        });
        expect(text).not.toMatch(/invalid|revoked|no longer works|stopped working/i);
      }
    }
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

  /**
   * The on-screen "paste the KEY, not your secret" notice was removed at the
   * owner's request, so the only defence left in this step is the parser. This
   * asserts it is actually wired to the input — `normalizeStudentPubkey`'s own
   * branch table is covered in `enrollment-token.test.ts`.
   */
  it('refuses an identity secret pasted into the key field', async () => {
    mswServer.use(meNoSemestersHandler());
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('enroll-pubkey-input'), {
      target: {
        value:
          `Provenance student identity secret\n\n${'9'.repeat(64)}\n\n` +
          'KEEP THIS PRIVATE. Anyone holding it can sign work as you, in every course.\n',
      },
    });
    fireEvent.click(screen.getByTestId('enroll-submit'));

    expect(screen.getByTestId('enroll-pubkey-error')).toHaveTextContent(/identity SECRET/);
    expect(screen.queryByTestId('enroll-token-panel')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// No semester, anywhere
//
// REPLACES the old 'EnrollView — semester' suite. Those three tests exercised
// `POST /semesters/:id/enrollment`, a route the server no longer has. A 2.1
// credential names no course and no semester, so the input, the link param and
// the "blocked until a valid uuid" rule all describe behaviour that is gone.
// What replaces them is the assertion that none of it is there any more.
// ---------------------------------------------------------------------------

describe('EnrollView — no semester', () => {
  it('asks for nothing but the key', async () => {
    mswServer.use(meNoSemestersHandler());
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());

    expect(screen.queryByTestId('enroll-semester-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('enroll-semester-from-link')).not.toBeInTheDocument();
    // Submit is live immediately — there is no second precondition to satisfy.
    expect((screen.getByTestId('enroll-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('ignores a leftover ?semester= link rather than acting on it', async () => {
    // Course staff published these links for the 2.0 flow; they will keep
    // circulating. The param is now inert, and must not scope anything.
    mswServer.use(meNoSemestersHandler());
    const { handler, seen } = mintHandler();
    mswServer.use(handler);

    renderEnroll('?semester=00000000-0000-0000-0000-000000000010');
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    submitKey();

    await waitFor(() => expect(screen.getByTestId('enroll-token-panel')).toBeInTheDocument());
    expect(seen.body).toEqual({ student_pubkey: PUBKEY });
  });

  it('tells the student the credential is not per-course', async () => {
    mswServer.use(meNoSemestersHandler());
    renderEnroll();
    await waitFor(() => expect(screen.getByTestId('enroll-form')).toBeInTheDocument());
    expect(screen.getByText(/not tied to a course or a semester/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe('EnrollView — server refusals', () => {
  const cases: ReadonlyArray<readonly [string, number, RegExp]> = [
    ['CREDENTIAL_UNAVAILABLE', 503, /not ready to issue credentials/i],
    ['CREDENTIAL_SESSION_REQUIRED', 403, /interactive login/i],
    ['VIEW_AS_READ_ONLY', 403, /viewing as another user/i],
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
      mintHandler({ ...RESPONSE, credential: { format_version: '2.1' } }).handler,
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

  it('flags a valid credential that belongs to a different institution', async () => {
    await mintThen();
    const other = JSON.stringify({
      enrollment: { ...RESPONSE.credential, institution_id: 'stanford' },
      enrollment_cert: { ...RESPONSE.institution_cert, institution_id: 'stanford' },
    });
    fireEvent.change(screen.getByTestId('enroll-verify-input'), { target: { value: other } });
    expect(screen.getByTestId('enroll-verify-other')).toHaveTextContent('stanford');
  });

  it('names the old-recorder failure so it is not mistaken for a bad paste', async () => {
    // The sequencing hazard, surfaced on the page: a student running a 2.0-only
    // build sees `unsupported_format_version` in VS Code, and must be able to
    // tell that from a mangled selection.
    await mintThen();
    expect(screen.getByTestId('enroll-version-note')).toHaveTextContent(
      /unsupported_format_version/,
    );
    expect(screen.getByTestId('enroll-version-note')).toHaveTextContent(/too old/i);
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
  it('shows which account the credential will be issued to', async () => {
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

  it('treats a 401 as an expired session, not an issuance problem', () => {
    expect(describeMintError(new UnauthorizedError()).title).toMatch(/session expired/i);
  });

  it('treats a non-ApiError as a transport failure', () => {
    expect(describeMintError(new TypeError('Failed to fetch')).title).toMatch(
      /could not reach the server/i,
    );
  });
});
