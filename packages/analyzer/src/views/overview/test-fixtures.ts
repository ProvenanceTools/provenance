/**
 * Shared test fixtures for overview view tests.
 *
 * Provides minimal but realistic ValidationReport, Flag[], EventIndex, and
 * Bundle instances. Not meant to test correctness of those modules — just to
 * give the UI components something to render.
 */

import type {
  ValidationReport,
  ValidationCheck,
} from '@provenance/analysis-core/validation/check-types.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';

// ---------------------------------------------------------------------------
// Validation report fixture
// ---------------------------------------------------------------------------

export const fixtureReport: ValidationReport = {
  overall: 'warn',
  checks: [
    {
      id: 'manifest_sig',
      label: 'Manifest signature',
      status: 'pass',
    },
    {
      id: 'session_binding',
      label: 'Session binding',
      status: 'pass',
    },
    {
      id: 'chain_integrity',
      label: 'Chain integrity',
      status: 'fail',
      detail: 'Hash mismatch at seq 4 (session abc).',
      supportingSeqs: [{ sessionId: 'abc', seq: 4 }],
    },
    {
      id: 'seq_gaps',
      label: 'Sequence gaps',
      status: 'pass',
    },
    {
      id: 'monotonic_t',
      label: 'Monotonic t',
      status: 'pass',
    },
    {
      id: 'monotonic_wall',
      label: 'Monotonic wall',
      status: 'pass',
    },
    {
      id: 'doc_save_hashes',
      label: 'Doc-save hashes',
      status: 'pass',
    },
    {
      id: 'submitted_code_match',
      label: 'Submitted code match',
      status: 'skipped',
      detail: 'No course-staff hashes available in v1.',
    },
  ],
};

export const fixtureFailReport: ValidationReport = {
  overall: 'fail',
  checks: fixtureReport.checks.map((c) =>
    c.id === 'chain_integrity' ? { ...c, status: 'fail' as const } : c,
  ),
};

export const fixturePassReport: ValidationReport = {
  overall: 'pass',
  checks: fixtureReport.checks.map((c): ValidationCheck => {
    if (c.id === 'chain_integrity') {
      return { id: c.id, label: c.label, status: 'pass' };
    }
    if (c.id === 'submitted_code_match') {
      return { id: c.id, label: c.label, status: 'pass' };
    }
    return c;
  }),
};

// ---------------------------------------------------------------------------
// Flags fixture
// ---------------------------------------------------------------------------

export const fixtureFlags: Flag[] = [
  {
    id: 'large_paste-abc:2-0',
    heuristic: 'large_paste',
    title: 'Large paste detected',
    severity: 'high',
    confidence: 0.9,
    supportingSeqs: ['abc:2', 'abc:3'],
    description: 'A paste of 5000 characters was detected in a short time window.',
    detail: { pastedChars: 5000, file: 'hw1.py' },
  },
  {
    id: 'external_edits-def:7-0',
    heuristic: 'external_edits',
    title: 'External file modification',
    severity: 'medium',
    confidence: 0.7,
    supportingSeqs: ['def:7'],
    description: 'File was modified outside VS Code during the session.',
    detail: { file: 'hw1.py', diffSize: 200 },
  },
  {
    id: 'low_typing-ghi:0-0',
    heuristic: 'low_typing_high_output',
    title: 'Low typing, high output',
    severity: 'low',
    confidence: 0.5,
    supportingSeqs: [],
    description: 'Very little typing relative to final file size.',
  },
];

// ---------------------------------------------------------------------------
// EventIndex fixture (minimal — only fields used by SummaryStatsPanel)
// ---------------------------------------------------------------------------

export function makeMinimalIndex(): EventIndex {
  // bySeq maps "${sessionId}:${seq}" → event.
  const bySeqMap = new Map([
    [
      'abc:1',
      {
        sessionId: 'abc',
        seq: 1,
        globalIdx: 1,
        wall: '2026-01-01T00:00:10.000Z',
        t: 10000,
        kind: 'doc.change' as const,
        payload: {
          deltas: [
            {
              text: 'hello',
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
            },
          ],
        },
        filePath: 'hw1.py',
      },
    ],
    [
      'abc:2',
      {
        sessionId: 'abc',
        seq: 2,
        globalIdx: 2,
        wall: '2026-01-01T00:00:20.000Z',
        t: 20000,
        kind: 'paste' as const,
        payload: { length: 300, file: 'hw1.py' },
        filePath: 'hw1.py',
      },
    ],
    [
      'abc:3',
      {
        sessionId: 'abc',
        seq: 3,
        globalIdx: 3,
        wall: '2026-01-01T00:00:30.000Z',
        t: 30000,
        kind: 'doc.save' as const,
        payload: { sha256: 'abc', file: 'hw1.py' },
        filePath: 'hw1.py',
      },
    ],
  ]);

  return {
    bySeq: bySeqMap,
    byKind: new Map(),
    byFile: new Map([['hw1.py', Array.from(bySeqMap.values())]]),
    bySessionId: new Map([['abc', []]]),
    ordered: [
      {
        sessionId: 'abc',
        seq: 0,
        globalIdx: 0,
        wall: '2026-01-01T00:00:00.000Z',
        t: 0,
        kind: 'session.start',
        payload: {},
      },
      {
        sessionId: 'abc',
        seq: 1,
        globalIdx: 1,
        wall: '2026-01-01T00:00:10.000Z',
        t: 10000,
        kind: 'doc.change',
        payload: {
          deltas: [
            {
              text: 'hello',
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
            },
          ],
        },
        filePath: 'hw1.py',
      },
      {
        sessionId: 'abc',
        seq: 2,
        globalIdx: 2,
        wall: '2026-01-01T00:00:20.000Z',
        t: 20000,
        kind: 'paste',
        payload: { length: 300, file: 'hw1.py' },
        filePath: 'hw1.py',
      },
      {
        sessionId: 'abc',
        seq: 3,
        globalIdx: 3,
        wall: '2026-01-01T00:00:30.000Z',
        t: 30000,
        kind: 'doc.save',
        payload: { sha256: 'abc', file: 'hw1.py' },
        filePath: 'hw1.py',
      },
    ],
  } as unknown as EventIndex;
}

// ---------------------------------------------------------------------------
// Bundle fixture
// ---------------------------------------------------------------------------

export function makeMinimalBundle(): Bundle {
  return {
    id: 'test-bundle-id',
    droppedArtifacts: [],
    manifest: {
      format_version: '1.0' as const,
      assignment_id: 'hw1',
      semester: 'sp26',
      extension_hash: 'deadbeef',
      sessions: [
        {
          session_id: 'abc',
          prev_session_id: null,
          slog_sha256: 'aaa',
          meta_sha256: 'bbb',
        },
      ],
    },
    manifestSigHex: 'sig',
    sessions: [
      {
        sessionId: 'abc',
        events: [],
        meta: {} as never,
        slogSha256: 'a'.repeat(64),
        slogSha256Lf: null,
        tornTail: null,
        metaSha256: 'b'.repeat(64),
        firstEvent: {
          seq: 0,
          kind: 'session.start',
          t: 0,
          wall: '2026-01-01T00:00:00.000Z',
          hash: 'h',
          prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
          data: {
            format_version: '1.0',
            session_id: 'abc',
            prev_session_id: null,
            assignment: { id: 'hw1', semester: 'sp26' },
            manifest_sig: 'sig',
            machine_id: 'test',
          },
        } as never,
      },
    ],
    sourceFilename: 'hw1-bundle.zip',
    loadedAt: '2026-01-01T01:00:00.000Z',
    submissionFiles: new Map(),
  };
}
