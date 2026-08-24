/**
 * BundleContext — the 'choosing' phase of the /local load.
 *
 * Driven through a real <BundleProvider> with the real loader: nothing is
 * mocked, so a scope that claims to load has actually been unzipped, indexed,
 * validated and run through the heuristics. Fixtures are built with
 * buildTestBundle and then laid out on disk the way a git submission is, so the
 * repo zips here are the same shape ingest sees.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import JSZip from 'jszip';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import {
  BundleProvider,
  useBundle,
  scopeSelectionKey,
  type BundleContextValue,
} from './BundleContext.js';

// Wire SHA-512 override so ed25519 works in jsdom.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Lay a real sealed bundle into `<scopeDir>.provenance/` inside `zip`, which is
 * how a git-submitted scope sits in a cloned repo. With no submission files
 * every entry buildTestBundle produces is a provenance file.
 */
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
  return new File([ab], name);
}

async function twoScopeRepo(name = 'repo.zip'): Promise<File> {
  const zip = new JSZip();
  await addScope(zip, 'proj2/', 'proj2');
  await addScope(zip, 'lab5/', 'lab5');
  zip.file('README.md', '# monorepo');
  return zipToFile(zip, name);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Observation = { status: BundleContextValue['status']; pendingNull: boolean };

/**
 * Render the provider and hand back both the live context and every
 * (status, pendingScopes) pair React rendered — the "throughout" assertions
 * need the history, not just the final state.
 */
function renderProvider(): { ctx: () => BundleContextValue; history: Observation[] } {
  const history: Observation[] = [];
  let latest: BundleContextValue | null = null;

  function Probe() {
    const value = useBundle();
    latest = value;
    history.push({ status: value.status, pendingNull: value.pendingScopes === null });
    return <div data-testid="status">{value.status}</div>;
  }

  render(
    <BundleProvider>
      <Probe />
    </BundleProvider>,
  );

  return {
    ctx: () => {
      if (latest === null) throw new Error('provider did not render');
      return latest;
    },
    history,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BundleContext — scope choice', () => {
  it('goes straight to loaded for a single flat bundle, never entering choosing', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    const { ctx, history } = renderProvider();
    await act(async () => {
      await ctx().beginLoad([file]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('loaded');
    });
    expect(ctx().bundles).toHaveLength(1);
    expect(history.every((h) => h.pendingNull)).toBe(true);
    expect(history.every((h) => h.status !== 'choosing')).toBe(true);
  });

  it('enters choosing when a dropped file holds more than one scope', async () => {
    const file = await twoScopeRepo();

    const { ctx } = renderProvider();
    await act(async () => {
      await ctx().beginLoad([file]);
    });

    expect(ctx().status).toBe('choosing');
    const pending = ctx().pendingScopes;
    expect(pending).not.toBeNull();
    expect(pending!.groups).toHaveLength(1);
    expect(pending!.groups[0]!.stem).toBe('repo');
    expect(pending!.groups[0]!.candidates).toHaveLength(2);
  });

  it('loads only the chosen scope', async () => {
    const file = await twoScopeRepo();

    const { ctx } = renderProvider();
    await act(async () => {
      await ctx().beginLoad([file]);
    });
    expect(ctx().status).toBe('choosing');

    await act(async () => {
      await ctx().chooseScopes([scopeSelectionKey('repo', 'proj2/')]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('loaded');
    });
    expect(ctx().bundles).toHaveLength(1);
    expect(ctx().pendingScopes).toBeNull();
  });

  it('cancelChoice returns to idle without loading anything', async () => {
    const file = await twoScopeRepo();

    const { ctx } = renderProvider();
    await act(async () => {
      await ctx().beginLoad([file]);
    });
    expect(ctx().status).toBe('choosing');

    act(() => {
      ctx().cancelChoice();
    });

    expect(ctx().status).toBe('idle');
    expect(ctx().bundles).toEqual([]);
    expect(ctx().pendingScopes).toBeNull();
  });

  it('does not prompt when a repo zip holds exactly one sealed scope', async () => {
    const zip = new JSZip();
    await addScope(zip, 'proj2/', 'proj2');
    zip.file('README.md', '# repo');
    const file = await zipToFile(zip, 'repo.zip');

    const { ctx, history } = renderProvider();
    await act(async () => {
      await ctx().beginLoad([file]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('loaded');
    });
    expect(ctx().bundles).toHaveLength(1);
    expect(history.every((h) => h.status !== 'choosing')).toBe(true);
    expect(history.every((h) => h.pendingNull)).toBe(true);
  });
});
