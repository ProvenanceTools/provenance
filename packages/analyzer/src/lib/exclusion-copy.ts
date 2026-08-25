/**
 * How the cross-scope exclusion register describes ONE lineage to a grader.
 *
 * Two panels render the register — `/compare` from the in-browser partition and
 * the server-backed cross-flags list from the API — and they must not describe
 * the same fact two ways. Both take their wording from here.
 *
 * The register is a statement about the RECORDING, never a finding about a
 * person (`analysis-core/coverage/cross-scope.ts`, §6 Rule 3), so every string
 * below has to survive being read as evidence. In particular the two reasons
 * are NOT synonyms and must not be flattened into one sentence:
 *
 *  - `same_repository_lineage` — a commit was proved shared. A repository is a
 *    thing that demonstrably exists, and the register may say so.
 *  - `shared_recording_scope` — no shared commit; a shared signed SESSION. This
 *    is the honest wording for an ordinary partner pair whose recorder never
 *    observed git, which is a whole class of them: git observation is an
 *    optional capability. Saying "same repository" here would assert a
 *    repository nobody demonstrated.
 */

/** The register's proof arrays, in either the API or the in-browser spelling. */
export type ExclusionProof = {
  reason: 'same_repository_lineage' | 'shared_recording_scope';
  sharedCommits: readonly string[];
  sharedSessions: readonly string[];
};

export type ExclusionCopy = {
  /** Leading clause, e.g. "Same repository lineage". */
  label: string;
  /** The evidence keys to list, already chosen for the reason. */
  evidence: readonly string[];
  /** "commit reference" / "recorded session", singular or plural to match. */
  evidenceNoun: string;
  /** The verb phrase that follows the count. */
  evidenceClause: string;
};

/**
 * Both proofs are carried on every row, so a commit-proved lineage that ALSO
 * shares sessions lists the commits — the claim its reason makes — rather than
 * silently mixing two kinds of key under one count. A grader reading
 * "established by 3 commit references" must be able to find three commits.
 */
export function exclusionCopy(ex: ExclusionProof): ExclusionCopy {
  if (ex.reason === 'shared_recording_scope') {
    const n = ex.sharedSessions.length;
    return {
      label: 'Shared recording scope',
      evidence: ex.sharedSessions,
      evidenceNoun: n === 1 ? 'recorded session' : 'recorded sessions',
      evidenceClause: 'present in more than one of these archives',
    };
  }
  const n = ex.sharedCommits.length;
  return {
    label: 'Same repository lineage',
    evidence: ex.sharedCommits,
    // "commit references", not "commits": a mixed-scope proof lists the SAME
    // sha under two repository keys, because neither key was observed by both
    // sides. Counting those as two commits would be a false claim in the one
    // place a grader looks for the evidence.
    evidenceNoun: n === 1 ? 'commit reference' : 'commit references',
    evidenceClause: 'shared across these archives',
  };
}

/**
 * The panel's intro line, which has to cover BOTH reasons at once because one
 * register can hold both. "Recording scope" is the term that is true either
 * way; "repository" is not.
 */
export const EXCLUSION_PANEL_INTRO =
  'These submissions are two views of one recording scope: each archive contains the ' +
  "other's recorded sessions, so a match between them says nothing about sharing between " +
  'students. Cross-comparison between them is not applicable. Every other pair was compared ' +
  'normally.';
