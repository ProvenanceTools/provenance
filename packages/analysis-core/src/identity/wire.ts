/**
 * The contributor stamp, across the HTTP boundary.
 *
 * `BundleContributors` is established once per bundle parse. The server does it
 * on every read (`loadSubmissionIndex` → `establishBundleContributors`); the
 * analyzer's `/local` route does it after `loadBundle`. The server-backed
 * analyzer does neither — it pages `EventRow`s and never sees a ZIP — so before
 * this module the deployed Replay tab had no contributor stamp at all, took
 * `soloReconstructionScope`, and therefore presented two partners' unordered
 * work as one linear keystroke sequence.
 *
 * Everything else the segmented reconstruction needs is already in the rows (see
 * `SourceEnvelope`). This carries the one thing that is not.
 *
 * ## Why the types are declared here rather than imported
 *
 * `analysis-core` depends on `log-core` and its analysis libs, and not on
 * `@provenance/shared` — the same reason `ServerEventRow` is declared in
 * `build-index.ts` rather than imported. The zod schemas in
 * `shared/src/api-schemas.ts` (`WireSessionContributorSchema`,
 * `WireContributorSchema`, `BundleContributorStampSchema`) are the authority on
 * the wire shape and these types mirror them structurally; both ends change in
 * one diff.
 *
 * ## What is lossy, and why that is safe
 *
 * Exactly one field: `IdentityUnverifiableReason`'s `error`, log-core's
 * `IdentityChainError`. It rides as `unknown` and is handed back verbatim. It is
 * a developer diagnostic that no staff surface renders — `contributor-labels.ts`
 * reads `reason.kind` and `reason.detail` and nothing else — and restating its
 * dozen arms in zod would create a second copy of a log-core union with nothing
 * keeping the two in step.
 *
 * Everything a reader is shown survives the round trip: which of the three
 * states a session is in, the verified `student_ref` for an attributed one, the
 * verbatim CLAIM for an unverifiable one, and whether the check was PERFORMED
 * (`isIdentityCheckFailure`) or merely impossible. Collapsing any of those is
 * how a deployment misconfiguration becomes a class-wide integrity finding, or
 * an unenrolled student becomes an accusation.
 */

import type { CertWindowStatus, IdentityChainError } from '@provenance/log-core';
import type {
  BundleContributors,
  Contributor,
  ContributorScope,
  IdentityUnverifiableReason,
  IdentityVersion,
  SessionContributor,
} from './types.js';

// ---------------------------------------------------------------------------
// Wire types — mirrors of the zod schemas in @provenance/shared
// ---------------------------------------------------------------------------

export type WireUnverifiableReason = {
  kind: IdentityUnverifiableReason['kind'];
  detail: string;
  required?: 'course_cert' | 'institution_cert';
  /** log-core's `IdentityChainError`, carried opaquely. See the module header. */
  error?: unknown;
};

export type WireSessionContributor =
  | {
      kind: 'attributed';
      session_id: string;
      contributor_key: string;
      student_ref: string;
      identity_version: IdentityVersion;
      scope: ContributorScope;
      scope_id: string;
      student_pubkey: string;
      cert_window: CertWindowStatus;
      credential_window: CertWindowStatus;
    }
  | {
      kind: 'unverifiable';
      session_id: string;
      contributor_key: string;
      claimed_student_ref: string | null;
      claimed_scope_id: string | null;
      claimed_identity_version: string | null;
      reason: WireUnverifiableReason;
    }
  | { kind: 'unattributed'; session_id: string; contributor_key: string };

export type WireContributor = {
  key: string;
  kind: SessionContributor['kind'];
  student_ref: string | null;
  identity_version: IdentityVersion | null;
  scope: ContributorScope | null;
  scope_id: string | null;
  session_ids: string[];
};

export type WireBundleContributors = {
  by_session: WireSessionContributor[];
  contributors: WireContributor[];
  root_key_configured: boolean;
  counts: { attributed: number; unverifiable: number; unattributed: number };
};

// ---------------------------------------------------------------------------
// Domain → wire
// ---------------------------------------------------------------------------

export function toWireSessionContributor(c: SessionContributor): WireSessionContributor {
  switch (c.kind) {
    case 'attributed':
      return {
        kind: 'attributed',
        session_id: c.sessionId,
        contributor_key: c.contributorKey,
        student_ref: c.studentRef,
        identity_version: c.identityVersion,
        scope: c.scope,
        scope_id: c.scopeId,
        student_pubkey: c.studentPubkey,
        cert_window: c.certWindow,
        credential_window: c.credentialWindow,
      };
    case 'unverifiable':
      return {
        kind: 'unverifiable',
        session_id: c.sessionId,
        contributor_key: c.contributorKey,
        claimed_student_ref: c.claimedStudentRef,
        claimed_scope_id: c.claimedScopeId,
        claimed_identity_version: c.claimedIdentityVersion,
        reason: {
          kind: c.reason.kind,
          detail: c.reason.detail,
          ...(c.reason.kind === 'no_trust_anchor' ? { required: c.reason.required } : {}),
          ...(c.reason.kind === 'chain_failed' ? { error: c.reason.error } : {}),
        },
      };
    case 'unattributed':
      return {
        kind: 'unattributed',
        session_id: c.sessionId,
        contributor_key: c.contributorKey,
      };
  }
}

/** `BundleContributors` → the wire shape. `bySession` becomes an array. */
export function toWireBundleContributors(stamp: BundleContributors): WireBundleContributors {
  return {
    by_session: [...stamp.bySession.values()].map(toWireSessionContributor),
    contributors: stamp.contributors.map((c) => ({
      key: c.key,
      kind: c.kind,
      student_ref: c.studentRef,
      identity_version: c.identityVersion,
      scope: c.scope,
      scope_id: c.scopeId,
      session_ids: [...c.sessionIds],
    })),
    root_key_configured: stamp.rootKeyConfigured,
    counts: { ...stamp.counts },
  };
}

// ---------------------------------------------------------------------------
// Wire → domain
// ---------------------------------------------------------------------------

function fromWireReason(reason: WireUnverifiableReason): IdentityUnverifiableReason {
  switch (reason.kind) {
    case 'no_root_key':
      return { kind: 'no_root_key', detail: reason.detail };
    case 'no_trust_anchor':
      return {
        kind: 'no_trust_anchor',
        // The wire always carries this for `no_trust_anchor`; a 2.0 identity
        // with no `course_cert` is the case that produces it, so that is the
        // honest default rather than a widened union.
        required: reason.required ?? 'course_cert',
        detail: reason.detail,
      };
    case 'anchor_not_root_signed':
      return { kind: 'anchor_not_root_signed', detail: reason.detail };
    case 'chain_failed':
      return {
        kind: 'chain_failed',
        // Opaque passthrough — see the module header. Narrowed rather than
        // validated because nothing reads it; it exists so a developer looking
        // at a response still sees what log-core said.
        error: reason.error as IdentityChainError,
        detail: reason.detail,
      };
  }
}

export function fromWireSessionContributor(c: WireSessionContributor): SessionContributor {
  switch (c.kind) {
    case 'attributed':
      return {
        kind: 'attributed',
        sessionId: c.session_id,
        contributorKey: c.contributor_key,
        studentRef: c.student_ref,
        identityVersion: c.identity_version,
        scope: c.scope,
        scopeId: c.scope_id,
        studentPubkey: c.student_pubkey,
        certWindow: c.cert_window,
        credentialWindow: c.credential_window,
      };
    case 'unverifiable':
      return {
        kind: 'unverifiable',
        sessionId: c.session_id,
        contributorKey: c.contributor_key,
        claimedStudentRef: c.claimed_student_ref,
        claimedScopeId: c.claimed_scope_id,
        claimedIdentityVersion: c.claimed_identity_version,
        reason: fromWireReason(c.reason),
      };
    case 'unattributed':
      return {
        kind: 'unattributed',
        sessionId: c.session_id,
        contributorKey: c.contributor_key,
      };
  }
}

/** The wire shape → `BundleContributors`, with `bySession` back as a Map. */
export function fromWireBundleContributors(wire: WireBundleContributors): BundleContributors {
  const bySession = new Map<string, SessionContributor>();
  for (const c of wire.by_session) bySession.set(c.session_id, fromWireSessionContributor(c));
  const contributors: Contributor[] = wire.contributors.map((c) => ({
    key: c.key,
    kind: c.kind,
    studentRef: c.student_ref,
    identityVersion: c.identity_version,
    scope: c.scope,
    scopeId: c.scope_id,
    sessionIds: [...c.session_ids],
  }));
  return {
    bySession,
    contributors,
    rootKeyConfigured: wire.root_key_configured,
    counts: { ...wire.counts },
  };
}
