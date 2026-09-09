/**
 * Unit tests for parseSubmissionMetadata — pure, no DB.
 */

import { describe, it, expect } from 'vitest';
import { parseSubmissionMetadata } from './parse-metadata.js';

// A representative Gradescope submission_metadata.yml: Ruby symbol keys, a
// single submitter, a group (two submitters), an sid-only submitter with a
// numeric sid, an empty-submitter submission, plus Ruby timestamps and a
// block-scalar `output` field that must not break parsing.
const SAMPLE = `submission_409194023:
  :submitters:
  - :name: First Last
    :sid: '123456789'
    :email: first@berkeley.edu
  :created_at: 2026-04-26 17:34:00.861687000 Z
  :score: 2.0
  :results:
    score: 2.0
    output: |-
      =====================================================================
      Assignment: Homework 10
      Final Score:2.0
submission_500000001:
  :submitters:
  - :name: Alice A
    :sid: '111'
    :email: alice@berkeley.edu
  - :name: Bob B
    :sid: '222'
    :email: bob@berkeley.edu
  :score: 10.0
submission_600000002:
  :submitters:
  - :sid: 333
  :score: 0.0
submission_700000003:
  :submitters: []
`;

describe('parseSubmissionMetadata', () => {
  it('parses Ruby-symbol-keyed submitters across single, group, and sid-only forms', () => {
    const res = parseSubmissionMetadata(SAMPLE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const byKey = new Map(res.value.submissions.map((s) => [s.folderKey, s]));
    expect(byKey.size).toBe(4);

    // Single submitter.
    expect(byKey.get('submission_409194023')!.submitters).toEqual([
      { sid: '123456789', name: 'First Last', email: 'first@berkeley.edu' },
    ]);

    // Group submission → two submitters.
    expect(byKey.get('submission_500000001')!.submitters).toEqual([
      { sid: '111', name: 'Alice A', email: 'alice@berkeley.edu' },
      { sid: '222', name: 'Bob B', email: 'bob@berkeley.edu' },
    ]);

    // Numeric sid with no name/email → coerced to string, no optional fields.
    expect(byKey.get('submission_600000002')!.submitters).toEqual([{ sid: '333' }]);

    // Empty submitter list is preserved.
    expect(byKey.get('submission_700000003')!.submitters).toEqual([]);
  });

  it('drops submitters that have no sid', () => {
    const yaml = `submission_1:
  :submitters:
  - :name: No Id
    :email: noid@berkeley.edu
  - :sid: '777'
`;
    const res = parseSubmissionMetadata(yaml);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.submissions[0]!.submitters).toEqual([{ sid: '777' }]);
  });

  it('also accepts plain (non-symbol) keys', () => {
    const yaml = `submission_1:
  submitters:
  - sid: '555'
    name: Plain Key
`;
    const res = parseSubmissionMetadata(yaml);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.submissions[0]!.submitters).toEqual([{ sid: '555', name: 'Plain Key' }]);
  });

  it('ignores top-level entries without a submitters field', () => {
    const yaml = `metadata_version: 3
submission_1:
  :submitters:
  - :sid: '1'
`;
    const res = parseSubmissionMetadata(yaml);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.submissions.map((s) => s.folderKey)).toEqual(['submission_1']);
  });

  // Regression: Gradescope's autograder emits a "Correct Assignment Check" test
  // whose output ends in trailing newlines. Ruby's Psych serializes that as a
  // multi-line single-quoted scalar and places the CLOSING quote at column 0 —
  // below the parent node's indentation. libyaml/Psych round-trips this, but a
  // spec-strict parser reads the terminator as absent and reports the scalar as
  // unclosed ("Missing closing 'quote"). A real Fall 2026 CS 61A export carried
  // 3653 of these across all 1573 submissions, failing every ingest.
  it('parses a Psych multi-line quoted scalar whose closing quote sits at column 0', () => {
    const yaml =
      'submission_423401597:\n' +
      '  :submitters:\n' +
      "  - :sid: '3042946091'\n" +
      '  :results:\n' +
      '    tests:\n' +
      '    - name: Correct Assignment Check\n' +
      "      output: 'Don''t worry about this test, it just checks that you submitted the\n" +
      '        correct assignment.\n' +
      '\n' +
      "'\n" +
      '      status: passed\n';

    const res = parseSubmissionMetadata(yaml);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.submissions).toEqual([
      { folderKey: 'submission_423401597', submitters: [{ sid: '3042946091' }] },
    ]);
  });

  it('returns unexpected_shape for a non-mapping document', () => {
    const res = parseSubmissionMetadata('- just\n- a\n- list\n');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('unexpected_shape');
  });

  it('returns invalid_yaml for malformed input', () => {
    const res = parseSubmissionMetadata(':\n  : :\n :::bad');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('invalid_yaml');
  });
});
