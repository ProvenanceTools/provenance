// @vitest-environment jsdom
/**
 * screenshot.test.ts — unit tests for the static-<pre> screenshot module.
 *
 * `screenshotReplayAt` is the main export. Its DOM-touching / html2canvas path
 * is covered by mocking `captureElement`. The pure helper functions
 * (`buildScreenshotHtml`, `runsToFlatOffsets`) are tested directly.
 *
 * We cannot test real html2canvas rendering in jsdom (canvas API is not
 * fully implemented), so we verify the structure of what would be captured
 * rather than the pixel content.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildScreenshotHtml,
  runsToFlatOffsets,
  screenshotReplayAt,
  captureElement,
} from './screenshot.js';
import type { DecorationRun } from '../views/replay/replay-decoration-utils.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import { soloReconstructionScope } from '@provenance/analysis-core/index/reconstruct-segments.js';
import { buildObservedDag } from '@provenance/analysis-core/git/observed-dag.js';
import { buildEventOrdering } from '@provenance/analysis-core/order/happens-before.js';
import type { SessionContributor } from '@provenance/analysis-core/identity/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRun(
  kind: 'paste' | 'external_change',
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
): DecorationRun {
  return { kind, startLineNumber, startColumn, endLineNumber, endColumn };
}

/**
 * Build a minimal EventIndex stub for screenshotReplayAt tests.
 * Only needs `byFile` for the reconstruction path.
 */
function makeMinimalIndex(filePath: string, events: Partial<IndexedEvent>[]): EventIndex {
  const indexed: IndexedEvent[] = events.map((e, i) => ({
    sessionId: 'sess-1',
    seq: i,
    globalIdx: i,
    wall: `2026-01-01T00:00:0${i}.000Z`,
    t: i * 1000,
    kind: e.kind ?? 'doc.change',
    payload: e.payload ?? {},
    file: filePath,
    ...e,
  }));
  return {
    bySeq: new Map(indexed.map((e) => [`${e.sessionId}:${e.seq}`, e])),
    byKind: new Map(),
    byFile: new Map([[filePath, indexed]]),
    bySessionId: new Map([['sess-1', indexed]]),
    ordered: indexed,
  };
}

// ---------------------------------------------------------------------------
// Tests: runsToFlatOffsets
// ---------------------------------------------------------------------------

describe('runsToFlatOffsets', () => {
  it('returns empty array for empty content', () => {
    expect(runsToFlatOffsets('', [])).toEqual([]);
  });

  it('returns empty array for empty runs', () => {
    expect(runsToFlatOffsets('hello', [])).toEqual([]);
  });

  it('converts a single-line single-run correctly', () => {
    // "hello world" — run covers chars 6..11 ("world"), line 1, col 7..12
    const content = 'hello world';
    const runs: DecorationRun[] = [makeRun('paste', 1, 7, 1, 12)];
    const result = runsToFlatOffsets(content, runs);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      startOffset: 6, // 'hello ' = 6 chars
      endOffset: 11, // 'world' ends at offset 11 (exclusive)
      kind: 'paste',
    });
  });

  it('converts a multi-line run correctly', () => {
    // "line1\nline2\n" — run covers line 2, col 1..5 ("line")
    const content = 'line1\nline2\n';
    const runs: DecorationRun[] = [makeRun('paste', 2, 1, 2, 5)];
    const result = runsToFlatOffsets(content, runs);
    expect(result).toHaveLength(1);
    // "line1\n" = 6 chars; line2 starts at offset 6
    expect(result[0]!.startOffset).toBe(6);
    expect(result[0]!.endOffset).toBe(10); // 6 + 4 chars ("line")
  });

  it('handles run starting at column 1 of the first line', () => {
    const content = 'pasted content here';
    const runs: DecorationRun[] = [makeRun('paste', 1, 1, 1, 7)]; // "pasted"
    const result = runsToFlatOffsets(content, runs);
    expect(result[0]!.startOffset).toBe(0);
    expect(result[0]!.endOffset).toBe(6);
  });

  it('handles external_change kind', () => {
    const content = 'abc def';
    const runs: DecorationRun[] = [makeRun('external_change', 1, 1, 1, 4)];
    const result = runsToFlatOffsets(content, runs);
    expect(result[0]!.kind).toBe('external_change');
  });

  it('filters out zero-length ranges', () => {
    const content = 'hello';
    // A run where startOffset === endOffset (e.g. col 3 to col 3).
    const runs: DecorationRun[] = [makeRun('paste', 1, 3, 1, 3)];
    const result = runsToFlatOffsets(content, runs);
    // endOffset (2) === startOffset (2) → filtered out
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildScreenshotHtml
// ---------------------------------------------------------------------------

describe('buildScreenshotHtml', () => {
  it('produces a non-empty string', () => {
    const html = buildScreenshotHtml('hello', [], 'hw1.py', 5);
    expect(html.length).toBeGreaterThan(0);
  });

  it('contains the file path', () => {
    const html = buildScreenshotHtml('code', [], 'src/hw1.py', 10);
    expect(html).toContain('src/hw1.py');
  });

  it('contains the globalIdx', () => {
    const html = buildScreenshotHtml('code', [], 'hw1.py', 42);
    expect(html).toContain('42');
  });

  it('escapes HTML special characters in content', () => {
    const html = buildScreenshotHtml('<script>alert(1)</script>', [], 'hw1.py', 0);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('wraps decorated regions in a span with background-color', () => {
    const content = 'hello world';
    const ranges = [{ startOffset: 0, endOffset: 5, kind: 'paste' as const }];
    const html = buildScreenshotHtml(content, ranges, 'hw1.py', 1);
    expect(html).toContain('<span style="background-color:');
    expect(html).toContain('rgba(251, 146, 60');
  });

  it('renders plain text for undecorated portions', () => {
    const content = 'hello world';
    const ranges = [{ startOffset: 0, endOffset: 5, kind: 'paste' as const }];
    const html = buildScreenshotHtml(content, ranges, 'hw1.py', 1);
    // " world" is undecorated
    expect(html).toContain(' world');
  });

  it('uses red for external_change', () => {
    const content = 'changed';
    const ranges = [{ startOffset: 0, endOffset: 7, kind: 'external_change' as const }];
    const html = buildScreenshotHtml(content, ranges, 'hw1.py', 1);
    expect(html).toContain('rgba(239, 68, 68');
  });

  it('escapes HTML in file path', () => {
    const html = buildScreenshotHtml('code', [], '<evil>/hw1.py', 0);
    expect(html).not.toContain('<evil>');
    expect(html).toContain('&lt;evil&gt;');
  });

  it('renders empty file content without error', () => {
    const html = buildScreenshotHtml('', [], 'hw1.py', 0);
    expect(html).toContain('hw1.py');
  });
});

// ---------------------------------------------------------------------------
// Tests: screenshotReplayAt (with html2canvas mocked)
// ---------------------------------------------------------------------------

// Mock html2canvas at the module level so screenshotReplayAt's dynamic
// import gets the mock. vi.mock is hoisted; the factory returns a module
// whose default export is an async function returning a fake canvas.
vi.mock('html2canvas', () => {
  const fakeCanvas = {
    toDataURL: (_fmt: string) => 'data:image/png;base64,TESTDATA',
  };
  return { default: vi.fn().mockResolvedValue(fakeCanvas) };
});

describe('screenshotReplayAt', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns a data URL string', async () => {
    const index = makeMinimalIndex('hw1.py', []);
    const result = await screenshotReplayAt(soloReconstructionScope(index), 'hw1.py', 0);
    expect(typeof result).toBe('string');
    expect(result).toContain('data:image/png;base64,TESTDATA');
  });

  it('appends and removes a div from the document body', async () => {
    const index = makeMinimalIndex('hw1.py', []);
    const bodyChildCountBefore = document.body.children.length;
    await screenshotReplayAt(soloReconstructionScope(index), 'hw1.py', 0);
    // The div should be removed after capture (cleanup in finally block).
    expect(document.body.children.length).toBe(bodyChildCountBefore);
  });

  it('reconstructs file state at the given globalIdx', async () => {
    // Create an index with a paste event at globalIdx 1.
    const index = makeMinimalIndex('hw1.py', [
      {
        kind: 'session.start',
        payload: { session_id: 'sess-1' },
        // Omit `file` rather than setting to undefined (exactOptionalPropertyTypes).
        globalIdx: 0,
      },
      {
        kind: 'paste',
        payload: {
          path: 'hw1.py',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          length: 10,
          sha256: 'abc',
          content: 'hello',
        },
        globalIdx: 1,
      },
    ]);
    // Should not throw even if the index has minimal events.
    const result = await screenshotReplayAt(soloReconstructionScope(index), 'hw1.py', 2);
    expect(typeof result).toBe('string');
  });

  /**
   * The image is captioned with a file and an event number and embedded in a
   * findings PDF that reaches an integrity panel. When there is no single file
   * state, a screenshot of one branch is a photograph of a file that never
   * existed. `null` is the only honest answer, and `findings-pdf` omits the
   * image rather than substituting a guess.
   */
  it('returns null when reconstruction has no single truth', async () => {
    // Two verified contributors editing one file, nothing ordering them: no
    // session link and no git.event, so `≺` genuinely says concurrent.
    const contributor = (sessionId: string, ref: string): SessionContributor => ({
      kind: 'attributed',
      sessionId,
      contributorKey: `attributed:2.0:course:c1:${ref}`,
      studentRef: ref,
      identityVersion: '2.0',
      scope: 'course',
      scopeId: 'c1',
      studentPubkey: 'pk',
      certWindow: { in_window: true },
      credentialWindow: { in_window: true },
    });
    const edit = (sessionId: string, seq: number, globalIdx: number): IndexedEvent => ({
      sessionId,
      seq,
      globalIdx,
      wall: `2026-01-01T00:00:0${globalIdx}.000Z`,
      t: seq * 1000,
      kind: 'doc.change',
      payload: {
        path: 'hw1.py',
        source: 'typed',
        deltas: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            text: sessionId,
          },
        ],
      },
      file: 'hw1.py',
    });
    const events = [edit('sess-a', 1, 0), edit('sess-b', 1, 1)];
    const index: EventIndex = {
      bySeq: new Map(events.map((e) => [`${e.sessionId}:${e.seq}`, e])),
      byKind: new Map(),
      byFile: new Map([['hw1.py', events]]),
      bySessionId: new Map([
        ['sess-a', [events[0]!]],
        ['sess-b', [events[1]!]],
      ]),
      ordered: events,
    };
    const contributorBySession = new Map<string, SessionContributor>([
      ['sess-a', contributor('sess-a', 'alice')],
      ['sess-b', contributor('sess-b', 'bob')],
    ]);
    // The events must be handed to the relation. An ordering built over empty
    // sessions answers `'unknown'` for every ref — "we have no record" — which
    // is a different fact from `'concurrent'`, and this test would then pass for
    // the wrong reason.
    const source = {
      sessions: events.map((e) => ({
        sessionId: e.sessionId,
        events: [{ seq: e.seq, kind: e.kind, data: e.payload }],
      })),
    } as unknown as Parameters<typeof buildObservedDag>[0];
    const concurrentScope = {
      index,
      contributorBySession,
      ordering: buildEventOrdering({
        source,
        dag: buildObservedDag(source),
        contributors: contributorBySession,
      }),
    };

    const result = await screenshotReplayAt(concurrentScope, 'hw1.py', 5);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: captureElement stub (verify the module-level function is injectable)
// ---------------------------------------------------------------------------

describe('captureElement (mock)', () => {
  it('is a function that returns a Promise', () => {
    // This test just verifies the export shape. Real html2canvas behavior
    // is not tested in jsdom (canvas rendering unavailable).
    expect(captureElement).toBeInstanceOf(Function);
  });
});
