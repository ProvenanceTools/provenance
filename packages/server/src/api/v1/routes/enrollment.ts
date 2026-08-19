/**
 * POST /api/v1/semesters/:semesterId/enrollment — mint a student's enrollment
 * token (program spec §5a — S2).
 *
 * ## This is the first route students can reach
 *
 * Until now every account on this server belonged to course staff. This route
 * introduces a second class of user, and its surface is deliberately one
 * endpoint wide: a student can mint their own enrollment token for a semester
 * whose roster they are on, and nothing else. There is no listing, no lookup,
 * no submission, no cohort, no roster read — every other route still goes
 * through `requireAuth`, which requires a `memberships` row that no student has.
 * A student who guesses another semester's id gets 403 unless they are on that
 * roster too, and even then all they can mint is their own token.
 *
 * ## Authentication
 *
 * The same Google OAuth and the same `AUTH_ALLOWED_HOSTED_DOMAINS` gate that
 * protects the analyzer, unchanged — the `hd` claim check at
 * `/auth/google/callback` is what keeps outsiders off, and nothing here relaxes
 * it. On top of that:
 *
 *  - **API tokens are refused.** A token binds a key to a named student for the
 *    semester; a stolen long-lived bearer secret must not be able to mint one.
 *  - **View-as is refused.** A superadmin impersonating a student must not be
 *    able to mint a credential in that student's name — that would produce
 *    signed evidence attributing work to someone by an operator's action, which
 *    is exactly what this chain exists to make impossible.
 *
 * Authorization is roster membership, checked in the service: no matching
 * `roster_entries` row, no token.
 */

import { Hono } from 'hono';
import {
  EnrollmentRequestSchema,
  StudentCredentialRequestSchema,
} from '@provenance/shared/api-schemas';
import { getDb } from '../../../db/client.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import { mintEnrollmentToken } from '../../../services/enrollment/mint.js';
import { issueStudentCredential } from '../../../services/enrollment/mint-credential.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createEnrollmentRouter(nowFn: () => Date = () => new Date()): Hono {
  const router = new Hono();

  router.post(
    '/semesters/:semesterId/enrollment',
    rateLimit('write.misc'),
    audit('enrollment.mint', 'semester', (c) => c.req.param('semesterId') ?? 'unknown'),
    async (c) => {
      const principal = c.var.principal ?? null;
      if (principal === null) {
        const returnTo = encodeURIComponent(c.req.path);
        const err = Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`);
        return c.json(err.toBody(), 401);
      }
      if (principal.principal_kind === 'token') {
        const err = Errors.enrollmentSessionRequired();
        return c.json(err.toBody(), 403);
      }
      if (principal.viewAs !== undefined) {
        const err = Errors.viewAsReadOnly();
        return c.json(err.toBody(), 403);
      }

      const semesterId = c.req.param('semesterId') ?? '';
      // Guard before the query: an id that is not a uuid would make Postgres
      // raise a cast error rather than return no rows.
      if (!UUID_RE.test(semesterId)) {
        const err = Errors.notFound();
        return c.json(err.toBody(), 404);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        const err = Errors.validation([{ body: 'must be a JSON object' }]);
        return c.json(err.toBody(), 400);
      }

      const parsed = EnrollmentRequestSchema.safeParse(body);
      if (!parsed.success) {
        const err = Errors.validation(parsed.error.issues);
        return c.json(err.toBody(), 400);
      }

      // Set the audit target so the row lands against this semester. The audit
      // middleware reads it after the handler returns.
      c.set('target', { semesterId });

      const result = await mintEnrollmentToken({
        db: getDb(),
        semesterId,
        email: principal.user.email,
        studentPubkey: parsed.data.student_pubkey,
        now: nowFn(),
      });

      if (!result.ok) {
        switch (result.error.kind) {
          case 'semester_not_found': {
            const err = Errors.notFound();
            return c.json(err.toBody(), 404);
          }
          case 'not_on_roster': {
            const err = Errors.enrollmentNotOnRoster();
            return c.json(err.toBody(), 403);
          }
          case 'roster_ambiguous': {
            const err = Errors.enrollmentRosterAmbiguous(result.error.matches);
            return c.json(err.toBody(), 409);
          }
          case 'unavailable': {
            const err = Errors.enrollmentUnavailable(result.error.reason);
            return c.json(err.toBody(), 503);
          }
        }
      }

      // Audit detail carries only public material: the opaque ref, the public
      // key, and whether this was a re-issue. Never the signature, never the
      // student's email — the whole point of `student_ref` is that the log line
      // does not carry an identity.
      c.set('auditDetail', {
        student_ref: result.value.student_ref,
        student_pubkey: result.value.enrollment.student_pubkey,
        enrollment_pubkey: result.value.enrollment_cert.enrollment_pubkey,
        reissued: result.value.reissued,
      });

      return c.json(result.value, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /identity/credential — issue a student's INSTITUTION-SCOPED
  // credential (identity format_version 2.1).
  //
  // ## Why this is not the route above
  //
  // The 2.0 route is `/semesters/:semesterId/enrollment` because an enrollment
  // token names a course. A student credential names no course, no semester,
  // and no assignment, so there is no path parameter to scope it by — a student
  // obtains ONE credential, once, and it serves every course forever.
  //
  // The 2.0 route stays mounted and unchanged: archived bundles carry 2.0
  // tokens, `enrollment.ts` in log-core stays live forever to verify them, and
  // the server half of that chain follows the same rule.
  //
  // ## Authorization
  //
  // The same Google OAuth and the same `AUTH_ALLOWED_HOSTED_DOMAINS` gate that
  // protects the analyzer, unchanged — the `hd` claim check at
  // `/auth/google/callback` is what keeps outsiders off, and nothing here
  // relaxes it. On top of that:
  //
  //  - **API tokens are refused.** A credential IS the attribution claim; a
  //    stolen long-lived bearer secret must not be able to mint one.
  //  - **View-as is refused.** A superadmin impersonating a student must not be
  //    able to issue a credential in that student's name — that would produce
  //    signed evidence attributing work to someone by an operator's action,
  //    which is exactly what this chain exists to make impossible.
  //
  // And that is the whole authorization story. There is deliberately NO roster
  // check: rosters are populated by Gradescope ingest, which runs only after a
  // student submits, so requiring one meant a student could not obtain an
  // identity before their first submission. Being an authenticated member of
  // the hosted domain is sufficient to be issued an opaque ref — the ref
  // asserts "this is consistently the same person", not "this person is in
  // your class", and the latter is answered later from the roster.
  // -------------------------------------------------------------------------
  router.post(
    '/identity/credential',
    rateLimit('write.misc'),
    audit('credential.issue', 'institution', () => 'institution'),
    async (c) => {
      const principal = c.var.principal ?? null;
      if (principal === null) {
        const returnTo = encodeURIComponent(c.req.path);
        const err = Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`);
        return c.json(err.toBody(), 401);
      }
      if (principal.principal_kind === 'token') {
        const err = Errors.credentialSessionRequired();
        return c.json(err.toBody(), 403);
      }
      if (principal.viewAs !== undefined) {
        const err = Errors.viewAsReadOnly();
        return c.json(err.toBody(), 403);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        const err = Errors.validation([{ body: 'must be a JSON object' }]);
        return c.json(err.toBody(), 400);
      }

      const parsed = StudentCredentialRequestSchema.safeParse(body);
      if (!parsed.success) {
        const err = Errors.validation(parsed.error.issues);
        return c.json(err.toBody(), 400);
      }

      const result = await issueStudentCredential({
        db: getDb(),
        // The Google `sub` claim, not the email: stable across an email change
        // and free of case ambiguity, so one human keeps one `student_ref`.
        ssoSubject: principal.user.google_subject,
        email: principal.user.email,
        studentPubkey: parsed.data.student_pubkey,
        now: nowFn(),
      });

      if (!result.ok) {
        const err = Errors.credentialUnavailable(result.error.reason);
        return c.json(err.toBody(), 503);
      }

      // Audit detail carries only public material: the opaque ref, the public
      // key, and whether this was a re-issue. Never the signature, never the
      // student's email or SSO subject — the whole point of `student_ref` is
      // that the log line does not carry an identity.
      c.set('auditDetail', {
        student_ref: result.value.student_ref,
        student_pubkey: result.value.credential.student_pubkey,
        institution_id: result.value.institution_id,
        reissued: result.value.reissued,
      });

      return c.json(result.value, 200);
    },
  );

  return router;
}
