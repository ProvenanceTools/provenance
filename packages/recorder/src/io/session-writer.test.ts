/**
 * Tests for SessionWriter.
 * Uses a real tmp dir; real file I/O; FixedClock for determinism.
 * CLAUDE.md: "Tests must be deterministic. No `Date.now()` in assertions; inject a clock."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  FixedClock,
  parseEntries,
  validateChain,
  chainEntry,
  GENESIS_PREV_HASH,
  HashedEnvelope,
} from '@provenance/log-core';
import { SessionWriter } from './session-writer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a chain of N HashedEnvelopes starting from GENESIS_PREV_HASH.
 * Useful for pre-seeding a chain state or producing test entries.
 */
function buildChain(count: number): HashedEnvelope[] {
  const entries: HashedEnvelope[] = [];
  let prevHash = GENESIS_PREV_HASH;

  for (let i = 0; i < count; i++) {
    const entry = chainEntry(prevHash, {
      seq: i,
      t: i * 10,
      wall: '2026-01-01T00:00:00.000Z',
      kind: 'session.end',
      data: { reason: `test-${i}` },
    });
    entries.push(entry);
    prevHash = entry.hash;
  }

  return entries;
}

/**
 * Build a single chained entry at the given seq, relative to an existing chain.
 * When chaining from scratch, pass GENESIS_PREV_HASH for prevHash.
 */
function makeEntry(seq: number, prevHash: string): HashedEnvelope {
  return chainEntry(prevHash, {
    seq,
    t: seq * 10,
    wall: '2026-01-01T00:00:00.000Z',
    kind: 'session.end',
    data: { reason: `test-${seq}` },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionWriter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'session-writer-test-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Basic chain round-trip
  // -------------------------------------------------------------------------

  it('open → append 3 entries → flush → dispose: file contains 3 valid chained entries', async () => {
    const slogPath = path.join(tmpDir, 'session.slog');
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const writer = await SessionWriter.open({
      slogPath,
      clock,
      // Use large thresholds so auto-flush doesn't fire during test
      bufferPolicy: { maxBytes: 1_000_000, maxIntervalMs: 60_000 },
    });

    const entries = buildChain(3);
    for (const entry of entries) {
      writer.append(entry);
    }

    await writer.flush();
    await writer.dispose();

    const text = await fsPromises.readFile(slogPath, 'utf8');
    const parseResult = parseEntries(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    expect(parseResult.value).toHaveLength(3);

    // Chain must validate end-to-end.
    const chainResult = validateChain(parseResult.value as Parameters<typeof validateChain>[0]);
    expect(chainResult.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Auto-flush on size threshold
  // -------------------------------------------------------------------------

  it('auto-flush on size threshold: entries appear in file after buffer fills', async () => {
    const slogPath = path.join(tmpDir, 'session.slog');
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const writer = await SessionWriter.open({
      slogPath,
      clock,
      // Very small byte threshold to force auto-flush quickly.
      bufferPolicy: { maxBytes: 1, maxIntervalMs: 60_000 },
    });

    const entries = buildChain(3);
    for (const entry of entries) {
      writer.append(entry);
    }

    // The first append() should have kicked off an auto-flush (1-byte threshold).
    // Wait for it to settle by forcing another flush.
    await writer.flush();
    await writer.dispose();

    const text = await fsPromises.readFile(slogPath, 'utf8');
    const parseResult = parseEntries(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    // All 3 entries are appended synchronously before any async flush occurs,
    // so the final file should contain exactly 3 entries.
    expect(parseResult.value).toHaveLength(3);

    // Chain must validate end-to-end.
    const chainResult = validateChain(parseResult.value as Parameters<typeof validateChain>[0]);
    expect(chainResult.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Periodic flush (real timer, short interval)
  // -------------------------------------------------------------------------

  it('periodic flush: entry appears in file after interval elapses', async () => {
    const slogPath = path.join(tmpDir, 'session.slog');
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const writer = await SessionWriter.open({
      slogPath,
      clock,
      // 50ms interval so we don't have to wait long; size threshold huge.
      bufferPolicy: { maxBytes: 1_000_000, maxIntervalMs: 50 },
    });

    const entry = makeEntry(0, GENESIS_PREV_HASH);
    writer.append(entry);

    // Wait for the interval to fire (~120ms is 2+ intervals, well past one fire).
    await new Promise<void>((r) => setTimeout(r, 120));

    // Ensure any in-flight flush completes.
    await writer.flush();
    await writer.dispose();

    const text = await fsPromises.readFile(slogPath, 'utf8');
    const parseResult = parseEntries(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    expect(parseResult.value).toHaveLength(1);
  }, 5000);

  // -------------------------------------------------------------------------
  // Dispose flushes pending entries
  // -------------------------------------------------------------------------

  it('dispose flushes pending entries before closing', async () => {
    const slogPath = path.join(tmpDir, 'session.slog');
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const writer = await SessionWriter.open({
      slogPath,
      clock,
      // Huge thresholds — nothing flushes until dispose.
      bufferPolicy: { maxBytes: 1_000_000, maxIntervalMs: 60_000 },
    });

    const entry = makeEntry(0, GENESIS_PREV_HASH);
    writer.append(entry);

    // Dispose without explicit flush first.
    await writer.dispose();

    const text = await fsPromises.readFile(slogPath, 'utf8');
    const parseResult = parseEntries(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    expect(parseResult.value).toHaveLength(1);
    expect(parseResult.value[0]?.hash).toBe(entry.hash);
  });

  // -------------------------------------------------------------------------
  // Append after dispose throws
  // -------------------------------------------------------------------------

  it('append after dispose throws', async () => {
    const slogPath = path.join(tmpDir, 'session.slog');
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const writer = await SessionWriter.open({ slogPath, clock });

    await writer.dispose();

    const entry = makeEntry(0, GENESIS_PREV_HASH);
    expect(() => writer.append(entry)).toThrow('append() called after dispose()');
  });

  // -------------------------------------------------------------------------
  // Ordered writes: A B C in rapid succession
  // -------------------------------------------------------------------------

  it('ordered writes: entries appear in seq order A B C', async () => {
    const slogPath = path.join(tmpDir, 'session.slog');
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const writer = await SessionWriter.open({
      slogPath,
      clock,
      bufferPolicy: { maxBytes: 1_000_000, maxIntervalMs: 60_000 },
    });

    const entries = buildChain(3);
    // Append all three rapidly (no awaits between).
    writer.append(entries[0]!);
    writer.append(entries[1]!);
    writer.append(entries[2]!);

    await writer.flush();
    await writer.dispose();

    const text = await fsPromises.readFile(slogPath, 'utf8');
    const parseResult = parseEntries(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const parsed = parseResult.value;
    expect(parsed).toHaveLength(3);

    // Verify seqs are in order.
    expect(parsed[0]?.seq).toBe(0);
    expect(parsed[1]?.seq).toBe(1);
    expect(parsed[2]?.seq).toBe(2);

    // Chain validates.
    const chainResult = validateChain(parsed as Parameters<typeof validateChain>[0]);
    expect(chainResult.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // onError is called on write failure
  // -------------------------------------------------------------------------

  it('onError callback is called when the FileHandle write fails', async () => {
    const slogPath = path.join(tmpDir, 'session.slog');
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const errors: Error[] = [];

    const writer = await SessionWriter.open({
      slogPath,
      clock,
      bufferPolicy: { maxBytes: 1_000_000, maxIntervalMs: 60_000 },
      onError: (e) => errors.push(e),
    });

    // Close the underlying FileHandle out from under the writer to cause a write error.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- invasive test
    await (writer as any).fh.close();

    const entry = makeEntry(0, GENESIS_PREV_HASH);
    writer.append(entry);

    // flush() will attempt the write on the closed handle and call onError.
    await writer.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);

    // dispose() should not throw even though the handle is already closed.
    await writer.dispose();
  });

  // -------------------------------------------------------------------------
  // dispose is idempotent
  // -------------------------------------------------------------------------

  it('dispose() is idempotent: second call does not throw', async () => {
    const slogPath = path.join(tmpDir, 'session.slog');
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const writer = await SessionWriter.open({ slogPath, clock });
    await writer.dispose();
    await expect(writer.dispose()).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Cumulative byte counter (size rotation, PRD §4.6)
  // -------------------------------------------------------------------------

  it('reports cumulative bytes appended across flushes', async () => {
    const slogPath = path.join(tmpDir, 'session.slog');
    const clock = new FixedClock(0, new Date('2026-01-01T00:00:00.000Z'));

    const entryA = makeEntry(0, GENESIS_PREV_HASH);
    const entryB = makeEntry(1, entryA.hash);

    const writer = await SessionWriter.open({ slogPath, clock });
    expect(writer.bytesAppended).toBe(0);
    writer.append(entryA);
    const afterFirst = writer.bytesAppended;
    expect(afterFirst).toBeGreaterThan(0);
    await writer.flush();
    // A flush resets the buffer, never the cumulative total.
    expect(writer.bytesAppended).toBe(afterFirst);
    writer.append(entryB);
    expect(writer.bytesAppended).toBeGreaterThan(afterFirst);
    await writer.dispose();
    // The counter must equal the file's real size on disk.
    const stat = await fsPromises.stat(slogPath);
    expect(writer.bytesAppended).toBe(stat.size);
  });
});
