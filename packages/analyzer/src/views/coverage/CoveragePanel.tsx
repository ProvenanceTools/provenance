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
 *  - **Two machines is not two people.** One student on two independently
 *    enrolled machines (D5) gets its OWN section, never a concurrent-recording
 *    row. Merging them would tell a grader that two students collaborated when
 *    one person moved between their own machines — the same class of fabricated
 *    relationship as the rules above, pointing the other way.
 *  - **"nobody reported" is not "the answer was no".** The two §5.6 sections —
 *    peer witnessing and git observation — each have a THIRD state for a
 *    recorder that says nothing, and it is the permanent state of every bundle
 *    recorded before those fields existed. It renders as an open question, never
 *    as `impossible` and never as a deficiency. `unwitnessed` in particular is
 *    stated as the ordinary case, and `disappeared` is stated as a description
 *    of what a file did, with a branch checkout and a stash named as the causes.
 *  - **"could not observe" is not "nothing happened".** The git section exists
 *    so a grader can tell those two apart. Both are stated; neither is implied.
 *
 * ## Which of these sections render, and why they differ
 *
 * Git observation renders unconditionally in state 3; peer witnessing renders
 * only when something reported or a witness was read. See the comments at each
 * one — the asymmetry is deliberate and is about which silence is dangerous.
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

/**
 * What each `peer.observed` state is worth saying out loud, and what it is not.
 *
 * Only the three states that invite a wrong reading get a note. `appeared` and
 * `grew` are what a partner recording normally looks like and are left silent —
 * annotating them would pad a list a grader is already reading for signal.
 *
 * Every note here exists to say the SAME thing in three different shapes: the
 * state is what the recorder saw happen to a file, and an ordinary git operation
 * produces each one. `disappeared` is the one that has to be got right —
 * `log-core/events.ts` is explicit that it is not evidence of misconduct,
 * because checking out a branch that never contained a partner's log removes it
 * from the working tree, and so does a stash.
 */
const OBSERVED_STATE_NOTES: Readonly<Record<string, string>> = {
  disappeared:
    'At some point the recorder saw this file leave the working tree. That is descriptive, not a finding: checking out a branch that never contained a partner’s log removes it, and so does a stash. What the observation still carries is the last state the recorder saw.',
  shrank:
    'At some point the recorder saw this file get smaller than it had been. On its own that is not evidence of anything — a branch switch and a fresh checkout both produce it.',
  unparseable:
    'At some point the recorder could not read this file as a provenance log. It did not rename, alter or remove it; recording what it saw is the entire response.',
};

/** How far a witnessing session's own identity got, said without insinuation. */
const WITNESS_AUTHORITY_NOTES: Readonly<Record<string, string>> = {
  unverifiable:
    'The session that made this observation asserts an identity that could not be verified, so the observation is recorded and is not being relied on.',
  unattributed:
    'The session that made this observation is not attributed to anyone — the usual cause is a student who had not enrolled. Its own chain verifies, so the observation is real; it simply has no name attached to it.',
};

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
    tornTails,
    unattestedTails,
    dagDefects,
    dagCoverage,
    witnessing,
    gitObservation,
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
          Peer witnessing (§5.5).

          Rendered only when something ACTUALLY REPORTED — a capability
          report, or a witness that was read. A bundle whose recorder predates
          peer witnessing has nothing to say here, and "0 of 3 logs are
          witnessed" said about such a bundle is an invitation to read absence
          as suspicion. The section stays away rather than volunteer it.
          ----------------------------------------------------------------- */}
      {(witnessing.capability !== 'unknown' ||
        witnessing.corroborated > 0 ||
        witnessing.discrepancies.length > 0 ||
        witnessing.excluded > 0 ||
        witnessing.malformed > 0) && (
        <Section title="Peer witnessing" testId="coverage-witnessing">
          {witnessing.capability === 'available' && (
            <p data-testid="coverage-witness-capability-available">
              At least one session here was watching the shared <code>.provenance/</code> directory,
              so what it did and did not see about the other logs is on the record.
            </p>
          )}
          {witnessing.capability === 'impossible' && (
            <p data-testid="coverage-witness-capability-impossible">
              <span className="font-medium">
                No session here was able to witness any other log.
              </span>{' '}
              Every session reported that it could not watch the shared <code>.provenance/</code>{' '}
              directory, so nothing in this submission could have been witnessed by anything else in
              it. That is a limit on what this record can show, and it is not something anyone did.
            </p>
          )}
          {witnessing.capability === 'unknown' && (
            <p data-testid="coverage-witness-capability-unknown">
              Not every session here reported whether it could watch the shared{' '}
              <code>.provenance/</code> directory, so we cannot say whether a log went unwitnessed
              because nothing saw it or because nothing was looking. Recorders only began reporting
              this recently; every submission recorded before then is in this state, and nothing
              follows from it.
            </p>
          )}

          {witnessing.sessions > 0 && (
            <p data-testid="coverage-witness-counts">
              {witnessing.witnessedSessions} of {witnessing.sessions} log
              {witnessing.sessions === 1 ? '' : 's'} in this submission{' '}
              {witnessing.witnessedSessions === 1 ? 'is' : 'are'} named by another session&rsquo;s
              signed chain.
            </p>
          )}
          {witnessing.unwitnessedSessions > 0 && (
            <p data-testid="coverage-unwitnessed-note">
              The other {witnessing.unwitnessedSessions}{' '}
              {witnessing.unwitnessedSessions === 1 ? 'is' : 'are'} named by no witness. That is the
              ordinary case and it is not a finding: the partner may not have been recording, their
              recorder may predate peer witnessing, or their sessions may simply never have
              overlapped this one. Nothing about the student, or about the log, follows from it.
            </p>
          )}
          {witnessing.corroborated > 0 && (
            <p data-testid="coverage-witness-corroborated">
              {witnessing.corroborated} observation
              {witnessing.corroborated === 1 ? '' : 's'} match the log that is here at the point
              {witnessing.corroborated === 1 ? ' it was' : ' they were'} taken, so the witnessed
              part of that log is intact.
            </p>
          )}

          {witnessing.discrepancies.map((d) => (
            <p
              key={`${d.file}:${d.verdict}`}
              data-testid="coverage-witness-discrepancy"
              data-verdict={d.verdict}
            >
              <span className="font-mono text-[11px] font-medium">{d.file}</span>
              {d.observations > 1 && (
                <span className="text-slate-500 dark:text-slate-400">
                  {' '}
                  (observed {d.observations} times)
                </span>
              )}{' '}
              — {d.detail}
              {d.states.map(
                (s) =>
                  OBSERVED_STATE_NOTES[s] !== undefined && (
                    <span key={s} data-testid="coverage-witness-state-note">
                      {' '}
                      {OBSERVED_STATE_NOTES[s]}
                    </span>
                  ),
              )}
              {WITNESS_AUTHORITY_NOTES[d.authority] !== undefined && (
                <span data-testid="coverage-witness-authority-note">
                  {' '}
                  {WITNESS_AUTHORITY_NOTES[d.authority]}
                </span>
              )}
            </p>
          ))}
          {witnessing.discrepancies.length > 0 && (
            <p data-testid="coverage-witness-discrepancy-note">
              An observation that does not line up with the log that is here says nothing about who
              altered anything, and each of these has ordinary explanations too: a partner who had
              not pushed when this archive was taken, a partner who kept recording after their last
              push, or a branch that never carried the file. They are stated so a grader can see
              them, not so anyone can be accused.
            </p>
          )}

          {witnessing.excluded > 0 && (
            <p data-testid="coverage-witness-excluded">
              {witnessing.excluded} observation{witnessing.excluded === 1 ? ' was' : 's were'} read
              and deliberately not used. A chain cannot vouch for itself, and an observation about
              another session of the same proven contributor is not independent evidence — whoever
              could alter one of those chains could alter both.
            </p>
          )}
          {witnessing.malformed > 0 && (
            <p data-testid="coverage-witness-malformed">
              {witnessing.malformed} observation
              {witnessing.malformed === 1 ? ' could' : 's could'} not be read in the shape this
              format defines, so {witnessing.malformed === 1 ? 'it was' : 'they were'} not used.
              That is a fact about the recorder that wrote them; nothing is concluded from it about
              anyone.
            </p>
          )}
        </Section>
      )}

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
          Git observation (§5.6 item 2) — the caveat the commit graph is read
          against, so it sits directly under it.

          UNCONDITIONAL, unlike peer witnessing above. The difference is that
          this section always has something true to say, and the thing it says
          on a legacy bundle — "this recorder does not report whether git was
          observable, so an absence of git evidence here is unresolved" — is
          precisely the sentence that stops silence from implying git was fine.
          A `git_unrecorded_in` classification is readable only with this
          paragraph in front of it, and that classification does not require the
          bundle to have observed a single commit. Given this project's history,
          the cost of one neutral paragraph on a submission nobody asked a git
          question about is the cheaper of the two errors.

          It does NOT feed `hasCoverageFacts`: a bundle whose only "fact" is
          that nothing reported still says "nothing to note".
          ----------------------------------------------------------------- */}
      <Section title="Git observation" testId="coverage-git-observation">
        {gitObservation.availability === 'available' && (
          <p data-testid="coverage-git-available">
            Git observation was reported as available to at least one session here. What each
            session did and did not see is broken down below — deliberately per session, because
            &ldquo;available to one of them&rdquo; is not &ldquo;available to all of them&rdquo;,
            and a bundle can carry sessions from more than one machine.
          </p>
        )}
        {gitObservation.availability === 'impossible' && (
          <p data-testid="coverage-git-impossible">
            <span className="font-medium">No git evidence could be collected here.</span>{' '}
            {gitObservation.impossibleReason === 'not_owned'
              ? 'Every session reported that git observation worked but that this assignment sat outside any repository it could see. There is no git evidence in this record because there was no repository to observe — not because nothing was done.'
              : gitObservation.impossibleReason === 'mixed'
                ? 'Some sessions reported that git observation was unavailable to them, and others reported that the assignment sat outside any repository they could see. Either way nothing could be observed, so the absence of git evidence in this record says nothing about what was done.'
                : 'Every session reported that git observation was unavailable to it — the editor’s git integration was not present, or could not be reached. There is no git evidence in this record because none could be gathered — not because nothing was done.'}
          </p>
        )}
        {gitObservation.availability === 'unknown' && (
          <p data-testid="coverage-git-unknown">
            This submission&rsquo;s recorder does not report whether git observation was available
            to it. An absence of git evidence here is therefore <em>unresolved</em>: it is equally
            consistent with no git activity having happened and with git never having been
            observable. Recorders only began reporting this recently, so every submission recorded
            before then is permanently in this state. It is not a defect and it is not a finding.
          </p>
        )}

        {gitObservation.observing > 0 && (
          <p data-testid="coverage-git-observing">
            {gitObservation.observing} of {gitObservation.sessions} session
            {gitObservation.sessions === 1 ? '' : 's'} recorded at least one commit.
          </p>
        )}
        {gitObservation.silentAndIncapable > 0 && (
          <p data-testid="coverage-git-silent-incapable">
            {gitObservation.silentAndIncapable} session
            {gitObservation.silentAndIncapable === 1 ? '' : 's'} recorded no commits and reported
            that {gitObservation.silentAndIncapable === 1 ? 'it' : 'they'} could not observe git.
            That silence is fully explained by what{' '}
            {gitObservation.silentAndIncapable === 1 ? 'that session' : 'those sessions'} could see,
            and nothing further should be read into it.
          </p>
        )}
        {gitObservation.silentThoughCapable > 0 && (
          <p data-testid="coverage-git-silent-capable">
            {gitObservation.silentThoughCapable} session
            {gitObservation.silentThoughCapable === 1 ? '' : 's'} recorded no commits and reported
            that git was available. So no git command ran while{' '}
            {gitObservation.silentThoughCapable === 1 ? 'it was' : 'they were'} recording — which is
            the ordinary shape of most honest sessions, and is not a finding.
          </p>
        )}
        {gitObservation.silentAndUnreported > 0 && (
          <p data-testid="coverage-git-silent-unreported">
            {gitObservation.silentAndUnreported} session
            {gitObservation.silentAndUnreported === 1 ? '' : 's'} recorded no commits and said
            nothing about whether git could be observed, so that silence stays ambiguous. It is
            exactly as ambiguous as it has always been; nothing has been checked and found wanting.
          </p>
        )}
        {gitObservation.malformed > 0 && (
          <p data-testid="coverage-git-malformed">
            {gitObservation.malformed} session
            {gitObservation.malformed === 1 ? '' : 's'} reported a git-capture value this format
            does not define, so that report could not be used. That is a fact about the recorder,
            never about the student.
          </p>
        )}
      </Section>

      {/* -----------------------------------------------------------------
          Torn final lines — an interrupted write, absorbed rather than fatal.

          Separate from "Files not analysed" on purpose. That section says a
          file was left out; this one says a file WAS analysed, minus an
          incomplete fragment on the end. Folding them together would tell a
          grader that a session they can see in full was excluded.
          ----------------------------------------------------------------- */}
      {tornTails.length > 0 && (
        <Section title="Interrupted writes" testId="coverage-torn-tails">
          {tornTails.map((t) => (
            <p key={t.sessionId} data-testid="coverage-torn-row">
              Session {t.sessionId.slice(0, 8)}… ends part-way through line {t.line}:{' '}
              {t.discardedChars} character(s) with no line terminator, which are not a complete
              entry. Everything before that point was analysed in full.
            </p>
          ))}
          <p data-testid="coverage-torn-note">
            The recorder appends one whole line at a time, so an unterminated final line is the
            signature of a write that was interrupted — a power cut, a full disk, the editor killed
            mid-flush. The fragment was left out of the analysis only; nothing was altered or
            deleted, and the digest checks still compare the archived bytes in full. If a signed
            checkpoint names a sequence number inside the lost fragment it will read as a missing
            entry — that is this same interruption, not a removal.
          </p>
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
