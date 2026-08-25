/**
 * A duplicated `.slog` must be ANALYSED once.
 *
 * Bug 12 made the loader keep EVERY `.slog` claiming a logical session id,
 * which is correct and necessary: the rolling seal has to be resolved on what
 * all the claimants AGREE about, and that needs all of them.
 *
 * It is not correct for the EVENT STREAM. `parse-bundle.ts` pushed each parse
 * result into `parsedSessions` unconditionally, so one logical session arrived
 * downstream as two sessions holding the same events. `buildIndex` dedupes only
 * `bySeq` (a `Map`); `byKind`, `byFile` and `bySessionId` all push. So every
 * delta was replayed twice — reconstructed file content is fabricated, typed
 * character counts double, and check 7 reports a computed sha256 that no honest
 * file could produce.
 *
 * Reachable by exactly the act bug 12 was written to stop accusing anyone for:
 * a student keeping a copy of their own `.provenance/` directory.
 *
 * The requirement is an EQUIVALENCE, not a set of magic numbers: the duplicated
 * bundle must analyse identically to the single-copy one. Pinning literals here
 * would let both sides drift together and still look green.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import JSZip from 'jszip';
import { loadBundle } from './parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { buildIndex } from '../index/build-index.js';
import { computeStats } from '../index/stats.js';
import { reconstructFile } from '../index/reconstruct-file.js';
import { verifyLogBytes } from '../validation/verify-log-bytes.js';
import { verifyDocSaveHashes } from '../validation/verify-doc-save-hashes.js';
import { runHeuristics } from '../heuristics/run-heuristics.js';
import type { ValidationReport } from '../validation/check-types.js';
import type { Bundle } from './types.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

/** Copy a session's `.slog` + `.slog.meta` verbatim under a second filename uuid. */
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

/** The single-copy bundle and its duplicated twin, loaded. */
async function bothShapes(): Promise<{ single: Bundle; duplicated: Bundle; filePath: string }> {
  const built = await buildTestBundle({
    sessions: [{ eventCount: 12, appendDocSave: true }],
    rollingSeal: {},
  });

  const single = await loadBundle(built.zipBuffer, 'single.zip');
  expect(single.ok).toBe(true);
  if (!single.ok) throw new Error('single bundle failed to load');

  const dupZip = await duplicateLog(
    built.zipBuffer,
    built.logFileIds[0]!,
    '99999999-0000-4000-8000-000000000000',
  );
  const duplicated = await loadBundle(dupZip, 'duplicated.zip');
  expect(duplicated.ok).toBe(true);
  if (!duplicated.ok) throw new Error('duplicated bundle failed to load');

  // Precondition: the loader DID see the duplication. Without this the
  // equivalences below could pass because nothing was duplicated at all.
  expect(
    duplicated.value.rollingSeal!.defects.some((d) => d.kind === 'ambiguous_session_log'),
  ).toBe(true);

  const filePath = [...buildIndex(single.value).byFile.keys()][0]!;
  return { single: single.value, duplicated: duplicated.value, filePath };
}

describe('a `.slog` duplicated under a second filename', () => {
  it('is replayed ONCE by the index, while the loader still carries both copies', async () => {
    // Both halves matter, and they pull in opposite directions.
    //
    // `bundle.sessions` MUST keep both: the rolling seal is resolved on what
    // the claimants agree about, and the witness reconciler answers
    // `indeterminate` instead of `tip_mismatch` when they disagree. Dropping
    // the duplicate in the loader was tried and reverted — it turned two
    // `witness/reconcile-witnesses.test.ts` cases red, one of them by producing
    // exactly the harsher verdict that test exists to prevent.
    //
    // The INDEX must keep one, because it is what replays the deltas.
    const { single, duplicated } = await bothShapes();

    expect(duplicated.sessions.length).toBe(single.sessions.length + 1);
    // Counted in EVENTS, not in map keys: both copies share one logical session
    // id, so `bySessionId.size` is 1 whether the duplicate was replayed or not,
    // and asserting on it would pass under the very bug this file exists for.
    expect(buildIndex(duplicated).ordered.length).toBe(buildIndex(single).ordered.length);
  });

  it('does not double the event stream', async () => {
    const { single, duplicated } = await bothShapes();
    const a = buildIndex(single);
    const b = buildIndex(duplicated);

    expect(b.ordered.length).toBe(a.ordered.length);
    for (const [kind, events] of a.byKind) {
      expect(b.byKind.get(kind)?.length).toBe(events.length);
    }
    for (const [sessionId, events] of a.bySessionId) {
      expect(b.bySessionId.get(sessionId)?.length).toBe(events.length);
    }
  });

  it('does not double charsTyped', async () => {
    // `low_typing_high_output` divides output by this number, so doubling it
    // moves a real student toward — or away from — a high-severity flag.
    const { single, duplicated, filePath } = await bothShapes();
    const a = computeStats(buildIndex(single), single);
    const b = computeStats(buildIndex(duplicated), duplicated);

    expect(b.perFile.get(filePath)!.charsTyped).toBe(a.perFile.get(filePath)!.charsTyped);
    expect(b.perFile.get(filePath)!.charsPasted).toBe(a.perFile.get(filePath)!.charsPasted);
    expect(b.perFile.get(filePath)!.saves).toBe(a.perFile.get(filePath)!.saves);
    expect(b.sessionCount).toBe(a.sessionCount);
  });

  it('does not fabricate reconstructed file content', async () => {
    // Replaying every delta twice produces bytes the student never wrote.
    const { single, duplicated, filePath } = await bothShapes();
    const a = reconstructFile(buildIndex(single), filePath);
    const b = reconstructFile(buildIndex(duplicated), filePath);

    expect(b.content).toBe(a.content);
  });

  it('leaves check 7 agreeing with the single-copy bundle', async () => {
    // NOTE, because it corrects a claim that was made about this defect: check 7
    // is NOT reachable by the double replay. `verifyDocSaveHashes` iterates
    // `bundle.sessions` and replays each session's OWN `events` array, so two
    // copies of one session are two independent, individually-correct replays.
    // It is structurally immune, and it passed before this fix as well as after.
    //
    // Kept as a regression guard rather than deleted: it is exactly one
    // refactor — replaying from the shared `EventIndex` instead of per-session
    // arrays — away from becoming reachable, and this is the test that would
    // notice.
    const { single, duplicated } = await bothShapes();
    const a = verifyDocSaveHashes(single);
    const b = verifyDocSaveHashes(duplicated);

    expect(b.status).toBe(a.status);
    expect(b.detail).toBe(a.detail);
  });

  it('produces the same heuristic flags as the single-copy bundle', async () => {
    // The blunt end-to-end equivalence. Reaching every affected heuristic by
    // name would be a list that goes stale; this asserts the property the
    // student actually cares about — a backup copy of their own directory
    // changes no finding against them.
    //
    // HONESTY NOTE: on this fixture NO flag fires on either side, so this
    // assertion passed before the fix as well as after and is a guard, not a
    // reproduction. The doubling it guards against is proven by the four tests
    // above. It earns its place because the inputs the heuristics divide by
    // (`charsTyped`, reconstructed length) are the ones that were doubled, so a
    // regression here becomes a flag difference as soon as any fixture is big
    // enough to cross a threshold.
    const { single, duplicated } = await bothShapes();

    const report = { checks: [], overallStatus: 'pass' } as unknown as ValidationReport;
    const a = runHeuristics(buildIndex(single), single, report);
    const b = runHeuristics(buildIndex(duplicated), duplicated, report);

    // Whole flags, not just ids: a doubled `charsTyped` reaches a grader
    // through the flag's own description text even when the id set is stable.
    const key = (f: (typeof a)[number]): string => `${f.id}|${f.severity}|${f.description}`;
    expect(b.map(key).sort()).toEqual(a.map(key).sort());
  });

  it('replays ONE copy verbatim when the copies DISAGREE, never a merge of both', async () => {
    // The over-correction to guard against is not "keeps both" but "blends
    // them". A union-by-seq of two divergent copies reconstructs a file that
    // neither log records — the same fabrication as the double replay, just
    // harder to spot. The analysed stream must be one copy, byte for byte.
    const built = await buildTestBundle({
      sessions: [{ eventCount: 12, appendDocSave: true }],
      rollingSeal: {},
    });
    const fid = built.logFileIds[0]!;

    const zip = await JSZip.loadAsync(built.zipBuffer);
    const fullText = await zip.file(`session-${fid}.slog`)!.async('string');
    // A SHORTER copy of the same session: the first 6 entries. Still a valid
    // log — the chain over a prefix verifies — so it parses and competes.
    const lines = fullText.split('\n').filter((l) => l !== '');
    const shortText = lines.slice(0, 6).join('\n') + '\n';

    const otherFid = '99999999-0000-4000-8000-000000000000';
    zip.file(`session-${otherFid}.slog`, shortText);
    zip.file(
      `session-${otherFid}.slog.meta`,
      await zip.file(`session-${fid}.slog.meta`)!.async('uint8array'),
    );
    const dupZip = await zip.generateAsync({ type: 'arraybuffer' });

    const loaded = await loadBundle(dupZip, 'disagreeing.zip');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // Both copies are still carried, so the seal and the witness reader keep
    // the ambiguity they need.
    expect(loaded.value.sessions).toHaveLength(2);

    const index = buildIndex(loaded.value);
    const replayed = index.ordered.length;
    // Exactly one of the two copies was replayed — not their sum, and not a
    // union-by-seq (which would also equal the longer copy's length, so the
    // content assertion below is the one that separates them).
    expect([lines.length, 6]).toContain(replayed);

    const filePath = [...index.byFile.keys()][0]!;
    const content = reconstructFile(index, filePath).content;

    // Byte-for-byte what ONE of the copies produces on its own, so no third
    // string can have been invented by blending them.
    //
    // Deliberately agnostic about WHICH copy wins: each session carries its own
    // random ed25519 keypair, so the `slogSha256` tie-break is not stable across
    // runs. Asserting the identity of the winner would be asserting a coin
    // flip; the property that matters is that the answer is one whole copy.
    const perCopy = loaded.value.sessions.map(
      (s) => reconstructFile(buildIndex({ ...loaded.value, sessions: [s] }), filePath).content,
    );
    expect(perCopy).toContain(content);
    // ...and the two copies really do disagree, or this asserts nothing.
    expect(perCopy[0]).not.toBe(perCopy[1]);
  });

  it('leaves check 6 reading the seal exactly as bug 12 left it', async () => {
    // The seal resolution genuinely needs every claimant, so the de-duplication
    // must happen for the INDEX without disturbing coverage. Byte-identical
    // claimants agree, so the answer stands.
    const { duplicated } = await bothShapes();
    expect(duplicated.rollingSeal!.coverage!).toHaveLength(1);
    expect(duplicated.rollingSeal!.coverage![0]!.slog).toEqual({ kind: 'exact' });
    expect(verifyLogBytes(duplicated).status).toBe('pass');
  });
});
