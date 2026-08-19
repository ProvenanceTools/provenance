/**
 * Unit tests for parseSession.
 *
 * Builds raw slog text and meta JSON using the test-bundle helper's internals
 * (via buildTestBundle + unzipBundle) and feeds them to parseSession directly.
 * This keeps tests fast and free of ZIP I/O overhead where possible.
 */

import { describe, it, expect } from 'vitest';
import { parseSession } from './parse-session.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { unzipBundle } from './unzip.js';
import type { SlogMeta } from '@provenance/log-core';

/**
 * Byte digests the loader would have computed from the ZIP. These tests are
 * about parse semantics, not the digests, so any well-formed pair does; they
 * are asserted for pass-through in the dedicated case below.
 */
const TEST_HASHES = { slogSha256: 'a'.repeat(64), metaSha256: 'b'.repeat(64) };

// ---------------------------------------------------------------------------
// Helper: extract raw files for the first session from a freshly built bundle.
// ---------------------------------------------------------------------------

async function getSessionFiles(sessionIndex = 0) {
  const { blob } = await buildTestBundle({ sessions: [{}, {}] });
  const unzipResult = await unzipBundle(blob);
  if (!unzipResult.ok) throw new Error('unzip failed in test setup');
  const sf = unzipResult.value.sessions[sessionIndex];
  if (sf === undefined) throw new Error(`no session at index ${sessionIndex}`);
  return sf;
}

/** Build a minimal valid SlogMeta JSON string for a given sessionId + pubkey. */
function makeMeta(sessionId: string, sessionPubkey: string): string {
  const meta: SlogMeta = {
    format_version: '1.0',
    session_id: sessionId,
    session_pubkey: sessionPubkey,
    encrypted_session_privkey: {
      algorithm: 'xchacha20-poly1305-hkdf-sha256-v1',
      nonce: 'ab'.repeat(12),
      ciphertext: 'cd'.repeat(48),
      salt: 'ef'.repeat(16),
      info: 'provenance-session-v1',
    },
    checkpoints: [],
  };
  return JSON.stringify(meta);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseSession', () => {
  it('round-trips a valid slog + meta into a typed ParsedSession', async () => {
    const sf = await getSessionFiles(0);
    const result = parseSession(sf.slogText, sf.metaJson, TEST_HASHES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(typeof result.value.sessionId).toBe('string');
    expect(result.value.events.length).toBeGreaterThan(0);
    expect(result.value.firstEvent.kind).toBe('session.start');
    expect(result.value.firstEvent.data.session_id).toBe(result.value.sessionId);
    expect(result.value.meta.session_id).toBe(result.value.sessionId);
  });

  it('firstEvent is narrowed to session.start with data typed as SessionStartPayload', async () => {
    const sf = await getSessionFiles(0);
    const result = parseSession(sf.slogText, sf.metaJson, TEST_HASHES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // TypeScript narrowing: these fields are present on SessionStartPayload
    const fe = result.value.firstEvent;
    expect(fe.kind).toBe('session.start');
    expect(typeof fe.data.format_version).toBe('string');
    expect(typeof fe.data.session_pubkey).toBe('string');
    expect(typeof fe.data.machine_id).toBe('string');
  });

  it('events array includes all envelopes (start + synthetic doc.change events)', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const unzipResult = await unzipBundle(blob);
    if (!unzipResult.ok) throw new Error('unzip failed in test setup');
    const sf = unzipResult.value.sessions[0]!;

    const result = parseSession(sf.slogText, sf.metaJson, TEST_HASHES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 1 session.start + 3 doc.change = 4 total
    expect(result.value.events).toHaveLength(4);
    expect(result.value.events[0]!.kind).toBe('session.start');
    expect(result.value.events[1]!.kind).toBe('doc.change');
  });

  it('returns ndjson_parse_failed with correct line number for corrupted NDJSON', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3 }],
      tamper: { corruptNdjsonAtLine: { sessionIndex: 0, line: 2 } },
    });
    const unzipResult = await unzipBundle(blob);
    if (!unzipResult.ok) throw new Error('unzip failed');
    const sf = unzipResult.value.sessions[0]!;

    const result = parseSession(sf.slogText, sf.metaJson, TEST_HASHES);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('ndjson_parse_failed');
    if (result.error.kind !== 'ndjson_parse_failed') return;
    expect(result.error.line).toBe(2);
    expect(typeof result.error.detail).toBe('string');
  });

  it('returns meta_invalid_shape for malformed meta JSON text', async () => {
    const sf = await getSessionFiles(0);
    const result = parseSession(sf.slogText, 'NOT { valid json }', TEST_HASHES);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('meta_invalid_shape');
  });

  it('returns meta_invalid_shape for meta that fails shape validation', async () => {
    const sf = await getSessionFiles(0);
    // Valid JSON but wrong shape (missing required fields)
    const badMeta = JSON.stringify({ format_version: '1.0', session_id: 'x' });
    const result = parseSession(sf.slogText, badMeta, TEST_HASHES);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('meta_invalid_shape');
  });

  it('returns first_event_not_session_start when first envelope kind != session.start', async () => {
    // Build a slog whose first line is a doc.change, not a session.start.
    // Easiest: take a valid slog, remove its first line, then prepend a doc.change line.
    const sf = await getSessionFiles(0);

    // Replace the first line with something that has the right shape but wrong kind.
    const lines = sf.slogText.trim().split('\n');
    const firstLineObj = JSON.parse(lines[0]!) as Record<string, unknown>;
    firstLineObj['kind'] = 'doc.change';
    firstLineObj['data'] = {
      path: '/x.py',
      deltas: [],
      source: 'typed',
    };
    lines[0] = JSON.stringify(firstLineObj);
    const tamperedSlog = lines.join('\n') + '\n';

    const result = parseSession(tamperedSlog, sf.metaJson, TEST_HASHES);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('first_event_not_session_start');
    if (result.error.kind !== 'first_event_not_session_start') return;
    expect(result.error.actualKind).toBe('doc.change');
  });

  it('returns session_id_mismatch when meta session_id does not match slog session_id', async () => {
    const sf = await getSessionFiles(0);
    // Build a meta with a different session_id but a valid-looking pubkey.
    // Parse the original meta to get the pubkey.
    const originalMeta = JSON.parse(sf.metaJson) as SlogMeta;
    const mismatchedMeta = makeMeta(
      '00000000-ffff-4000-8000-000000000000',
      originalMeta.session_pubkey,
    );

    const result = parseSession(sf.slogText, mismatchedMeta, TEST_HASHES);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('session_id_mismatch');
    if (result.error.kind !== 'session_id_mismatch') return;
    expect(result.error.metaSessionId).toBe('00000000-ffff-4000-8000-000000000000');
    expect(typeof result.error.slogSessionId).toBe('string');
  });
});
