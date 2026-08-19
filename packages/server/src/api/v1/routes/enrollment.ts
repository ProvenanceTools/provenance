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
import { EnrollmentRequestSchema } from '@provenance/shared/api-schemas';
import { getDb } from '../../../db/client.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import { mintEnrollmentToken } from '../../../services/enrollment/mint.js';

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

  return router;
}
