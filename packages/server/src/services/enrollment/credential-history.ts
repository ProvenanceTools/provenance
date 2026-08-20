/**
 * The append-only history of every 2.1 credential this server has issued, and
 * the one question it exists to answer.
 *
 * ## The question
 *
 *   "Was THIS public key ever issued to THIS student?"
 *
 * That is the adjudication question, and until migration 0027 the server could
 * not answer it. `students` keeps ONE `student_pubkey` per human and the
 * enrolment upsert overwrites it, so a bundle recorded on a laptop in October
 * was checked against whatever key the student's desktop enrolled in November.
 * The truthful answer — "yes, that was one of theirs" — needs the history, and
 * the history had been thrown away.
 *
 * ## Why one student legitimately has many keys
 *
 * Multiple machines per student is a supported flow, and the existing design
 * for it is correct: each machine generates its OWN master secret and therefore
 * its own keypair; the student signs in with the same account, so the server
 * returns the SAME global `student_ref`; each machine gets its own credential
 * binding its key to that shared ref. Bundles verify independently (the chain
 * walk never consults this server) and contributor resolution groups on
 * `student_ref`, so both machines resolve to ONE contributor.
 *
 * So "many keys, one ref" is the healthy state, not an anomaly, and a
 * `student_pubkey` that does not match the newest one is not evidence of
 * anything on its own.
 *
 * ## What this module does NOT do
 *
 * It does not gate, revoke, or expire anything. A credential is a signed
 * artifact: it stays cryptographically valid until its own signed `expires_at`
 * whatever this table says, and it must, because an archived bundle has to keep
 * verifying years later. Everything here is read-side evidence for a human
 * adjudicator.
 *
 * Only PUBLIC material is stored or returned. There is no code path here that
 * touches a private key, and there must never be one.
 */

import { and, eq, sql } from 'drizzle-orm';
import { student_credentials } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One issuance, as the credential in the student's hands describes itself. */
export type IssuedCredentialRecord = {
  readonly student_ref: string;
  readonly institution_id: string;
  readonly student_pubkey: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
};

/**
 * What a fresh issuance did to the student's history, in the terms the
 * enrollment page speaks.
 */
export type IssuanceStanding = {
  /**
   * How many DISTINCT public keys have ever been issued to this student,
   * counting the one just issued. Each machine derives its own key, so in
   * practice this is the number of machines the student has set up.
   */
  readonly machineCount: number;
  /**
   * True when the key just issued had never been issued to this student
   * before — a machine being set up for the first time, rather than an
   * already-known machine asking for a fresh credential.
   */
  readonly keyFirstIssued: boolean;
};

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Append one issuance and report where it leaves the student.
 *
 * APPEND-ONLY: there is no upsert here and no counter to bump. Two issuances of
 * the same key at different times are two facts — different `issued_at`,
 * potentially different `expires_at` — and an adjudicator asking which
 * credential was live when a bundle was recorded needs both of them.
 *
 * The counts are read back in a single statement after the insert, so the row
 * just written is included. Two genuinely concurrent enrolments of the same new
 * key could each see the other's row and both report `keyFirstIssued: false`;
 * that is cosmetic (it only softens a message on the enrollment page) and is
 * not worth a transaction, because no decision anywhere depends on it.
 */
export async function recordIssuedCredential(
  db: DrizzleDb,
  record: IssuedCredentialRecord,
): Promise<IssuanceStanding> {
  await db.insert(student_credentials).values({
    student_ref: record.student_ref,
    institution_id: record.institution_id,
    student_pubkey: record.student_pubkey,
    issued_at: record.issued_at,
    expires_at: record.expires_at,
  });

  const [counts] = await db
    .select({
      same_key: sql<number>`count(*) FILTER (
        WHERE ${student_credentials.student_pubkey} = ${record.student_pubkey}
      )::int`,
      machines: sql<number>`count(DISTINCT ${student_credentials.student_pubkey})::int`,
    })
    .from(student_credentials)
    .where(eq(student_credentials.student_ref, record.student_ref));

  return {
    machineCount: counts?.machines ?? 1,
    keyFirstIssued: (counts?.same_key ?? 1) <= 1,
  };
}

// ---------------------------------------------------------------------------
// Read — the adjudication question
// ---------------------------------------------------------------------------

/**
 * Every issuance of `studentPubkey` to `studentRef`, oldest first.
 *
 * An empty array means the server has no record of ever issuing that key to
 * that student. Note what that is NOT: it is not proof the key is forged. A
 * deployment that upgraded through migration 0027 only backfilled the key
 * `students` still held, so keys issued and overwritten BEFORE that migration
 * are unrecoverable and read as unknown here. `students.issue_count` exceeding
 * the number of rows for a student is the honest signal that this is the case.
 *
 * Deliberately returns the records rather than a bare boolean: an adjudicator
 * looking at an October bundle wants to know whether the credential was live in
 * October, which needs the dates.
 */
export async function findIssuedCredentials(
  db: DrizzleDb,
  args: { studentRef: string; studentPubkey: string },
): Promise<IssuedCredentialRecord[]> {
  const rows = await db
    .select({
      student_ref: student_credentials.student_ref,
      institution_id: student_credentials.institution_id,
      student_pubkey: student_credentials.student_pubkey,
      issued_at: student_credentials.issued_at,
      expires_at: student_credentials.expires_at,
    })
    .from(student_credentials)
    .where(
      and(
        eq(student_credentials.student_ref, args.studentRef),
        eq(student_credentials.student_pubkey, args.studentPubkey),
      ),
    )
    .orderBy(student_credentials.issued_at);
  return rows;
}

/**
 * THE adjudication query: was this public key ever issued to this student?
 *
 * Answered from the history and NOWHERE ELSE. Answering it from
 * `students.student_pubkey` would read every key but the most recent one as
 * never issued, which is exactly the bug — the laptop key of a student who
 * later enrolled a desktop would come back "no".
 */
export async function wasKeyEverIssuedToStudent(
  db: DrizzleDb,
  args: { studentRef: string; studentPubkey: string },
): Promise<boolean> {
  const found = await findIssuedCredentials(db, args);
  return found.length > 0;
}

/**
 * Every distinct public key ever issued to this student, oldest first — the
 * "which machines has this person set up?" view.
 */
export async function listStudentKeys(
  db: DrizzleDb,
  studentRef: string,
): Promise<IssuedCredentialRecord[]> {
  const rows = await db
    .select({
      student_ref: student_credentials.student_ref,
      institution_id: student_credentials.institution_id,
      student_pubkey: student_credentials.student_pubkey,
      issued_at: student_credentials.issued_at,
      expires_at: student_credentials.expires_at,
    })
    .from(student_credentials)
    .where(eq(student_credentials.student_ref, studentRef))
    .orderBy(student_credentials.issued_at);
  return rows;
}
