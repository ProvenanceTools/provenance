/**
 * Per-file heuristics evaluate only paths whose role is `reviewed`.
 *
 * One bundle holds the same suspicious pattern on an in-scope file and on a
 * file a tool wrote (not under review). With scope declared, only the in-scope
 * file may be flagged; with no scope information, both are.
 */

import { describe, it, expect } from 'vitest';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { establishBundleTrust } from '../manifest/bundle-manifest.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import {
  buildManifest1x,
  buildManifest2,
  buildTrustChainKeys,
  sessionStart1x,
  sessionStart2,
} from '../test-support/build-manifest-2.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import { largePasteHeuristic } from './large-paste.js';
import { externalEditsHeuristic } from './external-edits.js';
import { lowTypingHighOutputHeuristic } from './low-typing-high-output.js';
import { timeToFirstSaveAnomalyHeuristic } from './time-to-first-save-anomaly.js';
import { terminalActiveDuringExternalChangeHeuristic } from './terminal-active-during-external-change.js';
import { pasteIsSolutionHeuristic } from './paste-is-solution.js';
import { interSessionExternalChangeHeuristic } from './inter-session-external-change.js';
import { runHeuristics } from './run-heuristics.js';
import { reviewedPathPredicate } from './reviewed-scope.js';
import type { Flag, Heuristic } from './types.js';
import type { ValidationReport } from '../validation/check-types.js';

const cfg = DEFAULT_HEURISTIC_CONFIG;
const REVIEWED = 'hw.py';
const GENERATED = 'out/gen.txt';
const BIG = 'z'.repeat(400);

type BuildOpts = NonNullable<Parameters<typeof buildTestBundle>[0]>;
type EventSpec = NonNullable<NonNullable<BuildOpts['sessions']>[number]['events']>;

/** The same suspicious patterns, once per path. */
function eventsFor(path: string, external = true): EventSpec {
  const origin = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  return [
    {
      kind: 'doc.change',
      data: { path, source: 'typed', deltas: [{ range: origin, text: 'a' }] },
    },
    {
      kind: 'paste',
      data: {
        path,
        content: BIG,
        length: BIG.length,
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
      },
    },
    ...(external ? [{ kind: 'fs.external_change' as const, data: { path, diff_size: 500 } }] : []),
  ];
}

async function load(opts: BuildOpts) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { bundle: result.value, index: buildIndex(result.value) };
}

type Ctx = Awaited<ReturnType<typeof load>>;

// An external change taints reconstruction, which low_typing_high_output skips,
// so that heuristic gets its own event set without one.
const typingSpec = { events: [...eventsFor(REVIEWED, false), ...eventsFor(GENERATED, false)] };
const sessionSpec = { events: [...eventsFor(REVIEWED), ...eventsFor(GENERATED)] };

function pathOf(f: Flag): string | undefined {
  const d = f.detail ?? {};
  for (const k of ['path', 'filePath', 'file']) {
    const v = d[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function pathsFlaggedBy(h: Heuristic, ctx: Ctx): (string | undefined)[] {
  return h.run(ctx.index, ctx.bundle, cfg).map(pathOf).sort();
}

const PER_FILE = [largePasteHeuristic, externalEditsHeuristic];

type Session = NonNullable<BuildOpts['sessions']>[number];

/**
 * A bundle whose sessions embed a 1.x manifest scoped to `filesUnderReview`.
 * `tamper` edits the scope AFTER signing, leaving `sig` untouched, so the
 * signature no longer verifies. Trust is established against the course key
 * (a deployment signs 1.x with the key it configures as root).
 */
async function withManifest1x(
  filesUnderReview: string[],
  opts: { sessions?: Session[]; tamper?: boolean; establish?: boolean } = {},
) {
  const keys = await buildTrustChainKeys();
  const signed = await buildManifest1x({
    keys,
    filesUnderReview: opts.tamper ? ['something-else.py'] : filesUnderReview,
  });
  const manifest = opts.tamper ? { ...signed, files_under_review: filesUnderReview } : signed;
  const ctx = await load({
    sessions: (opts.sessions ?? [sessionSpec]).map((sp) => ({
      ...sp,
      sessionStart: sessionStart1x(manifest),
    })),
  });
  if (opts.establish !== false) await establishBundleTrust(ctx.bundle, keys.coursePubkeyHex);
  return ctx;
}

describe('per-file heuristics, scope declared by a 1.x manifest', () => {
  it('flag the reviewed file and not the out-of-scope file', async () => {
    const ctx = await withManifest1x([REVIEWED]);
    for (const h of PER_FILE) {
      expect(pathsFlaggedBy(h, ctx), h.id).toEqual([REVIEWED]);
    }
  });

  it('does not narrow scope when the signature does not verify', async () => {
    const ctx = await withManifest1x([REVIEWED], { tamper: true });
    expect(ctx.bundle.manifestScopeTrust).toBe('unverified');
    for (const h of PER_FILE) {
      expect(pathsFlaggedBy(h, ctx), h.id).toEqual([REVIEWED, GENERATED]);
    }
  });

  it('does not narrow scope when trust was never established', async () => {
    const ctx = await withManifest1x([REVIEWED], { establish: false });
    expect(pathsFlaggedBy(largePasteHeuristic, ctx)).toEqual([REVIEWED, GENERATED]);
  });

  it('treat a path in a reviewed directory but named by an ignore rule as not reviewed', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys,
      filesUnderReview: [REVIEWED, 'out/'],
      ignore: [GENERATED],
    });
    const ctx = await load({
      sessions: [{ ...sessionSpec, sessionStart: sessionStart2(manifest) }],
    });
    await establishBundleTrust(ctx.bundle, keys.rootPubkeyHex);
    expect(pathsFlaggedBy(largePasteHeuristic, ctx)).toEqual([REVIEWED]);
  });
});

describe('per-file heuristics, scope declared by a 2.0 manifest', () => {
  it('honours the scope once the trust chain verified', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys, filesUnderReview: [REVIEWED] });
    const ctx = await load({
      sessions: [{ ...sessionSpec, sessionStart: sessionStart2(manifest) }],
    });
    expect((await establishBundleTrust(ctx.bundle, keys.rootPubkeyHex)).kind).toBe('verified');
    for (const h of PER_FILE) {
      expect(pathsFlaggedBy(h, ctx), h.id).toEqual([REVIEWED]);
    }
  });

  it('does not let an UNVERIFIED manifest narrow scope (fails toward flagging)', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys, filesUnderReview: [REVIEWED] });
    const ctx = await load({
      sessions: [{ ...sessionSpec, sessionStart: sessionStart2(manifest) }],
    });
    // establishBundleTrust deliberately not called: trust stays 'unverified'.
    expect(pathsFlaggedBy(largePasteHeuristic, ctx)).toEqual([REVIEWED, GENERATED]);
  });
});

describe('per-file heuristics, scope from the sealed submission_files', () => {
  it('is not trusted: it is not course-signed, so every path is evaluated', async () => {
    const ctx = await load({
      sessions: [sessionSpec],
      submissionFiles: [{ path: REVIEWED, status: 'present', content: 'x' }],
    });
    expect(pathsFlaggedBy(largePasteHeuristic, ctx)).toEqual([REVIEWED, GENERATED]);
  });
});

describe('per-file heuristics, no scope information (old bundles)', () => {
  it('evaluate every path, exactly as before', async () => {
    const ctx = await load({ sessions: [sessionSpec] });
    expect(reviewedPathPredicate(ctx.bundle)(GENERATED)).toBe(true);
    for (const h of PER_FILE) {
      expect(pathsFlaggedBy(h, ctx), h.id).toEqual([REVIEWED, GENERATED]);
    }
  });
});

describe('runHeuristics', () => {
  it('emits no per-file flag for an out-of-scope file', async () => {
    const ctx = await withManifest1x([REVIEWED]);
    const report = { checks: [], bundleDetections: [] } as unknown as ValidationReport;
    const flags = runHeuristics(ctx.index, ctx.bundle, report);
    expect(flags.map(pathOf)).not.toContain(GENERATED);
    expect(flags.some((f) => pathOf(f) === REVIEWED)).toBe(true);
  });
});

describe('low_typing_high_output', () => {
  it('flags only the reviewed file when scope is declared, both when it is not', async () => {
    const scoped = await withManifest1x([REVIEWED], { sessions: [typingSpec] });
    expect(pathsFlaggedBy(lowTypingHighOutputHeuristic, scoped)).toEqual([REVIEWED]);

    const unscoped = await load({ sessions: [typingSpec] });
    expect(pathsFlaggedBy(lowTypingHighOutputHeuristic, unscoped)).toEqual([REVIEWED, GENERATED]);
  });
});

describe('time_to_first_save_anomaly and terminal_active_during_external_change', () => {
  function eventsAt(path: string): EventSpec {
    return [
      {
        kind: 'doc.open',
        data: { path, sha256: 'a'.repeat(64), line_count: 0 },
        t: 0,
      },
      {
        kind: 'paste',
        data: {
          path,
          content: BIG + BIG,
          length: BIG.length * 2,
          sha256: 'b'.repeat(64),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
        t: 2000,
      },
      { kind: 'doc.save', data: { path, sha256: 'c'.repeat(64) }, t: 5000 },
      { kind: 'fs.external_change', data: { path, diff_size: 100 }, t: 6000 },
    ];
  }
  const spec = {
    events: [
      {
        kind: 'terminal.open' as const,
        data: { terminal_id: 't1', shell: '/bin/zsh', shell_integration: true },
        t: 0,
      },
      ...eventsAt(REVIEWED),
      ...eventsAt(GENERATED),
    ],
  };

  it('evaluate only the reviewed file when scope is declared', async () => {
    const ctx = await withManifest1x([REVIEWED], { sessions: [spec] });
    expect(pathsFlaggedBy(timeToFirstSaveAnomalyHeuristic, ctx)).toEqual([REVIEWED]);
    expect(pathsFlaggedBy(terminalActiveDuringExternalChangeHeuristic, ctx)).toEqual([REVIEWED]);
  });

  it('evaluate every path with no scope information', async () => {
    const ctx = await load({ sessions: [spec] });
    expect(pathsFlaggedBy(timeToFirstSaveAnomalyHeuristic, ctx)).toEqual([REVIEWED, GENERATED]);
    expect(pathsFlaggedBy(terminalActiveDuringExternalChangeHeuristic, ctx)).toEqual([
      REVIEWED,
      GENERATED,
    ]);
  });
});

describe('paste_is_solution and inter_session_external_change', () => {
  const solution = Array.from({ length: 14 }, (_, i) => `line ${i} = ${i}`).join('\n');
  const origin = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const pasteSession = (path: string): EventSpec => [
    { kind: 'doc.open', data: { path, sha256: 'a'.repeat(64), line_count: 0, content: '' } },
    {
      kind: 'paste',
      data: {
        path,
        content: solution,
        length: solution.length,
        sha256: 'b'.repeat(64),
        range: origin,
      },
    },
    { kind: 'doc.save', data: { path, sha256: 'c'.repeat(64) } },
  ];
  const solutionSpec = { events: [...pasteSession(REVIEWED), ...pasteSession(GENERATED)] };

  const reopen = (path: string, content: string): EventSpec[number] => ({
    kind: 'doc.open',
    data: { path, sha256: 'd'.repeat(64), line_count: 40, content },
  });
  const typed = (path: string): EventSpec[number] => ({
    kind: 'doc.change',
    data: { path, source: 'typed', deltas: [{ range: origin, text: 'mine\n' }] },
  });
  const twoSessions: Session[] = [
    {
      events: [
        {
          kind: 'doc.open',
          data: { path: REVIEWED, sha256: 'a'.repeat(64), line_count: 0, content: '' },
        },
        {
          kind: 'doc.open',
          data: { path: GENERATED, sha256: 'a'.repeat(64), line_count: 0, content: '' },
        },
        typed(REVIEWED),
        typed(GENERATED),
      ],
    },
    {
      events: [
        reopen(REVIEWED, 'written outside\n'.repeat(40)),
        reopen(GENERATED, 'written outside\n'.repeat(40)),
      ],
    },
  ];

  it('paste_is_solution: reviewed file flags, out-of-scope file does not', async () => {
    const scoped = await withManifest1x([REVIEWED], { sessions: [solutionSpec] });
    expect(pathsFlaggedBy(pasteIsSolutionHeuristic, scoped)).toEqual([REVIEWED]);
    const unscoped = await load({ sessions: [solutionSpec] });
    expect(pathsFlaggedBy(pasteIsSolutionHeuristic, unscoped)).toEqual([REVIEWED, GENERATED]);
    const tampered = await withManifest1x([REVIEWED], { sessions: [solutionSpec], tamper: true });
    expect(pathsFlaggedBy(pasteIsSolutionHeuristic, tampered)).toEqual([REVIEWED, GENERATED]);
  });

  it('inter_session_external_change: reviewed file flags, out-of-scope file does not', async () => {
    const scoped = await withManifest1x([REVIEWED], { sessions: twoSessions });
    expect(pathsFlaggedBy(interSessionExternalChangeHeuristic, scoped)).toEqual([REVIEWED]);
    const unscoped = await load({ sessions: twoSessions });
    expect(pathsFlaggedBy(interSessionExternalChangeHeuristic, unscoped)).toEqual([
      REVIEWED,
      GENERATED,
    ]);
    const tampered = await withManifest1x([REVIEWED], { sessions: twoSessions, tamper: true });
    expect(pathsFlaggedBy(interSessionExternalChangeHeuristic, tampered)).toEqual([
      REVIEWED,
      GENERATED,
    ]);
  });
});
