/**
 * CoveragePanel — what the record does and does not contain, stated as fact.
 *
 * Spec §6 Rule 3. Nothing in this panel is a Flag, contributes to a score, or
 * fails a check, and the copy is written so that a grader skim-reading it cannot
 * come away with an accusation.
 *
 * The wording rules it exists to enforce, each of which has cost this project a
 * real false accusation:
 *
 *  - **Absence is never suspicious.** A student who never enrolled, a session
 *    with no `git.event`, a deployment with no root key: all render as limits on
 *    what we can see, never as something the student did.
 *  - **"Cannot check" is not "failed".** `rootKeyConfigured === false` renders as
 *    "no identity check was possible", in the neutral palette, and the word
 *    "failed" does not appear on that path.
 *  - **What is established is separate from what is inferred.** Each section
 *    leads with the fact and then says what it does and does not support.
 *
 * Presentation is deliberately the `IncompleteRecordingBanner` family — slate,
 * `role="status"`, no icons that read as warnings — and deliberately NOT the
 * amber/red vocabulary the flag surfaces use.
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import { coverageFacts, formatDuration, hasCoverageFacts } from './coverage-facts.js';

export type CoveragePanelProps = {
  /**
   * The parsed bundle, or `null` when the caller has none.
   *
   * `null` renders NOTHING. That is the server-backed Replay tab, which builds
   * its index from API rows: the honest answer there is that these facts were
   * not fetched, and a panel full of zeroes would state a stronger and false
   * one — "no commits observed, no contributors, no root key".
   */
  bundle: Bundle | null;
  index: EventIndex;
};

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
    <section className="border-t px-4 py-3 first:border-t-0" data-testid={testId}>
      <h3 className="mb-1.5 text-xs font-medium text-foreground">{title}</h3>
      <div className="space-y-1.5 text-xs text-muted-foreground">{children}</div>
    </section>
  );
}

export function CoveragePanel({ bundle, index }: CoveragePanelProps) {
  const [open, setOpen] = useState(false);

  const facts = useMemo(
    () => (bundle === null ? null : coverageFacts(bundle, index)),
    [bundle, index],
  );

  if (facts === null || !hasCoverageFacts(facts)) return null;

  const {
    identity,
    concurrentRecording,
    droppedArtifacts,
    unattestedTails,
    dagDefects,
    dagCoverage,
  } = facts;

  return (
    <div
      className="shrink-0 border-t bg-background"
      role="status"
      data-testid="replay-coverage-panel"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        data-testid="replay-coverage-toggle"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className="font-medium">Recording coverage</span>
        <span className="text-muted-foreground">
          — what this record contains, and what it cannot show. Not findings.
        </span>
      </button>

      {open && (
        <div className="max-h-64 overflow-auto border-t bg-slate-500/5">
          {/* ---------------------------------------------------------------
              Concurrent recording — the fact a suppressed overlap used to lose.
              --------------------------------------------------------------- */}
          {concurrentRecording.length > 0 && (
            <Section title="Concurrent recording" testId="coverage-concurrent-recording">
              {concurrentRecording.map((f) => (
                <p key={`${f.sessionA}:${f.sessionB}`} data-testid="coverage-concurrent-row">
                  <span className="text-foreground">
                    {f.contributorA} and {f.contributorB} recorded concurrently for{' '}
                    {formatDuration(f.overlapMs)}.
                  </span>{' '}
                  Both identities are verified and are different people, so this is two partners
                  working at the same time — the expected shape of collaboration, and not a finding.
                  {f.crashBounded &&
                    ' One of the two sessions has no session.end, so its extent is bounded at its last recorded event and the real overlap may be longer.'}
                </p>
              ))}
            </Section>
          )}

          {/* ---------------------------------------------------------------
              Identity coverage.
              --------------------------------------------------------------- */}
          <Section title="Identity coverage" testId="coverage-identity">
            {!identity.rootKeyConfigured ? (
              /*
               * NOT a failure. This deployment has no root public key, so no
               * identity chain of any version could be walked. Every identified
               * session reads "unverifiable" for that reason alone. Saying
               * "these identities failed verification" here would turn one unset
               * environment variable into a class-wide integrity finding.
               */
              <p data-testid="coverage-no-root-key">
                <span className="text-foreground">No identity check was possible.</span> This
                deployment has no root public key configured, so no session&rsquo;s enrollment chain
                could be checked at all. This is a limit on what this analyzer can verify — nothing
                here was checked and found wanting, and nothing follows from it about any student.
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
                Sessions with no identity block are not attributed to anyone. The usual cause is
                that the student had not enrolled. This is an ordinary state, it is not a finding,
                and such sessions are never grouped with each other and never asserted to be
                different people.
              </p>
            )}
          </Section>

          {/* ---------------------------------------------------------------
              Commit-graph coverage.
              --------------------------------------------------------------- */}
          {(dagCoverage.commits > 0 || dagDefects.length > 0) && (
            <Section title="Commit graph" testId="coverage-dag">
              <p data-testid="coverage-dag-counts">
                {dagCoverage.observedCommits} commit
                {dagCoverage.observedCommits === 1 ? '' : 's'} were observed by a recording session;{' '}
                {dagCoverage.witnessedOnlyCommits} appear only as a parent of another commit, so
                they existed but no surviving session recorded work at them.
              </p>
              {dagCoverage.witnessedOnlyCommits > 0 && (
                <p data-testid="coverage-witnessed-only-note">
                  A witnessed-only commit says work happened that this record does not cover. It
                  does not say who did that work, and it is not evidence of misconduct — a partner
                  who was not recording produces exactly this.
                </p>
              )}
              {facts.repositoryAssumedSingle && (
                <p data-testid="coverage-repo-assumed-single">
                  The signed log format does not yet carry a repository discriminator, so every
                  commit here is folded into one assumed repository. If this submission really
                  observed more than one repository, the graph above merges them.
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

          {/* ---------------------------------------------------------------
              Unattested tails.
              --------------------------------------------------------------- */}
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

          {/* ---------------------------------------------------------------
              Dropped artifacts.
              --------------------------------------------------------------- */}
          {droppedArtifacts.length > 0 && (
            <Section title="Files not analysed" testId="coverage-dropped-artifacts">
              {droppedArtifacts.map((a) => (
                <p key={a.filename} data-testid="coverage-dropped-row">
                  <span className="font-mono text-[11px] text-foreground">{a.filename}</span> —{' '}
                  {a.detail}
                </p>
              ))}
              <p data-testid="coverage-dropped-note">
                These files were left out of the analysis because they could not be read as
                provenance records. They were not deleted, and their presence is not a finding — a
                crash-recovery leftover is the ordinary cause.
              </p>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
