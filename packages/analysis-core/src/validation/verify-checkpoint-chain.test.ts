/**
 * Tests for the checkpoint-chain detection — PRD §4.6's signed `(seq, hash)`
 * checkpoints, verified.
 *
 * These build `Bundle`s directly rather than going through a ZIP, because the
 * shared `buildTestBundle` fixture always emits `checkpoints: []` and the whole
 * subject here is what happens when checkpoints are present. Signing uses
 * log-core's real `signCheckpoint`, and verification the real `verifyCheckpoint`
 * — nothing about the crypto is stubbed, so a forged signature is forged in the
 * same sense a real one would be.
 *
 * The end-to-end direction (real recorder → real MetaWriter → real seal → this
 * check) is covered in `tools/recorder-seal-conformance.test.ts`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import {
  chainEntry,
  signCheckpoint,
  generateSessionKeypair,
  type SessionKeypair,
  type SlogMeta,
  type HashedEnvelope,
} from '@provenance/log-core';
import { verifyCheckpointChain } from './verify-checkpoint-chain.js';
import type { Bundle, ParsedSession } from '../loader/types.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

const GENESIS = '0'.repeat(64);

/** Build a real, correctly-chained run of entries for one session. */
function buildEvents(sessionId: string, count: number): HashedEnvelope[] {
  const events: HashedEnvelope[] = [];
  let prevHash = GENESIS;

  for (let seq = 0; seq < count; seq++) {
    const entry = chainEntry(
      prevHash,
      seq === 0
        ? {
            seq,
            t: 0,
            wall: '2026-05-19T14:00:00.000Z',
            kind: 'session.start',
            data: {
              format_version: '1.0',
              session_id: sessionId,
              prev_session_id: null,
              assignment: { id: 'hw1', semester: '2026sp' },
              manifest_sig: 'ab'.repeat(32),
              machine_id: 'b'.repeat(64),
              vscode: { version: '1.100.0', commit: '', platform: 'darwin-arm64' },
              recorder: { version: '1.2.0', extension_id: 'test' },
              session_pubkey: 'c'.repeat(64),
            },
          }
        : {
            seq,
            t: seq * 1000,
            wall: new Date(Date.parse('2026-05-19T14:00:00.000Z') + seq * 1000).toISOString(),
            kind: 'session.heartbeat',
            data: { focused: true, active_file: null, idle_since_ms: 0 },
          },
    ) as HashedEnvelope;

    events.push(entry);
    prevHash = entry.hash;
  }

  return events;
}

function makeMeta(
  sessionId: string,
  pubkeyHex: string,
  checkpoints: SlogMeta['checkpoints'],
): SlogMeta {
  return {
    format_version: '1.0',
    session_id: sessionId,
    session_pubkey: pubkeyHex,
    encrypted_session_privkey: {
      algorithm: 'xchacha20-poly1305-hkdf-sha256-v1',
      nonce: 'ab'.repeat(12),
      ciphertext: 'cd'.repeat(48),
      salt: 'ef'.repeat(16),
      info: 'provenance-session-v1',
    },
    checkpoints,
  };
}

function makeBundle(sessions: ParsedSession[]): Bundle {
  return {
    id: 'bundle-1',
    droppedArtifacts: [],
    manifest: {
      format_version: '1.0',
      assignment_id: 'hw1',
      semester: '2026sp',
      extension_hash: 'a'.repeat(64),
      sessions: sessions.map((s) => ({
        session_id: s.sessionId,
        prev_session_id: null,
        slog_sha256: s.slogSha256,
        meta_sha256: s.metaSha256,
      })),
    },
    manifestSigHex: 'ab'.repeat(64),
    sessions,
    sourceFilename: 'test.zip',
    loadedAt: '2026-05-19T15:00:00.000Z',
    submissionFiles: new Map(),
  };
}

/**
 * A session with `checkpointAt` seqs genuinely checkpointed by its own key.
 */
async function makeSession(opts: {
  sessionId: string;
  eventCount: number;
  checkpointAt: number[];
  keypair: SessionKeypair;
}): Promise<ParsedSession> {
  const { sessionId, eventCount, checkpointAt, keypair } = opts;
  const events = buildEvents(sessionId, eventCount);

  const checkpoints = [];
  for (const seq of checkpointAt) {
    const entry = events.find((e) => e.seq === seq)!;
    checkpoints.push(await signCheckpoint(seq, entry.hash, keypair.privateKey));
  }

  return {
    sessionId,
    events,
    meta: makeMeta(sessionId, keypair.publicKeyHex, checkpoints),
    slogSha256: 'a'.repeat(64),
    slogSha256Lf: null,
    tornTail: null,
    metaSha256: 'b'.repeat(64),
    firstEvent: events[0] as ParsedSession['firstEvent'],
  };
}

// ---------------------------------------------------------------------------
// Honest bundles
// ---------------------------------------------------------------------------

describe('verifyCheckpointChain — honest bundles', () => {
  it('passes when every checkpoint verifies and agrees with the chain', async () => {
    const keypair = await generateSessionKeypair();
    const session = await makeSession({
      sessionId: 's1',
      eventCount: 8,
      checkpointAt: [2, 5, 7],
      keypair,
    });

    const check = await verifyCheckpointChain(makeBundle([session]));
    expect(check.id).toBe('checkpoint_chain_valid');
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('3 signed checkpoint(s) verified');
  });

  it('passes across multiple sessions, each signed by its OWN key', async () => {
    const kp1 = await generateSessionKeypair();
    const kp2 = await generateSessionKeypair();

    const bundle = makeBundle([
      await makeSession({ sessionId: 's1', eventCount: 5, checkpointAt: [1, 4], keypair: kp1 }),
      await makeSession({ sessionId: 's2', eventCount: 5, checkpointAt: [3], keypair: kp2 }),
    ]);

    expect((await verifyCheckpointChain(bundle)).status).toBe('pass');
  });

  it('passes when entries exist AFTER the last checkpoint (normal recorder output)', async () => {
    // A recorder checkpoints periodically, so trailing uncheckpointed entries
    // are the common case. Treating them as suspicious would fire on nearly
    // every honest submission.
    const keypair = await generateSessionKeypair();
    const session = await makeSession({
      sessionId: 's1',
      eventCount: 20,
      checkpointAt: [1, 2],
      keypair,
    });

    expect((await verifyCheckpointChain(makeBundle([session]))).status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Absent is not wrong
// ---------------------------------------------------------------------------

describe('verifyCheckpointChain — never manufactures a finding', () => {
  it('skips a session with no checkpoints', async () => {
    const keypair = await generateSessionKeypair();
    const session = await makeSession({
      sessionId: 's1',
      eventCount: 5,
      checkpointAt: [],
      keypair,
    });

    const check = await verifyCheckpointChain(makeBundle([session]));
    expect(check.status).toBe('skipped');
    expect(check.status).not.toBe('fail');
  });

  it('skips when the session pubkey is absent or malformed', async () => {
    const keypair = await generateSessionKeypair();
    const session = await makeSession({
      sessionId: 's1',
      eventCount: 5,
      checkpointAt: [2],
      keypair,
    });

    // Unverifiable is not refuted.
    const noKey: ParsedSession = {
      ...session,
      meta: { ...session.meta, session_pubkey: 'nope' },
    };

    const check = await verifyCheckpointChain(makeBundle([noKey]));
    expect(check.status).toBe('skipped');
    expect(check.status).not.toBe('fail');
  });

  it('skips an entirely empty bundle rather than failing it', async () => {
    expect((await verifyCheckpointChain(makeBundle([]))).status).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// Detections
// ---------------------------------------------------------------------------

describe('verifyCheckpointChain — catches tampering', () => {
  it('fails when a checkpoint is signed by the WRONG key (forged)', async () => {
    const keypair = await generateSessionKeypair();
    const attacker = await generateSessionKeypair();

    const session = await makeSession({
      sessionId: 's1',
      eventCount: 6,
      checkpointAt: [3],
      keypair: attacker, // signed by the attacker...
    });
    // ...but the session advertises its real key.
    const forged: ParsedSession = {
      ...session,
      meta: { ...session.meta, session_pubkey: keypair.publicKeyHex },
    };

    const check = await verifyCheckpointChain(makeBundle([forged]));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('does not verify against the session public key');
  });

  it('fails when a checkpointed entry was REWRITTEN (hash mismatch)', async () => {
    const keypair = await generateSessionKeypair();
    const session = await makeSession({
      sessionId: 's1',
      eventCount: 6,
      checkpointAt: [3],
      keypair,
    });

    // Rewrite the entry the checkpoint commits to. Its hash no longer matches
    // the value the session key swore to.
    const rewritten: ParsedSession = {
      ...session,
      events: session.events.map((e) => (e.seq === 3 ? { ...e, hash: 'd'.repeat(64) } : e)),
    };

    const check = await verifyCheckpointChain(makeBundle([rewritten]));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('swears the entry at seq 3');
    expect(check.supportingSeqs).toEqual([{ sessionId: 's1', seq: 3 }]);
  });

  it('fails when the log was TRUNCATED below a checkpoint', async () => {
    const keypair = await generateSessionKeypair();
    const session = await makeSession({
      sessionId: 's1',
      eventCount: 8,
      checkpointAt: [6],
      keypair,
    });

    // Cut the log short. The remaining chain still self-verifies (check 3
    // passes), but a signed checkpoint now points past the end.
    const truncated: ParsedSession = {
      ...session,
      events: session.events.filter((e) => e.seq <= 4),
    };

    const check = await verifyCheckpointChain(makeBundle([truncated]));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('no entry with that seq is present');
  });

  it('reports every offending checkpoint, not just the first', async () => {
    const keypair = await generateSessionKeypair();
    const session = await makeSession({
      sessionId: 's1',
      eventCount: 8,
      checkpointAt: [2, 5],
      keypair,
    });

    const rewritten: ParsedSession = {
      ...session,
      events: session.events.map((e) =>
        e.seq === 2 || e.seq === 5 ? { ...e, hash: 'd'.repeat(64) } : e,
      ),
    };

    const check = await verifyCheckpointChain(makeBundle([rewritten]));
    expect(check.status).toBe('fail');
    expect(check.supportingSeqs).toHaveLength(2);
  });

  it('does not blame the student for a hash mismatch it cannot authenticate', async () => {
    // A checkpoint that fails signature verification is reported as a bad
    // signature and nothing more — we must not additionally assert a hash
    // mismatch derived from an attacker-supplied claim.
    const keypair = await generateSessionKeypair();
    const attacker = await generateSessionKeypair();

    const session = await makeSession({
      sessionId: 's1',
      eventCount: 6,
      checkpointAt: [3],
      keypair: attacker,
    });
    const forged: ParsedSession = {
      ...session,
      meta: {
        ...session.meta,
        session_pubkey: keypair.publicKeyHex,
        checkpoints: session.meta.checkpoints.map((c) => ({ ...c, hash: 'e'.repeat(64) })),
      },
    };

    const check = await verifyCheckpointChain(makeBundle([forged]));
    expect(check.status).toBe('fail');
    expect(check.supportingSeqs).toHaveLength(1);
    expect(check.detail).toContain('does not verify against the session public key');
    expect(check.detail).not.toContain('swears the entry at seq');
  });
});
