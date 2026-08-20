/**
 * The `git.event` repository discriminator — decision D12 (collaboration spec
 * S14(b)).
 *
 * These tests are written against the FACTS the reader must keep apart, because
 * every one of them is a place where a tidy simplification becomes either a false
 * correlation between two unrelated repositories or a false accusation against a
 * student whose recorder simply had nothing to say.
 *
 * The load-bearing ones:
 *
 *  - absent is not malformed, and neither is a finding;
 *  - a value that cannot be a commit sha never becomes a repository key, which is
 *    what keeps a repository PATH or a remote URL out of the reader;
 *  - adding the field does not perturb a payload that does not carry it.
 */

import { describe, it, expect } from 'vitest';
import { canonicalize } from './canonical.js';
import { chainEntry, GENESIS_PREV_HASH } from './hash-chain.js';
import { readRepositoryDiscriminator, REPOSITORY_DISCRIMINATOR_FIELD } from './git-event.js';
import type { GitEventPayload } from './events.js';

const SHA1_ROOT = 'a'.repeat(40);
const SHA256_ROOT = 'b'.repeat(64);

// ---------------------------------------------------------------------------
// Absence — the ordinary case, permanently
// ---------------------------------------------------------------------------

describe('an absent discriminator', () => {
  it('reads as absent, not as a repository and not as a problem', () => {
    // Every bundle in existence is in this state, and no recorder emits the
    // field yet. Absent must therefore be indistinguishable from the world
    // before the field existed.
    expect(readRepositoryDiscriminator({ operation: 'commit', sha: SHA1_ROOT })).toEqual({
      kind: 'absent',
    });
  });

  it('reads an explicit null as absent, so a writer that spelled it still parses', () => {
    expect(readRepositoryDiscriminator({ operation: 'commit', root_commit_sha: null })).toEqual({
      kind: 'absent',
    });
  });

  it('reads a 1.x payload as absent', () => {
    expect(
      readRepositoryDiscriminator({ operation: 'state_change', commit_sha: SHA1_ROOT }),
    ).toEqual({ kind: 'absent' });
  });

  it('reads a non-object payload as absent rather than inventing a problem', () => {
    // There is no field on a non-object. Reporting a problem here would report
    // the same garbage twice: the caller already knows the payload is unusable.
    expect(readRepositoryDiscriminator(null)).toEqual({ kind: 'absent' });
    expect(readRepositoryDiscriminator(undefined)).toEqual({ kind: 'absent' });
    expect(readRepositoryDiscriminator('a string')).toEqual({ kind: 'absent' });
    expect(readRepositoryDiscriminator(42)).toEqual({ kind: 'absent' });
    expect(readRepositoryDiscriminator([SHA1_ROOT])).toEqual({ kind: 'absent' });
  });
});

// ---------------------------------------------------------------------------
// A recorded discriminator
// ---------------------------------------------------------------------------

describe('a recorded discriminator', () => {
  it('reads a 40-hex sha-1 root commit', () => {
    expect(readRepositoryDiscriminator({ root_commit_sha: SHA1_ROOT })).toEqual({
      kind: 'recorded',
      rootCommitSha: SHA1_ROOT,
    });
  });

  it('reads a 64-hex sha-256 root commit, because git has two object formats', () => {
    expect(readRepositoryDiscriminator({ root_commit_sha: SHA256_ROOT })).toEqual({
      kind: 'recorded',
      rootCommitSha: SHA256_ROOT,
    });
  });

  it('returns the value verbatim, so two partners on one repository agree exactly', () => {
    const mixedCaseFree = '0123456789abcdef'.repeat(2) + '01234567';
    expect(mixedCaseFree).toHaveLength(40);
    const read = readRepositoryDiscriminator({ root_commit_sha: mixedCaseFree });
    expect(read).toEqual({ kind: 'recorded', rootCommitSha: mixedCaseFree });
  });

  it('ignores unknown extra keys, so a newer recorder does not break this reader', () => {
    const read = readRepositoryDiscriminator({
      operation: 'commit',
      root_commit_sha: SHA1_ROOT,
      some_future_field: 'whatever',
    });
    expect(read).toEqual({ kind: 'recorded', rootCommitSha: SHA1_ROOT });
  });
});

// ---------------------------------------------------------------------------
// Malformed — never a key, never a finding
// ---------------------------------------------------------------------------

describe('a malformed discriminator', () => {
  it('rejects a non-string', () => {
    expect(readRepositoryDiscriminator({ root_commit_sha: 42 })).toEqual({
      kind: 'malformed',
      problem: 'not_a_string',
    });
    expect(readRepositoryDiscriminator({ root_commit_sha: { sha: SHA1_ROOT } })).toEqual({
      kind: 'malformed',
      problem: 'not_a_string',
    });
  });

  it('rejects the empty string, which would otherwise merge every repository', () => {
    expect(readRepositoryDiscriminator({ root_commit_sha: '' })).toEqual({
      kind: 'malformed',
      problem: 'empty',
    });
  });

  it('rejects a repository PATH — the identifier this field exists to avoid', () => {
    // A filesystem path is arguably an identifier and certainly noisy. The shape
    // check is the one place it can be stopped before it reaches a staff UI.
    expect(readRepositoryDiscriminator({ root_commit_sha: '/Users/student/cs61b/proj2' })).toEqual({
      kind: 'malformed',
      problem: 'not_a_commit_sha',
    });
  });

  it('rejects a remote URL, which embeds the org and often the student username', () => {
    expect(
      readRepositoryDiscriminator({ root_commit_sha: 'git@github.com:jdoe/proj2.git' }),
    ).toEqual({ kind: 'malformed', problem: 'not_a_commit_sha' });
  });

  it('rejects an abbreviated sha, because it is not the same value as the full one', () => {
    expect(readRepositoryDiscriminator({ root_commit_sha: 'a'.repeat(7) })).toEqual({
      kind: 'malformed',
      problem: 'not_a_commit_sha',
    });
  });

  it('rejects an uppercase sha rather than folding case', () => {
    // Folding would be exactly the normalization that could merge two values a
    // reader must compare exactly. Rejecting costs only correlation, and the
    // observation still lands as unlabelled.
    expect(readRepositoryDiscriminator({ root_commit_sha: 'A'.repeat(40) })).toEqual({
      kind: 'malformed',
      problem: 'not_a_commit_sha',
    });
  });

  it('rejects a hex string of the wrong length', () => {
    for (const length of [39, 41, 63, 65]) {
      expect(readRepositoryDiscriminator({ root_commit_sha: 'a'.repeat(length) })).toEqual({
        kind: 'malformed',
        problem: 'not_a_commit_sha',
      });
    }
  });

  it('rejects a sha-shaped string containing non-hex characters', () => {
    expect(readRepositoryDiscriminator({ root_commit_sha: 'z'.repeat(40) })).toEqual({
      kind: 'malformed',
      problem: 'not_a_commit_sha',
    });
  });

  it('never reports malformed as a kind a caller could mistake for a repository', () => {
    const read = readRepositoryDiscriminator({ root_commit_sha: '../../etc/passwd' });
    expect(read.kind).toBe('malformed');
    expect(read).not.toHaveProperty('rootCommitSha');
  });
});

// ---------------------------------------------------------------------------
// Format compatibility — the bytes
// ---------------------------------------------------------------------------

describe('adding the field does not perturb a payload that lacks it', () => {
  const envelope = (data: GitEventPayload): Parameters<typeof chainEntry>[1] => ({
    seq: 0,
    t: 0,
    wall: '2026-01-01T00:00:00.000Z',
    kind: 'git.event',
    data,
  });

  it('canonicalizes and chains a 1.x payload exactly as before', () => {
    const legacy: GitEventPayload = { operation: 'state_change', commit_sha: SHA1_ROOT };
    expect(canonicalize(legacy)).toBe(`{"commit_sha":"${SHA1_ROOT}","operation":"state_change"}`);
    // Pinned: this is the permanent 1.x anchor and must never move.
    expect(chainEntry(GENESIS_PREV_HASH, envelope(legacy)).hash).toBe(
      chainEntry(GENESIS_PREV_HASH, envelope({ operation: 'state_change', commit_sha: SHA1_ROOT }))
        .hash,
    );
  });

  it('sorts the new key where JCS puts it, between parents and sha', () => {
    const payload: GitEventPayload = {
      operation: 'commit',
      sha: SHA1_ROOT,
      parents: [],
      branch: 'main',
      root_commit_sha: SHA1_ROOT,
    };
    expect(canonicalize(payload)).toBe(
      `{"branch":"main","operation":"commit","parents":[],` +
        `"root_commit_sha":"${SHA1_ROOT}","sha":"${SHA1_ROOT}"}`,
    );
  });

  it('makes an omitted field and a null field DIFFERENT bytes, so writers must omit', () => {
    const omitted = { operation: 'commit', sha: SHA1_ROOT };
    const nulled = { operation: 'commit', sha: SHA1_ROOT, root_commit_sha: null };
    expect(canonicalize(omitted)).not.toBe(canonicalize(nulled));
    expect(chainEntry(GENESIS_PREV_HASH, envelope(omitted)).hash).not.toBe(
      chainEntry(GENESIS_PREV_HASH, envelope(nulled as unknown as GitEventPayload)).hash,
    );
    // Both nonetheless READ as absent, which is what keeps a nonconforming
    // writer from becoming a false repository.
    expect(readRepositoryDiscriminator(omitted)).toEqual({ kind: 'absent' });
    expect(readRepositoryDiscriminator(nulled)).toEqual({ kind: 'absent' });
  });

  it('makes a labelled and an unlabelled payload different bytes', () => {
    const unlabelled = { operation: 'commit', sha: SHA1_ROOT };
    const labelled = { operation: 'commit', sha: SHA1_ROOT, root_commit_sha: SHA1_ROOT };
    expect(chainEntry(GENESIS_PREV_HASH, envelope(unlabelled)).hash).not.toBe(
      chainEntry(GENESIS_PREV_HASH, envelope(labelled)).hash,
    );
  });
});

// ---------------------------------------------------------------------------
// Protocol constraints
// ---------------------------------------------------------------------------

describe('protocol constraints', () => {
  it('names the field through the exported constant, so a rename cannot drift', () => {
    expect(REPOSITORY_DISCRIMINATOR_FIELD).toBe('root_commit_sha');
    const payload = { [REPOSITORY_DISCRIMINATOR_FIELD]: SHA1_ROOT };
    expect(readRepositoryDiscriminator(payload)).toEqual({
      kind: 'recorded',
      rootCommitSha: SHA1_ROOT,
    });
  });

  it('carries no author identity: the discriminator is a repository, not a person', () => {
    // A root-commit sha names a REPOSITORY. Nothing here reads, derives or
    // returns anything about who authored a commit, and nothing may be added.
    const read = readRepositoryDiscriminator({
      root_commit_sha: SHA1_ROOT,
      author_email: 'jdoe@berkeley.edu',
      author_name: 'J Doe',
    });
    expect(read).toEqual({ kind: 'recorded', rootCommitSha: SHA1_ROOT });
    expect(Object.keys(read).some((k) => k.toLowerCase().includes('author'))).toBe(false);
  });
});
