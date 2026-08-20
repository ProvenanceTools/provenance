/**
 * Tests for the READ side of the rolling seal (program spec §8, S3).
 *
 * These build real in-memory ZIPs shaped like a git-submitted `.provenance/` —
 * `manifest-<session_id>.json` + `.sig` per session, no `manifest.json` — and
 * drive the whole loader + validation path over them.
 *
 * The first `describe` block is the load-bearing one: it proves a CLASSIC sealed
 * bundle is untouched by all of this. Everything else is new behaviour.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import JSZip from 'jszip';
import {
  canonicalize,
  parseRollingManifestFilename,
  rollingManifestFilenames,
} from '@provenance/log-core';
import { loadBundle } from './parse-bundle.js';
import { unzipBundle } from './unzip.js';
import { synthesizeRollingUnionManifest, validateRollingSeals } from './rolling-seal.js';
import { runValidation } from '../validation/run-validation.js';
import { verifyManifestSig } from '../validation/verify-manifest-sig.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { asLogicalSessionId } from './types.js';
import type { RollingSeal } from './types.js';

// Wire SHA-512 for jsdom compatibility (same pattern as build-test-bundle).
beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

const FIXED_NOW = '2026-01-01T12:00:00.000Z';
const fixedNow = (): string => FIXED_NOW;

/** Entry names inside a built ZIP, sorted. */
async function zipEntryNames(zipBuffer: ArrayBuffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(zipBuffer);
  return Object.keys(zip.files).sort();
}

// ---------------------------------------------------------------------------
// THE regression guard: a classic sealed bundle must be byte-for-byte unaffected.
// ---------------------------------------------------------------------------

describe('a classic sealed bundle is byte-for-byte unaffected', () => {
  it('carries no rolling manifests, so rollingSeal stays undefined', async () => {
    const { blob, zipBuffer } = await buildTestBundle({
      submissionFiles: [{ path: 'main.py', status: 'present', content: 'print(1)\n' }],
      sessions: [{ eventCount: 3, appendDocSave: true }],
    });

    // Nothing in a classic bundle can be read as a rolling seal. `manifest.json`
    // and `manifest.sig` deliberately do not match the pattern.
    for (const name of await zipEntryNames(zipBuffer)) {
      expect(parseRollingManifestFilename(name)).toBeNull();
    }

    const result = await loadBundle(blob, 'hw1.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.rollingSeal).toBeUndefined();
  });

  it('keeps the classic manifest bytes, the classic signature path and 1.1 version', async () => {
    const { blob, zipBuffer, manifest } = await buildTestBundle({
      submissionFiles: [{ path: 'main.py', status: 'present', content: 'print(1)\n' }],
      sessions: [{ eventCount: 3, appendDocSave: true }],
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const onDiskManifestJson = await zip.file('manifest.json')!.async('string');

    const result = await loadBundle(blob, 'hw1.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.value;

    // Same manifest, same version, same canonical bytes as on disk.
    expect(bundle.manifest.format_version).toBe('1.1');
    expect(bundle.manifest).toEqual(manifest);
    expect(canonicalize(bundle.manifest)).toBe(onDiskManifestJson);
    expect(bundle.manifestSigHex).not.toBeNull();

    // Same signature verification path, with the classic detail wording.
    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/^Verified against session /);
    // The rolling wording must never appear for a classic bundle.
    expect(check.detail).not.toMatch(/rolling/i);
  });

  it('produces the same validation report as before: all 8 checks, overall pass', async () => {
    const { blob } = await buildTestBundle({
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x5x4x3x2x1' }],
      sessions: [{ eventCount: 5, appendDocSave: true }],
    });
    const result = await loadBundle(blob, 'hw1.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = await runValidation(result.value);
    expect(report.checks).toHaveLength(8);
    expect(report.overall).toBe('pass');
    expect(report.checks.map((c) => c.status)).toEqual(Array(8).fill('pass'));
  });

  it('still reports missing_signature when a classic manifest has no sig', async () => {
    const { blob } = await buildTestBundle({ tamper: { omitSig: true } });
    const result = await loadBundle(blob, 'hw1.zip', fixedNow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing_signature');
  });

  it('a 1.0 legacy bundle is unaffected', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const result = await loadBundle(blob, 'hw1.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.format_version).toBe('1.0');
    expect(result.value.rollingSeal).toBeUndefined();
    expect(await verifyManifestSig(result.value)).toMatchObject({ status: 'pass' });
  });
});

// ---------------------------------------------------------------------------
// The happy path: a rolling-sealed bundle loads, and checks 1/2/8 are meaningful.
// ---------------------------------------------------------------------------

describe('a rolling-sealed bundle loads', () => {
  it('is recognized with no manifest.json present at all', async () => {
    const built = await buildTestBundle({
      rollingSeal: {},
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3, appendDocSave: true }],
    });

    const names = await zipEntryNames(built.zipBuffer);
    expect(names).not.toContain('manifest.json');
    expect(names).not.toContain('manifest.sig');
    const expected = rollingManifestFilenames(built.sessionIds[0]!);
    expect(names).toContain(expected.json);
    expect(names).toContain(expected.sig);

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.rollingSeal).toBeDefined();
    expect(result.value.manifestSigHex).toBeNull();
    expect(result.value.rollingSeal!.defects).toEqual([]);
  });

  it('synthesizes the union manifest at format_version 1.2 across every session', async () => {
    const built = await buildTestBundle({
      rollingSeal: {},
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.value;

    expect(bundle.manifest.format_version).toBe('1.2');
    // The union covers all three sessions — this is exactly why the shape
    // validator accepts N sessions at 1.2 while each FILE must cover one.
    expect(bundle.manifest.sessions).toHaveLength(3);
    expect(bundle.manifest.sessions.map((s) => s.session_id)).toEqual(built.sessionIds);
    expect(bundle.rollingSeal!.seals).toHaveLength(3);
    // Each on-disk manifest covers exactly one session.
    for (const seal of bundle.rollingSeal!.seals) {
      expect(seal.manifest.sessions).toHaveLength(1);
      expect(seal.manifest.sessions[0].session_id).toBe(seal.sessionId);
      expect(seal.manifest.format_version).toBe('1.2');
    }
    expect(bundle.manifest.submission_files).toHaveLength(1);
  });

  it('check 1 verifies each manifest against THAT session own key, not one shared key', async () => {
    const built = await buildTestBundle({
      rollingSeal: {},
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.value;

    // Every session has a DIFFERENT pubkey — a shared-key reader cannot pass.
    const pubkeys = new Set(bundle.sessions.map((s) => s.firstEvent.data.session_pubkey));
    expect(pubkeys.size).toBe(3);

    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/3 rolling manifest\(s\) verified, each against its own/);
    for (const id of built.sessionIds) {
      expect(check.detail).toContain(id);
    }
  });

  it('checks 1, 2 and 8 all produce meaningful results (not skipped, not vacuous)', async () => {
    const built = await buildTestBundle({
      rollingSeal: {},
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x5x4x3x2x1' }],
      sessions: [{ eventCount: 5, appendDocSave: true }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = await runValidation(result.value);
    expect(report.checks).toHaveLength(8);

    const byId = new Map(report.checks.map((c) => [c.id, c]));
    // Check 1 — the rolling signatures actually verified.
    expect(byId.get('manifest_sig')!.status).toBe('pass');
    // Check 2 — session binding, meaningful on a rolling bundle.
    expect(byId.get('session_binding')!.status).toBe('pass');
    // Check 8 — the submitted file matched the last recorded on-disk hash. This
    // is the check that was dead before the rolling seal: no manifest meant no
    // submission_files meant 'skipped'.
    const check8 = byId.get('submitted_code_match')!;
    expect(check8.status).toBe('pass');
    expect(check8.detail).toMatch(/1 submitted file\(s\) match/);

    expect(report.overall).toBe('pass');
  });

  it('check 8 fails on a rolling bundle whose submitted bytes drifted from the recording', async () => {
    const built = await buildTestBundle({
      rollingSeal: {},
      // The manifest records a sha256 that does not match what the log recorded.
      submissionFiles: [
        {
          path: '/test/file.py',
          status: 'present',
          content: 'x5x4x3x2x1',
          manifestSha256Override: 'b'.repeat(64),
        },
      ],
      sessions: [{ eventCount: 5, appendDocSave: true }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = await runValidation(result.value);
    const check8 = report.checks.find((c) => c.id === 'submitted_code_match')!;
    expect(check8.status).toBe('fail');
    expect(report.overall).toBe('fail');
  });

  it('a partner-style bundle where each session has its own key still verifies', async () => {
    // Two sessions, disjoint keys, one shared .provenance/ — the 61B shape. The
    // add-only per-session filenames are what make this mergeable at all.
    const built = await buildTestBundle({
      rollingSeal: {},
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [
        { eventCount: 3, machineId: 'partner-a' },
        { eventCount: 3, machineId: 'partner-b' },
      ],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = await verifyManifestSig(result.value);
    expect(check.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// The filename ↔ session_id binding.
// ---------------------------------------------------------------------------

describe('the filename to session_id binding', () => {
  it('refuses a manifest copied sideways under another session filename, even though its signature is valid', async () => {
    // manifest-A.json holds session B's manifest, signed with session A's OWN
    // key. The signature therefore VERIFIES. Only
    // validateRollingSessionManifest(manifest, sessionIdFromFilename) catches it.
    const built = await buildTestBundle({
      rollingSeal: { tamper: { sidewaysCopyFor: { sessionIndex: 0, manifestOfSessionIndex: 1 } } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.value;

    const sessionA = built.sessionIds[0]!;
    const defects = bundle.rollingSeal!.defects;
    expect(defects.map((d) => d.kind)).toContain('session_id_mismatch');
    const mismatch = defects.find((d) => d.kind === 'session_id_mismatch')!;
    expect(mismatch.sessionId).toBe(sessionA);
    expect(mismatch.detail).toContain(built.sessionIds[1]!);

    // The sideways copy is NOT accepted as a seal ...
    expect(bundle.rollingSeal!.seals.map((s) => s.sessionId)).not.toContain(sessionA);
    // ... and check 1 fails because of it.
    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/session/);
  });

  it('rejects a rolling manifest signed with a different session key', async () => {
    const built = await buildTestBundle({
      rollingSeal: { tamper: { signWithKeyOf: { sessionIndex: 0, keyOfSessionIndex: 1 } } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Shape and filename binding are fine here — only the key is wrong.
    expect(result.value.rollingSeal!.defects).toEqual([]);
    const check = await verifyManifestSig(result.value);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(
      `manifest-${built.sessionIds[0]!}.json did not verify against session ${built.sessionIds[0]!}'s own pubkey`,
    );
  });

  it('validateRollingSeals refuses a mismatch directly, without any crypto', () => {
    const built = {
      format_version: '1.2' as const,
      assignment_id: 'hw1',
      semester: 'sp26',
      extension_hash: 'a'.repeat(64),
      sessions: [
        {
          session_id: 'bbbb',
          prev_session_id: null,
          slog_sha256: 'c'.repeat(64),
          meta_sha256: 'd'.repeat(64),
        },
      ],
      submission_files: [],
    };
    const { seals, defects } = validateRollingSeals([
      { sessionId: 'aaaa', manifestJson: JSON.stringify(built), sigHex: 'ab'.repeat(64) },
    ]);
    expect(seals).toEqual([]);
    expect(defects).toHaveLength(1);
    expect(defects[0]!.kind).toBe('session_id_mismatch');
  });
});

// ---------------------------------------------------------------------------
// Edge cases.
// ---------------------------------------------------------------------------

describe('edge case: a bundle carrying BOTH a classic manifest.json and rolling manifests', () => {
  it('loads, uses the classic manifest, and verifies the rolling seals alongside it', async () => {
    const built = await buildTestBundle({
      rollingSeal: { alsoClassic: true },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const names = await zipEntryNames(built.zipBuffer);
    expect(names).toContain('manifest.json');
    expect(names).toContain(rollingManifestFilenames(built.sessionIds[0]!).json);

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.value;

    // The classic manifest wins for bundle.manifest — the classic path is unmoved.
    expect(bundle.manifest.format_version).toBe('1.1');
    expect(bundle.manifestSigHex).not.toBeNull();
    // But the rolling seals are retained and verified, not discarded.
    expect(bundle.rollingSeal!.seals).toHaveLength(2);
    expect(bundle.rollingSeal!.defects).toEqual([]);

    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/2 rolling manifest\(s\) verified/);
    expect(check.detail).toMatch(/Classic manifest\.json also verified/);
  });

  it('fails check 1 when the classic signature is good but a rolling one is not', async () => {
    const built = await buildTestBundle({
      rollingSeal: {
        alsoClassic: true,
        tamper: { signWithKeyOf: { sessionIndex: 0, keyOfSessionIndex: 1 } },
      },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A valid classic seal must not excuse a broken rolling seal.
    const check = await verifyManifestSig(result.value);
    expect(check.status).toBe('fail');
  });

  it('does not report unsealed_session for a session the classic manifest covers', async () => {
    const built = await buildTestBundle({
      rollingSeal: { alsoClassic: true, tamper: { omitSealFor: [1] } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.rollingSeal!.defects.map((d) => d.kind)).not.toContain('unsealed_session');
    const check = await verifyManifestSig(result.value);
    expect(check.status).toBe('pass');
  });
});

describe('edge case: a rolling .json with no .sig, and a .sig with no .json', () => {
  it('treats an unsigned rolling manifest as a missing_sig defect and fails check 1', async () => {
    const built = await buildTestBundle({
      rollingSeal: { tamper: { omitSigFor: [0] } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    // The bundle still LOADS: discarding the other session's findings over one
    // half-written seal would be failing toward fewer findings.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.value;

    const defects = bundle.rollingSeal!.defects;
    expect(defects.map((d) => d.kind)).toContain('missing_sig');
    expect(defects.find((d) => d.kind === 'missing_sig')!.sessionId).toBe(built.sessionIds[0]!);

    // Its content still contributes to the union, so check 8 can see the claim...
    expect(bundle.manifest.sessions.map((s) => s.session_id)).toContain(built.sessionIds[0]!);
    // ... but nothing vouches for it, so check 1 fails.
    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/unsigned/);
  });

  it('treats a stray rolling .sig with no .json as a missing_manifest defect and fails check 1', async () => {
    const built = await buildTestBundle({
      rollingSeal: { tamper: { omitJsonFor: [0] } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.value;

    const kinds = bundle.rollingSeal!.defects.map((d) => d.kind);
    expect(kinds).toContain('missing_manifest');
    // NOT also reported as unsealed_session. The stray `.sig` proves the session
    // WAS sealed, and `missing_manifest` ("the sealed manifest was removed") is
    // the strictly more specific statement — reporting both would double-count
    // one problem and make the check detail harder to act on.
    expect(kinds).not.toContain('unsealed_session');
    expect(kinds).toEqual(['missing_manifest']);

    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/was removed/);
  });

  it('reports invalid_manifest when the only rolling manifest is unparseable and there is no classic seal', async () => {
    const built = await buildTestBundle({
      rollingSeal: { tamper: { replaceJsonFor: { sessionIndex: 0, text: 'NOT JSON {{{' } } },
      sessions: [{ eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_manifest');
    expect('detail' in result.error && result.error.detail).toMatch(/not valid JSON/);
  });

  it('an unparseable rolling manifest plus submission files reports unexpected_file, exactly as an unparseable classic manifest does', async () => {
    // The submission-file whitelist is built from the manifests. An unparseable
    // manifest yields an empty whitelist, so the submitted bytes are unrecognized
    // and the ZIP is rejected before manifest resolution. This is pre-existing
    // classic behaviour (see unzip.ts step 3), and the rolling path inherits it
    // rather than inventing a second rule.
    const built = await buildTestBundle({
      rollingSeal: { tamper: { replaceJsonFor: { sessionIndex: 0, text: 'NOT JSON {{{' } } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }],
    });
    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unexpected_file');
  });

  it('an invalid-shape rolling manifest becomes an invalid_shape defect, not a load failure', async () => {
    // Valid JSON, wrong shape: format_version 1.1 in a rolling FILE, which
    // validateRollingSessionManifest refuses (`not_rolling`).
    const built = await buildTestBundle({
      rollingSeal: {
        tamper: {
          replaceJsonFor: {
            sessionIndex: 0,
            text: JSON.stringify({ format_version: '9.9', assignment_id: 'hw1' }),
          },
        },
      },
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    // Session 1's seal is still good, so the bundle loads.
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const kinds = result.value.rollingSeal!.defects.map((d) => d.kind);
    expect(kinds).toContain('invalid_shape');
    expect(result.value.rollingSeal!.seals).toHaveLength(1);
    expect(result.value.rollingSeal!.seals[0]!.sessionId).toBe(built.sessionIds[1]!);

    const check = await verifyManifestSig(result.value);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/shape invalid/);
  });
});

describe('edge case: a rolling manifest with no .slog, and a .slog with no rolling manifest', () => {
  it('reports no_session_log for a seal naming a session that is not in the bundle', async () => {
    const ghostId = 'deadbeef-0000-4000-8000-000000000000';
    const built = await buildTestBundle({
      rollingSeal: { tamper: { extraSealForSessionId: ghostId } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.value;

    const ghost = bundle.rollingSeal!.defects.find((d) => d.kind === 'no_session_log');
    expect(ghost).toBeDefined();
    expect(ghost!.sessionId).toBe(ghostId);

    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(ghostId);
    // No supporting seq for a session that is not in the bundle.
    expect(check.supportingSeqs ?? []).not.toContainEqual({ sessionId: ghostId, seq: 0 });
  });

  it('reports unsealed_session for a .slog no rolling manifest covers', async () => {
    const built = await buildTestBundle({
      rollingSeal: { tamper: { omitSealFor: [1] } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.value;

    const unsealed = bundle.rollingSeal!.defects.find((d) => d.kind === 'unsealed_session');
    expect(unsealed).toBeDefined();
    expect(unsealed!.sessionId).toBe(built.sessionIds[1]!);

    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/not covered by any seal/);
    expect(check.supportingSeqs).toContainEqual({ sessionId: built.sessionIds[1]!, seq: 0 });
  });
});

describe('edge case: no seal of either shape (the no_seal case)', () => {
  it('reports missing_manifest when there is neither a classic nor a rolling manifest', async () => {
    const { blob } = await buildTestBundle({ tamper: { omitManifest: true, omitSig: true } });
    const result = await loadBundle(blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing_manifest');
  });

  it('still reports missing_manifest for a stray classic manifest.sig even with rolling seals present', async () => {
    const built = await buildTestBundle({
      rollingSeal: { alsoClassic: true, tamper: {} },
      tamper: { omitManifest: true },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }],
    });
    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing_manifest');
  });
});

describe('edge case: rolling seals that disagree with each other', () => {
  it('reports divergent_scope when two seals claim different assignments', async () => {
    const built = await buildTestBundle({
      rollingSeal: { tamper: { assignmentIdFor: { sessionIndex: 1, assignmentId: 'hw9' } } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const defect = result.value.rollingSeal!.defects.find((d) => d.kind === 'divergent_scope');
    expect(defect).toBeDefined();
    expect(defect!.detail).toMatch(/assignment_id hw9 != hw1/);

    const check = await verifyManifestSig(result.value);
    expect(check.status).toBe('fail');
  });

  it('does NOT report divergent_scope when two seals name different recorder builds', async () => {
    // Updating the recorder mid-assignment is normal: today's single
    // `manifest.json` carries whichever build was current at seal time and
    // passes. Treating the variance as a scope defect failed check 1 for an
    // honest student who took an update.
    const newBuild = 'f'.repeat(64);
    const built = await buildTestBundle({
      rollingSeal: { tamper: { extensionHashFor: { sessionIndex: 1, extensionHash: newBuild } } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.rollingSeal!.defects).toEqual([]);
    expect((await verifyManifestSig(result.value)).status).toBe('pass');
  });

  it('carries the NEWEST build as the union scalar, and keeps every build observed', async () => {
    const newBuild = 'f'.repeat(64);
    const built = await buildTestBundle({
      rollingSeal: { tamper: { extensionHashFor: { sessionIndex: 1, extensionHash: newBuild } } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await loadBundle(built.blob, 'repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The scalar is the build behind the final state of the work…
    expect(result.value.manifest.extension_hash).toBe(newBuild);
    // …and nothing is hidden by that choice: both builds stay available so the
    // allowlist can check the one the scalar dropped.
    expect(result.value.rollingSeal!.observedExtensionHashes).toEqual(
      ['a'.repeat(64), newBuild].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Unit-level tests for the pure pieces.
// ---------------------------------------------------------------------------

describe('unzipBundle rolling recognition', () => {
  it('reports rolling halves independently and never confuses manifest.json for one', async () => {
    const built = await buildTestBundle({
      rollingSeal: { tamper: { omitSigFor: [0] } },
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const result = await unzipBundle(built.zipBuffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.manifestJson).toBeNull();
    expect(result.value.manifestSigHex).toBeNull();
    expect(result.value.rollingSeals).toHaveLength(2);

    const first = result.value.rollingSeals.find((s) => s.sessionId === built.sessionIds[0]!)!;
    expect(first.manifestJson).not.toBeNull();
    expect(first.sigHex).toBeNull();

    const second = result.value.rollingSeals.find((s) => s.sessionId === built.sessionIds[1]!)!;
    expect(second.manifestJson).not.toBeNull();
    expect(second.sigHex).not.toBeNull();
  });

  it('uses log-core’s filename pattern, so a stray manifest-*.json outside its charset is still unexpected_file', async () => {
    // The session-id charset is hex + dashes, matching `session-<uuid>.slog`.
    // A hand-rolled looser pattern here would silently swallow arbitrary files as
    // rolling seals; log-core owns the pattern precisely so it cannot drift.
    expect(parseRollingManifestFilename('manifest-notes.json')).toBeNull();
    expect(parseRollingManifestFilename('manifest.json')).toBeNull();
    expect(parseRollingManifestFilename('manifest.sig')).toBeNull();

    const built = await buildTestBundle({
      rollingSeal: {},
      sessions: [{ eventCount: 3 }],
      tamper: { addStrayFile: { name: 'manifest-notes.json', content: '{}' } },
    });
    const result = await unzipBundle(built.zipBuffer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unexpected_file');
  });

  it('does not treat a rolling manifest as an unexpected_file', async () => {
    const built = await buildTestBundle({
      rollingSeal: {},
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x3x2x1' }],
      sessions: [{ eventCount: 3 }],
    });
    const result = await unzipBundle(built.zipBuffer);
    expect(result.ok).toBe(true);
  });
});

describe('synthesizeRollingUnionManifest', () => {
  /** Session order as the loader supplies it: LOGICAL ids, never filenames. */
  const order = (...ids: string[]) => ids.map(asLogicalSessionId);

  const seal = (sessionId: string, files: Array<[string, string]>): RollingSeal => ({
    sessionId: asLogicalSessionId(sessionId),
    manifestJson: '{}',
    manifest: {
      format_version: '1.2',
      assignment_id: 'hw1',
      semester: 'sp26',
      extension_hash: 'a'.repeat(64),
      sessions: [
        {
          session_id: sessionId,
          prev_session_id: null,
          slog_sha256: 'c'.repeat(64),
          meta_sha256: 'd'.repeat(64),
        },
      ],
      submission_files: files.map(([path, sha256]) => ({
        path,
        status: 'present' as const,
        sha256,
      })),
    },
    sigHex: 'ab'.repeat(64),
  });

  it('returns null when there is nothing to synthesize from', () => {
    expect(synthesizeRollingUnionManifest([], [])).toBeNull();
  });

  it('merges submission_files last-writer-wins in session order', () => {
    const a = seal('a', [['f.py', '1'.repeat(64)]]);
    const b = seal('b', [['f.py', '2'.repeat(64)]]);
    const out = synthesizeRollingUnionManifest([a, b], order('a', 'b'))!;
    expect(out.manifest.submission_files).toEqual([
      { path: 'f.py', status: 'present', sha256: '2'.repeat(64) },
    ]);
    expect(out.manifest.sessions.map((s) => s.session_id)).toEqual(['a', 'b']);

    // Reverse the session order and the newest session's hash wins instead.
    const reversed = synthesizeRollingUnionManifest([a, b], order('b', 'a'))!;
    expect(reversed.manifest.submission_files).toEqual([
      { path: 'f.py', status: 'present', sha256: '1'.repeat(64) },
    ]);
    expect(reversed.manifest.sessions.map((s) => s.session_id)).toEqual(['b', 'a']);
  });

  it('orders seals with no parsed session deterministically after the rest', () => {
    const out = synthesizeRollingUnionManifest(
      [seal('z', []), seal('a', []), seal('m', [])],
      order('m'),
    )!;
    expect(out.manifest.sessions.map((s) => s.session_id)).toEqual(['m', 'a', 'z']);
  });
});
