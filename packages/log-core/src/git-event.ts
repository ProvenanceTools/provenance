/**
 * Reading the repository discriminator off a `git.event` payload — decision D12
 * (collaboration spec S14(b), §8.6 item 6).
 *
 * The type lives in `events.ts` with every other payload; the runtime narrowing
 * lives here, in the same style as `peer-observed.ts` and `rolling-manifest.ts`,
 * because it is a cross-language contract rather than a private detail of one
 * reader.
 *
 * ## What the discriminator is, and what it is not
 *
 * It is the repository's **root-commit sha**, and it is used for one thing:
 * deciding whether two observed commits live in the same sha space. Node identity
 * in the observed DAG is `(repository, sha)`, and without a discriminator a scope
 * that observed a submodule alongside its outer repository merges two unrelated
 * sha spaces into one graph.
 *
 * The root-commit sha was chosen because **both partners on one repository derive
 * the same value offline**, which is what makes cross-contributor correlation
 * possible at all, and because a submodule has a different root commit, so it
 * discriminates correctly. A session-salted hash of the repository path was
 * rejected for the first reason: two partners would compute different values and
 * the DAG could never be correlated across contributors.
 *
 * It is deliberately **not** the repository path (a filesystem path is arguably
 * an identifier and is certainly noisy) and **not** a remote URL (which embeds
 * the org and frequently the student's own username). That constraint is the
 * reason this reader checks the value's SHAPE, which the sha reader deliberately
 * does not do — see below.
 *
 * ## Absent is the ordinary case, permanently
 *
 * Every bundle recorded before this landed carries no discriminator, and no
 * recorder emits one yet (the writer half is deliberately outstanding; readers
 * before writers, program spec §9). {@link RepositoryDiscriminatorRead} therefore
 * models absence as its own answer, and a reader must treat it exactly as it
 * treated the world before the field existed. **Absent is not empty, is not a
 * defect, and can never be evidence of anything.**
 *
 * Three ordinary situations produce absence and none of them is a finding:
 *
 *  - a recorder that predates the field;
 *  - a **shallow clone**, where the root commit is not reachable — the boundary
 *    commit a shallow clone reports has no parents but is not a root, so a writer
 *    that emitted it would publish a value a full clone of the same repository
 *    disagrees with;
 *  - anything else that leaves the answer non-unique or unreadable.
 *
 * ## Why a malformed value is neither trusted nor treated as absent-and-forgotten
 *
 * A value that is present but not a commit sha cannot be used as a repository
 * key: it would partition the graph on garbage, and — the reason the shape check
 * exists at all — a nonconforming writer that put a repository PATH or a remote
 * URL in this field would otherwise flow an identifier straight through the
 * reader and into a staff-facing UI. So a malformed value yields
 * {@link RepositoryDiscriminatorRead} `'malformed'`, the caller folds the
 * observation in with the unlabelled ones, and the fact that a value was there
 * and could not be read is COUNTED rather than dropped.
 *
 * It is still not a finding. A malformed discriminator is a statement about the
 * recorder that wrote it, never about the student it recorded.
 *
 * ## Why this checks the shape when `sha` reading deliberately does not
 *
 * `analysis-core`'s `readSha` treats a commit sha as opaque: no case folding, no
 * abbreviation expansion, no length check, because normalizing there could merge
 * two genuinely distinct commits and corrupt the ordering the whole programme
 * rests on. The jobs are different. A `sha` is only ever compared for equality
 * against other recorded shas; this value is a NAMESPACE KEY and a privacy
 * boundary. Rejecting what cannot be a commit sha costs nothing — the observation
 * still lands, in the unlabelled repository — and is the one place a path or a
 * URL can be stopped.
 *
 * Both git object formats are accepted: 40 hex for sha-1, 64 for sha-256
 * repositories. Lowercase only, which is what git prints; an uppercase value is
 * malformed rather than folded, because folding it would be exactly the
 * normalization the paragraph above refuses. The cost of rejecting is bounded and
 * safe: the observation joins the unlabelled ones, and the pair of contributors
 * simply does not correlate.
 */

import type { GitEventPayload } from './events.js';

/**
 * The payload key that carries the discriminator.
 *
 * Exported so a port names the field through this constant rather than
 * restating the string, and so a rename is a compile error rather than a silent
 * cross-repository disagreement.
 */
export const REPOSITORY_DISCRIMINATOR_FIELD = 'root_commit_sha' satisfies keyof GitEventPayload;

/** sha-1 (40) and sha-256 (64) object names, lowercase hex, as git prints them. */
const ROOT_COMMIT_SHA_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Why a present discriminator could not be read.
 *
 * Descriptive only. None of these is evidence about a student, and no reader may
 * turn one into a finding — see the module docstring.
 */
export type RepositoryDiscriminatorProblem =
  /** Present, but not a JSON string. */
  | 'not_a_string'
  /** Present and a string, but empty. An empty key would merge every repository. */
  | 'empty'
  /**
   * A non-empty string that is not a lowercase 40- or 64-hex object name. A
   * repository path, a remote URL, an abbreviated sha and an uppercased sha all
   * land here.
   */
  | 'not_a_commit_sha';

/**
 * What one `git.event` payload says about which repository it came from.
 *
 * Three answers, kept apart on purpose:
 *
 *  - `'absent'` — the field is not there. The ordinary case for every bundle in
 *    existence, and for a shallow clone forever. Read it as "this observation is
 *    unlabelled", never as "a different repository" and never as a defect.
 *  - `'recorded'` — a usable root-commit sha.
 *  - `'malformed'` — something was there and could not be used.
 *
 * `'absent'` and `'malformed'` lead the caller to the same place (the unlabelled
 * repository) and are still different facts, which is why they are different
 * variants: one is a recorder that had nothing to say, the other is a recorder
 * that said something wrong, and only the second is worth counting.
 */
export type RepositoryDiscriminatorRead =
  | { kind: 'absent' }
  | { kind: 'recorded'; rootCommitSha: string }
  | { kind: 'malformed'; problem: RepositoryDiscriminatorProblem };

/**
 * Reads the repository discriminator out of an untyped `git.event` `data` value.
 *
 * Pure and total: never throws, never mutates. A `.slog` is a student-editable
 * file, so every input here is untrusted and a malformed one is EXPECTED rather
 * than exceptional.
 *
 * `null` is accepted as absence so a writer that spelled the unknown case
 * explicitly still reads correctly — but a **writer must OMIT the field**, never
 * emit `null`. The two canonicalize differently and therefore chain to different
 * hashes, exactly as `parents: []` and an absent `parents` do, and the format
 * pins omission.
 *
 * A payload that is not an object at all reads as `'absent'`: there is no field
 * on a non-object, and manufacturing a problem out of a payload this function
 * does not own would report the same garbage twice.
 */
export function readRepositoryDiscriminator(data: unknown): RepositoryDiscriminatorRead {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { kind: 'absent' };
  }
  const raw = (data as Record<string, unknown>)[REPOSITORY_DISCRIMINATOR_FIELD];
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'malformed', problem: 'not_a_string' };
  if (raw.length === 0) return { kind: 'malformed', problem: 'empty' };
  if (!ROOT_COMMIT_SHA_RE.test(raw)) return { kind: 'malformed', problem: 'not_a_commit_sha' };
  return { kind: 'recorded', rootCommitSha: raw };
}
