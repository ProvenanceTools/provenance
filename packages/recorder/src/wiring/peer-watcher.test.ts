/**
 * Tests for the peer-witnessing WRITER (program spec §7 mechanism 2).
 *
 * Every assertion here corresponds to a numbered item of the writer contract in
 * `docs/superpowers/specs/2026-08-19-program-decision-log.md`, and each was
 * verified by mutation — breaking the implementation one line at a time and
 * confirming a NAMED test goes red. A test nothing can fail on is not a test.
 *
 * The output side is pinned against the REAL readers rather than against a
 * hand-copied shape: `validatePeerObservedPayload` from log-core narrows every
 * payload emitted here, so a nonconforming writer fails in this file rather than
 * three repos later.
 */

import { describe, expect, it, vi } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  chainEntry,
  validatePeerObservedPayload,
  GENESIS_PREV_HASH,
  serializeEntry,
} from '@provenance/log-core';
import type { PeerObservedPayload } from '@provenance/log-core';
import { createSessionHost } from '../session/session-host.js';
import { startPeerWatcher, isWitnessableLogName, readForeignChainTip } from './peer-watcher.js';
import type { ProvenanceDirWatcher, PeerWatcherDeps } from './peer-watcher.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PROV_DIR = '/ws/proj/.provenance';
const OWN_SLOG = 'session-11111111-1111-4111-8111-111111111111.slog';
const PEER_SLOG = 'session-22222222-2222-4222-8222-222222222222.slog';
const PEER_SESSION = '4e2d9c10-55af-4b3e-9d21-8f0c7a6b3e55';

type FakeWatcher = ProvenanceDirWatcher & {
  fireCreate: (fsPath: string) => void;
  fireChange: (fsPath: string) => void;
  fireDelete: (fsPath: string) => void;
  disposed: () => boolean;
};

function makeFakeWatcher(): FakeWatcher {
  const create: Array<(p: string) => void> = [];
  const change: Array<(p: string) => void> = [];
  const del: Array<(p: string) => void> = [];
  let disposed = false;
  return {
    onDidCreate: (h) => {
      create.push(h);
      return { dispose: () => undefined };
    },
    onDidChange: (h) => {
      change.push(h);
      return { dispose: () => undefined };
    },
    onDidDelete: (h) => {
      del.push(h);
      return { dispose: () => undefined };
    },
    dispose: () => {
      disposed = true;
    },
    fireCreate: (p) => create.forEach((h) => h(p)),
    fireChange: (p) => change.forEach((h) => h(p)),
    fireDelete: (p) => del.forEach((h) => h(p)),
    disposed: () => disposed,
  };
}

/** A real, chain-valid foreign `.slog`, built with log-core's real chaining. */
function foreignLog(opts: { sessionId: string; extraEntries: number }): string {
  let prev = GENESIS_PREV_HASH;
  const lines: string[] = [];
  const push = (seq: number, kind: string, data: Record<string, unknown>): void => {
    const entry = chainEntry(prev, {
      seq,
      t: seq * 10,
      wall: new Date(Date.UTC(2026, 4, 19, 14, 0, seq)).toISOString(),
      kind,
      data,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test builder over the open kind space
    } as any);
    prev = entry.hash;
    lines.push(serializeEntry(entry));
  };
  push(0, 'session.start', { session_id: opts.sessionId, format_version: '1.0' });
  for (let i = 1; i <= opts.extraEntries; i++) {
    push(i, 'doc.change', { path: 'a.py', deltas: [], source: 'typed' });
  }
  return lines.join('');
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

type Harness = {
  watcher: FakeWatcher;
  emitted: PeerObservedPayload[];
  reads: string[];
  files: Map<string, string>;
  watcherHandle: ReturnType<typeof startPeerWatcher>;
};

function harness(overrides: Partial<PeerWatcherDeps> = {}): Harness {
  const watcher = makeFakeWatcher();
  const emitted: PeerObservedPayload[] = [];
  const reads: string[] = [];
  const files = new Map<string, string>();

  const watcherHandle = startPeerWatcher({
    provenanceDir: PROV_DIR,
    isOwnFile: (name) => name === OWN_SLOG || name === `${OWN_SLOG}.meta`,
    emit: (d) => emitted.push(d),
    readFile: async (abs) => {
      reads.push(abs);
      const text = files.get(path.basename(abs));
      if (text === undefined) return { ok: false, reason: 'gone' };
      return { ok: true, bytes: new TextEncoder().encode(text) };
    },
    createWatcher: () => watcher,
    ...overrides,
  });

  return { watcher, emitted, reads, files, watcherHandle };
}

const abs = (name: string): string => path.join(PROV_DIR, name);

// ---------------------------------------------------------------------------
// Rule 1 + 2 — one watcher, callbacks do no I/O
// ---------------------------------------------------------------------------

describe('the watcher is one directory watcher and its callbacks do no work', () => {
  it('constructs exactly ONE watcher, not one per file', () => {
    const createWatcher = vi.fn(() => makeFakeWatcher());
    const h = harness({ createWatcher });
    h.watcher.fireCreate(abs(PEER_SLOG));
    h.watcher.fireCreate(abs('session-33333333-3333-4333-8333-333333333333.slog'));
    expect(createWatcher).toHaveBeenCalledTimes(1);
  });

  it('does NO file I/O on the callback — nothing is read until drain', async () => {
    const h = harness();
    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 3 }));

    h.watcher.fireCreate(abs(PEER_SLOG));
    h.watcher.fireChange(abs(PEER_SLOG));
    h.watcher.fireDelete(abs(PEER_SLOG));

    // MUTATION GUARD: moving the read into `enqueue` — the shape that kills the
    // <1ms p99 handler budget (PRD §4.7) — makes both of these fail.
    expect(h.reads).toEqual([]);
    expect(h.emitted).toEqual([]);

    await h.watcherHandle.drain();
    expect(h.reads.length).toBeGreaterThan(0);
  });

  it('disposes the watcher and drops queued work', async () => {
    const h = harness();
    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 1 }));
    h.watcher.fireCreate(abs(PEER_SLOG));

    h.watcherHandle.dispose();
    expect(h.watcher.disposed()).toBe(true);

    await h.watcherHandle.drain();
    expect(h.emitted).toEqual([]);
  });

  it('survives a watcher that cannot be created, and never blocks recording', async () => {
    const h = harness({
      createWatcher: () => {
        throw new Error('EMFILE');
      },
    });
    await expect(h.watcherHandle.drain()).resolves.toBeUndefined();
    expect(h.emitted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — rate limiting: at most one observation per file per drain
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('emits AT MOST ONE observation per file per drain, however many events arrived', async () => {
    const h = harness();
    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 5 }));

    for (let i = 0; i < 50; i++) h.watcher.fireChange(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    // MUTATION GUARD: replacing the pending Set with an array makes this 50.
    expect(h.emitted).toHaveLength(1);
    expect(h.reads).toHaveLength(1);
  });

  it('emits nothing when the bytes have not changed since the last observation', async () => {
    const h = harness();
    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 5 }));

    h.watcher.fireChange(abs(PEER_SLOG));
    await h.watcherHandle.drain();
    expect(h.emitted).toHaveLength(1);

    h.watcher.fireChange(abs(PEER_SLOG));
    await h.watcherHandle.drain();
    expect(h.emitted).toHaveLength(1);
  });

  it('queues events that arrive DURING a drain for the next one, losing none', async () => {
    // A read that genuinely blocks, so the second watcher event lands while the
    // first drain is suspended mid-read rather than before it started.
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstRead = true;
    const emitted: PeerObservedPayload[] = [];
    const files = new Map<string, string>([
      [PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 2 })],
    ]);
    const watcher = makeFakeWatcher();
    const handle = startPeerWatcher({
      provenanceDir: PROV_DIR,
      isOwnFile: () => false,
      emit: (d) => emitted.push(d),
      readFile: async (p) => {
        // Snapshot at read START, as a real read does: the bytes a drain sees
        // are the bytes that were there when it looked.
        const text = files.get(path.basename(p))!;
        if (firstRead) {
          firstRead = false;
          await blocked;
        }
        return { ok: true, bytes: new TextEncoder().encode(text) };
      },
      createWatcher: () => watcher,
    });

    watcher.fireCreate(abs(PEER_SLOG));
    const inFlight = handle.drain();
    // Let the drain reach — and suspend inside — its read.
    await Promise.resolve();
    await Promise.resolve();

    // Arrives while that read is in flight. The queue was already snapshotted
    // and cleared, so this must be picked up by the NEXT drain, not lost.
    files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 9 }));
    watcher.fireChange(abs(PEER_SLOG));
    release!();
    await inFlight;

    await handle.drain();
    expect(emitted.map((e) => e.state)).toEqual(['appeared', 'grew']);
    handle.dispose();
  });

  it('serializes overlapping drains rather than interleaving their reads', async () => {
    const h = harness();
    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 2 }));
    h.watcher.fireCreate(abs(PEER_SLOG));

    await Promise.all([h.watcherHandle.drain(), h.watcherHandle.drain()]);
    expect(h.emitted).toHaveLength(1);
    await h.watcherHandle.settled();
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — exclude our own files by path
// ---------------------------------------------------------------------------

describe('self-witnessing', () => {
  it('NEVER witnesses this recorder’s own .slog', async () => {
    const h = harness();
    h.files.set(OWN_SLOG, foreignLog({ sessionId: 'our-own-session', extraEntries: 4 }));

    h.watcher.fireCreate(abs(OWN_SLOG));
    h.watcher.fireChange(abs(OWN_SLOG));
    await h.watcherHandle.drain();

    // MUTATION GUARD: dropping the isOwnFile check makes this fail — a chain
    // corroborating itself is circular, and the reader excluding it is not a
    // licence for the writer to produce it.
    expect(h.emitted).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it('never witnesses a .slog.meta, only .slog', () => {
    expect(isWitnessableLogName(PEER_SLOG)).toBe(true);
    expect(isWitnessableLogName(`${PEER_SLOG}.meta`)).toBe(false);
    expect(isWitnessableLogName('manifest-abc.json')).toBe(false);
    expect(isWitnessableLogName('manifest-abc.sig')).toBe(false);
  });

  it('witnesses a partner’s .slog in the same directory', async () => {
    const h = harness();
    h.files.set(OWN_SLOG, foreignLog({ sessionId: 'own', extraEntries: 4 }));
    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 4 }));

    h.watcher.fireCreate(abs(OWN_SLOG));
    h.watcher.fireCreate(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    expect(h.emitted.map((e) => e.file)).toEqual([PEER_SLOG]);
  });
});

// ---------------------------------------------------------------------------
// Rules 6, 7 — explicit nulls, and seq_high 0
// ---------------------------------------------------------------------------

describe('the payload shape every reader narrows', () => {
  it('emits EXPLICIT nulls, never omitted keys — omission changes the chain hash', async () => {
    const h = harness();
    h.files.set(PEER_SLOG, 'this is not ndjson at all\n');
    h.watcher.fireCreate(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    const payload = h.emitted[0]!;
    // MUTATION GUARD: spreading these conditionally (`...(x !== null ? {x} : {})`)
    // makes all three of these fail. The canonical bytes, and therefore the
    // entry hash, differ between an absent key and a null value.
    expect(Object.hasOwn(payload, 'session_id')).toBe(true);
    expect(Object.hasOwn(payload, 'seq_high')).toBe(true);
    expect(Object.hasOwn(payload, 'last_hash')).toBe(true);
    expect(payload.session_id).toBeNull();
    expect(payload.seq_high).toBeNull();
    expect(payload.last_hash).toBeNull();
    expect(payload.state).toBe('unparseable');
  });

  it('treats seq_high 0 as a REAL value — a log holding only its session.start', async () => {
    const h = harness();
    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 0 }));
    h.watcher.fireCreate(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    const payload = h.emitted[0]!;
    // MUTATION GUARD: any truthiness check on seq_high (`if (!seqHigh)`) turns
    // the shortest honest witness into an all-null `unparseable` one, and both
    // of these fail.
    expect(payload.seq_high).toBe(0);
    expect(payload.session_id).toBe(PEER_SESSION);
    expect(payload.last_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.state).toBe('appeared');
    expect(validatePeerObservedPayload(payload).ok).toBe(true);
  });

  it('carries NO identity of any kind — the key set is pinned', async () => {
    const h = harness();
    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 3 }));
    h.watcher.fireCreate(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    // A witness names a FILE and a CHAIN POSITION. No student_ref, no key, no
    // git author, no path outside .provenance/. This is a CPHS protocol
    // constraint, and it is checked as an exact key set so a new field cannot
    // arrive unnoticed.
    expect(Object.keys(h.emitted[0]!).sort()).toEqual([
      'bytes',
      'file',
      'last_hash',
      'seq_high',
      'session_id',
      'sha256',
      'state',
    ]);
    expect(h.emitted[0]!.file).toBe(PEER_SLOG);
    expect(h.emitted[0]!.file).not.toContain(path.sep);
  });

  it('every emitted payload is accepted by log-core’s real narrowing', async () => {
    const h = harness();
    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 3 }));
    h.watcher.fireCreate(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 30 }));
    h.watcher.fireChange(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    h.files.delete(PEER_SLOG);
    h.watcher.fireDelete(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    expect(h.emitted).toHaveLength(3);
    for (const payload of h.emitted) {
      const read = validatePeerObservedPayload(payload);
      expect(read.ok).toBe(true);
    }
  });

  it('sha256 is lowercase hex over the file’s exact bytes, and bytes is its length', async () => {
    const h = harness();
    const text = foreignLog({ sessionId: PEER_SESSION, extraEntries: 3 });
    h.files.set(PEER_SLOG, text);
    h.watcher.fireCreate(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    expect(h.emitted[0]!.sha256).toBe(sha256(text));
    expect(h.emitted[0]!.bytes).toBe(Buffer.byteLength(text, 'utf8'));
  });
});

// ---------------------------------------------------------------------------
// Rules 5, 9 — never touch a foreign file; state is descriptive
// ---------------------------------------------------------------------------

describe('a foreign file is never touched (decision-log bug 2)', () => {
  it('answers an unreadable log with state:unparseable and NOTHING else', async () => {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'prov-peer-'));
    const target = path.join(dir, PEER_SLOG);
    const garbage = '{"seq": 0, truncated mid-wri';
    await fsPromises.writeFile(target, garbage, 'utf8');

    const before = await fsPromises.readdir(dir);
    const watcher = makeFakeWatcher();
    const emitted: PeerObservedPayload[] = [];
    const handle = startPeerWatcher({
      provenanceDir: dir,
      isOwnFile: () => false,
      emit: (d) => emitted.push(d),
      readFile: async (p) => ({ ok: true, bytes: await fsPromises.readFile(p) }),
      createWatcher: () => watcher,
    });

    watcher.fireCreate(target);
    await handle.drain();

    expect(emitted[0]!.state).toBe('unparseable');

    // MUTATION GUARD: any rename/unlink/rewrite of a foreign log — the shape
    // that made a recorder quarantine its partner's evidence and let git blame
    // the victim — fails here. The directory listing and the bytes are both
    // required to be untouched.
    expect(await fsPromises.readdir(dir)).toEqual(before);
    expect(await fsPromises.readFile(target, 'utf8')).toBe(garbage);
    handle.dispose();
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('reports growth and shrinkage descriptively', async () => {
    const h = harness();
    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 2 }));
    h.watcher.fireCreate(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 20 }));
    h.watcher.fireChange(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    h.files.set(PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 1 }));
    h.watcher.fireChange(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    expect(h.emitted.map((e) => e.state)).toEqual(['appeared', 'grew', 'shrank']);
    expect(h.emitted[2]!.seq_high).toBe(1);
  });

  it('reports a disappearance with the LAST state seen, once, and never as misconduct', async () => {
    const h = harness();
    const text = foreignLog({ sessionId: PEER_SESSION, extraEntries: 7 });
    h.files.set(PEER_SLOG, text);
    h.watcher.fireCreate(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    h.files.delete(PEER_SLOG);
    h.watcher.fireDelete(abs(PEER_SLOG));
    await h.watcherHandle.drain();

    const gone = h.emitted[1]!;
    expect(gone.state).toBe('disappeared');
    // The chain fields carry the last state seen — this is what makes the
    // observation evidentiary. A `git checkout` or a `git stash` produces this
    // and neither is misconduct.
    expect(gone.sha256).toBe(sha256(text));
    expect(gone.seq_high).toBe(7);
    expect(gone.session_id).toBe(PEER_SESSION);

    // Only once: a file that is still gone at the next drain says nothing new.
    h.watcher.fireDelete(abs(PEER_SLOG));
    await h.watcherHandle.drain();
    expect(h.emitted).toHaveLength(2);
  });

  it('never invents a disappearance for a file it never saw present', async () => {
    const h = harness();
    h.watcher.fireDelete(abs(PEER_SLOG));
    await h.watcherHandle.drain();
    // With no prior observation there is no last state, and manufacturing a
    // digest would be manufacturing evidence about a partner's artifact.
    expect(h.emitted).toEqual([]);
  });

  it('does NOT turn a local read failure into a claim about a partner’s file', async () => {
    const h = harness({
      readFile: async () => ({ ok: false, reason: 'unreadable' }),
    });
    h.watcher.fireCreate(abs(PEER_SLOG));
    await h.watcherHandle.drain();
    // EACCES/EIO says something about this machine, not about the file.
    expect(h.emitted).toEqual([]);
  });

  it('one unreadable log does not cost the others their observation', async () => {
    const h = harness({
      readFile: async (p) => {
        if (path.basename(p) === PEER_SLOG) throw new Error('boom');
        return { ok: true, bytes: new TextEncoder().encode(foreignLog({ sessionId: 'z', extraEntries: 1 })) };
      },
    });
    const other = 'session-33333333-3333-4333-8333-333333333333.slog';
    h.watcher.fireCreate(abs(PEER_SLOG));
    h.watcher.fireCreate(abs(other));
    await h.watcherHandle.drain();
    expect(h.emitted.map((e) => e.file)).toEqual([other]);
  });
});

// ---------------------------------------------------------------------------
// The chain-advance seam
// ---------------------------------------------------------------------------

describe('the chain advance stays atomic with every other emitter', () => {
  it('interleaving: a drain’s awaits never straddle a chain advance', async () => {
    // The real SessionHost, so this is the production chaining code.
    const entries: Array<{ seq: number; kind: string; prev_hash: string; hash: string }> = [];
    let now = 0;
    const host = createSessionHost({
      sessionId: 'own',
      clock: { now: () => (now += 1), wall: () => new Date(now * 1000).toISOString() },
      onEntry: (e) =>
        entries.push({ seq: e.seq, kind: e.kind, prev_hash: e.prev_hash, hash: e.hash }),
    });

    const watcher = makeFakeWatcher();
    // Each read yields control to the microtask queue, and a competing emitter
    // fires while it is suspended. If the drain held a read `prevHash` across
    // that await, the chain would fork here.
    let reads = 0;
    const handle = startPeerWatcher({
      provenanceDir: PROV_DIR,
      isOwnFile: () => false,
      emit: (d) => host.emit('peer.observed', d),
      readFile: async (p) => {
        reads++;
        await Promise.resolve();
        host.emit('session.heartbeat', { open_files: reads });
        await Promise.resolve();
        return {
          ok: true,
          bytes: new TextEncoder().encode(
            foreignLog({ sessionId: `peer-${path.basename(p)}`, extraEntries: reads }),
          ),
        };
      },
      createWatcher: () => watcher,
    });

    host.emit('session.start', { open_files: 0 } as never);
    for (let i = 2; i <= 6; i++) {
      watcher.fireCreate(abs(`session-${String(i).repeat(8)}-2222-4222-8222-222222222222.slog`));
    }
    await handle.drain();
    host.emit('session.end', { reason: 'deactivate' });

    // Contiguous seq — no hole, which check 4 (seq_gaps) reads as a deletion.
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i));

    // Unbroken linkage — a torn chain advance is what manufactures a
    // check 3 (chain_integrity) finding against an innocent student.
    let prev = GENESIS_PREV_HASH;
    for (const e of entries) {
      expect(e.prev_hash).toBe(prev);
      prev = e.hash;
    }

    // And the interleaving really happened: heartbeats sit BETWEEN the
    // observations rather than all before or all after them.
    const kinds = entries.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'peer.observed')).toHaveLength(5);
    expect(kinds.indexOf('session.heartbeat')).toBeLessThan(kinds.indexOf('peer.observed'));
    handle.dispose();
  });

  it('a suppressed observation consumes NO seq — the chain stays contiguous', async () => {
    const emitted: PeerObservedPayload[] = [];
    let seq = 0;
    const watcher = makeFakeWatcher();
    const files = new Map<string, string>([
      [PEER_SLOG, foreignLog({ sessionId: PEER_SESSION, extraEntries: 3 })],
    ]);
    const handle = startPeerWatcher({
      provenanceDir: PROV_DIR,
      isOwnFile: (n) => n === OWN_SLOG,
      emit: (d) => {
        emitted.push(d);
        seq++;
      },
      readFile: async (p) => {
        const text = files.get(path.basename(p));
        if (text === undefined) return { ok: false, reason: 'gone' };
        return { ok: true, bytes: new TextEncoder().encode(text) };
      },
      createWatcher: () => watcher,
    });

    // Our own file (excluded), an unchanged file (nothing new), and a file that
    // was never present (nothing honest to say) — three suppression routes.
    files.set(OWN_SLOG, foreignLog({ sessionId: 'own', extraEntries: 3 }));
    watcher.fireCreate(abs(PEER_SLOG));
    await handle.drain();
    expect(seq).toBe(1);

    watcher.fireCreate(abs(OWN_SLOG));
    watcher.fireChange(abs(PEER_SLOG));
    watcher.fireDelete(abs('session-99999999-9999-4999-8999-999999999999.slog'));
    await handle.drain();

    // Gating happens BEFORE anything is chained, so a suppressed observation
    // leaves no hole. A hole reads as a deletion to validation check 4.
    expect(seq).toBe(1);
    expect(emitted).toHaveLength(1);
    handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// readForeignChainTip — the all-or-nothing rule
// ---------------------------------------------------------------------------

describe('readForeignChainTip', () => {
  it('reads the session id, the highest seq, and the hash AT that seq', () => {
    const tip = readForeignChainTip(foreignLog({ sessionId: PEER_SESSION, extraEntries: 12 }));
    expect(tip.session_id).toBe(PEER_SESSION);
    expect(tip.seq_high).toBe(12);
    expect(tip.last_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns ALL NULL when the log parses but names no session', () => {
    // A log whose session.start is missing cannot be named, so the honest answer
    // is that the chain was not read. Returning a seq without a session id is
    // the `partially_parsed` shape every reader REJECTS.
    const full = foreignLog({ sessionId: PEER_SESSION, extraEntries: 3 });
    const withoutStart = full.split('\n').slice(1).join('\n');
    expect(readForeignChainTip(withoutStart)).toEqual({
      session_id: null,
      seq_high: null,
      last_hash: null,
    });
  });

  it('returns all null for an empty file and for garbage', () => {
    const nothing = { session_id: null, seq_high: null, last_hash: null };
    expect(readForeignChainTip('')).toEqual(nothing);
    expect(readForeignChainTip('not json\n')).toEqual(nothing);
  });
});
