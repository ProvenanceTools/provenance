/**
 * Unit tests for the merged-in-content primitives.
 *
 * The states here are literal rather than reconstructed: these two functions are
 * pure counters over `provenance`, and building a bundle to produce four
 * characters would test `reconstructFile` instead of them. The heuristic-level
 * behaviour — that an honest `git pull` no longer produces a finding — is pinned
 * in each consuming heuristic's own test file, against real signed fixtures.
 */

import { describe, expect, it } from 'vitest';
import { charsWrittenAfter, mergedInCharCount } from './merged-in-content.js';
import type { FileReplayState } from '../index/reconstruct-file-provenance.js';

function stateOf(content: string, provenance: number[]): FileReplayState {
  return {
    content,
    provenance: Uint32Array.from(provenance),
    kindByGlobalIdx: new Map(),
    hashBySaveSeq: new Map(),
  };
}

// The file: two chars seeded by a doc.open at globalIdx 3, four chars delivered
// by an external change at 7, three chars typed at 11.
const state = stateOf('aabbbbccc', [3, 3, 7, 7, 7, 7, 11, 11, 11]);

describe('mergedInCharCount', () => {
  it('counts only characters written by an event in the merge set', () => {
    expect(mergedInCharCount(state, new Set([7]))).toBe(4);
  });

  it('is 0 for an empty merge set — the solo bundle path', () => {
    expect(mergedInCharCount(state, new Set())).toBe(0);
  });

  it('is 0 when the merge set names events that wrote nothing surviving', () => {
    expect(mergedInCharCount(state, new Set([5, 9]))).toBe(0);
  });
});

describe('charsWrittenAfter', () => {
  it('counts characters written after the cut, excluding merged-in ones', () => {
    expect(charsWrittenAfter(state, 3, new Set([7]))).toBe(3);
  });

  it('without a merge set, counts every character written after the cut', () => {
    expect(charsWrittenAfter(state, 3, new Set())).toBe(7);
  });

  it('excludes characters attributed to the cut event itself', () => {
    // doc.open seeds content attributed to the open's own globalIdx, and the
    // caller passes that globalIdx as the cut.
    expect(charsWrittenAfter(state, 11, new Set())).toBe(0);
  });
});
