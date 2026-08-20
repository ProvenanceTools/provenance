/**
 * CoveragePanel.test — facts, never findings.
 *
 * The panel's whole job is to be read by a grader without producing an
 * accusation, so most of these assertions are about what the copy must NOT say.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
} from '@provenance/analysis-core/test-support/build-identity.js';
import type { IdentityTestKeys } from '@provenance/analysis-core/test-support/build-identity.js';
import { establishBundleContributors } from '@provenance/analysis-core/identity/resolve-contributors.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import { CoveragePanel } from './CoveragePanel.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MS = new Date('2026-02-01T08:00:00.000Z').getTime();
const wallAt = (min: number) => new Date(BASE_MS + min * 60_000).toISOString();

let cachedKeys: IdentityTestKeys | null = null;
async function keys(): Promise<IdentityTestKeys> {
  cachedKeys ??= await buildIdentityKeys();
  return cachedKeys;
}

async function buildScope(
  specs: Array<{ who: { studentRef: string } | 'anonymous'; startMin: number; endMin: number }>,
  opts: { rootKey?: string } = {},
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const k = await keys();
  const sessions = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const sk = await seededKeypair(0x90 + i);
    sessions.push({
      events: [
        {
          kind: 'session.end',
          data: { reason: 'deactivate' },
          wall: wallAt(spec.endMin),
          t: spec.endMin * 60_000,
        },
      ],
      walls: [wallAt(spec.startMin)],
      sessionStart: {
        session_pubkey: sk.pubkeyHex,
        ...(spec.who === 'anonymous'
          ? {}
          : {
              identity: await buildInstitutionIdentity({
                keys: k,
                sessionPubkeyHex: sk.pubkeyHex,
                studentRef: spec.who.studentRef,
              }),
            }),
      },
    });
  }
  const { zipBuffer } = await buildTestBundle({ sessions });
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error('load failed');
  await establishBundleContributors(result.value, opts.rootKey ?? k.root.pubkeyHex);
  return { bundle: result.value, index: buildIndex(result.value) };
}

function renderOpen(bundle: Bundle | null, index: EventIndex) {
  const r = render(<CoveragePanel bundle={bundle} index={index} />);
  const toggle = screen.queryByTestId('replay-coverage-toggle');
  if (toggle !== null) fireEvent.click(toggle);
  return r;
}

// ---------------------------------------------------------------------------
// The suppressed overlap, surfaced
// ---------------------------------------------------------------------------

describe('a suppressed concurrent overlap appears as a fact', () => {
  it('names both partners and the duration', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 192 },
      { who: { studentRef: 'bob' }, startMin: 0, endMin: 192 },
    ]);
    renderOpen(bundle, index);

    const row = screen.getByTestId('coverage-concurrent-row');
    expect(row.textContent).toMatch(/alice/);
    expect(row.textContent).toMatch(/bob/);
    expect(row.textContent).toMatch(/3h 12m/);
    expect(row.textContent).toMatch(/recorded concurrently/i);
  });

  it('says it is the expected shape of collaboration, not a finding', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    renderOpen(bundle, index);

    const row = screen.getByTestId('coverage-concurrent-row');
    expect(row.textContent).toMatch(/not a finding/i);
    expect(row.textContent).toMatch(/expected shape of collaboration/i);
  });

  it('is a status region, never an alert', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    render(<CoveragePanel bundle={bundle} index={index} />);
    expect(screen.getByTestId('replay-coverage-panel').getAttribute('role')).toBe('status');
  });
});

// ---------------------------------------------------------------------------
// "Not checked" is not "failed"
// ---------------------------------------------------------------------------

describe('a deployment with no root key', () => {
  it('renders "no identity check was possible", not a failure', async () => {
    const { bundle, index } = await buildScope(
      [{ who: { studentRef: 'alice' }, startMin: 0, endMin: 60 }],
      { rootKey: '' },
    );
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-no-root-key');
    expect(note.textContent).toMatch(/no identity check was possible/i);
    expect(note.textContent).toMatch(/limit on what this analyzer can verify/i);
    expect(note.textContent).toMatch(/nothing follows from it about any student/i);
    // The words that would turn one unset environment variable into a
    // class-wide integrity finding.
    expect(note.textContent).not.toMatch(/failed/i);
    expect(note.textContent).not.toMatch(/did not verify/i);
    // And the counts panel — which would read as "1 unverifiable" — is not the
    // thing shown on this path.
    expect(screen.queryByTestId('coverage-identity-counts')).toBeNull();
  });

  it('shows counts instead when the root key IS configured', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    renderOpen(bundle, index);
    expect(screen.queryByTestId('coverage-no-root-key')).toBeNull();
    expect(screen.getByTestId('coverage-identity-counts').textContent).toMatch(/2 sessions/);
  });
});

// ---------------------------------------------------------------------------
// Absence is never suspicious
// ---------------------------------------------------------------------------

describe('absence is never suspicious', () => {
  it('describes unattributed sessions as ordinary', async () => {
    const { bundle, index } = await buildScope([
      { who: 'anonymous', startMin: 0, endMin: 60 },
      { who: 'anonymous', startMin: 120, endMin: 180 },
    ]);
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-unattributed-note');
    expect(note.textContent).toMatch(/ordinary state/i);
    expect(note.textContent).toMatch(/not a finding/i);
    expect(note.textContent).toMatch(/never grouped/i);
    expect(note.textContent).toMatch(/never asserted to be different people/i);
  });

  it('shows nothing at all for a clean solo bundle', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
    ]);
    const { container } = render(<CoveragePanel bundle={bundle} index={index} />);
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /local vs server-backed
// ---------------------------------------------------------------------------

describe('without a parsed bundle', () => {
  it('renders nothing rather than a page of zeroes', async () => {
    const { index } = await buildScope([{ who: { studentRef: 'alice' }, startMin: 0, endMin: 60 }]);
    const { container } = render(<CoveragePanel bundle={null} index={index} />);
    // A panel of zeroes would state "no commits observed, no contributors, no
    // root key" — a stronger and false claim than "these were not fetched".
    expect(container.firstChild).toBeNull();
  });
});
