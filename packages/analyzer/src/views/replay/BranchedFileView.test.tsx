/**
 * BranchedFileView.test — spec §6 Rule 4.
 *
 * The assertions that matter are negative ones: that no branch is preferred,
 * that no control exists to reduce the pane to one lineage, and that `unknown`
 * never borrows `concurrent`'s vocabulary.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FileReplayState } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import type { SessionContributor } from '@provenance/analysis-core/identity/types.js';
import { BranchedFileView } from './BranchedFileView.js';
import type { AmbiguousReconstruction } from './engine-core.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function state(content: string): FileReplayState {
  return {
    content,
    provenance: new Uint32Array(content.length),
    kindByGlobalIdx: new Map(),
    hashBySaveSeq: new Map(),
  };
}

function attributed(sessionId: string, ref: string): SessionContributor {
  return {
    kind: 'attributed',
    sessionId,
    contributorKey: `attributed:2.1:institution:inst1:${ref}`,
    studentRef: ref,
    identityVersion: '2.1',
    scope: 'institution',
    scopeId: 'inst1',
    studentPubkey: 'pk',
    certWindow: { in_window: true },
    credentialWindow: { in_window: true },
  };
}

function concurrent(
  branches: Array<{ ref: string; content: string; ambiguousAncestry?: boolean }>,
): AmbiguousReconstruction {
  return {
    kind: 'concurrent',
    branches: branches.map((b) => ({
      contributorKey: `attributed:2.1:institution:inst1:${b.ref}`,
      contributor: attributed(`sess-${b.ref}`, b.ref),
      tip: { sessionId: `sess-${b.ref}`, seq: 7 },
      value: state(b.content),
      ambiguousAncestry: b.ambiguousAncestry ?? false,
    })),
    divergence: {
      contributorKeys: branches.map((b) => `attributed:2.1:institution:inst1:${b.ref}`),
      detail: 'Two lineages are live at this cut and nothing orders them.',
    },
  };
}

const unknown: AmbiguousReconstruction = {
  kind: 'unknown',
  reason: 'event_outside_ordering',
  detail: 'An event of this file is not in the ordering’s scope.',
};

// ---------------------------------------------------------------------------
// concurrent
// ---------------------------------------------------------------------------

describe('two partners on divergent branches', () => {
  const twoBranches = concurrent([
    { ref: 'alice', content: 'ALICE WROTE THIS' },
    { ref: 'bob', content: 'BOB WROTE THIS' },
  ]);

  it('shows BOTH branches', () => {
    render(<BranchedFileView filePath="hw.py" ambiguity={twoBranches} />);
    const branches = screen.getAllByTestId('replay-branch');
    expect(branches).toHaveLength(2);
    expect(screen.getByText('ALICE WROTE THIS')).toBeInTheDocument();
    expect(screen.getByText('BOB WROTE THIS')).toBeInTheDocument();
  });

  it('labels each branch with its contributor', () => {
    render(<BranchedFileView filePath="hw.py" ambiguity={twoBranches} />);
    const names = screen.getAllByTestId('replay-branch-contributor').map((e) => e.textContent);
    expect(names.sort()).toEqual(['alice', 'bob']);
  });

  it('chooses neither — no branch is marked selected, primary, or default', () => {
    const { container } = render(<BranchedFileView filePath="hw.py" ambiguity={twoBranches} />);
    for (const el of screen.getAllByTestId('replay-branch')) {
      expect(el.getAttribute('aria-selected')).toBeNull();
      expect(el.getAttribute('data-selected')).toBeNull();
      expect(el.className).not.toMatch(/primary|selected|active/);
    }
    // No affordance that would collapse the pane to one lineage. A control
    // labelled "show Alice's version" is one screenshot away from being read as
    // "this is what Alice submitted".
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    expect(container.querySelectorAll('input')).toHaveLength(0);
  });

  it('never renders an interleaving of the two branches', () => {
    render(<BranchedFileView filePath="hw.py" ambiguity={twoBranches} />);
    for (const pane of screen.getAllByTestId('replay-branch-content')) {
      const text = pane.textContent ?? '';
      // Each pane holds exactly one lineage. A pane holding both is the
      // wall-clock replay's fabrication.
      expect(text.includes('ALICE') && text.includes('BOB')).toBe(false);
    }
  });

  it('says the evidence does not order them, and that clocks are not evidence', () => {
    render(<BranchedFileView filePath="hw.py" ambiguity={twoBranches} />);
    const body = screen.getByTestId('replay-ambiguous-body').textContent ?? '';
    expect(body).toMatch(/does not order/i);
    expect(body).toMatch(/clocks are not evidence/i);
    expect(body).toMatch(/never existed/i);
  });

  it('shows a third lineage rather than dropping it', () => {
    render(
      <BranchedFileView
        filePath="hw.py"
        ambiguity={concurrent([
          { ref: 'alice', content: 'A' },
          { ref: 'bob', content: 'B' },
          { ref: 'carol', content: 'C' },
        ])}
      />,
    );
    expect(screen.getAllByTestId('replay-branch')).toHaveLength(3);
    expect(screen.getByTestId('replay-branches').getAttribute('data-branch-count')).toBe('3');
  });

  it('admits when a branch’s own history is not ordered either', () => {
    render(
      <BranchedFileView
        filePath="hw.py"
        ambiguity={concurrent([
          { ref: 'alice', content: 'A', ambiguousAncestry: true },
          { ref: 'bob', content: 'B' },
        ])}
      />,
    );
    const notes = screen.getAllByTestId('replay-branch-ambiguous-ancestry');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toMatch(/best-effort/i);
  });

  it('marks the pane as concurrent, not unknown', () => {
    render(<BranchedFileView filePath="hw.py" ambiguity={twoBranches} />);
    expect(screen.getByTestId('replay-ambiguous').getAttribute('data-ambiguity-kind')).toBe(
      'concurrent',
    );
  });
});

// ---------------------------------------------------------------------------
// unknown
// ---------------------------------------------------------------------------

describe('unknown is presented as the absence of a record', () => {
  it('shows no branches at all', () => {
    render(<BranchedFileView filePath="hw.py" ambiguity={unknown} />);
    expect(screen.queryAllByTestId('replay-branch')).toHaveLength(0);
    expect(screen.queryByTestId('replay-branches')).toBeNull();
  });

  it('does not borrow concurrency’s vocabulary', () => {
    render(<BranchedFileView filePath="hw.py" ambiguity={unknown} />);
    const title = screen.getByTestId('replay-ambiguous-title').textContent ?? '';
    const body = screen.getByTestId('replay-ambiguous-body').textContent ?? '';
    expect(title).not.toMatch(/no single version/i);
    expect(body).toMatch(/absence of a record/i);
    expect(body).toMatch(/not a claim that the edits raced/i);
  });

  it('marks the pane as unknown, not concurrent', () => {
    render(<BranchedFileView filePath="hw.py" ambiguity={unknown} />);
    expect(screen.getByTestId('replay-ambiguous').getAttribute('data-ambiguity-kind')).toBe(
      'unknown',
    );
  });
});

// ---------------------------------------------------------------------------
// Tone, kept distinct
// ---------------------------------------------------------------------------

describe('branch tone', () => {
  function withContributor(c: SessionContributor): AmbiguousReconstruction {
    return {
      kind: 'concurrent',
      branches: [
        {
          contributorKey: c.contributorKey,
          contributor: c,
          tip: { sessionId: c.sessionId, seq: 1 },
          value: state('X'),
          ambiguousAncestry: false,
        },
        {
          contributorKey: 'attributed:2.1:institution:inst1:bob',
          contributor: attributed('sess-bob', 'bob'),
          tip: { sessionId: 'sess-bob', seq: 1 },
          value: state('Y'),
          ambiguousAncestry: false,
        },
      ],
      divergence: { contributorKeys: [], detail: 'd' },
    };
  }

  it('renders an unattributed branch blamelessly, and differently from a failed check', () => {
    render(
      <BranchedFileView
        filePath="hw.py"
        ambiguity={withContributor({
          kind: 'unattributed',
          sessionId: 'sess-nobody',
          contributorKey: 'unattributed:sess-nobody',
        })}
      />,
    );
    const branch = screen
      .getAllByTestId('replay-branch')
      .find((e) => e.getAttribute('data-tone') === 'unattributed');
    expect(branch).toBeDefined();
    expect(branch!.textContent).toMatch(/no identity/i);
    expect(branch!.textContent).not.toMatch(/did not verify/i);
  });

  it('separates "not checked" from "did not verify" in the badge text', () => {
    render(
      <BranchedFileView
        filePath="hw.py"
        ambiguity={withContributor({
          kind: 'unverifiable',
          sessionId: 'sess-nokey',
          contributorKey: 'unverifiable:sess-nokey',
          claimedStudentRef: 'carol',
          claimedScopeId: 'inst1',
          claimedIdentityVersion: '2.1',
          reason: { kind: 'no_root_key', detail: 'no root public key is configured' },
        })}
      />,
    );
    const branch = screen
      .getAllByTestId('replay-branch')
      .find((e) => e.getAttribute('data-tone') === 'identity_not_checked');
    expect(branch).toBeDefined();
    expect(branch!.textContent).toMatch(/not checked/i);
    expect(branch!.textContent).not.toMatch(/did not verify/i);
  });
});
