/**
 * Mint an enrollment token for a student (program spec §5a — S2).
 *
 * This is the one place in the system where the server's private key signs
 * anything. Everything it does is in service of one claim:
 *
 *   "the holder of THIS public key is the student behind THIS opaque
 *    student_ref, on the roster of THIS course, as of THIS instant."
 *
 * ## Why there is a round trip at all
 *
 * The token binds a public key the STUDENT generated. Staff cannot bulk-mint
 * for a class, because staff do not have the students' keys — the master secret
 * a per-course key is derived from never leaves the student's machine. The
 * student prints their per-course public key from the recorder, authenticates
 * here, and pastes the token back. That round trip is the property that makes
 * an enrollment token evidence rather than an assertion.
 *
 * ## What identity is trusted
 *
 * The caller's Google identity, already gated by `AUTH_ALLOWED_HOSTED_DOMAINS`
 * at login, matched against `roster_entries` for the target semester. No roster
 * match, no token: minting for an unknown identity would let anyone in the
 * hosted domain manufacture attribution for a course they are not in.
 *
 * ## What is NOT enforced
 *
 * The student's key is not proved to be theirs beyond their possession of it —
 * we never see a signature from it. That is deliberate: the token says "this
 * key was presented by this student", and the countersignature over
 * `session_pubkey` at record time is what turns possession into evidence. A
 * student who pastes someone else's public key gets a token that they cannot
 * use, because they do not hold the matching private half.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  signEnrollmentToken,
  verifyEnrollmentToken,
  checkEnrollmentCertWindow,
  parseIsoInstantMs,
  ENROLLMENT_FORMAT_VERSION,
} from '@provenance/log-core';
import type { EnrollmentCert } from '@provenance/log-core';
import type { EnrollmentResponse } from '@provenance/shared/api-schemas';
import { roster_entries, semesters, student_enrollments, student_refs } from '../../db/schema.js';
import { withTransaction, type DrizzleDb } from '../../db/client.js';
import { enrollmentKeyForSemester, hex64ToBytes } from '../../config/enrollment-keys.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MintEnrollmentError =
  | { kind: 'semester_not_found' }
  /** No key configured for this semester, or its certificate is out of window. */
  | { kind: 'unavailable'; reason: 'no_enrollment_key' | 'cert_out_of_window' | 'key_mismatch' }
  | { kind: 'not_on_roster' }
  | { kind: 'roster_ambiguous'; matches: number };

export type MintEnrollmentResult =
  | { ok: true; value: EnrollmentResponse }
  | { ok: false; error: MintEnrollmentError };

export type MintEnrollmentInput = {
  db: DrizzleDb;
  semesterId: string;
  /** The authenticated Google account's email. Matched case-insensitively. */
  email: string;
  /** The student's per-course ed25519 PUBLIC key, 64 lowercase hex. */
  studentPubkey: string;
  /** Injected clock — the token's `issued_at` and every bookkeeping timestamp. */
  now: Date;
};

// ---------------------------------------------------------------------------
// mintEnrollmentToken
// ---------------------------------------------------------------------------

export async function mintEnrollmentToken(
  input: MintEnrollmentInput,
): Promise<MintEnrollmentResult> {
  const { db, semesterId, email, studentPubkey, now } = input;

  // -------------------------------------------------------------------------
  // 1. The semester must exist.
  // -------------------------------------------------------------------------
  const semesterRows = await db
    .select({ id: semesters.id })
    .from(semesters)
    .where(eq(semesters.id, semesterId))
    .limit(1);
  if (semesterRows[0] === undefined) {
    return { ok: false, error: { kind: 'semester_not_found' } };
  }

  // -------------------------------------------------------------------------
  // 2. Key material. Absent is a legitimate state (any semester predating S2),
  //    so it is a 503 "not open", not a crash.
  // -------------------------------------------------------------------------
  const material = enrollmentKeyForSemester(semesterId);
  if (material === undefined) {
    return { ok: false, error: { kind: 'unavailable', reason: 'no_enrollment_key' } };
  }
  const cert: EnrollmentCert = material.cert;

  // The certificate's window is REPORTED rather than enforced when verifying an
  // archived bundle — a lapsed cert must not stop a class recording. Minting is
  // the opposite case: a token issued outside the window would be born with
  // `cert_window.in_window === false` and read as suspect forever. Refuse here
  // so the failure lands on the operator, not on the student's record.
  const issuedAt = now.toISOString();
  const window = checkEnrollmentCertWindow(cert, issuedAt);
  if (!window.in_window) {
    return { ok: false, error: { kind: 'unavailable', reason: 'cert_out_of_window' } };
  }

  // -------------------------------------------------------------------------
  // 3. Roster match on the authenticated email.
  // -------------------------------------------------------------------------
  const matches = await db
    .select({ id: roster_entries.id, sid: roster_entries.sid })
    .from(roster_entries)
    .where(
      and(
        eq(roster_entries.semester_id, semesterId),
        sql`lower(${roster_entries.email}) = lower(${email})`,
      ),
    );

  if (matches.length === 0) {
    return { ok: false, error: { kind: 'not_on_roster' } };
  }
  if (matches.length > 1) {
    // roster_entries is unique on (semester_id, sid), not on email, so a CSV
    // with a duplicated address can produce this. Picking one would attribute a
    // semester of work to whichever row sorted first.
    return { ok: false, error: { kind: 'roster_ambiguous', matches: matches.length } };
  }
  const entry = matches[0]!;

  // -------------------------------------------------------------------------
  // 4. The opaque student_ref, stable per (semester, sid).
  //
  // Keyed on the SID rather than roster_entries.id so a roster commit that
  // deletes and re-adds the student hands back the same ref: two refs for one
  // person would split their sessions into two apparent contributors, which is
  // precisely the confusion the multi-contributor work exists to avoid.
  // -------------------------------------------------------------------------
  const refRows = await db
    .insert(student_refs)
    .values({ semester_id: semesterId, roster_entry_id: entry.id, sid: entry.sid })
    .onConflictDoUpdate({
      target: [student_refs.semester_id, student_refs.sid],
      set: { roster_entry_id: entry.id },
    })
    .returning({ student_ref: student_refs.student_ref });
  const studentRef = refRows[0]!.student_ref;

  // -------------------------------------------------------------------------
  // 5. Sign. Outside any transaction: crypto does not need one, and holding a
  //    Postgres transaction open across it would be pure lock time.
  // -------------------------------------------------------------------------
  const unsigned = {
    format_version: ENROLLMENT_FORMAT_VERSION,
    student_ref: studentRef,
    course_id: cert.course_id,
    student_pubkey: studentPubkey,
    issued_at: issuedAt,
    // Bounded by the certificate that authorizes the signing key: a token
    // cannot usefully outlive its issuer's authority.
    expires_at: cert.valid_until,
  };

  const enrollmentSig = await signEnrollmentToken(unsigned, hex64ToBytes(material.private_key_hex));
  const token = { ...unsigned, enrollment_sig: enrollmentSig };

  // Self-verify before anything is stored or returned, exactly as
  // `tools/mint-enrollment-cert.ts` does. This is what catches a private key
  // that does not match the certificate's `enrollment_pubkey` — a stale or
  // mis-pasted secret — instead of handing the student a token that no recorder
  // will ever accept. The failing value is never logged.
  const selfCheck = await verifyEnrollmentToken(token, cert.enrollment_pubkey);
  if (!selfCheck.ok) {
    return { ok: false, error: { kind: 'unavailable', reason: 'key_mismatch' } };
  }

  // -------------------------------------------------------------------------
  // 6. Record the binding, and mark any OTHER key for this student superseded.
  //
  // Bookkeeping only — see migration 0024. Superseding does not and cannot
  // invalidate an issued token: the identity chain is verified entirely from
  // inside the bundle, so an archived submission signed under a superseded key
  // still verifies years later. That is the adjudication case this program
  // exists for.
  // -------------------------------------------------------------------------
  const expiresAtMs = parseIsoInstantMs(cert.valid_until);
  // The signed token is authoritative for expiry; this column is for staff
  // queries. A date-only bound resolves to the start of that day here, while
  // the token means through its end.
  const expiresAt = expiresAtMs === null ? now : new Date(expiresAtMs);

  let reissued = false;
  await withTransaction(db, async (tx) => {
    const upserted = await tx
      .insert(student_enrollments)
      .values({
        student_ref: studentRef,
        enrollment_pubkey: cert.enrollment_pubkey,
        student_pubkey: studentPubkey,
        issued_at: now,
        expires_at: expiresAt,
      })
      .onConflictDoUpdate({
        target: [student_enrollments.student_ref, student_enrollments.student_pubkey],
        set: {
          enrollment_pubkey: cert.enrollment_pubkey,
          issued_at: now,
          expires_at: expiresAt,
          issue_count: sql`${student_enrollments.issue_count} + 1`,
          // Re-enrolling an older key makes it current again. Refusing instead
          // would strand a student who went back to their first machine, and
          // would buy nothing: the old token was already valid.
          superseded_at: null,
        },
      })
      .returning({ issue_count: student_enrollments.issue_count });

    reissued = (upserted[0]?.issue_count ?? 1) > 1;

    await tx
      .update(student_enrollments)
      .set({ superseded_at: now })
      .where(
        and(
          eq(student_enrollments.student_ref, studentRef),
          sql`${student_enrollments.student_pubkey} <> ${studentPubkey}`,
          sql`${student_enrollments.superseded_at} IS NULL`,
        ),
      );
  });

  return {
    ok: true,
    value: {
      enrollment: token,
      enrollment_cert: cert,
      course_id: cert.course_id,
      student_ref: studentRef,
      reissued,
    },
  };
}
