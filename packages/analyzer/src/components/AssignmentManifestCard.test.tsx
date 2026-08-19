import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssignmentManifestCard } from './AssignmentManifestCard.js';
import type { AssignmentManifest } from '@provenance/shared/api-schemas';

const LEGACY: AssignmentManifest = {
  format_version: '1.x',
  course_id: null,
  collaboration: null,
  submission: null,
  scope: null,
  disabled_signals: [],
  heartbeat_interval_ms: 30_000,
  cert: null,
  trust_chain: 'legacy',
  trust_chain_detail: null,
};

const V2: AssignmentManifest = {
  format_version: '2.0',
  course_id: 'berkeley-cs61b',
  collaboration: 'group',
  submission: 'git',
  scope: 'repo',
  disabled_signals: ['terminal', 'selection_change'],
  heartbeat_interval_ms: 60_000,
  cert: {
    course_id: 'berkeley-cs61b',
    course_pubkey: 'ab'.repeat(32),
    valid_from: '2026-08-20',
    valid_until: '2027-01-15',
    in_window: true,
    window_reason: null,
  },
  trust_chain: 'verified',
  trust_chain_detail: null,
};

describe('AssignmentManifestCard', () => {
  it('renders nothing when there is no manifest', () => {
    const { container } = render(<AssignmentManifestCard manifest={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a 1.x bundle with nothing disabled', () => {
    // An empty card is worse than no card: it would imply the information is
    // missing rather than that the format predates it.
    const { container } = render(<AssignmentManifestCard manifest={LEGACY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows course, capability flags and certificate window for a 2.0 bundle', () => {
    render(<AssignmentManifestCard manifest={V2} />);
    expect(screen.getByTestId('manifest-fact-course')).toHaveTextContent('berkeley-cs61b');
    expect(screen.getByTestId('manifest-fact-collaboration')).toHaveTextContent('Group');
    expect(screen.getByTestId('manifest-fact-submission')).toHaveTextContent('Git repository');
    expect(screen.getByTestId('manifest-fact-scope')).toHaveTextContent('Whole repository');
    expect(screen.getByTestId('manifest-fact-trust-chain')).toHaveTextContent('Verified offline');
    expect(screen.getByTestId('manifest-fact-certificate-validity')).toHaveTextContent(
      '2026-08-20 → 2027-01-15',
    );
  });

  it('names the disabled capture signals and says the absence is policy', () => {
    render(<AssignmentManifestCard manifest={V2} />);
    expect(screen.getByTestId('manifest-disabled-Terminal')).toBeInTheDocument();
    expect(screen.getByTestId('manifest-disabled-Cursor & selection')).toBeInTheDocument();
    expect(screen.getByTestId('manifest-capture-policy')).toHaveTextContent(
      /course policy, not student behaviour/,
    );
  });

  it('shows a retuned heartbeat cadence', () => {
    render(<AssignmentManifestCard manifest={V2} />);
    expect(screen.getByTestId('manifest-heartbeat-interval')).toHaveTextContent('60s');
  });

  it('stays quiet about the cadence at the 30s default', () => {
    render(<AssignmentManifestCard manifest={{ ...V2, heartbeat_interval_ms: 30_000 }} />);
    expect(screen.queryByTestId('manifest-heartbeat-interval')).toBeNull();
  });

  it('states plainly when a course disabled nothing', () => {
    render(<AssignmentManifestCard manifest={{ ...V2, disabled_signals: [] }} />);
    expect(screen.getByTestId('manifest-capture-policy')).toHaveTextContent(
      'All capture signals were enabled',
    );
  });

  it('surfaces a failed trust chain with its cause', () => {
    render(
      <AssignmentManifestCard
        manifest={{
          ...V2,
          trust_chain: 'invalid',
          trust_chain_detail: 'course_cert does not verify against the root public key',
        }}
      />,
    );
    expect(screen.getByTestId('manifest-fact-trust-chain')).toHaveTextContent(
      'course_cert does not verify against the root public key',
    );
  });

  it('marks a lapsed certificate without calling the chain broken', () => {
    render(
      <AssignmentManifestCard
        manifest={{
          ...V2,
          cert: { ...V2.cert!, in_window: false, window_reason: 'after_valid_until' },
        }}
      />,
    );
    expect(screen.getByTestId('manifest-fact-trust-chain')).toHaveTextContent(
      'Verified — certificate after_valid_until',
    );
  });

  it('renders for a 1.x bundle only when a signal is somehow disabled', () => {
    // Defensive: a 1.x manifest can never carry a policy, but if a future
    // producer reports one the panel must not swallow it.
    render(<AssignmentManifestCard manifest={{ ...LEGACY, disabled_signals: ['terminal'] }} />);
    expect(screen.getByTestId('manifest-disabled-Terminal')).toBeInTheDocument();
  });
});
