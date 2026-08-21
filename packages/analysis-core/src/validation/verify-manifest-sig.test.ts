/**
 * Tests for Check 1 — Bundle manifest signature.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import JSZip from 'jszip';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { verifyManifestSig } from './verify-manifest-sig.js';

// Wire SHA-512 for jsdom compatibility (same pattern as build-test-bundle).
beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('verifyManifestSig', () => {
  it('returns pass for a well-formed bundle with a valid signature', async () => {
    const { blob } = await buildTestBundle();
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = await verifyManifestSig(result.value);
    expect(check.id).toBe('manifest_sig');
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/Verified against session/);
  });

  it('returns pass for a multi-session bundle (most-recent session pubkey used)', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = await verifyManifestSig(result.value);
    expect(check.status).toBe('pass');
  });

  it('returns fail when manifest.sig is not valid hex', async () => {
    const { blob } = await buildTestBundle();
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Corrupt the sig in the bundle object directly.
    const bundle = {
      ...result.value,
      manifestSigHex: 'not-hex!!!',
    };

    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/not valid hex/);
  });

  it('returns fail when the signature is valid hex but does not match any session pubkey', async () => {
    const { blob } = await buildTestBundle();
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bundle = {
      ...result.value,
      // Replace sig with a valid-hex but wrong signature.
      manifestSigHex: 'ab'.repeat(32),
    };

    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/did not verify/);
  });

  // -------------------------------------------------------------------------
  // A defect is not automatically a signature failure.
  //
  // Every rolling-seal defect used to be pushed into `problems` and fail this
  // check unconditionally. Some defects genuinely impugn a signature (an
  // unsigned manifest, a manifest that will not parse, a seal naming another
  // session). `ambiguous_session_log` does not: its own type docstring says it
  // "is NOT an integrity finding on its own", and the text bug 12 wrote for it
  // ends "a fact about the archive, not evidence of tampering on its own" —
  // rendered, until now, underneath a title asserting the signature failed.
  // -------------------------------------------------------------------------
  describe('a duplicated log is a fact about the archive, not a signature failure', () => {
    /** Copy a session's `.slog` + `.slog.meta` under a second filename uuid. */
    async function duplicateLog(
      zipBuffer: ArrayBuffer,
      fromFileUuid: string,
      toFileUuid: string,
    ): Promise<ArrayBuffer> {
      const zip = await JSZip.loadAsync(zipBuffer);
      const from = `session-${fromFileUuid}`;
      const to = `session-${toFileUuid}`;
      zip.file(`${to}.slog`, await zip.file(`${from}.slog`)!.async('uint8array'));
      zip.file(`${to}.slog.meta`, await zip.file(`${from}.slog.meta`)!.async('uint8array'));
      return zip.generateAsync({ type: 'arraybuffer' });
    }

    it('PASSES check 1 when the only defect is a duplicated log', async () => {
      // The honest shape: a student kept a copy of their own `.provenance/`
      // directory — a hand copy, a backup before a push, an odd merge. Every
      // rolling signature in this bundle verifies perfectly against its own
      // session's key. Nothing about the signature is wrong, so check 1 —
      // whose label is "Bundle manifest signature" — must not fail.
      const { zipBuffer, logFileIds } = await buildTestBundle({
        sessions: [{ eventCount: 4 }],
        rollingSeal: {},
      });

      const dup = await duplicateLog(
        zipBuffer,
        logFileIds[0]!,
        '99999999-0000-4000-8000-000000000000',
      );
      const result = await loadBundle(dup, 'git-clone.zip');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The loader DID detect the duplication — this is the precondition, and
      // if it ever stops holding the test below passes vacuously.
      expect(
        result.value.rollingSeal!.defects.some((d) => d.kind === 'ambiguous_session_log'),
      ).toBe(true);

      const check = await verifyManifestSig(result.value);
      expect(check.status).toBe('pass');
    });

    it('still REPORTS the duplication, rather than hiding it to reach a pass', async () => {
      // Failing toward fewer findings is the other way to get this wrong. The
      // fact stays visible in check 1's own detail; only the VERDICT changes.
      const { zipBuffer, logFileIds, sessionIds } = await buildTestBundle({
        sessions: [{ eventCount: 4 }],
        rollingSeal: {},
      });

      const dup = await duplicateLog(
        zipBuffer,
        logFileIds[0]!,
        '99999999-0000-4000-8000-000000000000',
      );
      const result = await loadBundle(dup, 'git-clone.zip');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const check = await verifyManifestSig(result.value);
      expect(check.detail).toContain(sessionIds[0]!);
      expect(check.detail).toContain('not evidence of tampering');
      // And it does not describe itself as a verification failure.
      expect(check.detail).not.toMatch(/did not fully verify/);
    });

    it('still FAILS when a real signature defect accompanies the duplication', async () => {
      // The over-correction guard. A duplicated log must not launder an
      // unsigned manifest into a pass: the two are independent, and the
      // signature-impugning one still decides the verdict.
      const { zipBuffer, logFileIds } = await buildTestBundle({
        sessions: [{ eventCount: 4 }],
        rollingSeal: { tamper: { omitSigFor: [0] } },
      });

      const dup = await duplicateLog(
        zipBuffer,
        logFileIds[0]!,
        '99999999-0000-4000-8000-000000000000',
      );
      const result = await loadBundle(dup, 'git-clone.zip');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const defects = result.value.rollingSeal!.defects;
      expect(defects.some((d) => d.kind === 'ambiguous_session_log')).toBe(true);
      expect(defects.some((d) => d.kind === 'missing_sig')).toBe(true);

      const check = await verifyManifestSig(result.value);
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/unsigned/);
      // The archive fact is still stated on the FAIL path too — the partition
      // decides the verdict, it never decides what a reader is told.
      expect(check.detail).toContain('not evidence of tampering');
    });
  });
});
