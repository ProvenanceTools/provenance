/**
 * CONCURRENT rolling seals: the union manifest must carry the FRESHEST recorded
 * hash per path, not the one belonging to whichever session started last.
 *
 * ## The bug
 *
 * `parse-bundle.ts` sorts sessions oldest → newest by `firstEvent.wall` — by
 * session START — and `synthesizeRollingUnionManifest` merged `submission_files`
 * last-writer-wins in that order, documented as "the newest session's hash is
 * the current truth".
 *
 * That holds for one student working sessions back to back. It breaks the
 * moment two students record against ONE shared repo, because a session that
 * STARTS later can END earlier:
 *
 *   session A  start 23:35:51  last event 23:57:26   seals the current bytes
 *   session B  start 23:41:08  last event 23:48:58   seals what was there at 23:48
 *
 * Session order by start is [A, B], so B is the last writer — and B's staler
 * hashes overwrite A's fresher ones for files B never even touched (a rolling
 * seal records the on-disk state of EVERY file under review as of that session's
 * last checkpoint, not just the ones that session edited). `parse-bundle.ts`
 * then hashes the submitted bytes, finds they disagree with the union's
 * `sha256`, sets `hashOk = false`, and check 8 short-circuits to
 * "Submitted bytes do not match their own manifest sha256 (tampered bundle)"
 * before its event-based comparison — which passes — is ever reached.
 *
 * This is NOT an artifact of an unclean shutdown. Both sessions here end
 * cleanly, with `final: true` seals, and the false finding still fires.
 *
 * The last test is the one that keeps the fix honest: bytes that match NO
 * recorded state must still come out as a tampered bundle, in either order.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { sha256Hex } from '@provenance/log-core';
import { loadBundle } from './parse-bundle.js';
import { runValidation } from '../validation/run-validation.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

const FIXED_NOW = '2026-01-01T12:00:00.000Z';
const fixedNow = (): string => FIXED_NOW;

// The two disputed files, plus one only the second student touched.
const ARRAY_DEQUE = 'ArrayDeque.java';
const LINKED_DEQUE = 'LinkedListDeque.java';
const DEQUE = 'Deque.java';

const ARRAY_FINAL = 'class ArrayDeque { /* ana, 23:57 */ }\n';
const LINKED_FINAL = 'class LinkedListDeque { /* ana, 23:47 */ }\n';
const DEQUE_FINAL = 'interface Deque { /* ben, 23:48 */ }\n';

const shaOf = (text: string): string => sha256Hex(new TextEncoder().encode(text));

/** What was on disk at 23:48, i.e. what the earlier-finishing seal recorded. */
const ARRAY_STALE = shaOf('class ArrayDeque { /* ana, 23:40 */ }\n');
const LINKED_STALE = shaOf('class LinkedListDeque { /* ana, 23:44 */ }\n');

/**
 * Two students, one repo, overlapping sessions — the later-STARTING session
 * (index 1, Ben) stops recording nine minutes BEFORE the earlier-starting one
 * (index 0, Ana).
 *
 * Ana's seal is the fresh one: she was still recording at 23:57:26, so her
 * rolling manifest carries the current on-disk hash of every reviewed file.
 * Ben's seal is honest and stale: at 23:48:58 the two Deque files were still
 * mid-edit on Ana's machine.
 *
 * `freshArraySha` / `arrayBytes` let a caller move ArrayDeque.java's recorded
 * and submitted hashes apart without changing anything else about the shape.
 */
async function buildConcurrentBundle(opts?: {
  /** Sha the FRESH (Ana, index 0) seal records for ArrayDeque.java. */
  freshArraySha?: string;
  /** Bytes actually shipped in the ZIP for ArrayDeque.java. */
  arrayBytes?: string;
}): Promise<Awaited<ReturnType<typeof buildTestBundle>>> {
  const arrayBytes = opts?.arrayBytes ?? ARRAY_FINAL;
  const freshArraySha = opts?.freshArraySha ?? shaOf(arrayBytes);

  return buildTestBundle({
    submissionFiles: [
      { path: ARRAY_DEQUE, status: 'present', content: arrayBytes },
      { path: LINKED_DEQUE, status: 'present', content: LINKED_FINAL },
      { path: DEQUE, status: 'present', content: DEQUE_FINAL },
    ],
    sessions: [
      // Ana — starts first, finishes LAST.
      {
        machineId: 'laptop-ana',
        walls: ['2026-01-01T23:35:51.000Z'],
        events: [
          {
            kind: 'doc.save',
            data: { path: LINKED_DEQUE, sha256: shaOf(LINKED_FINAL) },
            wall: '2026-01-01T23:47:02.000Z',
            t: 671_000,
          },
          {
            kind: 'doc.save',
            data: { path: ARRAY_DEQUE, sha256: shaOf(arrayBytes) },
            wall: '2026-01-01T23:57:26.000Z',
            t: 1_295_000,
          },
        ],
      },
      // Ben — starts SECOND, finishes FIRST.
      {
        machineId: 'laptop-ben',
        walls: ['2026-01-01T23:41:08.000Z'],
        events: [
          {
            kind: 'doc.save',
            data: { path: DEQUE, sha256: shaOf(DEQUE_FINAL) },
            wall: '2026-01-01T23:48:58.000Z',
            t: 470_000,
          },
        ],
      },
    ],
    rollingSeal: {
      final: true,
      submissionShaFor: [
        // Ana's seal, taken at 23:57:26 — current truth for every path.
        { sessionIndex: 0, shas: { [ARRAY_DEQUE]: freshArraySha } },
        // Ben's seal, taken at 23:48:58 — honest, and stale for Ana's files.
        {
          sessionIndex: 1,
          shas: { [ARRAY_DEQUE]: ARRAY_STALE, [LINKED_DEQUE]: LINKED_STALE },
        },
      ],
    },
  });
}

describe('two concurrent rolling seals against one repo', () => {
  it('carries the freshest recorded hash per path, not the last session to START', async () => {
    const { blob } = await buildConcurrentBundle();

    const loaded = await loadBundle(blob, 'hw1.zip', fixedNow);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const bundle = loaded.value;

    // Session order is still by START — the loader's own ordering is unchanged,
    // and everything else the union derives still reads it.
    expect(bundle.manifest.sessions.map((s) => s.session_id)).toEqual([
      bundle.sessions[0]!.sessionId,
      bundle.sessions[1]!.sessionId,
    ]);
    expect(bundle.sessions[0]!.firstEvent.wall).toBe('2026-01-01T23:35:51.000Z');

    // The union's file hashes come from the seal that was written LAST.
    expect(bundle.submissionFiles.get(ARRAY_DEQUE)?.sha256).toBe(shaOf(ARRAY_FINAL));
    expect(bundle.submissionFiles.get(LINKED_DEQUE)?.sha256).toBe(shaOf(LINKED_FINAL));
    expect(bundle.submissionFiles.get(DEQUE)?.sha256).toBe(shaOf(DEQUE_FINAL));

    // …so the submitted bytes agree with their own manifest.
    for (const path of [ARRAY_DEQUE, LINKED_DEQUE, DEQUE]) {
      expect(bundle.submissionFiles.get(path)?.hashOk).toBe(true);
    }
  });

  it('passes check 8 on an honest group submission', async () => {
    const { blob } = await buildConcurrentBundle();

    const loaded = await loadBundle(blob, 'hw1.zip', fixedNow);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const report = await runValidation(loaded.value);
    const check8 = report.checks.find((c) => c.id === 'submitted_code_match')!;
    expect(check8.detail).not.toMatch(/tampered bundle/);
    expect(check8.status).toBe('pass');
  });

  it('still reports a tampered bundle when the bytes match NO recorded state', async () => {
    // Ana's fresh seal commits to the pre-tamper bytes; Ben's stale seal commits
    // to something else again; the ZIP carries bytes neither ever saw. Whichever
    // seal wins the merge, the submitted bytes disagree with it.
    const tamperedBytes = 'class ArrayDeque { /* pasted in after the fact */ }\n';
    const { blob } = await buildConcurrentBundle({
      arrayBytes: tamperedBytes,
      freshArraySha: shaOf(ARRAY_FINAL),
    });

    const loaded = await loadBundle(blob, 'hw1.zip', fixedNow);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const bundle = loaded.value;

    const entry = bundle.submissionFiles.get(ARRAY_DEQUE)!;
    expect(entry.sha256).toBe(shaOf(ARRAY_FINAL));
    expect(entry.sha256).not.toBe(shaOf(tamperedBytes));
    expect(entry.hashOk).toBe(false);

    const report = await runValidation(bundle);
    const check8 = report.checks.find((c) => c.id === 'submitted_code_match')!;
    expect(check8.status).toBe('fail');
    expect(check8.detail).toContain(ARRAY_DEQUE);
    expect(check8.detail).toContain('tampered bundle');
  });
});

describe('sequential rolling seals are unaffected', () => {
  it('still lets the later session win when the sessions do not overlap', async () => {
    // Session 0 ends at 23:20 before session 1 starts at 23:30, so recency order
    // and start order agree. The later session's seal is the last writer, exactly
    // as before this fix.
    const built = await buildTestBundle({
      submissionFiles: [{ path: ARRAY_DEQUE, status: 'present', content: ARRAY_FINAL }],
      sessions: [
        {
          machineId: 'laptop-ana',
          walls: ['2026-01-01T23:10:00.000Z'],
          events: [
            {
              kind: 'doc.save',
              data: { path: ARRAY_DEQUE, sha256: ARRAY_STALE },
              wall: '2026-01-01T23:20:00.000Z',
              t: 600_000,
            },
          ],
        },
        {
          machineId: 'laptop-ana',
          walls: ['2026-01-01T23:30:00.000Z'],
          events: [
            {
              kind: 'doc.save',
              data: { path: ARRAY_DEQUE, sha256: shaOf(ARRAY_FINAL) },
              wall: '2026-01-01T23:40:00.000Z',
              t: 600_000,
            },
          ],
        },
      ],
      rollingSeal: {
        final: true,
        submissionShaFor: [{ sessionIndex: 0, shas: { [ARRAY_DEQUE]: ARRAY_STALE } }],
      },
    });

    const loaded = await loadBundle(built.blob, 'hw1.zip', fixedNow);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.submissionFiles.get(ARRAY_DEQUE)?.sha256).toBe(shaOf(ARRAY_FINAL));
    expect(loaded.value.submissionFiles.get(ARRAY_DEQUE)?.hashOk).toBe(true);

    const report = await runValidation(loaded.value);
    expect(report.checks.find((c) => c.id === 'submitted_code_match')!.status).toBe('pass');
  });
});
