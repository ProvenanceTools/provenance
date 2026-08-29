import { describe, expect, it } from 'vitest';
import type {
  BundleContributors,
  SessionContributor,
} from '@provenance/analysis-core/identity/types.js';

import { isLaneEligible } from './lane-mode.js';

function attributed(sessionId: string, studentRef: string): SessionContributor {
  return {
    kind: 'attributed',
    sessionId,
    contributorKey: `attributed:2.1:institution:inst1:${studentRef}`,
    studentRef,
    identityVersion: '2.1',
    scope: 'institution',
    scopeId: 'inst1',
    studentPubkey: 'aa'.repeat(32),
    certWindow: { in_window: true },
    credentialWindow: { in_window: true },
  };
}

function unattributed(sessionId: string): SessionContributor {
  return {
    kind: 'unattributed',
    sessionId,
    contributorKey: `unattributed:${encodeURIComponent(sessionId)}`,
  };
}

function bundleContributors(sessions: readonly SessionContributor[]): BundleContributors {
  const bySession = new Map(sessions.map((s) => [s.sessionId, s]));
  const byKey = new Map<string, { key: string; kind: string; sessionIds: string[] }>();
  for (const s of sessions) {
    const existing = byKey.get(s.contributorKey);
    if (existing !== undefined) {
      existing.sessionIds.push(s.sessionId);
      continue;
    }
    byKey.set(s.contributorKey, {
      key: s.contributorKey,
      kind: s.kind,
      sessionIds: [s.sessionId],
    });
  }
  return {
    bySession,
    contributors: [...byKey.values()],
    rootKeyConfigured: true,
    counts: { attributed: 0, unverifiable: 0, unattributed: 0 },
  } as unknown as BundleContributors;
}

describe('isLaneEligible', () => {
  it('is false with no contributor stamp at all', () => {
    expect(isLaneEligible(null)).toBe(false);
    expect(isLaneEligible(undefined)).toBe(false);
  });

  it('is false for a solo attributed submission', () => {
    const c = bundleContributors([attributed('s1', 'alice'), attributed('s2', 'alice')]);
    expect(isLaneEligible(c)).toBe(false);
  });

  it('is true for two provably different attributed contributors', () => {
    const c = bundleContributors([attributed('s1', 'alice'), attributed('s2', 'bob')]);
    expect(isLaneEligible(c)).toBe(true);
  });

  /**
   * The regression this module exists for.
   *
   * An unstamped solo bundle resolves every session `unattributed`, and
   * `unattributedContributorKey` is keyed per SESSION — so five sessions become
   * five distinct `Contributor` entries. The old gate (`contributors.length > 1`)
   * read that as a five-person group, turned lanes on, and then
   * `buildLaneLayout`'s three-lane cap handed every lane to the first three
   * sessions in order. For a student whose editing happened in sessions four and
   * five, that is three permanently idle lanes and no content, start to finish.
   */
  it('is false for an unstamped solo bundle with many sessions', () => {
    const c = bundleContributors([
      unattributed('01ed01c1'),
      unattributed('cc60a059'),
      unattributed('ba57a7b6'),
      unattributed('40f50443'),
      unattributed('94143ee7'),
    ]);
    expect(c.contributors.length).toBe(5); // the count the old gate trusted
    expect(isLaneEligible(c)).toBe(false);
  });

  it('is false when only one side is attributed', () => {
    const c = bundleContributors([attributed('s1', 'alice'), unattributed('s2')]);
    expect(isLaneEligible(c)).toBe(false);
  });
});
