/**
 * The version LINEAGE key — "whose repeated submissions supersede each other".
 *
 * ## This is the READ-side mirror; Postgres is the authority
 *
 * `submissions.version_owner_key` is a GENERATED ALWAYS column (migration
 * 0029). Postgres derives it from `(student_id, group_key)` and refuses any
 * attempt to write it, so nothing here can put a wrong value into a row. What
 * this function is for is the other direction: `create-submission.ts` must
 * SELECT ... FOR UPDATE the lineage before the row exists, and that predicate
 * has to spell the same string the column will hold.
 *
 * Keep the two in lockstep. `create-submission.test.ts` pins it by locking with
 * this function and asserting the row Postgres generated carries the identical
 * key — so a divergence fails a test rather than silently selecting zero rows,
 * which is the failure mode this whole column exists to remove.
 *
 * ## Why this column exists at all
 *
 * Before migration 0029 the version sequence was keyed on
 * `submissions.student_id`, which was NOT NULL. D9 makes it nullable so a
 * submission can belong to a SET of people. Keying a unique constraint on a
 * nullable column is not a small change — it is two silent failures at once:
 *
 *  - Postgres treats NULLs as DISTINCT, so `UNIQUE (…, student_id, version_index)`
 *    stops constraining anything for group rows: any number of them can hold
 *    version_index 1.
 *  - `WHERE student_id = ${studentId}` with a NULL binds to `= NULL`, which is
 *    never true, so `create-submission.ts`'s `FOR UPDATE` lock selects ZERO
 *    rows. `maxVersion` stays 0, every resubmission is allocated version 1
 *    forever, and `supersededIds` is always empty — the supersede chain never
 *    forms.
 *
 * Neither raises. Both are the exact shape of defect this repo has shipped
 * green before, so the fix is structural: version allocation reads a NOT NULL
 * column and nothing else, and Postgres DERIVES that column rather than
 * trusting anyone to supply it.
 *
 * ## The two namespaces are disjoint by construction
 *
 * `student:<uuid>` and `group:<key>` cannot collide: the DB derivation picks
 * the branch from whether `student_id` is null, so a row is in exactly one
 * namespace and no caller gets a say. This function rejects a `groupKey` that
 * spells itself as a student purely to name the mistake at its source.
 */

/**
 * A submission with neither a submitter nor a group identity has no lineage,
 * so it cannot participate in version allocation at all. That is a programming
 * error, not a data state: every ingest path either matches a roster entry or
 * routes the file to the unmatched tray before it reaches here.
 */
export class MissingVersionOwnerError extends Error {
  constructor() {
    super(
      'versionOwnerKey: a submission needs a lineage — pass either a studentId ' +
        '(the submitter of record) or a groupKey. Neither was given, and a row ' +
        'with no lineage would silently restart the version sequence on every ' +
        'resubmission.',
    );
    this.name = 'MissingVersionOwnerError';
  }
}

/** The reserved prefix for a solo lineage. Also spelled in the DB derivation. */
const STUDENT_PREFIX = 'student:';
/** The reserved prefix for a group lineage. */
const GROUP_PREFIX = 'group:';

export interface VersionOwnerArgs {
  /**
   * The submitter of record — the roster entry the filename match or the
   * Gradescope `match_sid` named. When present it ALWAYS wins: it is stable
   * across resubmissions in a way a contributor set is not (a partner who
   * simply did not record this time would otherwise change the group's key and
   * silently start a second lineage).
   */
  studentId: string | null;
  /**
   * A stable identifier for a group with no single submitter. Opaque to this
   * function beyond the guard below.
   */
  groupKey?: string | null;
}

/**
 * Build the lineage key for a submission.
 *
 * @throws {MissingVersionOwnerError} when neither a studentId nor a groupKey is given.
 */
export function versionOwnerKey(args: VersionOwnerArgs): string {
  const { studentId, groupKey = null } = args;

  if (studentId !== null && studentId !== '') {
    return `${STUDENT_PREFIX}${studentId}`;
  }

  if (groupKey !== null && groupKey !== '') {
    // A group key spelled as a student would produce a lock predicate that
    // hunts in the solo partition while the row Postgres generates sits in the
    // group one — the two would never meet. Fail at the source.
    if (groupKey.startsWith(STUDENT_PREFIX)) {
      throw new Error(
        `versionOwnerKey: groupKey must not begin with "${STUDENT_PREFIX}" — that ` +
          'prefix is the solo lineage namespace and a group must never collide with it.',
      );
    }
    return `${GROUP_PREFIX}${groupKey}`;
  }

  throw new MissingVersionOwnerError();
}

/**
 * Does this key name a solo lineage owned by the given roster entry?
 *
 * Exported so tests and future read paths express the correspondence through
 * the same definition rather than re-concatenating the prefix.
 */
export function isVersionOwnerOfStudent(key: string, studentId: string): boolean {
  return key === `${STUDENT_PREFIX}${studentId}`;
}
