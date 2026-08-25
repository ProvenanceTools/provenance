/**
 * Issue a student's INSTITUTION-SCOPED credential — identity `format_version`
 * 2.1 (`packages/log-core/src/institution.ts`).
 *
 * The structural twin of `mint.ts`, which stays live for the 2.0 course-scoped
 * chain. Everything here is in service of one claim:
 *
 *   "the holder of THIS public key is the person behind THIS opaque
 *    student_ref, at THIS institution, as of THIS instant."
 *
 * Note what the claim does NOT say: nothing about a course, a semester, or an
 * assignment. That omission is the entire redesign.
 *
 * ## The deadlock this removes
 *
 * `mint.ts` returns `not_on_roster` when no `roster_entries` row matches the
 * caller's email. But rosters are NOT entered by hand — they are populated by
 * the Gradescope ingest path, which runs only AFTER a student submits. So a
 * student could not obtain an identity until after their first submission,
 * while their sessions need one BEFORE they work or the work carries none.
 *
 * There is no roster check here at all. Course membership is a roster question
 * the server answers later, against data it owns, by linking the roster row to
 * the student when it eventually appears — see `linkRosterEntries`. Verifying
 * membership was never what a credential was for; it exists so a reader can
 * tell two students on one submission apart and say which is which.
 *
 * ## What identity is trusted
 *
 * The caller's Google identity, already gated by `AUTH_ALLOWED_HOSTED_DOMAINS`
 * at login — the `hd` claim check is untouched and is the only thing keeping
 * outsiders off. The row is keyed on the Google `sub` claim rather than the
 * email: `sub` is stable across an IT-driven email change and has no case
 * ambiguity, and keying identity on a mutable attribute is how one person ends
 * up with two refs and their sessions split into two apparent contributors.
 *
 * ## Idempotency, and the second machine
 *
 * A student who enrolls twice gets the SAME `student_ref`, guaranteed by the
 * unique key on (`institution_id`, `sso_subject`) and an upsert that never
 * touches `student_ref`. Re-issuing signs a fresh credential over that same ref
 * and overwrites the bookkeeping columns — it orphans nothing, because the 2.1
 * chain verifies entirely from inside the bundle and consults no server. The
 * credential already in a student's hands stays cryptographically valid until
 * its own signed `expires_at`, which is precisely what lets an archived bundle
 * verify years later during an adjudication.
 *
 * Enrolling twice is therefore NORMAL AND EXPECTED: it is how a student sets up
 * a second machine. Each machine generates its own master secret and its own
 * keypair, and each gets its own credential over the one shared ref, so
 * contributor resolution (which groups on `student_ref`) still sees ONE person.
 *
 * What the upsert cannot do is remember. It holds the most recent key only, so
 * every earlier key would be lost — and with it the server's ability to answer
 * "was this the student's key?" about a bundle recorded on their other machine.
 * That is why every issuance is also appended to `student_credentials`; see
 * `credential-history.ts`. The upsert's overwriting behaviour is deliberately
 * unchanged — `students` is the identity anchor, the history is additive.
 *
 * ## What is NOT enforced
 *
 * The student's key is not proved to be theirs beyond their possession of it —
 * we never see a signature from it. That is deliberate: the credential says
 * "this key was presented by this student", and the countersignature over
 * `session_pubkey` at record time is what turns possession into evidence. A
 * student who pastes someone else's public key gets a credential they cannot
 * use, because they do not hold the matching private half.
 */

import { and, isNull, sql } from 'drizzle-orm';
import {
  signStudentCredential,
  verifyStudentCredential,
  checkInstitutionCertWindow,
  parseIsoInstantMs,
  INSTITUTION_IDENTITY_FORMAT_VERSION,
} from '@provenance/log-core';
import type { StudentCredential } from '@provenance/log-core';
import type { StudentCredentialResponse } from '@provenance/shared/api-schemas';
import { roster_entries, students } from '../../db/schema.js';
import { type DrizzleDb } from '../../db/client.js';
import { institutionKey, hex64ToBytes } from '../../config/institution-keys.js';
import { recordIssuedCredential } from './credential-history.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IssueCredentialError = {
  kind: 'unavailable';
  reason: 'no_institution_key' | 'cert_out_of_window' | 'key_mismatch';
};

export type IssueCredentialResult =
  | { ok: true; value: StudentCredentialResponse }
  | { ok: false; error: IssueCredentialError };

export type IssueCredentialInput = {
  db: DrizzleDb;
  /** The Google `sub` claim of the authenticated account. The identity key. */
  ssoSubject: string;
  /** The authenticated Google account's email. Used ONLY to link roster rows. */
  email: string;
  /** The student's single long-lived ed25519 PUBLIC key, 64 lowercase hex. */
  studentPubkey: string;
  /** Injected clock — the credential's `issued_at` and every bookkeeping stamp. */
  now: Date;
};

// ---------------------------------------------------------------------------
// Roster linking
// ---------------------------------------------------------------------------

/**
 * Link every not-yet-linked roster row whose email matches this student to this
 * `student_ref`.
 *
 * Called from BOTH directions, because either can happen first:
 *
 *  - **student enrolls, then submits** (the normal case): at issue time there
 *    is nothing to link, and the roster row created by a later Gradescope
 *    ingest is linked by the ingest-side call;
 *  - **student submits, then enrolls**: the roster row already exists with a
 *    NULL `student_ref`, and this call backfills it.
 *
 * The write is the same idempotent statement in both directions, so the order
 * of the two events cannot change the outcome.
 *
 * Matching is on `lower(email)` on both sides: a roster CSV exported from
 * Gradescope and a Google account routinely disagree on case, and treating
 * `A.Student@uni.edu` and `a.student@uni.edu` as different people would hand
 * one human two identities.
 *
 * TWO ROSTER ROWS MATCHING ONE SSO IDENTITY IS NOT AN ERROR. It is the normal
 * case — a student appears on a roster in Fall and again in Spring — and both
 * rows simply point at the same `student_ref`. The 2.0 mint had to refuse this
 * (409 `roster_ambiguous`) because it derived the ref FROM a roster row and
 * could not pick one; here the ref comes from the SSO subject, so there is
 * nothing to disambiguate.
 *
 * The `IS NULL` guard is load-bearing: it makes the link WRITE-ONCE. Without
 * it, a roster row already attributed to one student could be silently
 * re-pointed at another by a later commit that happens to reuse the address —
 * which would re-attribute that student's work.
 */
export async function linkRosterEntries(
  db: DrizzleDb,
  studentRef: string,
  email: string,
): Promise<number> {
  const linked = await db
    .update(roster_entries)
    .set({ student_ref: studentRef })
    .where(
      and(
        isNull(roster_entries.student_ref),
        sql`lower(${roster_entries.email}) = lower(${email})`,
      ),
    )
    .returning({ id: roster_entries.id });
  return linked.length;
}

// ---------------------------------------------------------------------------
// issueStudentCredential
// ---------------------------------------------------------------------------

export async function issueStudentCredential(
  input: IssueCredentialInput,
): Promise<IssueCredentialResult> {
  const { db, ssoSubject, email, studentPubkey, now } = input;

  // -------------------------------------------------------------------------
  // 1. Key material. Absent is a legitimate state (any deployment that has not
  //    adopted 2.1 identity), so it is a 503 "not open", not a crash.
  // -------------------------------------------------------------------------
  const material = institutionKey();
  if (material === undefined) {
    return { ok: false, error: { kind: 'unavailable', reason: 'no_institution_key' } };
  }
  const cert = material.cert;

  // The certificate's window is REPORTED rather than enforced when verifying an
  // archived bundle — a lapsed cert must not stop a class recording. Issuing is
  // the opposite case: a credential minted outside the window would be born
  // out-of-window and read as suspect forever. Refuse here so the failure lands
  // on the operator, not on the student's record.
  const issuedAt = now.toISOString();
  const window = checkInstitutionCertWindow(cert, issuedAt);
  if (!window.in_window) {
    return { ok: false, error: { kind: 'unavailable', reason: 'cert_out_of_window' } };
  }

  // -------------------------------------------------------------------------
  // 2. The student row. NO ROSTER LOOKUP — that is the point of the redesign.
  //
  // Insert-or-return keyed on (institution_id, sso_subject). `student_ref` is
  // never in the `set` clause, so a second enrollment cannot allocate a second
  // ref for the same person: two refs for one human would split their sessions
  // into two apparent contributors, exactly the confusion this exists to avoid.
  // -------------------------------------------------------------------------
  const expiresAt = cert.valid_until;
  const expiresAtMs = parseIsoInstantMs(expiresAt);
  // The signed credential is authoritative for expiry; this column is for staff
  // queries. A date-only bound resolves to the start of that day here, while
  // the credential means through its end.
  const expiresAtDate = expiresAtMs === null ? now : new Date(expiresAtMs);

  const upserted = await db
    .insert(students)
    .values({
      institution_id: material.institution_id,
      sso_subject: ssoSubject,
      sso_email: email,
      student_pubkey: studentPubkey,
      issued_at: now,
      expires_at: expiresAtDate,
      issue_count: 1,
    })
    .onConflictDoUpdate({
      target: [students.institution_id, students.sso_subject],
      set: {
        // The email is refreshed so roster linking keeps working after an IT
        // department reassigns an address. The SSO subject, and therefore the
        // ref, is unaffected.
        sso_email: email,
        // One student has ONE key forever (global derivation, no user-derived
        // input), so this normally rewrites the same value. It changes only in
        // the "lost my master secret" case, and rewriting it does not and
        // cannot invalidate the credential already issued under the old key.
        student_pubkey: studentPubkey,
        issued_at: now,
        expires_at: expiresAtDate,
        issue_count: sql`${students.issue_count} + 1`,
        updated_at: now,
      },
    })
    .returning({
      student_ref: students.student_ref,
      issue_count: students.issue_count,
    });

  const row = upserted[0]!;
  const studentRef = row.student_ref;
  const reissued = row.issue_count > 1;

  // -------------------------------------------------------------------------
  // 3. Sign. Outside any transaction: crypto does not need one, and holding a
  //    Postgres transaction open across it would be pure lock time.
  // -------------------------------------------------------------------------
  const unsigned = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: material.institution_id,
    student_ref: studentRef,
    student_pubkey: studentPubkey,
    issued_at: issuedAt,
    // Bounded by the certificate that authorizes the signing key: a credential
    // cannot usefully outlive its issuer's authority.
    expires_at: expiresAt,
  };

  const institutionSig = await signStudentCredential(
    unsigned,
    hex64ToBytes(material.private_key_hex),
  );
  const credential: StudentCredential = { ...unsigned, institution_sig: institutionSig };

  // Self-verify before anything is stored or returned. This is what catches a
  // private key that does not match the certificate's `institution_pubkey` — a
  // stale or mis-pasted secret — instead of handing the student a credential
  // that no recorder or analyzer will ever accept. The failing value is never
  // logged.
  const selfCheck = await verifyStudentCredential(credential, cert.institution_pubkey);
  if (!selfCheck.ok) {
    return { ok: false, error: { kind: 'unavailable', reason: 'key_mismatch' } };
  }

  // -------------------------------------------------------------------------
  // 4. Append the issuance to the permanent history.
  //
  // After the self-check, for the same reason as the roster link below: a
  // deployment with a mismatched secret must not leave a record of a credential
  // it refused to hand over.
  //
  // This is the ONLY place that remembers a key the `students` upsert above has
  // overwritten, which is what lets an adjudicator later be told the truth
  // about a bundle recorded on a student's other machine — "yes, that was one
  // of theirs". Nothing prunes it; see `credential-history.ts`.
  // -------------------------------------------------------------------------
  const standing = await recordIssuedCredential(db, {
    student_ref: studentRef,
    institution_id: material.institution_id,
    student_pubkey: studentPubkey,
    issued_at: now,
    expires_at: expiresAtDate,
  });

  // -------------------------------------------------------------------------
  // 5. Backfill the roster link for the "submitted before enrolling" case.
  //
  // After the self-check, so a deployment with a mismatched secret does not
  // leave links behind for a credential it refused to issue.
  // -------------------------------------------------------------------------
  // A single UPDATE is already atomic; no transaction to add here.
  await linkRosterEntries(db, studentRef, email);

  return {
    ok: true,
    value: {
      credential,
      institution_cert: cert,
      institution_id: material.institution_id,
      student_ref: studentRef,
      reissued,
      machine_count: standing.machineCount,
      key_first_issued: standing.keyFirstIssued,
    },
  };
}
