/**
 * Peer-witness reconciliation (spec §5.5, Tier 4.3).
 *
 * ## What these tests are protecting
 *
 * Every verdict here sits next to a wrongful-accusation failure mode, and each
 * of the four collapses below has a test written specifically to catch it:
 *
 *  - `absent` folded into a finding — accuses a partner who simply has not
 *    pushed yet, which is the exact reading `no_session_log` was reworded to
 *    stop making;
 *  - `unwitnessed` folded into `absent` — turns "no recorder emitted a witness"
 *    (i.e. every bundle in existence) into a gap in the record;
 *  - a witness in an `unverifiable` session treated as authoritative — lets an
 *    artifact that cannot back its own identity testify about someone else's;
 *  - a missing witness read as suspicious — makes not being watched into
 *    evidence.
 *
 * ## The prefix trap
 *
 * A witness's `sha256` is over the bytes at observation time. The witnessed log
 * keeps growing, so digest inequality is the NORMAL case. A test below drives
 * exactly that shape and requires `corroborated`, because comparing digests
 * instead of chain positions is what produced decision-log bugs 5, 10 and 12.
 */

import { describe, it, expect } from 'vitest';
import { sha256Hex } from '@provenance/log-core';
import type { PeerObservedPayload } from '@provenance/log-core';
import {
  reconcileWitnesses,
  witnessEvidenceGrade,
  isWitnessAlterationEvidence,
} from './reconcile-witnesses.js';
import type { BundleWitnessReconciliation } from './reconcile-witnesses.js';
import { buildCollabScope, COLLAB_ALICE, COLLAB_BOB } from '../test-support/build-collab-scope.js';
import type { CollabWho } from '../test-support/build-collab-scope.js';
import type { EventSpec } from '../test-support/build-test-bundle.js';
import { buildIdentityKeys, seededKeypair } from '../test-support/build-identity.js';
import { establishBundleContributors } from '../identity/resolve-contributors.js';
import type { Bundle } from '../loader/types.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { loadBundle } from '../loader/parse-bundle.js';

const ALICE: CollabWho = { studentRef: COLLAB_ALICE };
const BOB: CollabWho = { studentRef: COLLAB_BOB };

/** Ordinary work events, enough to give a chain a few seqs. */
function work(n: number): EventSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'doc.change',
    data: {
      path: 'hw1.py',
      deltas: [{ range: null, text: `line${String(i)}\n` }],
      source: 'keystroke',
    },
  }));
}

function peerObserved(payload: PeerObservedPayload): EventSpec {
  return { kind: 'peer.observed', data: { ...payload } };
}

/** A well-formed witness of `facts`, with per-test overrides. */
function witnessOf(
  facts: { sessionId: string; seqHigh: number; lastHash: string },
  overrides: Partial<PeerObservedPayload> = {},
): PeerObservedPayload {
  return {
    file: 'session-0badf00d-0000-4000-8000-00000000beef.slog',
    // Deliberately NOT the archived file's digest. A witness sees a prefix.
    sha256: sha256Hex('bytes as seen at observation time'),
    bytes: 2048,
    session_id: facts.sessionId,
    seq_high: facts.seqHigh,
    last_hash: facts.lastHash,
    state: 'appeared',
    ...overrides,
  };
}

/** What a witnessing recorder would have read out of a session's log. */
function factsOf(bundle: Bundle, index: number) {
  const session = bundle.sessions[index]!;
  const last = session.events[session.events.length - 1]!;
  return { sessionId: session.sessionId, seqHigh: last.seq, lastHash: last.hash };
}

/**
 * Two passes: build the witnessed session first to learn its real chain tip,
 * then rebuild with a witness that names it. Session ids, keys and walls are all
 * keyed on session INDEX, so the witnessed session is reproduced exactly in the
 * second pass as long as it keeps its index.
 */
async function scopeWitnessing(opts: {
  witnessedWho: CollabWho;
  witnessWho: CollabWho;
  witnessedEvents?: EventSpec[];
  /** Rewrite the witness payload once the real facts are known. */
  distort?: (facts: { sessionId: string; seqHigh: number; lastHash: string }) => PeerObservedPayload;
  /** Drop the witnessed session from the second pass entirely. */
  omitWitnessed?: boolean;
  /** Re-stamp contributors against a root key that signs nothing here. */
  wrongRootKey?: boolean;
}): Promise<{ bundle: Bundle; facts: ReturnType<typeof factsOf> }> {
  const witnessedEvents = opts.witnessedEvents ?? work(4);

  // `buildTestBundle` derives a session's id from its INDEX, so the probe puts
  // the witnessed session at the index it will occupy in the final bundle. For
  // the `absent` case it goes one index PAST the end, which is what makes the
  // witnessed id genuinely missing rather than merely holding different events.
  const witnessedIndex = opts.omitWitnessed ? 2 : 0;
  const probeSpecs = Array.from({ length: witnessedIndex + 1 }, (_, i) => ({
    who: opts.witnessedWho,
    events: i === witnessedIndex ? witnessedEvents : work(1),
  }));
  const probe = await buildCollabScope(probeSpecs);
  const facts = factsOf(probe.bundle, witnessedIndex);

  const payload = opts.distort ? opts.distort(facts) : witnessOf(facts);
  const witnessSession = { who: opts.witnessWho, events: [...work(2), peerObserved(payload)] };

  const specs = opts.omitWitnessed
    ? // Two sessions, so index 2 — the id the witness names — is off the end.
      [{ who: opts.witnessedWho, events: work(1) }, witnessSession]
    : [{ who: opts.witnessedWho, events: witnessedEvents }, witnessSession];

  const built = await buildCollabScope(specs, { stamp: !opts.wrongRootKey });
  if (opts.wrongRootKey) {
    const stranger = await seededKeypair(0x9e);
    await establishBundleContributors(built.bundle, stranger.pubkeyHex);
  }

  if (opts.omitWitnessed) {
    // Load-bearing: if the witnessed id were present after all, the `absent`
    // tests would be asserting something else entirely.
    expect(built.bundle.sessions.map((s) => s.sessionId)).not.toContain(facts.sessionId);
  }
  return { bundle: built.bundle, facts };
}

function only(result: BundleWitnessReconciliation) {
  expect(result.witnesses).toHaveLength(1);
  return result.witnesses[0]!;
}

// ---------------------------------------------------------------------------
// The five verdicts
// ---------------------------------------------------------------------------

describe('the five verdicts are kept distinct', () => {
  it('corroborated — the present log reaches the witnessed seq with the witnessed hash', async () => {
    const { bundle } = await scopeWitnessing({ witnessedWho: BOB, witnessWho: ALICE });
    const r = only(reconcileWitnesses(bundle));

    expect(r.verdict).toBe('corroborated');
    expect(r.presentHashAtWitnessedSeq).toBe(r.witness.payload.last_hash);
    expect(isWitnessAlterationEvidence(r)).toBe(false);
  });

  it('corroborated even though the witnessed sha256 does not match the archived bytes', async () => {
    // THE PREFIX TRAP. A witness records the digest of the bytes it saw; the
    // partner keeps recording, so the committed file is longer and hashes
    // differently. Inequality here is the NORMAL case. An implementation that
    // compares digests reports every honest pair as tampered — the shape of
    // decision-log bugs 5, 10 and 12.
    const { bundle } = await scopeWitnessing({ witnessedWho: BOB, witnessWho: ALICE });
    const r = only(reconcileWitnesses(bundle));

    expect(r.witness.payload.sha256).not.toBe(bundle.sessions[0]!.slogSha256);
    expect(r.verdict).toBe('corroborated');
  });

  it('absent — witnessed, and no log for that session is in the bundle', async () => {
    const { bundle, facts } = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      omitWitnessed: true,
    });
    const r = only(reconcileWitnesses(bundle));

    expect(r.verdict).toBe('absent');
    expect(r.matchedSessionId).toBeNull();
    expect(r.witness.payload.session_id).toBe(facts.sessionId);
  });

  it('short — the present log stops before the witnessed seq', async () => {
    const { bundle } = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      distort: (f) => witnessOf(f, { seq_high: f.seqHigh + 5 }),
    });
    const r = only(reconcileWitnesses(bundle));

    expect(r.verdict).toBe('short');
    expect(r.presentSeqHigh).toBeLessThan(r.witness.payload.seq_high!);
    expect(r.presentHashAtWitnessedSeq).toBeNull();
  });

  it('tip mismatch — present, reaches the witnessed seq, different hash', async () => {
    const { bundle } = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      distort: (f) => witnessOf(f, { last_hash: 'f'.repeat(64) }),
    });
    const r = only(reconcileWitnesses(bundle));

    expect(r.verdict).toBe('tip_mismatch');
    expect(r.presentHashAtWitnessedSeq).not.toBe(r.witness.payload.last_hash);
  });

  it('indeterminate — the witness read no chain out of the file', async () => {
    const { bundle } = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      distort: (f) =>
        witnessOf(f, {
          session_id: null,
          seq_high: null,
          last_hash: null,
          state: 'unparseable',
        }),
    });
    const r = only(reconcileWitnesses(bundle));

    // NOT `absent`. "No log is here" and "we could not look" are different
    // claims, and only one of them is about the bundle.
    expect(r.verdict).toBe('indeterminate');
    expect(isWitnessAlterationEvidence(r)).toBe(false);
  });

  it('a short verdict and an absent verdict are never the same value', async () => {
    const shortScope = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      distort: (f) => witnessOf(f, { seq_high: f.seqHigh + 5 }),
    });
    const absentScope = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      omitWitnessed: true,
    });
    expect(only(reconcileWitnesses(shortScope.bundle)).verdict).not.toBe(
      only(reconcileWitnesses(absentScope.bundle)).verdict,
    );
  });
});

// ---------------------------------------------------------------------------
// absent is never, on its own, a finding
// ---------------------------------------------------------------------------

describe('absent is context, not evidence', () => {
  it('does not pass the alteration gate even from an attributed witness', async () => {
    // The innocent case this protects: a partner committed their rolling seal
    // before their `.slog` landed, or a `.gitignore` caught it. That archive is
    // byte-identical to a deletion, so `absent` cannot be evidence of one.
    const { bundle } = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      omitWitnessed: true,
    });
    const r = only(reconcileWitnesses(bundle));

    expect(r.witness.authority).toBe('attributed');
    expect(witnessEvidenceGrade(r.witness.authority)).toBe('established');
    expect(r.verdict).toBe('absent');
    expect(isWitnessAlterationEvidence(r)).toBe(false);
  });

  it('states what is established and names the innocent reading', async () => {
    const { bundle } = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      omitWitnessed: true,
    });
    const detail = only(reconcileWitnesses(bundle)).detail;

    // Bug 13's lesson, applied before the accusation can be written: separate
    // what is established from which reading applies.
    expect(detail).toContain('NOT established as a deletion');
    expect(detail).toContain('had not yet pushed');
  });
});

// ---------------------------------------------------------------------------
// unwitnessed is the ordinary case
// ---------------------------------------------------------------------------

describe('a bundle with no witnesses at all is entirely blameless', () => {
  it('produces no verdicts, and every session reads unwitnessed', async () => {
    // Every bundle recorded to date. No recorder emits `peer.observed`.
    const { bundle } = await buildCollabScope([
      { who: ALICE, events: work(3) },
      { who: BOB, events: work(3) },
    ]);
    const result = reconcileWitnesses(bundle);

    expect(result.witnesses).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.malformed).toEqual([]);
    expect(result.sessions.map((s) => s.state)).toEqual(['unwitnessed', 'unwitnessed']);
    expect(result.counts.unwitnessedSessions).toBe(2);
    expect(result.counts.absent).toBe(0);
  });

  it('never converts an unwitnessed session into an absent verdict', async () => {
    // The collapse this forbids: `unwitnessed` is about a log that IS here and
    // that nobody watched; `absent` is about a log that is NOT here. Folding
    // them makes "the partner was not recording" into a gap in the record.
    const { bundle } = await buildCollabScope([{ who: ALICE, events: work(3) }]);
    const result = reconcileWitnesses(bundle);

    expect(result.counts.absent).toBe(0);
    expect(result.counts.unwitnessedSessions).toBe(1);
    expect(result.witnesses).toHaveLength(0);
  });

  it('leaves the witnessed session unwitnessed when the witness is excluded', async () => {
    // An excluded witness is not a witness. Counting it would make a circular
    // self-observation look like independent coverage.
    const probe = await buildCollabScope([{ who: ALICE, events: work(3) }]);
    const facts = factsOf(probe.bundle, 0);
    const { bundle } = await buildCollabScope([
      { who: ALICE, events: [...work(3), peerObserved(witnessOf(facts))] },
    ]);
    const result = reconcileWitnesses(bundle);

    expect(result.excluded).toHaveLength(1);
    expect(result.sessions[0]!.state).toBe('unwitnessed');
    expect(result.sessions[0]!.witnessCount).toBe(0);
  });

  it('a session that IS witnessed is marked witnessed', async () => {
    const { bundle } = await scopeWitnessing({ witnessedWho: BOB, witnessWho: ALICE });
    const result = reconcileWitnesses(bundle);

    const witnessed = result.sessions.find((s) => s.sessionId === bundle.sessions[0]!.sessionId)!;
    expect(witnessed.state).toBe('witnessed');
    expect(witnessed.witnessCount).toBe(1);
    // The WITNESSING session is itself unwitnessed, and that is fine.
    expect(result.counts.unwitnessedSessions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Trustworthiness follows the witnessing session's identity
// ---------------------------------------------------------------------------

describe('a witness is only as good as the chain it sits in', () => {
  it('grades an attributed witness established, and lets it be evidence', async () => {
    const { bundle } = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      distort: (f) => witnessOf(f, { last_hash: 'f'.repeat(64) }),
    });
    const r = only(reconcileWitnesses(bundle));

    expect(r.witness.authority).toBe('attributed');
    expect(witnessEvidenceGrade(r.witness.authority)).toBe('established');
    expect(isWitnessAlterationEvidence(r)).toBe(true);
  });

  it('grades an unattributed witness inferred — real evidence, unnamed', async () => {
    // The majority case today: a student who never enrolled. Their chain still
    // verifies, so discarding their observation would throw away honest
    // evidence; we simply cannot say whose observation it is.
    const { bundle } = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: 'anonymous',
      distort: (f) => witnessOf(f, { last_hash: 'f'.repeat(64) }),
    });
    const r = only(reconcileWitnesses(bundle));

    expect(r.witness.authority).toBe('unattributed');
    expect(witnessEvidenceGrade(r.witness.authority)).toBe('inferred');
    expect(isWitnessAlterationEvidence(r)).toBe(true);
  });

  it('a witness inside an unverifiable session is NOT authoritative', async () => {
    // THE ASYMMETRY. Same bundle, same verdict, different weight: an artifact
    // asserting an identity it cannot back does not get to testify about
    // someone else's log.
    const { bundle } = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      distort: (f) => witnessOf(f, { last_hash: 'f'.repeat(64) }),
      wrongRootKey: true,
    });
    const r = only(reconcileWitnesses(bundle));

    expect(r.witness.authority).toBe('unverifiable');
    expect(witnessEvidenceGrade(r.witness.authority)).toBe('unknown');
    expect(r.verdict).toBe('tip_mismatch');
    // The FACT survives — it is reported, not hidden (R1). Only its weight changes.
    expect(isWitnessAlterationEvidence(r)).toBe(false);
  });

  it('the same tip mismatch is evidence from an attributed witness and not from an unverifiable one', async () => {
    const trusted = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      distort: (f) => witnessOf(f, { last_hash: 'f'.repeat(64) }),
    });
    const untrusted = await scopeWitnessing({
      witnessedWho: BOB,
      witnessWho: ALICE,
      distort: (f) => witnessOf(f, { last_hash: 'f'.repeat(64) }),
      wrongRootKey: true,
    });

    const a = only(reconcileWitnesses(trusted.bundle));
    const b = only(reconcileWitnesses(untrusted.bundle));

    expect(a.verdict).toBe(b.verdict);
    expect(isWitnessAlterationEvidence(a)).toBe(true);
    expect(isWitnessAlterationEvidence(b)).toBe(false);
  });

  it('an unstamped bundle grades every witness inferred, never authoritative', async () => {
    const probe = await buildCollabScope([{ who: BOB, events: work(4) }]);
    const facts = factsOf(probe.bundle, 0);
    const { bundle } = await buildCollabScope(
      [
        { who: BOB, events: work(4) },
        { who: ALICE, events: [peerObserved(witnessOf(facts, { last_hash: 'f'.repeat(64) }))] },
      ],
      { stamp: false },
    );
    const r = only(reconcileWitnesses(bundle));

    expect(r.witness.authority).toBe('unattributed');
    expect(witnessEvidenceGrade(r.witness.authority)).toBe('inferred');
  });

  it('grades every authority exactly once', () => {
    expect(witnessEvidenceGrade('attributed')).toBe('established');
    expect(witnessEvidenceGrade('unattributed')).toBe('inferred');
    expect(witnessEvidenceGrade('unverifiable')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Witnesses that prove nothing
// ---------------------------------------------------------------------------

describe('circular and self-serving witnesses are excluded, not counted', () => {
  it('excludes a session witnessing its own log', async () => {
    const probe = await buildCollabScope([{ who: ALICE, events: work(3) }]);
    const facts = factsOf(probe.bundle, 0);
    const { bundle } = await buildCollabScope([
      { who: ALICE, events: [...work(3), peerObserved(witnessOf(facts))] },
    ]);
    const result = reconcileWitnesses(bundle);

    expect(result.witnesses).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]!.reason).toBe('self_witness');
  });

  it('excludes a witness about another session of the SAME proven contributor', async () => {
    // Not peer evidence: whoever could alter one of Alice's chains could alter
    // both. Requires both sides attributed, so it can never discard a witness
    // on an unproven relationship.
    const { bundle } = await scopeWitnessing({ witnessedWho: ALICE, witnessWho: ALICE });
    const result = reconcileWitnesses(bundle);

    expect(result.witnesses).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]!.reason).toBe('same_contributor');
  });

  it('does NOT exclude on an unproven relationship', async () => {
    // Two anonymous sessions are indistinguishable from one person recording
    // twice — and asserting either way is fabricating a relationship.
    // `compareContributors` answers 'unknown', so the witness is kept.
    const { bundle } = await scopeWitnessing({
      witnessedWho: 'anonymous',
      witnessWho: 'anonymous',
    });
    const result = reconcileWitnesses(bundle);

    expect(result.excluded).toEqual([]);
    expect(only(result).verdict).toBe('corroborated');
  });
});

// ---------------------------------------------------------------------------
// Malformed payloads
// ---------------------------------------------------------------------------

describe('a malformed witness is reported, never interpreted', () => {
  it('collects a payload that does not narrow, and produces no verdict', async () => {
    const { bundle } = await buildCollabScope([
      {
        who: ALICE,
        events: [{ kind: 'peer.observed', data: { file: 'x.slog', sha256: 'nope' } }],
      },
    ]);
    const result = reconcileWitnesses(bundle);

    expect(result.witnesses).toEqual([]);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0]!.error).toEqual({ kind: 'bad_field', field: 'sha256' });
    expect(result.counts.malformed).toBe(1);
  });

  it('rejects a half-parsed witness rather than reading the half it can', async () => {
    // Names a session, commits to no tip. It would look authoritative while
    // being unfalsifiable by any archive.
    const probe = await buildCollabScope([{ who: BOB, events: work(3) }]);
    const facts = factsOf(probe.bundle, 0);
    const { bundle } = await buildCollabScope([
      { who: BOB, events: work(3) },
      {
        who: ALICE,
        events: [
          peerObserved(witnessOf(facts, { seq_high: null, last_hash: null }) as PeerObservedPayload),
        ],
      },
    ]);
    const result = reconcileWitnesses(bundle);

    expect(result.witnesses).toEqual([]);
    expect(result.malformed[0]!.error.kind).toBe('partially_parsed');
    // And the witnessed session stays UNWITNESSED — an unreadable witness is
    // not coverage.
    expect(result.sessions[0]!.state).toBe('unwitnessed');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism — the ingest-retry contract', () => {
  it('two runs over one bundle produce identical output', async () => {
    const { bundle } = await scopeWitnessing({ witnessedWho: BOB, witnessWho: ALICE });
    expect(reconcileWitnesses(bundle)).toEqual(reconcileWitnesses(bundle));
  });

  it('counts add up to what was reported', async () => {
    const { bundle } = await scopeWitnessing({ witnessedWho: BOB, witnessWho: ALICE });
    const r = reconcileWitnesses(bundle);
    const verdictTotal =
      r.counts.corroborated +
      r.counts.absent +
      r.counts.short +
      r.counts.tip_mismatch +
      r.counts.indeterminate;

    expect(verdictTotal).toBe(r.witnesses.length);
    expect(r.counts.witnessedSessions + r.counts.unwitnessedSessions).toBe(r.sessions.length);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('older bundles', () => {
  it('a bundle with no peer.observed parses and reconciles unchanged', async () => {
    const { bundle } = await buildCollabScope([{ who: ALICE, events: work(5) }]);

    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.sessions[0]!.events.some((e) => e.kind === 'peer.observed')).toBe(false);
    expect(reconcileWitnesses(bundle).counts).toEqual({
      corroborated: 0,
      absent: 0,
      short: 0,
      tip_mismatch: 0,
      indeterminate: 0,
      unwitnessedSessions: 1,
      witnessedSessions: 0,
      excluded: 0,
      malformed: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Root key material sanity — keeps the unverifiable fixture load-bearing
// ---------------------------------------------------------------------------

describe('the unverifiable fixture is real', () => {
  it('the stranger root key is genuinely not the one that signed the identities', async () => {
    // Without this, `wrongRootKey` could silently be a no-op and every
    // "unverifiable" assertion above would be decorative — the exact failure the
    // decision log's §5 catalogue is full of.
    const keys = await buildIdentityKeys();
    const stranger = await seededKeypair(0x9e);
    expect(stranger.pubkeyHex).not.toBe(keys.root.pubkeyHex);
  });
});

// ---------------------------------------------------------------------------
// Two logs claiming one session id — the ambiguous case
// ---------------------------------------------------------------------------

describe('when two .slog files claim the witnessed session id', () => {
  /** Both logs under one logical id; distinct FILENAME uuids, as production does. */
  async function duplicated(secondEvents: EventSpec[]) {
    const shared = '00000000-0000-4000-8000-00000000dupe';
    const probe = await buildCollabScope([{ who: BOB, events: work(4) }]);
    const facts = { ...factsOf(probe.bundle, 0), sessionId: shared };

    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          sessionId: shared,
          fileUuid: '11111111-0000-4000-8000-000000000001',
          events: work(4),
        },
        {
          sessionId: shared,
          fileUuid: '22222222-0000-4000-8000-000000000002',
          events: secondEvents,
        },
        { events: [peerObserved(witnessOf(facts))] },
      ],
    });
    const loaded = await loadBundle(new Blob([zipBuffer]), 'dup.zip');
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    return { bundle: loaded.value, shared };
  }

  it('answers on what the copies AGREE about', async () => {
    // Unanimity is an answer whichever file the witness actually saw — the same
    // resolution `resolveAmbiguousCoverage` settled on for rolling seals.
    const { bundle, shared } = await duplicated(work(4));
    const copies = bundle.sessions.filter((s) => s.sessionId === shared);
    expect(copies.length).toBeGreaterThan(1);

    // Both copies carry the same events, so both reach the witnessed seq with
    // the same (non-witnessed) hash: they AGREE, and the agreed answer stands.
    const r = only(reconcileWitnesses(bundle));
    expect(r.verdict).toBe('tip_mismatch');
    expect(r.presentHashAtWitnessedSeq).not.toBeNull();
  });

  it('is indeterminate — never the harsher reading — when the copies disagree', async () => {
    // One copy is short of the witnessed seq and the other is not. The honest
    // answer is that we cannot check, NOT `short`: falling through to the
    // stricter branch on an unanswerable question is precisely how a duplicated
    // log became a maximum-severity accusation (decision-log bug 12).
    const { bundle } = await duplicated(work(1));
    const r = only(reconcileWitnesses(bundle));

    expect(r.verdict).toBe('indeterminate');
    expect(isWitnessAlterationEvidence(r)).toBe(false);
    expect(r.presentHashAtWitnessedSeq).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A hole at the witnessed seq
// ---------------------------------------------------------------------------

describe('a log with no entry AT the witnessed seq', () => {
  it('is indeterminate, not short and not a mismatch', async () => {
    // The log reaches PAST the witnessed seq but is missing the entry at it.
    // Checks 3 and 4 report the gap as a chain defect in its own right; from the
    // witness's side nothing was compared, so nothing is concluded.
    const { bundle } = await scopeWitnessing({ witnessedWho: BOB, witnessWho: ALICE });
    const witnessedSeq = only(reconcileWitnesses(bundle)).witness.payload.seq_high!;

    const holedEvents = [
      ...bundle.sessions[0]!.events.filter((e) => e.seq !== witnessedSeq),
      // Keep a seq ABOVE the witnessed one, so this is a hole and not a truncation.
      { ...bundle.sessions[0]!.events[0]!, seq: witnessedSeq + 1 },
    ];
    const holed: Bundle = {
      ...bundle,
      sessions: bundle.sessions.map((s, i) => (i === 0 ? { ...s, events: holedEvents } : s)),
    };

    const r = only(reconcileWitnesses(holed));
    expect(r.verdict).toBe('indeterminate');
    expect(r.presentSeqHigh).toBe(witnessedSeq + 1);
    expect(r.presentHashAtWitnessedSeq).toBeNull();
  });
});
