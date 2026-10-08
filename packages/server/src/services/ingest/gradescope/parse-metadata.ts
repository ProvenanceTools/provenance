/**
 * Parse a Gradescope `submission_metadata.yml` (Gradescope assignment export).
 *
 * Gradescope writes this file as Ruby-flavoured YAML (Psych): mapping keys are
 * Ruby symbols, so they serialize with a leading colon (`:submitters`, `:sid`,
 * `:name`, `:email`). The top-level keys are the per-submission folder names
 * (e.g. `submission_409194023`) — the same names as the unzipped submission
 * folders in the export. Each submission carries a `:submitters` list (more than
 * one for group projects), plus `:created_at`, `:score`, `:results`, `:history`
 * that we do not need here.
 *
 * We extract only what the ingest path needs: per-submission the folder key and
 * its submitters (sid / name / email). The `sid` is the canonical roster key
 * (analyzer PRD §9.2). Submitters without an sid are dropped (cannot be matched
 * or rostered).
 *
 * Gradescope's autograder output reaches us through Psych's quoted-scalar
 * emitter, which wraps long values across lines and, when the value ends in
 * trailing newlines, writes the closing quote on its own line at column 0. That
 * output is what libyaml reads back, so we parse with js-yaml rather than a
 * strict parser that treats the dedented terminator as a missing one.
 *
 * Pure function — no I/O. The caller reads the file bytes.
 */

// js-yaml (libyaml lineage), NOT the `yaml` package: Psych emits multi-line
// single-quoted scalars whose closing quote lands at column 0, below the parent
// node's indentation (see the autograder-output note above). A spec-strict
// parser rejects that terminator as missing; js-yaml accepts it, as Psych does.
// v4's `loadAll` uses the safe default schema — no `!!js/*` construction.
//
// `loadAll`, not `load`: a real Gradescope export carried a bare `...`
// document-end marker at column 0 mid-file, splitting it into two documents.
// It followed the only submissions whose autograder output Psych writes as a
// keep-chomped `|+` block scalar — consistent with Gradescope concatenating
// per-batch Psych dumps, where libyaml closes an open-ended document with `...`
// and the next batch's mapping continues without a `---`.
import { loadAll as parseYamlStream } from 'js-yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GradescopeSubmitter {
  /** Student identifier — the canonical roster match key. */
  sid: string;
  /** Display name, if present in the metadata. */
  name?: string;
  /** Email, if present in the metadata. */
  email?: string;
}

export interface GradescopeSubmissionMeta {
  /** Metadata key — equals the submission folder name, e.g. "submission_409194023". */
  folderKey: string;
  /** Submitters of this submission (more than one for group projects). */
  submitters: GradescopeSubmitter[];
}

export interface ParsedGradescopeMetadata {
  submissions: GradescopeSubmissionMeta[];
}

export type ParseMetadataResult =
  | { ok: true; value: ParsedGradescopeMetadata }
  | { ok: false; error: 'invalid_yaml' | 'unexpected_shape'; detail: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a Ruby-symbol-or-plain key off an object. Gradescope emits `:submitters`
 * etc.; we also accept the plain `submitters` form for robustness.
 */
function symField(obj: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, `:${key}`)) return obj[`:${key}`];
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  return undefined;
}

/** Coerce a scalar (string | number) to a trimmed non-empty string, else undefined. */
function asString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSubmitters(raw: unknown): GradescopeSubmitter[] {
  if (!Array.isArray(raw)) return [];
  const out: GradescopeSubmitter[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const sid = asString(symField(entry, 'sid'));
    if (sid === undefined) continue; // no sid → cannot match or roster
    const name = asString(symField(entry, 'name'));
    const email = asString(symField(entry, 'email'));
    out.push({
      sid,
      ...(name !== undefined && { name }),
      ...(email !== undefined && { email }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// parseSubmissionMetadata
// ---------------------------------------------------------------------------

/**
 * Parse the YAML text of a `submission_metadata.yml` file.
 *
 * Returns one entry per top-level submission mapping that carries a
 * `:submitters` list. Submissions with an empty/absent submitter list are kept
 * (with `submitters: []`) so the caller can still surface the folder; the caller
 * decides how to treat them (no submitter → cannot match).
 */
export function parseSubmissionMetadata(yamlText: string): ParseMetadataResult {
  let docs: unknown[];
  try {
    docs = parseYamlStream(yamlText);
  } catch (e) {
    return { ok: false, error: 'invalid_yaml', detail: e instanceof Error ? e.message : String(e) };
  }

  // Gradescope can split the file into several documents with a bare `...`
  // (see the stream note above); each is a mapping of submission folders, so
  // merge them. A folder repeated across documents is refused rather than
  // letting one silently overwrite the other — the same stance js-yaml takes on
  // a duplicate key within a single document.
  const nonEmpty = docs.filter((d) => d !== null && d !== undefined);
  if (nonEmpty.length === 0 || !nonEmpty.every(isObject)) {
    return { ok: false, error: 'unexpected_shape', detail: 'top level is not a mapping' };
  }
  const doc: Record<string, unknown> = {};
  for (const part of nonEmpty) {
    for (const [key, value] of Object.entries(part)) {
      if (Object.prototype.hasOwnProperty.call(doc, key)) {
        return {
          ok: false,
          error: 'unexpected_shape',
          detail: `duplicate submission key across documents: ${key}`,
        };
      }
      doc[key] = value;
    }
  }

  const submissions: GradescopeSubmissionMeta[] = [];
  for (const [folderKey, value] of Object.entries(doc)) {
    if (!isObject(value)) continue;
    // A submission entry is one that carries a submitters field.
    const submittersRaw = symField(value, 'submitters');
    if (submittersRaw === undefined) continue;
    submissions.push({ folderKey, submitters: parseSubmitters(submittersRaw) });
  }

  return { ok: true, value: { submissions } };
}
