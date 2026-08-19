/**
 * Tests for the inter_session_external_change heuristic.
 */

import { describe, it, expect } from 'vitest';
import { interSessionExternalChangeHeuristic } from './inter-session-external-change.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import type { EventSpec } from '../test-support/build-test-bundle.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
} from '../test-support/build-identity.js';
import type { IdentityTestKeys } from '../test-support/build-identity.js';
import { establishBundleContributors } from '../identity/resolve-contributors.js';

const cfg = DEFAULT_HEURISTIC_CONFIG;

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

// Convenience: build a session that opens `file` at `content`, types one
// `appended` chunk at the end, then saves.
function sessionThat(file: string, openContent: string, appended: string): EventSpec[] {
  return [
    { kind: 'doc.open', data: { path: file, content: openContent } },
    {
      kind: 'doc.change',
      data: {
        path: file,
        source: 'typed',
        deltas: [
          {
            range: {
              start: { line: 0, character: openContent.length },
              end: { line: 0, character: openContent.length },
            },
            text: appended,
          },
        ],
      },
    },
    { kind: 'doc.save', data: { path: file, sha256: 'unused-in-this-test' } },
  ];
}

describe('inter_session_external_change', () => {
  it('emits no flags for a single-session bundle', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [{ events: sessionThat('hw1.py', '', 'def foo():\n    return 1\n') }],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('emits no flags when the file is unchanged across the gap', async () => {
    const finalA = 'def foo():\n    return 1\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', 'def foo():\n    return 1\n') },
        { events: sessionThat('hw1.py', finalA, '    # comment\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('flags a file that diverged between sessions', async () => {
    const finalA = 'def foo():\n    return 1\n';
    // Simulated external edit: someone added a print between sessions.
    const externallyEdited = finalA + 'print("oops")\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', finalA) },
        { events: sessionThat('hw1.py', externallyEdited, '\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);

    const f = flags[0]!;
    expect(f.heuristic).toBe('inter_session_external_change');
    expect(f.title).toContain('hw1.py');
    // |26 - 38| = 12, below default highSeverityCharsChanged (100) → medium.
    expect(f.severity).toBe('medium');
    expect(f.confidence).toBeCloseTo(0.85);
    expect(f.supportingSeqs).toHaveLength(1);
    const detail = f.detail as Record<string, unknown>;
    expect(detail['file']).toBe('hw1.py');
    expect(detail['prev_length']).toBe(finalA.length);
    expect(detail['next_length']).toBe(externallyEdited.length);
  });

  it('marks divergence above the threshold as high severity', async () => {
    const finalA = 'x = 1\n';
    // Massive divergence.
    const externallyEdited = finalA + 'y = 2\n'.repeat(40); // 240 chars added
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', finalA) },
        { events: sessionThat('hw1.py', externallyEdited, '\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
  });

  it('does not flag files that the prior session never touched', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', 'a = 1\n') },
        // Session 2 opens a different file. We have no prior reconstruction
        // for utils.py from session 1, so we skip.
        { events: sessionThat('utils.py', 'def helper():\n    pass\n', '\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('does not flag when the second session uses pre-v1.1 doc.open without content', async () => {
    const finalA = 'def foo():\n    return 1\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', finalA) },
        {
          events: [
            // No content field → pre-v1.1 recorder. Cannot detect divergence.
            { kind: 'doc.open', data: { path: 'hw1.py' } },
            { kind: 'doc.save', data: { path: 'hw1.py', sha256: 'unused' } },
          ],
        },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Contributor scoping (Tier 3.3)
//
// This heuristic can only support "the file changed while MY recorder was off".
// Across two partners it was reporting a difference that is guaranteed by
// construction — different person, different machine, different working tree —
// at confidence 0.85, on every partner commit. Suppression is permitted ONLY
// where both sides resolve to verified, distinct contributors.
// ---------------------------------------------------------------------------

describe('inter_session_external_change — contributor scoping', () => {
  const ALICE = '9c8e1a70-2f2b-4c55-8f1e-6b4a0d9c7e21';
  const BOB = '3a1d0e55-8c44-4b2a-a7f0-11c9d2e3f4a5';

  let cachedKeys: IdentityTestKeys | null = null;
  async function keys(): Promise<IdentityTestKeys> {
    cachedKeys ??= await buildIdentityKeys();
    return cachedKeys;
  }

  type Who = { studentRef: string } | 'anonymous';

  /**
   * Build a bundle from a list of (contributor, events) sessions and stamp it.
   * `stamp: false` leaves the bundle unstamped, which is how a caller that
   * forgot to establish contributors sees the world.
   */
  async function buildAttributed(
    specs: Array<{ who: Who; events: EventSpec[] }>,
    opts?: { stamp?: boolean },
  ) {
    const k = await keys();
    const sessions = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const sk = await seededKeypair(0x60 + i);
      sessions.push({
        events: spec.events,
        sessionStart: {
          session_pubkey: sk.pubkeyHex,
          ...(spec.who === 'anonymous'
            ? {}
            : {
                identity: await buildInstitutionIdentity({
                  keys: k,
                  sessionPubkeyHex: sk.pubkeyHex,
                  studentRef: spec.who.studentRef,
                }),
              }),
        },
      });
    }
    const { zipBuffer } = await buildTestBundle({ sessions });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
    const bundle = result.value;
    const resolved =
      opts?.stamp === false ? null : await establishBundleContributors(bundle, k.root.pubkeyHex);
    return { index: buildIndex(bundle), bundle, resolved };
  }

  // Alice ends her session with this; the partner's commit then lands on top.
  const ALICE_FINAL = 'def foo():\n    return 1\n';
  const AFTER_PARTNER_COMMIT = ALICE_FINAL + 'def bar():\n    return 2\n';

  it("does NOT flag a partner's commit landing between contributor A's sessions", async () => {
    // Wall order: Alice, Bob (who commits his own work), Alice again. Both
    // consecutive pairs cross contributors, so neither is a claim about Alice.
    const { index, bundle, resolved } = await buildAttributed([
      { who: { studentRef: ALICE }, events: sessionThat('hw1.py', '', ALICE_FINAL) },
      {
        who: { studentRef: BOB },
        events: sessionThat('hw1.py', AFTER_PARTNER_COMMIT, 'x = 3\n'),
      },
      {
        who: { studentRef: ALICE },
        events: sessionThat('hw1.py', AFTER_PARTNER_COMMIT + 'x = 3\n', '\n'),
      },
    ]);
    expect(resolved!.counts).toEqual({ attributed: 3, unverifiable: 0, unattributed: 0 });

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('does NOT flag a straight two-partner handoff', async () => {
    const { index, bundle, resolved } = await buildAttributed([
      { who: { studentRef: ALICE }, events: sessionThat('hw1.py', '', ALICE_FINAL) },
      { who: { studentRef: BOB }, events: sessionThat('hw1.py', AFTER_PARTNER_COMMIT, '\n') },
    ]);
    expect(resolved!.counts).toEqual({ attributed: 2, unverifiable: 0, unattributed: 0 });

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it("STILL flags divergence between one contributor's own consecutive sessions", async () => {
    // The real signal: Alice's file changed under an editor that was not
    // recording, between two of HER sessions.
    const { index, bundle, resolved } = await buildAttributed([
      { who: { studentRef: ALICE }, events: sessionThat('hw1.py', '', ALICE_FINAL) },
      {
        who: { studentRef: ALICE },
        events: sessionThat('hw1.py', ALICE_FINAL + 'print("oops")\n', '\n'),
      },
    ]);
    expect(resolved!.contributors).toHaveLength(1);

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    const f = flags[0]!;
    expect(f.severity).toBe('medium');
    expect(f.confidence).toBeCloseTo(0.85);
    expect(f.detail!['contributor_comparison']).toBe('same');
    expect(f.description).toContain('same verified contributor');
  });

  it('STILL flags when one side is unattributed', async () => {
    const { index, bundle, resolved } = await buildAttributed([
      { who: { studentRef: ALICE }, events: sessionThat('hw1.py', '', ALICE_FINAL) },
      { who: 'anonymous', events: sessionThat('hw1.py', ALICE_FINAL + 'print("x")\n', '\n') },
    ]);
    expect(resolved!.counts).toEqual({ attributed: 1, unverifiable: 0, unattributed: 1 });

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributor_comparison']).toBe('unknown');
  });

  it('STILL flags when BOTH sides are unattributed — singleton keys must not read as "different people"', async () => {
    const { index, bundle, resolved } = await buildAttributed([
      { who: 'anonymous', events: sessionThat('hw1.py', '', ALICE_FINAL) },
      { who: 'anonymous', events: sessionThat('hw1.py', ALICE_FINAL + 'print("x")\n', '\n') },
    ]);
    // Distinct singleton keys — a direct key compare would suppress here.
    expect(resolved!.contributors).toHaveLength(2);
    expect(resolved!.contributors[0]!.key).not.toBe(resolved!.contributors[1]!.key);

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributor_comparison']).toBe('unknown');
  });

  it('an UNSTAMPED bundle behaves exactly as it did before Tier 3.3', async () => {
    // Two DIFFERENT verified partners — but nobody stamped the bundle, so every
    // session reads unattributed and the pre-3.3 comparison is preserved. A
    // caller that forgets to stamp must lose no findings.
    const { index, bundle } = await buildAttributed(
      [
        { who: { studentRef: ALICE }, events: sessionThat('hw1.py', '', ALICE_FINAL) },
        { who: { studentRef: BOB }, events: sessionThat('hw1.py', AFTER_PARTNER_COMMIT, '\n') },
      ],
      { stamp: false },
    );
    expect(bundle.contributors).toBeUndefined();

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributor_comparison']).toBe('unknown');
  });
});
