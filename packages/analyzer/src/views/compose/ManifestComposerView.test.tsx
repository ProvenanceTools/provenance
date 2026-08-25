/**
 * View-level tests for the manifest composer.
 *
 * These cover the promises the PAGE makes, as distinct from the promises the
 * pure module makes (`manifest-composer.test.ts`) and the key-containment gate
 * (`manifest-composer.leak.test.tsx`):
 *
 *  - a mismatched `course_id` is reported beside the field, while staff are
 *    still typing — not at download time, and not as a signature error;
 *  - there is no download link until a manifest has actually verified;
 *  - the policy UI offers three knobs and explains the cost of each;
 *  - `issued_at` is prefilled from the clock and signs as prefilled.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { POLICY_GATED_EVENT_KINDS } from '@provenance/log-core';
import { ManifestComposerView } from './ManifestComposerView.js';
import { POLICY_CAPTURE_TOGGLES } from './manifest-composer.js';
import { makeCourseCert, makeKeypair } from './composer.fixture.js';

function jsonFile(name: string, text: string): File {
  const file = new File([text], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
  return file;
}

async function fixtures(options: { validFrom?: string; validUntil?: string } = {}) {
  const root = await makeKeypair(0x51);
  const rootPrivate = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    rootPrivate[i] = Number.parseInt(root.privateKeyHex.slice(i * 2, i * 2 + 2), 16);
  }
  const course = await makeKeypair(0x22);
  const cert = await makeCourseCert({
    courseId: 'berkeley-cs61b',
    coursePubkeyHex: course.publicKeyHex,
    rootPrivateKey: rootPrivate,
    ...(options.validFrom === undefined ? {} : { validFrom: options.validFrom }),
    ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }),
  });
  return { root, course, cert };
}

/** Fill everything except the certificate, the keypair and the root key. */
function fillAssignment(courseId = 'berkeley-cs61b'): void {
  fireEvent.change(screen.getByTestId('composer-assignment-id'), { target: { value: 'proj2' } });
  fireEvent.change(screen.getByTestId('composer-semester'), { target: { value: 'fa26' } });
  fireEvent.change(screen.getByTestId('composer-issued-at'), {
    target: { value: '2026-09-08T00:00:00Z' },
  });
  fireEvent.change(screen.getByTestId('composer-files'), { target: { value: 'src/main.py' } });
  fireEvent.change(screen.getByTestId('composer-course-id'), { target: { value: courseId } });
}

/** Fill the assignment, certificate, keypair and root key with a valid 2.0 form. */
async function fillValidV2Form(): Promise<void> {
  const { root, course, cert } = await fixtures();
  fillAssignment();
  fireEvent.change(screen.getByTestId('composer-cert-input'), {
    target: { files: [jsonFile('cert.json', cert.fileText)] },
  });
  await screen.findByTestId('composer-cert-summary');
  fireEvent.change(screen.getByTestId('composer-key-input'), {
    target: { files: [jsonFile('key.json', course.fileText)] },
  });
  fireEvent.change(screen.getByTestId('composer-root-pubkey'), {
    target: { value: root.publicKeyHex },
  });
}

/** Sign the currently-filled form and return the produced manifest, parsed. */
async function signAndReadBlob(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByTestId('composer-sign'));
  await screen.findByTestId('composer-download');
  const fileText = (screen.getByTestId('composer-file-text') as HTMLTextAreaElement).value;
  return JSON.parse(fileText) as Record<string, unknown>;
}

describe('ManifestComposerView', () => {
  beforeEach(() => {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = () => 'blob:stub';
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // course_id — caught in the form
  // -------------------------------------------------------------------------

  it('flags a course_id that does not match the certificate, before any submit', async () => {
    const { cert } = await fixtures();
    render(<ManifestComposerView />);

    fireEvent.change(screen.getByTestId('composer-cert-input'), {
      target: { files: [jsonFile('cert.json', cert.fileText)] },
    });
    await screen.findByTestId('composer-cert-summary');

    fireEvent.change(screen.getByTestId('composer-course-id'), {
      target: { value: 'berkeley-cs61c' },
    });

    const error = await screen.findByTestId('composer-course-id-error');
    expect(error.textContent).toContain('berkeley-cs61b');
    expect(error.textContent).toContain('step 3');
    // Nothing was signed, and no download exists.
    expect(screen.queryByTestId('composer-download')).toBeNull();
  });

  it('clears the mismatch when the certificate id is filled in', async () => {
    const { cert } = await fixtures();
    render(<ManifestComposerView />);

    fireEvent.change(screen.getByTestId('composer-cert-input'), {
      target: { files: [jsonFile('cert.json', cert.fileText)] },
    });
    await screen.findByTestId('composer-cert-summary');
    fireEvent.change(screen.getByTestId('composer-course-id'), { target: { value: 'wrong' } });
    await screen.findByTestId('composer-course-id-error');

    fireEvent.click(screen.getByTestId('composer-course-id-fill'));
    await waitFor(() => {
      expect(screen.queryByTestId('composer-course-id-error')).toBeNull();
    });
    expect((screen.getByTestId('composer-course-id') as HTMLInputElement).value).toBe(
      'berkeley-cs61b',
    );
  });

  // -------------------------------------------------------------------------
  // Nothing unverified is downloadable
  // -------------------------------------------------------------------------

  it('offers no download until a manifest has verified', async () => {
    const { root, course, cert } = await fixtures();
    render(<ManifestComposerView />);
    expect(screen.queryByTestId('composer-download')).toBeNull();

    fillAssignment();
    fireEvent.change(screen.getByTestId('composer-cert-input'), {
      target: { files: [jsonFile('cert.json', cert.fileText)] },
    });
    await screen.findByTestId('composer-cert-summary');
    fireEvent.change(screen.getByTestId('composer-key-input'), {
      target: { files: [jsonFile('key.json', course.fileText)] },
    });
    fireEvent.change(screen.getByTestId('composer-root-pubkey'), {
      target: { value: root.publicKeyHex },
    });

    fireEvent.click(screen.getByTestId('composer-sign'));

    const link = await screen.findByTestId('composer-download');
    expect(link.getAttribute('download')).toBe('provenance-manifest');
    expect(screen.getByTestId('composer-file-text')).toBeTruthy();
  });

  it('refuses, and offers no download, when the root key does not match the certificate', async () => {
    const { course, cert } = await fixtures();
    const wrongRoot = await makeKeypair(0x77);
    render(<ManifestComposerView />);

    fillAssignment();
    fireEvent.change(screen.getByTestId('composer-cert-input'), {
      target: { files: [jsonFile('cert.json', cert.fileText)] },
    });
    await screen.findByTestId('composer-cert-summary');
    fireEvent.change(screen.getByTestId('composer-key-input'), {
      target: { files: [jsonFile('key.json', course.fileText)] },
    });
    fireEvent.change(screen.getByTestId('composer-root-pubkey'), {
      target: { value: wrongRoot.publicKeyHex },
    });

    fireEvent.click(screen.getByTestId('composer-sign'));

    const detail = await screen.findByTestId('composer-error-detail');
    expect(detail.textContent).toContain('root public key');
    expect(screen.queryByTestId('composer-download')).toBeNull();
    expect(screen.queryByTestId('composer-result')).toBeNull();
  });

  it('refuses to sign a 2.0 manifest with no root key available', async () => {
    const { course, cert } = await fixtures();
    render(<ManifestComposerView />);

    fillAssignment();
    fireEvent.change(screen.getByTestId('composer-cert-input'), {
      target: { files: [jsonFile('cert.json', cert.fileText)] },
    });
    await screen.findByTestId('composer-cert-summary');
    fireEvent.change(screen.getByTestId('composer-key-input'), {
      target: { files: [jsonFile('key.json', course.fileText)] },
    });

    fireEvent.click(screen.getByTestId('composer-sign'));

    const detail = await screen.findByTestId('composer-error-detail');
    expect(detail.textContent).toContain('root public key');
    expect(screen.queryByTestId('composer-download')).toBeNull();
  });

  it('surfaces an out-of-window certificate as a warning, not a refusal', async () => {
    const { root, course, cert } = await fixtures({
      validFrom: '2025-08-20',
      validUntil: '2026-01-15',
    });
    render(<ManifestComposerView />);

    fillAssignment();
    fireEvent.change(screen.getByTestId('composer-cert-input'), {
      target: { files: [jsonFile('cert.json', cert.fileText)] },
    });
    await screen.findByTestId('composer-cert-summary');
    fireEvent.change(screen.getByTestId('composer-key-input'), {
      target: { files: [jsonFile('key.json', course.fileText)] },
    });
    fireEvent.change(screen.getByTestId('composer-root-pubkey'), {
      target: { value: root.publicKeyHex },
    });

    fireEvent.click(screen.getByTestId('composer-sign'));

    await screen.findByTestId('composer-download');
    expect((await screen.findByTestId('composer-window-warning')).textContent).toContain('outside');
  });

  it('reports missing fields without signing', async () => {
    render(<ManifestComposerView />);
    fireEvent.click(screen.getByTestId('composer-sign'));
    const detail = await screen.findByTestId('composer-error-detail');
    expect(detail.textContent).toContain('keypair');
    expect(screen.queryByTestId('composer-download')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The policy UI
  // -------------------------------------------------------------------------

  it('renders one checkbox per gated knob and no others', () => {
    render(<ManifestComposerView />);
    const gated = Object.values(POLICY_GATED_EVENT_KINDS);
    for (const key of new Set(gated)) {
      expect(screen.getByTestId(`composer-policy-${key}`)).toBeTruthy();
    }
    // The only checkboxes on the page are those knobs.
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(POLICY_CAPTURE_TOGGLES.length);
  });

  it('explains what disabling a signal costs, only once it is disabled', () => {
    render(<ManifestComposerView />);
    expect(screen.queryByTestId('composer-policy-cost-terminal')).toBeNull();
    fireEvent.click(screen.getByTestId('composer-policy-terminal'));
    expect(screen.getByTestId('composer-policy-cost-terminal').textContent).toContain(
      'exculpatory',
    );
  });

  // -------------------------------------------------------------------------
  // issued_at
  // -------------------------------------------------------------------------

  it('prefills issued_at with the current time, to whole seconds in UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T17:04:31.412Z'));
    try {
      render(<ManifestComposerView />);
      expect((screen.getByTestId('composer-issued-at') as HTMLInputElement).value).toBe(
        '2026-09-08T17:04:31Z',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('signs the prefilled issued_at without it being typed', async () => {
    const course = await makeKeypair(0x22);

    // Only the mount is on a frozen clock — the default is read once, in the
    // state initialiser. Signing then runs on real timers, so the fake clock
    // never has to interleave with the ed25519 promises.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T17:04:31.412Z'));
    render(<ManifestComposerView />);
    vi.useRealTimers();

    fireEvent.click(screen.getByTestId('composer-format-1.0'));
    fireEvent.change(screen.getByTestId('composer-assignment-id'), { target: { value: 'proj2' } });
    fireEvent.change(screen.getByTestId('composer-semester'), { target: { value: 'fa26' } });
    fireEvent.change(screen.getByTestId('composer-files'), { target: { value: 'src/main.py' } });
    fireEvent.change(screen.getByTestId('composer-key-input'), {
      target: { files: [jsonFile('key.json', course.fileText)] },
    });
    fireEvent.click(screen.getByTestId('composer-sign'));

    await screen.findByTestId('composer-download');
    const fileText = (screen.getByTestId('composer-file-text') as HTMLTextAreaElement).value;
    expect((JSON.parse(fileText) as { issued_at: string }).issued_at).toBe('2026-09-08T17:04:31Z');
  });

  // -------------------------------------------------------------------------
  // 1.0
  // -------------------------------------------------------------------------

  it('hides the 2.0-only inputs at format 1.0 and signs with the keypair alone', async () => {
    const course = await makeKeypair(0x22);
    render(<ManifestComposerView />);

    fireEvent.click(screen.getByTestId('composer-format-1.0'));
    expect(screen.queryByTestId('composer-cert-input')).toBeNull();
    expect(screen.queryByTestId('composer-course-id')).toBeNull();
    expect(screen.queryByTestId('composer-policy-terminal')).toBeNull();
    expect(screen.queryByTestId('composer-root-pubkey')).toBeNull();

    fireEvent.change(screen.getByTestId('composer-assignment-id'), { target: { value: 'proj2' } });
    fireEvent.change(screen.getByTestId('composer-semester'), { target: { value: 'fa26' } });
    fireEvent.change(screen.getByTestId('composer-issued-at'), {
      target: { value: '2026-09-08T00:00:00Z' },
    });
    fireEvent.change(screen.getByTestId('composer-files'), { target: { value: 'src/main.py' } });
    fireEvent.change(screen.getByTestId('composer-key-input'), {
      target: { files: [jsonFile('key.json', course.fileText)] },
    });

    fireEvent.click(screen.getByTestId('composer-sign'));

    await screen.findByTestId('composer-download');
    const fileText = (screen.getByTestId('composer-file-text') as HTMLTextAreaElement).value;
    const parsed = JSON.parse(fileText) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      'assignment_id',
      'files_under_review',
      'issued_at',
      'semester',
      'sig',
    ]);
  });

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  it('previews the payload that will be signed, without sig or certificate', async () => {
    const { cert } = await fixtures();
    render(<ManifestComposerView />);
    fillAssignment();
    fireEvent.change(screen.getByTestId('composer-cert-input'), {
      target: { files: [jsonFile('cert.json', cert.fileText)] },
    });
    await screen.findByTestId('composer-cert-summary');

    const preview = JSON.parse(
      screen.getByTestId('composer-preview').textContent ?? '{}',
    ) as Record<string, unknown>;
    expect(preview['sig']).toBeUndefined();
    expect(preview['course_cert']).toBeUndefined();
    expect(preview['format_version']).toBe('2.0');
    expect(preview['policy']).toEqual({
      capture: {
        selection_change: true,
        focus_change: true,
        terminal: true,
        heartbeat_interval_ms: 30000,
      },
    });
  });

  // -------------------------------------------------------------------------
  // ignore / attachments
  // -------------------------------------------------------------------------

  it('signs a manifest carrying the ignore and attachments lists', async () => {
    render(<ManifestComposerView />);
    await fillValidV2Form(); // existing helper
    fireEvent.change(screen.getByTestId('composer-ignore'), { target: { value: '*.class' } });
    fireEvent.change(screen.getByTestId('composer-attachments'), { target: { value: 'logs/' } });
    const produced = await signAndReadBlob();
    expect(produced['ignore']).toEqual(['*.class']);
    expect(produced['attachments']).toEqual(['logs/']);
  });

  it('refuses to sign when an entry is malformed, and names it', async () => {
    render(<ManifestComposerView />);
    await fillValidV2Form();
    fireEvent.change(screen.getByTestId('composer-ignore'), { target: { value: '../escape' } });
    fireEvent.click(screen.getByRole('button', { name: /sign/i }));
    // Named twice by design: inline under the field (composer-ignore-error)
    // and in the invalid-form summary list, the same pattern every other
    // field on this page already follows. findAllByText tolerates that;
    // findByText would throw "Found multiple elements".
    const matches = await screen.findAllByText(/\.\.\/escape/);
    expect(matches.length).toBeGreaterThan(0);
    expect(screen.queryByTestId('composer-download')).toBeNull();
  });
});
