import { describe, it, expect } from 'vitest';
import {
  UNNAMED_CONTRIBUTOR_LABEL,
  personLabel,
  personSid,
  contributorLabel,
  contributorSid,
  contributorsLabel,
  contributorsSidLabel,
  type DisplayContributor,
} from './contributor-display.js';

const ALICE: DisplayContributor = {
  student: { sid: '3031234', display_name: 'Alice Liddell' },
};
const BOB: DisplayContributor = {
  student: { sid: '3035678', display_name: 'Bob Cratchit' },
};
const UNNAMED: DisplayContributor = { student: null };

describe('personLabel / personSid', () => {
  it('returns the name and sid for a named person', () => {
    expect(personLabel({ sid: '3031234', display_name: 'Alice Liddell' })).toBe('Alice Liddell');
    expect(personSid({ sid: '3031234', display_name: 'Alice Liddell' })).toBe('3031234');
  });

  it('returns the neutral placeholder and an empty sid for null', () => {
    expect(personLabel(null)).toBe(UNNAMED_CONTRIBUTOR_LABEL);
    expect(personSid(null)).toBe('');
  });

  it('never renders a null person as an error or as "unknown"', () => {
    const label = personLabel(null).toLowerCase();
    expect(label).not.toContain('unknown');
    expect(label).not.toContain('invalid');
    expect(label).not.toContain('error');
    expect(label).not.toContain('missing');
  });
});

describe('contributorLabel / contributorSid', () => {
  it('names a single named contributor exactly as the student would be named', () => {
    expect(contributorLabel(ALICE)).toBe('Alice Liddell');
    expect(contributorSid(ALICE)).toBe('3031234');
  });

  it('uses the neutral placeholder for a single unnamed contributor', () => {
    expect(contributorLabel(UNNAMED)).toBe(UNNAMED_CONTRIBUTOR_LABEL);
    expect(contributorSid(UNNAMED)).toBe('');
  });
});

describe('contributorsLabel / contributorsSidLabel', () => {
  it('a solo submission renders exactly the old student strings', () => {
    expect(contributorsLabel([ALICE])).toBe('Alice Liddell');
    expect(contributorsSidLabel([ALICE])).toBe('3031234');
  });

  it('a solo unnamed contributor renders the neutral placeholder', () => {
    expect(contributorsLabel([UNNAMED])).toBe(UNNAMED_CONTRIBUTOR_LABEL);
    expect(contributorsSidLabel([UNNAMED])).toBe('');
  });

  it('lists both names for two contributors', () => {
    expect(contributorsLabel([ALICE, BOB])).toBe('Alice Liddell, Bob Cratchit');
    expect(contributorsSidLabel([ALICE, BOB])).toBe('3031234, 3035678');
  });

  it('keeps unnamed contributors positionally aligned rather than dropping them', () => {
    expect(contributorsLabel([ALICE, UNNAMED, BOB])).toBe(
      `Alice Liddell, ${UNNAMED_CONTRIBUTOR_LABEL}, Bob Cratchit`,
    );
    expect(contributorsSidLabel([ALICE, UNNAMED, BOB])).toBe('3031234, , 3035678');
  });

  it('honours a custom separator', () => {
    expect(contributorsLabel([ALICE, BOB], { separator: ';' })).toBe('Alice Liddell;Bob Cratchit');
    expect(contributorsSidLabel([ALICE, BOB], { separator: ';' })).toBe('3031234;3035678');
  });

  it('returns empty strings for an empty list with no fallback', () => {
    expect(contributorsLabel([])).toBe('');
    expect(contributorsSidLabel([])).toBe('');
    expect(contributorsLabel([], { fallbackStudent: null })).toBe('');
    expect(contributorsSidLabel([], { fallbackStudent: null })).toBe('');
  });

  it('uses the fallback student only when the list is empty', () => {
    const fallback = { sid: '3039999', display_name: 'Fallback Student' };
    expect(contributorsLabel([], { fallbackStudent: fallback })).toBe('Fallback Student');
    expect(contributorsSidLabel([], { fallbackStudent: fallback })).toBe('3039999');
    expect(contributorsLabel([ALICE], { fallbackStudent: fallback })).toBe('Alice Liddell');
    expect(contributorsSidLabel([ALICE], { fallbackStudent: fallback })).toBe('3031234');
  });
});
