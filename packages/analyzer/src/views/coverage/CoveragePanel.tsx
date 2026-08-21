/**
 * CoveragePanel — what the record does and does not contain, stated as fact, at
 * the submission level.
 *
 * Spec: `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` §6
 * Rule 3 — "a coverage panel **per scope**, always visible. […] Low coverage is
 * displayed as low coverage. It is never a flag and never a score contribution —
 * it is context a human needs to read the flags correctly."
 *
 * ## Why the submission level, and why not the Replay tab
 *
 * This panel first shipped inside the Replay tab, collapsed behind a disclosure
 * button. That failed Rule 3 twice over: a tab is not "always visible", and a
 * collapsed panel is not visible at all. It also mis-scoped the facts. "Artifacts
 * were dropped", "this seal has an unattested tail", "no root key is configured"
 * and "these two contributors recorded concurrently" are statements about the
 * SUBMISSION, not about the replay — a grader forms their view on the overview,
 * and the context that tells them how to read the flags has to be there, beside
 * the flags, not behind a tab they may never open.
 *
 * Rule 3 says a panel *per scope*, so there is exactly one — not one per tab.
 * It is mounted in the two overview surfaces that render a scope (the
 * server-backed submission Overview and the in-browser `/local` OverviewView),
 * which are two implementations of one view, not two places to look.
 *
 * ## The three states, and why none of them is "render nothing"
 *
 * Always visible means the panel answers even when it has no facts, because
 * silence and "nothing to report" are different claims:
 *
 *  1. **No facts** — the server did not send them, which today means only one
 *     thing: a deployment that predates `SubmissionSummary.coverage`. It says
 *     exactly that. It must never render counts: a panel of zeroes asserts
 *     "no commits observed, no contributors, no root key", which is a stronger
 *     and false claim than "not available".
 *  2. **Facts, nothing to note** — a solo, fully attributed, classically sealed
 *     bundle. It says so in one line, in the neutral palette, and nothing about
 *     that line is alarming.
 *  3. **Facts to state** — the sections below.
 *
 * ## The wording rules, each of which has cost this project a false accusation
 *
 *  - **Absence is never suspicious.** A student who never enrolled, a session
 *    with no `git.event`, a deployment with no root key: all render as limits on
 *    what we can see, never as something the student did.
 *  - **"Cannot check" is not "failed".** `rootKeyConfigured === false` renders as
 *    "no identity check was possible", and the word "failed" does not appear on
 *    that path.
 *  - **`unverifiable` is not `unattributed`.** They are counted and described
 *    separately and are never summed into one "problem" number.
 *  - **`concurrent` is not `unknown`.** A concurrent-recording row is only ever
 *    two verified, provably different people — guaranteed upstream by the type
 *    of `CollaborationOverlap`, not by this file's care.
 *
 * Presentation is deliberately the `IncompleteRecordingBanner` family — slate,
 * `role="status"`, no icons that read as warnings — and deliberately NOT the
 * amber/red vocabulary the flag surfaces use.
 */

import { hasCoverageFacts } from '@provenance/analysis-core/coverage/coverage-facts.js';
import type { CoverageFacts } from '@provenance/analysis-core/coverage/coverage-facts.js';
import { formatDuration } from './duration.js';

export type CoveragePanelProps = {
  /**
   * The already-computed facts, or `null` when the caller has none.
   *
   * The panel takes the AGGREGATE rather than a `Bundle` so that both surfaces
   * can feed it from the place that actually has the data: `/local` computes
   * `coverageFacts(bundle, index)` in the browser, and the server-backed route
   * reads `SubmissionSummary.coverage` off the wire, where the server ran the
   * identical function on the bundle it had already parsed. One renderer, one
   * computation, no second implementation to drift.
   *
   * `null` therefore no longer means "this view cannot compute them". It means
   * **the server did not send them** — a deployment older than the `coverage`
   * field — and renders as "not available", never as zeroes. See the header.
   */
  facts: CoverageFacts | null;
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section
      role="status"
      data-testid="submission-coverage-panel"
      className="rounded border border-slate-400 bg-slate-50 text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
    >
      <div className="border-b border-slate-300 px-4 py-2 dark:border-slate-700">
        <h2 className="text-sm font-medium">Recording coverage</h2>
        <p className="text-xs text-slate-600 dark:text-slate-400">
          What this record contains, and what it cannot show. These are facts about the recording,
          not findings about anyone.
        </p>
      </div>
      {children}
    </section>
  );
}

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="border-t border-slate-300 px-4 py-3 first:border-t-0 dark:border-slate-700"
      data-testid={testId}
    >
      <h3 className="mb-1.5 text-xs font-medium">{title}</h3>
      <div className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300">{children}</div>
    </div>
  );
}

export function CoveragePanel({ facts }: CoveragePanelProps) {
  // State 1 — no facts. Say so. Never render counts here: zeroes would assert
  // "no commits observed, no contributors, no root key", none of which was
  // established, and all of which read as a thinner record than the student has.
  if (facts === null) {
    return (
      <Frame>
        <Section title="Not available" testId="coverage-not-available">
          <p data-testid="coverage-not-available-note">
            This server did not send the coverage facts for this submission, which happens when it
            is running a version older than the one that reports them. Nothing here has been checked
            and found wanting — the facts simply were not fetched, and no conclusion about this
            submission follows from their absence.
          </p>
        </Section>
      </Frame>
    );
  }

  const {
    identity,
    concurrentRecording,
    multiMachineRecording,
    droppedArtifacts,
    unattestedTails,
    dagDefects,
    dagCoverage,
  } = facts;

  // State 2 — facts computed, nothing to note. Rule 3 wants the statement, not
  // an empty frame and not silence.
  if (!hasCoverageFacts(facts)) {
    return (
      <Frame>
        <Section title="Nothing to note" testId="coverage-nothing-to-note">
          <p data-testid="coverage-nothing-to-note-body">
            Every session in this submission is attributed to a verified contributor, no artifacts
            were left out of the analysis, and each log is covered end to end by its signature.
            There is nothing further to say about what this record can and cannot show.
          </p>
        </Section>
      </Frame>
    );
  }

  // State 3 — facts to state.
  return (
    <Frame>
      {/* -----------------------------------------------------------------
          Concurrent recording — the fact a suppressed overlap used to lose.
          ----------------------------------------------------------------- */}
      {concurrentRecording.length > 0 && (
        <Section title="Concurrent recording" testId="coverage-concurrent-recording">
          {concurrentRecording.map((f) => (
            <p key={`${f.sessionA}:${f.sessionB}`} data-testid="coverage-concurrent-row">
              <span className="font-medium">
                {f.contributorA} and {f.contributorB} recorded concurrently for{' '}
                {formatDuration(f.overlapMs)}.
              </span>{' '}
              Both identities are verified and are different people, so this is two partners working
              at the same time — the expected shape of collaboration, and not a finding.
              {f.crashBounded &&
                ' One of the two sessions has no session.end, so its extent is bounded at its last recorded event and the real overlap may be longer.'}
            </p>
          ))}
        </Section>
      )}

      {/* -----------------------------------------------------------------
          One student, two machines (D5) — a SEPARATE section, deliberately.
          Rendering this inside "Concurrent recording" would tell a grader
          two people collaborated when one person moved between their own
          machines. Two machines is not two people.
          ----------------------------------------------------------------- */}
      {multiMachineRecording.length > 0 && (
        <Section title="One contributor, two machines" testId="coverage-multi-machine-recording">
          {multiMachineRecording.map((f) => (
            <p key={`${f.sessionA}:${f.sessionB}`} data-testid="coverage-multi-machine-row">
              <span className="font-medium">
                {f.studentRef} recorded on two enrolled machines at the same time, for{' '}
                {formatDuration(f.overlapMs)}.
              </span>{' '}
              Both sessions verify to the same student, and each was signed by a different enrolled
              machine key — so this is one person&rsquo;s two machines, which is a supported setup,
              and not a finding. Enrolling a second machine is how it is meant to be done: each
              machine generates its own key and nothing is copied between them.
              {f.crashBounded &&
                ' One of the two sessions has no session.end, so its extent is bounded at its last recorded event and the real overlap may be longer.'}
            </p>
          ))}
        </Section>
      )}

      {/* -----------------------------------------------------------------
          Identity coverage.
          ----------------------------------------------------------------- */}
      <Section title="Identity coverage" testId="coverage-identity">
        {!identity.rootKeyConfigured ? (
          /*
           * NOT a failure. This deployment has no root public key, so no
           * identity chain of any version could be walked. Every identified
           * session reads "unverifiable" for that reason alone. Saying "these
           * identities failed verification" here would turn one unset
           * environment variable into a class-wide integrity finding.
           */
          <p data-testid="coverage-no-root-key">
            <span className="font-medium">No identity check was possible.</span> This deployment has
            no root public key configured, so no session&rsquo;s enrollment chain could be checked
            at all. This is a limit on what this analyzer can verify — nothing here was checked and
            found wanting, and nothing follows from it about any student.
          </p>
        ) : (
          <p data-testid="coverage-identity-counts">
            {identity.attributed} session{identity.attributed === 1 ? '' : 's'} attributed to a
            verified contributor; {identity.unverifiable} carrying an identity claim that is not
            being honoured; {identity.unattributed} with no identity block at all.
          </p>
        )}
        {identity.unattributed > 0 && (
          <p data-testid="coverage-unattributed-note">
            Sessions with no identity block are not attributed to anyone. The usual cause is that
            the student had not enrolled. This is an ordinary state, it is not a finding, and such
            sessions are never grouped with each other and never asserted to be different people.
          </p>
        )}
      </Section>

      {/* -----------------------------------------------------------------
          Commit-graph coverage.
          ----------------------------------------------------------------- */}
      {(dagCoverage.commits > 0 || dagDefects.length > 0) && (
        <Section title="Commit graph" testId="coverage-dag">
          <p data-testid="coverage-dag-counts">
            {dagCoverage.observedCommits} commit{dagCoverage.observedCommits === 1 ? '' : 's'} were
            observed by a recording session; {dagCoverage.witnessedOnlyCommits} appear only as a
            parent of another commit, so they existed but no surviving session recorded work at
            them.
          </p>
          {dagCoverage.witnessedOnlyCommits > 0 && (
            <p data-testid="coverage-witnessed-only-note">
              A witnessed-only commit says work happened that this record does not cover. It does
              not say who did that work, and it is not evidence of misconduct — a partner who was
              not recording produces exactly this.
            </p>
          )}
          {/*
            Reworded when D12's writer half landed. The old copy said the signed
            format "does not yet carry a repository discriminator", which stopped
            being true: the format carries `root_commit_sha` and all three
            recorders emit it.

            The case that reaches this paragraph is now broader than "no
            discriminator at all". It is "at least one observation named no
            repository", which covers a wholly unlabelled scope AND a mixed one
            where a partner's recorder did name theirs — so the copy has to be
            honest about both, and about the fact that a named repository is NOT
            merged with the unnamed ones. It must also stay a statement about the
            RECORDING: not naming a repository is what an older recorder and a
            shallow clone both do, and neither says anything about anybody.
          */}
          {facts.repositoryAssumedSingle && (
            <p data-testid="coverage-repo-assumed-single">
              One or more commits here name no repository, so those are folded into a single assumed
              repository. A recorder that predates the repository field, and a shallow clone whose
              root commit cannot be reached, both produce this. If more than one unnamed repository
              was really observed, the graph above merges them; commits that did name a repository
              are kept apart from the unnamed ones rather than assumed to be the same. This is a
              limit on what the graph can show, and it is not a finding.
            </p>
          )}
          {dagDefects.map((d, i) => (
            <p key={`${d.kind}-${i}`} data-testid="coverage-dag-defect">
              {d.kind === 'conflicting_parents' &&
                `Two signed chains claim different parents for commit ${d.sha.slice(0, 8)}…. Every claim is kept and no edge is asserted in either direction, so nothing downstream is ordered on it.`}
              {d.kind === 'cycle' &&
                `The observed commits ${d.shas.map((s) => s.slice(0, 8)).join(', ')} form a cycle, which real git cannot produce. No ordering is derived from them.`}
              {d.kind === 'unreadable_parents' &&
                `The parent list for commit ${d.sha.slice(0, 8)}… could not be read (${d.reason}). Its incoming edges are treated as unknown rather than as absent.`}
            </p>
          ))}
        </Section>
      )}

      {/* -----------------------------------------------------------------
          Unattested tails.
          ----------------------------------------------------------------- */}
      {unattestedTails.length > 0 && (
        <Section title="Unattested log tails" testId="coverage-unattested-tails">
          {unattestedTails.map((t) => (
            <p key={`${t.sessionId}:${t.file}`} data-testid="coverage-unattested-row">
              Session {t.sessionId.slice(0, 8)}… has {t.sealed} of {t.total} {t.unit} of its{' '}
              {t.file === 'slog' ? 'log' : 'log sidecar'} covered by a signature; the remaining{' '}
              {t.total - t.sealed} {t.unit} were written after the last seal.
            </p>
          ))}
          <p data-testid="coverage-unattested-note">
            A rolling seal is written on the checkpoint cadence, so it commits to a prefix. Any
            session ended by a crash, a power cut, a full disk, or an archive taken mid-session
            leaves a tail like this. It limits what can be verified; it is not evidence that the
            tail was altered.
          </p>
        </Section>
      )}

      {/* -----------------------------------------------------------------
          Dropped artifacts.
          ----------------------------------------------------------------- */}
      {droppedArtifacts.length > 0 && (
        <Section title="Files not analysed" testId="coverage-dropped-artifacts">
          {droppedArtifacts.map((a) => (
            <p key={a.filename} data-testid="coverage-dropped-row">
              <span className="font-mono text-[11px] font-medium">{a.filename}</span> — {a.detail}
            </p>
          ))}
          <p data-testid="coverage-dropped-note">
            These files were left out of the analysis because they could not be read as provenance
            records. They were not deleted, and their presence is not a finding — a crash-recovery
            leftover is the ordinary cause.
          </p>
        </Section>
      )}
    </Frame>
  );
}
