/**
 * Charge each flag to a contributor — or to nobody.
 *
 * D14 needs a per-contributor score, and a score is only as good as the
 * attribution under it. This module decides, for one persisted flag, whether
 * the evidence establishes a PERSON.
 *
 * ## The rule
 *
 * §6 Rule 2: "a finding names a person only when the evidence is `established`
 * for that person. Otherwise it is a scope-level finding with no name
 * attached."
 *
 * So a flag is charged to a contributor when ALL of its supporting evidence sits
 * in ONE session AND that session resolves to an `attributed` contributor —
 * a chain that was walked and verified. Everything else is scope-level (`''`):
 *
 *  - supporting events spanning more than one session (`flags.session_id` is
 *    already `''` in that case, by the rule `run-per-submission.ts` documents);
 *  - a flag with no supporting events at all — the validation-derived integrity
 *    flags, which are properties of the bundle, not of a person;
 *  - a session that is `unattributed` (no identity block — ordinary and
 *    blameless) or `unverifiable` (a claim that did not verify). Charging an
 *    `unverifiable` session to the contributor it NAMES is exactly how a forged
 *    identity block would move a finding onto an innocent student.
 *
 * ## The error direction is deliberate
 *
 * This UNDER-attributes rather than over-attributes. A multi-session flag
 * earned entirely by one partner is left scope-level, so their per-contributor
 * score is lower than the evidence would strictly support.
 *
 * That asymmetry is the point. Under-attribution costs a partner nothing — the
 * finding is still visible on the submission, at full severity, in the scope
 * roll-up a grader reads. Over-attribution puts a named student's name on a
 * finding the evidence does not tie to them, which is the failure this entire
 * programme is judged against. When the two are not equally cheap, fail toward
 * the harmless one.
 *
 * (The single-contributor case is unaffected either way: `scoreContributors`
 * charges a sole contributor every flag including the scope-level ones, so a
 * solo submission's per-contributor score is exactly its scope score.)
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import { flags } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

/** Scope-level: this finding belongs to the submission and to no one person. */
export const SCOPE_LEVEL = '';

/**
 * The contributor key a session's findings may be charged to, or
 * {@link SCOPE_LEVEL}.
 *
 * Pure, and the single definition of the predicate. `attributed` is the ONLY
 * verdict that names a person — see the header for why `unverifiable` must not.
 */
export function contributorKeyForSession(bundle: Bundle, sessionId: string): string {
  if (sessionId === '') return SCOPE_LEVEL;
  const verdict = bundle.contributors?.bySession.get(sessionId);
  if (verdict === undefined || verdict.kind !== 'attributed') return SCOPE_LEVEL;
  return verdict.contributorKey;
}

/**
 * Write `flags.contributor_key` for every flag of one submission.
 *
 * Runs after the flags are persisted and after the bundle carries its
 * contributor stamp. Idempotent — the mapping is a pure function of the bundle,
 * so a retry writes the same values.
 *
 * @returns the number of flags charged to a contributor (the rest are scope-level).
 */
export async function attributeFlags(
  db: DrizzleDb,
  submissionId: string,
  bundle: Bundle,
): Promise<number> {
  const rows = await db
    .select({ id: flags.id, session_id: flags.session_id })
    .from(flags)
    .where(eq(flags.submission_id, submissionId));

  if (rows.length === 0) return 0;

  // Group flag ids by the key they resolve to, so this is one UPDATE per
  // distinct contributor rather than one per flag.
  const byKey = new Map<string, string[]>();
  for (const row of rows) {
    const key = contributorKeyForSession(bundle, row.session_id);
    if (key === SCOPE_LEVEL) continue;
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [row.id]);
    else bucket.push(row.id);
  }

  let attributed = 0;
  for (const [key, ids] of byKey) {
    await db
      .update(flags)
      .set({ contributor_key: key })
      .where(and(eq(flags.submission_id, submissionId), inArray(flags.id, ids)));
    attributed += ids.length;
  }

  // Anything not in `byKey` must be reset to scope-level rather than left at
  // whatever a previous run wrote. A recompute that narrows attribution (a
  // contributor whose identity no longer verifies, say) must not leave a stale
  // name on a finding.
  const attributedIds = new Set([...byKey.values()].flat());
  const scopeIds = rows.map((r) => r.id).filter((id) => !attributedIds.has(id));
  if (scopeIds.length > 0) {
    await db
      .update(flags)
      .set({ contributor_key: SCOPE_LEVEL })
      .where(and(eq(flags.submission_id, submissionId), inArray(flags.id, scopeIds)));
  }

  return attributed;
}
