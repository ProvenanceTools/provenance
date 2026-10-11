/**
 * Persisted submitted-file shas — what check 8 needs to be re-run faithfully
 * against a source-stripped stored bundle.
 *
 * Ingest strips the student's source files before storing the bundle (see
 * `strip-bundle.ts`). Check 8 (`submitted_code_match`) compares what was
 * SUBMITTED against the recording, so a re-run on the stripped copy — every
 * recompute, and the Source tab — has lost half of its evidence. The fix is to
 * record, at ingest, the sha256 of each submitted file's ACTUAL bytes
 * (`computeSubmittedShas` on the bundle loaded WITH its source) and pass that
 * record back as `submittedShas` on every re-run. analysis-core then reaches the
 * same per-file verdict on the stripped copy as it did at ingest, for every seal
 * kind (see `verify-submitted-code.ts`).
 *
 * WHERE IT LIVES. No migration: the record is stored inside the existing
 * `validation_results.detail` jsonb, which holds the 8-entry `ValidationCheck[]`
 * array, as a `submitted_shas: { [path]: sha256 }` field ON the
 * `submitted_code_match` entry. Every read and write of that field goes through
 * this module, and every API reader of `detail` strips it
 * ({@link stripSubmittedShas}) — it is internal evidence, not part of the
 * HTTP contract.
 *
 * ABSENT vs EMPTY. `{}` is a real record: ingest saw the bytes and no submitted
 * file was present. ABSENT (no field) means nobody recorded it — every row
 * ingested before this field existed. The two must stay distinguishable: the
 * re-upload refresh keys off absence.
 *
 * MALFORMED IS ABSENT. A record that is not a plain object of non-empty path
 * keys to lowercase 64-hex values is treated as absent as a whole. Absent shas
 * make a stripped re-run read `unknown` (check skipped, no flag), never
 * `mismatch` — so a corrupted record can only cost a verdict, never invent an
 * accusation.
 */

import { eq } from 'drizzle-orm';
import type { SubmittedShas } from '@provenance/analysis-core/validation/verify-submitted-code.js';
import type { ValidationCheck } from '@provenance/analysis-core/validation/check-types.js';
import { validation_results } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

export type { SubmittedShas };

/** The jsonb field name on the stored check-8 entry. */
export const SUBMITTED_SHAS_FIELD = 'submitted_shas';

const CHECK_8_ID = 'submitted_code_match';
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A stored check entry: a `ValidationCheck`, plus the shas on check 8 only. */
export type StoredValidationCheck = ValidationCheck & {
  [SUBMITTED_SHAS_FIELD]?: Record<string, string>;
};

/**
 * Return a copy of `checks` whose `submitted_code_match` entry carries `shas`.
 * Every other entry is passed through unchanged; the input is not mutated.
 */
export function attachSubmittedShas(
  checks: readonly ValidationCheck[],
  shas: SubmittedShas,
): StoredValidationCheck[] {
  return checks.map((c) =>
    c.id === CHECK_8_ID ? { ...c, [SUBMITTED_SHAS_FIELD]: { ...shas } } : c,
  );
}

/**
 * Read the persisted shas back out of a stored `validation_results.detail`
 * value. `undefined` when absent OR malformed (see the module docstring).
 */
export function readSubmittedShas(detail: unknown): SubmittedShas | undefined {
  if (!Array.isArray(detail)) return undefined;
  const entry: unknown = detail.find(
    (c: unknown) => isPlainObject(c) && (c as { id?: unknown }).id === CHECK_8_ID,
  );
  if (!isPlainObject(entry)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(entry, SUBMITTED_SHAS_FIELD)) return undefined;
  const raw: unknown = (entry as Record<string, unknown>)[SUBMITTED_SHAS_FIELD];
  if (!isPlainObject(raw)) return undefined;

  const out: Record<string, string> = {};
  for (const [path, sha] of Object.entries(raw)) {
    if (path.length === 0 || typeof sha !== 'string' || !SHA256_HEX.test(sha)) return undefined;
    out[path] = sha;
  }
  return out;
}

/**
 * Remove the persisted shas from a stored checks array before it leaves the
 * server. Returns new objects for any entry that carried the field, so the
 * caller's value is not mutated. Non-object entries pass through.
 */
export function stripSubmittedShas<T>(checks: readonly T[]): T[] {
  return checks.map((c) => {
    if (!isPlainObject(c) || !Object.prototype.hasOwnProperty.call(c, SUBMITTED_SHAS_FIELD)) {
      return c;
    }
    const { [SUBMITTED_SHAS_FIELD]: _omitted, ...rest } = c as Record<string, unknown>;
    void _omitted;
    return rest as T;
  });
}

/**
 * The persisted shas for one submission, read from its `validation_results`
 * row. `undefined` when there is no row, or the row carries none (or a
 * malformed record).
 */
export async function loadStoredSubmittedShas(
  db: DrizzleDb,
  submissionId: string,
): Promise<SubmittedShas | undefined> {
  const rows = await db
    .select({ detail: validation_results.detail })
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId))
    .limit(1);
  return rows.length === 0 ? undefined : readSubmittedShas(rows[0]!.detail);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
