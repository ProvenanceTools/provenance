/**
 * CoveragePanel.test — facts, never findings.
 *
 * The panel's whole job is to be read by a grader without producing an
 * accusation, so most of these assertions are about what the copy must NOT say.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  describeCapabilityValueProblem,
  describeFileScopeProblem,
  describeGitCapture,
  describeWitnessCapture,
} from '@provenance/log-core';
import type { PeerObservedPayload } from '@provenance/log-core';
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
import { coverageFacts } from '@provenance/analysis-core/coverage/coverage-facts.js';
import { CoverageFactsSchema } from '@provenance/shared/api-schemas';
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

/**
 * A commit observation. `rootCommitSha` OMITTED models a recorder that names no
 * repository — an older build, or a shallow clone, both of which the D12 writer
 * contract says must omit the field — and is what lands in the sentinel
 * repository the single-repository caveat is about.
 */
type CommitSpec = { sha: string; rootCommitSha?: string; atMin: number };

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ROOT_ONE = '1'.repeat(40);
const ROOT_TWO = '2'.repeat(40);

/**
 * A SECOND enrolled machine for the same deployment (D5): same root, same
 * institution, a different student keypair. That is the whole difference a
 * second independent enrolment produces.
 */
let cachedSecondMachine: IdentityTestKeys | null = null;
async function secondMachine(): Promise<IdentityTestKeys> {
  cachedSecondMachine ??= await buildIdentityKeys({ studentSeedByte: 0x56 });
  return cachedSecondMachine;
}

async function buildScope(
  specs: Array<{
    who: Who;
    startMin: number;
    endMin: number;
    commits?: CommitSpec[];
    machine?: IdentityTestKeys;
    /**
     * §5.6 `session.start` capability reports. OMITTED is the ordinary case —
     * every bundle recorded before the fields existed — and the tests below
     * depend on it staying the default.
     */
    capabilities?: Record<string, unknown>;
    /** `peer.observed` payloads this session recorded about other logs. */
    witnesses?: PeerObservedPayload[];
    /** Paths this session edits, so a file can be busy rather than silent. */
    activity?: string[];
  }>,
  opts: { rootKey?: string; submissionFiles?: string[] } = {},
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const k = await keys();
  const sessions = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const sk = await seededKeypair(0x90 + i);
    sessions.push({
      events: [
        ...(spec.commits ?? []).map((c) => ({
          kind: 'git.event',
          data: {
            operation: 'commit',
            sha: c.sha,
            parents: [],
            ...(c.rootCommitSha === undefined ? {} : { root_commit_sha: c.rootCommitSha }),
          },
          wall: wallAt(c.atMin),
          t: c.atMin * 60_000,
        })),
        ...(spec.witnesses ?? []).map((w) => ({
          kind: 'peer.observed',
          data: { ...w },
          wall: wallAt(spec.startMin),
          t: spec.startMin * 60_000,
        })),
        ...(spec.activity ?? []).map((path) => ({
          kind: 'doc.change',
          data: { path, deltas: [{ range: null, text: 'x = 1\n' }], source: 'keystroke' },
          wall: wallAt(spec.startMin),
          t: spec.startMin * 60_000,
        })),
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
        ...(spec.capabilities ?? {}),
        ...(spec.who === 'anonymous'
          ? {}
          : {
              identity: await buildInstitutionIdentity({
                keys: spec.machine ?? k,
                sessionPubkeyHex: sk.pubkeyHex,
                ...(spec.who === 'forged'
                  ? { certSignedBy: k.student.privkey }
                  : { studentRef: spec.who.studentRef }),
              }),
            }),
      },
    });
  }
  const { zipBuffer } = await buildTestBundle({
    sessions,
    ...(opts.submissionFiles === undefined
      ? {}
      : {
          submissionFiles: opts.submissionFiles.map((path) => ({
            path,
            status: 'present' as const,
            content: `# ${path}\n`,
          })),
        }),
  });
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error('load failed');
  await establishBundleContributors(result.value, opts.rootKey ?? k.root.pubkeyHex);
  return { bundle: result.value, index: buildIndex(result.value) };
}

/**
 * The panel is always visible now (§6 Rule 3), so there is no disclosure button
 * to click first. Kept as a named helper so the intent of each test body is
 * unchanged from when there was one.
 *
 * It takes a bundle + index and runs the coverage stage itself, which is what
 * `/local` does — the panel now takes the computed aggregate, not a `Bundle`.
 */
function renderOpen(bundle: Bundle, index: EventIndex) {
  return render(<CoveragePanel facts={coverageFacts(bundle, index)} />);
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
    expect(row.textContent).toMatch(/what collaboration looks like/i);
  });

  it('is a status region, never an alert', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    render(<CoveragePanel facts={coverageFacts(bundle, index)} />);
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
    render(<CoveragePanel facts={coverageFacts(bundle, index)} />);
    expect(screen.getByTestId('coverage-concurrent-row')).not.toBeNull();
    // No collapsed-by-default control survives.
    expect(screen.queryByRole('button', { expanded: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One student, two machines (D5)
// ---------------------------------------------------------------------------

describe('a suppressed two-machine overlap appears as a fact', () => {
  async function twoMachines() {
    return buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 192 },
      { who: { studentRef: 'alice' }, machine: await secondMachine(), startMin: 0, endMin: 192 },
    ]);
  }

  it('names the one student, the two machines, and the duration', async () => {
    const { bundle, index } = await twoMachines();
    renderOpen(bundle, index);

    const row = screen.getByTestId('coverage-multi-machine-row');
    expect(row.textContent).toMatch(/alice/);
    expect(row.textContent).toMatch(/3h 12m/);
    expect(row.textContent).toMatch(/two enrolled machines/i);
    expect(row.textContent).toMatch(/not a finding/i);
  });

  it('is its OWN section — two machines is not two people', async () => {
    const { bundle, index } = await twoMachines();
    renderOpen(bundle, index);

    expect(screen.getByTestId('coverage-multi-machine-recording')).not.toBeNull();
    // The partner-collaboration section must NOT appear: no two people here.
    expect(screen.queryByTestId('coverage-concurrent-recording')).toBeNull();
    // And the copy must not describe this as collaboration.
    const row = screen.getByTestId('coverage-multi-machine-row');
    expect(row.textContent).not.toMatch(/collaboration/i);
    expect(row.textContent).not.toMatch(/partner/i);
  });

  it('is a status region, never an alert', async () => {
    const { bundle, index } = await twoMachines();
    render(<CoveragePanel facts={coverageFacts(bundle, index)} />);
    expect(screen.getByTestId('submission-coverage-panel').getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('survives the wire — the server-backed panel says the same thing', async () => {
    const { bundle, index } = await twoMachines();
    const facts = coverageFacts(bundle, index);
    expect(facts.multiMachineRecording.length).toBeGreaterThan(0);

    const overTheWire: unknown = JSON.parse(JSON.stringify(facts));
    const parsed = CoverageFactsSchema.parse(overTheWire);
    expect(parsed.multiMachineRecording).toEqual(facts.multiMachineRecording);

    render(<CoveragePanel facts={parsed as unknown as typeof facts} />);
    expect(screen.getByTestId('coverage-multi-machine-row').textContent).toMatch(/alice/);
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
    expect(note.textContent).toMatch(/nothing here was checked and found wanting/i);
    expect(note.textContent).toMatch(/nothing here was checked and found wanting/i);
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
    expect(counts).toMatch(/1 verified/);
    expect(counts).toMatch(/1 claiming an identity that is not being honoured/);
    expect(counts).toMatch(/1 with no identity block/);
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
    expect(screen.getByTestId('coverage-identity-counts').textContent).toMatch(/2 verified/);
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
    expect(note.textContent).toMatch(/usually means the student had not enrolled/i);
    expect(note.textContent).toMatch(/not a finding/i);
    expect(note.textContent).toMatch(/never grouped/i);
    expect(note.textContent).toMatch(/never treated as different people/i);
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
// The single-repository caveat (D12)
// ---------------------------------------------------------------------------

/**
 * The old copy said "The signed log format does not yet carry a repository
 * discriminator". That stopped being true on 2026-08-20: the format carries
 * `root_commit_sha` and all three recorders emit it, so the sentence told a
 * grader something false about the tool at the exact moment they were reading
 * a caveat about the evidence.
 *
 * These tests pin the replacement. They assert BOTH halves of what the
 * paragraph now has to be honest about — the wholly unlabelled scope and the
 * mixed one — and they assert the false sentence is gone, because a wording fix
 * nothing can fail on is not a fix.
 */
describe('the single-repository caveat', () => {
  it('no longer claims the format cannot carry a repository discriminator', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        commits: [{ sha: SHA_A, atMin: 10 }],
      },
    ]);
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-repo-assumed-single');
    // The claim that went stale, in every form it could come back in.
    expect(note.textContent).not.toMatch(/does not yet carry/i);
    expect(note.textContent).not.toMatch(/format/i);
    // What is actually true of a commit that reaches this paragraph, and WHY,
    // so the reader is not left to guess at a cause.
    expect(note.textContent).toMatch(/name no repository/i);
    expect(note.textContent).toMatch(/folded into one assumed repository/i);
    expect(note.textContent).toMatch(/an older recorder and a shallow clone/i);
    expect(note.textContent).toMatch(/shallow clone/i);
    // Facts, never findings — the house rule for this whole panel.
    expect(note.textContent).toMatch(/not a finding/i);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is honest about a mixed scope: named repositories are NOT merged in', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        commits: [{ sha: SHA_A, rootCommitSha: ROOT_ONE, atMin: 10 }],
      },
      {
        who: { studentRef: 'bob' },
        startMin: 120,
        endMin: 180,
        commits: [{ sha: SHA_B, atMin: 130 }],
      },
    ]);
    // Guard the premise: this is the MIXED case, which the caveat used to go
    // silent on entirely. If the paragraph is absent, the fact is unstated and
    // this is the under-report the analysis-core fix was for.
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-repo-assumed-single');
    // The copy has to cover "some, not all" — "every commit here is folded"
    // would be false on this scope.
    expect(note.textContent).toMatch(/some commits here name no repository/i);
    expect(note.textContent).not.toMatch(/every commit here is folded/i);
    // And it must say the labelled half is kept apart, because assuming the
    // unlabelled commits belong to the named repository is exactly the merge
    // the discriminator exists to prevent.
    expect(note.textContent).toMatch(/kept apart from the unnamed ones/i);
  });

  it('says nothing at all when every commit named its repository', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        commits: [
          { sha: SHA_A, rootCommitSha: ROOT_ONE, atMin: 10 },
          { sha: SHA_B, rootCommitSha: ROOT_TWO, atMin: 20 },
        ],
      },
    ]);
    renderOpen(bundle, index);

    // The commit-graph section is rendered — there are commits — but there is
    // no caveat, because nothing was merged. Two repositories is not a finding
    // and gets no paragraph of its own.
    expect(screen.getByTestId('coverage-dag')).not.toBeNull();
    expect(screen.queryByTestId('coverage-repo-assumed-single')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /local vs server-backed
// ---------------------------------------------------------------------------

describe('when the facts were not sent', () => {
  /**
   * The meaning of this state CHANGED when the server started serving coverage.
   * It used to mean "this view cannot compute them"; it now means "the server
   * did not send them", which today has exactly one cause — a deployment older
   * than `SubmissionSummary.coverage`.
   *
   * The prohibition it was written to enforce is untouched and is asserted
   * harder below: a panel of zeroes would state "no commits observed, no
   * contributors, no root key" — a stronger and FALSE claim than "not
   * available". Rule 3 wants the panel visible, so the honest visible answer is
   * that the facts were not sent.
   */
  it('says the server did not send them, and never renders a page of zeroes', () => {
    render(<CoveragePanel facts={null} />);

    const note = screen.getByTestId('coverage-not-available-note');
    expect(note.textContent).toMatch(/did not send coverage facts/i);
    expect(note.textContent).toMatch(/running a version older/i);
    expect(note.textContent).toMatch(/nothing was checked and found wanting/i);
    // The old copy blamed the VIEW ("which this view does not load"), which is
    // no longer true of any surface: both compute or receive real facts.
    expect(note.textContent).not.toMatch(/this view does not load/i);

    // The zeroes prohibition, stated as structure rather than as copy: not one
    // of the counting sections may appear on this path.
    for (const id of [
      'coverage-identity-counts',
      'coverage-no-root-key',
      'coverage-dag-counts',
      'coverage-concurrent-recording',
      'coverage-multi-machine-recording',
      'coverage-unattested-tails',
      'coverage-dropped-artifacts',
      'coverage-nothing-to-note',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    // Belt and braces: no bare "0 " count text anywhere in the rendered panel.
    expect(screen.getByTestId('submission-coverage-panel').textContent).not.toMatch(/\b0\b/);
  });

  /**
   * The three states are three DIFFERENT claims, and the one that is easiest to
   * lose is the difference between the first two: "we were not told" and "we
   * were told, and there is nothing to report". A consumer that substitutes an
   * empty aggregate for a missing one silently converts the first into the
   * second — which is why this asserts they render different sections rather
   * than merely that each renders something.
   */
  it('is a different answer from "nothing to note"', async () => {
    const empty = render(<CoveragePanel facts={null} />);
    expect(screen.queryByTestId('coverage-nothing-to-note')).toBeNull();
    empty.unmount();

    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
    ]);
    renderOpen(bundle, index);
    expect(screen.getByTestId('coverage-nothing-to-note')).not.toBeNull();
    expect(screen.queryByTestId('coverage-not-available')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §5.6 — git observability
// ---------------------------------------------------------------------------

/**
 * The whole reason this section exists: an absence of git evidence is equally
 * consistent with "no git activity happened" and with "git was never
 * observable", and until the capability reports there was no way to say which.
 * Every assertion below is about keeping those two sentences apart, and about
 * the third sentence — "nobody told us" — never reading as either of them.
 */
describe('git observation says which kind of silence this is', () => {
  it('an unreported capability reads as an open question, never as a defect', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        commits: [{ sha: SHA_A, atMin: 5 }],
      },
    ]);
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-git-unknown');
    expect(note.textContent).toMatch(/does not report whether it could see git/i);
    expect(note.textContent).toMatch(/unexplained/i);
    expect(note.textContent).toMatch(/it is not a defect and it is not a finding/i);
    // The state of the entire archive must not read as a fault in the archive.
    expect(note.textContent).not.toMatch(/unavailable/i);
    expect(note.textContent).not.toMatch(/failed|missing|suspicious|should have/i);
    expect(screen.queryByTestId('coverage-git-impossible')).toBeNull();
  });

  it('"could not observe" is stated as incapacity, and explicitly not as absence of activity', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        capabilities: { git_capture: 'unavailable' },
      },
    ]);
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-git-impossible');
    expect(note.textContent).toMatch(/could not see git/i);
    expect(note.textContent).toMatch(/none could be gathered/i);
    expect(note.textContent).toMatch(/not that nothing was done/i);
    expect(note.textContent).not.toMatch(/failed/i);
  });

  it('keeps "no git integration" and "outside any repository" apart in the copy', async () => {
    // Same consequence, different facts. A grader acts differently on the two,
    // and collapsing them is what §5.6 item 2 exists to prevent.
    const notOwned = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        capabilities: { git_capture: 'not_owned' },
      },
    ]);
    const first = renderOpen(notOwned.bundle, notOwned.index);
    const notOwnedText = screen.getByTestId('coverage-git-impossible').textContent ?? '';
    expect(notOwnedText).toMatch(/no repository it could see belonged to this assignment/i);
    expect(notOwnedText).toMatch(/no repository to watch/i);
    first.unmount();

    const unavailable = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        capabilities: { git_capture: 'unavailable' },
      },
    ]);
    renderOpen(unavailable.bundle, unavailable.index);
    const unavailableText = screen.getByTestId('coverage-git-impossible').textContent ?? '';
    expect(unavailableText).toMatch(/exposed no git integration/i);
    // Both causes, not just the first: an extension that was absent and one
    // whose API could not be reached send a reader to different places.
    expect(unavailableText).toMatch(/could not be reached/i);
    // The two must not be the same sentence.
    expect(unavailableText).not.toBe(notOwnedText);
  });

  it('a capable session that recorded no commits is stated as ordinary, not as silence to explain', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        capabilities: { git_capture: 'available' },
      },
    ]);
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-git-silent-capable');
    expect(note.textContent).toMatch(/no git command ran/i);
    expect(note.textContent).toMatch(/most sessions look like this/i);
    expect(note.textContent).toMatch(/most sessions look like this/i);
  });

  it('never renders in the flag vocabulary', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        capabilities: { git_capture: 'unavailable' },
      },
    ]);
    renderOpen(bundle, index);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('coverage-git-observation').textContent).not.toMatch(
      /warning|violation|suspicious|misconduct/i,
    );
  });
});

// ---------------------------------------------------------------------------
// §5.6 / §5.5 — peer witnessing
// ---------------------------------------------------------------------------

const WITNESSED_FILE = 'session-0badf00d-0000-4000-8000-00000000beef.slog';

/** A witness naming a session id that is NOT in the bundle — the `absent` shape. */
function absentWitness(state: PeerObservedPayload['state']): PeerObservedPayload {
  return {
    file: WITNESSED_FILE,
    sha256: 'f'.repeat(64),
    bytes: 4096,
    session_id: '00000000-0000-4000-8000-0000deadbeef',
    seq_high: 12,
    last_hash: 'a'.repeat(64),
    state,
  };
}

describe('peer witnessing reads as evidence about a log, never about a person', () => {
  it('stays away entirely when nothing witnessed and nothing reported', async () => {
    // Every bundle in the archive. "0 of 2 logs are witnessed" said about one of
    // these is an invitation to read absence as suspicion, so it is not said.
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 180,
        commits: [{ sha: SHA_A, atMin: 5 }],
      },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    renderOpen(bundle, index);
    expect(screen.queryByTestId('coverage-witnessing')).toBeNull();
  });

  it('an unwitnessed log is stated as the ordinary case once the section is on screen', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 180,
        capabilities: { witness_capture: 'available' },
      },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-unwitnessed-note');
    expect(note.textContent).toMatch(/ordinary case/i);
    expect(note.textContent).toMatch(/the ordinary case/i);
    expect(note.textContent).toMatch(/may not have been recording/i);
    expect(note.textContent).toMatch(/never overlapped/i);
    // The reading this whole module exists to prevent.
    expect(note.textContent).not.toMatch(/unverified|suspicious|deleted|removed/i);
  });

  it('`disappeared` is described, with a checkout and a stash named as causes', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 180,
        witnesses: [absentWitness('disappeared')],
      },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-witness-state-note');
    expect(note.textContent).toMatch(/descriptive, not a finding/i);
    expect(note.textContent).toMatch(/checking out a branch/i);
    expect(note.textContent).toMatch(/stash/i);
    // `disappeared` must not import the vocabulary of an act.
    expect(note.textContent).not.toMatch(/deleted|removed by|tamper/i);
  });

  it('an absent witnessed log never becomes an accusation, and never names anyone', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 180,
        witnesses: [absentWitness('disappeared')],
      },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    renderOpen(bundle, index);

    const row = screen.getByTestId('coverage-witness-discrepancy');
    expect(row.getAttribute('data-verdict')).toBe('absent');
    // reconcile-witnesses' own wording, carried through rather than rephrased.
    expect(row.textContent).toMatch(/NOT established as a deletion/i);
    expect(row.textContent).toMatch(/had not yet pushed/i);

    const note = screen.getByTestId('coverage-witness-discrepancy-note');
    expect(note.textContent).toMatch(/not so anyone can be accused/i);
    expect(note.textContent).toMatch(/not so anyone can be accused/i);

    // No contributor name is reachable from a witness row. `alice` witnessed,
    // and a witness establishes nothing about who acted (§5, S26).
    const section = screen.getByTestId('coverage-witnessing');
    expect(section.textContent).not.toMatch(/alice|bob/i);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('every session being unable to witness is stated as a limit, not as a deficiency', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 180,
        capabilities: { witness_capture: 'unavailable' },
      },
      {
        who: { studentRef: 'bob' },
        startMin: 60,
        endMin: 240,
        capabilities: { witness_capture: 'unavailable' },
      },
    ]);
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-witness-capability-impossible');
    expect(note.textContent).toMatch(/had the chance to be corroborated/i);
    expect(note.textContent).toMatch(/had the chance to be corroborated/i);
  });
});

// ---------------------------------------------------------------------------
// §5.6 item 1 — file scope
//
// The field exists to remove ONE inference: "no events for this file" is
// otherwise ambiguous between _nothing happened in it_ and _it was never
// watched_. Nothing here is a finding in either direction — "not watched" is
// exculpatory, and an absent report is a fact about a release date.
// ---------------------------------------------------------------------------

/** A complete `file_scope` report naming exactly `watched`. */
const scopeOf = (watched: string[], complete = true) => ({
  file_scope: { watched, complete },
});

describe('file scope says whether a silent file was ever being watched', () => {
  it('an unreported scope reads as "this recorder does not report", never as a defect', async () => {
    // EVERY bundle recorded before §5.6, permanently. This is the assertion the
    // whole archive depends on.
    const { bundle, index } = await buildScope([{ who: 'anonymous', startMin: 0, endMin: 60 }], {
      submissionFiles: ['hw1.py', 'provided.py'],
    });
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-file-scope-unreported');
    expect(note.textContent).toMatch(/does not report which files it watched/i);
    expect(note.textContent).toMatch(/unexplained/i);
    expect(note.textContent).toMatch(/it is not a defect and it is not a finding/i);
    // Nothing is claimed about any individual file, in either direction.
    expect(screen.queryByTestId('coverage-file-not-watched')).toBeNull();
    expect(note.textContent).not.toMatch(/failed|missing|suspicious|should have|never touched/i);
  });

  it('a file outside a complete scope is stated as EXPLAINED, never as absence of work', async () => {
    const { bundle, index } = await buildScope(
      [
        {
          who: { studentRef: 'alice' },
          startMin: 0,
          endMin: 60,
          capabilities: scopeOf(['hw1.py']),
        },
      ],
      { submissionFiles: ['hw1.py', 'provided.py'] },
    );
    renderOpen(bundle, index);

    expect(screen.getByTestId('coverage-file-scope-reported').textContent).toMatch(
      /every session reported its watched files/i,
    );

    const rows = screen.getAllByTestId('coverage-file-not-watched');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toMatch(/provided\.py/);
    expect(rows[0]!.textContent).toMatch(/outside every watched scope/i);
    expect(rows[0]!.textContent).toMatch(/nothing was recording it/i);
    // The watched file is not listed: there is no ambiguity to resolve for it.
    expect(rows[0]!.textContent).not.toMatch(/hw1\.py/);

    const note = screen.getByTestId('coverage-file-not-watched-note');
    expect(note.textContent).toMatch(/about the assignment’s configuration/i);
    expect(note.textContent).toMatch(/nothing here is a finding/i);
    expect(note.textContent).not.toMatch(/suspicious|misconduct|failed|warning/i);
  });

  it('says the course EXCLUDED a file, not merely that nothing watched it (§9.3)', async () => {
    // The spec's binding sentence: the analyzer must always be able to say "no
    // evidence exists for this file BECAUSE THE COURSE EXCLUDED IT", which is a
    // different sentence from "no evidence exists". Without it a grader reads
    // an ignored file and an out-of-scope file as the same silence.
    const { bundle, index } = await buildScope(
      [
        {
          who: { studentRef: 'alice' },
          startMin: 0,
          endMin: 60,
          capabilities: scopeOf(['hw1.py']),
        },
      ],
      { submissionFiles: ['hw1.py', 'provided.py'] },
    );
    const facts = coverageFacts(bundle, index);
    render(
      <CoveragePanel
        facts={{
          ...facts,
          fileScope: {
            ...facts.fileScope,
            files: facts.fileScope.files.map((f) =>
              f.path === 'provided.py'
                ? { ...f, notWatchedReason: 'ignored_by_assignment' as const }
                : f,
            ),
          },
        }}
      />,
    );

    const rows = screen.getAllByTestId('coverage-file-not-watched');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toMatch(/provided\.py/);
    expect(rows[0]!.textContent).toMatch(/excluded by the assignment/i);
    expect(rows[0]!.textContent).toMatch(/exculpatory evidence included/i);
    // Never the generic sentence when a real reason is available.
    expect(rows[0]!.textContent).not.toMatch(/outside every watched scope/i);
    // Still not a finding, in either register.
    expect(rows[0]!.textContent).not.toMatch(/suspicious|misconduct|failed|warning/i);
  });

  it('says an attachment was never captured BY DESIGN, not that it fell out of scope', async () => {
    const { bundle, index } = await buildScope(
      [
        {
          who: { studentRef: 'alice' },
          startMin: 0,
          endMin: 60,
          capabilities: scopeOf(['hw1.py']),
        },
      ],
      { submissionFiles: ['hw1.py', 'provided.py'] },
    );
    const facts = coverageFacts(bundle, index);
    render(
      <CoveragePanel
        facts={{
          ...facts,
          fileScope: {
            ...facts.fileScope,
            files: facts.fileScope.files.map((f) =>
              f.path === 'provided.py' ? { ...f, notWatchedReason: 'attachment' as const } : f,
            ),
          },
        }}
      />,
    );

    const row = screen.getAllByTestId('coverage-file-not-watched')[0]!;
    expect(row.textContent).toMatch(/sealed into the bundle and hashed, never captured/i);
    expect(row.textContent).toMatch(/by design/i);
    expect(row.textContent).not.toMatch(/outside every watched scope/i);
  });

  it('one silent session takes every unnamed file to unknown, and says so', async () => {
    const { bundle, index } = await buildScope(
      [
        {
          who: { studentRef: 'alice' },
          startMin: 0,
          endMin: 60,
          capabilities: scopeOf(['hw1.py']),
        },
        { who: { studentRef: 'bob' }, startMin: 120, endMin: 180 },
      ],
      { submissionFiles: ['hw1.py', 'provided.py'] },
    );
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-file-scope-partial');
    expect(note.textContent).toMatch(/lower bound/i);
    expect(note.textContent).toMatch(/may still have been watched by a session that said nothing/i);
    // Fail toward not knowing: no file is asserted to be unwatched.
    expect(screen.queryByTestId('coverage-file-not-watched')).toBeNull();
  });

  it('a busy file is never listed as having no activity, whatever the scope says', async () => {
    // `provided.py` is outside the reported scope AND has events. Listing it as
    // "this record contains no activity for it" beside its own events would be
    // a contradiction, so it is not listed at all.
    const { bundle, index } = await buildScope(
      [
        {
          who: { studentRef: 'alice' },
          startMin: 0,
          endMin: 60,
          capabilities: scopeOf(['hw1.py']),
          activity: ['provided.py'],
        },
      ],
      { submissionFiles: ['hw1.py', 'provided.py'] },
    );
    renderOpen(bundle, index);

    expect(screen.queryByTestId('coverage-file-not-watched')).toBeNull();
    expect(screen.queryByTestId('coverage-file-not-watched-note')).toBeNull();
  });

  it('a capped list is said to prove watched and never to prove not_watched', async () => {
    const { bundle, index } = await buildScope(
      [
        {
          who: { studentRef: 'alice' },
          startMin: 0,
          endMin: 60,
          capabilities: scopeOf(['hw1.py'], false),
        },
      ],
      { submissionFiles: ['hw1.py', 'provided.py'] },
    );
    renderOpen(bundle, index);

    expect(screen.getByTestId('coverage-file-scope-incomplete').textContent).toMatch(
      /never show one was not/i,
    );
    expect(screen.queryByTestId('coverage-file-not-watched')).toBeNull();
  });

  it('a malformed scope is named by problem and never echoes the offending path', async () => {
    // An absolute path is what the reader exists to stop — it carries the
    // account name and the machine's layout (S14(b)). The panel must state the
    // problem without republishing the value.
    const { bundle, index } = await buildScope(
      [
        {
          who: { studentRef: 'alice' },
          startMin: 0,
          endMin: 60,
          capabilities: scopeOf(['/Users/someone/hw1.py']),
        },
      ],
      { submissionFiles: ['hw1.py'] },
    );
    renderOpen(bundle, index);

    const note = screen.getByTestId('coverage-file-scope-malformed');
    expect(note.textContent).toContain(describeFileScopeProblem('path_absolute'));
    expect(note.textContent).not.toMatch(/someone/);
    expect(note.textContent).toMatch(/about the recorder, not the student/i);
    // Rejected whole, so nothing about any file is asserted.
    expect(screen.queryByTestId('coverage-file-not-watched')).toBeNull();
  });

  it('never renders in the flag vocabulary', async () => {
    const { bundle, index } = await buildScope(
      [
        {
          who: { studentRef: 'alice' },
          startMin: 0,
          endMin: 60,
          capabilities: scopeOf(['hw1.py']),
        },
      ],
      { submissionFiles: ['hw1.py', 'provided.py'] },
    );
    renderOpen(bundle, index);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('coverage-file-scope').textContent).not.toMatch(
      /warning|violation|suspicious|misconduct|failed/i,
    );
  });
});

// ---------------------------------------------------------------------------
// The canonical wording
//
// `log-core` owns the staff-facing sentence for each capability state so that
// this analyzer and the three recorder repos cannot phrase one verdict four
// ways. These assertions pin the panel's copy to the helper's OUTPUT rather
// than to a literal, so a second hand-written copy cannot reappear silently.
// ---------------------------------------------------------------------------

describe('capability verdicts are quoted from log-core, not re-worded here', () => {
  it('quotes describeGitCapture for each impossible reason', async () => {
    const unavailable = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        capabilities: { git_capture: 'unavailable' },
      },
    ]);
    const first = renderOpen(unavailable.bundle, unavailable.index);
    expect(screen.getByTestId('coverage-git-impossible').textContent).toContain(
      describeGitCapture('unavailable'),
    );
    first.unmount();

    const notOwned = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        capabilities: { git_capture: 'not_owned' },
      },
    ]);
    const second = renderOpen(notOwned.bundle, notOwned.index);
    expect(screen.getByTestId('coverage-git-impossible').textContent).toContain(
      describeGitCapture('not_owned'),
    );
    second.unmount();

    const mixed = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        capabilities: { git_capture: 'unavailable' },
      },
      {
        who: { studentRef: 'bob' },
        startMin: 120,
        endMin: 180,
        capabilities: { git_capture: 'not_owned' },
      },
    ]);
    renderOpen(mixed.bundle, mixed.index);
    const mixedText = screen.getByTestId('coverage-git-impossible').textContent ?? '';
    // Both reasons, both quoted — a mixed scope is not either half.
    expect(mixedText).toContain(describeGitCapture('unavailable'));
    expect(mixedText).toContain(describeGitCapture('not_owned'));
  });

  it('keeps the "not because nothing was done" guard the helper does not carry', async () => {
    // The helper says what the recorder could not do. It does NOT say that this
    // is not a statement about the student, and that clause is the one this
    // project has paid for. Quoting the helper must never drop it.
    for (const capture of ['unavailable', 'not_owned'] as const) {
      const { bundle, index } = await buildScope([
        {
          who: { studentRef: 'alice' },
          startMin: 0,
          endMin: 60,
          capabilities: { git_capture: capture },
        },
      ]);
      const view = renderOpen(bundle, index);
      expect(screen.getByTestId('coverage-git-impossible').textContent).toMatch(
        /not that nothing was done/i,
      );
      view.unmount();
    }
  });

  it('quotes describeWitnessCapture when no session could witness', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        capabilities: { witness_capture: 'unavailable' },
      },
    ]);
    renderOpen(bundle, index);
    const text = screen.getByTestId('coverage-witness-capability-impossible').textContent ?? '';
    expect(text).toContain(describeWitnessCapture('unavailable'));
    expect(text).toMatch(/had the chance to be corroborated/i);
  });

  it('quotes describeCapabilityValueProblem, so a non-string is not called an undefined value', async () => {
    // The old literal said "a value this format does not define", which is only
    // ever true of `unknown_value`. A session reporting a NON-STRING was being
    // described as something it was not.
    const notAString = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60, capabilities: { git_capture: 7 } },
    ]);
    const first = renderOpen(notAString.bundle, notAString.index);
    expect(screen.getByTestId('coverage-git-malformed').textContent).toContain(
      describeCapabilityValueProblem('not_a_string'),
    );
    first.unmount();

    const unknownValue = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        capabilities: { git_capture: 'sort-of' },
      },
    ]);
    renderOpen(unknownValue.bundle, unknownValue.index);
    const text = screen.getByTestId('coverage-git-malformed').textContent ?? '';
    expect(text).toContain(describeCapabilityValueProblem('unknown_value'));
    expect(text).toMatch(/about the recorder, not the student/i);
  });

  /**
   * The `'available'` sentences are deliberately NOT the helpers'. The helper is
   * per-SESSION ("this session was watching…") and the panel's summary is
   * per-BUNDLE ("at least one session here"). Quoting a per-session claim as a
   * bundle-level one would assert something about sessions that never reported.
   */
  it('does NOT quote the per-session helper for the bundle-level available case', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        capabilities: { git_capture: 'available', witness_capture: 'available' },
      },
    ]);
    renderOpen(bundle, index);
    // The git section no longer carries an 'available' sentence at all: it was
    // pure scaffolding — it announced that a per-session breakdown followed and
    // then explained why the breakdown is per session. The strip says "git
    // observed" and the rows below say the rest.
    //
    // So the requirement is now the STRONGER one it always implied: the
    // per-SESSION helper sentence must appear nowhere in this section, whether
    // or not a sentence of our own is there to be compared against it.
    expect(screen.queryByTestId('coverage-git-available')).toBeNull();
    expect(screen.getByTestId('coverage-git-observation').textContent ?? '').not.toContain(
      describeGitCapture('available'),
    );
    // Witnessing DOES keep an 'available' sentence, and it stays bundle-level.
    expect(screen.getByTestId('coverage-witness-capability-available').textContent).toMatch(
      /at least one session/i,
    );
  });
});

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/**
 * `packages/shared` has no test suite of its own, so the wire schema is pinned
 * from here — the one place that holds BOTH the computed aggregate and the Zod
 * schema the server serializes it under.
 *
 * The hazard these are written against is specific and recorded in the decision
 * log: `BundleContributors.bySession` is a `ReadonlyMap`, which
 * `JSON.stringify` renders as `{}`. A wire shape carrying it would report "no
 * contributors" for every submission in the deployment, silently, and every
 * type in sight would still be green. So the assertions below round-trip real
 * facts through JSON and then through the schema, which is the only thing that
 * can see a Map that vanished.
 */
describe('the CoverageFacts wire shape', () => {
  it('round-trips real facts through JSON and the shared schema', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
      { who: 'anonymous', startMin: 300, endMin: 360 },
    ]);
    const facts = coverageFacts(bundle, index);
    // Guard the premise: there is something to lose in transit.
    expect(facts.concurrentRecording.length).toBeGreaterThan(0);
    expect(facts.identity.attributed).toBeGreaterThan(0);
    expect(facts.identity.unattributed).toBeGreaterThan(0);

    const overTheWire: unknown = JSON.parse(JSON.stringify(facts));
    const parsed = CoverageFactsSchema.parse(overTheWire);

    // Nothing was lost or flattened. `toEqual` on the whole aggregate is the
    // point: a Map that became `{}`, a count that became a string, or a field
    // the schema forgot all show up here.
    expect(parsed).toEqual(facts);
  });

  it('carries no Map, Set or other structure JSON quietly empties', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    const facts = coverageFacts(bundle, index);

    const walk = (v: unknown, path: string): void => {
      expect(v instanceof Map, `${path} is a Map — JSON.stringify renders it as {}`).toBe(false);
      expect(v instanceof Set, `${path} is a Set — JSON.stringify renders it as {}`).toBe(false);
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    walk(facts, 'coverage');
  });

  /**
   * A field added to `CoverageFacts` and not to the schema is a fact the server
   * computes and never sends — the panel would go quiet about it on the
   * server-backed surface while `/local` kept showing it, which is exactly the
   * divergence this whole change exists to close. Compared as key SETS so it
   * fails in both directions.
   */
  it('sends every top-level fact the coverage stage computes, and no more', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
    ]);
    expect(Object.keys(coverageFacts(bundle, index)).sort()).toEqual(
      Object.keys(CoverageFactsSchema.shape).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Torn final lines
//
// The loader now absorbs a `.slog` that ends part-way through a line — the
// residue of an interrupted write, which used to fail the WHOLE submission to
// load. Absorbing it is only the right trade if the truncation is VISIBLE: a
// silent one is worse than the fatal error it replaced, because nobody can tell
// that anything was left out.
// ---------------------------------------------------------------------------

describe('a torn final line is stated, and stated as an interruption', () => {
  async function tornScope(): Promise<{ bundle: Bundle; index: EventIndex }> {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      tamper: { tornTail: { sessionIndex: 0 } },
    });
    const result = await loadBundle(new Blob([zipBuffer]), 'crashed.zip');
    if (!result.ok) throw new Error('load failed');
    return { bundle: result.value, index: buildIndex(result.value) };
  }

  it('renders the truncation rather than swallowing it', async () => {
    const { bundle, index } = await tornScope();
    renderOpen(bundle, index);
    expect(screen.getByTestId('coverage-torn-tails')).toBeInTheDocument();
    expect(screen.getByTestId('coverage-torn-row').textContent).toMatch(/part-way through line/i);
  });

  it('is NOT rendered as a file that was left out of the analysis', async () => {
    // `droppedArtifacts` says a file was excluded; this says a file was
    // analysed and a fragment on its end was not. Merging the two would tell a
    // grader that a session they can see in full was excluded.
    const { bundle, index } = await tornScope();
    renderOpen(bundle, index);
    expect(screen.queryByTestId('coverage-dropped-artifacts')).toBeNull();
    expect(bundle.droppedArtifacts).toHaveLength(0);
  });

  it('names the innocent cause and denies that anything was altered', async () => {
    const { bundle, index } = await tornScope();
    renderOpen(bundle, index);
    const note = screen.getByTestId('coverage-torn-note').textContent ?? '';
    expect(note).toMatch(/interrupted/i);
    expect(note).toMatch(/nothing was altered or deleted/i);
    // The one downstream reading that could otherwise look like a deletion.
    expect(note).toMatch(/checkpoint/i);
  });

  it('says nothing at all when no log was torn', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
    ]);
    renderOpen(bundle, index);
    expect(screen.queryByTestId('coverage-torn-tails')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The strip, and what it means for an ordinary submission
//
// The panel used to render four sections of disclaimers for a solo student who
// had simply not enrolled — every §5.6 field a CURRENT recorder reports takes a
// bundle out of "nothing to note", so the quiet path had become unreachable for
// exactly the recordings it was written for. These pin the fix from both ends:
// the facts must be readable without touching anything, and the arguments about
// them must not be on screen until asked for.
// ---------------------------------------------------------------------------

/** What a current recorder reports on an ordinary solo, unenrolled session. */
const CURRENT_RECORDER = {
  git_capture: 'available',
  witness_capture: 'available',
  ...scopeOf(['src/solution.py', 'src/helpers.py']),
};

describe('an ordinary current-recorder bundle states its facts and argues none of them', () => {
  it('puts every count on screen without opening anything', async () => {
    const { bundle, index } = await buildScope([
      {
        who: 'anonymous',
        startMin: 0,
        endMin: 60,
        capabilities: CURRENT_RECORDER,
        commits: [{ sha: SHA_A, atMin: 30 }],
        activity: ['src/solution.py'],
      },
    ]);
    renderOpen(bundle, index);

    // Rendered, not clicked open — same standard Rule 3 sets for the overlap row.
    const strip = screen.getByTestId('coverage-stat-strip');
    expect(strip).toBeVisible();
    expect(screen.getByTestId('coverage-stat-sessions')).toBeVisible();
    expect(screen.getByTestId('coverage-stat-identity').textContent).toMatch(/1 unattributed/i);
    expect(screen.getByTestId('coverage-stat-commits').textContent).toMatch(/1 commit observed/i);
    expect(screen.getByTestId('coverage-stat-git').textContent).toMatch(/git observed/i);
    expect(screen.getByTestId('coverage-stat-files').textContent).toMatch(/2 files watched/i);
  });

  it('argues with nobody until asked: no explanatory paragraph is visible', async () => {
    const { bundle, index } = await buildScope([
      {
        who: 'anonymous',
        startMin: 0,
        endMin: 60,
        capabilities: CURRENT_RECORDER,
        commits: [{ sha: SHA_A, atMin: 30 }],
        activity: ['src/solution.py'],
      },
    ]);
    renderOpen(bundle, index);

    // The paragraphs this panel used to open with, on a submission where
    // nothing happened. Each must STILL BE IN THE DOCUMENT — folded, not
    // deleted — so the claim survives and only its prominence changed.
    //
    // getByTestId, not queryByTestId: a guarded loop would pass just as well
    // against a panel that stopped rendering these at all, which is the
    // opposite of the fix. Absence has to fail here.
    for (const id of [
      'coverage-unattributed-note',
      'coverage-unwitnessed-note',
      'coverage-git-observing',
      'coverage-file-scope-reported',
    ]) {
      expect(screen.getByTestId(id)).not.toBeVisible();
    }

    // Nothing alarming reached the screen either.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('submission-coverage-panel').getAttribute('role')).toBe('status');
  });

  it('keeps a rare-but-innocent fact visible, disclosure or not', async () => {
    // The rule the Why disclosure is held to: ordinary reassurance folds, a
    // fact a grader could misread does not. An overlap is the latter.
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180, capabilities: CURRENT_RECORDER },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240, capabilities: CURRENT_RECORDER },
    ]);
    renderOpen(bundle, index);

    const row = screen.getByTestId('coverage-concurrent-row');
    expect(row).toBeVisible();
    // Including the sentence that says why it is not a finding.
    expect(row.textContent).toMatch(/what collaboration looks like, and not a finding/i);
  });
});
