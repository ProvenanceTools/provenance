/**
 * Tests for Check 2 — Session binding.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { verifySessionBinding } from './verify-session-binding.js';
import {
  buildTrustChainKeys,
  buildManifest2,
  sessionStart2,
} from '../test-support/build-manifest-2.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('verifySessionBinding', () => {
  it('returns pass for a single-session bundle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{}] });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = await verifySessionBinding(result.value);
    expect(check.id).toBe('session_binding');
    expect(check.status).toBe('pass');
  });

  it('returns pass for a multi-session bundle where all sessions share the same manifest_sig', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3 }, { eventCount: 3 }, { eventCount: 3 }],
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = await verifySessionBinding(result.value);
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/3 sessions share/);
  });

  it('returns fail when one session has a different manifest_sig', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
      tamper: {
        mismatchManifestSig: {
          sessionIndex: 1,
          manifest_sig: 'different-sig-from-another-assignment',
        },
      },
    });
    // loadBundle will succeed (this tamper doesn't break structural validity).
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = await verifySessionBinding(result.value);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/different assignment manifest/);
    expect(check.supportingSeqs).toHaveLength(1);
    expect(check.supportingSeqs?.[0]?.seq).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Manifest 2.0 — the check becomes a real cryptographic verification.
//
// The 1.x cases above are the permanent-support regression suite: they must
// keep passing byte-for-byte forever (program spec §9).
// ---------------------------------------------------------------------------

describe('verifySessionBinding — Manifest 2.0', () => {
  it('verifies root -> course_cert -> manifest -> every session', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys });
    const { blob } = await buildTestBundle({
      sessions: [
        { sessionStart: sessionStart2(manifest) },
        { sessionStart: sessionStart2(manifest) },
      ],
    });
    const result = await loadBundle(blob, 'test.zip');
    if (!result.ok) throw new Error('load failed');

    const check = await verifySessionBinding(result.value, {
      rootPubkeyHex: keys.rootPubkeyHex,
    });
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/Trust chain verified offline/);
    expect(check.detail).toMatch(/berkeley-cs61b/);
  });

  it('fails when the certificate was not signed by the configured root key', async () => {
    const keys = await buildTrustChainKeys();
    const other = await buildTrustChainKeys(0x55, 0x66);
    const manifest = await buildManifest2({ keys });
    const { blob } = await buildTestBundle({
      sessions: [{ sessionStart: sessionStart2(manifest) }],
    });
    const result = await loadBundle(blob, 'test.zip');
    if (!result.ok) throw new Error('load failed');

    const check = await verifySessionBinding(result.value, {
      rootPubkeyHex: other.rootPubkeyHex,
    });
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/root public key/);
  });

  it("fails when one course's key signs a manifest claiming another course", async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys,
      courseId: 'berkeley-cs61c',
      certCourseId: 'berkeley-cs61b',
    });
    const { blob } = await buildTestBundle({
      sessions: [{ sessionStart: sessionStart2(manifest) }],
    });
    const result = await loadBundle(blob, 'test.zip');
    if (!result.ok) throw new Error('load failed');

    const check = await verifySessionBinding(result.value, {
      rootPubkeyHex: keys.rootPubkeyHex,
    });
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/does not match certificate course_id/);
  });

  it('fails when the signed capture policy was edited after signing', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys,
      policy: { capture: { selection_change: true } },
    });
    // The off switch a student would want: disable capture, keep the signature.
    const tampered = { ...manifest, policy: { capture: { selection_change: false } } };
    const { blob } = await buildTestBundle({
      sessions: [{ sessionStart: sessionStart2(tampered) }],
    });
    const result = await loadBundle(blob, 'test.zip');
    if (!result.ok) throw new Error('load failed');

    const check = await verifySessionBinding(result.value, {
      rootPubkeyHex: keys.rootPubkeyHex,
    });
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/certified course public key/);
  });

  it('fails when a session binds to a different manifest than the one it carries', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys });
    const { blob } = await buildTestBundle({
      sessions: [
        { sessionStart: sessionStart2(manifest) },
        { sessionStart: { ...sessionStart2(manifest), manifest_sig: 'b'.repeat(128) } },
      ],
    });
    const result = await loadBundle(blob, 'test.zip');
    if (!result.ok) throw new Error('load failed');

    const check = await verifySessionBinding(result.value, {
      rootPubkeyHex: keys.rootPubkeyHex,
    });
    expect(check.status).toBe('fail');
    expect(check.supportingSeqs).toHaveLength(1);
  });

  it('reports skipped, not pass, when no root public key is configured', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys });
    const { blob } = await buildTestBundle({
      sessions: [{ sessionStart: sessionStart2(manifest) }],
    });
    const result = await loadBundle(blob, 'test.zip');
    if (!result.ok) throw new Error('load failed');

    const check = await verifySessionBinding(result.value);
    expect(check.status).toBe('skipped');
    expect(check.detail).toMatch(/no root public key is configured/);
  });

  it('passes but flags an expired certificate rather than failing the bundle', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys, issuedAt: '2027-06-01T00:00:00Z' });
    const { blob } = await buildTestBundle({
      sessions: [{ sessionStart: sessionStart2(manifest) }],
    });
    const result = await loadBundle(blob, 'test.zip');
    if (!result.ok) throw new Error('load failed');

    const check = await verifySessionBinding(result.value, {
      rootPubkeyHex: keys.rootPubkeyHex,
    });
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/after_valid_until/);
  });

  it('ignores the root key entirely for a 1.x bundle (permanent 1.x support)', async () => {
    const keys = await buildTrustChainKeys();
    const { blob } = await buildTestBundle({ sessions: [{}, {}] });
    const result = await loadBundle(blob, 'test.zip');
    if (!result.ok) throw new Error('load failed');

    const check = await verifySessionBinding(result.value, {
      rootPubkeyHex: keys.rootPubkeyHex,
    });
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/2 sessions share the same manifest_sig/);
  });
});
