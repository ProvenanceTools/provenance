/**
 * Write the `.gitattributes` that stops git rewriting `.provenance/`'s bytes.
 *
 * The WHY — what git's end-of-line filters do to a signed `.slog`, why the
 * analyzer cannot fully repair it after the fact, and why the content is
 * `* -text` — lives in `log-core/git-attributes.ts` alongside the bytes
 * themselves, so all three recorders read one explanation.
 *
 * This module is only the write policy, and the policy is almost entirely about
 * what NOT to do:
 *
 *  - **Never overwrite.** `.provenance/` is shared between partners in a 61B/61C
 *    repository and is add-only. A `.gitattributes` already there may be a
 *    partner's, the course's, or the student's own, and clobbering a file the
 *    recorder did not write is exactly the sin of bug 2 (a recorder quarantining
 *    its partner's log). The create is `wx`, so "already there" is decided by
 *    the kernel rather than by a check-then-write that two recorders could both
 *    win.
 *  - **Never throw.** A read-only checkout, a full disk, a directory owned by
 *    another user — none of them is a reason to fail a recording. Every failure
 *    returns an outcome and records nothing else.
 *  - **Never emit an event.** This is not a recorded fact about the session; it
 *    is housekeeping. Adding an event kind would be a log-format change and a
 *    tri-repo contract change, for something the analyzer can already see
 *    directly (either the digests match or they do not).
 *
 * ## Concurrency
 *
 * Two recorders can start in the same `.provenance/` at the same time — two VS
 * Code windows, or a partner's editor in the same clone. `flag: 'wx'` makes the
 * create atomic: exactly one wins, the other gets `EEXIST` and reports
 * `already_present`. Both outcomes are correct and neither writes twice.
 *
 * ## When one is already there but does not protect anything
 *
 * The student may have a `.gitattributes` in `.provenance/` that says something
 * else entirely. We still do not touch it — but staying silent would mean the
 * prevention had quietly failed, which is the shape of defect this whole change
 * exists to remove. So the existing file is read and, if nothing in it disables
 * end-of-line translation, a warning goes to the extension console naming the
 * path and the one line that would fix it.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
  PROVENANCE_GITATTRIBUTES_FILENAME,
  PROVENANCE_GITATTRIBUTES_CONTENT,
  looksLikeItDisablesEolTranslation,
} from '@provenance/log-core';

/**
 * What happened. Returned rather than thrown, and returned even for failures,
 * so a caller that wants to surface this has something to surface and a caller
 * that does not can ignore it without swallowing an exception.
 */
export type GitAttributesOutcome =
  /** This recorder created the file. */
  | { kind: 'created'; filePath: string }
  /**
   * A `.gitattributes` was already there and was left exactly as it was.
   * `protective` records whether it appears to disable end-of-line translation;
   * `false` means the logs in this directory are still exposed.
   */
  | { kind: 'already_present'; filePath: string; protective: boolean }
  /** Nothing was written and nothing was changed. Never fatal. */
  | { kind: 'failed'; filePath: string; message: string };

/** The filesystem operations this module needs. Injectable for tests. */
export type GitAttributesFs = {
  writeFile: typeof fsPromises.writeFile;
  readFile: typeof fsPromises.readFile;
};

/**
 * Create `.provenance/.gitattributes` if it is not already there.
 *
 * @param provenanceDir The `.provenance/` directory, already created.
 * @param _fs           Injectable fs; defaults to the real `node:fs/promises`.
 */
export async function ensureProvenanceGitAttributes(
  provenanceDir: string,
  _fs: GitAttributesFs = fsPromises,
): Promise<GitAttributesOutcome> {
  const filePath = path.join(provenanceDir, PROVENANCE_GITATTRIBUTES_FILENAME);

  try {
    // 'wx' — create exclusively. The kernel decides the race, so two recorders
    // starting together cannot both write, and an existing file is never
    // truncated.
    await _fs.writeFile(filePath, PROVENANCE_GITATTRIBUTES_CONTENT, { flag: 'wx' });
    return { kind: 'created', filePath };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      // A read-only checkout, a full disk, a permissions problem. The recording
      // continues; the logs are simply unprotected against git's filters, which
      // is exactly where they stood before this file existed.
      return { kind: 'failed', filePath, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // Something is already there. Read it — only to decide whether to warn. It is
  // never modified, whatever it turns out to say.
  try {
    const existing = await _fs.readFile(filePath, 'utf8');
    const protective = looksLikeItDisablesEolTranslation(existing);
    if (!protective) {
      console.warn(
        `[provenance] ${filePath} already exists and does not appear to disable git's ` +
          `end-of-line translation. Leaving it untouched. Without a "* -text" line there, a ` +
          `checkout under core.autocrlf=true or a "text=auto eol=crlf" attribute can rewrite ` +
          `this session's log bytes and make an untouched log look modified to the analyzer.`,
      );
    }
    return { kind: 'already_present', filePath, protective };
  } catch (e) {
    // It exists (EEXIST above said so) but cannot be read. Nothing was changed,
    // and we cannot say whether it protects anything — so do not claim it does.
    return { kind: 'failed', filePath, message: e instanceof Error ? e.message : String(e) };
  }
}
