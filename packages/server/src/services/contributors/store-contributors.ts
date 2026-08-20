/**
 * Write `submission_contributors` — who a submission is attributable to.
 *
 * D9 (`docs/superpowers/specs/2026-08-19-program-decision-log.md`), parent spec
 * §7. This is the write half of the cut-over that replaced the fan-out in which
 * one group bundle became N `submissions` rows with N duplicated blobs.
 *
 * ## Two sources, reconciled onto one row per human
 *
 *  - the ROSTER side — whoever the filename match or the Gradescope `match_sid`
 *    named. Named, but says nothing about who recorded.
 *  - the BUNDLE side — `analysis-core`'s `establishBundleContributors`, which
 *    groups sessions on the verified `student_ref`. The only side that can
 *    attribute a FINDING to a person.
 *
 * A co-submitter who also recorded arrives from BOTH. Writing them twice would
 * not merely duplicate a name — it would SPLIT THEIR SCORE across two apparent
 * people, so a partner who earned every flag in the bundle could read as two
 * contributors with half the score each. {@link reconcileContributors} merges
 * on `roster_entry_id`, and the partial unique index
 * `submission_contributors_person_key` makes the unmerged shape unrepresentable
 * even if this function were wrong.
 *
 * ## What deliberately gets NO row
 *
 * `unattributed` sessions — no identity block at all, which is the ORDINARY and
 * blameless state for almost every bundle in existence today. `analysis-core`
 * gives each such session a SINGLETON contributor key precisely because two of
 * them are neither provably one person nor provably two. Emitting a row per
 * session would turn an ordinary five-session solo bundle into five apparent
 * contributors — a fabricated relationship, and the exact error
 * `identity/types.ts` exists to prevent. It would also break the property that
 * makes this whole cut-over safe: that a solo submission has exactly one
 * contributor and therefore reads identically to how it read before.
 *
 * `unverifiable` sessions — an identity block that is PRESENT and does not
 * verify. That is a claim the artifact cannot back, it is already a finding in
 * its own right, and promoting it into the roster-facing attribution surface is
 * precisely how a forged identity block would launder work onto the innocent
 * student it names. `identity/types.ts`: "It is NEVER merged into the
 * contributor it names."
 *
 * ## Ordering: this runs AFTER heuristics, on purpose
 *
 * `establishBundleContributors` MUTATES the bundle (it stamps the verdict), and
 * several heuristics read that stamp — `multiple_sessions_overlap` through
 * `compareContributors`, the external-change reclassification through the
 * collaborative-scope gate. The ingest path has never stamped it, so ingest-time
 * heuristics run against a fully-`unattributed` bundle.
 *
 * Stamping BEFORE heuristics would therefore change which flags ingest produces
 * for bundles that carry identity — a product behaviour change, and not one
 * this change was asked to make. So the stamp happens here, after
 * `runAndStoreHeuristics` has already run and returned, and flag CONTENT is
 * provably untouched. (The pre-existing divergence between ingest-time and
 * recompute-time heuristic input is noted in the decision log; it is not
 * introduced or widened here.)
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { establishBundleContributors } from '@provenance/analysis-core/identity/resolve-contributors.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { Contributor } from '@provenance/analysis-core/identity/types.js';
import { roster_entries, student_refs, submission_contributors } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { rootPublicKeyHexIfConfigured } from '../../config/root-key.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One reconciled contributor, ready to be written. */
export interface ContributorRow {
  contributor_key: string;
  kind: 'roster' | 'attributed';
  roster_entry_id: string | null;
  student_ref: string | null;
  student_pubkey: string | null;
  session_count: number;
  first_seen: Date | null;
  last_seen: Date | null;
  is_submitter: boolean;
}

/** A bundle-side contributor with its roster link already resolved. */
export interface ResolvedBundleContributor {
  contributor: Contributor;
  /** The roster row this contributor's `student_ref` maps to, if any (D13). */
  rosterEntryId: string | null;
  sessionCount: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
  studentPubkey: string | null;
}

/** The roster-side key namespace. Kept here so there is one spelling. */
export function rosterContributorKey(rosterEntryId: string): string {
  return `roster:${rosterEntryId}`;
}

// ---------------------------------------------------------------------------
// Reconciliation — pure, so it is testable without a database
// ---------------------------------------------------------------------------

/**
 * Merge the roster side and the bundle side into one row per person.
 *
 * A bundle contributor that resolves to a roster entry ABSORBS that entry: the
 * resulting row carries the attributed key (so findings can be charged to it)
 * and `is_submitter` true (so the roster fact is not lost). A submitter with no
 * matching bundle contributor gets a `'roster'` row. A bundle contributor with
 * no roster match keeps `roster_entry_id` null — D13's `unattributed`
 * presentation, which is an administrative gap and never an integrity signal.
 *
 * Pure and deterministic: the output order is bundle contributors in
 * first-appearance order, then unabsorbed submitters in the order given. Ingest
 * idempotency depends on this — a retry must produce the identical row set.
 */
export function reconcileContributors(
  bundleContributors: readonly ResolvedBundleContributor[],
  submitterRosterIds: readonly string[],
): ContributorRow[] {
  const absorbed = new Set<string>();
  const rows: ContributorRow[] = [];

  for (const resolved of bundleContributors) {
    const { contributor, rosterEntryId } = resolved;
    // Only `attributed` contributors are representable here; the caller filters,
    // but assert the invariant rather than trusting it — a singleton
    // `unattributed` key reaching the table would fabricate a contributor.
    if (contributor.kind !== 'attributed' || contributor.studentRef === null) continue;

    let isSubmitter = false;
    if (rosterEntryId !== null && submitterRosterIds.includes(rosterEntryId)) {
      absorbed.add(rosterEntryId);
      isSubmitter = true;
    }

    rows.push({
      contributor_key: contributor.key,
      kind: 'attributed',
      roster_entry_id: rosterEntryId,
      student_ref: contributor.studentRef,
      student_pubkey: resolved.studentPubkey,
      session_count: resolved.sessionCount,
      first_seen: resolved.firstSeen,
      last_seen: resolved.lastSeen,
      is_submitter: isSubmitter,
    });
  }

  // De-duplicate the submitter list without reordering it: the same roster
  // entry can be named twice (two uploads of one group export), and two rows
  // for one human is the failure the partial unique index exists to catch.
  const seenSubmitters = new Set<string>();
  for (const rosterEntryId of submitterRosterIds) {
    if (absorbed.has(rosterEntryId) || seenSubmitters.has(rosterEntryId)) continue;
    seenSubmitters.add(rosterEntryId);
    rows.push({
      contributor_key: rosterContributorKey(rosterEntryId),
      kind: 'roster',
      roster_entry_id: rosterEntryId,
      student_ref: null,
      student_pubkey: null,
      session_count: 0,
      first_seen: null,
      last_seen: null,
      is_submitter: true,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Bundle-side resolution
// ---------------------------------------------------------------------------

/**
 * Parse an ISO wall-clock string into a Date, or null when it is unusable.
 *
 * `wall` is student-clock material and is never trusted for ordering (that is
 * what `t` and the chain are for). Here it is only coverage detail — "when did
 * this person record" — so a malformed value degrades to null rather than
 * throwing and failing an ingest.
 */
function parseWall(wall: string | undefined): Date | null {
  if (wall === undefined) return null;
  const d = new Date(wall);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve each `attributed` contributor's roster link and coverage detail.
 *
 * Two ref namespaces, both supported forever (archived 2.0 bundles must resolve
 * years later — parent spec §9):
 *
 *  - **2.1, institution-scoped**: the ref is a global `students.student_ref`;
 *    the roster link lives on `roster_entries.student_ref` for this semester.
 *  - **2.0, course-scoped**: the ref is a per-semester `student_refs.student_ref`
 *    which carries `roster_entry_id` directly.
 *
 * Both lookups are SEMESTER-SCOPED. A ref that belongs to a different semester
 * must not resolve to that semester's roster row — that would attribute this
 * submission to a person who is not in this cohort.
 */
export async function resolveBundleContributors(
  db: DrizzleDb,
  semesterId: string,
  bundle: Bundle,
): Promise<ResolvedBundleContributor[]> {
  const stamp = bundle.contributors;
  if (stamp === undefined) return [];

  const attributed = stamp.contributors.filter(
    (c): c is Contributor & { studentRef: string } =>
      c.kind === 'attributed' && c.studentRef !== null,
  );
  if (attributed.length === 0) return [];

  const refs = [...new Set(attributed.map((c) => c.studentRef))];

  // 2.1 — roster rows linked to a global student_ref, in THIS semester.
  const institutionRows = await db
    .select({ ref: roster_entries.student_ref, id: roster_entries.id })
    .from(roster_entries)
    .where(
      and(eq(roster_entries.semester_id, semesterId), inArray(roster_entries.student_ref, refs)),
    );
  const byInstitutionRef = new Map<string, string>();
  for (const r of institutionRows) {
    if (r.ref !== null) byInstitutionRef.set(r.ref, r.id);
  }

  // 2.0 — archived per-semester refs carrying the roster link directly.
  const courseRows = await db
    .select({ ref: student_refs.student_ref, id: student_refs.roster_entry_id })
    .from(student_refs)
    .where(and(eq(student_refs.semester_id, semesterId), inArray(student_refs.student_ref, refs)));
  const byCourseRef = new Map<string, string>();
  for (const r of courseRows) {
    if (r.id !== null) byCourseRef.set(r.ref, r.id);
  }

  const sessionById = new Map(bundle.sessions.map((s) => [s.sessionId, s]));

  return attributed.map((contributor) => {
    const rosterEntryId =
      (contributor.scope === 'institution'
        ? byInstitutionRef.get(contributor.studentRef)
        : byCourseRef.get(contributor.studentRef)) ?? null;

    let firstSeen: Date | null = null;
    let lastSeen: Date | null = null;
    let studentPubkey: string | null = null;

    for (const sessionId of contributor.sessionIds) {
      const session = sessionById.get(sessionId);
      if (session === undefined) continue;

      const start = parseWall(session.firstEvent.wall);
      const lastEvent = session.events[session.events.length - 1];
      const end = parseWall(lastEvent?.wall) ?? start;

      if (start !== null && (firstSeen === null || start < firstSeen)) firstSeen = start;
      if (end !== null && (lastSeen === null || end > lastSeen)) lastSeen = end;

      if (studentPubkey === null) {
        const sessionVerdict = stamp.bySession.get(sessionId);
        if (sessionVerdict?.kind === 'attributed') studentPubkey = sessionVerdict.studentPubkey;
      }
    }

    return {
      contributor,
      rosterEntryId,
      sessionCount: contributor.sessionIds.length,
      firstSeen,
      lastSeen,
      studentPubkey,
    };
  });
}

// ---------------------------------------------------------------------------
// storeContributors
// ---------------------------------------------------------------------------

/**
 * Stamp the bundle's contributors and write the reconciled set.
 *
 * IDEMPOTENT. Every row is upserted on (submission_id, contributor_key), and
 * any row this submission carries that is NOT in the new set is deleted first,
 * so a retry converges on exactly the same set rather than accumulating. The
 * score columns are deliberately NOT touched here — `applyContributorScores`
 * owns them, and clobbering them on a re-run would zero a contributor's score
 * between this write and that one.
 *
 * @param submitterRosterIds roster entries known from the roster side. Usually
 *   one (the matched submitter); more when co-submitters have attached to this
 *   submission.
 */
export async function storeContributors(
  db: DrizzleDb,
  submissionId: string,
  semesterId: string,
  bundle: Bundle,
  submitterRosterIds: readonly string[],
): Promise<ContributorRow[]> {
  // Stamp if nobody has. `establishBundleContributors` is the single definition
  // of who a contributor is; the server never re-implements it.
  if (bundle.contributors === undefined) {
    await establishBundleContributors(bundle, rootPublicKeyHexIfConfigured());
  }

  const resolved = await resolveBundleContributors(db, semesterId, bundle);
  const rows = reconcileContributors(resolved, submitterRosterIds);

  if (rows.length === 0) {
    // A submission with no nameable contributor at all. Legal — a bundle with
    // no identity and no roster match — and it must not leave stale rows behind.
    await db
      .delete(submission_contributors)
      .where(eq(submission_contributors.submission_id, submissionId));
    return rows;
  }

  const keys = rows.map((r) => r.contributor_key);
  const existing = await db
    .select({ id: submission_contributors.id, key: submission_contributors.contributor_key })
    .from(submission_contributors)
    .where(eq(submission_contributors.submission_id, submissionId));

  const staleIds = existing.filter((e) => !keys.includes(e.key)).map((e) => e.id);
  if (staleIds.length > 0) {
    await db.delete(submission_contributors).where(inArray(submission_contributors.id, staleIds));
  }

  await db
    .insert(submission_contributors)
    .values(
      rows.map((r) => ({
        submission_id: submissionId,
        semester_id: semesterId,
        contributor_key: r.contributor_key,
        kind: r.kind,
        roster_entry_id: r.roster_entry_id,
        student_ref: r.student_ref,
        student_pubkey: r.student_pubkey,
        session_count: r.session_count,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        is_submitter: r.is_submitter,
      })),
    )
    .onConflictDoUpdate({
      target: [submission_contributors.submission_id, submission_contributors.contributor_key],
      set: {
        kind: sqlExcluded('kind'),
        roster_entry_id: sqlExcluded('roster_entry_id'),
        student_ref: sqlExcluded('student_ref'),
        student_pubkey: sqlExcluded('student_pubkey'),
        session_count: sqlExcluded('session_count'),
        first_seen: sqlExcluded('first_seen'),
        last_seen: sqlExcluded('last_seen'),
        is_submitter: sqlExcluded('is_submitter'),
      },
    });

  return rows;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * `excluded.<col>` for an upsert SET clause.
 *
 * Column names here are compile-time literals from this module only — never
 * user input — so the raw identifier is safe. Kept as one helper so a future
 * column cannot be added with a different, unreviewed spelling.
 */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
