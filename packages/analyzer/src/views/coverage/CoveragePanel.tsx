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
 *  - **"not watched" is not misconduct, and is not even a defect.** The file
 *    scope section is EXCULPATORY: a file the recorder was never told to watch
 *    is a fact about the assignment manifest, and its silence is explained
 *    rather than suspicious. A recorder that reports no scope at all — every
 *    bundle before §5.6, permanently — reads as "this recorder does not
 *    report", never as something missing from the submission.
 *
 * ## Which of these sections render, and why they differ
 *
 * Git observation and file scope render unconditionally in state 3; peer
 * witnessing renders only when something reported or a witness was read. See the
 * comments at each one — the asymmetry is deliberate and is about which silence
 * is dangerous.
 *
 * ## Counts in the strip, explanations behind `Why`
 *
 * State 3 opens with a {@link StatStrip}: every count this panel states, on one
 * wrapped line, no prose. The paragraphs stay exactly as they were — same
 * wording, same `data-testid` — but the ones that fire on an ORDINARY recording
 * now sit inside a {@link Why} disclosure.
 *
 * The rule for what may fold, and the reason it is not "whatever is longest",
 * is on {@link Why}. In short: a paragraph that appears on every submission is
 * reassurance nobody asked for, and reassurance that is always on screen trains
 * a grader to skip the panel. A paragraph that appears because something unusual
 * and innocent happened — an overlap, two machines, a torn tail, a witness
 * discrepancy — is the one they must not miss, and it stays visible.
 *
 * A solo bundle from a current recorder therefore renders the strip and no
 * paragraphs at all, which is what it always should have said: this record is
 * ordinary. Before this, the same bundle rendered four sections of disclaimers
 * about partners it did not have.
 *
 * ## The capability wording is `log-core`'s, not this file's
 *
 * `describeGitCapture`, `describeWitnessCapture`,
 * `describeCapabilityValueProblem` and `describeFileScopeProblem` are the
 * canonical staff-facing sentences for these states, shared by this analyzer and
 * the three recorder repos so that four consumers cannot phrase one verdict four
 * ways. Where they appear below they are QUOTED, never paraphrased.
 *
 * They are per-SESSION sentences ("this session", "this machine") and the
 * summaries here are per-BUNDLE, so each use supplies its own bundle-level frame
 * — "every session in this submission reported the same thing: …". A helper
 * dropped straight into a bundle-level claim would say "this session" about a
 * set of sessions. The `'available'` cases are therefore NOT taken from the
 * helpers: "at least one session here" is a different assertion from
 * "this session", and there is no honest frame that makes the per-session
 * sentence true of a bundle where only some sessions reported it.
 *
 * Presentation is deliberately the `IncompleteRecordingBanner` family — slate,
 * `role="status"`, no icons that read as warnings — and deliberately NOT the
 * amber/red vocabulary the flag surfaces use.
 */

import {
  describeCapabilityValueProblem,
  describeFileScopeProblem,
  describeGitCapture,
  describeWitnessCapture,
} from '@provenance/log-core';
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
      className="rounded border border-slate-300 bg-slate-50 text-slate-900"
    >
      <div className="border-b border-slate-200 px-4 py-2">
        <h2 className="text-sm font-medium">Recording coverage</h2>
        <p className="text-xs text-slate-600">
          What this record covers, and what it cannot show. Facts about the recording, not findings
          about anyone.
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
    <div className="border-t border-slate-200 px-4 py-3 first:border-t-0" data-testid={testId}>
      <h3 className="mb-1.5 text-xs font-medium">{title}</h3>
      <div className="space-y-1.5 text-xs text-slate-700">{children}</div>
    </div>
  );
}

/**
 * The always-visible strip: one compact line per fact, no prose.
 *
 * Rule 3 says the coverage context has to be beside the flags, always visible.
 * It does not say it has to be four paragraphs. Every COUNT this panel used to
 * spend a sentence on lives here instead, keeping its original `data-testid` so
 * the claim it makes is still the claim under test — only the wrapper changed.
 *
 * Deliberately not a table and not a stat-card row: this must read as a caption
 * on the submission, not as another scoreboard competing with the flags.
 */
function StatStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-slate-200 px-4 py-2.5 first:border-t-0">
      <ul
        data-testid="coverage-stat-strip"
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700"
      >
        {children}
      </ul>
    </div>
  );
}

function Stat({
  children,
  testId,
  muted = false,
}: {
  children: React.ReactNode;
  testId: string;
  muted?: boolean;
}) {
  return (
    <li data-testid={testId} className={muted ? 'text-slate-500' : undefined}>
      {children}
    </li>
  );
}

/**
 * The explanation, folded away by default.
 *
 * ## Which prose is allowed behind this, and which is not
 *
 * ONLY the paragraphs that fire on an ordinary recording — a student who never
 * enrolled, a log nobody witnessed, a commit no session was recording at, a
 * capable session that ran no git command, a recorder that predates a §5.6
 * field. Those are the ones a grader meets on every submission, and reassurance
 * that is always on screen stops reading as reassurance: a panel that protests
 * on a submission where nothing happened teaches the reader to skip it, which is
 * exactly when they most need to read it.
 *
 * The rare-but-innocent facts — a concurrent overlap, two machines, a torn tail,
 * an unattested tail, a dropped artifact, a witness discrepancy, a DAG defect —
 * keep their defence ON SCREEN, undisclosed. `CoveragePanel.test.tsx`'s "is
 * visible without any disclosure" pins the first of those, and the rest share
 * its reasoning: a fact that could be misread is exactly the fact whose
 * explanation must not need a click. Passing that test by hiding the sentence
 * behind a control it happens not to match would be softening the requirement,
 * not meeting it.
 *
 * Native `<details>`, so the prose stays in the DOM and in the page's text for
 * find-in-page, and so no state has to be managed. It exposes no
 * `aria-expanded`, which is why it does not read as the collapsed control that
 * same test forbids — but the rule above, not that detail, is what keeps the
 * two kinds of paragraph apart.
 */
function Why({ children, label = 'why' }: { children: React.ReactNode; label?: string }) {
  return (
    <details className="mt-1" data-testid="coverage-why">
      <summary className="cursor-pointer list-none text-[11px] text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-slate-400">
        {label}
      </summary>
      <div className="mt-1.5 space-y-1.5 border-l-2 border-slate-200 pl-3 text-xs text-slate-600">
        {children}
      </div>
    </details>
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
    'The recorder saw this file leave the working tree — descriptive, not a finding. Checking out a branch that never had a partner’s log removes it, and so does a stash. The observation still carries the last state the recorder saw.',
  shrank:
    'The recorder saw this file get smaller. A branch switch and a fresh checkout both do that.',
  unparseable:
    'The recorder could not read this file as a provenance log. It did not rename, alter or remove it.',
};

/** How far a witnessing session's own identity got, said without insinuation. */
const WITNESS_AUTHORITY_NOTES: Readonly<Record<string, string>> = {
  unverifiable:
    'The observing session claims an identity that could not be verified, so this observation is recorded but not relied on.',
  unattributed:
    'The observing session has no name on it — usually a student who had not enrolled. Its chain verifies, so the observation is real.',
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
            This server did not send coverage facts — it is running a version older than the one
            that reports them. Nothing was checked and found wanting; the facts were not fetched.
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
    fileScope,
  } = facts;

  // State 2 — facts computed, nothing to note. Rule 3 wants the statement, not
  // an empty frame and not silence.
  if (!hasCoverageFacts(facts)) {
    return (
      <Frame>
        <Section title="Nothing to note" testId="coverage-nothing-to-note">
          <p data-testid="coverage-nothing-to-note-body">
            Every session is attributed to a verified contributor, nothing was left out of the
            analysis, and each log is covered end to end by its signature. There is nothing further
            to say about what this record can and cannot show.
          </p>
        </Section>
      </Frame>
    );
  }

  const identitySessions = identity.attributed + identity.unverifiable + identity.unattributed;

  // State 3 — facts to state.
  return (
    <Frame>
      {/* -----------------------------------------------------------------
          The strip: every COUNT this panel states, in one place, no prose.

          These carry their own `coverage-stat-*` ids rather than borrowing the
          ids of the sentences below. The sentences keep theirs — a claim under
          test stays on the element that makes it — so this strip adds a
          summary and takes nothing away.
          ----------------------------------------------------------------- */}
      <StatStrip>
        {/* `IdentityCoverage` carries the three buckets, not a total. Summing
            them here keeps the total a presentation detail rather than a
            fourth field the wire shape has to promise to keep consistent. */}
        <Stat testId="coverage-stat-sessions">
          {identitySessions} session{identitySessions === 1 ? '' : 's'}
        </Stat>
        {!identity.rootKeyConfigured ? (
          <Stat testId="coverage-stat-identity" muted>
            identity not checkable
          </Stat>
        ) : (
          identity.unverifiable + identity.unattributed > 0 && (
            <Stat testId="coverage-stat-identity" muted>
              {identity.unverifiable > 0 && `${identity.unverifiable} unverifiable`}
              {identity.unverifiable > 0 && identity.unattributed > 0 && ' · '}
              {identity.unattributed > 0 && `${identity.unattributed} unattributed`}
            </Stat>
          )
        )}
        {dagCoverage.commits > 0 && (
          <Stat testId="coverage-stat-commits">
            {dagCoverage.observedCommits} commit
            {dagCoverage.observedCommits === 1 ? '' : 's'} observed
            {dagCoverage.witnessedOnlyCommits > 0 &&
              ` · ${dagCoverage.witnessedOnlyCommits} witnessed-only`}
          </Stat>
        )}
        {gitObservation.availability !== 'unknown' && (
          <Stat testId="coverage-stat-git" muted={gitObservation.availability !== 'available'}>
            {gitObservation.availability === 'available' ? 'git observed' : 'git not observable'}
          </Stat>
        )}
        {witnessing.sessions > 0 && witnessing.capability !== 'unknown' && (
          <Stat testId="coverage-stat-witnessing" muted={witnessing.witnessedSessions === 0}>
            {witnessing.witnessedSessions} of {witnessing.sessions} log
            {witnessing.sessions === 1 ? '' : 's'} witnessed
          </Stat>
        )}
        {fileScope.reporting === 'reported' && (
          <Stat testId="coverage-stat-files">
            {fileScope.watchedFiles.length} file
            {fileScope.watchedFiles.length === 1 ? '' : 's'} watched
          </Stat>
        )}
      </StatStrip>

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
              Both are verified, and verified as different people — this is what collaboration looks
              like, and not a finding.
              {f.crashBounded &&
                ' One session has no session.end, so its extent stops at its last recorded event and the real overlap may be longer.'}
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
              Both sessions verify to the same student, each signed by a different enrolled machine
              key. This is one person&rsquo;s two machines — a supported setup, and not a finding.
              Each machine generates its own key; nothing is copied between them.
              {f.crashBounded &&
                ' One session has no session.end, so its extent stops at its last recorded event and the real overlap may be longer.'}
            </p>
          ))}
        </Section>
      )}

      {/* -----------------------------------------------------------------
          Identity coverage.
          ----------------------------------------------------------------- */}
      {/*
        Renders only when it has something a strip item cannot carry. The
        counts are in the strip; what is left is the deployment fact (kept ON
        SCREEN — "no identity check was possible" is what stops a grader
        reading unverifiable sessions as failed students) and the unattributed
        explanation, which is ordinary and folds away.
      */}
      {/*
        Unconditional in state 3, deliberately — an earlier draft rendered it
        only when a session was unverifiable or unattributed, which read well
        (a fully attributed bundle has no problem to state) but quietly removed
        the panel's ability to answer "how ARE these sessions attributed?" on a
        clean submission. `CoveragePanel.test.tsx`'s "shows counts instead when
        the root key IS configured" is that guarantee, and it costs one
        collapsed line to keep.
      */}
      <Section title="Identity coverage" testId="coverage-identity">
        {/*
         * NOT a failure. This deployment has no root public key, so no
         * identity chain of any version could be walked. Every identified
         * session reads "unverifiable" for that reason alone. Saying "these
         * identities failed verification" here would turn one unset
         * environment variable into a class-wide integrity finding.
         *
         * Stays visible: it is rare, and it is the sentence that stops a
         * page of "unverifiable" reading as a page of failed students.
         */}
        {!identity.rootKeyConfigured && (
          <p data-testid="coverage-no-root-key">
            <span className="font-medium">No identity check was possible.</span> This deployment has
            no root public key configured, so no enrollment chain could be checked. Nothing here was
            checked and found wanting.
          </p>
        )}
        {identity.rootKeyConfigured && (
          <Why label="attribution">
            <p data-testid="coverage-identity-counts">
              {identity.attributed} verified, {identity.unverifiable} claiming an identity that is
              not being honoured, {identity.unattributed} with no identity block.
            </p>
            {identity.unattributed > 0 && (
              <p data-testid="coverage-unattributed-note">
                A session with no identity block usually means the student had not enrolled — an
                ordinary state, not a finding. The log is real; it just has no name on it. These are
                never grouped together and never treated as different people.
              </p>
            )}
          </Why>
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
          {/*
            `impossible` stays visible; `available` and `unknown` fold away.
            The asymmetry is the same one that decides whether this section
            renders at all: "nothing here could witness anything" is a real
            limit on the record, while "something was watching" and "nobody
            said" are the two ordinary states a grader meets constantly.
          */}
          {witnessing.capability === 'impossible' && (
            /*
             * The middle sentence is `log-core`'s own, quoted rather than
             * paraphrased — see the module header on why the wording is
             * centralised. It is per-SESSION ("in this session"), which is why
             * the bundle-level lead has to introduce it as what every session
             * reported; the helper cannot be used as a bundle-level claim.
             */
            <p data-testid="coverage-witness-capability-impossible">
              <span className="font-medium">Nothing here could witness anything else.</span> Every
              session reported the same: {describeWitnessCapture('unavailable')} No log in this
              submission had the chance to be corroborated.
            </p>
          )}
          <Why label="witnessing">
            {witnessing.capability === 'available' && (
              <p data-testid="coverage-witness-capability-available">
                At least one session was watching the shared <code>.provenance/</code> directory.
              </p>
            )}
            {witnessing.capability === 'unknown' && (
              <p data-testid="coverage-witness-capability-unknown">
                Not every session reported whether it could watch the shared{' '}
                <code>.provenance/</code> directory, so an unwitnessed log here is unexplained:
                nothing saw it, or nothing was looking. Recorders only began reporting this
                recently.
              </p>
            )}
            {witnessing.sessions > 0 && (
              <p data-testid="coverage-witness-counts">
                {witnessing.witnessedSessions} of {witnessing.sessions} log
                {witnessing.sessions === 1 ? '' : 's'}{' '}
                {witnessing.witnessedSessions === 1 ? 'is' : 'are'} named by another session&rsquo;s
                signed chain.
              </p>
            )}
            {witnessing.unwitnessedSessions > 0 && (
              <p data-testid="coverage-unwitnessed-note">
                A log no witness names is the ordinary case: the partner may not have been
                recording, their recorder may predate witnessing, or their sessions never overlapped
                this one.
              </p>
            )}
            {witnessing.corroborated > 0 && (
              <p data-testid="coverage-witness-corroborated">
                {witnessing.corroborated} observation
                {witnessing.corroborated === 1 ? '' : 's'} match the log that is here, so the
                witnessed part of it is intact.
              </p>
            )}
          </Why>

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
              These have ordinary explanations: a partner who had not pushed when this archive was
              taken, a partner who kept recording after their last push, or a branch that never
              carried the file. They are shown so a grader can see them, not so anyone can be
              accused.
            </p>
          )}

          {witnessing.excluded > 0 && (
            <p data-testid="coverage-witness-excluded">
              {witnessing.excluded} observation{witnessing.excluded === 1 ? ' was' : 's were'} read
              and deliberately not used: a chain cannot vouch for itself, and whoever could alter
              one chain of the same contributor could alter both.
            </p>
          )}
          {witnessing.malformed > 0 && (
            <p data-testid="coverage-witness-malformed">
              {witnessing.malformed} observation
              {witnessing.malformed === 1 ? ' was' : 's were'} not in the shape this format defines,
              so {witnessing.malformed === 1 ? 'it was' : 'they were'} not used. That is about the
              recorder, not the student.
            </p>
          )}
        </Section>
      )}

      {/* -----------------------------------------------------------------
          Commit-graph coverage.
          ----------------------------------------------------------------- */}
      {(dagCoverage.commits > 0 || dagDefects.length > 0) && (
        <Section title="Commit graph" testId="coverage-dag">
          {/* Counts are in the strip. Both paragraphs here are the ordinary
              case — a witnessed-only commit is what a non-recording partner
              produces — so both fold away. The DAG defects below do not: a
              cycle or a conflicting parent is rare and needs its explanation
              on screen beside it. */}
          <Why label="coverage">
            <p data-testid="coverage-dag-counts">
              {dagCoverage.observedCommits} commit{dagCoverage.observedCommits === 1 ? '' : 's'}{' '}
              observed by a recording session, {dagCoverage.witnessedOnlyCommits} known only as the
              parent of another commit.
            </p>
            {dagCoverage.witnessedOnlyCommits > 0 && (
              <p data-testid="coverage-witnessed-only-note">
                Work happened at those commits that this record does not cover — a partner who was
                not recording produces exactly this. It says nothing about who did that work.
              </p>
            )}
          </Why>
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
              Some commits here name no repository, so those are folded into one assumed repository
              — if they really came from several, the graph merges them. Commits that did name a
              repository are kept apart from the unnamed ones. An older recorder and a shallow clone
              both produce this — a limit on the graph, not a finding.
            </p>
          )}
          {dagDefects.map((d, i) => (
            <p key={`${d.kind}-${i}`} data-testid="coverage-dag-defect">
              {d.kind === 'conflicting_parents' &&
                `Two signed chains claim different parents for commit ${d.sha.slice(0, 8)}…. Both claims are kept and no edge is drawn either way, so nothing downstream is ordered on it.`}
              {d.kind === 'cycle' &&
                `Commits ${d.shas.map((s) => s.slice(0, 8)).join(', ')} form a cycle, which real git cannot produce. No ordering is derived from them.`}
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
        {/*
          `impossible` and `unknown` stay visible; `available` folds away.
          The two silences are the dangerous ones — this section exists so a
          grader can tell "could not observe" from "nothing happened", and
          neither of those sentences may need a click to reach. "Git was
          available" carries no such risk.
        */}
        {gitObservation.availability === 'impossible' && (
          /*
           * The `describeGitCapture` sentences are `log-core`'s own, quoted
           * rather than paraphrased — one wording, four consumers. They are
           * per-SESSION statements, so each branch supplies its own bundle-level
           * frame around them; using a helper directly as a bundle-level claim
           * would say "this session" about a set of sessions.
           *
           * The closing sentence of each branch is NOT in the helper and must
           * not be dropped: "not because nothing was done" is the clause that
           * stops an incapacity from reading as inactivity.
           */
          <p data-testid="coverage-git-impossible">
            <span className="font-medium">The recorder could not see git.</span>{' '}
            {gitObservation.impossibleReason === 'mixed' ? (
              <>
                Sessions here reported two reasons. {describeGitCapture('unavailable')}{' '}
                {describeGitCapture('not_owned')} An absence of commits means nothing either way —
                not that nothing was done.
              </>
            ) : gitObservation.impossibleReason === 'not_owned' ? (
              <>
                {describeGitCapture('not_owned')} No commits were recorded because there was no
                repository to watch — not that nothing was done.
              </>
            ) : (
              <>
                {describeGitCapture('unavailable')} No commits were recorded because none could be
                gathered — not that nothing was done.
              </>
            )}
          </p>
        )}
        {gitObservation.availability === 'unknown' && (
          <p data-testid="coverage-git-unknown">
            This recorder does not report whether it could see git, so an absence of commits here is{' '}
            <em>unexplained</em>: no git activity happened, or git was never observable. Recorders
            only began reporting this recently, so it is not a defect and it is not a finding.
          </p>
        )}

        {/*
          `coverage-git-available` is gone rather than shortened. Every word of
          it was scaffolding: it announced that a breakdown followed, and then
          explained why the breakdown is per session. The strip already says
          "git observed" and the per-session rows say the rest.
        */}
        <Why label="per session">
          {gitObservation.observing > 0 && (
            <p data-testid="coverage-git-observing">
              {gitObservation.observing} of {gitObservation.sessions} session
              {gitObservation.sessions === 1 ? '' : 's'} recorded a commit.
            </p>
          )}
          {gitObservation.silentAndIncapable > 0 && (
            <p data-testid="coverage-git-silent-incapable">
              {gitObservation.silentAndIncapable} recorded no commits and could not see git — that
              silence is already explained.
            </p>
          )}
          {gitObservation.silentThoughCapable > 0 && (
            <p data-testid="coverage-git-silent-capable">
              {gitObservation.silentThoughCapable} recorded no commits while git was working, so no
              git command ran. Most sessions look like this.
            </p>
          )}
          {gitObservation.silentAndUnreported > 0 && (
            <p data-testid="coverage-git-silent-unreported">
              {gitObservation.silentAndUnreported} recorded no commits and did not say whether git
              was visible, so that silence stays ambiguous.
            </p>
          )}
        </Why>
        {gitObservation.malformed > 0 && (
          /*
           * The reason comes from `log-core`'s `describeCapabilityValueProblem`
           * rather than from a literal here. The literal used to say "a value
           * this format does not define", which is only ever true of
           * `unknown_value` — a session that reported a NON-STRING is counted in
           * the same total and was being described as something it was not.
           */
          <p data-testid="coverage-git-malformed">
            {gitObservation.malformed} session
            {gitObservation.malformed === 1 ? '' : 's'} reported a git-capture value that could not
            be used
            {gitObservation.malformedProblems.length > 0 &&
              `: ${gitObservation.malformedProblems.map(describeCapabilityValueProblem).join('; ')}`}
            . That is about the recorder, not the student.
          </p>
        )}
      </Section>

      {/* -----------------------------------------------------------------
          File scope (§5.6 item 1) — which files were actually being watched.

          UNCONDITIONAL in state 3, for the same reason "Git observation" is:
          the sentence it says on a legacy bundle — "this recorder does not
          report which files it was watching, so a file's silence is
          unresolved" — is precisely what stops a grader reading an empty
          Source tab as "the student never touched these files".

          Nothing in this section is a finding IN EITHER DIRECTION, which is
          the part that is easy to get wrong. "Not watched" is not misconduct
          and is not even a defect: the recorder watches what the assignment
          manifest told it to watch, so a file outside the scope is a course
          configuration fact. It is EXCULPATORY — it explains a silence that
          would otherwise be read as inactivity.

          Per-file rows are rendered only for a file that is BOTH provably
          outside every watched scope AND silent in this record. A file with
          activity has no ambiguity to resolve, and listing it as "not
          watched" beside its own events would read as a contradiction rather
          than as context.

          Like git observation, it does NOT feed `hasCoverageFacts`: a bundle
          whose only "fact" is that nothing reported still says "nothing to
          note".
          ----------------------------------------------------------------- */}
      <Section title="File scope" testId="coverage-file-scope">
        {fileScope.reporting === 'unreported' && (
          <p data-testid="coverage-file-scope-unreported">
            This recorder does not report which files it watched, so a silent file here is{' '}
            <em>unexplained</em>: nothing happened in it, or nothing was watching it. Recorders only
            began reporting this recently, so it is not a defect and it is not a finding.
          </p>
        )}
        {fileScope.reporting === 'partial' && (
          <p data-testid="coverage-file-scope-partial">
            Only some sessions reported which files they watched, so this is a lower bound. A file
            missing from it may still have been watched by a session that said nothing.
          </p>
        )}
        {/* The only one of the three that folds away: a complete scope is the
            healthy reading, and its count is already in the strip. `unreported`
            and `partial` stay visible — each is the sentence that stops a
            file's silence being read as inactivity. */}
        {fileScope.reporting === 'reported' && (
          <Why label="scope">
            <p data-testid="coverage-file-scope-reported">
              Every session reported its watched files. {fileScope.watchedFiles.length} file
              {fileScope.watchedFiles.length === 1 ? ' was' : 's were'} under observation.
            </p>
          </Why>
        )}
        {fileScope.incompleteSessions > 0 && (
          <p data-testid="coverage-file-scope-incomplete">
            {fileScope.incompleteSessions} session
            {fileScope.incompleteSessions === 1 ? '' : 's'} hit the format&rsquo;s cap on this list,
            so a file it does not name may still have been watched. A capped list can show a file{' '}
            <em>was</em> watched; it can never show one was not.
          </p>
        )}
        {fileScope.malformedSessions > 0 && (
          /* Reasons come from `log-core`'s `describeFileScopeProblem`, which
             names the problem and never quotes the offending path — that
             privacy check is why the reader inspects the value at all. */
          <p data-testid="coverage-file-scope-malformed">
            {fileScope.malformedSessions} session
            {fileScope.malformedSessions === 1 ? '' : 's'} reported a file scope that could not be
            read
            {fileScope.malformedProblems.length > 0 &&
              `: ${fileScope.malformedProblems.map(describeFileScopeProblem).join('; ')}`}
            . It was set aside whole, so nothing was narrowed. That is about the recorder, not the
            student.
          </p>
        )}

        {fileScope.files
          .filter((f) => f.watched === 'not_watched' && !f.recordedActivity)
          .map((f) => (
            <p key={f.path} data-testid="coverage-file-not-watched">
              <span className="font-mono text-[11px] font-medium">{f.path}</span> — under review but
              outside every watched scope, so nothing was recording it. That alone explains the
              silence.
            </p>
          ))}
        {fileScope.files.some((f) => f.watched === 'not_watched' && !f.recordedActivity) && (
          <p data-testid="coverage-file-not-watched-note">
            The recorder watches what the assignment manifest tells it to watch, so this is about
            the assignment&rsquo;s configuration, not the student. Nothing here is a finding.
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
            The recorder appends one whole line at a time, so an unterminated last line means the
            write was interrupted — a power cut, a full disk, the editor killed mid-flush. The
            fragment was skipped by the analysis only; nothing was altered or deleted, and the
            digest checks still compare the archived bytes in full. If a signed checkpoint names a
            sequence number inside the lost fragment, it reads as a missing entry — same
            interruption, not a removal.
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
            A rolling seal is rewritten on the checkpoint cadence, so it only ever commits to a
            prefix. A crash, a power cut, a full disk, or an archive taken mid-session all leave a
            tail like this. It limits what can be verified; it is not evidence the tail was altered.
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
            These could not be read as provenance records, so the analysis skipped them. They were
            not deleted. A crash-recovery leftover is the usual cause.
          </p>
        </Section>
      )}
    </Frame>
  );
}
