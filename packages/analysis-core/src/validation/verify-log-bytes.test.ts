/**
 * Tests for the log-bytes detection — the signed manifest's `slog_sha256` /
 * `meta_sha256` commitment, enforced.
 *
 * Two things these tests are careful about, because getting either wrong is how
 * a tamper check becomes worthless or actively harmful:
 *
 *  1. **A stripped bundle must still pass.** Ingest removes student source and
 *     keeps only `manifest.json`, `manifest.sig`, `*.slog`, `*.slog.meta`. If
 *     this check could not survive that, it would report every stored bundle as
 *     tampered — exactly the bug check 8 shipped in 2026-07.
 *  2. **Absent is not wrong.** Every path where the commitment cannot be
 *     evaluated must be `skipped`, never `fail`.
 *
 * `buildTestBundle` computes each session's manifest digest from the log text
 * BEFORE applying `tamper`, which is faithful to reality: a real manifest is
 * signed over the true bytes, and the attacker edits the log afterwards. So any
 * `tamper` option that rewrites `.slog` content also moves its bytes away from
 * the signed digest, which is precisely what this check exists to notice.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import JSZip from 'jszip';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { verifyLogBytes } from './verify-log-bytes.js';
import type { Bundle } from '../loader/types.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

async function load(blob: Blob | ArrayBuffer, name = 'test.zip'): Promise<Bundle> {
  const result = await loadBundle(blob, name);
  if (!result.ok) throw new Error(`loadBundle failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

/**
 * Rewrite a bundle ZIP, mutating entries through a callback.
 * Used to tamper with a SEALED bundle the way an attacker actually would —
 * after the manifest was signed.
 */
async function rewriteZip(
  zipBuffer: ArrayBuffer,
  mutate: (zip: JSZip) => Promise<void> | void,
): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(zipBuffer);
  await mutate(zip);
  const out = await zip.generateAsync({ type: 'arraybuffer' });
  return out;
}

function slogName(sessionId: string): string {
  return `session-${sessionId}.slog`;
}

// ---------------------------------------------------------------------------
// Clean bundles — the check must be quiet
// ---------------------------------------------------------------------------

describe('verifyLogBytes — clean bundles pass', () => {
  it('passes for a single-session bundle whose bytes are untouched', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const check = verifyLogBytes(await load(blob));

    expect(check.id).toBe('log_bytes_match');
    expect(check.status).toBe('pass');
  });

  it('passes for a multi-session bundle', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 4 }, { eventCount: 3 }, { eventCount: 6 }],
    });
    const check = verifyLogBytes(await load(blob));

    expect(check.status).toBe('pass');
    // 3 sessions x 2 files each.
    expect(check.detail).toContain('6 log-file digest(s) matched');
  });

  it('passes for a 1.1 bundle carrying submission files', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      submissionFiles: [{ path: 'main.py', status: 'present', content: 'x = 1\n' }],
    });
    expect(verifyLogBytes(await load(blob)).status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// THE HOLE: post-seal modification of a .slog
// ---------------------------------------------------------------------------

describe('verifyLogBytes — catches post-seal modification', () => {
  it('catches a well-formed APPENDED entry (the characterized hole)', async () => {
    // The append attack: the appended entry is correctly chained, so checks
    // 3-6 are all satisfied. Only the file's digest changes.
    const { zipBuffer, sessionIds } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const sid = sessionIds[0]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      // Append a well-formed envelope: a verbatim copy of the last entry, so
      // the file still parses cleanly and the loader is happy. Only the file's
      // bytes — and therefore its digest — have moved. A genuinely re-chained
      // append is exercised end-to-end against real recorder output in
      // tools/recorder-seal-conformance.test.ts.
      const text = await zip.file(slogName(sid))!.async('string');
      const lines = text.trim().split('\n');
      zip.file(slogName(sid), `${text}${lines[lines.length - 1]!}\n`);
    });

    const check = verifyLogBytes(await load(tampered));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(sid);
    expect(check.detail).toContain('.slog');
    expect(check.supportingSeqs).toEqual([{ sessionId: sid, seq: 0 }]);
  });

  it('catches a single flipped byte in a .slog', async () => {
    const { zipBuffer, sessionIds } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const sid = sessionIds[0]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const bytes = await zip.file(slogName(sid))!.async('uint8array');
      bytes[Math.floor(bytes.length / 2)] ^= 0x01;
      zip.file(slogName(sid), bytes);
    });

    expect(verifyLogBytes(await load(tampered)).status).toBe('fail');
  });

  it('catches a TRUNCATED .slog', async () => {
    const { zipBuffer, sessionIds } = await buildTestBundle({ sessions: [{ eventCount: 6 }] });
    const sid = sessionIds[0]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const lines = (await zip.file(slogName(sid))!.async('string')).trim().split('\n');
      // Drop the last two entries. The remaining chain still self-verifies.
      zip.file(slogName(sid), `${lines.slice(0, -2).join('\n')}\n`);
    });

    expect(verifyLogBytes(await load(tampered)).status).toBe('fail');
  });

  it('catches a tampered .slog.meta and names that file', async () => {
    const { zipBuffer, sessionIds } = await buildTestBundle({ sessions: [{ eventCount: 4 }] });
    const sid = sessionIds[0]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const name = `${slogName(sid)}.meta`;
      const meta = JSON.parse(await zip.file(name)!.async('string')) as Record<string, unknown>;
      // Shape stays valid so the loader still parses it — only bytes change.
      meta['session_pubkey'] = 'f'.repeat(64);
      zip.file(name, JSON.stringify(meta));
    });

    const check = verifyLogBytes(await load(tampered));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('.slog.meta');
  });

  it('reports every mismatching session, not just the first', async () => {
    const { zipBuffer, sessionIds } = await buildTestBundle({
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      for (const sid of sessionIds) {
        const text = await zip.file(slogName(sid))!.async('string');
        zip.file(slogName(sid), `${text}\n`);
      }
    });

    const check = verifyLogBytes(await load(tampered));
    expect(check.status).toBe('fail');
    for (const sid of sessionIds) expect(check.detail).toContain(sid);
    expect(check.supportingSeqs).toHaveLength(2);
  });

  it('quotes both the committed and the actual digest, so staff can audit it', async () => {
    const { zipBuffer, sessionIds, manifest } = await buildTestBundle({
      sessions: [{ eventCount: 3 }],
    });
    const sid = sessionIds[0]!;
    const committed = manifest.sessions.find((s) => s.session_id === sid)!.slog_sha256;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const text = await zip.file(slogName(sid))!.async('string');
      zip.file(slogName(sid), `${text}\n`);
    });

    const check = verifyLogBytes(await load(tampered));
    expect(check.detail).toContain(committed);
    expect(check.detail).toContain('bundled bytes hash to');
  });
});

// ---------------------------------------------------------------------------
// Absent is not wrong
// ---------------------------------------------------------------------------

describe('verifyLogBytes — never manufactures a finding', () => {
  it('skips (does not fail) when the manifest commits to no usable digest', async () => {
    const bundle = await load((await buildTestBundle({ sessions: [{ eventCount: 3 }] })).blob);

    // A manifest whose digests are absent/malformed: unusable, not violated.
    const noDigests: Bundle = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        sessions: bundle.manifest.sessions.map((s) => ({
          ...s,
          slog_sha256: '',
          meta_sha256: 'not-a-sha256',
        })),
      },
    };

    const check = verifyLogBytes(noDigests);
    expect(check.status).toBe('skipped');
    expect(check.status).not.toBe('fail');
  });

  it('skips when no manifest entry names the session (an unsealed session)', async () => {
    const bundle = await load((await buildTestBundle({ sessions: [{ eventCount: 3 }] })).blob);

    const unsealed: Bundle = {
      ...bundle,
      manifest: { ...bundle.manifest, sessions: [] },
    };

    expect(verifyLogBytes(unsealed).status).toBe('skipped');
  });

  it('ignores a manifest entry whose session_id is null', async () => {
    // null marks a session whose .slog the sealer could not parse. It matches
    // no session and must not be mistaken for a mismatch.
    const bundle = await load((await buildTestBundle({ sessions: [{ eventCount: 3 }] })).blob);

    const withNull: Bundle = {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        sessions: [
          ...bundle.manifest.sessions,
          {
            session_id: null,
            prev_session_id: null,
            slog_sha256: 'a'.repeat(64),
            meta_sha256: 'b'.repeat(64),
          },
        ],
      },
    };

    expect(verifyLogBytes(withNull).status).toBe('pass');
  });

  it('passes a legacy 1.0 bundle — legacy is not tampering', async () => {
    const { blob, manifest } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    expect(manifest.format_version).toBe('1.0');
    expect(verifyLogBytes(await load(blob)).status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Rolling-sealed bundles (program spec §8)
// ---------------------------------------------------------------------------

describe('verifyLogBytes — rolling-sealed bundles', () => {
  it('passes a clean rolling-sealed bundle', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 4 }, { eventCount: 4 }],
      rollingSeal: {},
    });

    const bundle = await load(blob);
    // Confirm we really exercised the rolling path, not the classic one.
    expect(bundle.rollingSeal).toBeDefined();
    expect(bundle.manifest.format_version).toBe('1.2');

    expect(verifyLogBytes(bundle).status).toBe('pass');
  });

  it('catches an appended entry in a rolling-sealed bundle', async () => {
    const { zipBuffer, sessionIds } = await buildTestBundle({
      sessions: [{ eventCount: 4 }, { eventCount: 4 }],
      rollingSeal: {},
    });
    const sid = sessionIds[1]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const text = await zip.file(slogName(sid))!.async('string');
      const lines = text.trim().split('\n');
      zip.file(slogName(sid), `${text}${lines[lines.length - 1]!}\n`);
    });

    const bundle = await load(tampered);
    expect(bundle.rollingSeal).toBeDefined();

    const check = verifyLogBytes(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(sid);
  });
});

// ---------------------------------------------------------------------------
// STORED (source-stripped) bundles
// ---------------------------------------------------------------------------

describe('verifyLogBytes — re-runnable against a stored, source-stripped bundle', () => {
  /**
   * Mirrors `server/services/ingest/strip-bundle.ts`'s `isProvenanceEntry`
   * EXACTLY, as of 2026-08. Duplicated rather than imported because
   * `analysis-core` must not depend on `server`.
   */
  function isProvenanceEntry(name: string): boolean {
    return (
      name === 'manifest.json' ||
      name === 'manifest.sig' ||
      name.endsWith('.slog') ||
      name.endsWith('.slog.meta')
    );
  }

  /**
   * The allowlist a rolling-sealed bundle NEEDS.
   *
   * NOTE — REPORTED, NOT FIXED HERE: the server's `isProvenanceEntry` above
   * keeps only the CLASSIC `manifest.json` / `manifest.sig`. A rolling-sealed
   * bundle (program spec §8) is sealed exclusively by per-session
   * `manifest-<session_id>.json` / `.sig`, none of which match that allowlist —
   * so stripping one today deletes its only seal and the stored blob no longer
   * loads at all (`missing_manifest`). That is a pre-existing defect in the
   * ingest stripper, not in this detection, and `strip-bundle.ts` belongs to
   * the concurrent git-native-ingest workstream, so it is deliberately left
   * alone. The rolling strip test below uses the corrected allowlist so it
   * measures THIS check rather than that bug.
   */
  function isProvenanceEntryRollingAware(name: string): boolean {
    return isProvenanceEntry(name) || /^manifest-.+\.(json|sig)$/.test(name);
  }

  async function strip(
    zipBuffer: ArrayBuffer,
    keep: (name: string) => boolean = isProvenanceEntry,
  ): Promise<ArrayBuffer> {
    return rewriteZip(zipBuffer, (zip) => {
      for (const name of Object.keys(zip.files)) {
        if (!keep(name)) zip.remove(name);
      }
    });
  }

  it('still PASSES after stripping — stripping is not tampering', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      submissionFiles: [{ path: 'main.py', status: 'present', content: 'print(1)\n' }],
    });

    const full = await load(zipBuffer);
    expect(full.submissionFiles.get('main.py')?.bytes).toBeDefined();
    expect(verifyLogBytes(full).status).toBe('pass');

    const stripped = await load(await strip(zipBuffer));
    // The source really is gone...
    expect(stripped.submissionFiles.get('main.py')?.bytes).toBeUndefined();
    // ...and the detection is unmoved.
    const check = verifyLogBytes(stripped);
    expect(check.status).toBe('pass');
    expect(check.status).not.toBe('fail');
  });

  it('produces a byte-identical digest before and after stripping', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      submissionFiles: [{ path: 'a.py', status: 'present', content: 'a = 1\n' }],
    });

    const before = await load(zipBuffer);
    const after = await load(await strip(zipBuffer));

    expect(after.sessions[0]!.slogSha256).toBe(before.sessions[0]!.slogSha256);
    expect(after.sessions[0]!.metaSha256).toBe(before.sessions[0]!.metaSha256);
  });

  it('STILL CATCHES a tampered log in a stripped bundle', async () => {
    // The detection must not merely survive stripping — it must keep working.
    const { zipBuffer, sessionIds } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      submissionFiles: [{ path: 'a.py', status: 'present', content: 'a = 1\n' }],
    });
    const sid = sessionIds[0]!;

    const strippedThenTampered = await rewriteZip(await strip(zipBuffer), async (zip) => {
      const text = await zip.file(slogName(sid))!.async('string');
      const lines = text.trim().split('\n');
      zip.file(slogName(sid), `${text}${lines[lines.length - 1]!}\n`);
    });

    expect(verifyLogBytes(await load(strippedThenTampered)).status).toBe('fail');
  });

  it('still passes a stripped ROLLING-sealed bundle', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      rollingSeal: {},
    });

    const stripped = await load(await strip(zipBuffer, isProvenanceEntryRollingAware));
    expect(stripped.rollingSeal).toBeDefined();
    expect(verifyLogBytes(stripped).status).toBe('pass');
  });
});
