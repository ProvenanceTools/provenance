/**
 * Serve the analyzer's "Source" tab from a stored (provenance-only) bundle blob.
 *
 * Student source bytes are no longer stored: ingest strips them from the bundle
 * before persisting it (only the signed manifest + .slog logs remain). So:
 *
 *   - The file LIST + per-file verdicts come from the signed manifest
 *     (submission_files: path/status/sha256) compared against the recorded
 *     on-disk hashes in the event stream. Because the manifest is
 *     signature-verified (validation check 1) and the source bytes were removed
 *     deliberately, we trust the manifest sha256 for present files (loadBundle's
 *     byte-vs-manifest `hashOk` is necessarily false with the bytes gone). This
 *     reproduces the ingest-time verdict for every normal case; the one case it
 *     cannot reproduce — bytes tampered without touching the manifest — is caught
 *     at ingest and recorded in validation_results.check_8_status.
 *
 *   - File CONTENT is reconstructed from the event stream (replay to the end of
 *     the recording), not read from raw bytes. For a `match` verdict this equals
 *     the submitted source; for a `mismatch` it is the recorded final state
 *     (which, by definition, differs from what was submitted). Every response
 *     therefore carries `content_source: 'event_replay'` so the analyzer can say
 *     so on the pane instead of presenting a reconstruction as the submission.
 *
 * CHAIN INTEGRITY COMES FROM THE STORED VALIDATION ROW, not from a live
 * re-run. Per-file verdicts are gated on `chainIntact`, so deriving that gate
 * here with a second `runValidation(bundle)` meant one page load could show the
 * Validation tab's stored `chain_integrity` next to Source badges computed under
 * a different answer — two surfaces contradicting each other about the same
 * fact. CLAUDE.md's rule is that validation runs once at ingest and read paths
 * serve the stored `validation_results` row; the caller passes that row's
 * `chain_integrity` status in. (It also removes a full 8-check validation —
 * ed25519 verify plus a whole-chain re-hash — from every Source tab request.)
 *
 * Retention contract: callers return `available:false` / 404 when the blob is
 * gone (swept by retention). These functions never receive a null buffer.
 */

import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { submittedFileVerdicts } from '@provenance/analysis-core/validation/verify-submitted-code.js';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import { reconstructFileWithProvenance } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { SubmittedFileList, SubmittedFileContent } from '@provenance/shared/api-schemas';

/**
 * Trust the signed manifest sha256 for present submission files.
 *
 * The stored bundle is source-stripped, so loadBundle's `hashOk` (which re-hashes
 * the zip bytes against the manifest) is false for every present file. The
 * manifest is signature-verified, so we set hashOk=true to reproduce the
 * ingest-time verdict (manifest sha vs recorded on-disk hash) instead of a
 * spurious "tampered bundle" mismatch caused solely by the absent bytes.
 */
function trustManifestShas(bundle: Bundle): void {
  for (const entry of bundle.submissionFiles.values()) {
    if (entry.status === 'present') entry.hashOk = true;
  }
}

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
 */
export type StoredValidationGate = { chainIntact: boolean };

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

  const bundle = parsed.value;
  trustManifestShas(bundle);
  const verdicts = submittedFileVerdicts(bundle, { chainIntact: gate.chainIntact });

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

  trustManifestShas(bundle);
  const verdicts = submittedFileVerdicts(bundle, { chainIntact: gate.chainIntact });
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
