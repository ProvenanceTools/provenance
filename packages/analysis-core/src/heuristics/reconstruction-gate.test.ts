/**
 * Tier 2.2 — the reconstruction gate every content heuristic goes through.
 *
 * The policy under test is one sentence: a heuristic may not fire on content it
 * cannot establish. These tests exist because the failure mode is silent —
 * picking a branch produces a perfectly plausible-looking flag against a named
 * student, derived from a file that never existed — and because the
 * suppression must NOT extend to solo work, where it would quietly weaken every
 * shipped course.
 */

import { describe, expect, it } from 'vitest';
import type { HashedEnvelope } from '@provenance/log-core';
import type { SessionContributor } from '../identity/types.js';
import type { Bundle, ParsedSession } from '../loader/types.js';
import { buildIndex } from '../index/build-index.js';
import { pasteIsSolutionHeuristic } from './paste-is-solution.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import {
  establishedContent,
  establishedReplayState,
  establishedResult,
  reconstructionAmbiguityOf,
} from './reconstruction-gate.js';

const PATH = 'hw.py';
// No trailing newline: `lineCount` splits on '\n', so a trailing one adds an
// empty third line that diffLines does not count as shared, dropping the ratio
// to 0.67 and under the 0.8 threshold. The positive control below is what
// caught that — without it this suite would have "passed" on a fixture the
// heuristic never fires on.
const SOLUTION = 'def solve():\n    return 42';

function ev(
  seq: number,
  kind: string,
  data: Record<string, unknown>,
  wallBase: number,
): HashedEnvelope {
  return {
    seq,
    t: seq * 10,
    wall: new Date(Date.UTC(2026, 0, 1, wallBase, seq)).toISOString(),
    kind,
    data,
    prev_hash: '0'.repeat(64),
    hash: '1'.repeat(64),
  } as unknown as HashedEnvelope;
}

function attributed(sessionId: string, ref: string): SessionContributor {
  return {
    kind: 'attributed',
    sessionId,
    contributorKey: `attributed:2.0:course:c1:${ref}`,
    studentRef: ref,
    identityVersion: '2.0',
    scope: 'course',
    scopeId: 'c1',
    studentPubkey: 'pk',
    certWindow: { in_window: true },
    credentialWindow: { in_window: true },
  };
}

type Spec = { id: string; ref: string; wallBase: number; events: readonly HashedEnvelope[] };

function bundleOf(specs: readonly Spec[]): Bundle {
  const sessions: ParsedSession[] = specs.map((s) => ({
    sessionId: s.id,
    events: s.events,
    meta: {} as ParsedSession['meta'],
    slogSha256: 'a'.repeat(64),
    metaSha256: 'b'.repeat(64),
    firstEvent: s.events[0] as ParsedSession['firstEvent'],
  }));
  const bySession = new Map<string, SessionContributor>(
    specs.map((s) => [s.id, attributed(s.id, s.ref)]),
  );
  return {
    id: 'bundle-1',
    manifest: { format_version: '1.1' } as Bundle['manifest'],
    manifestSigHex: null,
    sessions,
    sourceFilename: 'b.zip',
    loadedAt: '2026-01-01T00:00:00.000Z',
    submissionFiles: new Map(),
    contributors: {
      bySession,
      contributors: [],
      rootKeyConfigured: true,
      counts: { attributed: specs.length, unverifiable: 0, unattributed: 0 },
    },
  };
}

/** A session that pastes the whole solution into `hw.py`. */
function pastingSession(id: string, ref: string, wallBase: number): Spec {
  return {
    id,
    ref,
    wallBase,
    events: [
      ev(
        0,
        'session.start',
        {
          format_version: '2.0',
          session_id: id,
          prev_session_id: null,
          assignment: { id: 'hw1', semester: 'fa26' },
        },
        wallBase,
      ),
      ev(1, 'doc.open', { path: PATH, content: '', sha256: '0'.repeat(64) }, wallBase),
      ev(
        2,
        'paste',
        {
          path: PATH,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          length: SOLUTION.length,
          sha256: '2'.repeat(64),
          content: SOLUTION,
        },
        wallBase,
      ),
      ev(3, 'doc.save', { path: PATH, sha256: '3'.repeat(64) }, wallBase),
    ],
  };
}

describe('the reconstruction gate', () => {
  const solo = () => {
    const bundle = bundleOf([pastingSession('s1', 'alice', 1)]);
    return { bundle, index: buildIndex(bundle) };
  };

  /**
   * Two verified contributors both pasting into one file, with nothing ordering
   * them — no session link, no commits. `≺` says concurrent, so there is no
   * established final content.
   */
  const concurrent = () => {
    const bundle = bundleOf([
      pastingSession('s-alice', 'alice', 1),
      pastingSession('s-bob', 'bob', 2),
    ]);
    return { bundle, index: buildIndex(bundle) };
  };

  it('hands back content for a solo bundle', () => {
    const { bundle, index } = solo();
    expect(establishedContent(index, bundle, PATH)).toBe(SOLUTION);
    expect(establishedResult(index, bundle, PATH)).not.toBeNull();
    expect(establishedReplayState(index, bundle, PATH)).not.toBeNull();
    expect(reconstructionAmbiguityOf(index, bundle, PATH)).toBeUndefined();
  });

  /**
   * The mutation this kills: returning `branches[0].value` here instead of
   * `null` would give every content heuristic a plausible string to reason
   * about, and every flag derived from it would be about a file that never
   * existed.
   */
  it('refuses to hand back content when two contributors are unordered', () => {
    const { bundle, index } = concurrent();
    expect(establishedContent(index, bundle, PATH)).toBeNull();
    expect(establishedResult(index, bundle, PATH)).toBeNull();
    expect(establishedReplayState(index, bundle, PATH)).toBeNull();
  });

  it('records WHICH kind of no-single-content it was', () => {
    const { bundle, index } = concurrent();
    // Not merely "absent" — `concurrent` and `unknown` are different facts and a
    // reader must be told which one they are looking at.
    expect(reconstructionAmbiguityOf(index, bundle, PATH)).toBe('concurrent');
  });
});

describe('paste_is_solution under concurrency', () => {
  /**
   * The most damning flag in the catalogue, high severity, 0.85 confidence. It
   * fires when a paste matches the file's final state — so it needs a final
   * state, and with two contributors' lineages unordered there is not one.
   */
  it('does not fire on a file two contributors edited on unordered branches', () => {
    const bundle = bundleOf([
      pastingSession('s-alice', 'alice', 1),
      pastingSession('s-bob', 'bob', 2),
    ]);
    const flags = pasteIsSolutionHeuristic.run(
      buildIndex(bundle),
      bundle,
      DEFAULT_HEURISTIC_CONFIG,
    );
    expect(flags).toHaveLength(0);
  });

  /**
   * The other half, and the one that matters more: the gate must not have
   * turned the heuristic off. The identical paste in a solo bundle still fires.
   */
  it('still fires on the identical paste in a solo bundle', () => {
    const bundle = bundleOf([pastingSession('s1', 'alice', 1)]);
    const flags = pasteIsSolutionHeuristic.run(
      buildIndex(bundle),
      bundle,
      DEFAULT_HEURISTIC_CONFIG,
    );
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]!.heuristic).toBe('paste_is_solution');
  });
});
