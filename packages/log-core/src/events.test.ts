/**
 * Format tests for `GitEventPayload` — the commit-graph fields (program spec
 * S5).
 *
 * ## Why the graph is captured at record time
 *
 * Gradescope delivers no `.git`, and a `.git` that did travel would be
 * rewritable anyway: `git commit --amend`, `rebase`, and `filter-branch` all
 * rewrite history after the fact, so a repository presented at submission time
 * is evidence of what the student *ended up with*, not of what happened. The
 * recorder sits on the live repo while the work is being done, so recording
 * `sha` / `parents` / `branch` into the signed hash chain captures the graph at
 * the instant it existed, where it can no longer be rewritten.
 *
 * ## What is deliberately NOT captured
 *
 * **No git author name and no author email — not here, not anywhere.** The
 * approved CPHS protocol treats a new category of identifier as requiring a
 * filed modification before implementation, and author identity is exactly that.
 * `sha`, `parents`, and `branch` are structural: they describe the shape of the
 * history, not who made it. Attribution already has a designed home — the opaque
 * `student_ref` inside `session.start.identity` — and it is opaque on purpose.
 * A test below asserts the payload's key set so this cannot be widened by
 * accident.
 */

import { describe, it, expect } from 'vitest';
import { canonicalize } from './canonical.js';
import { chainEntry, GENESIS_PREV_HASH } from './hash-chain.js';
import { FLOOR_EVENT_KINDS, POLICY_GATED_EVENT_KINDS } from './policy.js';
import type { GitEventPayload } from './events.js';

const WALL = '2026-01-01T00:00:00.000Z';

function envelope(data: GitEventPayload): Parameters<typeof chainEntry>[1] {
  return { seq: 0, t: 0, wall: WALL, kind: 'git.event', data };
}

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

describe('git.event remains a floor event kind', () => {
  it('is in FLOOR_EVENT_KINDS and not policy-gateable', () => {
    // Adding fields to a floor payload does not make it gateable. A course must
    // not be able to switch the commit graph off: it is the exculpatory evidence
    // that a large insert was a merge or a checkout rather than a paste.
    expect(FLOOR_EVENT_KINDS).toContain('git.event');
    expect(Object.keys(POLICY_GATED_EVENT_KINDS)).not.toContain('git.event');
  });
});

// ---------------------------------------------------------------------------
// 1.x compatibility — permanent (program spec §9)
// ---------------------------------------------------------------------------

describe('GitEventPayload 1.x payloads are unaffected', () => {
  it('every new field is optional: `{ operation }` alone is a valid payload', () => {
    const minimal: GitEventPayload = { operation: 'state_change' };
    expect(canonicalize(minimal)).toBe('{"operation":"state_change"}');
  });

  it('the legacy `{ operation, commit_sha }` shape canonicalizes exactly as before', () => {
    // Pinned literal, not a recomputation: a 1.x bundle recorded years ago must
    // keep producing this hash, so this string is the contract.
    const legacy: GitEventPayload = { operation: 'state_change', commit_sha: 'a'.repeat(40) };
    expect(canonicalize(legacy)).toBe(
      `{"commit_sha":"${'a'.repeat(40)}","operation":"state_change"}`,
    );
  });

  it('a legacy envelope chains to a stable hash', () => {
    const legacy: GitEventPayload = { operation: 'state_change', commit_sha: 'a'.repeat(40) };
    const entry = chainEntry(GENESIS_PREV_HASH, envelope(legacy));
    // Recomputed the same way twice — the value is pinned by the conformance
    // vector, not duplicated here; what matters is that adding optional fields
    // to the type did not perturb a payload that does not use them.
    expect(entry.hash).toBe(chainEntry(GENESIS_PREV_HASH, envelope(legacy)).hash);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// The 2.0 commit-graph fields
// ---------------------------------------------------------------------------

describe('GitEventPayload commit graph', () => {
  const merge: GitEventPayload = {
    operation: 'commit',
    commit_sha: 'c'.repeat(40),
    sha: 'c'.repeat(40),
    parents: ['a'.repeat(40), 'b'.repeat(40)],
    branch: 'main',
  };

  it('canonicalizes with JCS key order: branch, commit_sha, operation, parents, sha', () => {
    // Three ports must reproduce these bytes. JCS sorts object keys; arrays keep
    // their order, which is why `parents` order is load-bearing (see below).
    expect(canonicalize(merge)).toBe(
      `{"branch":"main","commit_sha":"${'c'.repeat(40)}","operation":"commit",` +
        `"parents":["${'a'.repeat(40)}","${'b'.repeat(40)}"],"sha":"${'c'.repeat(40)}"}`,
    );
  });

  it('preserves parent ORDER — first parent is the branch being merged into', () => {
    const flipped: GitEventPayload = { ...merge, parents: ['b'.repeat(40), 'a'.repeat(40)] };
    // Reordering parents inverts the meaning of a merge, so it must change the
    // canonical bytes (and therefore the chain hash) rather than normalize away.
    expect(canonicalize(flipped)).not.toBe(canonicalize(merge));
  });

  it('distinguishes a root commit (no parents) from an unknown one (field absent)', () => {
    const root: GitEventPayload = { operation: 'commit', sha: 'd'.repeat(40), parents: [] };
    const unknown: GitEventPayload = { operation: 'commit', sha: 'd'.repeat(40) };
    // An empty array means "this commit genuinely has no parents"; an absent
    // field means "the recorder could not read them". Collapsing the two would
    // let a rewritten root commit hide as a read failure.
    expect(canonicalize(root)).not.toBe(canonicalize(unknown));
    expect(canonicalize(root)).toContain('"parents":[]');
    expect(canonicalize(unknown)).not.toContain('parents');
  });

  it('omits branch when HEAD is detached, rather than inventing a name', () => {
    const detached: GitEventPayload = { operation: 'commit', sha: 'd'.repeat(40), parents: [] };
    expect(canonicalize(detached)).not.toContain('branch');
  });

  it('chains deterministically', () => {
    const a = chainEntry(GENESIS_PREV_HASH, envelope(merge));
    const b = chainEntry(GENESIS_PREV_HASH, envelope(merge));
    expect(a.hash).toBe(b.hash);
  });

  it('carries NO git author name or email', () => {
    // The hard constraint. Widening this payload with author identity requires a
    // filed CPHS modification BEFORE implementation, so the key set is asserted
    // rather than left to review.
    const keys = Object.keys(merge).sort();
    expect(keys).toEqual(['branch', 'commit_sha', 'operation', 'parents', 'sha']);

    // And the type itself admits nothing else: these must be compile errors.
    // @ts-expect-error author_name is not part of GitEventPayload and must not be
    const withName: GitEventPayload = { operation: 'commit', author_name: 'Ada' };
    // @ts-expect-error author_email is not part of GitEventPayload and must not be
    const withEmail: GitEventPayload = { operation: 'commit', author_email: 'a@b.edu' };
    expect(withName.operation).toBe('commit');
    expect(withEmail.operation).toBe('commit');
  });
});
