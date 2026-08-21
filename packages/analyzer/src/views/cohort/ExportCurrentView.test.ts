/**
 * buildCsv — the cohort CSV column contract.
 *
 * Graders' spreadsheets consume this by column position, so the pre-0029
 * columns must keep both their order and their exact solo-row values. The
 * contributor columns are appended at the END for that reason.
 */

import { describe, it, expect } from 'vitest';
import { buildCsv } from './ExportCurrentView.js';
import { makeSubmissionRow, makeSubmissionContributor } from '../../test/msw-handlers.js';
import { UNNAMED_CONTRIBUTOR_LABEL } from '../../lib/contributor-display.js';

const PRE_0029_HEADERS = [
  'submission_id',
  'student_sid',
  'student_name',
  'assignment',
  'score_total',
  'score_max_severity',
  'flags_high',
  'flags_medium',
  'flags_low',
  'flags_info',
  'top_flags',
  'active_time',
  'idle_time',
  'validation_status',
  'ingested_at',
  'recompute_status',
  'superseded',
];

function headerCells(csv: string): string[] {
  return csv.split('\n')[0]!.split(',');
}

function rowCells(csv: string, index: number): string[] {
  return csv.split('\n')[index + 1]!.split(',');
}

describe('buildCsv column contract', () => {
  it('keeps every pre-0029 column in its original position', () => {
    const csv = buildCsv([makeSubmissionRow()]);
    expect(headerCells(csv).slice(0, PRE_0029_HEADERS.length)).toEqual(PRE_0029_HEADERS);
  });

  it('appends the contributor columns at the end', () => {
    const csv = buildCsv([makeSubmissionRow()]);
    expect(headerCells(csv).slice(PRE_0029_HEADERS.length)).toEqual([
      'contributor_count',
      'contributor_sids',
      'contributor_names',
    ]);
  });

  it('leaves a solo row pre-0029 cells byte-identical to the student fields', () => {
    const row = makeSubmissionRow();
    const cells = rowCells(buildCsv([row]), 0);
    expect(cells[1]).toBe(row.student!.sid);
    expect(cells[2]).toBe(row.student!.display_name);
    // ...and the appended columns simply repeat them.
    expect(cells.slice(PRE_0029_HEADERS.length)).toEqual([
      '1',
      row.student!.sid,
      row.student!.display_name,
    ]);
  });

  it('carries every contributor of a group submission instead of losing them', () => {
    const row = makeSubmissionRow({
      contributors: [
        makeSubmissionContributor(),
        makeSubmissionContributor({
          contributor_key: 'roster:30000000-0000-0000-0000-000000000002',
          student: {
            id: '30000000-0000-0000-0000-000000000002',
            sid: '3035678',
            display_name: 'Bob Cratchit',
          },
        }),
      ],
    });
    const cells = rowCells(buildCsv([row]), 0);
    expect(cells.slice(PRE_0029_HEADERS.length)).toEqual([
      '2',
      '3031234;3035678',
      // Semicolon-joined, so no comma to escape — one CSV cell.
      'Alice Liddell;Bob Cratchit',
    ]);
  });

  it('emits empty submitter cells and the neutral label when nobody is on the roster', () => {
    const row = makeSubmissionRow({
      student: null,
      contributors: [
        makeSubmissionContributor({
          contributor_key: 'attributed:abc',
          kind: 'attributed',
          student: null,
          student_ref: 'ref-abc',
        }),
      ],
    });
    const cells = rowCells(buildCsv([row]), 0);
    expect(cells[1]).toBe('');
    expect(cells[2]).toBe('');
    expect(cells.slice(PRE_0029_HEADERS.length)).toEqual(['1', '', UNNAMED_CONTRIBUTOR_LABEL]);
  });
});
