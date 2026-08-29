/**
 * SplitLanesToggle.test — the solo-submission guard, and the toggle contract.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type {
  BundleContributors,
  Contributor,
  SessionContributor,
} from '@provenance/analysis-core/identity/types.js';
import { SplitLanesToggle } from './SplitLanesToggle.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function attributedContributor(ref: string): Contributor {
  return {
    key: `attributed:2.1:institution:inst1:${ref}`,
    kind: 'attributed',
    studentRef: ref,
    identityVersion: '2.1',
    scope: 'institution',
    scopeId: 'inst1',
    sessionIds: [`sess-${ref}`],
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

/**
 * `bySession` is DERIVED from `contributors` rather than left empty. The
 * resolver can never produce a stamp that names contributors but maps no
 * sessions, and lane eligibility (`lane-mode.ts`) reads `bySession` — the field
 * carrying each session's `kind` — so an empty map here would make every case
 * below vacuous rather than testing the control.
 */
function stamp(contributors: Contributor[]): BundleContributors {
  const bySession = new Map<string, SessionContributor>();
  for (const c of contributors) {
    for (const sessionId of c.sessionIds) {
      bySession.set(
        sessionId,
        c.kind === 'attributed'
          ? {
              kind: 'attributed',
              sessionId,
              contributorKey: c.key,
              studentRef: c.studentRef!,
              identityVersion: c.identityVersion!,
              scope: c.scope!,
              scopeId: c.scopeId!,
              studentPubkey: 'aa'.repeat(32),
              certWindow: 'in_window',
              credentialWindow: 'in_window',
            }
          : { kind: 'unattributed', sessionId, contributorKey: c.key },
      );
    }
  }
  return {
    bySession,
    contributors,
    rootKeyConfigured: true,
    counts: { attributed: 0, unverifiable: 0, unattributed: 0 },
  };
}

// ---------------------------------------------------------------------------
// The solo / absent-stamp case must render nothing — mirrors ContributorSelect
// ---------------------------------------------------------------------------

describe('a submission with one contributor, or none at all', () => {
  it('renders nothing when there is no contributor stamp', () => {
    const { container } = render(
      <SplitLanesToggle contributors={null} enabled={true} onToggle={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  /**
   * Regression: an UNSTAMPED bundle resolves every session `unattributed`, and
   * that key is per-session — so a solo student with five sessions produced five
   * `Contributor` entries and the old `length > 1` gate showed "Split lanes · 5"
   * and defaulted lanes ON. Downstream, the three-lane cap handed every lane to
   * the first three sessions, which for this student held no document events at
   * all: three idle lanes, no content, start to finish. See `lane-mode.ts`.
   */
  it('renders nothing for an unstamped solo bundle with five sessions', () => {
    const { container } = render(
      <SplitLanesToggle
        contributors={stamp([
          unattributedContributor('01ed01c1'),
          unattributedContributor('cc60a059'),
          unattributedContributor('ba57a7b6'),
          unattributedContributor('40f50443'),
          unattributedContributor('94143ee7'),
        ])}
        enabled={true}
        onToggle={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="split-lanes-toggle"]')).toBeNull();
  });

  it('renders nothing for a solo contributor', () => {
    const { container } = render(
      <SplitLanesToggle
        contributors={stamp([attributedContributor('alice')])}
        enabled={true}
        onToggle={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-contributor: renders, labels, toggles
// ---------------------------------------------------------------------------

describe('a submission with more than one contributor', () => {
  const twoContributors = stamp([attributedContributor('alice'), attributedContributor('bob')]);

  it('renders the control with the exact "Split lanes · N" label', () => {
    render(<SplitLanesToggle contributors={twoContributors} enabled={true} onToggle={vi.fn()} />);
    const toggle = screen.getByTestId('split-lanes-toggle');
    expect(toggle).toBeInTheDocument();
    expect(toggle.textContent).toBe('Split lanes · 2');
  });

  it('reflects the enabled state via aria-checked and data-enabled', () => {
    const { rerender } = render(
      <SplitLanesToggle contributors={twoContributors} enabled={false} onToggle={vi.fn()} />,
    );
    let toggle = screen.getByTestId('split-lanes-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.dataset['enabled']).toBe('false');

    rerender(<SplitLanesToggle contributors={twoContributors} enabled={true} onToggle={vi.fn()} />);
    toggle = screen.getByTestId('split-lanes-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.dataset['enabled']).toBe('true');
  });

  it('calls onToggle with the flipped state, not the current one', () => {
    const onToggle = vi.fn();
    render(<SplitLanesToggle contributors={twoContributors} enabled={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('split-lanes-toggle'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('reflects five contributors in the label too', () => {
    const five = stamp(
      ['alice', 'bob', 'carol', 'dave', 'erin'].map((ref) => attributedContributor(ref)),
    );
    render(<SplitLanesToggle contributors={five} enabled={true} onToggle={vi.fn()} />);
    expect(screen.getByTestId('split-lanes-toggle').dataset['laneCount']).toBe('5');
  });
});
