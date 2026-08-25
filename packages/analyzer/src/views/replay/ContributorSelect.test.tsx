/**
 * ContributorSelect.test — grouping rules, and the solo bundle that must not
 * change at all.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type {
  BundleContributors,
  Contributor,
  SessionContributor,
} from '@provenance/analysis-core/identity/types.js';
import { ContributorSelect } from './ContributorSelect.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function event(sessionId: string, globalIdx: number): IndexedEvent {
  return {
    sessionId,
    seq: globalIdx,
    globalIdx,
    wall: '2026-01-01T00:00:00.000Z',
    t: globalIdx * 100,
    kind: 'doc.change',
    payload: {},
  } as unknown as IndexedEvent;
}

function index(sessionIds: string[]): EventIndex {
  const bySessionId = new Map<string, IndexedEvent[]>();
  sessionIds.forEach((id, i) => bySessionId.set(id, [event(id, i * 10)]));
  return { bySessionId } as unknown as EventIndex;
}

function attributedSession(sessionId: string, ref: string): SessionContributor {
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

function attributedContributor(ref: string, sessionIds: string[]): Contributor {
  return {
    key: `attributed:2.1:institution:inst1:${ref}`,
    kind: 'attributed',
    studentRef: ref,
    identityVersion: '2.1',
    scope: 'institution',
    scopeId: 'inst1',
    sessionIds,
  };
}

function unattributedContributor(sessionId: string): Contributor {
  return {
    key: `unattributed:${sessionId}`,
    kind: 'unattributed',
    studentRef: null,
    identityVersion: null,
    scope: null,
    scopeId: null,
    sessionIds: [sessionId],
  };
}

function stamp(
  contributors: Contributor[],
  bySession: Array<[string, SessionContributor]>,
): BundleContributors {
  return {
    bySession: new Map(bySession),
    contributors,
    rootKeyConfigured: true,
    counts: { attributed: 0, unverifiable: 0, unattributed: 0 },
  };
}

// ---------------------------------------------------------------------------
// The solo case must be untouched
// ---------------------------------------------------------------------------

describe('a submission with one contributor', () => {
  it('renders nothing at all', () => {
    const { container } = render(
      <ContributorSelect
        contributors={stamp(
          [attributedContributor('alice', ['s1', 's2'])],
          [
            ['s1', attributedSession('s1', 'alice')],
            ['s2', attributedSession('s2', 'alice')],
          ],
        )}
        index={index(['s1', 's2'])}
        currentSessionId="s1"
        onSeek={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when there is no contributor stamp — the server-backed tab', () => {
    const { container } = render(
      <ContributorSelect
        contributors={null}
        index={index(['s1'])}
        currentSessionId="s1"
        onSeek={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe('grouping', () => {
  it('groups a student’s two machines into one contributor', () => {
    render(
      <ContributorSelect
        contributors={stamp(
          [attributedContributor('alice', ['s1', 's2']), attributedContributor('bob', ['s3'])],
          [
            ['s1', attributedSession('s1', 'alice')],
            ['s2', attributedSession('s2', 'alice')],
            ['s3', attributedSession('s3', 'bob')],
          ],
        )}
        index={index(['s1', 's2', 's3'])}
        currentSessionId="s1"
        onSeek={vi.fn()}
      />,
    );
    // Three sessions, two contributors.
    expect(screen.getByTestId('replay-contributor-switcher').dataset['contributorCount']).toBe('2');
    expect(screen.getByTestId('replay-contributor-detail').textContent).toMatch(/2 sessions/);
  });

  it('never merges two unattributed sessions into one contributor', () => {
    render(
      <ContributorSelect
        contributors={stamp(
          [unattributedContributor('s1'), unattributedContributor('s2')],
          [
            ['s1', { kind: 'unattributed', sessionId: 's1', contributorKey: 'unattributed:s1' }],
            ['s2', { kind: 'unattributed', sessionId: 's2', contributorKey: 'unattributed:s2' }],
          ],
        )}
        index={index(['s1', 's2'])}
        currentSessionId="s1"
        onSeek={vi.fn()}
      />,
    );
    // Two singleton pseudo-contributors, not one merged "unknown person".
    expect(screen.getByTestId('replay-contributor-switcher').dataset['contributorCount']).toBe('2');
  });

  it('renders an unattributed contributor blamelessly', () => {
    render(
      <ContributorSelect
        contributors={stamp(
          [attributedContributor('alice', ['s1']), unattributedContributor('s2')],
          [
            ['s1', attributedSession('s1', 'alice')],
            ['s2', { kind: 'unattributed', sessionId: 's2', contributorKey: 'unattributed:s2' }],
          ],
        )}
        index={index(['s1', 's2'])}
        currentSessionId="s2"
        onSeek={vi.fn()}
      />,
    );
    const detail = screen.getByTestId('replay-contributor-detail');
    expect(detail.dataset['tone']).toBe('unattributed');
    expect(detail.textContent).toMatch(/not a finding/i);
    expect(detail.textContent).not.toMatch(/fail|suspicious|verif/i);
  });
});

// ---------------------------------------------------------------------------
// Seek, not filter
// ---------------------------------------------------------------------------

describe('choosing a contributor', () => {
  const contributors = stamp(
    [attributedContributor('alice', ['s1']), attributedContributor('bob', ['s2'])],
    [
      ['s1', attributedSession('s1', 'alice')],
      ['s2', attributedSession('s2', 'bob')],
    ],
  );

  it('seeks to that contributor’s first recorded event', () => {
    const onSeek = vi.fn();
    render(
      <ContributorSelect
        contributors={contributors}
        index={index(['s1', 's2'])}
        currentSessionId="s1"
        onSeek={onSeek}
      />,
    );
    fireEvent.change(screen.getByTestId('replay-contributor-select'), {
      target: { value: 'attributed:2.1:institution:inst1:bob' },
    });
    expect(onSeek).toHaveBeenCalledWith(10);
  });

  it('is a live readout of where the playhead is', () => {
    const { rerender } = render(
      <ContributorSelect
        contributors={contributors}
        index={index(['s1', 's2'])}
        currentSessionId="s1"
        onSeek={vi.fn()}
      />,
    );
    expect((screen.getByTestId('replay-contributor-select') as HTMLSelectElement).value).toBe(
      'attributed:2.1:institution:inst1:alice',
    );

    rerender(
      <ContributorSelect
        contributors={contributors}
        index={index(['s1', 's2'])}
        currentSessionId="s2"
        onSeek={vi.fn()}
      />,
    );
    expect((screen.getByTestId('replay-contributor-select') as HTMLSelectElement).value).toBe(
      'attributed:2.1:institution:inst1:bob',
    );
  });

  it('does not silently name a contributor when the playhead is in an uncovered session', () => {
    render(
      <ContributorSelect
        contributors={contributors}
        index={index(['s1', 's2'])}
        currentSessionId="s-not-in-stamp"
        onSeek={vi.fn()}
      />,
    );
    // An explicit "not resolved" option, rather than the browser silently
    // displaying the first option and naming the wrong person.
    expect(screen.getByTestId('replay-contributor-unresolved')).toBeInTheDocument();
    expect(screen.queryByTestId('replay-contributor-detail')).toBeNull();
  });
});
