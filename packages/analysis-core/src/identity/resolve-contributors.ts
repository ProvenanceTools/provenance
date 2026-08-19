/**
 * Contributor resolution — Tier 1.1 of
 * `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` (§5.1, §7).
 *
 * Answers, offline and from the bundle alone, "which contributor produced this
 * session?", and stamps the answer on the Bundle so every downstream consumer
 * reads the same verdict instead of re-implementing identity logic.
 *
 * ## Where identity comes from, and where it does NOT
 *
 * Only `session.start.identity`. Spec §5.1 rules out every other candidate, and
 * each exclusion is load-bearing:
 *
 *  - **never `machine_id`** — it is `sha256(hostname:username:session_id)`, so it
 *    is session-salted and can never match across two sessions of the same
 *    person, let alone identify one;
 *  - **never git author** — deliberately out of bounds (`log-core/events.ts`
 *    §"No author identity. Ever."): a git author is a real name and a real
 *    email, which this system does not record;
 *  - **never the upload filename** — the server's `match-student.ts` regex
 *    identifies the SUBMITTER, which in a shared repo is one of the
 *    contributors at most.
 *
 * ## The async/sync seam
 *
 * Signature verification is async; heuristics are synchronous. So this follows
 * the exact pattern `establishBundleTrust` uses for the capture policy: the
 * verdict is computed ONCE by {@link establishBundleContributors} and stamped on
 * the Bundle, and the synchronous {@link contributorOf} reads the stamp.
 *
 * An UNSTAMPED bundle reads as fully `unattributed` (spec §5.1). That is the
 * fail-toward-more-findings direction: `unattributed` is the state under which
 * the dangerous heuristics keep firing, because "two people" is exactly what is
 * unproven. It is not the state that suppresses anything.
 *
 * ## Trust anchors — two shapes, both supported forever
 *
 * The anchor is whatever ROOT vouched for, and which one is needed is decided by
 * the SIGNED `format_version` in the identity block's cert slot, never by which
 * fields happen to be present. (Routing on presence is the bug that once made
 * the whole legacy manifest path unreachable — see `institution.ts`.)
 *
 *  - **2.1, institution-scoped (current).** The `institution_cert` travels
 *    inline in the identity block. It is root-verified HERE, with
 *    `verifyInstitutionCert`, and only then handed to the chain walk as an
 *    anchor. A cert that rides in a student-editable bundle is not an anchor
 *    until root says so.
 *  - **2.0, course-scoped (archived).** The anchor is the `course_cert` inside
 *    the bundle's Manifest 2.0, which `verifyBundleTrustChain` has already
 *    walked root → course_cert → manifest → session. If that chain is `legacy`
 *    or `invalid` there is no root-anchored course key in this bundle, so the
 *    identity is `unverifiable / no_trust_anchor` — we cannot check, which is a
 *    different statement from "it failed".
 *
 * Archived 2.0 bundles must resolve forever; that is the entire justification
 * for adjudicating years later (program spec §9). Nothing here is gated on the
 * current version.
 *
 * ## Windows are reported, never enforced
 *
 * A lapsed cert or credential is returned ON the attributed verdict
 * (`certWindow` / `credentialWindow`), exactly as log-core returns it. An
 * institution letting a cert lapse mid-semester must not retroactively strip
 * attribution from a term's worth of work.
 */

import {
  verifyIdentityChain,
  verifyInstitutionCert,
  parseInstitutionCert,
  INSTITUTION_IDENTITY_FORMAT_VERSION,
  ENROLLMENT_FORMAT_VERSION,
} from '@provenance/log-core';
import type {
  CourseCert,
  IdentityChainError,
  InstitutionCert,
  SessionIdentity,
} from '@provenance/log-core';
import { verifyBundleTrustChain, describeTrustChainError } from '../manifest/bundle-manifest.js';
import type { Bundle, ParsedSession } from '../loader/types.js';
import type {
  BundleContributors,
  Contributor,
  ContributorScope,
  IdentityUnverifiableReason,
  IdentityVersion,
  SessionContributor,
} from './types.js';

export type {
  BundleContributors,
  Contributor,
  ContributorScope,
  IdentityUnverifiableReason,
  IdentityVersion,
  SessionContributor,
} from './types.js';
export { compareContributors, isIdentityCheckFailure } from './types.js';

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Build the grouping key for an attributed contributor.
 *
 * Components are percent-encoded before being joined on `:`. An unencoded join
 * would let a `course_id` containing a colon collide with a different
 * (scopeId, studentRef) pair — and a key collision here is two people merged
 * into one contributor, which is the fabricated relationship this module exists
 * to avoid.
 */
export function attributedContributorKey(
  identityVersion: IdentityVersion,
  scope: ContributorScope,
  scopeId: string,
  studentRef: string,
): string {
  return `attributed:${identityVersion}:${scope}:${encodeURIComponent(scopeId)}:${encodeURIComponent(studentRef)}`;
}

/** Singleton key for a session whose identity block did not verify. */
export function unverifiableContributorKey(sessionId: string): string {
  return `unverifiable:${encodeURIComponent(sessionId)}`;
}

/** Singleton key for a session that carried no identity block at all. */
export function unattributedContributorKey(sessionId: string): string {
  return `unattributed:${encodeURIComponent(sessionId)}`;
}

// ---------------------------------------------------------------------------
// Error text
// ---------------------------------------------------------------------------

/** Human-readable cause for a failed identity chain walk. */
export function describeIdentityChainError(error: IdentityChainError): string {
  switch (error.kind) {
    case 'unsupported_identity_version':
      return `identity declares format_version ${JSON.stringify(error.format_version)}, which this analyzer does not implement`;
    case 'identity_version_mismatch':
      return `identity cert declares ${error.cert_version} but the credential declares ${error.credential_version}`;
    case 'missing_trust_anchor':
      return `no root-verified ${error.required} was available to anchor this identity`;
    case 'invalid_cert_shape':
      return `identity certificate shape invalid${error.field === undefined ? '' : ` at ${error.field}`}${
        error.reason === undefined ? '' : `: ${error.reason}`
      }`;
    case 'invalid_token_shape':
      return `identity credential shape invalid${error.field === undefined ? '' : ` at ${error.field}`}${
        error.reason === undefined ? '' : `: ${error.reason}`
      }`;
    case 'invalid_course_signature':
      return 'enrollment certificate does not verify against the certified course public key';
    case 'invalid_enrollment_signature':
      return 'enrollment token does not verify against the certified enrollment public key';
    case 'course_id_mismatch':
      return `identity links disagree on course: token ${error.token_course_id}, cert ${error.cert_course_id}, course_cert ${error.course_cert_course_id}`;
    case 'invalid_institution_signature':
      return 'student credential does not verify against the root-certified institution public key';
    case 'institution_mismatch':
      return `identity links disagree on institution: credential ${error.credential_institution_id}, cert ${error.cert_institution_id}, anchor ${error.anchor_institution_id}${
        error.pubkey_mismatch ? ' (travelling cert names a different institution key than the anchor)' : ''
      }`;
    case 'invalid_session_pubkey':
      return 'session.start carries no usable session_pubkey for the identity binding';
    case 'invalid_session_pubkey_signature':
      return 'the student key did not countersign this session public key';
  }
}

/** One-line summary of a session contributor verdict, for UI and export text. */
export function describeSessionContributor(c: SessionContributor): string {
  switch (c.kind) {
    case 'attributed':
      return `attributed to ${c.studentRef} (${c.scope} ${c.scopeId}, identity ${c.identityVersion})`;
    case 'unattributed':
      return 'no identity block recorded — this session is not attributed to anyone';
    case 'unverifiable':
      return `identity present but not verifiable${
        c.claimedStudentRef === null ? '' : ` (claims ${c.claimedStudentRef})`
      }: ${c.reason.detail}`;
  }
}

// ---------------------------------------------------------------------------
// Reading the identity block
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(obj: Record<string, unknown> | null, field: string): string | null {
  if (obj === null) return null;
  const v = obj[field];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * What the identity block CLAIMS, read without trusting any of it.
 *
 * Used only to populate the display-only fields of an `unverifiable` verdict, so
 * a reader can see what the artifact asserted. Never used for grouping.
 */
function readClaims(identity: unknown): {
  studentRef: string | null;
  scopeId: string | null;
  version: string | null;
} {
  const block = asRecord(identity);
  const credential = asRecord(block?.['enrollment']);
  const cert = asRecord(block?.['enrollment_cert']);
  return {
    studentRef: readString(credential, 'student_ref'),
    // 2.0 credentials name a `course_id`, 2.1 credentials an `institution_id`.
    scopeId: readString(credential, 'institution_id') ?? readString(credential, 'course_id'),
    version: readString(cert, 'format_version'),
  };
}

/**
 * The version discriminator: the SIGNED `format_version` in the cert slot.
 *
 * Read before any signature work, exactly as `verifyIdentityChain` does. This is
 * used only to decide WHICH anchor to fetch — the chain walk re-reads it and
 * remains the authority on routing, so an unknown version still fails there with
 * `unsupported_identity_version` rather than being silently treated as 2.0.
 */
function declaredCertVersion(identity: unknown): string | null {
  return readString(asRecord(asRecord(identity)?.['enrollment_cert']), 'format_version');
}

// ---------------------------------------------------------------------------
// Per-session resolution
// ---------------------------------------------------------------------------

function unattributed(sessionId: string): SessionContributor {
  return {
    kind: 'unattributed',
    sessionId,
    contributorKey: unattributedContributorKey(sessionId),
  };
}

function unverifiable(
  sessionId: string,
  identity: unknown,
  reason: IdentityUnverifiableReason,
): SessionContributor {
  const claims = readClaims(identity);
  return {
    kind: 'unverifiable',
    sessionId,
    contributorKey: unverifiableContributorKey(sessionId),
    claimedStudentRef: claims.studentRef,
    claimedScopeId: claims.scopeId,
    claimedIdentityVersion: claims.version,
    reason,
  };
}

/** The root-anchored trust material available to this bundle, resolved once. */
type BundleAnchors = {
  rootPubkeyHex: string | undefined;
  /** Root-verified `course_cert` for 2.0 identities, or the reason there is none. */
  courseCert: CourseCert | null;
  courseCertUnavailable: string | null;
};

async function resolveSessionContributor(
  session: ParsedSession,
  anchors: BundleAnchors,
): Promise<SessionContributor> {
  const sessionId = session.sessionId;
  const identity = session.firstEvent.data.identity;

  // ---------------------------------------------------------------------------
  // No identity block at all. Blameless and ordinary — the recorder records
  // regardless of whether the student ever enrolled, which is correct. Note the
  // test is on the block's ABSENCE, not on whether it is well-formed: a present
  // but empty object is a claim, and claims go through verification below.
  // ---------------------------------------------------------------------------
  if (identity === undefined || identity === null) {
    return unattributed(sessionId);
  }

  // ---------------------------------------------------------------------------
  // From here the block is present, so every exit is `attributed` or
  // `unverifiable`. It can never fall back to `unattributed`.
  // ---------------------------------------------------------------------------
  const rootPubkeyHex = anchors.rootPubkeyHex;
  if (rootPubkeyHex === undefined || rootPubkeyHex.length === 0) {
    return unverifiable(sessionId, identity, {
      kind: 'no_root_key',
      detail:
        'no root public key is configured on this deployment, so no identity chain can be checked',
    });
  }

  const sessionPubkey = session.firstEvent.data.session_pubkey;
  const sessionStartedAt = session.firstEvent.wall;
  const version = declaredCertVersion(identity);

  let institutionCert: InstitutionCert | undefined;
  let courseCert: CourseCert | undefined;

  if (version === INSTITUTION_IDENTITY_FORMAT_VERSION) {
    // 2.1: the anchor travels inline, so root-verify it before it counts as one.
    const parsed = parseInstitutionCert(asRecord(identity)?.['enrollment_cert']);
    if (!parsed.ok) {
      const e = parsed.error;
      const chainError: IdentityChainError =
        e.kind === 'invalid_shape'
          ? {
              kind: 'invalid_cert_shape',
              ...(e.field !== undefined ? { field: e.field } : {}),
              ...(e.reason !== undefined ? { reason: e.reason } : {}),
            }
          : { kind: 'invalid_institution_signature' };
      return unverifiable(sessionId, identity, {
        kind: 'chain_failed',
        error: chainError,
        detail: describeIdentityChainError(chainError),
      });
    }
    const rootOk = await verifyInstitutionCert(parsed.value, rootPubkeyHex);
    if (!rootOk.ok) {
      return unverifiable(sessionId, identity, {
        kind: 'anchor_not_root_signed',
        detail:
          'the institution certificate travelling in this bundle does not verify against the root public key',
      });
    }
    institutionCert = parsed.value;
  } else if (version === ENROLLMENT_FORMAT_VERSION) {
    // 2.0: the anchor is the bundle manifest's root-verified `course_cert`.
    if (anchors.courseCert === null) {
      return unverifiable(sessionId, identity, {
        kind: 'no_trust_anchor',
        required: 'course_cert',
        detail:
          anchors.courseCertUnavailable ??
          'this bundle carries no root-verified course certificate',
      });
    }
    courseCert = anchors.courseCert;
  }
  // Any other declared version falls through with NO anchor: `verifyIdentityChain`
  // gates on the version before it looks at anchors and reports
  // `unsupported_identity_version`, which is the honest cause.

  const chain = await verifyIdentityChain({
    identity: identity as SessionIdentity,
    session_pubkey: typeof sessionPubkey === 'string' ? sessionPubkey : '',
    ...(courseCert !== undefined ? { course_cert: courseCert } : {}),
    ...(institutionCert !== undefined ? { institution_cert: institutionCert } : {}),
    session_started_at: sessionStartedAt,
  });

  if (!chain.ok) {
    return unverifiable(sessionId, identity, {
      kind: 'chain_failed',
      error: chain.error,
      detail: describeIdentityChainError(chain.error),
    });
  }

  const ok = chain.value;
  const scope: ContributorScope = ok.identity_version === '2.1' ? 'institution' : 'course';
  const scopeId = ok.identity_version === '2.1' ? ok.institution_id : ok.course_id;

  return {
    kind: 'attributed',
    sessionId,
    contributorKey: attributedContributorKey(
      ok.identity_version,
      scope,
      scopeId,
      ok.student_ref,
    ),
    studentRef: ok.student_ref,
    identityVersion: ok.identity_version,
    scope,
    scopeId,
    studentPubkey: ok.student_pubkey,
    certWindow: ok.cert_window,
    credentialWindow: ok.token_window,
  };
}

// ---------------------------------------------------------------------------
// Bundle-level resolution
// ---------------------------------------------------------------------------

/**
 * Resolve every session's contributor. Does NOT mutate the bundle — see
 * {@link establishBundleContributors} for the stamping variant.
 *
 * @param rootPubkeyHex The deployment's root public key. A PARAMETER, never a
 *   constant in this package: `analysis-core` is isomorphic, and one
 *   deployment's root key is not another's. Omitting it is legal and supported —
 *   the bundle still loads and analyses, and every identified session resolves
 *   `unverifiable / no_root_key`.
 */
export async function resolveBundleContributors(
  bundle: Bundle,
  rootPubkeyHex?: string,
): Promise<BundleContributors> {
  const rootKeyConfigured = rootPubkeyHex !== undefined && rootPubkeyHex.length > 0;

  // The 2.0 anchor is bundle-wide, so it is walked once rather than per session.
  // Only walked when there is a root key AND some session actually declares a 2.0
  // identity — a bundle with no 2.0 identity pays nothing for this.
  let courseCert: CourseCert | null = null;
  let courseCertUnavailable: string | null = null;
  const needsCourseAnchor = bundle.sessions.some(
    (s) => declaredCertVersion(s.firstEvent.data.identity) === ENROLLMENT_FORMAT_VERSION,
  );
  if (rootKeyConfigured && needsCourseAnchor) {
    const trust = await verifyBundleTrustChain(bundle, rootPubkeyHex);
    if (trust.kind === 'verified') {
      courseCert = trust.chain.cert;
    } else if (trust.kind === 'legacy') {
      courseCertUnavailable =
        'this bundle carries no Manifest 2.0, so there is no root-verified course certificate to anchor a 2.0 identity to';
    } else if (trust.kind === 'invalid') {
      courseCertUnavailable = `this bundle's manifest trust chain does not verify, so its course certificate anchors nothing (${describeTrustChainError(trust.error)})`;
    } else {
      courseCertUnavailable =
        'the manifest trust chain could not be verified, so there is no course certificate anchor';
    }
  }

  const anchors: BundleAnchors = { rootPubkeyHex, courseCert, courseCertUnavailable };

  // Sessions resolve independently — no ordering constraint, so Promise.all is
  // correct here (the CLAUDE.md rule is about operations that MUST be ordered).
  const verdicts = await Promise.all(
    bundle.sessions.map((session) => resolveSessionContributor(session, anchors)),
  );

  const bySession = new Map<string, SessionContributor>();
  const contributorsByKey = new Map<string, Contributor & { sessionIds: string[] }>();
  const counts = { attributed: 0, unverifiable: 0, unattributed: 0 };

  for (const verdict of verdicts) {
    bySession.set(verdict.sessionId, verdict);
    counts[verdict.kind] += 1;

    const existing = contributorsByKey.get(verdict.contributorKey);
    if (existing !== undefined) {
      existing.sessionIds.push(verdict.sessionId);
      continue;
    }
    contributorsByKey.set(verdict.contributorKey, {
      key: verdict.contributorKey,
      kind: verdict.kind,
      studentRef: verdict.kind === 'attributed' ? verdict.studentRef : null,
      identityVersion: verdict.kind === 'attributed' ? verdict.identityVersion : null,
      scope: verdict.kind === 'attributed' ? verdict.scope : null,
      scopeId: verdict.kind === 'attributed' ? verdict.scopeId : null,
      sessionIds: [verdict.sessionId],
    });
  }

  return {
    bySession,
    contributors: [...contributorsByKey.values()],
    rootKeyConfigured,
    counts,
  };
}

/**
 * Resolve contributors AND stamp the verdict onto the bundle, so the
 * synchronous, crypto-free {@link contributorOf} can serve every downstream
 * consumer.
 *
 * Mutates its argument, for the same reason `establishBundleTrust` does: every
 * holder of the Bundle reference (the server's LRU-cached `{ bundle, index }`,
 * the browser's `BundleContext` state, the heuristics that receive it) must see
 * the same verdict, and a copy would silently leave the originals unattributed.
 *
 * Idempotent, and cheap to repeat relative to bundle parsing.
 */
export async function establishBundleContributors(
  bundle: Bundle,
  rootPubkeyHex?: string,
): Promise<BundleContributors> {
  const contributors = await resolveBundleContributors(bundle, rootPubkeyHex);
  bundle.contributors = contributors;
  return contributors;
}

// ---------------------------------------------------------------------------
// The synchronous accessors — the ONLY identity API downstream code should use
// ---------------------------------------------------------------------------

/**
 * Which contributor produced this session?
 *
 * Pure and synchronous: reads the stamp {@link establishBundleContributors}
 * left. Nothing downstream should re-derive this — one implementation of "who
 * is this" is the whole point of Tier 1.1.
 *
 * An UNSTAMPED bundle, or a session id this bundle does not contain, answers
 * `unattributed` (spec §5.1). That fails toward MORE findings, not fewer:
 * `unattributed` is the state under which the contributor-gated heuristics keep
 * firing, because "these are two different people" is precisely what is
 * unproven.
 */
export function contributorOf(bundle: Bundle, sessionId: string): SessionContributor {
  return bundle.contributors?.bySession.get(sessionId) ?? unattributed(sessionId);
}

/** Every distinct contributor in the bundle. Empty when the bundle is unstamped. */
export function contributorsOf(bundle: Bundle): readonly Contributor[] {
  return bundle.contributors?.contributors ?? [];
}

/**
 * The distinct contributors we can actually NAME — the attributed ones.
 *
 * A finding may name a person only on the strength of one of these (spec §6
 * Rule 2). Everything else is a scope-level finding with no name attached.
 */
export function attributedContributorsOf(bundle: Bundle): readonly Contributor[] {
  return contributorsOf(bundle).filter((c) => c.kind === 'attributed');
}
