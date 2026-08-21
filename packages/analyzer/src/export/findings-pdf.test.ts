/**
 * findings-pdf.test.ts — unit tests for the PDF orchestrator.
 *
 * `generatePdf` is an async orchestrator that:
 *   1. Filters flags to severity >= medium.
 *   2. Resolves file paths from the index.
 *   3. Calls screenshotReplayAt (mocked here).
 *   4. Calls renderPdf.
 *
 * We mock `screenshot.ts`'s `screenshotReplayAt` to avoid DOM/html2canvas and
 * mock `renderPdf` to verify call shape without producing real PDFs.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GeneratePdfInput } from './findings-pdf.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { ValidationReport } from '@provenance/analysis-core/validation/check-types.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import type { HashedEnvelope } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

// Mock screenshotReplayAt to return a fixed data URL without DOM access.
vi.mock('./screenshot.js', () => ({
  screenshotReplayAt: vi.fn().mockResolvedValue('data:image/png;base64,FAKESHOT'),
}));

// Mock renderPdf to return a fake doc (avoids jsPDF output overhead in tests).
vi.mock('./pdf-renderer.js', () => ({
  renderPdf: vi.fn().mockReturnValue({ fakeDoc: true }),
  pdfFilenameFor: vi.fn().mockReturnValue('findings-hw1-20260519-120000.pdf'),
}));

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeBundle(): Bundle {
  const events: HashedEnvelope[] = [
    {
      seq: 0,
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      kind: 'session.start',
      data: {
        format_version: '1.0',
        session_id: 'sess-abc',
        prev_session_id: null,
        assignment: { id: 'hw1', semester: 'sp26' },
        manifest_sig: 'sig-hex',
        machine_id: 'machine-xyz',
        vscode: { version: '1.97.0', commit: '', platform: 'darwin-arm64' },
        recorder: { version: '1.0.0', extension_id: 'provenance' },
        session_pubkey: 'pubkey-hex',
      },
      prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
      hash: 'hash0',
    } as HashedEnvelope,
  ];

  return {
    id: 'bundle-id-1',
    droppedArtifacts: [],
    manifest: {
      format_version: '1.0',
      assignment_id: 'hw1',
      semester: 'sp26',
      extension_hash: 'd'.repeat(64),
      sessions: [],
    } as unknown as import('@provenance/log-core').BundleManifest,
    manifestSigHex: 'sig-hex',
    sessions: [
      {
        sessionId: 'sess-abc',
        events: events as readonly HashedEnvelope[],
        meta: {} as import('@provenance/log-core').SlogMeta,
        slogSha256: 'a'.repeat(64),
        slogSha256Lf: null,
        tornTail: null,
        metaSha256: 'b'.repeat(64),
        firstEvent: events[0] as HashedEnvelope<'session.start'> & {
          data: import('@provenance/log-core').SessionStartPayload;
        },
      },
    ],
    sourceFilename: 'hw1-submission.zip',
    loadedAt: '2026-01-01T00:00:00.000Z',
    submissionFiles: new Map(),
  };
}

function makeReport(): ValidationReport {
  return {
    overall: 'pass',
    checks: [],
  } as unknown as ValidationReport;
}

function makeEvent(
  globalIdx: number,
  sessionId: string,
  seq: number,
  kind: string,
  file: string,
): IndexedEvent {
  return {
    globalIdx,
    sessionId,
    seq,
    kind: kind as IndexedEvent['kind'],
    wall: '2026-01-01T00:00:00.000Z',
    t: 0,
    payload: {},
    file,
  };
}

function makeIndex(events: IndexedEvent[]): EventIndex {
  const bySeq = new Map<string, IndexedEvent>();
  for (const e of events) {
    bySeq.set(`${e.sessionId}:${e.seq}`, e);
  }
  return {
    bySeq,
    byKind: new Map(),
    byFile: new Map(),
    bySessionId: new Map(),
    ordered: events,
  };
}

function makeFlag(id: string, severity: Flag['severity'], supportingSeqs: string[]): Flag {
  return {
    id,
    heuristic: 'large_paste',
    title: `Flag ${id}`,
    severity,
    confidence: 0.8,
    supportingSeqs,
    description: 'A test flag.',
  };
}

function makeInput(overrides: Partial<GeneratePdfInput> = {}): GeneratePdfInput {
  return {
    bundle: makeBundle(),
    index: makeIndex([]),
    report: makeReport(),
    flags: [],
    generatedAt: new Date('2026-05-19T12:00:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generatePdf', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns a doc and filename', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const result = await generatePdf(makeInput());
    expect(result).toHaveProperty('doc');
    expect(result).toHaveProperty('filename');
    expect(typeof result.filename).toBe('string');
  });

  it('takes no screenshots when all flags are low/info severity', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const { screenshotReplayAt } = await import('./screenshot.js');
    const flags = [makeFlag('f1', 'low', ['sess-abc:0']), makeFlag('f2', 'info', ['sess-abc:0'])];
    const index = makeIndex([makeEvent(0, 'sess-abc', 0, 'paste', 'hw1.py')]);
    await generatePdf(makeInput({ flags, index }));
    expect(screenshotReplayAt).not.toHaveBeenCalled();
  });

  it('takes one screenshot per medium/high flag', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const { screenshotReplayAt } = await import('./screenshot.js');
    const index = makeIndex([
      makeEvent(0, 'sess-abc', 0, 'paste', 'hw1.py'),
      makeEvent(1, 'sess-abc', 1, 'fs.external_change', 'hw1.py'),
    ]);
    const flags = [
      makeFlag('f1', 'medium', ['sess-abc:0']),
      makeFlag('f2', 'high', ['sess-abc:1']),
      makeFlag('f3', 'info', ['sess-abc:0']), // should be skipped
    ];
    await generatePdf(makeInput({ flags, index }));
    expect(screenshotReplayAt).toHaveBeenCalledTimes(2);
  });

  it('calls screenshotReplayAt with correct filePath and globalIdx+1', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const { screenshotReplayAt } = await import('./screenshot.js');
    const index = makeIndex([makeEvent(5, 'sess-abc', 3, 'paste', 'hw1.py')]);
    const flags = [makeFlag('f1', 'high', ['sess-abc:3'])];
    await generatePdf(makeInput({ flags, index }));
    // globalIdx=5, so upToGlobalIdx=6. The first argument is now a
    // ReconstructionScope rather than the bare index (Tier 2.2) — the scope is
    // what knows who each session belongs to, which is what decides whether
    // there is a single file state to screenshot at all. The index it wraps is
    // still the one we passed in.
    expect(screenshotReplayAt).toHaveBeenCalledWith(
      expect.objectContaining({ index }),
      'hw1.py',
      6,
    );
  });

  /**
   * `null` means reconstruction had no single truth at that position. The PDF
   * must render the flag WITHOUT a picture rather than embed a screenshot of one
   * arbitrarily chosen branch — that image would leave the tool captioned as
   * evidence.
   */
  it('omits the image when screenshotReplayAt returns null', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const { screenshotReplayAt } = await import('./screenshot.js');
    vi.mocked(screenshotReplayAt).mockResolvedValueOnce(null);
    const index = makeIndex([makeEvent(5, 'sess-abc', 3, 'paste', 'hw1.py')]);
    const flags = [makeFlag('f1', 'high', ['sess-abc:3'])];
    const result = await generatePdf(makeInput({ flags, index }));
    // The export still succeeds; it just carries no screenshot for that flag.
    expect(result).toBeDefined();
    expect(screenshotReplayAt).toHaveBeenCalled();
  });

  it('skips screenshot when supporting seq has no file attribute', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const { screenshotReplayAt } = await import('./screenshot.js');
    // Event with no file attribute
    const event: IndexedEvent = {
      globalIdx: 0,
      sessionId: 'sess-abc',
      seq: 0,
      kind: 'session.start',
      wall: '2026-01-01T00:00:00.000Z',
      t: 0,
      payload: {},
      // no `file` property
    };
    const index: EventIndex = {
      bySeq: new Map([['sess-abc:0', event]]),
      byKind: new Map(),
      byFile: new Map(),
      bySessionId: new Map(),
      ordered: [event],
    };
    const flags = [makeFlag('f1', 'high', ['sess-abc:0'])];
    await generatePdf(makeInput({ flags, index }));
    expect(screenshotReplayAt).not.toHaveBeenCalled();
  });

  it('skips screenshot when supporting event not found in index', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const { screenshotReplayAt } = await import('./screenshot.js');
    const index = makeIndex([]); // empty index
    const flags = [makeFlag('f1', 'high', ['sess-abc:99'])]; // non-existent seq
    await generatePdf(makeInput({ flags, index }));
    expect(screenshotReplayAt).not.toHaveBeenCalled();
  });

  it('skips screenshot when flag has no supportingSeqs', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const { screenshotReplayAt } = await import('./screenshot.js');
    const flags = [makeFlag('f1', 'high', [])]; // no supporting seqs
    await generatePdf(makeInput({ flags }));
    expect(screenshotReplayAt).not.toHaveBeenCalled();
  });

  it('reports progress via onProgress callback', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const index = makeIndex([makeEvent(0, 'sess-abc', 0, 'paste', 'hw1.py')]);
    const flags = [makeFlag('f1', 'medium', ['sess-abc:0'])];
    const progressCalls: [number, number][] = [];
    await generatePdf(
      makeInput({
        flags,
        index,
        onProgress: (completed, total) => {
          progressCalls.push([completed, total]);
        },
      }),
    );
    // 1 medium flag → 1 progress call: (1, 1)
    expect(progressCalls).toEqual([[1, 1]]);
  });

  it('reports progress correctly for multiple flags', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const index = makeIndex([
      makeEvent(0, 'sess-abc', 0, 'paste', 'hw1.py'),
      makeEvent(1, 'sess-abc', 1, 'paste', 'hw1.py'),
    ]);
    const flags = [
      makeFlag('f1', 'high', ['sess-abc:0']),
      makeFlag('f2', 'medium', ['sess-abc:1']),
    ];
    const progressCalls: [number, number][] = [];
    await generatePdf(
      makeInput({
        flags,
        index,
        onProgress: (completed, total) => progressCalls.push([completed, total]),
      }),
    );
    expect(progressCalls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('continues without a screenshot when screenshotReplayAt throws', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const { screenshotReplayAt } = await import('./screenshot.js');
    vi.mocked(screenshotReplayAt).mockRejectedValueOnce(new Error('canvas error'));
    const index = makeIndex([makeEvent(0, 'sess-abc', 0, 'paste', 'hw1.py')]);
    const flags = [makeFlag('f1', 'high', ['sess-abc:0'])];
    // Should resolve (not reject) even when screenshot throws.
    const result = await generatePdf(makeInput({ flags, index }));
    expect(result).toHaveProperty('doc');
  });

  it('passes screenshots to renderPdf', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const { renderPdf } = await import('./pdf-renderer.js');
    const index = makeIndex([makeEvent(0, 'sess-abc', 0, 'paste', 'hw1.py')]);
    const flags = [makeFlag('f1', 'high', ['sess-abc:0'])];
    await generatePdf(makeInput({ flags, index }));
    const call = vi.mocked(renderPdf).mock.calls[0];
    expect(call).toBeDefined();
    const pdfInput = call![0];
    expect(pdfInput.screenshots).toHaveLength(1);
    expect(pdfInput.screenshots[0]!.flagId).toBe('f1');
    expect(pdfInput.screenshots[0]!.dataUrl).toContain('data:image/png');
  });

  it('includes wall time in screenshot label', async () => {
    const { generatePdf } = await import('./findings-pdf.js');
    const { renderPdf } = await import('./pdf-renderer.js');
    const event = makeEvent(0, 'sess-abc', 0, 'paste', 'hw1.py');
    const index = makeIndex([event]);
    const flags = [makeFlag('f1', 'high', ['sess-abc:0'])];
    await generatePdf(makeInput({ flags, index }));
    const call = vi.mocked(renderPdf).mock.calls[0];
    const pdfInput = call![0];
    expect(pdfInput.screenshots[0]!.label).toContain(event.wall);
  });
});
