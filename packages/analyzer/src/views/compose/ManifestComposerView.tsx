/**
 * ManifestComposerView — compose, validate, preview, sign and download a
 * `.provenance-manifest`, in the browser.
 *
 * Route: `/compose/manifest`, behind `RequireAuth + RequireStaff + AppShell`.
 * STAFF ONLY. Emphatically not the student-reachable `/enroll` path: this page
 * handles the course SIGNING key, and the only reason a browser is allowed near
 * it is that the browser is staff's own machine.
 *
 * ## Why this page exists
 *
 * Composing a 2.0 manifest by hand means getting nine fields and a policy block
 * right in raw JSON and then running a CLI. Every one of those fields is signed,
 * so a typo is not a typo — it is a distributed artifact that fails at
 * activation time in a student's editor, days later, with a message about a
 * signature. This page is `tools/sign-manifest.ts` with the JSON authoring and
 * the self-check moved in front of the mistake.
 *
 * ## Where the private key goes
 *
 * Nowhere. Concretely, and this is the whole design:
 *
 *  - The key is chosen with a file picker. **This component never reads that
 *    file except inside the sign handler.** Not on selection, not to preview
 *    the public half, not to check it against the certificate — all of which
 *    would be nice affordances and all of which would mean another code path
 *    holding key bytes. `keypairFile` state is a `File`, i.e. a handle to a
 *    location on disk, and a handle is not key material.
 *  - Inside the sign handler the text is read, handed straight to
 *    `composeSignedManifest`, and dropped when the function returns. It is a
 *    parameter and a local, never state, never a ref, never a closure that
 *    outlives the call — so it is not in React DevTools, not in a component
 *    snapshot, and not in anything an error boundary would serialize.
 *  - `manifest-composer.ts` zeroes the derived bytes in a `finally` and returns
 *    only the public half. See its docstring for the rest of the audit.
 *  - This file imports no API client, touches no `localStorage` /
 *    `sessionStorage` / `indexedDB` / `document.cookie`, and calls no
 *    `console.*`. The analyzer carries no analytics or error-reporting SDK, so
 *    there is no third path to audit; if one is ever added, this page must be
 *    re-audited before it ships. `manifest-composer.leak.test.tsx` enforces the
 *    first two structurally and the rest behaviourally, by driving a real sign
 *    and asserting the key hex reaches no request, no storage, no console call,
 *    no DOM node and no produced blob.
 *
 * None of this is stated on the page — the containment is a property of the
 * code and its tests, not of a paragraph. Keep it that way here.
 *
 * ## Where the certificate comes from
 *
 * Staff upload it, alongside the keypair. It is not fetched from the server,
 * and that is a deliberate choice with three reasons:
 *
 *  1. **It is the cert that will actually be embedded.** A server-served
 *     certificate is whatever the server currently holds; if it has been
 *     re-minted with a new window since staff last looked, the page would
 *     staple a different certificate than the one they think they are
 *     distributing. The uploaded file is the artifact, verified as itself.
 *  2. **No new server surface.** A fetch route would mean an endpoint plus an
 *     `api-schemas` contract change. (It would also have collided with
 *     concurrent work in `server` and `shared` — but the reason stands without
 *     that.)
 *  3. **The two files already live together.** `tools/mint-course-cert.ts`
 *     writes the certificate next to the keypair `generate-course-keypair.ts`
 *     wrote. Staff pick two files from one directory.
 *
 * The cost is one extra file picker, and one extra chance to pick the wrong
 * file — which is why `parseCourseCertFile` refuses a keypair in that slot
 * before it does anything else.
 *
 * ## Where the root public key comes from
 *
 * `VITE_ROOT_PUBLIC_KEY_HEX`, baked into the bundle (see `lib/root-key.ts`), or
 * pasted by staff when the deployment has not set it — mirroring the CLI's
 * `--root-pubkey`. It is a PUBLIC key and is used for exactly one thing: the
 * self-verification walk. Without it, this page refuses to produce a 2.0
 * manifest at all rather than emitting one it has not checked.
 */

import { useMemo, useRef, useState } from 'react';
import { ErrorRegion } from '../../components/a11y/ErrorRegion.js';
import { StatusRegion } from '../../components/a11y/StatusRegion.js';
import { getRootPublicKeyHex } from '../../lib/root-key.js';
import {
  EMPTY_COMPOSER_FORM,
  MANIFEST_DOWNLOAD_FILENAME,
  POLICY_CAPTURE_TOGGLES,
  buildUnsignedManifest,
  composeSignedManifest,
  issuedAtFrom,
  parseCourseCertFile,
  splitPathList,
  validateComposerForm,
} from './manifest-composer.js';
import type {
  ComposeError,
  ComposeOk,
  ComposerForm,
  ComposerFormat,
  PolicyToggleKey,
} from './manifest-composer.js';
import {
  HEARTBEAT_INTERVAL_MAX_MS,
  HEARTBEAT_INTERVAL_MIN_MS,
  MANIFEST_FORMAT_VERSION_2,
  MANIFEST_FORMAT_VERSION_LEGACY,
} from '@provenance/log-core';
import type {
  CourseCert,
  ManifestCollaboration,
  ManifestScope,
  ManifestSubmission,
} from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

const INPUT_CLASS =
  'mt-1 w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none ' +
  'focus:ring-2 focus:ring-orange-500';

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <ErrorRegion className="mt-1 text-xs text-red-600">
      <span id={id} data-testid={id}>
        {message}
      </span>
    </ErrorRegion>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      {subtitle !== undefined && <p className="mt-1 text-xs text-gray-600">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ManifestComposerView
// ---------------------------------------------------------------------------

export function ManifestComposerView() {
  // issued_at defaults to now: the common case is signing a manifest today,
  // and a hand-typed timestamp is a signed field nobody re-reads.
  const [form, setForm] = useState<ComposerForm>(() => ({
    ...EMPTY_COMPOSER_FORM,
    issued_at: issuedAtFrom(new Date()),
  }));
  const [filesText, setFilesText] = useState('');
  const [ignoreText, setIgnoreText] = useState('');
  const [attachmentsText, setAttachmentsText] = useState('');

  // The certificate is PUBLIC and is embedded in the output verbatim, so
  // holding its text is not a hazard — unlike the keypair, below.
  const [certText, setCertText] = useState<string | null>(null);
  const [certName, setCertName] = useState<string | null>(null);
  const [certError, setCertError] = useState<string | null>(null);

  // A HANDLE, never contents. See the module docstring.
  const [keypairFile, setKeypairFile] = useState<File | null>(null);

  const [rootPubkeyInput, setRootPubkeyInput] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ComposeOk | null>(null);
  const [error, setError] = useState<ComposeError | null>(null);
  const [copied, setCopied] = useState(false);

  const certInputRef = useRef<HTMLInputElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);

  const bakedRootPubkey = getRootPublicKeyHex();
  const rootPubkeyHex =
    bakedRootPubkey ?? (rootPubkeyInput.trim().length > 0 ? rootPubkeyInput.trim() : null);

  const isV2 = form.format === MANIFEST_FORMAT_VERSION_2;

  const cert: CourseCert | null = useMemo(() => {
    if (certText === null) return null;
    const parsed = parseCourseCertFile(certText);
    return parsed.ok ? parsed.value : null;
  }, [certText]);

  const issues = validateComposerForm(form, cert);
  const issueFor = (field: string): string | undefined =>
    issues.find((i) => i.field === field)?.message;

  const preview = useMemo(() => {
    try {
      return JSON.stringify(buildUnsignedManifest(form), null, 2);
    } catch {
      // buildUnsignedManifest is total over the form type; the guard is here so
      // a preview can never take the page down.
      return '';
    }
  }, [form]);

  function update(patch: Partial<ComposerForm>): void {
    setForm((f) => ({ ...f, ...patch }));
    setResult(null);
    setError(null);
  }

  function updatePolicy(patch: Partial<ComposerForm['policy']>): void {
    setForm((f) => ({ ...f, policy: { ...f.policy, ...patch } }));
    setResult(null);
    setError(null);
  }

  async function handleCertChosen(file: File | undefined): Promise<void> {
    setResult(null);
    setError(null);
    if (file === undefined) return;
    const text = await file.text();
    const parsed = parseCourseCertFile(text);
    if (!parsed.ok) {
      // Do NOT keep the text of a file we just refused — in the
      // looks_like_a_private_key case it is a private key.
      setCertText(null);
      setCertName(null);
      setCertError(parsed.error.message);
      if (certInputRef.current !== null) certInputRef.current.value = '';
      return;
    }
    setCertError(null);
    setCertText(text);
    setCertName(file.name);
  }

  function handleKeypairChosen(file: File | undefined): void {
    setResult(null);
    setError(null);
    // Deliberately not read here. The handle is all this component keeps.
    setKeypairFile(file ?? null);
  }

  async function handleSign(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitted(true);
    setResult(null);
    setError(null);

    if (keypairFile === null) {
      setError({ kind: 'bad_key_file', message: 'Choose your course keypair file first.' });
      return;
    }

    setBusy(true);
    try {
      // The one and only read of the key file. `keypairText` is a local: it is
      // not stored, not logged, and is unreachable once this function returns.
      const keypairText = await keypairFile.text();
      const composed = await composeSignedManifest({
        form,
        keypairFileText: keypairText,
        certFileText: certText,
        rootPubkeyHex,
      });
      if (composed.ok) {
        setResult(composed.value);
      } else {
        setError(composed.error);
      }
    } finally {
      setBusy(false);
    }
  }

  function handleCopy(): void {
    if (result === null) return;
    void navigator.clipboard
      ?.writeText(result.fileText)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        /* the textarea below selects on focus */
      });
  }

  function handleStartOver(): void {
    setResult(null);
    setError(null);
    setSubmitted(false);
    setKeypairFile(null);
    if (keyInputRef.current !== null) keyInputRef.current.value = '';
  }

  // The blob URL carries the MANIFEST, which is public by construction — it is
  // the file handed to every student in the class.
  const downloadHref = useMemo(() => {
    if (result === null) return null;
    return URL.createObjectURL(new Blob([result.fileText], { type: 'application/json' }));
  }, [result]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Manifest composer</h1>
        <p className="mt-2 text-sm text-gray-700">
          Build, sign and download the <span className="font-mono">.provenance-manifest</span> for
          an assignment.
        </p>
      </header>

      <form onSubmit={(e) => void handleSign(e)} data-testid="composer-form">
        {/* ── Format ────────────────────────────────────────────────────── */}
        <Section
          title="Format"
          subtitle="2.0 carries the trust chain and the capture policy. 1.0 is the legacy shape and stays supported forever, for courses still on a 1.x recorder."
        >
          <div className="flex gap-4">
            {(
              [
                MANIFEST_FORMAT_VERSION_2,
                MANIFEST_FORMAT_VERSION_LEGACY,
              ] as readonly ComposerFormat[]
            ).map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm text-gray-800">
                <input
                  type="radio"
                  name="format"
                  value={value}
                  checked={form.format === value}
                  onChange={() => update({ format: value })}
                  data-testid={`composer-format-${value}`}
                />
                <span className="font-mono">{value}</span>
              </label>
            ))}
          </div>
        </Section>

        {/* ── Assignment ────────────────────────────────────────────────── */}
        <Section title="Assignment">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="composer-assignment-id" className="text-xs font-medium text-gray-700">
                assignment_id
              </label>
              <input
                id="composer-assignment-id"
                className={INPUT_CLASS}
                value={form.assignment_id}
                onChange={(e) => update({ assignment_id: e.target.value })}
                placeholder="proj2"
                data-testid="composer-assignment-id"
                aria-invalid={submitted && issueFor('assignment_id') !== undefined}
              />
              {submitted && (
                <FieldError id="composer-assignment-id-error" message={issueFor('assignment_id')} />
              )}
            </div>
            <div>
              <label htmlFor="composer-semester" className="text-xs font-medium text-gray-700">
                semester
              </label>
              <input
                id="composer-semester"
                className={INPUT_CLASS}
                value={form.semester}
                onChange={(e) => update({ semester: e.target.value })}
                placeholder="fa26"
                data-testid="composer-semester"
              />
              {submitted && (
                <FieldError id="composer-semester-error" message={issueFor('semester')} />
              )}
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="composer-issued-at" className="text-xs font-medium text-gray-700">
                issued_at
              </label>
              <input
                id="composer-issued-at"
                className={INPUT_CLASS}
                value={form.issued_at}
                onChange={(e) => update({ issued_at: e.target.value })}
                placeholder="2026-09-08T00:00:00Z"
                data-testid="composer-issued-at"
              />
              <p className="mt-1 text-xs text-gray-500">
                Defaults to now, in UTC. The certificate&rsquo;s validity window is checked against
                this date.
              </p>
              {submitted && (
                <FieldError id="composer-issued-at-error" message={issueFor('issued_at')} />
              )}
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="composer-files" className="text-xs font-medium text-gray-700">
                files_under_review — one path per line
              </label>
              <textarea
                id="composer-files"
                rows={5}
                className={`${INPUT_CLASS} font-mono`}
                value={filesText}
                onChange={(e) => {
                  setFilesText(e.target.value);
                  update({ files_under_review: splitPathList(e.target.value) });
                }}
                placeholder={'src/main.py\nsrc/helpers.py'}
                data-testid="composer-files"
              />
              <p className="mt-1 text-xs text-gray-500">
                Relative to the folder holding the manifest. Blank lines, duplicates and stray
                trailing spaces are dropped — a path with an invisible trailing space is signed and
                then matches nothing.
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Three forms: an exact path (<code>Makefile</code>), a folder and everything under it
                (<code>src/</code>), or a filename suffix at any depth (<code>*.java</code>). There
                is no <code>**</code> and no mid-path wildcard.
              </p>
              {submitted && (
                <FieldError id="composer-files-error" message={issueFor('files_under_review')} />
              )}
            </div>
          </div>
        </Section>

        {isV2 && (
          <>
            {/* ── Certificate ───────────────────────────────────────────── */}
            <Section
              title="Course certificate"
              subtitle="The root-signed file from tools/mint-course-cert.ts. It is public and is copied into the manifest verbatim."
            >
              <input
                ref={certInputRef}
                type="file"
                accept=".json,application/json"
                onChange={(e) => void handleCertChosen(e.target.files?.[0])}
                data-testid="composer-cert-input"
                aria-label="Course certificate file"
                className="text-sm"
              />
              {cert !== null && (
                <StatusRegion className="mt-3">
                  <dl
                    className="rounded border border-green-300 bg-green-50 p-3 text-xs text-green-900"
                    data-testid="composer-cert-summary"
                  >
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0">File</dt>
                      <dd className="font-mono break-all">{certName}</dd>
                    </div>
                    <div className="mt-1 flex gap-2">
                      <dt className="w-28 shrink-0">course_id</dt>
                      <dd className="font-mono break-all" data-testid="composer-cert-course-id">
                        {cert.course_id}
                      </dd>
                    </div>
                    <div className="mt-1 flex gap-2">
                      <dt className="w-28 shrink-0">course_pubkey</dt>
                      <dd className="font-mono break-all">{cert.course_pubkey}</dd>
                    </div>
                    <div className="mt-1 flex gap-2">
                      <dt className="w-28 shrink-0">valid</dt>
                      <dd className="font-mono break-all">
                        {cert.valid_from} → {cert.valid_until}
                      </dd>
                    </div>
                  </dl>
                </StatusRegion>
              )}
              {certError !== null && (
                <ErrorRegion className="mt-3 rounded border border-red-300 bg-red-50 p-3">
                  <p className="text-xs text-red-900" data-testid="composer-cert-error">
                    {certError}
                  </p>
                </ErrorRegion>
              )}
              {submitted && certError === null && (
                <FieldError id="composer-cert-missing-error" message={issueFor('course_cert')} />
              )}
            </Section>

            {/* ── 2.0 fields ────────────────────────────────────────────── */}
            <Section title="Course and scope">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor="composer-course-id" className="text-xs font-medium text-gray-700">
                    course_id
                  </label>
                  <input
                    id="composer-course-id"
                    className={INPUT_CLASS}
                    value={form.course_id}
                    onChange={(e) => update({ course_id: e.target.value })}
                    placeholder="berkeley-cs61b"
                    data-testid="composer-course-id"
                    aria-invalid={issueFor('course_id') !== undefined}
                    aria-describedby={
                      issueFor('course_id') !== undefined ? 'composer-course-id-error' : undefined
                    }
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    The id in your course certificate. It must match exactly.
                  </p>
                  {cert !== null && (
                    <button
                      type="button"
                      onClick={() => update({ course_id: cert.course_id })}
                      data-testid="composer-course-id-fill"
                      className="mt-1 text-xs font-medium text-orange-700 underline-offset-4 hover:underline"
                    >
                      Use the certificate&rsquo;s id ({cert.course_id})
                    </button>
                  )}
                  {/* Shown as soon as it is wrong, not only after a submit: this
                      is the one field where a mismatch means the manifest signs
                      fine and then fails verification in a student's editor. */}
                  <FieldError id="composer-course-id-error" message={issueFor('course_id')} />
                </div>

                <div>
                  <label
                    htmlFor="composer-collaboration"
                    className="text-xs font-medium text-gray-700"
                  >
                    collaboration
                  </label>
                  <select
                    id="composer-collaboration"
                    className={INPUT_CLASS}
                    value={form.collaboration}
                    onChange={(e) =>
                      update({ collaboration: e.target.value as ManifestCollaboration })
                    }
                    data-testid="composer-collaboration"
                  >
                    <option value="solo">solo</option>
                    <option value="group">group</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    <span className="font-mono">solo</span> — one student.{' '}
                    <span className="font-mono">group</span> — a second contributor is expected, so
                    the analyzer compares them instead of flagging one.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="composer-submission"
                    className="text-xs font-medium text-gray-700"
                  >
                    submission
                  </label>
                  <select
                    id="composer-submission"
                    className={INPUT_CLASS}
                    value={form.submission}
                    onChange={(e) => update({ submission: e.target.value as ManifestSubmission })}
                    data-testid="composer-submission"
                  >
                    <option value="bundle">bundle</option>
                    <option value="git">git</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    How work reaches you. <span className="font-mono">bundle</span> — students seal
                    and upload a zip. <span className="font-mono">git</span> — they push to a repo,
                    and the recorder seals each session as it goes.
                  </p>
                </div>
                <div>
                  <label htmlFor="composer-scope" className="text-xs font-medium text-gray-700">
                    scope
                  </label>
                  <select
                    id="composer-scope"
                    className={INPUT_CLASS}
                    value={form.scope}
                    onChange={(e) => update({ scope: e.target.value as ManifestScope })}
                    data-testid="composer-scope"
                  >
                    <option value="directory">directory</option>
                    <option value="repo">repo</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    What the assignment covers: the folder holding this manifest, or the whole
                    repository. Recording follows{' '}
                    <span className="font-mono">files_under_review</span> either way.
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="composer-ignore" className="text-xs font-medium text-gray-700">
                    ignore — one entry per line
                  </label>
                  <textarea
                    id="composer-ignore"
                    rows={3}
                    className={`${INPUT_CLASS} font-mono`}
                    value={ignoreText}
                    onChange={(e) => {
                      setIgnoreText(e.target.value);
                      update({ ignore: splitPathList(e.target.value) });
                    }}
                    placeholder={'*.class\ntarget/'}
                    data-testid="composer-ignore"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Files the recorder will not capture at all. This is a real cost, not just less
                    noise: no events are produced for these paths, and that includes the evidence
                    that would <em>exculpate</em> a student — the typing history showing they wrote
                    the code themselves. Ignore build output and dependencies, not source.
                  </p>
                  {submitted && (
                    <FieldError id="composer-ignore-error" message={issueFor('ignore')} />
                  )}
                </div>
                <div className="sm:col-span-2">
                  <label
                    htmlFor="composer-attachments"
                    className="text-xs font-medium text-gray-700"
                  >
                    attachments — one entry per line
                  </label>
                  <textarea
                    id="composer-attachments"
                    rows={3}
                    className={`${INPUT_CLASS} font-mono`}
                    value={attachmentsText}
                    onChange={(e) => {
                      setAttachmentsText(e.target.value);
                      update({ attachments: splitPathList(e.target.value) });
                    }}
                    placeholder={'logs/\n*.log'}
                    data-testid="composer-attachments"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Files that travel with the submission but are never recorded — run logs,
                    generated output. Their path and hash are covered by the signed bundle manifest,
                    so they cannot be altered unnoticed, but they have no typing history and are
                    never compared against one.
                  </p>
                  {submitted && (
                    <FieldError id="composer-attachments-error" message={issueFor('attachments')} />
                  )}
                </div>
              </div>
            </Section>

            {/* ── Capture policy ────────────────────────────────────────── */}
            <Section
              title="Capture policy"
              subtitle="What the recorder records for this assignment. A policy can only narrow capture, and it is inside the signed payload — so you can turn capture down and a student cannot turn it off."
            >
              <ul className="space-y-3">
                {POLICY_CAPTURE_TOGGLES.map((toggle) => {
                  const key: PolicyToggleKey = toggle.key;
                  const on = form.policy[key];
                  return (
                    <li key={key} className="rounded border border-gray-200 p-3">
                      <label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={on}
                          onChange={(e) => updatePolicy({ [key]: e.target.checked })}
                          data-testid={`composer-policy-${key}`}
                        />
                        <span>
                          <span className="text-sm font-medium text-gray-900">
                            {toggle.label}{' '}
                            <span className="font-mono text-xs text-gray-500">({key})</span>
                          </span>
                          <span className="mt-0.5 block text-xs text-gray-600">
                            {toggle.captures} Events:{' '}
                            <span className="font-mono">{toggle.eventKinds.join(', ')}</span>
                          </span>
                        </span>
                      </label>
                      {!on && (
                        <p
                          className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
                          data-testid={`composer-policy-cost-${key}`}
                        >
                          <span className="font-semibold">What this costs: </span>
                          {toggle.cost}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>

              <div className="mt-4">
                <label htmlFor="composer-heartbeat" className="text-xs font-medium text-gray-700">
                  heartbeat_interval_ms
                </label>
                <input
                  id="composer-heartbeat"
                  type="number"
                  className={INPUT_CLASS}
                  value={String(form.policy.heartbeat_interval_ms)}
                  onChange={(e) => updatePolicy({ heartbeat_interval_ms: Number(e.target.value) })}
                  data-testid="composer-heartbeat"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Between {HEARTBEAT_INTERVAL_MIN_MS} and {HEARTBEAT_INTERVAL_MAX_MS} ms. Heartbeats
                  themselves are not optional — Active/Idle time and the heartbeat-gap heuristic are
                  built on them; only the cadence is yours. A longer interval means coarser idle
                  detection.
                </p>
                <FieldError
                  id="composer-heartbeat-error"
                  message={issueFor('heartbeat_interval_ms')}
                />
              </div>
            </Section>

            {/* ── Enrollment ────────────────────────────────────────────── */}
            <Section
              title="Enrollment"
              subtitle="Whether the recorder asks your students to enrol. This changes nothing about what is recorded — the bundle is identical either way. It changes whether a submission says who produced it."
            >
              <div className="rounded border border-gray-200 p-3">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form.policy.enrollment_required}
                    onChange={(e) => updatePolicy({ enrollment_required: e.target.checked })}
                    data-testid="composer-enrollment-required"
                  />
                  <span>
                    <span className="text-sm font-medium text-gray-900">
                      Require enrollment{' '}
                      <span className="font-mono text-xs text-gray-500">(enrollment.required)</span>
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-600">
                      Students who have not enrolled see “(not enrolled)” in the status bar and are
                      offered the enrollment page once. Recording works either way.
                    </span>
                  </span>
                </label>
                {!form.policy.enrollment_required && (
                  <p
                    className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
                    data-testid="composer-enrollment-cost"
                  >
                    <span className="font-semibold">What this costs: </span>
                    Submissions carry no contributor. Nothing in the bundle says who produced it, so
                    group work cannot be split between partners and a contested submission cannot be
                    tied to a person by the recording alone. Everything else — the event stream, the
                    hash chain, the seal, every validation check and heuristic — is unaffected. Turn
                    this off for solo assignments where attribution buys you nothing, and the cost
                    of confusing a first-week student is real.
                  </p>
                )}
              </div>
            </Section>
          </>
        )}

        {/* ── Signing key ───────────────────────────────────────────────── */}
        <Section
          title="Course signing key"
          subtitle="The keypair from tools/generate-course-keypair.ts. Read only while signing, and only here in your browser."
        >
          <input
            ref={keyInputRef}
            type="file"
            accept=".json,application/json"
            onChange={(e) => handleKeypairChosen(e.target.files?.[0])}
            data-testid="composer-key-input"
            aria-label="Course keypair file"
            className="text-sm"
          />
          {keypairFile !== null && (
            <p className="mt-2 text-xs text-gray-600" data-testid="composer-key-chosen">
              Selected <span className="font-mono">{keypairFile.name}</span>. Nothing has been read
              from it yet — this page opens it only when you press Sign.
            </p>
          )}

          {bakedRootPubkey === undefined && isV2 && (
            <div className="mt-4">
              <label htmlFor="composer-root-pubkey" className="text-xs font-medium text-gray-700">
                Root public key
              </label>
              <input
                id="composer-root-pubkey"
                className={`${INPUT_CLASS} font-mono`}
                value={rootPubkeyInput}
                onChange={(e) => setRootPubkeyInput(e.target.value)}
                placeholder="64 characters, digits and a–f"
                data-testid="composer-root-pubkey"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="mt-1 text-xs text-gray-500">
                This deployment has no root key baked in, so this page cannot check the chain of
                what it would produce without one. It is a public key — the same value your recorder
                build embeds — and it is used here for the self-check only. It is never written into
                the manifest.
              </p>
            </div>
          )}
        </Section>

        {/* ── Preview ───────────────────────────────────────────────────── */}
        <Section
          title="Preview — what will be signed"
          subtitle="The payload, before the signature and (at 2.0) before the certificate is stapled on. The downloaded file is this, canonicalized to one line, plus sig and course_cert."
        >
          <pre
            className="overflow-x-auto rounded border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800"
            data-testid="composer-preview"
          >
            {preview}
          </pre>
        </Section>

        <button
          type="submit"
          disabled={busy}
          data-testid="composer-sign"
          className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-orange-700 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-orange-800 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 disabled:opacity-50"
        >
          {busy ? 'Signing…' : 'Sign and verify'}
        </button>
        <p className="mt-2 text-center text-xs text-gray-500">
          The manifest is verified against the real trust chain before you are offered a download.
          If it would not verify, you get the reason instead of a file.
        </p>
      </form>

      {/* ── Failure ───────────────────────────────────────────────────── */}
      {error !== null && (
        <ErrorRegion className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-900" data-testid="composer-error-title">
            No manifest was produced.
          </p>
          <p className="mt-1 text-xs text-red-900" data-testid="composer-error-detail">
            {error.message}
          </p>
          {error.kind === 'invalid_form' && (
            <ul className="mt-2 list-disc pl-5 text-xs text-red-900">
              {error.issues.map((issue) => (
                <li key={issue.field} data-testid={`composer-error-issue-${issue.field}`}>
                  <span className="font-mono">{issue.field}</span> — {issue.message}
                </li>
              ))}
            </ul>
          )}
        </ErrorRegion>
      )}

      {/* ── Success ───────────────────────────────────────────────────── */}
      {result !== null && (
        <section className="mt-6" data-testid="composer-result">
          <div className="rounded-lg border border-green-300 bg-green-50 p-4">
            <h2 className="text-sm font-semibold text-green-900" data-testid="composer-verified">
              Signed, and verified against the {result.chain === null ? 'signing key' : 'root key'}.
            </h2>
            <dl className="mt-2 space-y-1 text-xs text-green-900">
              {result.chain !== null && (
                <div className="flex gap-2">
                  <dt className="w-32 shrink-0">Chain</dt>
                  <dd className="font-mono break-all">
                    root → cert({result.chain.course_id}) → manifest
                  </dd>
                </div>
              )}
              <div className="flex gap-2">
                <dt className="w-32 shrink-0">Signed by</dt>
                <dd className="font-mono break-all" data-testid="composer-signing-pubkey">
                  {result.coursePublicKeyHex}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0">sig</dt>
                <dd className="font-mono break-all" data-testid="composer-sig">
                  {result.sig}
                </dd>
              </div>
            </dl>
          </div>

          {result.windowWarning !== null && (
            <ErrorRegion className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="text-xs text-amber-900" data-testid="composer-window-warning">
                {result.windowWarning}
              </p>
            </ErrorRegion>
          )}

          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-3">
              {downloadHref !== null && (
                <a
                  href={downloadHref}
                  download={result.filename}
                  data-testid="composer-download"
                  className="inline-flex items-center rounded-md bg-orange-700 px-4 py-2 text-sm font-medium text-white hover:bg-orange-800"
                >
                  Download {MANIFEST_DOWNLOAD_FILENAME}
                </a>
              )}
              <button
                type="button"
                onClick={handleCopy}
                data-testid="composer-copy"
                className="rounded border border-gray-300 px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
              >
                {copied ? 'Copied' : 'Copy the file'}
              </button>
              <button
                type="button"
                onClick={handleStartOver}
                data-testid="composer-start-over"
                className="text-xs font-medium text-orange-700 underline-offset-4 hover:underline"
              >
                Sign another
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              Saved as <span className="font-mono">{MANIFEST_DOWNLOAD_FILENAME}</span> rather than{' '}
              <span className="font-mono">.provenance-manifest</span>, because a browser saving a
              dotfile hides it in your Downloads folder. The recorder accepts either name; rename it
              if your skeleton uses the dotted one.
            </p>
            <textarea
              readOnly
              rows={6}
              value={result.fileText}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="The signed manifest"
              data-testid="composer-file-text"
              className="mt-3 w-full resize-none rounded border border-gray-300 bg-gray-50 px-2 py-1.5 font-mono text-xs break-all text-gray-900"
            />
          </div>
        </section>
      )}
    </main>
  );
}
