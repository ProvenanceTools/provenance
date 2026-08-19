/**
 * Contributor-resolution types — the answer to "which contributor produced this
 * session?", and nothing else.
 *
 * Spec: `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` §5.1
 * (contributor), §6 (presenting ambiguity), Tier 1.1 in §7.
 *
 * These types live in their own module, importing NOTHING from `loader/`, so
 * that `loader/types.ts` can carry the stamp (`Bundle.contributors`) with a
 * type-only import and no runtime cycle.
 *
 * ## The three states, and why collapsing any two is a bug
 *
 * The whole point of this module is that these are three DIFFERENT facts:
 *
 *  - **`attributed`** — an identity block was present, we had the root-anchored
 *    trust material, we walked the chain, and it verified. We know who.
 *
 *  - **`unattributed`** — there is NO identity block on `session.start` at all.
 *    The student never enrolled, or their recorder had no keyring. This is an
 *    ORDINARY, BLAMELESS state (spec S23: `buildSessionIdentity` returns
 *    `skipped` for every failure and the recorder records anyway, which is
 *    correct — never block recording). Nothing here is evidence of anything, and
 *    no consumer may render it as suspicious.
 *
 *  - **`unverifiable`** — an identity block IS present and we could not stand
 *    behind it. That is an artifact making a claim it cannot back, and it is a
 *    finding in its own right. It is NEVER merged into the contributor it names.
 *
 * Collapsing `unverifiable` into `unattributed` hides a forged claim. Collapsing
 * `unattributed` into `unverifiable` manufactures a finding against a student
 * whose only act was not enrolling. Both directions are wrongful-accusation
 * failures, which is why the union below is explicit rather than a boolean.
 *
 * ## "We cannot check" vs "we checked and it failed"
 *
 * Both are `unverifiable` — an unverified claim must not be honoured either way,
 * and R1 says an identity we cannot evaluate stays visible rather than being
 * silently dropped. But they are different facts and a caller must be able to
 * tell them apart: a deployment with no root public key configured produces the
 * first for EVERY identified session, and rendering that as "these students'
 * identities failed verification" would be a deployment misconfiguration
 * presented as a class-wide integrity finding. {@link IdentityUnverifiableReason}
 * keeps them distinct and {@link isIdentityCheckFailure} is the predicate.
 *
 * ## Naming note
 *
 * §5.1 of the spec sketches the verified branch as `kind: 'verified'`. This
 * module uses `'attributed'` so the discriminant reads as the exact complement
 * of `'unattributed'` — the pair a reader has to keep straight. Same three
 * states, same semantics.
 */

import type { CertWindowStatus, IdentityChainError } from '@provenance/log-core';

/** Which identity scheme a session's chain was walked under. */
export type IdentityVersion = '2.0' | '2.1';

/**
 * What a `student_ref` is scoped to.
 *
 * `'course'` for the legacy 2.0 chain (a per-course ref, minted against a
 * roster); `'institution'` for the current 2.1 chain (one global ref per
 * student, every course). The two namespaces are disjoint — see
 * {@link Contributor.key}.
 */
export type ContributorScope = 'course' | 'institution';

/**
 * Why an identity block that was PRESENT did not produce an attribution.
 *
 * The first two mean **we could not check**; the last two mean **we checked and
 * it failed**. See {@link isIdentityCheckFailure}.
 */
export type IdentityUnverifiableReason =
  /**
   * No root public key is configured on this deployment, so no chain of any
   * version can be walked. Analysis still runs — attribution is a feature of a
   * configured deployment, never a precondition of loading a bundle.
   */
  | { kind: 'no_root_key'; detail: string }
  /**
   * The root-anchored trust material this identity version needs is not
   * available from this bundle. In practice: a 2.0 identity in a bundle whose
   * Manifest 2.0 trust chain is `legacy` (no `course_cert` to anchor to) or
   * `invalid` (the anchor itself did not verify, so it anchors nothing).
   */
  | { kind: 'no_trust_anchor'; required: 'course_cert' | 'institution_cert'; detail: string }
  /**
   * A 2.1 identity's travelling `institution_cert` does not verify against the
   * root public key. The cert rides inside a student-editable bundle, so
   * root-verifying it is what turns it into an anchor at all; failing that, it
   * is just an assertion.
   */
  | { kind: 'anchor_not_root_signed'; detail: string }
  /** We had the anchor, walked the chain with log-core, and the walk failed. */
  | { kind: 'chain_failed'; error: IdentityChainError; detail: string };

/**
 * Did we actually perform the check?
 *
 * `false` — "we cannot check" (no root key, no anchor). `true` — "we checked and
 * it failed". A UI that wants to say "this identity does not verify" must read
 * THIS, not `kind === 'unverifiable'`.
 */
export function isIdentityCheckFailure(reason: IdentityUnverifiableReason): boolean {
  return reason.kind === 'anchor_not_root_signed' || reason.kind === 'chain_failed';
}

/** One session's contributor verdict. */
export type SessionContributor =
  | {
      kind: 'attributed';
      sessionId: string;
      /** Grouping key. See {@link Contributor.key}. */
      contributorKey: string;
      /** The verified roster reference. Opaque; never a name, SID, or email. */
      studentRef: string;
      identityVersion: IdentityVersion;
      scope: ContributorScope;
      /** `course_id` for 2.0, `institution_id` for 2.1. */
      scopeId: string;
      /** The long-lived student public key that countersigned this session key. */
      studentPubkey: string;
      /**
       * Non-fatal. Was the issuing cert in window when it issued the credential?
       * Judged against the credential's own issue time, never wall-clock now, so
       * an archived bundle still reads correctly years later.
       */
      certWindow: CertWindowStatus;
      /**
       * Non-fatal. Was the credential in window when this session ran? Judged
       * against `session.start.wall`.
       */
      credentialWindow: CertWindowStatus;
    }
  | {
      kind: 'unverifiable';
      sessionId: string;
      /**
       * A SINGLETON key, `unverifiable:<sessionId>`. Deliberately not derived
       * from {@link SessionContributor.claimedStudentRef}: merging an unverified
       * claim into the contributor it names is precisely how a forged identity
       * block would launder work onto an innocent student.
       */
      contributorKey: string;
      /**
       * What the artifact CLAIMED, verbatim, for display and for the finding
       * text. Never a grouping key, and never the basis of naming a person.
       * `null` when the block carried nothing readable there.
       */
      claimedStudentRef: string | null;
      /** The `course_id` / `institution_id` the block claimed. Display only. */
      claimedScopeId: string | null;
      /** The `format_version` the travelling cert declared. Display only. */
      claimedIdentityVersion: string | null;
      reason: IdentityUnverifiableReason;
    }
  | {
      kind: 'unattributed';
      sessionId: string;
      /**
       * A SINGLETON key, `unattributed:<sessionId>`.
       *
       * Two unattributed sessions are NEVER grouped together: two unenrolled
       * people are indistinguishable from one person recording twice, and
       * asserting either way is a fabricated relationship. Nor are they proven
       * DISTINCT — {@link compareContributors} answers `'unknown'` for any pair
       * involving one, which is the only honest answer.
       */
      contributorKey: string;
    };

/** A distinct contributor within one bundle, with the sessions that resolved to it. */
export type Contributor = {
  /**
   * The grouping key, and the identity primitive every downstream consumer
   * should join on.
   *
   * For an attributed contributor:
   * `attributed:<version>:<scope>:<enc(scopeId)>:<enc(studentRef)>`.
   *
   * `student_ref` is the designed attribution primitive and is the only field
   * here that is stable across machines — `session_pubkey` is per-session
   * ephemeral and could never group two sessions, and a derived student pubkey,
   * while stable, is a different value under the 2.0 and 2.1 schemes for the
   * same human. The ref is namespaced by version + scope because a 2.0 ref is
   * per-COURSE and a 2.1 ref is GLOBAL: they are drawn from different spaces and
   * a bare string compare across them could collide two different people.
   * Components are percent-encoded so a separator inside an id cannot merge two
   * contributors.
   *
   * For `unverifiable` and `unattributed` the key is a per-session singleton.
   */
  key: string;
  kind: SessionContributor['kind'];
  /** Non-null ONLY for `attributed`. A claim is not a `studentRef`. */
  studentRef: string | null;
  identityVersion: IdentityVersion | null;
  scope: ContributorScope | null;
  scopeId: string | null;
  /** Session ids that resolved to this contributor, in bundle (wall) order. */
  sessionIds: readonly string[];
};

/**
 * The bundle-level contributor verdict, stamped onto the Bundle by
 * `establishBundleContributors`.
 */
export type BundleContributors = {
  /** Every session in the bundle, keyed by `sessionId`. Total — no session is omitted. */
  bySession: ReadonlyMap<string, SessionContributor>;
  /** Distinct contributors, in order of first appearance in the bundle. */
  contributors: readonly Contributor[];
  /**
   * Whether a root public key was supplied at all.
   *
   * `false` is a DEPLOYMENT fact, not a property of the bundle: every identified
   * session is then `unverifiable / no_root_key`, and a reader must be told that
   * rather than shown a page of apparent identity failures.
   */
  rootKeyConfigured: boolean;
  /** Session counts per state. Coverage-panel input (spec §6 Rule 3). */
  counts: { attributed: number; unverifiable: number; unattributed: number };
};

/**
 * Three-valued contributor comparison — the primitive the re-keyed heuristics
 * (Tier 3) must use instead of comparing keys directly.
 *
 * `'unknown'` whenever either side is not attributed. Reading "different keys"
 * as "two different people" would assert exactly the relationship that is
 * unproven for an unattributed session, and that assertion is what makes
 * `multiple_sessions_overlap` say "impossible without log forging".
 */
export function compareContributors(
  a: SessionContributor,
  b: SessionContributor,
): 'same' | 'different' | 'unknown' {
  if (a.kind !== 'attributed' || b.kind !== 'attributed') return 'unknown';
  return a.contributorKey === b.contributorKey ? 'same' : 'different';
}
