import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { inspectDroppedFiles, candidateToFile } from './inspect-dropped-files.js';

/** Minimal rolling-sealed scope at `prefix` (may be '' for the tree root). */
function addScope(zip: JSZip, prefix: string, assignmentId: string, slogLines: number): void {
  const sid = '11111111-1111-1111-1111-111111111111';
  zip.file(
    `${prefix}.provenance/manifest-${sid}.json`,
    JSON.stringify({ assignment_id: assignmentId, semester: 'fa26', submission_files: [] }),
  );
  zip.file(`${prefix}.provenance/manifest-${sid}.sig`, 'deadbeef');
  zip.file(
    `${prefix}.provenance/session-${sid}.slog`,
    Array.from({ length: slogLines }, (_, i) => `{"seq":${i}}`).join('\n'),
  );
  zip.file(`${prefix}.provenance/session-${sid}.slog.meta`, JSON.stringify({ session_id: sid }));
}

async function zipToFile(zip: JSZip, name: string): Promise<File> {
  const ab = await zip.generateAsync({ type: 'arraybuffer' });
  return new File([ab], name);
}

describe('inspectDroppedFiles', () => {
  it('returns null candidates for a flat sealed bundle', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ assignment_id: 'proj2', submission_files: [] }));
    zip.file('manifest.sig', 'deadbeef');
    zip.file('session-11111111-1111-1111-1111-111111111111.slog', '{"seq":0}');
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'bundle.zip')]);
    expect(inspected!.candidates).toBeNull();
  });

  it('finds one candidate per sealed scope in a monorepo, sorted by path', async () => {
    const zip = new JSZip();
    addScope(zip, 'proj2/', 'proj2', 4);
    addScope(zip, 'lab5/', 'lab5', 2);
    zip.file('README.md', '# monorepo');
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'repo.zip')]);
    const candidates = inspected!.candidates!;
    expect(candidates.map((c) => c.scopePath)).toEqual(['lab5/', 'proj2/']);
    expect(candidates.map((c) => c.declaredAssignmentId)).toEqual(['lab5', 'proj2']);
  });

  it('counts sessions and approximates events from slog line counts', async () => {
    const zip = new JSZip();
    addScope(zip, 'proj2/', 'proj2', 4);
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'repo.zip')]);
    const c = inspected!.candidates![0]!;
    expect(c.sessionCount).toBe(1);
    expect(c.approxEventCount).toBe(4);
    expect(c.totalBytes).toBeGreaterThan(0);
  });

  it('lists an unsealed .provenance/ as a non-selectable candidate', async () => {
    const zip = new JSZip();
    addScope(zip, 'proj2/', 'proj2', 2);
    zip.file('lab5/.provenance/notes.txt', 'nothing seals this');
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'repo.zip')]);
    const lab5 = inspected!.candidates!.find((c) => c.scopePath === 'lab5/')!;
    expect(lab5.selectable).toBe(false);
    expect(lab5.declaredAssignmentId).toBeNull();
  });

  it('treats an archive whose only .provenance entries are macOS junk as not repo-shaped', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ assignment_id: 'proj2', submission_files: [] }));
    zip.file('manifest.sig', 'deadbeef');
    zip.file('session-11111111-1111-1111-1111-111111111111.slog', '{"seq":0}');
    zip.file('__MACOSX/proj2/.provenance/._manifest.json', 'junk');
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'bundle.zip')]);
    expect(inspected!.candidates).toBeNull();
  });

  it('returns null candidates for bytes that are not a zip', async () => {
    const [inspected] = await inspectDroppedFiles([new File([new Uint8Array([1, 2, 3])], 'x.zip')]);
    expect(inspected!.candidates).toBeNull();
  });

  it('candidateToFile rebuilds a loadable flat bundle named for its scope', async () => {
    const zip = new JSZip();
    addScope(zip, 'proj2/', 'proj2', 2);
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'repo.zip')]);
    const out = await candidateToFile('repo', inspected!.candidates![0]!);
    expect(out.name).toBe('repo/proj2.zip');
    // Read the produced File as a Blob: jsdom has no Blob.prototype.arrayBuffer.
    const reread = await JSZip.loadAsync(out);
    expect(Object.keys(reread.files).some((n) => n.startsWith('manifest-'))).toBe(true);
    expect(Object.keys(reread.files).every((n) => !n.includes('.provenance/'))).toBe(true);
  });

  it('names a root-scope candidate with the uploaded stem', async () => {
    const zip = new JSZip();
    addScope(zip, '', 'proj2', 2);
    zip.file('nested/.provenance/manifest-22222222-2222-2222-2222-222222222222.json', '{}');
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'repo.zip')]);
    const root = inspected!.candidates!.find((c) => c.scopePath === '')!;
    expect((await candidateToFile('repo', root)).name).toBe('repo.zip');
  });
});
