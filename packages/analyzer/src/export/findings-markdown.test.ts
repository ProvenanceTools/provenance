/**
 * findings-markdown.test.ts — pure-function tests for the Markdown exporter.
 *
 * The big test is an inline snapshot against a hand-built fixture so the
 * shape of the report is self-documenting in the test file. The clock is
 * always injected, so the snapshot is stable across runs.
 */

import { describe, it, expect } from 'vitest';
import { renderFindings, filenameFor } from './findings-markdown.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { ValidationReport } from '@provenance/analysis-core/validation/check-types.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import type { CrossFlag } from '@provenance/analysis-core/heuristics/cross/types.js';
import type { HashedEnvelope } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeFixtureBundle(): Bundle {
  const events: HashedEnvelope[] = [
    {
      seq: 0,
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      kind: 'session.start',
      data: {
        format_version: '1.0',
        session_id: 'abc',
        prev_session_id: null,
        assignment: { id: 'hw1', semester: 'sp26' },
        manifest_sig: 'sig',
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
        length: 500,
        sha256: 'pastehash',
        content: 'def foo():\n    return 42\n',
      },
      prev_hash: 'hash0',
      hash: 'hash1',
    } as HashedEnvelope,
    {
      seq: 2,
      t: 2000,
      wall: '2026-01-01T00:00:02.000Z',
      kind: 'fs.external_change',
      data: {
        path: 'hw1.py',
        old_hash: 'a'.repeat(64),
        new_hash: 'b'.repeat(64),
        diff_size: 250,
      },
      prev_hash: 'hash1',
      hash: 'hash2',
    } as HashedEnvelope,
  ];

  return {
    id: 'test-bundle-id',
    manifest: {
      format_version: '1.0',
      assignment_id: 'hw1',
      semester: 'sp26',
      extension_hash: 'd'.repeat(64),
      sessions: [
        {
          session_id: 'abc',
          prev_session_id: null,
          slog_sha256: 'a'.repeat(64),
          meta_sha256: 'b'.repeat(64),
        },
      ],
    },
    manifestSigHex: 'sig-hex',
    sessions: [
      {
        sessionId: 'abc',
        events,
        meta: {} as never,
        slogSha256: 'a'.repeat(64),
        metaSha256: 'b'.repeat(64),
        firstEvent: events[0] as never,
      },
    ],
    sourceFilename: 'hw1-bundle.zip',
    loadedAt: '2026-01-01T01:00:00.000Z',
    submissionFiles: new Map(),
  };
}

const fixtureReport: ValidationReport = {
  overall: 'fail',
  checks: [
    { id: 'manifest_sig', label: 'Manifest signature', status: 'pass' },
    { id: 'session_binding', label: 'Session binding', status: 'pass' },
    {
      id: 'chain_integrity',
      label: 'Chain integrity',
      status: 'fail',
      detail: 'Hash mismatch at seq 4.',
      supportingSeqs: [{ sessionId: 'abc', seq: 4 }],
    },
    { id: 'seq_gaps', label: 'Sequence gaps', status: 'pass' },
    { id: 'monotonic_t', label: 'Monotonic t', status: 'pass' },
    { id: 'monotonic_wall', label: 'Monotonic wall', status: 'pass' },
    { id: 'doc_save_hashes', label: 'Doc-save hashes', status: 'pass' },
    {
      id: 'submitted_code_match',
      label: 'Submitted code match',
      status: 'skipped',
      detail: 'No course-staff hashes available in v1.',
    },
  ],
};

const fixtureFlags: Flag[] = [
  {
    id: 'large_paste-abc:1-0',
    heuristic: 'large_paste',
    title: 'Large paste detected',
    severity: 'high',
    confidence: 0.9,
    supportingSeqs: ['abc:1'],
    description: 'A paste of 500 characters was detected.',
    detail: { pastedChars: 500, file: 'hw1.py' },
  },
  {
    id: 'external_edits-abc:2-0',
    heuristic: 'external_edits',
    title: 'External file modification',
    severity: 'medium',
    confidence: 0.7,
    supportingSeqs: ['abc:2'],
    description: 'File was modified outside VS Code.',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderFindings', () => {
  it('produces a coherent Markdown report (inline snapshot)', () => {
    const md = renderFindings(makeFixtureBundle(), fixtureReport, fixtureFlags, {
      generatedAt: new Date('2026-05-19T12:34:56.000Z'),
      bundleSha256: 'c'.repeat(64),
    });

    expect(md).toMatchInlineSnapshot(`
      "# Provenance Findings Report

      - **Assignment:** hw1
      - **Semester:** sp26
      - **Bundle filename:** hw1-bundle.zip
      - **Bundle sha256:** cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
      - **Extension hash:** dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
      - **Sessions:** 1
      - **Flags:** 2
      - **Validation overall:** fail
      - **Generated at:** 2026-05-19T12:34:56.000Z

      ## Validation report

      Overall: **fail**

      | Check | Status | Detail |
      | --- | --- | --- |
      | Manifest signature | pass |  |
      | Session ↔ assignment binding | pass |  |
      | Hash chain integrity | fail | Hash mismatch at seq 4. |
      | Sequence gaps | pass |  |
      | Monotonic t | pass |  |
      | Monotonic wall clock | pass |  |
      | doc.save hash consistency | pass |  |
      | Submitted-code hash match | skipped | No course-staff hashes available in v1. |

      ## Heuristic flags

      ### 1. Large paste detected

      - **Heuristic:** \`large_paste\`
      - **Severity:** high
      - **Confidence:** 0.90
      - **Supporting events:** 1

      A paste of 500 characters was detected.

      Supporting event keys:

      - \`abc:1\`

      Detail:

      \`\`\`json
      {
        "file": "hw1.py",
        "pastedChars": 500
      }
      \`\`\`

      ### 2. External file modification

      - **Heuristic:** \`external_edits\`
      - **Severity:** medium
      - **Confidence:** 0.70
      - **Supporting events:** 1

      File was modified outside VS Code.

      Supporting event keys:

      - \`abc:2\`

      ## Appendix: sample supporting events

      ### \`large_paste\` — first supporting event (\`abc:1\`)

      \`\`\`json
      {
        "data": {
          "content": "def foo():\\n    return 42\\n",
          "length": 500,
          "path": "hw1.py",
          "range": {
            "end": {
              "character": 0,
              "line": 0
            },
            "start": {
              "character": 0,
              "line": 0
            }
          },
          "sha256": "pastehash"
        },
        "hash": "hash1",
        "kind": "paste",
        "prev_hash": "hash0",
        "seq": 1,
        "t": 1000,
        "wall": "2026-01-01T00:00:01.000Z"
      }
      \`\`\`

      ### \`external_edits\` — first supporting event (\`abc:2\`)

      \`\`\`json
      {
        "data": {
          "diff_size": 250,
          "new_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "old_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "path": "hw1.py"
        },
        "hash": "hash2",
        "kind": "fs.external_change",
        "prev_hash": "hash1",
        "seq": 2,
        "t": 2000,
        "wall": "2026-01-01T00:00:02.000Z"
      }
      \`\`\`
      "
    `);
  });

  it('renders "(not available)" when bundleSha256 is omitted', () => {
    const md = renderFindings(makeFixtureBundle(), fixtureReport, [], {
      generatedAt: new Date('2026-05-19T12:34:56.000Z'),
    });
    expect(md).toContain('**Bundle sha256:** (not available)');
  });

  it('handles an empty flag list with a friendly message', () => {
    const md = renderFindings(makeFixtureBundle(), fixtureReport, [], {
      generatedAt: new Date('2026-05-19T12:34:56.000Z'),
    });
    expect(md).toContain('_No flags were raised by the v1 heuristic suite._');
    expect(md).toContain(
      '_No supporting events available for the flags raised, or no flags raised._',
    );
  });

  it('renders an "event not found" marker when the supporting seq is not in the bundle', () => {
    const orphanFlag: Flag = {
      id: 'orphan-0',
      heuristic: 'large_paste',
      title: 'Missing-event flag',
      severity: 'low',
      confidence: 0.5,
      supportingSeqs: ['abc:9999'],
      description: 'Synthetic.',
    };
    const md = renderFindings(makeFixtureBundle(), fixtureReport, [orphanFlag], {
      generatedAt: new Date('2026-05-19T12:34:56.000Z'),
    });
    expect(md).toContain('_Event `abc:9999` not found in bundle._');
  });

  it('escapes newlines in recorder-supplied title/description so they cannot inject markdown structure', () => {
    // PRD §6: recorder payloads (e.g. file paths) are attacker-controllable.
    // A crafted path like `hw1.py\n\n# Forged` must NOT produce a real
    // top-level heading or a structural break in the rendered case file.
    const injectionFlag: Flag = {
      id: 'inject-0',
      heuristic: 'large_paste',
      title: 'paste in hw1.py\n\n# Forged heading\n\nAll heuristics cleared',
      severity: 'high',
      confidence: 0.9,
      supportingSeqs: ['abc:1'],
      description: 'desc line 1\n\n# Forged description heading\n\ndesc line 2',
    };
    const md = renderFindings(makeFixtureBundle(), fixtureReport, [injectionFlag], {
      generatedAt: new Date('2026-05-19T12:34:56.000Z'),
    });
    // No standalone `# Forged …` line (a real h1) should appear anywhere.
    expect(md).not.toMatch(/^#[^#].*Forged/m);
    expect(md).not.toContain('\n# Forged');
    // The literal text should still be present, just collapsed onto one line.
    expect(md).toContain('paste in hw1.py # Forged heading All heuristics cleared');
    expect(md).toContain('desc line 1 # Forged description heading desc line 2');
  });

  it('does not call Date.now or other ambient clocks (pure function smoke check)', () => {
    // Run the renderer twice with the same inputs — the output must be byte-equal.
    const inputs = [
      makeFixtureBundle(),
      fixtureReport,
      fixtureFlags,
      { generatedAt: new Date('2026-05-19T12:34:56.000Z'), bundleSha256: 'c'.repeat(64) },
    ] as const;
    const a = renderFindings(inputs[0], inputs[1], inputs[2], inputs[3]);
    const b = renderFindings(inputs[0], inputs[1], inputs[2], inputs[3]);
    expect(a).toBe(b);
  });

  it('escapes recorder-supplied header fields to prevent markdown injection', () => {
    // PRD §6: recorder payloads are attacker-controllable. A hostile assignment_id
    // like `hw1\n\n# Forged conclusion` must NOT inject a real markdown heading.
    const bundle = makeFixtureBundle();
    bundle.manifest = {
      ...bundle.manifest,
      assignment_id: 'hw1\n\n# Forged heading',
      semester: 'sp26\n\n# Another forged',
      extension_hash: 'abc123\n\n# Third forge',
    };
    bundle.sourceFilename = 'bundle.zip\n\n# Injected';

    const md = renderFindings(bundle, fixtureReport, fixtureFlags, {
      generatedAt: new Date('2026-05-19T12:34:56.000Z'),
      bundleSha256: 'c'.repeat(64),
    });

    // No standalone `# Forged …` or `# Another …` or `# Injected` heading lines.
    // The regex `/^#[^#].*Forged/m` matches a line starting with single `#` followed
    // by non-`#` (ruling out ## etc) and containing "Forged".
    expect(md).not.toMatch(/^#[^#].*Forged/m);
    expect(md).not.toMatch(/^#[^#].*Another/m);
    expect(md).not.toMatch(/^#[^#].*Injected/m);

    // The literal text should still be present, just collapsed onto one line.
    expect(md).toContain('hw1 # Forged heading');
    expect(md).toContain('sp26 # Another forged');
    expect(md).toContain('bundle.zip # Injected');
  });

  // ---------------------------------------------------------------------------
  // Cross-flags section (Phase 18 review fix)
  // ---------------------------------------------------------------------------

  const fixtureCrossFlag: CrossFlag = {
    id: 'paste_shared_across_students-bundle-x|bundle-y-0',
    heuristic: 'paste_shared_across_students',
    title: 'Shared paste detected across 2 bundles',
    severity: 'high',
    confidence: 0.95,
    bundleIds: ['bundle-x', 'bundle-y'],
    eventsPerBundle: {
      'bundle-x': ['sess-x:3', 'sess-x:7'],
      'bundle-y': ['sess-y:2'],
    },
    description: 'An identical paste appears in 2 different student bundles.',
    detail: { matchKind: 'sha256_exact', pasteCount: 2 },
  };

  const fixtureBundleNamesById: Record<string, string> = {
    'bundle-x': 'student-x.zip',
    'bundle-y': 'student-y.zip',
  };

  it('renders a Cross-submission flags section when crossFlags is non-empty (inline snapshot)', () => {
    const md = renderFindings(makeFixtureBundle(), fixtureReport, [], {
      generatedAt: new Date('2026-05-19T12:34:56.000Z'),
      crossFlags: [fixtureCrossFlag],
      bundleNamesById: fixtureBundleNamesById,
    });

    // Section heading present.
    expect(md).toContain('## Cross-submission flags');
    // Flag heading present.
    expect(md).toContain('### 1. Shared paste detected across 2 bundles');
    // Bundle name labels (sourceFilename, not UUID).
    expect(md).toContain('student-x.zip');
    expect(md).toContain('student-y.zip');
    // Supporting events line.
    expect(md).toContain('sess-x:3, sess-x:7');
    expect(md).toContain('sess-y:2');
    // Description.
    expect(md).toContain('An identical paste appears in 2 different student bundles.');
    // The section appears between the per-bundle flags section and the appendix.
    const crossPos = md.indexOf('## Cross-submission flags');
    const appendixPos = md.indexOf('## Appendix:');
    expect(crossPos).toBeGreaterThan(-1);
    expect(appendixPos).toBeGreaterThan(crossPos);
  });

  it('omits the Cross-submission flags section when crossFlags is empty', () => {
    const md = renderFindings(makeFixtureBundle(), fixtureReport, fixtureFlags, {
      generatedAt: new Date('2026-05-19T12:34:56.000Z'),
      bundleSha256: 'c'.repeat(64),
      crossFlags: [],
    });

    expect(md).not.toContain('## Cross-submission flags');
    // Output must be byte-identical to the snapshot (no crossFlags passed at all).
    const mdNoCrossFlags = renderFindings(makeFixtureBundle(), fixtureReport, fixtureFlags, {
      generatedAt: new Date('2026-05-19T12:34:56.000Z'),
      bundleSha256: 'c'.repeat(64),
    });
    expect(md).toBe(mdNoCrossFlags);
  });

  it('omits the Cross-submission flags section when crossFlags is omitted', () => {
    const md = renderFindings(makeFixtureBundle(), fixtureReport, fixtureFlags, {
      generatedAt: new Date('2026-05-19T12:34:56.000Z'),
      bundleSha256: 'c'.repeat(64),
    });

    expect(md).not.toContain('## Cross-submission flags');
  });

  it('escapes newlines in cross-flag title/description to prevent markdown injection', () => {
    const injectionCrossFlag: CrossFlag = {
      ...fixtureCrossFlag,
      title: 'paste in hw1.py\n\n# Forged',
      description: 'desc\n\n# Forged description',
    };

    const md = renderFindings(makeFixtureBundle(), fixtureReport, [], {
      generatedAt: new Date('2026-05-19T12:34:56.000Z'),
      crossFlags: [injectionCrossFlag],
      bundleNamesById: fixtureBundleNamesById,
    });

    // No standalone `# Forged …` heading line.
    expect(md).not.toMatch(/^#[^#].*Forged/m);
    expect(md).not.toContain('\n# Forged');
    // The text is still present, just collapsed.
    expect(md).toContain('paste in hw1.py # Forged');
    expect(md).toContain('desc # Forged description');
  });
});

describe('filenameFor', () => {
  it('includes the assignment id and a UTC timestamp', () => {
    const bundle = makeFixtureBundle();
    const name = filenameFor(bundle, new Date('2026-05-19T12:34:56.000Z'));
    expect(name).toBe('findings-hw1-20260519-123456.md');
  });

  it('sanitizes weird assignment ids', () => {
    const bundle = makeFixtureBundle();
    bundle.manifest = { ...bundle.manifest, assignment_id: 'CS 61A / hw 3!' };
    const name = filenameFor(bundle, new Date('2026-05-19T12:34:56.000Z'));
    expect(name).toBe('findings-CS-61A-hw-3-20260519-123456.md');
  });

  it('falls back to "bundle" if assignment id has no valid chars', () => {
    const bundle = makeFixtureBundle();
    bundle.manifest = { ...bundle.manifest, assignment_id: '!!!' };
    const name = filenameFor(bundle, new Date('2026-05-19T12:34:56.000Z'));
    expect(name).toBe('findings-bundle-20260519-123456.md');
  });

  it('zero-pads single-digit date components', () => {
    const bundle = makeFixtureBundle();
    const name = filenameFor(bundle, new Date('2026-01-02T03:04:05.000Z'));
    expect(name).toBe('findings-hw1-20260102-030405.md');
  });
});
