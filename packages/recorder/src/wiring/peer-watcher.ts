/**
 * peer-watcher.ts — PEER WITNESSING, write side (program spec §7 mechanism 2,
 * collaboration spec §5.5, Tier 4.1).
 *
 * In a shared repository a `git pull` drops a partner's `.slog` into
 * `.provenance/`. This module notices, hashes it, reads its chain tip, and
 * writes what it saw into **this** recorder's own signed chain as a
 * `peer.observed` entry. Deleting a partner's log then leaves your own chain
 * testifying that it existed, and hiding that means destroying both chains —
 * which yields a submission with no provenance at all, the loudest possible
 * signal.
 *
 * The reader half is `log-core/peer-observed.ts` (the narrowing) and
 * `analysis-core/witness/reconcile-witnesses.ts` (the five verdicts). The writer
 * contract this module implements is pinned in
 * `docs/superpowers/specs/2026-08-19-program-decision-log.md`, "The writer
 * contract — what the three recorders must emit". Every numbered rule below is
 * one of its items; the two sibling recorders port from here.
 *
 * ## 1. One watcher on the directory, not one per file
 *
 * A partner's filename is not knowable in advance — it is a uuid minted on their
 * machine — so a per-file watcher is not even expressible here. One watcher on
 * `.provenance/` is also the only shape that sees a file APPEAR, which is the
 * whole point.
 *
 * ## 2. Callbacks enqueue a name and return
 *
 * No I/O, no hashing, no parsing on the callback. The recorder's handler budget
 * is <1 ms p99 (PRD §4.7) and hashing a partner's multi-megabyte log on a
 * watcher callback would blow it on the one path a student notices. A callback
 * here is a `Set.add` of a string plus a basename comparison.
 *
 * ## 3. The drain runs on the checkpoint cadence
 *
 * Same cadence, and the same serialized chain, as the rolling seal: every
 * `CHECKPOINT_INTERVAL` entries, plus once at `dispose()` so a pull that landed
 * after the last checkpoint is still witnessed. Because the queue is a SET of
 * filenames, a file touched fifty times between two drains yields exactly one
 * observation — the rate limit is structural rather than a timer.
 *
 * ## 4. This recorder's own files are excluded by path
 *
 * A chain cannot corroborate itself. `reconcileWitnesses` excludes a
 * self-witness anyway (`reason: 'self_witness'`), but a recorder must not
 * produce one: an excluded witness is noise in a staff-facing count, and relying
 * on the reader to clean up after the writer is how the two halves drift.
 *
 * ## 5. A FOREIGN FILE IS NEVER TOUCHED
 *
 * Read and hash is the entire interaction. This module never renames, rewrites,
 * moves, truncates or deletes anything, and it holds no write-capable handle: it
 * is constructed with a `readFile` and nothing else. `state: 'unparseable'` is
 * the complete response to a log that cannot be read.
 *
 * That is not a stylistic preference. Decision-log bug 2 was a startup recovery
 * that quarantined — renamed — a partner's log with no ownership check, which in
 * a shared repo destroys the victim's evidence and makes git blame them for it,
 * and hands an attacker a way to delete a partner's log by corrupting one byte
 * of it. Watching a directory full of other students' evidence is the second
 * place that mistake could be made. It is not made here.
 *
 * ## 6. Nulls are emitted explicitly, never omitted
 *
 * `session_id` / `seq_high` / `last_hash` are the three values read out of the
 * foreign chain, and they are all-null together or all-non-null together. They
 * are always PRESENT as keys: an omitted key and a `null` value canonicalize
 * differently and therefore chain to different hashes, so a port that omits them
 * produces a log whose entries hash differently from every other recorder's for
 * the same observation.
 *
 * ## 7. `seq_high: 0` is a real value
 *
 * A foreign log holding only its `session.start` has `seq_high === 0`. Every
 * comparison here is against `null` explicitly; a truthiness check would turn the
 * shortest honest witness into a malformed one.
 *
 * ## 9. `state` is descriptive, never a verdict
 *
 * `disappeared` is NOT misconduct — a `git checkout` of a branch without the
 * partner's `.slog`, or a `git stash`, removes it from the working tree — and it
 * carries the LAST state seen, which is exactly what makes the observation
 * evidentiary. Nothing in this module scores, flags or ranks anything, and
 * nothing it emits names a person: a witness names a FILE and a CHAIN POSITION.
 * There is no student ref, no key, no git author and no path outside
 * `.provenance/` in the payload, and there must never be.
 *
 * ## Failure is always silent degradation
 *
 * Recording matters more than witnessing. Every read error, parse failure and
 * unexpected exception ends as "no observation for that file this round". The
 * drain never throws, never rejects, and can never stall a session.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { parseEntries } from '@provenance/log-core';
import type { PeerObservedPayload } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A `vscode.Disposable`-shaped handle, without importing vscode into this module. */
export type PeerWatcherDisposable = { dispose(): void };

/**
 * The seam onto `vscode.workspace.createFileSystemWatcher`.
 *
 * Kept as an injected shape rather than an import so the unit tests exercise the
 * queueing and drain logic as pure functions (CLAUDE.md: "Do not write tests that
 * exercise VS Code APIs from unit tests. Mock at the seam."). The production
 * adapter lives in `session/session-registry.ts`.
 */
export type ProvenanceDirWatcher = PeerWatcherDisposable & {
  /** A `.provenance/` entry was created. Handler receives an absolute path. */
  onDidCreate(handler: (fsPath: string) => void): PeerWatcherDisposable;
  /** A `.provenance/` entry changed. */
  onDidChange(handler: (fsPath: string) => void): PeerWatcherDisposable;
  /** A `.provenance/` entry was deleted. */
  onDidDelete(handler: (fsPath: string) => void): PeerWatcherDisposable;
};

/** Why a read of a foreign file did not produce bytes. */
type ReadFailure = 'gone' | 'unreadable';

/**
 * Read a foreign log's exact bytes.
 *
 * Returns `'gone'` when the file is not there (ENOENT / ENOTDIR — a checkout or
 * a stash) and `'unreadable'` for every other failure. The two are kept apart
 * because only the first is a fact about the file: a permission error or an EIO
 * says something about this machine, and turning it into a `disappeared`
 * observation would put a claim about a partner's artifact into a signed chain
 * on the strength of a local failure.
 */
export type ReadForeignLog = (
  absPath: string,
) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: ReadFailure }>;

export type PeerWatcherDeps = {
  /** Absolute path of THIS session's `.provenance/` directory. */
  provenanceDir: string;
  /**
   * True for a file this recorder writes itself. Receives the BASENAME.
   *
   * Rule 4. Supplied by the caller because only the session knows its own
   * `.slog` filename uuid, which is minted independently of the logical session
   * id — the two id spaces that decision-log bugs 10 and 12 were both about.
   */
  isOwnFile: (basename: string) => boolean;
  /**
   * Emit one `peer.observed` entry. MUST be synchronous — it is
   * `sessionHost.emit`, which reads `prevHash`, chains, and advances `seq`
   * without an await. See {@link PeerWatcher.drain}.
   */
  emit: (data: PeerObservedPayload) => void;
  readFile: ReadForeignLog;
  /** Construct the single directory watcher. Called once, at start. */
  createWatcher: () => ProvenanceDirWatcher;
};

export type PeerWatcher = PeerWatcherDisposable & {
  /**
   * Observe every file queued since the last drain and emit one `peer.observed`
   * for each that has something new to say.
   *
   * Never rejects. Serialized against itself, so two overlapping calls (a
   * checkpoint landing while `dispose()` drains) run one after the other rather
   * than interleaving their reads.
   */
  drain(): Promise<void>;
  /** Resolves once any in-flight drain has settled. For tests and shutdown. */
  settled(): Promise<void>;
};

/** The last observation this session made of one foreign file. */
type LastSeen = {
  sha256: string;
  bytes: number;
  session_id: string | null;
  seq_high: number | null;
  last_hash: string | null;
  /** False once a `disappeared` has been emitted, so it is emitted only once. */
  present: boolean;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Only `.slog` files are witnessed.
 *
 * `.slog.meta` carries the session key and the checkpoints, not the chain a
 * witness commits to, and the payload's `session_id` / `seq_high` / `last_hash`
 * are by definition reads of a `.slog`. `manifest-<id>.json` / `.sig` are the
 * rolling seal, which the loader already reconciles against the logs present.
 * Note `endsWith('.slog')` is false for `foo.slog.meta`, which is the intent.
 */
export function isWitnessableLogName(basename: string): boolean {
  return basename.endsWith('.slog');
}

/** sha256, lowercase hex, over the file's exact bytes (rule 8). */
function sha256HexOfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * What a foreign log's chain says about itself: its logical session id, its
 * highest `seq`, and the `hash` at that `seq`.
 *
 * All three or none — rule 6, and the reader's `partially_parsed` rejection. A
 * log that parses but carries no `session.start`, or whose `session_id` is not a
 * string, cannot be named, so the honest answer is that the chain was not read.
 *
 * Exported for the unit tests, which drive real recorder-produced logs through
 * it rather than hand-built ones.
 */
export function readForeignChainTip(text: string): {
  session_id: string | null;
  seq_high: number | null;
  last_hash: string | null;
} {
  const NOTHING = { session_id: null, seq_high: null, last_hash: null };

  const parsed = parseEntries(text);
  if (!parsed.ok || parsed.value.length === 0) return NOTHING;

  let sessionId: string | null = null;
  let seqHigh: number | null = null;
  let lastHash: string | null = null;

  for (const entry of parsed.value) {
    if (entry.kind === 'session.start') {
      const data = entry.data as Record<string, unknown> | null;
      const id = data === null ? undefined : data['session_id'];
      if (typeof id === 'string' && id.length > 0) sessionId = id;
    }
    // `>` and an explicit null check, never truthiness: seq 0 is a real seq.
    if (seqHigh === null || entry.seq > seqHigh) {
      seqHigh = entry.seq;
      lastHash = entry.hash;
    }
  }

  if (sessionId === null || seqHigh === null || lastHash === null) return NOTHING;
  return { session_id: sessionId, seq_high: seqHigh, last_hash: lastHash };
}

/**
 * The state this observation describes, given the previous one.
 *
 * Rule 9: descriptive, never a verdict, and never an input to what the witness
 * proves — `reconcileWitnesses` reaches its five verdicts from `seq_high` +
 * `last_hash` alone and never reads `state`.
 *
 * The one shape none of the five names exactly is a rewrite that leaves the
 * length unchanged. It is reported as `'grew'`, deliberately: `bytes` is emitted
 * beside it so a reader sees the length did not change, whereas `'shrank'` is
 * the state the format's own notes describe as "catches a truncation", and
 * reaching for it on a same-length rewrite would lean the descriptive field
 * toward accusation. This system fails toward the reading that does not accuse.
 */
function stateFor(previous: LastSeen | undefined, bytes: number): PeerObservedPayload['state'] {
  if (previous === undefined || !previous.present) return 'appeared';
  return bytes < previous.bytes ? 'shrank' : 'grew';
}

// ---------------------------------------------------------------------------
// startPeerWatcher
// ---------------------------------------------------------------------------

export function startPeerWatcher(deps: PeerWatcherDeps): PeerWatcher {
  const { provenanceDir, isOwnFile, emit, readFile, createWatcher } = deps;

  /**
   * Basenames seen since the last drain. A SET, which is the rate limit: at most
   * one observation per file per drain no matter how many events arrived.
   */
  const queued = new Set<string>();
  const lastSeen = new Map<string, LastSeen>();

  const subscriptions: PeerWatcherDisposable[] = [];
  let watcher: ProvenanceDirWatcher | undefined;
  let disposed = false;

  /** Serializes drains against each other. Never rejects. */
  let drainChain: Promise<void> = Promise.resolve();

  /**
   * The watcher callback. Rule 2: this is the whole of it — a basename, two
   * string comparisons and a `Set.add`. No I/O, no hashing, no parsing.
   */
  function enqueue(fsPath: string): void {
    if (disposed) return;
    const name = path.basename(fsPath);
    if (!isWitnessableLogName(name)) return;
    if (isOwnFile(name)) return; // rule 4 — never witness ourselves
    queued.add(name);
  }

  try {
    watcher = createWatcher();
    subscriptions.push(watcher.onDidCreate(enqueue));
    subscriptions.push(watcher.onDidChange(enqueue));
    subscriptions.push(watcher.onDidDelete(enqueue));
  } catch (e) {
    // A watcher that cannot be created costs witnessing, never recording.
    console.warn('[provenance] peer watcher: failed to watch .provenance/:', e);
  }

  /**
   * Observe ONE queued file. Returns the payload to emit, or `null` when there
   * is nothing new or nothing honest to say.
   *
   * Everything asynchronous happens here, and nothing here emits. That split is
   * what keeps the chain advance atomic — see {@link drainOnce}.
   */
  async function observe(name: string): Promise<PeerObservedPayload | null> {
    const previous = lastSeen.get(name);
    const abs = path.join(provenanceDir, name);

    const read = await readFile(abs);

    if (!read.ok) {
      // A local read failure is not a fact about a partner's file. Only an
      // actual absence is, and only if we ever saw the file present — with no
      // prior observation there is no last state to report and inventing a
      // digest would be manufacturing evidence.
      if (read.reason !== 'gone') return null;
      if (previous === undefined || !previous.present) return null;

      lastSeen.set(name, { ...previous, present: false });
      return {
        file: name,
        sha256: previous.sha256,
        bytes: previous.bytes,
        session_id: previous.session_id,
        seq_high: previous.seq_high,
        last_hash: previous.last_hash,
        state: 'disappeared',
      };
    }

    const digest = sha256HexOfBytes(read.bytes);
    const size = read.bytes.byteLength;

    // Unchanged bytes say nothing new. Skipping is the rate limit doing its job,
    // and it consumes no `seq`: nothing is chained, so the chain stays
    // contiguous and validation check 4 sees no hole.
    if (previous !== undefined && previous.present && previous.sha256 === digest) {
      return null;
    }

    let tip: { session_id: string | null; seq_high: number | null; last_hash: string | null };
    try {
      tip = readForeignChainTip(new TextDecoder().decode(read.bytes));
    } catch {
      tip = { session_id: null, seq_high: null, last_hash: null };
    }

    // Rule 5: a log we cannot read gets `unparseable` and all-null chain fields,
    // and that is the ENTIRE response. The file is not renamed, not rewritten,
    // not deleted, not quarantined.
    const unread = tip.session_id === null;
    const state: PeerObservedPayload['state'] = unread ? 'unparseable' : stateFor(previous, size);

    lastSeen.set(name, {
      sha256: digest,
      bytes: size,
      session_id: tip.session_id,
      seq_high: tip.seq_high,
      last_hash: tip.last_hash,
      present: true,
    });

    // Every key is present, including the nulls (rule 6). Spreading a
    // conditional object here instead would change the canonical bytes and
    // therefore the chain hash.
    return {
      file: name,
      sha256: digest,
      bytes: size,
      session_id: tip.session_id,
      seq_high: tip.seq_high,
      last_hash: tip.last_hash,
      state,
    };
  }

  async function drainOnce(): Promise<void> {
    if (disposed) return;
    if (queued.size === 0) return;

    // Snapshot and clear first, so events arriving during the reads below are
    // queued for the NEXT drain rather than lost or double-observed. Sorted so
    // a drain of several files emits in a deterministic order.
    const batch = [...queued].sort();
    queued.clear();

    const payloads: PeerObservedPayload[] = [];
    for (const name of batch) {
      try {
        const payload = await observe(name);
        if (payload !== null) payloads.push(payload);
      } catch (e) {
        // Best effort, per file: one unreadable log must not cost the others.
        console.warn(`[provenance] peer watcher: failed to observe ${name}:`, e);
      }
    }

    if (disposed) return;

    // THE CHAIN-ADVANCE SEAM. Every await is above this line. `sessionHost.emit`
    // reads `prevHash`, chains, and advances `seq`/`prevHash` with no await
    // inside it, and this loop adds none — so no other emitter (doc.change, the
    // heartbeat, git wiring) can observe a half-advanced chain. Introducing an
    // `await` into this loop reintroduces the interleaving that manufactures
    // `chain_integrity` and `seq_gaps` findings against innocent students.
    // Pinned by peer-watcher.test.ts's "the chain advance is atomic" case.
    for (const payload of payloads) {
      emit(payload);
    }
  }

  return {
    drain(): Promise<void> {
      drainChain = drainChain.then(() =>
        drainOnce().catch((e: unknown) => {
          console.warn('[provenance] peer watcher: drain error:', e);
        }),
      );
      return drainChain;
    },

    settled(): Promise<void> {
      return drainChain;
    },

    dispose(): void {
      disposed = true;
      for (const s of subscriptions) {
        try {
          s.dispose();
        } catch {
          // Best effort.
        }
      }
      subscriptions.length = 0;
      try {
        watcher?.dispose();
      } catch {
        // Best effort.
      }
      watcher = undefined;
      queued.clear();
      lastSeen.clear();
    },
  };
}
