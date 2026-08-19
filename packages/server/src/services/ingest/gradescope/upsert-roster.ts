/**
 * Upsert roster entries from Gradescope submitters (analyzer PRD §8.4 / §5.2).
 *
 * The Gradescope ingest path populates the roster directly from the export's
 * `submission_metadata.yml` rather than from a separate CSV upload. Per the
 * agreed behaviour this is an *add/update only* upsert — it never deletes
 * existing roster entries (unlike the CSV preview/commit flow, which can delete).
 *
 * Matching is by exact `(semester_id, sid)`, the same key the ingest worker uses
 * to resolve a bundle's `match_sid` to a roster entry, so the sids written here
 * line up with the sids matched later.
 *
 * Update policy: a submitter's name/email overwrites the stored value only when
 * present in the metadata — a metadata row missing a name does not clobber an
 * existing display name. New entries fall back to email, then sid, for the
 * required display_name.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { roster_entries, students } from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';
import type { GradescopeSubmitter } from './parse-metadata.js';
import { assignMissingProtectedIndices } from '../../protected-index.js';

// ---------------------------------------------------------------------------
// Roster ↔ student linking
// ---------------------------------------------------------------------------

/**
 * Point every still-unlinked roster row in this semester at the `students` row
 * whose SSO email matches, case-insensitively.
 *
 * Identity 2.1 (`packages/log-core/src/institution.ts`). The link lives on the
 * ROSTER side, so this write can never damage an identity: deleting a roster
 * row later drops the link, not the `students` row, and a `student_ref` read
 * out of an archived bundle still resolves.
 *
 * Emails that match more than one `students` row cannot occur — `students` is
 * unique on (institution_id, sso_subject) and a single Google account owns one
 * address at one institution — but the subquery is written to take the single
 * matching ref rather than to error, so a hand-edited database cannot wedge
 * ingest.
 *
 * The converse (one student matching several roster rows) is the NORMAL case:
 * a student appears on a Fall roster and again on a Spring one, and both rows
 * point at the same ref. That is a plain many-to-one, not the 2.0-era
 * `roster_ambiguous` conflict, because the ref is derived from the SSO subject
 * rather than from a roster row.
 */
export async function linkNewRosterEntriesToStudents(
  db: DrizzleDb,
  semesterId: string,
): Promise<number> {
  const linked = await db
    .update(roster_entries)
    .set({
      student_ref: sql`(
        SELECT ${students.student_ref} FROM ${students}
        WHERE lower(${students.sso_email}) = lower(${roster_entries.email})
        LIMIT 1
      )`,
    })
    .where(
      and(
        eq(roster_entries.semester_id, semesterId),
        isNull(roster_entries.student_ref),
        sql`${roster_entries.email} IS NOT NULL`,
        sql`EXISTS (
          SELECT 1 FROM ${students}
          WHERE lower(${students.sso_email}) = lower(${roster_entries.email})
        )`,
      ),
    )
    .returning({ id: roster_entries.id });
  return linked.length;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RosterUpsertResult {
  added: number;
  updated: number;
}

// ---------------------------------------------------------------------------
// upsertRosterFromSubmitters
// ---------------------------------------------------------------------------

/**
 * Insert new roster entries and update existing ones for the given submitters.
 * Never deletes. Returns how many rows were added vs. updated (an existing sid
 * always counts as "updated", even if no field actually changed).
 *
 * Runs inside a single transaction so the add/update counts are consistent.
 */
export async function upsertRosterFromSubmitters(
  db: DrizzleDb,
  semesterId: string,
  submitters: GradescopeSubmitter[],
): Promise<RosterUpsertResult> {
  // Dedupe by sid (the caller usually passes deduped submitters, but be safe).
  const bySid = new Map<string, GradescopeSubmitter>();
  for (const s of submitters) {
    if (!bySid.has(s.sid)) bySid.set(s.sid, s);
  }
  const unique = Array.from(bySid.values());
  if (unique.length === 0) return { added: 0, updated: 0 };

  return db.transaction(async (tx) => {
    // Which of these sids already exist? Determines added vs updated counts.
    const sids = unique.map((s) => s.sid);
    const existingRows = await tx
      .select({ sid: roster_entries.sid })
      .from(roster_entries)
      .where(and(eq(roster_entries.semester_id, semesterId), inArray(roster_entries.sid, sids)));
    const existing = new Set(existingRows.map((r) => r.sid));

    let added = 0;
    let updated = 0;

    for (const s of unique) {
      // On conflict, overwrite name/email only when the metadata supplies them.
      const set: Record<string, unknown> = { updated_at: sql`now()` };
      if (s.name !== undefined) set['display_name'] = s.name;
      if (s.email !== undefined) set['email'] = s.email;

      await tx
        .insert(roster_entries)
        .values({
          semester_id: semesterId,
          sid: s.sid,
          display_name: s.name ?? s.email ?? s.sid,
          email: s.email ?? null,
        })
        .onConflictDoUpdate({
          target: [roster_entries.semester_id, roster_entries.sid],
          set,
        });

      if (existing.has(s.sid)) updated += 1;
      else added += 1;
    }

    // Newly-inserted rows have NULL protected_index; assign per-semester indices
    // so Gradescope-rostered students get stable "Student N" labels in protected
    // mode (matching the CSV commitRoster path), not the UUID-stub fallback.
    if (added > 0) {
      await assignMissingProtectedIndices(tx, semesterId);
    }

    // Link the rows just written to any student who has ALREADY obtained a 2.1
    // credential, matching on lower(email) in both directions.
    //
    // This is the "student enrolls, then submits" case — the normal one. The
    // mirror call in `issueStudentCredential` handles "student submits, then
    // enrolls". Both are the same idempotent write, so the order of the two
    // events cannot change the outcome.
    //
    // The `IS NULL` guard makes the link write-once: an already-attributed
    // roster row is never re-pointed at a different student by a later commit
    // that happens to reuse an address, because re-pointing would silently
    // re-attribute that student's work.
    await linkNewRosterEntriesToStudents(tx, semesterId);

    return { added, updated };
  });
}
