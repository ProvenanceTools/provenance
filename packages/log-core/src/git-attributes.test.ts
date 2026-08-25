/**
 * Tests for the `.provenance/.gitattributes` bytes and the shallow check that
 * decides whether an EXISTING attributes file protects the directory.
 *
 * These bytes are a tri-repo contract: provjet and provnvim write the same file,
 * so pinning the content here is what stops three recorders from protecting
 * three different things. And the content is load-bearing in a way that is easy
 * to lose in a refactor — a `.gitattributes` that exists but omits the one
 * effective line looks like the problem is handled and is not.
 */

import { describe, it, expect } from 'vitest';
import {
  PROVENANCE_GITATTRIBUTES_FILENAME,
  PROVENANCE_GITATTRIBUTES_CONTENT,
  looksLikeItDisablesEolTranslation,
} from './git-attributes.js';

describe('PROVENANCE_GITATTRIBUTES_CONTENT', () => {
  it('is named exactly what git looks for', () => {
    expect(PROVENANCE_GITATTRIBUTES_FILENAME).toBe('.gitattributes');
  });

  it('carries the line that actually disables end-of-line translation', () => {
    // `* -text` and not a per-extension list: every file in `.provenance/` is a
    // signed or digested artifact, and a future artifact type must be covered
    // without a fourth repository having to be updated.
    const effective = PROVENANCE_GITATTRIBUTES_CONTENT.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(effective).toEqual(['* -text']);
  });

  it('sets no text or eol attribute of its own', () => {
    // Either would re-enable the translation this file exists to prevent.
    const effective = PROVENANCE_GITATTRIBUTES_CONTENT.split('\n').filter(
      (l) => !l.trimStart().startsWith('#'),
    );
    expect(effective.some((l) => /(^|\s)text=/.test(l))).toBe(false);
    expect(effective.some((l) => /(^|\s)eol=/.test(l))).toBe(false);
  });

  it('explains itself, because students read this directory', () => {
    // Recorder PRD §6: the protocol is public. A bare `* -text` is the kind of
    // line somebody deletes while tidying.
    expect(PROVENANCE_GITATTRIBUTES_CONTENT).toContain('#');
    expect(PROVENANCE_GITATTRIBUTES_CONTENT).toContain('core.autocrlf');
    expect(PROVENANCE_GITATTRIBUTES_CONTENT).toContain('Do not delete this file');
  });

  it('ends with a newline, so appending to it cannot corrupt the last rule', () => {
    expect(PROVENANCE_GITATTRIBUTES_CONTENT.endsWith('\n')).toBe(true);
  });

  it('is self-consistent: its own content passes the protection check', () => {
    expect(looksLikeItDisablesEolTranslation(PROVENANCE_GITATTRIBUTES_CONTENT)).toBe(true);
  });
});

describe('looksLikeItDisablesEolTranslation', () => {
  it('accepts -text on any pattern', () => {
    expect(looksLikeItDisablesEolTranslation('* -text')).toBe(true);
    expect(looksLikeItDisablesEolTranslation('*.slog -text\n*.slog.meta -text\n')).toBe(true);
    expect(looksLikeItDisablesEolTranslation('* -text -diff\n')).toBe(true);
  });

  it('accepts the binary macro, which expands to include -text', () => {
    expect(looksLikeItDisablesEolTranslation('* binary\n')).toBe(true);
    expect(looksLikeItDisablesEolTranslation('*.slog binary')).toBe(true);
  });

  it('rejects an attributes file that leaves translation on', () => {
    expect(looksLikeItDisablesEolTranslation('* text=auto\n')).toBe(false);
    expect(looksLikeItDisablesEolTranslation('* text=auto eol=crlf\n')).toBe(false);
    expect(looksLikeItDisablesEolTranslation('*.slog text\n')).toBe(false);
  });

  it('rejects empty and whitespace-only files', () => {
    expect(looksLikeItDisablesEolTranslation('')).toBe(false);
    expect(looksLikeItDisablesEolTranslation('\n\n   \n')).toBe(false);
  });

  it('ignores comments — a commented-out rule protects nothing', () => {
    expect(looksLikeItDisablesEolTranslation('# * -text\n')).toBe(false);
    expect(looksLikeItDisablesEolTranslation('  # binary\n')).toBe(false);
  });

  it('finds the rule on a later line, not only the first', () => {
    expect(looksLikeItDisablesEolTranslation('# header\n* text=auto\n*.slog -text\n')).toBe(true);
  });

  it('does not match -text embedded in a longer token', () => {
    // Guarding the regex boundaries: `diff=mytext` and `foo-text` are not the
    // `-text` attribute, and treating them as protection would suppress the
    // warning for a file that protects nothing.
    expect(looksLikeItDisablesEolTranslation('* diff=mytext\n')).toBe(false);
    expect(looksLikeItDisablesEolTranslation('* foo-textish\n')).toBe(false);
    expect(looksLikeItDisablesEolTranslation('* binaryish\n')).toBe(false);
  });
});
