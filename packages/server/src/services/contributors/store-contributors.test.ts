/**
 * Contributor reconciliation — one row per PERSON, from two sources.
 *
 * Pure tests against {@link reconcileContributors}. The database enforces the
 * same invariant with a partial unique index, but a constraint violation at
 * ingest time is a failed upload; getting it right here is what stops the
 * violation being reached at all.
 *
 * The claims defended:
 *
 *  1. a co-submitter who ALSO recorded produces ONE row, not two. Two rows for
 *     one human would both duplicate them in the contributor list and SPLIT
 *     THEIR SCORE across two apparent people;
 *  2. a submitter who never recorded is still a contributor;
 *  3. a verified contributor with no roster row is KEPT, unnamed (D13) — an
 *     administrative gap, never a dropped person and never a finding;
 *  4. `unattributed` and `unverifiable` sessions produce NO contributor. This
 *     is the one that keeps solo submissions unchanged: today's ordinary bundle
 *     has no identity block at all, and a row per such session would turn one
 *     student into five apparent contributors;
 *  5. the output is deterministic, because ingest idempotency depends on a
 *     retry producing the identical row set.
 */

import { describe, it, expect } from 'vitest';
import type { Contributor } from '@provenance/analysis-core/identity/types.js';
import {
  reconcileContributors,
  rosterContributorKey,
  type ResolvedBundleContributor,
} from './store-contributors.js';

const ROSTER_ALICE = '11111111-1111-1111-1111-111111111111';
const ROSTER_BOB = '22222222-2222-2222-2222-222222222222';

function attributed(studentRef: string, sessionIds: string[]): Contributor {
  return {
    key: `attributed:2.1:institution:berkeley:${studentRef}`,
    kind: 'attributed',
    studentRef,
    identityVersion: '2.1',
    scope: 'institution',
    scopeId: 'berkeley',
    sessionIds,
  };
}

/** A session with no identity block — the ordinary, blameless state. */
function unattributed(sessionId: string): Contributor {
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

/** An identity block that is present and does NOT verify. */
function unverifiable(sessionId: string): Contributor {
  return {
    key: `unverifiable:${sessionId}`,
    kind: 'unverifiable',
    studentRef: null,
    identityVersion: null,
    scope: null,
    scopeId: null,
    sessionIds: [sessionId],
  };
}

function resolved(
  contributor: Contributor,
  rosterEntryId: string | null,
): ResolvedBundleContributor {
  return {
    contributor,
    rosterEntryId,
    sessionCount: contributor.sessionIds.length,
    firstSeen: null,
    lastSeen: null,
    studentPubkey: null,
  };
}

describe('reconcileContributors — the merge', () => {
  it('merges a co-submitter who also recorded into ONE row', () => {
    const alice = attributed('alice-ref', ['s1', 's2']);

    const rows = reconcileContributors([resolved(alice, ROSTER_ALICE)], [ROSTER_ALICE]);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The ATTRIBUTED key wins — it is the one findings can be charged to.
    expect(row.contributor_key).toBe(alice.key);
    expect(row.kind).toBe('attributed');
    expect(row.roster_entry_id).toBe(ROSTER_ALICE);
    // The roster fact is not lost in the merge.
    expect(row.is_submitter).toBe(true);
    expect(row.session_count).toBe(2);
  });

  it('does not double-count when the same submitter is named twice', () => {
    // Two uploads of one group export naming the same person.
    const rows = reconcileContributors([], [ROSTER_ALICE, ROSTER_ALICE]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.roster_entry_id).toBe(ROSTER_ALICE);
  });

  it('keeps a submitter who never recorded', () => {
    const alice = attributed('alice-ref', ['s1']);

    const rows = reconcileContributors([resolved(alice, ROSTER_ALICE)], [ROSTER_ALICE, ROSTER_BOB]);

    expect(rows).toHaveLength(2);
    const bob = rows.find((r) => r.roster_entry_id === ROSTER_BOB)!;
    expect(bob.kind).toBe('roster');
    expect(bob.contributor_key).toBe(rosterContributorKey(ROSTER_BOB));
    expect(bob.is_submitter).toBe(true);
    // A submitter who did not record has no sessions, by definition.
    expect(bob.session_count).toBe(0);
    expect(bob.student_ref).toBeNull();
  });

  it('keeps a verified contributor with no roster row, unnamed (D13)', () => {
    const stranger = attributed('stranger-ref', ['s9']);

    const rows = reconcileContributors([resolved(stranger, null)], [ROSTER_ALICE]);

    const kept = rows.find((r) => r.contributor_key === stranger.key);
    expect(kept).toBeDefined();
    expect(kept!.roster_entry_id).toBeNull();
    expect(kept!.student_ref).toBe('stranger-ref');
    // Not a submitter — nobody on the roster side named them.
    expect(kept!.is_submitter).toBe(false);
    // And the actual submitter still gets their own row.
    expect(rows).toHaveLength(2);
  });
});

describe('reconcileContributors — what must NOT become a contributor', () => {
  it('produces no row for an unattributed session (the ordinary solo bundle)', () => {
    // Five sessions, no identity block anywhere — today's normal bundle.
    const sessions = ['s1', 's2', 's3', 's4', 's5'].map((id) => resolved(unattributed(id), null));

    const rows = reconcileContributors(sessions, [ROSTER_ALICE]);

    // EXACTLY ONE contributor: the submitter. Five singleton rows here would
    // turn one student into five apparent contributors — and would break the
    // sole-contributor scoring rule that keeps solo submissions unchanged.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.roster_entry_id).toBe(ROSTER_ALICE);
    expect(rows[0]!.kind).toBe('roster');
  });

  it('produces no row for an unverifiable session', () => {
    const rows = reconcileContributors([resolved(unverifiable('s1'), ROSTER_BOB)], [ROSTER_ALICE]);

    // An identity block that does not verify must never be promoted into the
    // roster-facing attribution surface — that is how a forged block would
    // launder work onto the student it names. Bob is NOT here, even though the
    // resolver offered a roster id for him.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.roster_entry_id).toBe(ROSTER_ALICE);
    expect(rows.some((r) => r.roster_entry_id === ROSTER_BOB)).toBe(false);
  });
});

describe('reconcileContributors — determinism', () => {
  it('produces the identical row set on a repeat call (ingest idempotency)', () => {
    const input = [
      resolved(attributed('alice-ref', ['s1']), ROSTER_ALICE),
      resolved(attributed('bob-ref', ['s2']), null),
    ];
    const submitters = [ROSTER_ALICE, ROSTER_BOB];

    expect(reconcileContributors(input, submitters)).toEqual(
      reconcileContributors(input, submitters),
    );
  });

  it('is empty when there is neither a bundle contributor nor a submitter', () => {
    expect(reconcileContributors([], [])).toEqual([]);
  });
});
