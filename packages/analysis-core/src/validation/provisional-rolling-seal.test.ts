/**
 * Check 8 against a PROVISIONAL (non-final) rolling seal.
 *
 * ## The bug
 *
 * A git-submitted assignment carries rolling seals, rewritten only at
 * checkpoints and once more, marked `final`, at clean shutdown. Students save
 * and `git commit` while the editor is still open, so the committed seal is
 * NON-FINAL and its `submission_files[].sha256` is an EARLIER genuine recorded
 * state of the file — the last save(s) came after the last checkpoint.
 *
 * The loader computed `hashOk = sha256(bytes) === seal sha` and check 8
 * short-circuited `bytes present && !hashOk` to "Submitted bytes do not match
 * their own manifest sha256 (tampered bundle)" — a high-severity accusation
 * against a student whose submission matched their own last recorded save.
 * With the bytes stripped (stored bundles are provenance-only) the stale seal
 * sha was compared against the last recorded hash instead, and accused again.
 *
 * ## What must still hold
 *
 *   - bytes matching NO recorded state are still a mismatch at full strength;
 *   - a FINAL seal and a classic-only bundle are byte-for-byte unchanged.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { sha256Hex } from '@provenance/log-core';
import { loadBundle } from '../loader/parse-bundle.js';
import type { Bundle } from '../loader/types.js';
import { runValidation } from './run-validation.js';
import type { ValidationOptions } from './run-validation.js';
import { computeSubmittedShas, submittedFileVerdicts } from './verify-submitted-code.js';
import { integrityFlagsFromReport } from '../heuristics/integrity-flags.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import type { BuildBundleOpts } from '../test-support/build-test-bundle.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

const fixedNow = (): string => '2026-01-01T12:00:00.000Z';
const shaOf = (text: string): string => sha256Hex(new TextEncoder().encode(text));

const FILE = 'solution.py';
/** Opened at session start. */
const V0 = 'def f():\n    return 0\n';
/** Saved, then captured by the last checkpoint's seal. */
const V1 = 'def f():\n    return 1\n';
/** Saved AFTER the last checkpoint, then committed with the editor still open. */
const V2 = 'def f():\n    return 2\n';
/** Never on disk while the recorder was watching. */
const FOREIGN = 'def f():\n    return 42  # pasted in after the fact\n';

type Shape = {
  /** Seal kind. `classic` = classic-only `manifest.json`, no rolling seals. */
  seal: 'rolling-provisional' | 'rolling-final' | 'classic' | 'both-shapes';
  /** Bytes in the ZIP; `null` models a source-stripped stored bundle. */
  submitted: string | null;
  /** Content the seal's `submission_files` sha256 is taken over. */
  sealedAs: string;
};

async function build(shape: Shape): Promise<Bundle> {
  const opts: BuildBundleOpts = {
    submissionFiles: [
      {
        path: FILE,
        status: 'present',
        ...(shape.submitted !== null ? { content: shape.submitted } : {}),
        manifestSha256Override: shaOf(shape.sealedAs),
      },
    ],
    sessions: [
      {
        walls: ['2026-01-01T10:00:00.000Z'],
        events: [
          {
            kind: 'doc.open',
            data: { path: FILE, sha256: shaOf(V0) },
            wall: '2026-01-01T10:00:01.000Z',
            t: 1_000,
          },
          {
            kind: 'doc.save',
            data: { path: FILE, sha256: shaOf(V1) },
            wall: '2026-01-01T10:05:00.000Z',
            t: 300_000,
          },
          {
            kind: 'doc.save',
            data: { path: FILE, sha256: shaOf(V2) },
            wall: '2026-01-01T10:05:40.000Z',
            t: 340_000,
          },
        ],
      },
    ],
    ...(shape.seal === 'classic'
      ? {}
      : {
          rollingSeal: {
            final: shape.seal !== 'rolling-provisional',
            ...(shape.seal === 'both-shapes' ? { alsoClassic: true } : {}),
          },
        }),
  };
  const built = await buildTestBundle(opts);
  const loaded = await loadBundle(built.blob, 'hw.zip', fixedNow);
  if (!loaded.ok) throw new Error(`load failed: ${JSON.stringify(loaded.error)}`);
  return loaded.value;
}

async function check8(bundle: Bundle, options: ValidationOptions = {}) {
  const report = await runValidation(bundle, options);
  const check = report.checks.find((c) => c.id === 'submitted_code_match')!;
  const flags = integrityFlagsFromReport(report).filter(
    (f) => f.heuristic === 'submitted_code_match',
  );
  return { check, flags };
}

describe('non-final rolling seal, bytes present', () => {
  it('marks the entry provisional and records the actual submitted sha', async () => {
    const bundle = await build({ seal: 'rolling-provisional', submitted: V2, sealedAs: V1 });
    const entry = bundle.submissionFiles.get(FILE)!;
    expect(entry.provisional).toBe(true);
    expect(entry.sha256).toBe(shaOf(V1));
    expect(entry.submittedSha256).toBe(shaOf(V2));
    // `hashOk` keeps its meaning: the bytes do not agree with the seal.
    expect(entry.hashOk).toBe(false);
  });

  it('passes when the submitted file is the last recorded save (seal predates it)', async () => {
    const bundle = await build({ seal: 'rolling-provisional', submitted: V2, sealedAs: V1 });

    const [v] = submittedFileVerdicts(bundle, { chainIntact: true });
    expect(v!.verdict).toBe('match');
    expect(v!.submittedSha).toBe(shaOf(V2));
    expect(v!.recordedSha).toBe(shaOf(V2));
    expect(v!.detail).not.toMatch(/tampered/);
    expect(v!.detail).toMatch(/provisional/);
    expect(v!.detail).toMatch(/predates the last recorded save/);

    const { check, flags } = await check8(bundle);
    expect(check.status).toBe('pass');
    expect(flags).toEqual([]);
  });

  it('is unchanged when the provisional seal happens to be current', async () => {
    const bundle = await build({ seal: 'rolling-provisional', submitted: V2, sealedAs: V2 });
    const [v] = submittedFileVerdicts(bundle, { chainIntact: true });
    expect(v!.verdict).toBe('match');
    expect(v!.detail).toBe('Submitted file matches the last recorded on-disk state.');
  });

  it('still fails at full strength when the bytes match NO recorded state', async () => {
    const bundle = await build({ seal: 'rolling-provisional', submitted: FOREIGN, sealedAs: V1 });

    const [v] = submittedFileVerdicts(bundle, { chainIntact: true });
    expect(v!.verdict).toBe('mismatch');
    expect(v!.submittedSha).toBe(shaOf(FOREIGN));
    expect(v!.detail).toMatch(/matches neither the seal's sha256/);

    const { check, flags } = await check8(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain(FILE);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.confidence).toBe(1.0);
  });

  it('fails foreign bytes even when the chain is broken (the sub-check precedes the gate)', async () => {
    const bundle = await build({ seal: 'rolling-provisional', submitted: FOREIGN, sealedAs: V1 });
    const [v] = submittedFileVerdicts(bundle, { chainIntact: false });
    expect(v!.verdict).toBe('mismatch');
  });

  it('runs the ordinary comparison for bytes matching an EARLIER recorded state', async () => {
    // The bytes are a genuine recorded state, just not the last one. That is
    // the ordinary event-based comparison's question, and its answer is the
    // ordinary one — no provisional leniency beyond "the seal is not a
    // commitment".
    const bundle = await build({ seal: 'rolling-provisional', submitted: V0, sealedAs: V1 });
    const [v] = submittedFileVerdicts(bundle, { chainIntact: true });
    expect(v!.verdict).toBe('mismatch');
    expect(v!.submittedSha).toBe(shaOf(V0));
    expect(v!.recordedSha).toBe(shaOf(V2));
    expect(v!.detail).toMatch(/!= last recorded on-disk sha256/);
    expect(v!.detail).toMatch(/provisional/);
  });

  it('reports a provisional attachment with later bytes as unknown, not tampered', async () => {
    const bundle = await build({ seal: 'rolling-provisional', submitted: V2, sealedAs: V1 });
    // The builder has no attachment role; the verdict reads only `role`.
    bundle.submissionFiles.get(FILE)!.role = 'attachment';
    const [v] = submittedFileVerdicts(bundle, { chainIntact: true });
    expect(v!.verdict).toBe('unknown');
    expect(v!.submittedSha).toBe(shaOf(V2));
    expect(v!.detail).not.toMatch(/tampered bundle/);
  });
});

describe('FINAL rolling seal is a commitment (unchanged)', () => {
  it('is not provisional', async () => {
    const bundle = await build({ seal: 'rolling-final', submitted: V2, sealedAs: V1 });
    expect(bundle.submissionFiles.get(FILE)!.provisional).toBeUndefined();
  });

  it('reports stale bytes as a tampered bundle', async () => {
    const bundle = await build({ seal: 'rolling-final', submitted: V2, sealedAs: V1 });
    const [v] = submittedFileVerdicts(bundle, { chainIntact: true });
    expect(v).toEqual({
      path: FILE,
      status: 'present',
      verdict: 'mismatch',
      submittedSha: shaOf(V1),
      recordedSha: null,
      detail: 'Submitted bytes do not match their own manifest sha256 (tampered bundle).',
      supportingSeqs: [],
    });
    const { check, flags } = await check8(bundle);
    expect(check.status).toBe('fail');
    expect(flags[0]!.severity).toBe('high');
  });

  it('ignores persisted shas when the bytes are stripped', async () => {
    const bundle = await build({ seal: 'rolling-final', submitted: null, sealedAs: V1 });
    const [v] = submittedFileVerdicts(bundle, {
      chainIntact: true,
      submittedShas: { [FILE]: shaOf(V2) },
    });
    // The seal's own sha against the recording, exactly as before.
    expect(v!.verdict).toBe('mismatch');
    expect(v!.submittedSha).toBe(shaOf(V1));
  });
});

describe('source-stripped bundle with a provisional seal', () => {
  it('is unknown — never mismatch — when no persisted sha is supplied', async () => {
    const bundle = await build({ seal: 'rolling-provisional', submitted: null, sealedAs: V1 });
    const entry = bundle.submissionFiles.get(FILE)!;
    expect(entry.provisional).toBe(true);
    expect(entry.bytes).toBeUndefined();

    const [v] = submittedFileVerdicts(bundle, { chainIntact: true });
    expect(v!.verdict).toBe('unknown');
    expect(v!.submittedSha).toBeNull();
    expect(v!.detail).toMatch(/not retained and the seal is provisional/);

    // `unknown` alone → check 8 `skipped` → no flag at all.
    const { check, flags } = await check8(bundle);
    expect(check.status).toBe('skipped');
    expect(check.detail).toMatch(/seal is provisional/);
    expect(flags).toEqual([]);
  });

  it('matches when the persisted actual sha is the last recorded save', async () => {
    const bundle = await build({ seal: 'rolling-provisional', submitted: null, sealedAs: V1 });
    const options = { submittedShas: { [FILE]: shaOf(V2) } };

    const [v] = submittedFileVerdicts(bundle, { chainIntact: true, ...options });
    expect(v!.verdict).toBe('match');
    expect(v!.submittedSha).toBe(shaOf(V2));

    const { check, flags } = await check8(bundle, options);
    expect(check.status).toBe('pass');
    expect(flags).toEqual([]);
  });

  it('still fails at full strength when the persisted sha matches no recorded state', async () => {
    const bundle = await build({ seal: 'rolling-provisional', submitted: null, sealedAs: V1 });
    const { check, flags } = await check8(bundle, {
      submittedShas: { [FILE]: shaOf(FOREIGN) },
    });
    expect(check.status).toBe('fail');
    expect(flags[0]!.severity).toBe('high');
  });

  it('treats a malformed persisted sha as absent (unknown), not as a mismatch', async () => {
    const bundle = await build({ seal: 'rolling-provisional', submitted: null, sealedAs: V1 });
    const [v] = submittedFileVerdicts(bundle, {
      chainIntact: true,
      submittedShas: { [FILE]: 'not-a-sha' },
    });
    expect(v!.verdict).toBe('unknown');
  });

  it('reproduces the ingest-time verdict from computeSubmittedShas', async () => {
    const atIngest = await build({ seal: 'rolling-provisional', submitted: V2, sealedAs: V1 });
    const persisted = computeSubmittedShas(atIngest);
    expect(persisted).toEqual({ [FILE]: shaOf(V2) });

    const stored = await build({ seal: 'rolling-provisional', submitted: null, sealedAs: V1 });
    expect(computeSubmittedShas(stored)).toEqual({});

    const ingest = submittedFileVerdicts(atIngest, { chainIntact: true });
    const rerun = submittedFileVerdicts(stored, { chainIntact: true, submittedShas: persisted });
    expect(rerun).toEqual(ingest);
  });
});

describe('both-shapes bundle (classic manifest.json beside rolling seals)', () => {
  it('treats the classic file hashes as provisional and passes the later save', async () => {
    // Final rolling seals do not rescue the classic manifest: it is the one
    // `bundle.manifest` reads, and it is a leftover of an earlier seal command.
    const bundle = await build({ seal: 'both-shapes', submitted: V2, sealedAs: V1 });
    expect(bundle.manifestSigHex).not.toBeNull();
    expect(bundle.submissionFiles.get(FILE)!.provisional).toBe(true);

    const { check, flags } = await check8(bundle);
    expect(check.status).toBe('pass');
    expect(flags).toEqual([]);
  });

  it('still fails foreign bytes', async () => {
    const bundle = await build({ seal: 'both-shapes', submitted: FOREIGN, sealedAs: V1 });
    const { check } = await check8(bundle);
    expect(check.status).toBe('fail');
  });
});

describe('classic-only bundle (unchanged)', () => {
  it('is never provisional', async () => {
    const bundle = await build({ seal: 'classic', submitted: V2, sealedAs: V1 });
    expect(bundle.rollingSeal).toBeUndefined();
    expect(bundle.submissionFiles.get(FILE)!.provisional).toBeUndefined();
  });

  it('reports stale bytes as a tampered bundle', async () => {
    const bundle = await build({ seal: 'classic', submitted: V2, sealedAs: V1 });
    const [v] = submittedFileVerdicts(bundle, { chainIntact: true });
    expect(v!.verdict).toBe('mismatch');
    expect(v!.submittedSha).toBe(shaOf(V1));
    expect(v!.detail).toBe(
      'Submitted bytes do not match their own manifest sha256 (tampered bundle).',
    );
  });

  it('compares the manifest sha when stripped, ignoring persisted shas', async () => {
    const bundle = await build({ seal: 'classic', submitted: null, sealedAs: V2 });
    const [v] = submittedFileVerdicts(bundle, {
      chainIntact: true,
      submittedShas: { [FILE]: shaOf(FOREIGN) },
    });
    expect(v).toEqual({
      path: FILE,
      status: 'present',
      verdict: 'match',
      submittedSha: shaOf(V2),
      recordedSha: shaOf(V2),
      detail: 'Submitted file matches the last recorded on-disk state.',
      supportingSeqs: [v!.supportingSeqs[0]!],
    });
  });
});
