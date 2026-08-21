/**
 * The `.gitattributes` every recorder writes into `.provenance/`.
 *
 * ## Why this file has to exist
 *
 * A `.slog` is newline-delimited JSON. Nothing tells git it is anything but
 * text, so git applies its end-of-line filters to it — and those filters are not
 * byte-preserving. Under a repository `.gitattributes` carrying
 * `* text=auto eol=crlf`, under `core.eol=crlf`, or under `core.autocrlf=true`
 * on the machine that materializes the working tree, every LF the recorder wrote
 * comes back as CRLF.
 *
 * Every file in `.provenance/` is covered by an ed25519 signature over its exact
 * sha256. Change one byte and the signed digest no longer matches. The git
 * submission path has no seal step — the student pushes, the grader clones, and
 * whatever sits in `.provenance/` **in the delivered working tree** is the
 * submission — so there is nothing downstream to re-hash the widened bytes and
 * notice. The analyzer's `log_bytes_match` sees a `.slog` that does not hash to
 * the value the signed manifest commits to, and that is the strongest signal the
 * system produces: high severity, confidence 1.0.
 *
 * It is also the worst-shaped one. `parseEntries` splits on `'\n'`, leaving a
 * trailing `'\r'` that `JSON.parse` accepts as insignificant whitespace, so
 * every entry parses to the identical object: the hash chain verifies, the
 * signed checkpoints verify, the manifest signature verifies, and seven of the
 * eight PRD §5.4 checks pass. Only the byte digest fails — which makes an
 * artifact of `git clone` read like a surgical, deliberate edit.
 *
 * ## Why prevention here is the fix, and the reader-side check is not
 *
 * The analyzer can recognize ONE direction after the fact: sealed LF, archived
 * CRLF, undone by rewriting `\r\n` to `\n` and re-hashing. The other direction
 * cannot be recovered by any amount of hashing. The rolling-seal writer hashes
 * each log **by re-reading it from disk**, so a `git checkout` that
 * re-materializes a committed `.slog` mid-session leaves the recorder signing
 * over already-widened bytes — and git's clean filter then normalizes the
 * committed blob back to LF, so the archive is narrower than the seal. A log
 * smudged mid-session and then appended to is narrower still in one region and
 * wider in another. Undoing either would mean guessing which of `n` terminators
 * were wide: a `2^n` search.
 *
 * So this file is the only complete fix. It stops the translation at the source,
 * which is the only place the bytes can still be protected rather than
 * reconstructed.
 *
 * ## Why the content is `* -text`
 *
 * Attribute lookup walks from the file's own directory upward, and a
 * `.gitattributes` in a DEEPER directory wins over one at the repository root.
 * So `.provenance/.gitattributes` overrides a course skeleton's
 * `* text=auto eol=crlf` for exactly this directory and changes nothing outside
 * it. Verified against real `git clone`, both with a conflicting root attribute
 * and with `core.autocrlf=true`.
 *
 * The pattern is `*` rather than a list of extensions on purpose: every file in
 * `.provenance/` is a signed or digested artifact, none of them benefits from
 * end-of-line translation, and a future artifact type is covered without a
 * fourth repository having to be updated.
 *
 * `-text` and not `binary`: `binary` is the macro for `-diff -merge -text`, and
 * while `-merge` is arguably right for an add-only shared directory (a textual
 * merge of two `.slog` versions would splice conflict markers into a signed
 * log), turning it on changes how merge conflicts surface for students and is a
 * separate decision from fixing the digests. `-text` is the whole of the fix.
 */

/** The filename, as git requires it. */
export const PROVENANCE_GITATTRIBUTES_FILENAME = '.gitattributes';

/**
 * The exact bytes every recorder writes.
 *
 * Pinned here rather than re-spelled in each recorder so provjet and provnvim
 * cannot drift, and so a conformance test can assert the byte string. The
 * comment block is deliberate: students read this repository (recorder PRD §6),
 * and a bare `* -text` with no explanation is the kind of line somebody deletes
 * while tidying.
 */
export const PROVENANCE_GITATTRIBUTES_CONTENT = `# Provenance — do not let git rewrite these bytes.
#
# Every file in this directory is covered by a signature over its exact sha256.
# Git's end-of-line filters (core.autocrlf, core.eol, "text=auto") rewrite LF to
# CRLF when a file is checked out. That changes these bytes, and an untouched log
# then looks modified to the analyzer.
#
# "-text" turns that translation off for this directory only. It overrides any
# text/eol attribute set at the repository root, because attributes in a deeper
# directory take precedence.
#
# Do not delete this file, and do not add text or eol attributes to it.
* -text
`;

/**
 * Does an EXISTING `.gitattributes` appear to protect this directory's bytes?
 *
 * A deliberately shallow check, and not a git attribute parser. The recorder
 * must never overwrite a file it did not write — in a shared repository that
 * file may be a partner's or the course's — so the only thing this decides is
 * whether to warn. Answering "yes" wrongly costs a missing warning; answering
 * "no" wrongly costs a spurious one. Neither touches the student's file.
 *
 * Accepts either `-text` or the `binary` macro (which expands to include
 * `-text`), on any line that is not a comment.
 */
export function looksLikeItDisablesEolTranslation(contents: string): boolean {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .some((line) => /(^|\s)(-text|binary)(\s|$)/.test(line));
}
