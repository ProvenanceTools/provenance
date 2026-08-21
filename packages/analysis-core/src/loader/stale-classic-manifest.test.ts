/**
 * A both-shapes bundle whose classic manifest is STALE.
 *
 * `commands/seal.ts` writes `manifest.json` + `manifest.sig` INTO `.provenance/`
 * and never removes them. So a student who runs "Prepare Submission Bundle"
 * once — curiosity, a ZIP-submitted sibling assignment, a mixed cohort — and
 * then keeps working and pushes ships a bundle carrying BOTH shapes, in which
 * the classic manifest committed to the log as it stood at seal time and the
 * rolling seals committed to it as it stands now.
 *
 * `parse-bundle.ts` computed prefix coverage only when `classicManifest ===
 * null`, so for that bundle coverage stayed `undefined` for every session —
 * and `verify-log-bytes.ts` reads absent coverage as "this is a classic seal"
 * and applies WHOLE-FILE equality. The student's honest later work therefore
 * failed `log_bytes_match` at high severity, confidence 1.0.
 *
 * This is the fifth route to the prefix-vs-whole-file accusation. Bug 5 was the
 * first, bug 10 the second, bug 12 the third. Bug 10 fixed one branch of the
 * INNER conditional and bug 12 the other; the gate one level up was never
 * looked at. `parse-bundle.ts` (`classicManifest ?? unionManifest`) then makes
 * the stale manifest the one the whole of analysis-core reads, and check 1 goes
 * on passing, so nothing contradicts the finding.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import JSZip from 'jszip';
import { loadBundle } from './parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { verifyLogBytes } from '../validation/verify-log-bytes.js';
import { verifyManifestSig } from '../validation/verify-manifest-sig.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

/**
 * The honest shape: sealed classically after 6 entries, kept working to 14,
 * pushed. The rolling seal is non-final because the session was still live.
 */
async function staleBothShapes() {
  const built = await buildTestBundle({
    sessions: [{ eventCount: 14 }],
    rollingSeal: {
      alsoClassic: true,
      final: false,
      staleClassicAfterEntries: { sessionIndex: 0, entries: 6 },
    },
  });
  const result = await loadBundle(built.zipBuffer, 'git-clone.zip');
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('bundle failed to load');
  return result.value;
}

describe('a both-shapes bundle whose classic manifest is stale', () => {
  it('carries both seal shapes — the precondition for everything below', async () => {
    const bundle = await staleBothShapes();
    expect(bundle.manifestSigHex).not.toBeNull();
    expect(bundle.rollingSeal).toBeDefined();
    expect(bundle.rollingSeal!.seals.length).toBeGreaterThan(0);
  });

  it('computes prefix coverage rather than leaving it undefined', async () => {
    // The gate. `undefined` here is not inert: it is READ, three modules away,
    // as "this bundle carries a classic whole-file commitment".
    const bundle = await staleBothShapes();
    expect(bundle.rollingSeal!.coverage).toBeDefined();
    expect(bundle.rollingSeal!.coverage!).toHaveLength(1);
  });

  it('does NOT accuse the student of modifying the log after sealing', async () => {
    // The finding itself — the assertion that has to trip. High severity,
    // confidence 1.0, against a student whose only act was to keep working
    // after running the seal command once.
    const bundle = await staleBothShapes();
    const check = verifyLogBytes(bundle);
    expect(check.status).not.toBe('fail');
  });

  it('reports the growth past the classic seal as a fact', async () => {
    // Failing toward fewer findings is the other way to get this wrong. The
    // bytes the seal does not attest are named, not silently blessed.
    const bundle = await staleBothShapes();
    const coverage = bundle.rollingSeal!.coverage![0]!;
    expect(coverage.slog.kind).toBe('partial');
  });

  it('leaves check 1 passing, since neither signature is in doubt', async () => {
    const bundle = await staleBothShapes();
    const check = await verifyManifestSig(bundle);
    expect(check.status).toBe('pass');
  });

  it('still catches an append past a FINAL seal in a both-shapes bundle', async () => {
    // The accepted cost of this change, and its limit.
    //
    // A both-shapes bundle used to get whole-file strictness for free from the
    // classic manifest. It now gets prefix semantics, exactly as a rolling-only
    // bundle does — so an append past a NON-final seal is honest growth rather
    // than a finding, which is D7's decision ("absence of `final` is never a
    // finding"), applied consistently instead of depending on whether a stale
    // `manifest.json` happened to be lying around.
    //
    // What must NOT be lost is the case `final` exists for: the seal written by
    // `dispose()` over a finished log. Then the log provably cannot grow, and an
    // appended entry is still caught at full strength.
    const built = await buildTestBundle({
      sessions: [{ eventCount: 10 }],
      rollingSeal: { alsoClassic: true, final: true },
    });

    const zip = await JSZip.loadAsync(built.zipBuffer);
    const name = `session-${built.logFileIds[0]!}.slog`;
    const text = await zip.file(name)!.async('string');
    const lines = text.split('\n').filter((l) => l !== '');
    // Append a copy of the last entry — a well-formed line the seal never saw.
    zip.file(name, [...lines, lines[lines.length - 1]!].join('\n') + '\n');
    const appended = await zip.generateAsync({ type: 'arraybuffer' });

    const result = await loadBundle(appended, 'appended.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(verifyLogBytes(result.value).status).toBe('fail');
    expect(result.value.rollingSeal!.coverage![0]!.slog.kind).toBe('no_match');
  });

  it('still FAILS when the pre-seal bytes genuinely diverge', async () => {
    // The strength that must survive. Honest growth means the committed digest
    // is reproduced by SOME prefix of the file. Editing a byte the seal already
    // covered means it is reproduced by none — a different history, not a
    // longer one — and the check must still say so.
    //
    // Built in the ARCHIVE, not on the loaded Bundle: coverage is computed by
    // the loader, so mutating `bundle.manifest` afterwards is invisible to it
    // and proves nothing. (That mistake made an earlier version of this test
    // pass against the very hole it was written to guard.)
    const built = await buildTestBundle({
      sessions: [{ eventCount: 14 }],
      rollingSeal: {
        alsoClassic: true,
        final: false,
        staleClassicAfterEntries: { sessionIndex: 0, entries: 6 },
      },
    });

    const zip = await JSZip.loadAsync(built.zipBuffer);
    const name = `session-${built.logFileIds[0]!}.slog`;
    const lines = (await zip.file(name)!.async('string')).split('\n');
    // Entry 2 sits INSIDE the prefix the classic manifest committed to.
    lines[1] = lines[1]!.replace(/"t":\d+/, '"t":999999');
    zip.file(name, lines.join('\n'));
    const tampered = await zip.generateAsync({ type: 'arraybuffer' });

    const result = await loadBundle(tampered, 'tampered.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyLogBytes(result.value);
    expect(check.status).toBe('fail');
    expect(result.value.rollingSeal!.coverage![0]!.slog.kind).toBe('no_match');
  });
});
