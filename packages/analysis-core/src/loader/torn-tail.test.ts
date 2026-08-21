/**
 * A TORN LAST LINE — the crash artifact that wears the log's own name.
 *
 * ## The defect
 *
 * A power cut, a full disk, or an OS kill part-way through a flush leaves a
 * half-written trailing line in the `.slog`. Unlike every other crash residue
 * the read-side orphan guard learned to absorb, this one sits under the file's
 * completely NORMAL name: `session-<uuid>.slog`. None of the `.corrupt-` /
 * `.tmp` / zero-byte patterns `unzip.ts` drops can match it, so it reaches
 * `parseSession`, which returns `ndjson_parse_failed`, and `parse-bundle.ts`
 * returned that error for the WHOLE BUNDLE before a single validation check ran.
 * `loadSubmissionIndex` throws on a load failure, so every server read path
 * threw with it.
 *
 * Cost to the student: every session they recorded, for a crash they could not
 * have prevented. The read-side guard stopped one layer short of this case.
 *
 * ## The fix, and the line it must not cross
 *
 * The loader now truncates the `.slog` to its last COMPLETE entry and KEEPS the
 * session, because the chain over that prefix still verifies and discarding it
 * would throw away real evidence. That tolerance is dangerous in exactly one
 * direction, and these tests exist mostly to fence it:
 *
 *   - the digests compared by `log_bytes_match` are taken by the unzipper over
 *     the RAW ARCHIVE BYTES and are never recomputed from the truncated view.
 *     Recomputing them would let an attacker append past a seal, tear the last
 *     line, and watch a failing byte check turn into a passing one;
 *   - the rolling seal's prefix search likewise runs over the FULL archived
 *     text. Running it over the truncated view would make the text fail to
 *     re-encode to the archived digest, which `computeSlogCoverage` answers
 *     `unavailable`, which falls through to WHOLE-FILE equality on a prefix
 *     commitment — the sixth route to the bug-5/10/12 false accusation, firing
 *     on precisely the crash victim this fix exists for;
 *   - tolerance applies ONLY to bytes after the final `\n`. A corrupt line in
 *     the MIDDLE is not a crash artifact and stays fatal.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { sha256Hex } from '@provenance/log-core';
import JSZip from 'jszip';
import { loadBundle } from './parse-bundle.js';
import { runValidation } from '../validation/run-validation.js';
import { buildIndex } from '../index/build-index.js';
import { coverageFacts, hasCoverageFacts } from '../coverage/coverage-facts.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

const fixedNow = (): string => '2026-08-21T00:00:00.000Z';

/** Read one `.slog`'s exact archived bytes back out of a built ZIP. */
async function slogBytes(zipBuffer: ArrayBuffer, logFileId: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const f = zip.file(`session-${logFileId}.slog`);
  if (f === null) throw new Error(`no session-${logFileId}.slog in the archive`);
  return f.async('uint8array');
}

// ---------------------------------------------------------------------------
// 1. The defect itself.
// ---------------------------------------------------------------------------

describe('a torn last line in a .slog', () => {
  it('does not destroy the whole submission', async () => {
    const built = await buildTestBundle({
      sessions: [{ eventCount: 4 }, { eventCount: 4 }],
      tamper: { tornTail: { sessionIndex: 1 } },
    });

    const result = await loadBundle(built.blob, 'crashed.zip', fixedNow);

    // Before the fix this was `{ ok: false, error: { kind: 'ndjson_parse_failed' } }`
    // and BOTH sessions were lost.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions).toHaveLength(2);
  });

  it('keeps every complete entry of the torn session, and only drops the fragment', async () => {
    const whole = await buildTestBundle({ sessions: [{ eventCount: 6 }] });
    const torn = await buildTestBundle({
      sessions: [{ eventCount: 6 }],
      tamper: { tornTail: { sessionIndex: 0 } },
    });

    const a = await loadBundle(whole.blob, 'whole.zip', fixedNow);
    const b = await loadBundle(torn.blob, 'torn.zip', fixedNow);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // The fragment carried no entry, so nothing analysable was lost.
    expect(b.value.sessions[0]!.events.map((e) => e.seq)).toEqual(
      a.value.sessions[0]!.events.map((e) => e.seq),
    );
  });

  it('reports the truncation as a fact rather than applying it silently', async () => {
    const built = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      tamper: { tornTail: { sessionIndex: 0 } },
    });
    const result = await loadBundle(built.blob, 'crashed.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tail = result.value.sessions[0]!.tornTail;
    expect(tail).not.toBeNull();
    expect(tail!.line).toBeGreaterThan(0);
    expect(tail!.discardedChars).toBeGreaterThan(0);
    // The prose must name the innocent reading, because this fires only on
    // students who did nothing.
    expect(tail!.detail.toLowerCase()).toContain('interrupt');
  });

  it('a complete final entry that merely lost its newline is KEPT, not discarded', async () => {
    // A flush that wrote the whole line and died before the terminator. The
    // entry is intact, chains, and must not be thrown away over a missing byte.
    const whole = await buildTestBundle({ sessions: [{ eventCount: 4 }] });
    const zip = await JSZip.loadAsync(whole.zipBuffer);
    const name = `session-${whole.logFileIds[0]!}.slog`;
    const text = await zip.file(name)!.async('string');
    zip.file(name, text.replace(/\n$/, ''));
    const blob = new Blob([await zip.generateAsync({ type: 'arraybuffer' })]);

    const result = await loadBundle(blob, 'no-final-newline.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions[0]!.events).toHaveLength(5);
    expect(result.value.sessions[0]!.tornTail).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Proving the negative: the middle is untouched.
// ---------------------------------------------------------------------------

describe('a corrupt line in the MIDDLE is a different fact and stays fatal', () => {
  it('still fails the load', async () => {
    const built = await buildTestBundle({
      sessions: [{ eventCount: 6 }],
      tamper: { corruptNdjsonAtLine: { sessionIndex: 0, line: 3 } },
    });
    const result = await loadBundle(built.blob, 'mid.zip', fixedNow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('ndjson_parse_failed');
  });

  it('is not rescued by ALSO tearing the last line', async () => {
    // The obvious way to abuse a tail-tolerant reader: hide a mid-file edit
    // behind a torn tail, hoping the reader gives up at the first bad line and
    // keeps whatever came before. It must not.
    const built = await buildTestBundle({
      sessions: [{ eventCount: 6 }],
      tamper: {
        corruptNdjsonAtLine: { sessionIndex: 0, line: 3 },
        tornTail: { sessionIndex: 0 },
      },
    });
    const result = await loadBundle(built.blob, 'mid-plus-tear.zip', fixedNow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('ndjson_parse_failed');
    if (result.error.kind !== 'ndjson_parse_failed') return;
    expect(result.error.line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Proving the negative: the byte check keeps its full strength.
// ---------------------------------------------------------------------------

describe('truncation cannot launder a modification', () => {
  it("the session carries the ARCHIVED digest, never the truncated view's", async () => {
    const built = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      tamper: { tornTail: { sessionIndex: 0 } },
    });
    const result = await loadBundle(built.blob, 'torn.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const archived = await slogBytes(built.zipBuffer, built.logFileIds[0]!);
    expect(result.value.sessions[0]!.slogSha256).toBe(sha256Hex(archived));

    // And it is NOT the digest of what the reader kept — that value is what an
    // attacker would need this check to compare against.
    const keptPrefix = new TextDecoder()
      .decode(archived)
      .slice(0, new TextDecoder().decode(archived).lastIndexOf('\n') + 1);
    expect(result.value.sessions[0]!.slogSha256).not.toBe(sha256Hex(keptPrefix));
  });

  it('TRUNCATE-TO-SEAL: bytes added past a FINAL seal and then torn still fail', async () => {
    // The purest form of the laundering attack, and the one a reader that
    // re-hashed its own truncated view would hand over for free.
    //
    // A FINAL rolling seal is written by dispose() AFTER session.end is
    // emitted and both files are flushed and closed, so it commits to the whole
    // file. Append anything unterminated to that finished log and the kept
    // prefix is EXACTLY the sealed bytes — so a reader hashing what it kept
    // would reproduce the committed digest and report `exact`. Hashing the
    // ARCHIVE instead reports the difference, which is what it is.
    //
    // This is not a false accusation against a crash victim: dispose() writes
    // the final seal only after the log is flushed and closed, so the recorder
    // that produced a final seal can no longer tear its own file. A final seal
    // beside a torn log means the bytes changed after the writer said it was
    // finished.
    const built = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      rollingSeal: { final: true },
      tamper: { tornTail: { sessionIndex: 0 } },
    });
    const result = await loadBundle(built.blob, 'truncate-to-seal.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions[0]!.tornTail).not.toBeNull();

    const report = await runValidation(result.value);
    const bytes = (report.bundleDetections ?? []).find((d) => d.id === 'log_bytes_match');
    expect(bytes?.status).toBe('fail');
  });

  it('a post-seal append hidden behind a torn tail still fails log_bytes_match at full strength', async () => {
    // The laundering attack, driven. Append a well-formed, correctly-chained
    // entry past a FINAL rolling seal (which commits to the whole file), then
    // tear the very last line so a tolerant reader has something to discard.
    // If the reader ever hashed only what it kept, this would pass.
    const built = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      rollingSeal: { final: true },
    });
    const zip = await JSZip.loadAsync(built.zipBuffer);
    const name = `session-${built.logFileIds[0]!}.slog`;
    const text = await zip.file(name)!.async('string');
    const lines = text.split('\n').filter((l) => l !== '');
    const last = lines[lines.length - 1]!;
    // A real append (the thing being hidden) plus a torn fragment after it.
    zip.file(name, text + last + '\n' + last.slice(0, 20));
    const blob = new Blob([await zip.generateAsync({ type: 'arraybuffer' })]);

    const result = await loadBundle(blob, 'append-then-tear.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions[0]!.tornTail).not.toBeNull();

    const report = await runValidation(result.value);
    const bytes = (report.bundleDetections ?? []).find((d) => d.id === 'log_bytes_match');
    expect(bytes?.status).toBe('fail');
  });

  it('an HONEST crash under a non-final rolling seal is not accused', async () => {
    // The mirror of the test above, and the whole point of the exercise: the
    // same shape without the append must PASS, with the tail simply unattested.
    const built = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      rollingSeal: { final: false },
      tamper: { tornTail: { sessionIndex: 0 } },
    });

    const result = await loadBundle(built.blob, 'crashed-git-scope.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = await runValidation(result.value);
    const bytes = (report.bundleDetections ?? []).find((d) => d.id === 'log_bytes_match');
    expect(bytes?.status).toBe('pass');

    // The seal is STILL resolved against this session — it must not have been
    // dropped along with anything, because a dropped seal becomes a
    // `no_session_log` defect and fails check 1 at high severity.
    const defects = result.value.rollingSeal?.defects ?? [];
    expect(defects.map((d) => d.kind)).not.toContain('no_session_log');
    expect(defects.map((d) => d.kind)).not.toContain('unsealed_session');
    expect(result.value.rollingSeal?.coverage ?? []).toHaveLength(1);
  });

  it('the rolling prefix search runs over the FULL archived bytes, not the kept prefix', async () => {
    // If coverage were computed from the truncated text it would fail to
    // re-encode to the archived digest, `computeSlogCoverage` would answer
    // `unavailable`, and `verify-log-bytes.ts` would fall back to WHOLE-FILE
    // equality against a prefix commitment — failing at high severity on a
    // crash victim. The coverage verdict must be `partial` over the whole file.
    const built = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      rollingSeal: { final: false },
      tamper: { tornTail: { sessionIndex: 0 } },
    });
    const result = await loadBundle(built.blob, 'crashed-git-scope.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cov = result.value.rollingSeal!.coverage![0]!;
    expect(cov.slog.kind).toBe('partial');
    if (cov.slog.kind !== 'partial') return;
    const archived = await slogBytes(built.zipBuffer, built.logFileIds[0]!);
    // `total` is the whole archived file, fragment included — the reader
    // measured what is there, not what it chose to parse.
    expect(cov.slog.total).toBe(archived.length);
    expect(cov.slog.sealed).toBeLessThan(cov.slog.total);
  });

  it('a classic bundle resealed over the torn bytes still passes, and one that was not still fails', async () => {
    // The classic path is unchanged in both directions. `seal` reads whatever
    // is on disk, so a tear BEFORE sealing is committed to and matches; a tear
    // AFTER sealing is a genuine post-seal byte change and must fail.
    const resealed = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      tamper: { tornTail: { sessionIndex: 0, resealAfterTear: true } },
    });
    const a = await loadBundle(resealed.blob, 'resealed.zip', fixedNow);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const reportA = await runValidation(a.value);
    expect((reportA.bundleDetections ?? []).find((d) => d.id === 'log_bytes_match')?.status).toBe(
      'pass',
    );

    const after = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      tamper: { tornTail: { sessionIndex: 0 } },
    });
    const b = await loadBundle(after.blob, 'torn-after-seal.zip', fixedNow);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const reportB = await runValidation(b.value);
    expect((reportB.bundleDetections ?? []).find((d) => d.id === 'log_bytes_match')?.status).toBe(
      'fail',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The fact reaches the stage that reports it.
//
// Written after mutation testing found the gap: emptying `tornTails` in the
// coverage stage left every analysis-core test green and was caught only by an
// analyzer render test, one package away. A fact whose only pin lives in a
// consumer is a fact this package can silently stop producing.
// ---------------------------------------------------------------------------

describe('the coverage stage carries the truncation', () => {
  it('reports one fact per torn session, with the session id and the loss', async () => {
    const built = await buildTestBundle({
      sessions: [{ eventCount: 4 }, { eventCount: 4 }],
      tamper: { tornTail: { sessionIndex: 1 } },
    });
    const result = await loadBundle(built.blob, 'crashed.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const facts = coverageFacts(result.value, buildIndex(result.value));
    expect(facts.tornTails).toHaveLength(1);
    expect(facts.tornTails[0]!.sessionId).toBe(built.sessionIds[1]);
    expect(facts.tornTails[0]!.discardedChars).toBeGreaterThan(0);
    // The panel renders on `hasCoverageFacts`; a fact it does not switch on is
    // a fact the panel never shows.
    expect(hasCoverageFacts(facts)).toBe(true);
  });

  it('says nothing when no log was torn', async () => {
    const built = await buildTestBundle({ sessions: [{ eventCount: 4 }] });
    const result = await loadBundle(built.blob, 'clean.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(coverageFacts(result.value, buildIndex(result.value)).tornTails).toEqual([]);
  });

  it('is NOT reported as a dropped artifact — the file was analysed', async () => {
    // `droppedArtifacts` says a file was left out entirely, and both of its
    // renderers say so in prose ("N files could not be analysed"). A torn
    // session was analysed; folding the two together would state a falsehood
    // on two staff-facing surfaces.
    const built = await buildTestBundle({
      sessions: [{ eventCount: 4 }],
      tamper: { tornTail: { sessionIndex: 0 } },
    });
    const result = await loadBundle(built.blob, 'crashed.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.droppedArtifacts).toEqual([]);
    expect(result.value.sessions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. The rest of the analysis is unharmed.
// ---------------------------------------------------------------------------

describe('the surviving prefix is analysed at full strength', () => {
  it('the hash chain over the kept entries still verifies', async () => {
    const built = await buildTestBundle({
      sessions: [{ eventCount: 6 }],
      tamper: { tornTail: { sessionIndex: 0 } },
    });
    const result = await loadBundle(built.blob, 'torn.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = await runValidation(result.value);
    expect(report.checks.find((c) => c.id === 'chain_integrity')?.status).toBe('pass');
  });

  it('a broken chain inside the kept prefix still fails', async () => {
    const built = await buildTestBundle({
      sessions: [{ eventCount: 6 }],
      tamper: {
        breakChainAt: { sessionIndex: 0, entryIndex: 2 },
        tornTail: { sessionIndex: 0 },
      },
    });
    const result = await loadBundle(built.blob, 'torn-and-broken.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = await runValidation(result.value);
    expect(report.checks.find((c) => c.id === 'chain_integrity')?.status).toBe('fail');
  });
});
