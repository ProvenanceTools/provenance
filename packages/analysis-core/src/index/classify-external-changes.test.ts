/**
 * Tier 3.1 — external-change reclassification by content.
 *
 * The scenarios these tests exist for, in the census's words (§3 S2):
 *
 *  - a pull delivering a partner's recorded work must not produce a finding;
 *  - a pull delivering content nobody recorded must produce one;
 *  - a genuine out-of-editor paste must produce exactly the finding it did
 *    before;
 *  - a solo bundle must be byte-for-byte unaffected;
 *  - and anything the evidence cannot settle must say so rather than defaulting
 *    to the accusatory answer.
 */

import { describe, it, expect } from 'vitest';
import { sha256Hex } from '@provenance/log-core';
import {
  classifyExternalChanges,
  externalChangeClassificationFor,
  GIT_ADJACENCY_WINDOW_MS,
  type ExternalChangeClassification,
} from './classify-external-changes.js';
import { buildIndex } from './build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle, type EventSpec } from '../test-support/build-test-bundle.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
  type IdentityTestKeys,
} from '../test-support/build-identity.js';
import {
  buildTrustChainKeys,
  buildManifest2,
  sessionStart2,
} from '../test-support/build-manifest-2.js';
import { establishBundleContributors } from '../identity/resolve-contributors.js';
import { establishBundleTrust } from '../manifest/bundle-manifest.js';
import type { Bundle } from '../loader/types.js';
import type { EventIndex } from './event-index.js';

// ---------------------------------------------------------------------------
// Fixture vocabulary
// ---------------------------------------------------------------------------

const ALICE = '9c8e1a70-2f2b-4c55-8f1e-6b4a0d9c7e21';
const BOB = '3a1d0e55-8c44-4b2a-a7f0-11c9d2e3f4a5';

/** Deliberately full-length, distinct, and never abbreviated — the DAG compares exactly. */
const C0 = 'a'.repeat(40);
const C1 = 'b'.repeat(40);
const C2 = 'c'.repeat(40);

const FILE = 'hw1.py';
const PARTNER_WORK = 'def solve(n):\n    return n * 2\n';
const PARTNER_SHA = sha256Hex(PARTNER_WORK);
const NOBODY_RECORDED = 'def solve(n):\n    return magic(n)\n';
const NOBODY_SHA = sha256Hex(NOBODY_RECORDED);

let cachedKeys: IdentityTestKeys | null = null;
async function keys(): Promise<IdentityTestKeys> {
  cachedKeys ??= await buildIdentityKeys();
  return cachedKeys;
}

type Who = { studentRef: string } | 'anonymous';

type SessionSpec = { who: Who; events: EventSpec[] };

type BuildOpts = {
  /** Stamp contributors. Default true. */
  stamp?: boolean;
  /**
   * Mint a signed Manifest 2.0 carrying this `collaboration` and, unless
   * `trustManifest` is false, establish its trust chain.
   */
  collaboration?: 'solo' | 'group';
  /** Establish the manifest trust chain. Default true when `collaboration` is set. */
  trustManifest?: boolean;
};

type Fixture = { bundle: Bundle; index: EventIndex };

async function build(specs: SessionSpec[], opts: BuildOpts = {}): Promise<Fixture> {
  const k = await keys();

  let manifestStart: Record<string, unknown> = {};
  let trustKeys: Awaited<ReturnType<typeof buildTrustChainKeys>> | null = null;
  if (opts.collaboration !== undefined) {
    trustKeys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys: trustKeys,
      collaboration: opts.collaboration,
      filesUnderReview: [FILE],
    });
    manifestStart = sessionStart2(manifest);
  }

  const sessions = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const sk = await seededKeypair(0x60 + i);
    sessions.push({
      events: spec.events,
      sessionStart: {
        ...manifestStart,
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

  if (trustKeys !== null && opts.trustManifest !== false) {
    const chain = await establishBundleTrust(bundle, trustKeys.rootPubkeyHex);
    // If the fixture stops producing a verifiable chain, every collaboration-gate
    // assertion below would start passing for the wrong reason.
    expect(chain.kind).toBe('verified');
  }
  if (opts.stamp !== false) {
    await establishBundleContributors(bundle, k.root.pubkeyHex);
  }

  return { bundle, index: buildIndex(bundle) };
}

// --- event constructors ----------------------------------------------------

function gitEvent(sha: string, parents?: string[]): EventSpec {
  return {
    kind: 'git.event',
    data: {
      operation: 'state_change',
      sha,
      commit_sha: sha,
      branch: 'main',
      ...(parents === undefined ? {} : { parents }),
    },
  };
}

function docOpen(content: string): EventSpec {
  return {
    kind: 'doc.open',
    data: { path: FILE, content, sha256: sha256Hex(content), line_count: 2 },
  };
}

function docSave(content: string): EventSpec {
  return { kind: 'doc.save', data: { path: FILE, sha256: sha256Hex(content) } };
}

function externalChange(content: string, over?: Partial<EventSpec>): EventSpec {
  return {
    kind: 'fs.external_change',
    data: {
      path: FILE,
      operation: 'modify',
      old_hash: sha256Hex('stale\n'),
      new_hash: sha256Hex(content),
      new_content: content,
      diff_size: content.length,
    },
    ...over,
  };
}

/** The partner's session: they wrote the work, saved it, and committed it. */
function partnerSession(content: string, commit: string): EventSpec[] {
  return [docOpen(''), docSave(content), gitEvent(commit, [C0])];
}

/** The puller's session: HEAD moves, then the file changes underneath them. */
function pullerSession(newContent: string, opts?: { t?: number }): EventSpec[] {
  return [
    gitEvent(C0), // first observation — establishes HEAD, is NOT a move
    gitEvent(C1, [C0]), // the pull: HEAD moves
    externalChange(newContent, opts?.t === undefined ? {} : { t: opts.t }),
  ];
}

function only(c: ExternalChangeClassification) {
  const verdicts = [...c.byGlobalIdx.values()];
  expect(verdicts).toHaveLength(1);
  return verdicts[0]!;
}

// ---------------------------------------------------------------------------
// R3 — a solo bundle is byte-for-byte unaffected
// ---------------------------------------------------------------------------

describe('the collaboration gate (R3)', () => {
  it('does not run for a solo bundle — one contributor, no group manifest', async () => {
    const { bundle, index } = await build([
      { who: { studentRef: ALICE }, events: pullerSession(NOBODY_RECORDED) },
    ]);
    const c = classifyExternalChanges(bundle, index);
    expect(c.applicability).toBe('scope_not_collaborative');
    expect(c.byGlobalIdx.size).toBe(0);
    expect(c.gitMergeIn.size).toBe(0);
    expect(c.counts).toEqual({
      git_merge_in: 0,
      git_unrecorded_in: 0,
      external: 0,
      unclassified: 0,
    });
    expect(c.scope.twoDifferentContributors).toBe(false);
  });

  it('does not run for ONE contributor recording on two machines', async () => {
    // D5: two machines, one student_ref, one contributor. Not collaboration.
    const { bundle, index } = await build([
      { who: { studentRef: ALICE }, events: partnerSession(PARTNER_WORK, C1) },
      { who: { studentRef: ALICE }, events: pullerSession(PARTNER_WORK) },
    ]);
    expect(classifyExternalChanges(bundle, index).applicability).toBe('scope_not_collaborative');
  });

  it('does not run for an UNSTAMPED bundle, even with two real partners', async () => {
    // Forgetting to stamp must lose no findings: unstamped reads fully
    // unattributed, which yields no `'different'` pair and therefore the solo
    // path — today's exact behaviour.
    const { bundle, index } = await build(
      [
        { who: { studentRef: BOB }, events: partnerSession(PARTNER_WORK, C1) },
        { who: { studentRef: ALICE }, events: pullerSession(PARTNER_WORK) },
      ],
      { stamp: false },
    );
    expect(classifyExternalChanges(bundle, index).applicability).toBe('scope_not_collaborative');
  });

  it('runs when two provably different contributors are present', async () => {
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: partnerSession(PARTNER_WORK, C1) },
      { who: { studentRef: ALICE }, events: pullerSession(PARTNER_WORK) },
    ]);
    const c = classifyExternalChanges(bundle, index);
    expect(c.applicability).toBe('ran');
    expect(c.scope.twoDifferentContributors).toBe(true);
  });

  it('runs on a VERIFIED group manifest even with nobody attributed', async () => {
    const { bundle, index } = await build(
      [
        { who: 'anonymous', events: partnerSession(PARTNER_WORK, C1) },
        { who: 'anonymous', events: pullerSession(PARTNER_WORK) },
      ],
      { collaboration: 'group' },
    );
    const c = classifyExternalChanges(bundle, index);
    expect(c.applicability).toBe('ran');
    expect(c.scope.collaboration).toBe('group');
    expect(c.scope.twoDifferentContributors).toBe(false);
  });

  it('does NOT run on an UNVERIFIED group manifest — the gate must not be student-settable', async () => {
    const { bundle, index } = await build(
      [
        { who: 'anonymous', events: partnerSession(PARTNER_WORK, C1) },
        { who: 'anonymous', events: pullerSession(PARTNER_WORK) },
      ],
      { collaboration: 'group', trustManifest: false },
    );
    const c = classifyExternalChanges(bundle, index);
    expect(c.applicability).toBe('scope_not_collaborative');
    expect(c.scope.collaboration).toBeNull();
  });

  it('does NOT run on a verified SOLO manifest', async () => {
    const { bundle, index } = await build(
      [
        { who: 'anonymous', events: partnerSession(PARTNER_WORK, C1) },
        { who: 'anonymous', events: pullerSession(PARTNER_WORK) },
      ],
      { collaboration: 'solo' },
    );
    const c = classifyExternalChanges(bundle, index);
    expect(c.applicability).toBe('scope_not_collaborative');
    expect(c.scope.collaboration).toBe('solo');
  });
});

// ---------------------------------------------------------------------------
// The four classes
// ---------------------------------------------------------------------------

describe('git_merge_in — a pull delivering a partner’s recorded work', () => {
  async function pullOfPartnerWork() {
    return build([
      { who: { studentRef: BOB }, events: partnerSession(PARTNER_WORK, C1) },
      { who: { studentRef: ALICE }, events: pullerSession(PARTNER_WORK) },
    ]);
  }

  it('classifies it git_merge_in and names the matching session', async () => {
    const { bundle, index } = await pullOfPartnerWork();
    const v = only(classifyExternalChanges(bundle, index));
    expect(v.classification).toBe('git_merge_in');
    expect(v.reason).toBeNull();
    expect(v.path).toBe(FILE);
    expect(v.matches).toHaveLength(1);
    expect(v.matches[0]!.contributorComparison).toBe('different');
    expect(v.matches[0]!.kind).toBe('doc.save');
    expect(v.matches[0]!.studentRef).toBe(BOB);
    expect(v.detail).toContain('byte-identical');
  });

  it('corroborates it against the observed commit DAG', async () => {
    const { bundle, index } = await pullOfPartnerWork();
    // Bob observed C1; Alice's HEAD was at C1 when the file changed.
    expect(only(classifyExternalChanges(bundle, index)).dagCorroboration).toBe('same_commit');
  });

  it("reports 'ancestor' when the puller moved past the partner's commit", async () => {
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: partnerSession(PARTNER_WORK, C1) },
      {
        who: { studentRef: ALICE },
        events: [
          gitEvent(C0),
          gitEvent(C1, [C0]),
          gitEvent(C2, [C1]), // merged on top of the partner's commit
          externalChange(PARTNER_WORK),
        ],
      },
    ]);
    const v = only(classifyExternalChanges(bundle, index));
    expect(v.classification).toBe('git_merge_in');
    expect(v.dagCorroboration).toBe('ancestor');
  });

  it('matches a content-bearing doc.open as well as a doc.save', async () => {
    // A partner who merely OPENED the file recorded its on-disk sha, and that is
    // the same evidence: these bytes existed in their tree while recording.
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: [docOpen(PARTNER_WORK), gitEvent(C1, [C0])] },
      {
        who: { studentRef: ALICE },
        // Alice opens her own (older) copy first, so the file's replayed state
        // before the pull is hers and D1c's edit-derived rule does not claim the
        // event as the recorder reporting its own write.
        events: [gitEvent(C0), docOpen('start\n'), gitEvent(C1, [C0]), externalChange(PARTNER_WORK)],
      },
    ]);
    const v = only(classifyExternalChanges(bundle, index));
    expect(v.classification).toBe('git_merge_in');
    expect(v.matches[0]!.kind).toBe('doc.open');
  });

  it('R1 — the reclassified event is still in the index, and still counted', async () => {
    const { bundle, index } = await pullOfPartnerWork();
    const c = classifyExternalChanges(bundle, index);

    const inKind = index.byKind.get('fs.external_change') ?? [];
    expect(inKind).toHaveLength(1);
    const ev = inKind[0]!;

    // Present in every index structure a timeline / Source tab reads.
    expect(index.ordered.some((e) => e.globalIdx === ev.globalIdx)).toBe(true);
    expect(index.byFile.get(FILE)!.some((e) => e.globalIdx === ev.globalIdx)).toBe(true);
    expect(index.bySeq.get(`${ev.sessionId}:${ev.seq}`)).toBeDefined();
    expect(index.bySessionId.get(ev.sessionId)!.some((e) => e.globalIdx === ev.globalIdx)).toBe(
      true,
    );

    // And described, not deleted.
    expect(c.gitMergeIn.has(ev.globalIdx)).toBe(true);
    expect(c.byGlobalIdx.get(ev.globalIdx)).toBeDefined();
    expect(c.counts.git_merge_in).toBe(1);
  });
});

describe('git_unrecorded_in — a pull delivering content nobody recorded', () => {
  async function pullOfUnrecordedWork() {
    return build([
      { who: { studentRef: BOB }, events: partnerSession('something else\n', C1) },
      { who: { studentRef: ALICE }, events: pullerSession(NOBODY_RECORDED) },
    ]);
  }

  it('is surfaced as its own class, NOT folded into git_merge_in', async () => {
    const { bundle, index } = await pullOfUnrecordedWork();
    const c = classifyExternalChanges(bundle, index);
    const v = only(c);
    expect(v.classification).toBe('git_unrecorded_in');
    expect(v.matches).toHaveLength(0);
    expect(v.gitAdjacency).not.toBeNull();
    expect(v.gitAdjacency!.sha).toBe(C1);
    expect(v.gitAdjacency!.headMoved).toBe(true);
    expect(v.detail).toContain('no recorder observed');

    // The suppressing set is git_merge_in and nothing else.
    expect(c.gitMergeIn.size).toBe(0);
    expect(c.counts).toMatchObject({ git_merge_in: 0, git_unrecorded_in: 1 });
  });

  it('falls back to `external` when the HEAD move is outside the window', async () => {
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: partnerSession('something else\n', C1) },
      {
        who: { studentRef: ALICE },
        // t is milliseconds since THIS session's start; the git.event at seq 2
        // defaults to t = 2000.
        events: pullerSession(NOBODY_RECORDED, { t: 2000 + GIT_ADJACENCY_WINDOW_MS + 1 }),
      },
    ]);
    const v = only(classifyExternalChanges(bundle, index));
    expect(v.classification).toBe('external');
    // The adjacency is still reported — it just did not qualify.
    expect(v.gitAdjacency!.withinMs).toBe(GIT_ADJACENCY_WINDOW_MS + 1);
  });

  it('is not produced when HEAD never moved — a repeated sha is a status refresh, not a pull', async () => {
    // The recorder emits git.event on EVERY repository state change (S28).
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: partnerSession('something else\n', C1) },
      {
        who: { studentRef: ALICE },
        events: [gitEvent(C0), gitEvent(C0), externalChange(NOBODY_RECORDED)],
      },
    ]);
    const v = only(classifyExternalChanges(bundle, index));
    expect(v.classification).toBe('external');
    expect(v.gitAdjacency).toBeNull();
  });
});

describe('external — a genuine out-of-editor paste', () => {
  it('keeps today’s meaning when git was recorded and nothing is adjacent', async () => {
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: partnerSession('something else\n', C1) },
      {
        who: { studentRef: ALICE },
        events: [gitEvent(C0), docOpen('start\n'), externalChange(NOBODY_RECORDED)],
      },
    ]);
    const v = only(classifyExternalChanges(bundle, index));
    expect(v.classification).toBe('external');
    expect(v.reason).toBeNull();
    expect(v.matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R2 — "cannot classify" is never the accusatory answer
// ---------------------------------------------------------------------------

describe('unclassified (R2)', () => {
  it('no git.event anywhere in the session → no_git_observations, not external', async () => {
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: [docOpen(''), docSave('something else\n')] },
      { who: { studentRef: ALICE }, events: [docOpen('start\n'), externalChange(NOBODY_RECORDED)] },
    ]);
    const v = only(classifyExternalChanges(bundle, index));
    expect(v.classification).toBe('unclassified');
    expect(v.reason).toEqual({ kind: 'no_git_observations' });
    expect(v.detail).toContain('unobservable');
  });

  it('an UNATTRIBUTED partner’s matching content → not_attributable, not external', async () => {
    const { bundle, index } = await build(
      [
        { who: 'anonymous', events: partnerSession(PARTNER_WORK, C1) },
        { who: 'anonymous', events: pullerSession(PARTNER_WORK) },
      ],
      { collaboration: 'group' },
    );
    const c = classifyExternalChanges(bundle, index);
    const v = only(c);
    expect(v.classification).toBe('unclassified');
    expect(v.reason).toEqual({ kind: 'content_match_not_attributable' });
    // The match is reported — a grader must see the bytes exist elsewhere.
    expect(v.matches).toHaveLength(1);
    expect(v.matches[0]!.contributorComparison).toBe('unknown');
    // ...but no person is named on unproven evidence (spec §6 Rule 2).
    expect(v.matches[0]!.studentRef).toBeNull();
    // And it is NOT suppressed.
    expect(c.gitMergeIn.size).toBe(0);
  });

  it("the SAME contributor's other session is not a partner → not_attributable", async () => {
    // Alice on machine 1 saved these bytes; Alice on machine 2 pulls them. Real,
    // and not evidence of collaboration — so it is reported, not set aside.
    const { bundle, index } = await build(
      [
        { who: { studentRef: ALICE }, events: partnerSession(PARTNER_WORK, C1) },
        { who: { studentRef: ALICE }, events: pullerSession(PARTNER_WORK) },
        // A third, different contributor makes the scope collaborative without
        // touching the file, so the gate opens and the classification is the
        // thing under test.
        { who: { studentRef: BOB }, events: [gitEvent(C2, [C1])] },
      ],
      {},
    );
    const v = only(classifyExternalChanges(bundle, index));
    expect(v.classification).toBe('unclassified');
    expect(v.reason).toEqual({ kind: 'content_match_not_attributable' });
    expect(v.matches[0]!.contributorComparison).toBe('same');
  });

  it("a partner's content with no HEAD move → content_match_without_git_operation", async () => {
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: partnerSession(PARTNER_WORK, C1) },
      {
        who: { studentRef: ALICE },
        events: [gitEvent(C0), gitEvent(C0), externalChange(PARTNER_WORK)],
      },
    ]);
    const c = classifyExternalChanges(bundle, index);
    const v = only(c);
    expect(v.classification).toBe('unclassified');
    expect(v.reason).toEqual({ kind: 'content_match_without_git_operation' });
    expect(v.matches[0]!.contributorComparison).toBe('different');
    expect(c.gitMergeIn.size).toBe(0);
  });

  it('a delete carries no post-change hash → no_post_change_hash', async () => {
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: partnerSession(PARTNER_WORK, C1) },
      {
        who: { studentRef: ALICE },
        events: [
          gitEvent(C0),
          gitEvent(C1, [C0]),
          {
            kind: 'fs.external_change',
            data: {
              path: FILE,
              operation: 'delete',
              old_hash: PARTNER_SHA,
              new_hash: '',
              diff_size: -PARTNER_WORK.length,
            },
          },
        ],
      },
    ]);
    const v = only(classifyExternalChanges(bundle, index));
    expect(v.classification).toBe('unclassified');
    expect(v.reason).toEqual({ kind: 'no_post_change_hash' });
  });
});

// ---------------------------------------------------------------------------
// The laundering guard
// ---------------------------------------------------------------------------

describe('what may not be a match source', () => {
  it("another session's fs.external_change is NOT a match source", async () => {
    // Bob's tree received these bytes from nowhere too. If one unrecorded
    // external write could explain another, a student could paste content in
    // once with no recording and have every later arrival explain itself.
    const { bundle, index } = await build([
      {
        who: { studentRef: BOB },
        events: [gitEvent(C0), gitEvent(C1, [C0]), externalChange(NOBODY_RECORDED)],
      },
      { who: { studentRef: ALICE }, events: pullerSession(NOBODY_RECORDED) },
    ]);
    const c = classifyExternalChanges(bundle, index);
    expect(c.gitMergeIn.size).toBe(0);
    for (const v of c.byGlobalIdx.values()) {
      expect(v.classification).toBe('git_unrecorded_in');
      expect(v.matches).toHaveLength(0);
    }
  });

  it('a match on a DIFFERENT path does not explain this one', async () => {
    const { bundle, index } = await build([
      {
        who: { studentRef: BOB },
        events: [
          { kind: 'doc.open', data: { path: 'other.py', content: '', sha256: sha256Hex('') } },
          { kind: 'doc.save', data: { path: 'other.py', sha256: PARTNER_SHA } },
          gitEvent(C1, [C0]),
        ],
      },
      { who: { studentRef: ALICE }, events: pullerSession(PARTNER_WORK) },
    ]);
    const v = only(classifyExternalChanges(bundle, index));
    expect(v.classification).toBe('git_unrecorded_in');
    expect(v.matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism, memoization, and the recorder tag
// ---------------------------------------------------------------------------

describe('properties', () => {
  it('is deterministic — the ingest-retry contract', async () => {
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: partnerSession(PARTNER_WORK, C1) },
      { who: { studentRef: ALICE }, events: pullerSession(PARTNER_WORK) },
    ]);
    const a = classifyExternalChanges(bundle, index);
    const b = classifyExternalChanges(bundle, index);
    expect(JSON.stringify([...b.byGlobalIdx])).toBe(JSON.stringify([...a.byGlobalIdx]));
  });

  it('memoizes per index', async () => {
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: partnerSession(PARTNER_WORK, C1) },
      { who: { studentRef: ALICE }, events: pullerSession(PARTNER_WORK) },
    ]);
    expect(externalChangeClassificationFor(bundle, index)).toBe(
      externalChangeClassificationFor(bundle, index),
    );
  });

  it('records the recorder tag without letting it decide anything', async () => {
    // The tagger said "git" and the content says nobody recorded these bytes.
    // The content wins; the tag is reported as corroboration only.
    const { bundle, index } = await build([
      { who: { studentRef: BOB }, events: partnerSession('something else\n', C1) },
      {
        who: { studentRef: ALICE },
        events: [
          gitEvent(C0),
          gitEvent(C1, [C0]),
          externalChange(NOBODY_RECORDED, {
            data: {
              path: FILE,
              operation: 'modify',
              old_hash: sha256Hex('stale\n'),
              new_hash: NOBODY_SHA,
              new_content: NOBODY_RECORDED,
              diff_size: NOBODY_RECORDED.length,
              explanation: 'git',
            },
          }),
        ],
      },
    ]);
    const v = only(classifyExternalChanges(bundle, index));
    expect(v.recorderExplanation).toBe('git');
    expect(v.classification).toBe('git_unrecorded_in');
  });
});
