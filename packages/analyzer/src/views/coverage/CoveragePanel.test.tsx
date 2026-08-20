/**
 * CoveragePanel.test — facts, never findings.
 *
 * The panel's whole job is to be read by a grader without producing an
 * accusation, so most of these assertions are about what the copy must NOT say.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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

/**
 * `'anonymous'` — no identity block at all, so `unattributed`.
 * `{ studentRef }` — a fully signed 2.1 chain, so `attributed`.
 * `'forged'` — an identity block IS present, but its institution cert is signed
 *   by the student key rather than the root, so it is `unverifiable` on a
 *   deployment whose root key IS configured. That combination is what separates
 *   "a claim we could not stand behind" from "no claim at all", and it is the
 *   only fixture that can prove the panel keeps them apart.
 */
type Who = { studentRef: string } | 'anonymous' | 'forged';

async function buildScope(
  specs: Array<{ who: Who; startMin: number; endMin: number }>,
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
                ...(spec.who === 'forged'
                  ? { certSignedBy: k.student.privkey }
                  : { studentRef: spec.who.studentRef }),
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

/**
 * The panel is always visible now (§6 Rule 3), so there is no disclosure button
 * to click first. Kept as a named helper so the intent of each test body is
 * unchanged from when there was one.
 */
function renderOpen(bundle: Bundle | null, index: EventIndex | null) {
  return render(<CoveragePanel bundle={bundle} index={index} />);
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
    expect(screen.getByTestId('submission-coverage-panel').getAttribute('role')).toBe('status');
    // Never the flag vocabulary: no alert role anywhere in the panel.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is visible without any disclosure — Rule 3 says always visible', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    // Rendered, not clicked open: the fact must be on screen immediately.
    render(<CoveragePanel bundle={bundle} index={index} />);
    expect(screen.getByTestId('coverage-concurrent-row')).not.toBeNull();
    // No collapsed-by-default control survives.
    expect(screen.queryByRole('button', { expanded: false })).toBeNull();
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

  /**
   * The distinction this pins is `unverifiable` != `unattributed`. Summing them
   * into one "not attributed" number hides a forged identity claim behind a
   * student who simply never enrolled — and it reads to a grader as one
   * population when it is two, with opposite meanings. Without this test the
   * collapse is invisible: verified by mutation, the summed line passed every
   * other assertion in this file.
   */
  it('never sums unverifiable and unattributed into one number', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
      { who: 'forged', startMin: 120, endMin: 180 },
      { who: 'anonymous', startMin: 240, endMin: 300 },
    ]);
    // Guard the premise: one of each, and the root key really is configured, so
    // this is the counts branch and not the "could not check" branch.
    expect(bundle.contributors?.rootKeyConfigured).toBe(true);
    expect(bundle.contributors?.counts).toEqual({
      attributed: 1,
      unverifiable: 1,
      unattributed: 1,
    });

    renderOpen(bundle, index);
    const counts = screen.getByTestId('coverage-identity-counts').textContent ?? '';

    // Each state is reported with its OWN count and its OWN description.
    expect(counts).toMatch(/1 session attributed to a verified contributor/i);
    expect(counts).toMatch(/1 carrying an identity claim that is not being honoured/i);
    expect(counts).toMatch(/1 with no identity block at all/i);
    // And never as a single summed "2".
    expect(counts).not.toMatch(/2 not attributed/i);
    expect(counts).not.toMatch(/\b2\b/);
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

  /**
   * This assertion CHANGED when the panel moved from the Replay tab to the
   * submission level. In the tab it rendered nothing for a clean solo bundle,
   * which was fine for an accessory panel. §6 Rule 3 wants the coverage
   * statement always visible per scope, so it now says "nothing to note" —
   * a stronger requirement than silence, and the assertions below keep it from
   * saying anything alarming while doing so.
   */
  it('says "nothing to note" for a clean solo bundle, and nothing alarming', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
    ]);
    renderOpen(bundle, index);

    const body = screen.getByTestId('coverage-nothing-to-note-body');
    expect(body.textContent).toMatch(/nothing further to say/i);
    // Not a finding, not a warning, not an accusation.
    expect(screen.getByTestId('submission-coverage-panel').getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
    for (const word of [/failed/i, /suspicious/i, /tamper/i, /missing/i, /incomplete/i]) {
      expect(body.textContent).not.toMatch(word);
    }
    // And none of the fact sections is rendered with zeroes in it.
    expect(screen.queryByTestId('coverage-identity-counts')).toBeNull();
    expect(screen.queryByTestId('coverage-dag-counts')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /local vs server-backed
// ---------------------------------------------------------------------------

describe('without a parsed bundle — the server-backed submission view', () => {
  /**
   * Also CHANGED by the move, in the same direction and for the same reason.
   * The prohibition it was written to enforce is untouched and is asserted
   * harder below: a panel of zeroes would state "no commits observed, no
   * contributors, no root key" — a stronger and FALSE claim than "not
   * available". Rule 3 wants the panel visible, so the honest visible answer is
   * that the facts were not fetched.
   */
  it('says "not available", and never renders a page of zeroes', async () => {
    const { index } = await buildScope([{ who: { studentRef: 'alice' }, startMin: 0, endMin: 60 }]);
    renderOpen(null, index);

    const note = screen.getByTestId('coverage-not-available-note');
    expect(note.textContent).toMatch(/were not fetched/i);
    expect(note.textContent).toMatch(/nothing here has been checked and found wanting/i);
    expect(note.textContent).toMatch(/no conclusion about this submission follows/i);

    // The zeroes prohibition, stated as structure rather than as copy: not one
    // of the counting sections may appear on this path.
    for (const id of [
      'coverage-identity-counts',
      'coverage-no-root-key',
      'coverage-dag-counts',
      'coverage-concurrent-recording',
      'coverage-unattested-tails',
      'coverage-dropped-artifacts',
      'coverage-nothing-to-note',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    // Belt and braces: no bare "0 " count text anywhere in the rendered panel.
    expect(screen.getByTestId('submission-coverage-panel').textContent).not.toMatch(/\b0\b/);
  });

  it('says the same when the index has not been built either', async () => {
    renderOpen(null, null);
    expect(screen.getByTestId('coverage-not-available-note')).not.toBeNull();
  });
});
