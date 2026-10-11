/**
 * Serve the analyzer's "Source" tab from a stored (provenance-only) bundle blob.
 *
 * Student source bytes are no longer stored: ingest strips them from the bundle
 * before persisting it (only the signed manifest + .slog logs remain). So:
 *
 *   - The file LIST + per-file verdicts come from check 8's
 *     `submittedFileVerdicts` over the stored bundle, fed the sha256 of each
 *     submitted file's bytes that ingest persisted before stripping
 *     (services/ingest/submitted-shas.ts). With those, the verdicts reproduce
 *     the ingest-time ones for every seal kind — including a tampered bundle,
 *     whose recorded shas disagree with its signed manifest. For a row ingested
 *     before the shas were recorded, analysis-core falls back to the signed
 *     manifest sha where it is a commitment, and says `unknown` where it is not
 *     (a provisional rolling seal) — never `mismatch` from missing evidence.
 *
 *   - File CONTENT is reconstructed from the event stream (replay to the end of
 *     the recording), not read from raw bytes. For a `match` verdict this equals
 *     the submitted source; for a `mismatch` it is the recorded final state
 *     (which, by definition, differs from what was submitted). Every response
 *     therefore carries `content_source: 'event_replay'` so the analyzer can say
 *     so on the pane instead of presenting a reconstruction as the submission.
 *
 * THE GATE COMES FROM THE STORED VALIDATION ROW, not from a live re-run.
 * Per-file verdicts are gated on `chainIntact`, so deriving that gate here with
 * a second `runValidation(bundle)` meant one page load could show the
 * Validation tab's stored `chain_integrity` next to Source badges computed
 * under a different answer — two surfaces contradicting each other about the
 * same fact. The caller passes that row's `chain_integrity` status and its
 * persisted submitted shas in (`getStoredSourceGate`). (It also removes a full
 * 8-check validation — ed25519 verify plus a whole-chain re-hash — from every
 * Source tab request.)
 *
 * Retention contract: callers return `available:false` / 404 when the blob is
 * gone (swept by retention). These functions never receive a null buffer.
 */

import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { submittedFileVerdicts } from '@provenance/analysis-core/validation/verify-submitted-code.js';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import { reconstructFileWithProvenance } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import type { SubmittedShas } from '@provenance/analysis-core/validation/verify-submitted-code.js';
import type { SubmittedFileList, SubmittedFileContent } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// extractSubmittedFiles
// ---------------------------------------------------------------------------

/**
 * The stored-validation gate these functions need.
 *
 * `chainIntact` is the ingest-time `chain_integrity` check status, read from
 * `validation_results` by the caller. False when the check did not pass OR when
 * no validation row exists — every per-file verdict then comes back `unknown`,
 * which is the honest answer: with no established chain we cannot say whether
 * the recorded hashes mean anything.
 *
 * `submittedShas` is the record ingest persisted from the submitted bytes;
 * absent for rows ingested before it existed.
 */
export type StoredValidationGate = { chainIntact: boolean; submittedShas?: SubmittedShas };

function verdictOptions(gate: StoredValidationGate): {
  chainIntact: boolean;
  submittedShas?: SubmittedShas;
} {
  return {
    chainIntact: gate.chainIntact,
    ...(gate.submittedShas !== undefined ? { submittedShas: gate.submittedShas } : {}),
  };
}

/**
 * Parse `blob` and return per-file verdicts for the Source tab file list.
 *
 * Returns `{ available: true, files: [] }` when the bundle fails to parse or is
 * format 1.0 (no submission_files in the manifest).
 */
export async function extractSubmittedFiles(
  blob: ArrayBuffer,
  gate: StoredValidationGate,
): Promise<SubmittedFileList> {
  const parsed = await loadBundle(blob, 'bundle.zip');
  if (!parsed.ok) return { available: true, files: [] };

  const verdicts = submittedFileVerdicts(parsed.value, verdictOptions(gate));

  return {
    available: true,
    files: verdicts.map((v) => ({
      path: v.path,
      status: v.status,
      verdict: v.verdict,
      sha256: v.submittedSha,
    })),
  };
}

// ---------------------------------------------------------------------------
// extractSubmittedFileContent
// ---------------------------------------------------------------------------

/**
 * Parse `blob` and return the reconstructed content + verdict for `path`.
 *
 * Returns `null` when the bundle fails to parse, the path is not listed in the
 * manifest's submission_files, or the file was 'missing' at seal time.
 */
export async function extractSubmittedFileContent(
  blob: ArrayBuffer,
  path: string,
  gate: StoredValidationGate,
): Promise<SubmittedFileContent | null> {
  const parsed = await loadBundle(blob, 'bundle.zip');
  if (!parsed.ok) return null;

  const bundle = parsed.value;
  const entry = bundle.submissionFiles.get(path);
  if (entry === undefined) return null;
  if (entry.status === 'missing') return null;

  const verdicts = submittedFileVerdicts(bundle, verdictOptions(gate));
  const v = verdicts.find((x) => x.path === path);

  // Content is reconstructed from the event stream (replay to the end), since the
  // raw source bytes are no longer stored. `content_source` carries that fact to
  // the analyzer, which must not render this as "the submitted code" — least of
  // all under a `mismatch` verdict, where it is provably not.
  const index = buildIndex(bundle);
  const content = reconstructFileWithProvenance(index, path).content;

  return {
    path,
    content,
    status: entry.status,
    verdict: v?.verdict ?? 'unknown',
    content_source: 'event_replay',
  };
}
