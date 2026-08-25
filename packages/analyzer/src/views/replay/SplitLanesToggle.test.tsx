/**
 * SplitLanesToggle.test — the solo-submission guard, and the toggle contract.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { BundleContributors, Contributor } from '@provenance/analysis-core/identity/types.js';
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

function stamp(contributors: Contributor[]): BundleContributors {
  return {
    bySession: new Map(),
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

  it('renders the control and shows the lane count in the label', () => {
    render(<SplitLanesToggle contributors={twoContributors} enabled={true} onToggle={vi.fn()} />);
    const toggle = screen.getByTestId('split-lanes-toggle');
    expect(toggle).toBeInTheDocument();
    expect(toggle.textContent).toMatch(/2/);
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
