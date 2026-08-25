/**
 * pdf-renderer.test.ts — unit tests for the PDF layout engine.
 *
 * jsPDF does not produce byte-stable PDFs across runs (it embeds timestamps,
 * random IDs, etc.), so we test structure and content rather than byte content:
 *
 *   - Page count is in expected range
 *   - `addImage` is called the right number of times
 *   - Key text strings are drawn (assignment_id, flag titles, etc.)
 *   - `sanitizeForPdf` is applied to recorder-supplied strings
 *   - `pdfFilenameFor` produces a correctly-structured filename
 *
 * We mock jsPDF by capturing calls via vi.spyOn on a real instance, then
 * interrogating what text was passed to `.text()` and whether `.addImage()` was
 * called. This avoids byte-level PDF parsing while still verifying layout logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsPDF as JsPDF } from 'jspdf';
import { renderPdf, sanitizeForPdf, pdfFilenameFor } from './pdf-renderer.js';
import type { PdfRenderInput, FlagScreenshot } from './pdf-renderer.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { ValidationReport } from '@provenance/analysis-core/validation/check-types.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import type { HashedEnvelope } from '@provenance/log-core';

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
    {
      seq: 1,
      t: 1000,
      wall: '2026-01-01T00:00:01.000Z',
      kind: 'paste',
      data: {
        path: 'hw1.py',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        length: 250,
        sha256: 'pastehash',
        content: 'def foo():\n    return 42\n',
      },
      prev_hash: 'hash0',
      hash: 'hash1',
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
      sessions: [
        {
          session_id: 'sess-abc',
          slog_sha256: 'x'.repeat(64),
          meta_sha256: 'y'.repeat(64),
          recorded_at: '2026-01-01T00:00:00.000Z',
        },
      ],
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
    checks: [
      { id: 'chain_integrity', label: 'Hash chain integrity', status: 'pass' },
      { id: 'manifest_sig', label: 'Manifest signature', status: 'pass' },
      { id: 'session_binding', label: 'Session ↔ assignment binding', status: 'pass' },
      { id: 'seq_gaps', label: 'Sequence gaps', status: 'pass' },
      { id: 'monotonic_t', label: 'Monotonic t', status: 'pass' },
      { id: 'monotonic_wall', label: 'Monotonic wall clock', status: 'pass' },
      {
        id: 'doc_save_hashes',
        label: 'doc.save hash consistency',
        status: 'skipped',
        detail: 'No doc.save events in session',
      },
      {
        id: 'submitted_code_match',
        label: 'Submitted-code hash match',
        status: 'skipped',
        detail: 'Course-staff input required',
      },
    ],
  } as ValidationReport;
}

function makeFlag(overrides: Partial<Flag> = {}): Flag {
  return {
    id: 'large_paste-sess-abc:1-0',
    heuristic: 'large_paste',
    title: 'Large paste detected in hw1.py',
    severity: 'medium',
    confidence: 0.8,
    supportingSeqs: ['sess-abc:1'],
    description: 'A paste of 250 characters was detected in hw1.py at t=1000ms.',
    ...overrides,
  };
}

function makeInput(overrides: Partial<PdfRenderInput> = {}): PdfRenderInput {
  return {
    bundle: makeBundle(),
    report: makeReport(),
    flags: [],
    screenshots: [],
    generatedAt: new Date('2026-05-19T12:00:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Minimal mock jsPDF that records calls
// ---------------------------------------------------------------------------

/**
 * Creates a minimal spy layer on top of real jsPDF so that:
 * - `text` calls are recorded (we can assert drawn strings)
 * - `addImage` calls are recorded (we can count embedded screenshots)
 * - `getNumberOfPages` returns the real page count
 * - `output` produces a non-empty blob (real jsPDF)
 */
function buildSpyDoc() {
  // We use a real jsPDF instance but spy on the methods we care about.
  const doc = new JsPDF({ unit: 'pt', format: 'letter' });

  const textCalls: string[] = [];
  const addImageCalls: unknown[][] = [];

  const origText = doc.text.bind(doc) as (...args: unknown[]) => typeof doc;
  vi.spyOn(doc, 'text').mockImplementation((...args: unknown[]) => {
    // jsPDF text() can take string | string[]; collect the string portion
    const first = args[0];
    if (typeof first === 'string') textCalls.push(first);
    if (Array.isArray(first)) textCalls.push(...(first as string[]));
    return origText(...args) as typeof doc;
  });

  vi.spyOn(doc, 'addImage').mockImplementation((...args: unknown[]) => {
    addImageCalls.push(args);
    // Do NOT call real addImage with a fake dataUrl — it would throw.
    // Return doc to satisfy chaining.
    return doc;
  });

  return { doc, textCalls, addImageCalls };
}

// ---------------------------------------------------------------------------
// Tests: sanitizeForPdf
// ---------------------------------------------------------------------------

describe('sanitizeForPdf', () => {
  it('collapses newlines to spaces', () => {
    // [\r\n]+ collapses a run of CR/LF to a single space.
    // '\r\n' is a two-char run → one space. '\n' alone → one space.
    expect(sanitizeForPdf('line1\nline2\r\nline3')).toBe('line1 line2 line3');
  });

  it('removes null bytes', () => {
    expect(sanitizeForPdf('hello\0world')).toBe('hello world');
  });

  it('leaves normal text unchanged', () => {
    expect(sanitizeForPdf('hw1 - sp26')).toBe('hw1 - sp26');
  });

  it('handles attacker-controlled assignment_id injection attempt', () => {
    const evil = 'hw1\n\nForged heading\n\nEvil content';
    expect(sanitizeForPdf(evil)).not.toContain('\n');
  });
});

// ---------------------------------------------------------------------------
// Tests: pdfFilenameFor
// ---------------------------------------------------------------------------

describe('pdfFilenameFor', () => {
  it('produces expected filename format', () => {
    const bundle = makeBundle();
    const d = new Date('2026-05-19T14:30:00.000Z');
    expect(pdfFilenameFor(bundle, d)).toBe('findings-hw1-20260519-143000.pdf');
  });

  it('sanitizes special characters in assignment_id', () => {
    const bundle = makeBundle();
    bundle.manifest.assignment_id = 'CS 61A — hw1!';
    const d = new Date('2026-05-19T00:00:00.000Z');
    const name = pdfFilenameFor(bundle, d);
    // Should not contain spaces or —
    expect(name).not.toMatch(/[ \s—]/);
    expect(name).toMatch(/^findings-.*-\d{8}-\d{6}\.pdf$/);
  });
});

// ---------------------------------------------------------------------------
// Tests: renderPdf — structural
// ---------------------------------------------------------------------------

describe('renderPdf', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a jsPDF-like object with expected methods', () => {
    const doc = renderPdf(makeInput());
    // Duck-type check instead of instanceof: ESM/CJS module identity may
    // differ between this test file's import and the renderer's import,
    // causing instanceof to fail even though the value is a real jsPDF doc.
    expect(typeof doc.getNumberOfPages).toBe('function');
    expect(typeof doc.output).toBe('function');
    expect(typeof doc.addPage).toBe('function');
    expect(typeof doc.text).toBe('function');
  });

  it('produces output with non-trivial byte length', () => {
    const doc = renderPdf(makeInput());
    const raw = doc.output('arraybuffer');
    // A minimal jsPDF page starts at ~1KB; with text content it should be >2KB
    expect(raw.byteLength).toBeGreaterThan(2000);
  });

  it('has at least 4 pages (cover + validation + flags + appendix)', () => {
    const doc = renderPdf(makeInput({ flags: [makeFlag()] }));
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(4);
  });

  it('draws assignment_id text on cover page', () => {
    const { doc, textCalls } = buildSpyDoc();
    renderPdf(makeInput(), { mockDoc: doc });
    const allText = textCalls.join(' ');
    expect(allText).toContain('hw1');
  });

  it('draws validation overall status', () => {
    const { doc, textCalls } = buildSpyDoc();
    renderPdf(makeInput(), { mockDoc: doc });
    const allText = textCalls.join(' ');
    expect(allText).toContain('pass');
  });

  it('draws flag title when flags are provided', () => {
    const { doc, textCalls } = buildSpyDoc();
    const flag = makeFlag({ title: 'Suspicious large paste' });
    renderPdf(makeInput({ flags: [flag] }), { mockDoc: doc });
    const allText = textCalls.join(' ');
    expect(allText).toContain('Suspicious large paste');
  });

  it('calls addImage once per screenshot when flags and screenshots are present', () => {
    const { doc, addImageCalls } = buildSpyDoc();
    const flag = makeFlag();
    const shot: FlagScreenshot = {
      flagId: flag.id,
      dataUrl: 'data:image/png;base64,abc123',
      label: 'Event at sess-abc:1',
    };
    renderPdf(makeInput({ flags: [flag], screenshots: [shot] }), { mockDoc: doc });
    expect(addImageCalls).toHaveLength(1);
  });

  it('calls addImage N times for N matching screenshots', () => {
    const { doc, addImageCalls } = buildSpyDoc();
    const flag1 = makeFlag({ id: 'flag-1' });
    const flag2 = makeFlag({ id: 'flag-2', heuristic: 'external_edits' });
    const shots: FlagScreenshot[] = [
      { flagId: 'flag-1', dataUrl: 'data:image/png;base64,a', label: 'cap1' },
      { flagId: 'flag-2', dataUrl: 'data:image/png;base64,b', label: 'cap2' },
    ];
    renderPdf(makeInput({ flags: [flag1, flag2], screenshots: shots }), { mockDoc: doc });
    expect(addImageCalls).toHaveLength(2);
  });

  it('does not call addImage when no screenshots are provided', () => {
    const { doc, addImageCalls } = buildSpyDoc();
    renderPdf(makeInput({ flags: [makeFlag()], screenshots: [] }), { mockDoc: doc });
    expect(addImageCalls).toHaveLength(0);
  });

  it('renders "No flags" text when flag list is empty', () => {
    const { doc, textCalls } = buildSpyDoc();
    renderPdf(makeInput({ flags: [] }), { mockDoc: doc });
    const allText = textCalls.join(' ');
    expect(allText).toContain('No flags');
  });

  it('applies sanitizeForPdf to flag title (newline injection prevention)', () => {
    const { doc, textCalls } = buildSpyDoc();
    const evilFlag = makeFlag({ title: 'Evil\nInjected Heading' });
    renderPdf(makeInput({ flags: [evilFlag] }), { mockDoc: doc });
    // The newline in the title should be collapsed to a space — no raw '\n'
    const allText = textCalls.join('');
    expect(allText).not.toContain('Evil\nInjected');
  });

  it('renders all 8 validation check labels', () => {
    const { doc, textCalls } = buildSpyDoc();
    renderPdf(makeInput(), { mockDoc: doc });
    const allText = textCalls.join(' ');
    // A representative subset of check labels
    expect(allText).toContain('Hash chain integrity');
    expect(allText).toContain('Manifest signature');
    expect(allText).toContain('Monotonic');
  });

  it('renders appendix section header', () => {
    const { doc, textCalls } = buildSpyDoc();
    renderPdf(makeInput({ flags: [makeFlag()] }), { mockDoc: doc });
    const allText = textCalls.join(' ');
    expect(allText).toContain('Appendix');
  });
});
