/**
 * SessionWriter — owns the open FileHandle for the `.slog` file.
 *
 * CLAUDE.md: "The session writer is a class because it owns a file handle."
 * PRD §4.7: "flush every 1s or 256KB, whichever comes first."
 * PRD §4.6: "Append-only writes; we never rewrite earlier lines."
 *
 * Design notes:
 *
 * - append() is synchronous so the VS Code event handlers never block (CLAUDE.md:
 *   "doc.change handlers must run in < 1 ms p99"). It enqueues the serialized line
 *   and kicks off an async flush when the buffer policy says to.
 *
 * - Concurrent flush() calls serialize via flushChain:
 *     this.flushChain = this.flushChain.then(() => this._doFlush())
 *   This guarantees write ordering (CLAUDE.md: "No Promise.all over operations that
 *   must be ordered. Log writes are ordered.").
 *
 * - On write error we call onError and DROP the buffered lines rather than restoring
 *   them. Restoring would risk duplicate writes on the next flush if the underlying
 *   write partially succeeded before the error. Callers that want durability should
 *   surface the error (e.g., emit a recorder.degraded event) and stop the session.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
  HashedEnvelope,
  serializeEntry,
  shouldFlush,
  DEFAULT_BUFFER_POLICY,
  BufferPolicyConfig,
  Clock,
} from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionWriterOptions = {
  slogPath: string;
  clock: Clock;
  bufferPolicy?: Partial<BufferPolicyConfig>;
  /** Called for non-fatal write errors. Receives the error; writer continues. */
  onError?: (error: Error) => void;
};

// ---------------------------------------------------------------------------
// SessionWriter
// ---------------------------------------------------------------------------

export class SessionWriter {
  private readonly clock: Clock;
  private readonly bufferPolicy: Partial<BufferPolicyConfig>;
  private readonly onError: (error: Error) => void;

  private fh: fsPromises.FileHandle;
  private buffer: string[] = [];
  private bufferedBytes = 0;
  /**
   * Total bytes appended over this writer's lifetime. Unlike {@link bufferedBytes}
   * it is NEVER reset by a flush, so it equals the `.slog`'s size on disk once
   * everything is flushed. Size rotation (PRD §4.6) reads it at checkpoint
   * cadence; nothing on the hot path does more than one addition here.
   */
  private totalBytes = 0;
  private lastFlushAtMs: number;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  // Serializes concurrent flush() calls so writes are ordered.
  private flushChain: Promise<void> = Promise.resolve();

  private constructor(
    slogPath: string,
    clock: Clock,
    bufferPolicy: Partial<BufferPolicyConfig>,
    onError: (error: Error) => void,
    fh: fsPromises.FileHandle,
  ) {
    this.clock = clock;
    this.bufferPolicy = bufferPolicy;
    this.onError = onError;
    this.fh = fh;
    this.lastFlushAtMs = clock.now();

    const maxIntervalMs = bufferPolicy.maxIntervalMs ?? DEFAULT_BUFFER_POLICY.maxIntervalMs;

    // Periodic flush — .unref() so the timer doesn't keep the VS Code process alive.
    this.flushTimer = setInterval(() => {
      if (!this.disposed) {
        void this.flush();
      }
    }, maxIntervalMs);
    this.flushTimer.unref();
  }

  /**
   * Open the `.slog` file for appending and return a ready SessionWriter.
   * Creates the directory if it does not exist (recursive: true).
   */
  static async open(options: SessionWriterOptions): Promise<SessionWriter> {
    const { slogPath, clock, bufferPolicy = {}, onError = () => undefined } = options;

    await fsPromises.mkdir(path.dirname(slogPath), { recursive: true });
    const fh = await fsPromises.open(slogPath, 'a');

    return new SessionWriter(slogPath, clock, bufferPolicy, onError, fh);
  }

  /** Cumulative bytes appended (written + buffered). See {@link totalBytes}. */
  get bytesAppended(): number {
    return this.totalBytes;
  }

  /**
   * Synchronously enqueue an entry for writing.
   * Kicks off a background flush if the buffer policy says to.
   * Throws if called after dispose().
   */
  append(entry: HashedEnvelope): void {
    if (this.disposed) {
      throw new Error('[SessionWriter] append() called after dispose()');
    }

    const line = serializeEntry(entry);
    this.buffer.push(line);
    const lineBytes = Buffer.byteLength(line, 'utf8');
    this.bufferedBytes += lineBytes;
    this.totalBytes += lineBytes;

    if (
      shouldFlush(
        {
          bufferedBytes: this.bufferedBytes,
          lastFlushAtMs: this.lastFlushAtMs,
          nowMs: this.clock.now(),
        },
        this.bufferPolicy,
      )
    ) {
      // Fire-and-forget: append() must not block the calling event handler.
      void this.flush();
    }
  }

  /**
   * Force-flush whatever is buffered.
   * Returns a promise that resolves when the flush is complete.
   * Concurrent calls are serialized via flushChain.
   */
  flush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this._doFlush());
    return this.flushChain;
  }

  /**
   * Internal: do the actual write. Called only through flushChain.
   */
  private async _doFlush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    // Snapshot and clear the buffer immediately.
    // If the write fails, lines are DROPPED (see design note at top of file).
    const snapshot = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;

    const data = snapshot.join('');

    try {
      await this.fh.write(data);
      this.lastFlushAtMs = this.clock.now();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      // Lines are already dropped from the buffer. Call onError so callers can react.
      this.onError(error);
    }
  }

  /**
   * Flush pending entries, close the file handle, and mark the writer as disposed.
   * Idempotent: safe to call more than once.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Final flush — wait for any in-flight flush to settle first.
    await this.flush();

    try {
      await this.fh.close();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.onError(error);
    }
  }
}
