/**
 * Phase A of the /local load: decide whether a dropped file is a flat sealed
 * bundle (load it as-is, exactly as before this module existed) or a git repo
 * carrying one or more assignment recordings (offer a choice).
 *
 * The repo-shape predicate, the junk rule and the scope-prefix rule are all
 * imported from analysis-core rather than re-spelled here: ingest decides
 * "what is a scope" with that code, and /local exists partly to show staff
 * what ingest did. Two implementations would drift.
 */

import JSZip from 'jszip';
import {
  discoverRepoScopes,
  isJunkPath,
  provenanceScopePrefix,
} from '@provenance/analysis-core/scopes/discover-scopes.js';
import {
  zipBundleEntries,
  type BundleEntry,
} from '@provenance/analysis-core/scopes/select-entries.js';

export interface ScopeCandidate {
  /** `''` for the tree root, else a prefix ending in `/`. */
  scopePath: string;
  declaredAssignmentId: string | null;
  declaredSemester: string | null;
  sessionCount: number;
  /**
   * NDJSON line count over this scope's `.slog` entries — NOT a parsed event
   * count. Discovery has already inflated these bytes, so counting newlines is
   * a linear scan with no JSON parsing; parsing every scope to label the one
   * about to be picked would cost most of a full load. Exact for well-formed
   * NDJSON, off by one for a torn tail or a trailing blank line. Render with a
   * leading tilde.
   */
  approxEventCount: number;
  totalBytes: number;
  /** False for a `.provenance/` sealed by nothing — listed, not selectable. */
  selectable: boolean;
  entries: BundleEntry[];
}

export interface InspectedFile {
  file: File;
  /** null means not repo-shaped; load the file as-is. */
  candidates: ScopeCandidate[] | null;
}

const SLOG_RE = /^session-[0-9a-fA-F-]+\.slog$/;

function countLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const b of bytes) if (b === 0x0a) lines++;
  // A final line with no trailing newline still counts.
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

export async function inspectDroppedFiles(files: File[]): Promise<InspectedFile[]> {
  const out: InspectedFile[] = [];
  for (const file of files) {
    out.push({ file, candidates: await inspectOne(file) });
  }
  return out;
}

async function inspectOne(file: File): Promise<ScopeCandidate[] | null> {
  let archive: JSZip;
  try {
    // The File is handed to JSZip as a Blob rather than read into an
    // ArrayBuffer first: JSZip streams it through FileReader, which avoids a
    // second full copy of the archive and is exactly how analysis-core's own
    // loader takes its input. (It is also the only form that works under
    // jsdom, which does not implement Blob.prototype.arrayBuffer.)
    archive = await JSZip.loadAsync(file);
  } catch {
    return null; // not a zip — let the existing loader report it
  }

  // Name-only repo-shape test, identical to the server's ingest guard: an
  // archive is repo-shaped iff some non-junk entry sits under a `.provenance/`
  // directory. A flat sealed bundle can never satisfy it.
  const names = Object.entries(archive.files)
    .filter(([, o]) => !o.dir)
    .map(([n]) => n);
  const isRepoShaped = names.some((n) => !isJunkPath(n) && provenanceScopePrefix(n) !== null);
  if (!isRepoShaped) return null;

  const contents = new Map<string, Uint8Array>();
  for (const [name, obj] of Object.entries(archive.files)) {
    if (obj.dir) continue;
    contents.set(name, await obj.async('uint8array'));
  }

  const discovered = discoverRepoScopes(contents);
  if (!discovered.ok) return null;

  const sealed: ScopeCandidate[] = discovered.scopes.map((s) => {
    const slogs = s.entries.filter((e) => SLOG_RE.test(e.name));
    return {
      scopePath: s.scopePath,
      declaredAssignmentId: s.declaredAssignmentId,
      declaredSemester: s.declaredSemester,
      sessionCount: slogs.length,
      approxEventCount: slogs.reduce((n, e) => n + countLines(e.data), 0),
      totalBytes: s.entries.reduce((n, e) => n + e.data.length, 0),
      selectable: true,
      entries: s.entries,
    };
  });

  // Unsealed directories are LISTED, not hidden: a student whose recording
  // never sealed should be visible as such rather than silently absent.
  const unsealed: ScopeCandidate[] = discovered.unusable.map((u) => ({
    scopePath: u.scopePath,
    declaredAssignmentId: null,
    declaredSemester: null,
    sessionCount: 0,
    approxEventCount: 0,
    totalBytes: 0,
    selectable: false,
    entries: [],
  }));

  return [...sealed, ...unsealed].sort((a, b) => (a.scopePath < b.scopePath ? -1 : 1));
}

/**
 * Rebuild one chosen scope as the flat bundle zip the loader requires.
 *
 * The root scope keeps the uploaded name so a repo whose provenance sits at its
 * root is labelled exactly as the equivalent flat bundle would be; a nested
 * scope is named for its directory, matching how a fanned-out ingest names it.
 */
export async function candidateToFile(stem: string, c: ScopeCandidate): Promise<File> {
  const name = c.scopePath === '' ? `${stem}.zip` : `${stem}/${c.scopePath.slice(0, -1)}.zip`;
  return new File([await zipBundleEntries(c.entries)], name);
}
