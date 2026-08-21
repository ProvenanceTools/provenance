/**
 * Git line-ending translation must not be reported as tampering.
 *
 * ## What was live before these tests existed
 *
 * A `.slog` is NDJSON, nothing marks it binary, and the git submission path
 * delivers a WORKING TREE — so a repository carrying `* text=auto eol=crlf`, a
 * checkout under `core.eol=crlf`, or `core.autocrlf=true` on the machine that
 * materializes that tree hands the analyzer a `.slog` whose every LF is a CRLF.
 * `log_bytes_match` failed on it at **high severity, confidence 1.0**, asserting
 * *"the log was modified after the bundle was sealed"* and *"This is not
 * recoverable from a benign cause."*
 *
 * And nothing else failed. `parseEntries` splits on `'\n'`, leaving a trailing
 * `'\r'` that `JSON.parse` treats as insignificant whitespace, so every entry
 * parses identically: chain, checkpoints and signature all verify. Seven of the
 * eight PRD §5.4 checks pass. A byte-level artifact of `git clone` therefore
 * read like a surgical edit — the most incriminating possible shape.
 *
 * No CRLF `.slog` fixture existed anywhere in the repo. That is why it survived.
 * `buildTestBundle`'s `gitLineEndings` option now makes one reachable, in both
 * directions, and these tests are the regression.
 *
 * ## The two directions are not symmetric, and the tests say so
 *
 * `archive_crlf` — sealed LF, archived CRLF — is recoverable: undo the widening,
 * re-hash, and hitting the signed digest exactly PROVES the archived file is the
 * sealed file with wider terminators and nothing else.
 *
 * `seal_crlf` — sealed over already-widened bytes, archived narrow — is not, and
 * neither is a mixed file. Undoing either means guessing which of `n` terminators
 * were wide. Those must still FAIL, and the tests below pin that, because a fix
 * that made them pass would be a fix that lets real tampering through. What the
 * failing verdict must no longer do is claim a benign cause is impossible.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import JSZip from 'jszip';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { verifyLogBytes } from './verify-log-bytes.js';
import { runValidation } from './run-validation.js';
import type { Bundle } from '../loader/types.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

async function load(blob: Blob | ArrayBuffer, name = 'test.zip'): Promise<Bundle> {
  const result = await loadBundle(blob, name);
  if (!result.ok) throw new Error(`loadBundle failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

/** The `.slog` entry name in the ZIP — the FILENAME uuid, never the logical id. */
function slogName(logFileId: string): string {
  return `session-${logFileId}.slog`;
}

// ---------------------------------------------------------------------------
// The fixture itself must be honest
// ---------------------------------------------------------------------------

describe('gitLineEndings fixture', () => {
  it('actually puts CRLF bytes in the ZIP, and keeps the signed digest over LF', async () => {
    const { zipBuffer, logFileIds, manifest } = await buildTestBundle({
      gitLineEndings: { direction: 'archive_crlf' },
      sessions: [{ eventCount: 4 }],
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const archived = await zip.file(slogName(logFileIds[0]!))!.async('string');

    // If this fixture ever stops producing CRLF, every test below silently
    // stops testing anything — the exact failure mode that let bug 10 live.
    expect(archived).toContain('\r\n');
    expect(archived.split('\r\n').length).toBeGreaterThan(2);
    // The manifest still commits to the pre-widening bytes, which is the whole
    // premise: git rewrote the file after it was sealed.
    expect(manifest.sessions[0]!.slog_sha256).not.toBe('');
    expect(archived.replace(/\r\n/g, '\n')).not.toBe(archived);
  });

  it('keeps the .slog FILENAME uuid different from the logical session id', async () => {
    // The fixture rule from the decision log, asserted rather than assumed:
    // a fixture that spells both ids the same cannot fail on crossing them.
    const { sessionIds, logFileIds } = await buildTestBundle({
      gitLineEndings: { direction: 'archive_crlf' },
      sessions: [{ eventCount: 3 }],
    });
    expect(logFileIds[0]).not.toBe(sessionIds[0]);
  });

  it('seal_crlf moves the digest onto the widened bytes and archives the narrow ones', async () => {
    const { zipBuffer, logFileIds } = await buildTestBundle({
      gitLineEndings: { direction: 'seal_crlf' },
      sessions: [{ eventCount: 4 }],
    });
    const zip = await JSZip.loadAsync(zipBuffer);
    const archived = await zip.file(slogName(logFileIds[0]!))!.async('string');
    expect(archived).not.toContain('\r\n');
  });
});

// ---------------------------------------------------------------------------
// The regression: a CRLF .slog is not an accusation
// ---------------------------------------------------------------------------

describe('verifyLogBytes — git widened the line endings (recoverable direction)', () => {
  it('does NOT fail a CLASSIC bundle whose .slog was CRLF-translated', async () => {
    const { blob } = await buildTestBundle({
      gitLineEndings: { direction: 'archive_crlf' },
      sessions: [{ eventCount: 5 }],
    });
    const check = verifyLogBytes(await load(blob));

    expect(check.status).toBe('pass');
    // The sentence that made this a maximum-severity accusation.
    expect(check.detail).not.toContain('not recoverable from a benign cause');
    expect(check.detail).not.toContain('modified after sealing');
  });

  it('does NOT fail a ROLLING-sealed bundle — the git path shape', async () => {
    const { blob } = await buildTestBundle({
      rollingSeal: { final: false },
      gitLineEndings: { direction: 'archive_crlf' },
      sessions: [{ eventCount: 5 }],
    });
    const check = verifyLogBytes(await load(blob));
    expect(check.status).toBe('pass');
  });

  it('does NOT fail a FINAL rolling seal either', async () => {
    // A final seal commits to the whole file and skips the prefix search, so it
    // needs the line-ending retry independently of the non-final path. Without
    // it, a clean shutdown is punished harder than a crash.
    const { blob } = await buildTestBundle({
      rollingSeal: { final: true },
      gitLineEndings: { direction: 'archive_crlf' },
      sessions: [{ eventCount: 5 }],
    });
    const check = verifyLogBytes(await load(blob));
    expect(check.status).toBe('pass');
  });

  it('SAYS SO — the translation is reported, never silently swallowed', async () => {
    const { blob, sessionIds } = await buildTestBundle({
      gitLineEndings: { direction: 'archive_crlf' },
      sessions: [{ eventCount: 5 }],
    });
    const check = verifyLogBytes(await load(blob));

    expect(check.detail).toContain("undoing git's LF→CRLF");
    expect(check.detail).toContain('THIS IS NOT A MODIFICATION OF THE LOG');
    // Names the affected session and file, so staff can audit the claim.
    expect(check.detail).toContain(sessionIds[0]!);
    expect(check.detail).toContain('.slog');
    // Points at the actual remedy rather than at the student.
    expect(check.detail).toContain('.gitattributes');
  });

  it('does not claim the bytes are the sealed bytes when they are not', async () => {
    // The passing verdict used to assert "The bytes of every checked .slog and
    // .slog.meta are the bytes that were sealed." Under a translation that
    // sentence is false, and leaving it would bury the one fact worth surfacing.
    const { blob } = await buildTestBundle({
      gitLineEndings: { direction: 'archive_crlf' },
      sessions: [{ eventCount: 5 }],
    });
    const check = verifyLogBytes(await load(blob));
    expect(check.detail).not.toContain('are the bytes that were sealed');
    expect(check.detail).toContain('is what was sealed');
  });

  it('leaves every other validation check exactly as it was', async () => {
    // The reason this bug read as deliberate: everything else passes. That must
    // remain true — the fix must not have quietly changed the chain or the
    // signature verdicts to get here.
    const { blob } = await buildTestBundle({
      gitLineEndings: { direction: 'archive_crlf' },
      sessions: [{ eventCount: 5 }],
    });
    const report = await runValidation(await load(blob));
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));

    expect(byId['manifest_sig']).toBe('pass');
    expect(byId['chain_integrity']).toBe('pass');
    expect(byId['seq_gaps']).toBe('pass');
    expect(byId['monotonic_t']).toBe('pass');
    expect(byId['monotonic_wall']).toBe('pass');
  });

  it('produces no integrity Flag at all', async () => {
    // The outcome that actually reaches a grader. `log_bytes_match` is a static
    // high/1.0 flag titled "Session log bytes do not match the signed manifest",
    // so a `fail` here is the accusation regardless of how kind the detail text is.
    const { blob } = await buildTestBundle({
      rollingSeal: { final: false },
      gitLineEndings: { direction: 'archive_crlf' },
      sessions: [{ eventCount: 5 }],
    });
    const report = await runValidation(await load(blob));
    const detection = report.bundleDetections?.find((d) => d.id === 'log_bytes_match');
    expect(detection?.status).toBe('pass');
  });

  it('handles a multi-session bundle where only ONE session was translated', async () => {
    const { blob, sessionIds } = await buildTestBundle({
      gitLineEndings: { direction: 'archive_crlf', sessionIndexes: [1] },
      sessions: [{ eventCount: 4 }, { eventCount: 4 }, { eventCount: 4 }],
    });
    const check = verifyLogBytes(await load(blob));

    expect(check.status).toBe('pass');
    expect(check.detail).toContain(sessionIds[1]!);
    // Exactly one digest needed undoing, not all three.
    expect(check.detail).toContain('1 log-file digest(s) matched only after');
  });
});

// ---------------------------------------------------------------------------
// Real tampering must still fail. If it does not, this change is worse than
// the bug it fixes.
// ---------------------------------------------------------------------------

describe('verifyLogBytes — the line-ending retry is not a licence', () => {
  /** Append a well-formed extra line, the way the characterized hole did. */
  async function appendEntry(zipBuffer: ArrayBuffer, fid: string, crlf: boolean) {
    const zip = await JSZip.loadAsync(zipBuffer);
    const name = slogName(fid);
    const text = await zip.file(name)!.async('string');
    const eol = crlf ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    zip.file(name, lines.join(eol) + eol + lines[lines.length - 1]! + eol);
    return zip.generateAsync({ type: 'arraybuffer' });
  }

  it('STILL fails an appended entry in a plain LF bundle', async () => {
    const { zipBuffer, logFileIds } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const check = verifyLogBytes(await load(await appendEntry(zipBuffer, logFileIds[0]!, false)));
    expect(check.status).toBe('fail');
  });

  it('STILL fails an appended entry hidden inside a CRLF translation', async () => {
    // The attack the retry would enable if it were a search rather than one
    // fixed rewrite: widen the terminators AND slip in an extra entry, hoping
    // the normalization absorbs both. Undoing the widening leaves the extra
    // entry in place, so the digest still misses.
    const { zipBuffer, logFileIds } = await buildTestBundle({
      gitLineEndings: { direction: 'archive_crlf' },
      sessions: [{ eventCount: 5 }],
    });
    const check = verifyLogBytes(await load(await appendEntry(zipBuffer, logFileIds[0]!, true)));
    expect(check.status).toBe('fail');
  });

  it('STILL fails a flipped byte inside a CRLF-translated log', async () => {
    const { zipBuffer, logFileIds } = await buildTestBundle({
      gitLineEndings: { direction: 'archive_crlf' },
      sessions: [{ eventCount: 5 }],
    });
    const zip = await JSZip.loadAsync(zipBuffer);
    const name = slogName(logFileIds[0]!);
    const text = await zip.file(name)!.async('string');
    zip.file(name, text.replace('doc.change', 'doc.chXnge'));
    const check = verifyLogBytes(await load(await zip.generateAsync({ type: 'arraybuffer' })));
    expect(check.status).toBe('fail');
  });

  it('STILL fails a lone CR that git never produces', async () => {
    // `toLf` rewrites only `\r\n`. A stray `\r` survives normalization, so it
    // cannot be laundered through the retry — which is what makes the proof in
    // `loader/line-endings.ts` hold.
    const { zipBuffer, logFileIds } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const zip = await JSZip.loadAsync(zipBuffer);
    const name = slogName(logFileIds[0]!);
    const text = await zip.file(name)!.async('string');
    zip.file(name, '\r' + text);
    const check = verifyLogBytes(await load(await zip.generateAsync({ type: 'arraybuffer' })));
    expect(check.status).toBe('fail');
  });

  it('STILL fails the UNRECOVERABLE direction (sealed over widened bytes)', async () => {
    const { blob } = await buildTestBundle({
      gitLineEndings: { direction: 'seal_crlf' },
      sessions: [{ eventCount: 5 }],
    });
    const check = verifyLogBytes(await load(blob));
    expect(check.status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// The wording a student with an already-broken repo is judged by.
// ---------------------------------------------------------------------------

describe('verifyLogBytes — a mismatch no longer asserts a cause it cannot establish', () => {
  it('never claims a benign cause is impossible', async () => {
    // Decision-log bug 13, exactly: the finding stays, the confidence of the
    // INTERPRETATION is what was wrong. "This is not recoverable from a benign
    // cause" was false — git's default filters produce this symptom — and it was
    // persisted into a staff-visible string.
    const { blob } = await buildTestBundle({
      gitLineEndings: { direction: 'seal_crlf' },
      sessions: [{ eventCount: 5 }],
    });
    const check = verifyLogBytes(await load(blob));

    expect(check.status).toBe('fail');
    expect(check.detail).not.toContain('not recoverable from a benign cause');
  });

  it('names line-ending translation as a reading it cannot exclude', async () => {
    const { zipBuffer, logFileIds } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const zip = await JSZip.loadAsync(zipBuffer);
    const name = slogName(logFileIds[0]!);
    // A WELL-FORMED duplicate of the last entry: it parses and shape-validates,
    // so the bundle still loads and the byte digest is the only thing that
    // notices — which is the characterized hole this check exists to close.
    const lines = (await zip.file(name)!.async('string')).split('\n').filter((l) => l.length > 0);
    zip.file(name, lines.join('\n') + '\n' + lines[lines.length - 1]! + '\n');
    const check = verifyLogBytes(await load(await zip.generateAsync({ type: 'arraybuffer' })));

    expect(check.status).toBe('fail');
    expect(check.detail).toContain('core.autocrlf');
    // States what is established separately from what is merely one reading.
    expect(check.detail).toContain('is not established by this check alone');
    // And says what would settle it.
    expect(check.detail).toContain('check 3');
    expect(check.detail).toContain('.gitattributes');
  });

  it('still says plainly that the archived bytes are not the signed bytes', async () => {
    // Softening the wording must not soften the FINDING. The gap is real.
    const { zipBuffer, logFileIds } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const zip = await JSZip.loadAsync(zipBuffer);
    const name = slogName(logFileIds[0]!);
    // A WELL-FORMED duplicate of the last entry: it parses and shape-validates,
    // so the bundle still loads and the byte digest is the only thing that
    // notices — which is the characterized hole this check exists to close.
    const lines = (await zip.file(name)!.async('string')).split('\n').filter((l) => l.length > 0);
    zip.file(name, lines.join('\n') + '\n' + lines[lines.length - 1]! + '\n');
    const check = verifyLogBytes(await load(await zip.generateAsync({ type: 'arraybuffer' })));

    expect(check.status).toBe('fail');
    expect(check.detail).toContain('Session log bytes do not match the signed manifest');
    expect(check.detail).toContain('The archived bytes are not the bytes that were signed');
  });
});
