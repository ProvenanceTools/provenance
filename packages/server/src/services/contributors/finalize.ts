/**
 * The contributor stage — one entry point, called from both write paths.
 *
 * Ingest (`jobs/worker.ts`) and recompute (`scoring/recompute-submission.ts`)
 * both need the identical three steps in the identical order, and they have
 * drifted apart before: `resolvePerFlag` exists because ingest and recompute
 * disagreed about what a missing config entry meant and the divergence silently
 * erased flags on recompute. One function, called twice, is the only shape that
 * cannot repeat that.
 *
 * ## The order is not arbitrary
 *
 * 1. **`storeContributors`** — stamps the bundle and writes the reconciled
 *    contributor set. Must be first: the other two read what it writes.
 * 2. **`attributeFlags`** — charges each persisted flag to a contributor, or to
 *    nobody. Must be after the stamp (it reads `bundle.contributors`) and after
 *    the flags exist.
 * 3. **`applyContributorScores`** — reads the now-attributed flags and writes
 *    each contributor's score. Must be last.
 *
 * ## Where this sits in the pipeline
 *
 * AFTER `runAndStoreHeuristics`, inside the same transaction. The pipeline
 * order the PRD pins — parse → match → heuristics → cross-flags — is unchanged:
 * this is not a new pipeline stage between two of those, it is bookkeeping that
 * runs once the per-submission heuristics have produced their flags.
 *
 * The placement is also what keeps flag CONTENT identical to before the
 * cut-over. `establishBundleContributors` mutates the bundle, and heuristics
 * read that stamp; stamping earlier would change which flags ingest produces.
 * See `store-contributors.ts` for the full reasoning.
 *
 * Idempotent end to end — every step converges on the same rows, so a pg-boss
 * retry produces identical output.
 */

import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { DrizzleDb } from '../../db/client.js';
import { storeContributors, type ContributorRow } from './store-contributors.js';
import { attributeFlags } from './attribute-flags.js';
import { applyContributorScores, type ContributorScore } from './contributor-scores.js';

export interface FinalizeContributorsResult {
  contributors: ContributorRow[];
  /** How many flags were charged to a person; the rest are scope-level. */
  attributedFlagCount: number;
  scores: ContributorScore[];
}

export async function finalizeContributors(
  db: DrizzleDb,
  submissionId: string,
  semesterId: string,
  bundle: Bundle,
  submitterRosterIds: readonly string[],
): Promise<FinalizeContributorsResult> {
  const contributors = await storeContributors(
    db,
    submissionId,
    semesterId,
    bundle,
    submitterRosterIds,
  );
  const attributedFlagCount = await attributeFlags(db, submissionId, bundle);
  const scores = await applyContributorScores(db, submissionId);

  return { contributors, attributedFlagCount, scores };
}
