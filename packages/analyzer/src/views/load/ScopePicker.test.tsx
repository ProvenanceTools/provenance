/**
 * ScopePicker tests.
 *
 * Driven through LoadView with a real <BundleProvider> and a real two-scope
 * repo zip, so the provider state under the picker is the state production
 * produces. The component takes no props deliberately — there is no escape
 * hatch to render it with fabricated candidates.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import JSZip from 'jszip';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { BundleProvider } from '../../context/BundleContext.js';
import { LoadView } from './LoadView.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';

// Wire SHA-512 override so ed25519 works in jsdom.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Lay a real sealed bundle into `<scopeDir>.provenance/`, as a git submission has it. */
async function addScope(zip: JSZip, scopeDir: string, assignmentId: string): Promise<void> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId,
    semester: 'fa2026',
    sessions: [{ eventCount: 2 }],
  });
  const inner = await JSZip.loadAsync(zipBuffer);
  for (const [name, obj] of Object.entries(inner.files)) {
    if (obj.dir) continue;
    zip.file(`${scopeDir}.provenance/${name}`, await obj.async('uint8array'));
  }
}

async function zipToFile(zip: JSZip, name: string): Promise<File> {
  const ab = await zip.generateAsync({ type: 'arraybuffer' });
  return new File([ab], name, { type: 'application/zip' });
}

/** Two sealed scopes; `withUnsealed` adds a third `.provenance/` nothing seals. */
async function repoFile(withUnsealed = false): Promise<File> {
  const zip = new JSZip();
  await addScope(zip, 'proj2/', 'proj2');
  await addScope(zip, 'lab5/', 'lab5');
  if (withUnsealed) zip.file('hw3/.provenance/notes.txt', 'nothing seals this');
  zip.file('README.md', '# monorepo');
  return zipToFile(zip, 'repo.zip');
}

function renderLoadView() {
  return render(
    <MemoryRouter initialEntries={['/local/load']}>
      <BundleProvider>
        <Routes>
          <Route path="/local/load" element={<LoadView />} />
          <Route
            path="/local/overview"
            element={<div data-testid="overview-reached">Overview</div>}
          />
        </Routes>
      </BundleProvider>
    </MemoryRouter>,
  );
}

/** Drop `file` on the drop zone and wait for the picker to appear. */
async function dropAndAwaitPicker(file: File): Promise<void> {
  renderLoadView();
  act(() => {
    fireEvent.drop(screen.getByTestId('drop-zone'), {
      dataTransfer: { files: [file] as unknown as FileList },
    });
  });
  await waitFor(
    () => {
      expect(screen.getByTestId('scope-picker')).toBeInTheDocument();
    },
    { timeout: 5000 },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScopePicker', () => {
  it('lists every candidate with its assignment id and session count', async () => {
    await dropAndAwaitPicker(await repoFile());

    const proj2 = screen.getByTestId('scope-row-proj2/');
    const lab5 = screen.getByTestId('scope-row-lab5/');
    expect(proj2).toHaveTextContent('proj2/');
    expect(proj2).toHaveTextContent('proj2');
    expect(proj2).toHaveTextContent('1 session');
    expect(lab5).toHaveTextContent('lab5/');
    expect(lab5).toHaveTextContent('lab5');
    expect(lab5).toHaveTextContent('1 session');
  });

  it('disables the confirm button until something is selected', async () => {
    await dropAndAwaitPicker(await repoFile());

    const confirm = screen.getByTestId('analyze-selected');
    expect(confirm).toBeDisabled();

    act(() => {
      fireEvent.click(screen.getByTestId('scope-row-proj2/').querySelector('input')!);
    });
    expect(screen.getByTestId('analyze-selected')).not.toBeDisabled();
  });

  it('renders an unsealed scope as disabled with a not-sealed reason', async () => {
    await dropAndAwaitPicker(await repoFile(true));

    const hw3 = screen.getByTestId('scope-row-hw3/');
    expect(hw3.querySelector('input')).toBeDisabled();
    expect(hw3).toHaveTextContent('not sealed');
    expect(screen.getByTestId('scope-row-proj2/').querySelector('input')).not.toBeDisabled();
  });

  it('allows selecting more than one scope', async () => {
    await dropAndAwaitPicker(await repoFile());

    act(() => {
      fireEvent.click(screen.getByTestId('scope-row-proj2/').querySelector('input')!);
      fireEvent.click(screen.getByTestId('scope-row-lab5/').querySelector('input')!);
    });

    expect(screen.getByTestId('scope-row-proj2/').querySelector('input')).toBeChecked();
    expect(screen.getByTestId('scope-row-lab5/').querySelector('input')).toBeChecked();

    await act(async () => {
      screen.getByTestId('analyze-selected').click();
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('overview-reached')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  it('calls cancelChoice when dismissed', async () => {
    await dropAndAwaitPicker(await repoFile());

    act(() => {
      screen.getByTestId('cancel-choice').click();
    });

    // Back to idle: the picker is gone and the drop zone is offered again.
    await waitFor(() => {
      expect(screen.queryByTestId('scope-picker')).not.toBeInTheDocument();
      expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    });
  });
});
