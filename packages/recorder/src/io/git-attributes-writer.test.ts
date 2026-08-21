/**
 * Tests for the `.provenance/.gitattributes` writer — the prevention half of the
 * git line-ending fix.
 *
 * What these are careful about, because each is a way the prevention could fail
 * quietly or do harm:
 *
 *  1. **It must never overwrite.** `.provenance/` is shared between partners and
 *     is add-only. Clobbering a file this recorder did not write is bug 2's sin.
 *  2. **It must never throw.** A read-only checkout or a full disk is not a
 *     reason to lose a recording.
 *  3. **It must actually contain the line that does the work.** A file that is
 *     created but says nothing useful is worse than none, because it looks like
 *     the problem is handled.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PROVENANCE_GITATTRIBUTES_CONTENT,
  PROVENANCE_GITATTRIBUTES_FILENAME,
  looksLikeItDisablesEolTranslation,
} from '@provenance/log-core';
import { ensureProvenanceGitAttributes } from './git-attributes-writer.js';
import type { GitAttributesFs } from './git-attributes-writer.js';

/** An in-memory fs that records how it was called. */
function fakeFs(initial: Record<string, string> = {}): GitAttributesFs & {
  files: Map<string, string>;
  writes: Array<{ path: string; flag: unknown }>;
} {
  const files = new Map(Object.entries(initial));
  const writes: Array<{ path: string; flag: unknown }> = [];
  return {
    files,
    writes,
    writeFile: (async (p: string, data: string, opts?: { flag?: string }) => {
      writes.push({ path: p, flag: opts?.flag });
      if (opts?.flag === 'wx' && files.has(p)) {
        const e = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
        e.code = 'EEXIST';
        throw e;
      }
      files.set(p, data);
    }) as unknown as GitAttributesFs['writeFile'],
    readFile: (async (p: string) => {
      const v = files.get(p);
      if (v === undefined) {
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      }
      return v;
    }) as unknown as GitAttributesFs['readFile'],
  };
}

describe('ensureProvenanceGitAttributes — creating', () => {
  it('creates the file when the directory has none', async () => {
    const fs = fakeFs();
    const out = await ensureProvenanceGitAttributes('/w/.provenance', fs);

    expect(out.kind).toBe('created');
    expect(fs.files.get(`/w/.provenance/${PROVENANCE_GITATTRIBUTES_FILENAME}`)).toBe(
      PROVENANCE_GITATTRIBUTES_CONTENT,
    );
  });

  it('creates EXCLUSIVELY, so two recorders racing cannot both write', async () => {
    // The kernel decides the race. A check-then-write would let both win.
    const fs = fakeFs();
    await ensureProvenanceGitAttributes('/w/.provenance', fs);
    expect(fs.writes[0]!.flag).toBe('wx');
  });

  it('writes content that actually disables end-of-line translation', async () => {
    // The whole point. A `.gitattributes` without this is decoration.
    expect(PROVENANCE_GITATTRIBUTES_CONTENT).toContain('* -text');
    expect(looksLikeItDisablesEolTranslation(PROVENANCE_GITATTRIBUTES_CONTENT)).toBe(true);
  });
});

describe('ensureProvenanceGitAttributes — never overwrites', () => {
  it('leaves an existing protective file exactly as it was', async () => {
    const path = `/w/.provenance/${PROVENANCE_GITATTRIBUTES_FILENAME}`;
    const fs = fakeFs({ [path]: '*.slog -text\n' });
    const out = await ensureProvenanceGitAttributes('/w/.provenance', fs);

    expect(out).toEqual({ kind: 'already_present', filePath: path, protective: true });
    expect(fs.files.get(path)).toBe('*.slog -text\n');
  });

  it('leaves an existing NON-protective file alone too, and warns', async () => {
    // A partner's or the course's file. We do not own it, so we do not touch it
    // — but silence here would mean the prevention had quietly failed.
    const path = `/w/.provenance/${PROVENANCE_GITATTRIBUTES_FILENAME}`;
    const fs = fakeFs({ [path]: '* text=auto\n' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await ensureProvenanceGitAttributes('/w/.provenance', fs);

    expect(out).toEqual({ kind: 'already_present', filePath: path, protective: false });
    expect(fs.files.get(path)).toBe('* text=auto\n');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('does not appear to disable');
    warn.mockRestore();
  });

  it('does not warn when the existing file already protects the bytes', async () => {
    const path = `/w/.provenance/${PROVENANCE_GITATTRIBUTES_FILENAME}`;
    const fs = fakeFs({ [path]: '* binary\n' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await ensureProvenanceGitAttributes('/w/.provenance', fs);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('ensureProvenanceGitAttributes — never throws', () => {
  it('reports a read-only directory instead of failing the session', async () => {
    const fs = fakeFs();
    fs.writeFile = (async () => {
      const e = new Error('EROFS: read-only file system') as NodeJS.ErrnoException;
      e.code = 'EROFS';
      throw e;
    }) as unknown as GitAttributesFs['writeFile'];

    const out = await ensureProvenanceGitAttributes('/w/.provenance', fs);
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && out.message).toContain('EROFS');
  });

  it('reports rather than claims protection when an existing file cannot be read', async () => {
    // EEXIST said it is there; the read then failed. We must not report
    // `already_present, protective: true` — we do not know.
    const path = `/w/.provenance/${PROVENANCE_GITATTRIBUTES_FILENAME}`;
    const fs = fakeFs({ [path]: 'whatever' });
    fs.readFile = (async () => {
      const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      e.code = 'EACCES';
      throw e;
    }) as unknown as GitAttributesFs['readFile'];

    const out = await ensureProvenanceGitAttributes('/w/.provenance', fs);
    expect(out.kind).toBe('failed');
  });
});

describe('looksLikeItDisablesEolTranslation', () => {
  it('accepts -text and the binary macro', () => {
    expect(looksLikeItDisablesEolTranslation('* -text\n')).toBe(true);
    expect(looksLikeItDisablesEolTranslation('*.slog binary\n')).toBe(true);
  });

  it('rejects attribute files that leave translation on', () => {
    expect(looksLikeItDisablesEolTranslation('* text=auto\n')).toBe(false);
    expect(looksLikeItDisablesEolTranslation('* text=auto eol=crlf\n')).toBe(false);
    expect(looksLikeItDisablesEolTranslation('')).toBe(false);
  });

  it('ignores comments, so a commented-out rule does not count as protection', () => {
    expect(looksLikeItDisablesEolTranslation('# * -text\n')).toBe(false);
  });

  it('does not mistake "text" inside a longer token for "-text"', () => {
    expect(looksLikeItDisablesEolTranslation('* diff=mytext\n')).toBe(false);
  });
});
