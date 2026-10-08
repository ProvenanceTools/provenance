/**
 * paste_matches_known_source heuristic (Phase 16).
 *
 * PRD §7.4 process-shape + PRD §10 Q4.
 *
 * Accepts a course-staff-supplied corpus of known sources. For each paste event,
 * attempts to match against each corpus entry in two ways:
 *
 *   1. Exact hash match: if the paste's `sha256` field matches any hash in the
 *      entry's `hashes` array → high-severity flag (confidence 0.95).
 *
 *   2. Fuzzy line match: if the paste has an inline `content` field AND any
 *      element of the entry's `fuzzy_lines` array shares ≥ fuzzyThreshold
 *      (default: 0.7) of its lines with the paste content → medium-severity
 *      flag (confidence 0.8).
 *
 * When no corpus is provided (empty array), the heuristic emits 0 flags.
 * When the corpus is malformed (invalid shape), the loader function returns a
 * typed error; the caller can log it. The heuristic itself only receives
 * validated KnownSource[].
 *
 * Corpus format:
 *   KnownSource = {
 *     name: string;
 *     hashes: string[];          // SHA-256 hex strings; exact match → high
 *     fuzzy_lines?: string[][];  // text blocks; line-ratio match → medium
 *   }
 *
 * The corpus is passed via `config.pasteMatchesKnownSource.corpus`. Loading
 * from disk is not applicable (the analyzer is an offline browser app). Course
 * staff populates the corpus via config before running heuristics.
 *
 * PRD §10 Q4 (open question): the corpus CONTENT is course-staff's call. This
 * module ships the MECHANISM; the corpus entries are out of scope for Phase 16.
 */

import { diffLines } from 'diff';
import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig, KnownSource } from './config.js';
import { reviewedPathPredicate } from './reviewed-scope.js';
import { iterateCandidatePastes, sha256OfCandidate } from './candidate-pastes.js';

// ---------------------------------------------------------------------------
// Corpus loader
// ---------------------------------------------------------------------------

export type CorpusError = {
  kind: 'corpus_error';
  message: string;
  /** 0-based index of the malformed entry, or undefined for top-level errors. */
  entryIndex?: number;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: CorpusError };

/**
 * Validate and parse a JSON value as KnownSource[].
 *
 * Accepts the raw `unknown` value (typically from `JSON.parse`). Returns
 * `Ok<KnownSource[]>` if valid, or `Err<CorpusError>` if the shape is wrong.
 *
 * Shape rules:
 *   - Top level must be an array.
 *   - Each element must be an object with:
 *       - `name`: string (required)
 *       - `hashes`: string[] (required; entries must be strings)
 *       - `fuzzy_lines`: string[][] (optional; if present, elements must be string[])
 *
 * Extra keys are ignored (forward-compatible).
 */
export function loadKnownSourceCorpus(json: unknown): Result<KnownSource[]> {
  if (!Array.isArray(json)) {
    return {
      ok: false,
      error: { kind: 'corpus_error', message: 'Corpus must be a JSON array at the top level.' },
    };
  }

  const sources: KnownSource[] = [];

  for (let i = 0; i < json.length; i++) {
    const entry = json[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return {
        ok: false,
        error: {
          kind: 'corpus_error',
          message: `Entry ${i} is not an object.`,
          entryIndex: i,
        },
      };
    }

    const e = entry as Record<string, unknown>;

    if (typeof e['name'] !== 'string') {
      return {
        ok: false,
        error: {
          kind: 'corpus_error',
          message: `Entry ${i} is missing a valid 'name' string field.`,
          entryIndex: i,
        },
      };
    }

    if (!Array.isArray(e['hashes'])) {
      return {
        ok: false,
        error: {
          kind: 'corpus_error',
          message: `Entry ${i} is missing a valid 'hashes' array field.`,
          entryIndex: i,
        },
      };
    }

    for (let h = 0; h < (e['hashes'] as unknown[]).length; h++) {
      if (typeof (e['hashes'] as unknown[])[h] !== 'string') {
        return {
          ok: false,
          error: {
            kind: 'corpus_error',
            message: `Entry ${i}.hashes[${h}] is not a string.`,
            entryIndex: i,
          },
        };
      }
    }

    const fuzzyLines = e['fuzzy_lines'];
    if (fuzzyLines !== undefined) {
      if (!Array.isArray(fuzzyLines)) {
        return {
          ok: false,
          error: {
            kind: 'corpus_error',
            message: `Entry ${i}.fuzzy_lines must be an array if present.`,
            entryIndex: i,
          },
        };
      }

      for (let b = 0; b < (fuzzyLines as unknown[]).length; b++) {
        const block = (fuzzyLines as unknown[])[b];
        if (!Array.isArray(block)) {
          return {
            ok: false,
            error: {
              kind: 'corpus_error',
              message: `Entry ${i}.fuzzy_lines[${b}] must be a string[].`,
              entryIndex: i,
            },
          };
        }
        for (let l = 0; l < (block as unknown[]).length; l++) {
          if (typeof (block as unknown[])[l] !== 'string') {
            return {
              ok: false,
              error: {
                kind: 'corpus_error',
                message: `Entry ${i}.fuzzy_lines[${b}][${l}] is not a string.`,
                entryIndex: i,
              },
            };
          }
        }
      }
    }

    const source: KnownSource = {
      name: e['name'] as string,
      hashes: e['hashes'] as string[],
    };
    if (fuzzyLines !== undefined) {
      source.fuzzy_lines = fuzzyLines as string[][];
    }
    sources.push(source);
  }

  return { ok: true, value: sources };
}

// ---------------------------------------------------------------------------
// Fuzzy line matching helpers
// ---------------------------------------------------------------------------

/**
 * Compute the ratio of shared lines between pasteContent and a reference
 * text (a single fuzzy_lines block joined with '\n').
 * Returns shared_lines / max(paste_lines, ref_lines).
 */
function fuzzyLineRatio(pasteContent: string, referenceLines: string[]): number {
  if (pasteContent.length === 0 || referenceLines.length === 0) return 0;
  const referenceText = referenceLines.join('\n');
  const parts = diffLines(pasteContent, referenceText);
  let shared = 0;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      shared += part.count ?? 0;
    }
  }
  const pasteLineCount = pasteContent.split('\n').length;
  const refLineCount = referenceLines.length;
  return shared / Math.max(pasteLineCount, refLineCount);
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function flagId(kind: 'hash' | 'fuzzy', seqKey: string, entryName: string, idx: number): string {
  return `paste_matches_known_source-${kind}-${seqKey}-${idx}-${entryName.slice(0, 20).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { corpus, fuzzyThreshold } = config.pasteMatchesKnownSource;

  // When no corpus is provided, emit 0 flags.
  if (corpus.length === 0) return [];

  const flags: Flag[] = [];
  let flagIndex = 0;

  // Iterate paste-shaped candidates from both `paste` events and recorder-v1.2
  // `doc.change` events with `source: 'paste_likely' | 'paste_confirmed'`.
  // For doc.change-derived candidates we compute the sha256 lazily (recorder
  // doesn't pre-compute it for delta text).
  for (const c of iterateCandidatePastes(index, reviewedPathPredicate(bundle))) {
    const pasteSha256 = sha256OfCandidate(c);
    const pasteContent = c.content;
    const filePath = c.path;
    const seqKey = c.seqKey;
    const sourceLabel = c.origin === 'paste' ? 'paste' : 'paste-shaped bulk edit';

    for (const entry of corpus) {
      // -----------------------------------------------------------------------
      // 1. Exact hash match (high severity, confidence 0.95)
      // -----------------------------------------------------------------------
      if (pasteSha256 !== undefined && entry.hashes.includes(pasteSha256)) {
        const id = flagId('hash', seqKey, entry.name, flagIndex++);
        flags.push({
          id,
          heuristic: 'paste_matches_known_source',
          title: `Paste matches known source: ${entry.name}`,
          severity: 'high',
          confidence: 0.95,
          supportingSeqs: [seqKey],
          description:
            `A ${sourceLabel} in ${filePath} has a SHA-256 hash that exactly matches the known ` +
            `source "${entry.name}". This indicates the inserted content is identical to a ` +
            `course-known solution or reference material.`,
          detail: {
            filePath,
            sourceName: entry.name,
            matchKind: 'hash_exact',
            pasteSha256,
            origin: c.origin,
          },
        });
        // Hash match is definitive; skip fuzzy check for same entry.
        continue;
      }

      // -----------------------------------------------------------------------
      // 2. Fuzzy line match (medium severity, confidence 0.8)
      // -----------------------------------------------------------------------
      if (pasteContent !== undefined && entry.fuzzy_lines !== undefined) {
        for (const referenceBlock of entry.fuzzy_lines) {
          const ratio = fuzzyLineRatio(pasteContent, referenceBlock);
          if (ratio >= fuzzyThreshold) {
            const id = flagId('fuzzy', seqKey, entry.name, flagIndex++);
            flags.push({
              id,
              heuristic: 'paste_matches_known_source',
              title: `Paste fuzzy-matches known source: ${entry.name}`,
              severity: 'medium',
              confidence: 0.8,
              supportingSeqs: [seqKey],
              description:
                `A ${sourceLabel} in ${filePath} shares ${Math.round(ratio * 100)}% of its lines ` +
                `with a block in the known source "${entry.name}".`,
              detail: {
                filePath,
                sourceName: entry.name,
                matchKind: 'fuzzy_lines',
                lineRatio: ratio,
                fuzzyThreshold,
                origin: c.origin,
              },
            });
            // Stop checking other blocks for this entry once a match is found.
            break;
          }
        }
      }
    }
  }

  return flags;
}

export const pasteMatchesKnownSourceHeuristic: Heuristic = {
  id: 'paste_matches_known_source',
  label: 'Paste matches known source',
  run,
};
