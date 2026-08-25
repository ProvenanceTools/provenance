/**
 * POST /api/v1/identity/credential — issue a student's INSTITUTION-SCOPED
 * credential (identity `format_version` 2.1).
 *
 * ## This is the only route students can reach
 *
 * Every other account on this server belongs to course staff. This route's
 * surface is deliberately one endpoint wide: a student can obtain their own
 * credential and nothing else. There is no listing, no lookup, no submission,
 * no cohort, no roster read — every other route still goes through
 * `requireAuth`, which requires a `memberships` row that no student has.
 *
 * ## Why there is no course or semester in the path
 *
 * A credential names no course, no semester, and no assignment, so there is no
 * path parameter to scope it by — a student obtains ONE credential, once, and
 * it serves every course forever. Attribution to a *course* is answered later,
 * from the roster, by linking the student's `student_ref` to a roster row.
 *
 * ## The retired 2.0 minting route
 *
 * There used to be a sibling here, `POST /semesters/:semesterId/enrollment`,
 * which minted a per-COURSE enrollment token (identity `format_version` 2.0).
 * It is gone. It was superseded by this route before either shipped, and it was
 * structurally deadlocked besides: it required a `roster_entries` match, and
 * rosters are populated by Gradescope ingest, which runs only *after* a student
 * submits. A student could therefore never enrol before their first submission,
 * which is the one moment an identity is actually needed.
 *
 * Retiring the MINTING path says nothing about VERIFICATION. Identity 2.0
 * verification in `log-core` (`enrollment.ts`, `verifyIdentityChain`) and in
 * `analysis-core` (`identity/resolve-contributors.ts`) stays live forever:
 * archived bundles carry 2.0 tokens and must keep verifying years later, which
 * is the entire justification for this system. The chain is walked from inside
 * the bundle and never consults this server, so nothing removed here can reach
 * it. See `enrollment-retired.test.ts`.
 *
 * ## Authorization
 *
 * The same Google OAuth and the same `AUTH_ALLOWED_HOSTED_DOMAINS` gate that
 * protects the analyzer, unchanged — the `hd` claim check at
 * `/auth/google/callback` is what keeps outsiders off, and nothing here relaxes
 * it. On top of that:
 *
 *  - **API tokens are refused.** A credential IS the attribution claim; a
 *    stolen long-lived bearer secret must not be able to mint one.
 *  - **View-as is refused.** A superadmin impersonating a student must not be
 *    able to issue a credential in that student's name — that would produce
 *    signed evidence attributing work to someone by an operator's action, which
 *    is exactly what this chain exists to make impossible.
 *
 * And that is the whole authorization story. There is deliberately NO roster
 * check, for the deadlock reason above. Being an authenticated member of the
 * hosted domain is sufficient to be issued an opaque ref — the ref asserts
 * "this is consistently the same person", not "this person is in your class",
 * and the latter is answered later from the roster.
 */

import { Hono } from 'hono';
import { StudentCredentialRequestSchema } from '@provenance/shared/api-schemas';
import { getDb } from '../../../db/client.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../../middleware/audit.js';
import { Errors } from '../errors.js';
import { issueStudentCredential } from '../../../services/enrollment/mint-credential.js';

export function createCredentialRouter(nowFn: () => Date = () => new Date()): Hono {
  const router = new Hono();

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
        // How many machines this student has now enrolled. A count, not a name.
        machine_count: result.value.machine_count,
      });

      return c.json(result.value, 200);
    },
  );

  return router;
}
