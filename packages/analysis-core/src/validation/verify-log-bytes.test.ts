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

/**
 * The `.slog` entry name in the ZIP.
 *
 * Takes the FILENAME uuid (`BuiltBundle.logFileIds`), never the logical session
 * id (`BuiltBundle.sessionIds`). Those are two independently minted uuids in
 * production, and this suite must reach into the zip with the one the file is
 * actually named after — otherwise every mutation below silently no-ops and the
 * test passes without exercising anything. See `build-test-bundle.ts`.
 */
function slogName(logFileId: string): string {
  return `session-${logFileId}.slog`;
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
    const { zipBuffer, sessionIds, logFileIds } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
    });
    const sid = sessionIds[0]!;
    const fid = logFileIds[0]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      // Append a well-formed envelope: a verbatim copy of the last entry, so
      // the file still parses cleanly and the loader is happy. Only the file's
      // bytes — and therefore its digest — have moved. A genuinely re-chained
      // append is exercised end-to-end against real recorder output in
      // tools/recorder-seal-conformance.test.ts.
      const text = await zip.file(slogName(fid))!.async('string');
      const lines = text.trim().split('\n');
      zip.file(slogName(fid), `${text}${lines[lines.length - 1]!}\n`);
    });

    const check = verifyLogBytes(await load(tampered));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(sid);
    expect(check.detail).toContain('.slog');
    expect(check.supportingSeqs).toEqual([{ sessionId: sid, seq: 0 }]);
  });

  it('catches a single flipped byte in a .slog', async () => {
    const { zipBuffer, sessionIds, logFileIds } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
    });
    const sid = sessionIds[0]!;
    const fid = logFileIds[0]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const bytes = await zip.file(slogName(fid))!.async('uint8array');
      const i = Math.floor(bytes.length / 2);
      bytes[i] = bytes[i]! ^ 0x01;
      zip.file(slogName(fid), bytes);
    });

    const check = verifyLogBytes(await load(tampered));
    expect(check.status).toBe('fail');
    // Located by the FILENAME uuid, reported under the LOGICAL id.
    expect(check.detail).toContain(sid);
  });

  it('catches a TRUNCATED .slog', async () => {
    const { zipBuffer, sessionIds, logFileIds } = await buildTestBundle({
      sessions: [{ eventCount: 6 }],
    });
    const sid = sessionIds[0]!;
    const fid = logFileIds[0]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const lines = (await zip.file(slogName(fid))!.async('string')).trim().split('\n');
      // Drop the last two entries. The remaining chain still self-verifies.
      zip.file(slogName(fid), `${lines.slice(0, -2).join('\n')}\n`);
    });

    const check = verifyLogBytes(await load(tampered));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(sid);
  });

  it('catches a tampered .slog.meta and names that file', async () => {
    const { zipBuffer, sessionIds, logFileIds } = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
    });
    const sid = sessionIds[0]!;
    const fid = logFileIds[0]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const name = `${slogName(fid)}.meta`;
      const meta = JSON.parse(await zip.file(name)!.async('string')) as Record<string, unknown>;
      // Shape stays valid so the loader still parses it — only bytes change.
      meta['session_pubkey'] = 'f'.repeat(64);
      zip.file(name, JSON.stringify(meta));
    });

    const check = verifyLogBytes(await load(tampered));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('.slog.meta');
    expect(check.detail).toContain(sid);
  });

  it('reports every mismatching session, not just the first', async () => {
    const { zipBuffer, sessionIds, logFileIds } = await buildTestBundle({
      sessions: [{ eventCount: 3 }, { eventCount: 3 }],
    });

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      for (const fid of logFileIds) {
        const text = await zip.file(slogName(fid))!.async('string');
        zip.file(slogName(fid), `${text}\n`);
      }
    });

    const check = verifyLogBytes(await load(tampered));
    expect(check.status).toBe('fail');
    for (const sid of sessionIds) expect(check.detail).toContain(sid);
    expect(check.supportingSeqs).toHaveLength(2);
  });

  it('quotes both the committed and the actual digest, so staff can audit it', async () => {
    const { zipBuffer, sessionIds, logFileIds, manifest } = await buildTestBundle({
      sessions: [{ eventCount: 3 }],
    });
    const sid = sessionIds[0]!;
    const fid = logFileIds[0]!;
    const committed = manifest.sessions.find((s) => s.session_id === sid)!.slog_sha256;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const text = await zip.file(slogName(fid))!.async('string');
      zip.file(slogName(fid), `${text}\n`);
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
    const { zipBuffer, sessionIds, logFileIds } = await buildTestBundle({
      sessions: [{ eventCount: 4 }, { eventCount: 4 }],
      rollingSeal: {},
    });
    const sid = sessionIds[1]!;
    const fid = logFileIds[1]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const text = await zip.file(slogName(fid))!.async('string');
      const lines = text.trim().split('\n');
      zip.file(slogName(fid), `${text}${lines[lines.length - 1]!}\n`);
    });

    const bundle = await load(tampered);
    expect(bundle.rollingSeal).toBeDefined();

    const check = verifyLogBytes(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(sid);
  });

  // -------------------------------------------------------------------------
  // FINAL vs NON-FINAL — the reason the append above is catchable at all.
  //
  // A rolling seal is signed BEFORE the log's trailing bytes exist, so it can
  // only commit to a prefix — which is what stops an honest mid-session archive
  // being read as tampering, and is also what made an append invisible. The
  // recorder's dispose()-time roll marks itself `final` inside the SIGNED
  // payload, and that seal (and only that seal) is read whole-file.
  // -------------------------------------------------------------------------

  it('reads the append as a WHOLE-FILE contradiction, not a broken prefix', async () => {
    // Proves the previous test fails for the right reason. A prefix search
    // would still find the sealed prefix intact and report growth; the final
    // marker is what makes this a mismatch at all.
    const { zipBuffer, sessionIds, logFileIds } = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      rollingSeal: { final: true },
    });
    const sid = sessionIds[0]!;
    const fid = logFileIds[0]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const text = await zip.file(slogName(fid))!.async('string');
      const lines = text.trim().split('\n');
      zip.file(slogName(fid), `${text}${lines[lines.length - 1]!}\n`);
    });

    const bundle = await load(tampered);
    expect(bundle.rollingSeal?.coverage?.[0]?.final).toBe(true);
    // Whole-file semantics: no prefix was found, so no prefix was contradicted.
    expect(bundle.rollingSeal?.coverage?.[0]?.slog).toEqual({ kind: 'no_match' });

    const check = verifyLogBytes(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('FINAL');
    expect(check.detail).toContain('after the session ended');
    expect(check.detail).toContain(sid);
  });

  it('does NOT accuse the same append when the seal is not final', async () => {
    // The honest mid-session archive: identical bytes, identical append, but
    // the seal never claimed the log was finished. Accusing here is the exact
    // false-positive this whole design exists to avoid.
    const { zipBuffer, sessionIds, logFileIds } = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      rollingSeal: { final: false },
    });
    const sid = sessionIds[0]!;
    const fid = logFileIds[0]!;

    const grown = await rewriteZip(zipBuffer, async (zip) => {
      const text = await zip.file(slogName(fid))!.async('string');
      const lines = text.trim().split('\n');
      zip.file(slogName(fid), `${text}${lines[lines.length - 1]!}\n`);
    });

    const bundle = await load(grown);
    expect(bundle.rollingSeal?.coverage?.[0]?.final).toBe(false);
    // Coverage is keyed by the LOGICAL session id, never the `.slog` filename
    // uuid. Keying it wrongly leaves coverage EMPTY, which silently downgrades
    // this bundle to whole-file equality and accuses this student.
    expect(bundle.rollingSeal?.coverage?.[0]?.sessionId).toBe(sid);
    expect(bundle.rollingSeal?.coverage?.[0]?.sessionId).not.toBe(fid);

    const check = verifyLogBytes(bundle);
    expect(check.status).toBe('pass');
    expect(check.status).not.toBe('fail');
  });

  it('reports the unattested tail, and says outright that no final seal is present', async () => {
    // THE DOWNGRADE, as staff see it. A student who deletes their final seal
    // and restores an earlier non-final one they also legitimately signed
    // re-opens the prefix gap. It cannot be refuted — both seals are real
    // statements by the same key, and the shape is byte-for-byte identical to
    // an honest mid-session archive — so it stays a PASS. What it must not do
    // is read as "sealed in full", and this is the sentence that stops it.
    const { zipBuffer, sessionIds, logFileIds } = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      rollingSeal: { final: false },
    });
    const sid = sessionIds[0]!;
    const fid = logFileIds[0]!;

    const grown = await rewriteZip(zipBuffer, async (zip) => {
      const text = await zip.file(slogName(fid))!.async('string');
      const lines = text.trim().split('\n');
      zip.file(slogName(fid), `${text}${lines[lines.length - 1]!}\n`);
    });

    const check = verifyLogBytes(await load(grown));
    expect(check.status).toBe('pass');
    expect(check.detail).toContain(sid);
    expect(check.detail).toContain('written after the last seal');
    expect(check.detail).toContain('NOT marked');
    expect(check.detail).toContain('could not be detected');
  });

  it('says a clean final-sealed bundle is covered in full', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      rollingSeal: { final: true },
    });

    const check = verifyLogBytes(await load(blob));
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('FINAL');
    expect(check.detail).toContain('covered in full');
  });

  it('still catches a flipped byte inside a NON-final seal’s prefix', async () => {
    // Making finality the trigger for strictness must not cost the prefix
    // enforcement that already existed. Editing the sealed region reproduces no
    // state the file ever passed through, final or not.
    const { zipBuffer, sessionIds, logFileIds } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      rollingSeal: { final: false },
    });
    const sid = sessionIds[0]!;
    const fid = logFileIds[0]!;

    const tampered = await rewriteZip(zipBuffer, async (zip) => {
      const bytes = await zip.file(slogName(fid))!.async('uint8array');
      const i = Math.floor(bytes.length / 2);
      bytes[i] = bytes[i]! ^ 0x01;
      zip.file(slogName(fid), bytes);
    });

    const check = verifyLogBytes(await load(tampered));
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
    const { zipBuffer, sessionIds, logFileIds } = await buildTestBundle({
      sessions: [{ eventCount: 5 }],
      submissionFiles: [{ path: 'a.py', status: 'present', content: 'a = 1\n' }],
    });
    const sid = sessionIds[0]!;
    const fid = logFileIds[0]!;

    const strippedThenTampered = await rewriteZip(await strip(zipBuffer), async (zip) => {
      const text = await zip.file(slogName(fid))!.async('string');
      const lines = text.trim().split('\n');
      zip.file(slogName(fid), `${text}${lines[lines.length - 1]!}\n`);
    });

    const check = verifyLogBytes(await load(strippedThenTampered));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(sid);
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
