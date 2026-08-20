/**
 * BranchedFileView — what the replay pane shows when the file at the playhead
 * has no single content.
 *
 * Spec: `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` §6
 * Rule 4 — "a replay position inside a concurrent interval shows the branches
 * side by side, or refuses with an explanation. It does not pick one and it does
 * not interleave."
 *
 * ## The two states are not one state
 *
 * `concurrent` and `unknown` are rendered by two different branches of this
 * component, with different headings, different body copy and different
 * `data-testid`s, because they are different facts:
 *
 *  - `concurrent` — we hold the records, we ordered everything the evidence
 *    orders, and the answer is that these lineages are genuinely unordered.
 *    That is a POSITIVE statement about the evidence, and the branches are
 *    shown, because they are the evidence.
 *  - `unknown` — the happens-before relation does not reach some of these
 *    events. There is nothing to show side by side, because we are not saying
 *    the edits raced; we are saying we cannot see.
 *
 * ## Why no branch is ever preferred
 *
 * The branches render in a list, every one of them, and the component takes no
 * "selected branch" prop. There is deliberately no affordance that reduces the
 * pane to one lineage: a control labelled "show Alice's version" is one
 * screenshot away from being read as "this is what Alice submitted", and the
 * whole point is that no such file existed. Branch order is the order
 * analysis-core produced, which is contributor-key sorted and therefore stable
 * across reloads — not a ranking.
 *
 * This is a refusal surface, so it deliberately does NOT use the Monaco editor
 * the determinate path uses. Rendering a branch in the same chrome as the real
 * replay is exactly how a reader comes away believing they saw the file.
 */

import type { AmbiguousReconstruction } from './engine-core.js';
import {
  describeAmbiguityKind,
  labelSessionContributor,
  type ContributorTone,
} from './contributor-labels.js';

// ---------------------------------------------------------------------------
// Tone → presentation
// ---------------------------------------------------------------------------

/**
 * Visual treatment per contributor tone.
 *
 * The two `unverifiable` tones get visibly different chrome, which is the whole
 * reason {@link ContributorTone} has four values. `identity_not_checked` is
 * slate — the same neutral family as `unattributed`, because neither is a
 * finding — while `identity_check_failed` is amber, because it is one.
 */
const TONE_CHROME: Record<ContributorTone, { badge: string; label: string }> = {
  attributed: {
    badge: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    label: 'Verified identity',
  },
  unattributed: {
    badge: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
    label: 'No identity recorded',
  },
  identity_not_checked: {
    badge: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
    label: 'Identity not checked',
  },
  identity_check_failed: {
    badge: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    label: 'Identity did not verify',
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type BranchedFileViewProps = {
  filePath: string;
  /** The engine's verdict for this path at the current playhead. */
  ambiguity: AmbiguousReconstruction;
};

export function BranchedFileView({ filePath, ambiguity }: BranchedFileViewProps) {
  const copy = describeAmbiguityKind(ambiguity.kind, filePath);

  // -------------------------------------------------------------------------
  // `unknown` — the absence of a record. Nothing to compare.
  // -------------------------------------------------------------------------
  if (ambiguity.kind === 'unknown') {
    return (
      <div
        className="flex h-full w-full items-start justify-center overflow-auto p-8"
        data-testid="replay-ambiguous"
        data-ambiguity-kind="unknown"
      >
        <div className="max-w-2xl">
          <p
            className="mb-2 text-sm font-medium text-foreground"
            data-testid="replay-ambiguous-title"
          >
            {copy.title}
          </p>
          <p className="text-sm text-muted-foreground" data-testid="replay-ambiguous-body">
            {copy.body}
          </p>
          <p className="mt-4 text-xs text-muted-foreground" data-testid="replay-unknown-detail">
            {ambiguity.detail}
          </p>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // `concurrent` — we have the branches. Show all of them.
  // -------------------------------------------------------------------------
  const branches = ambiguity.branches;

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid="replay-ambiguous"
      data-ambiguity-kind="concurrent"
    >
      <div className="shrink-0 border-b px-6 py-4">
        <p className="mb-2 text-sm font-medium text-foreground" data-testid="replay-ambiguous-title">
          {copy.title}
        </p>
        <p className="text-sm text-muted-foreground" data-testid="replay-ambiguous-body">
          {copy.body}
        </p>
        <p
          className="mt-3 text-xs text-muted-foreground"
          data-testid="replay-divergence-detail"
        >
          {ambiguity.divergence.detail}
        </p>
      </div>

      {/*
        A grid rather than a two-pane split: `concurrent` is "two or more", and a
        hard-coded left/right would silently drop a third lineage — the case a
        three-way branch produces, and the one nobody would notice was missing.
      */}
      <div
        className="grid min-h-0 flex-1 gap-px overflow-auto bg-border"
        style={{ gridTemplateColumns: `repeat(${Math.min(branches.length, 3)}, minmax(0, 1fr))` }}
        data-testid="replay-branches"
        data-branch-count={branches.length}
      >
        {branches.map((branch) => {
          const label = labelSessionContributor(branch.contributor);
          const chrome = TONE_CHROME[label.tone];

          return (
            <section
              key={branch.contributorKey}
              className="flex min-w-0 flex-col bg-background"
              data-testid="replay-branch"
              data-contributor-key={branch.contributorKey}
              data-tone={label.tone}
            >
              <header className="shrink-0 border-b px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="min-w-0 truncate text-sm font-medium text-foreground"
                    data-testid="replay-branch-contributor"
                  >
                    {label.short}
                  </span>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${chrome.badge}`}
                    data-testid="replay-branch-tone"
                  >
                    {chrome.label}
                  </span>
                </div>
                <p
                  className="mt-1.5 text-xs text-muted-foreground"
                  data-testid="replay-branch-detail"
                >
                  {label.detail}
                </p>
                <p className="mt-1.5 text-[11px] text-muted-foreground tabular-nums">
                  Tip: session {branch.tip.sessionId.slice(0, 8)}… seq {branch.tip.seq}
                </p>
                {branch.ambiguousAncestry && (
                  /*
                   * A branch whose OWN history is not fully ordered is a
                   * best-effort linearization, and saying so is required — the
                   * alternative is presenting a guess inside a panel whose whole
                   * message is that we do not guess.
                   */
                  <p
                    className="mt-1.5 text-[11px] text-amber-300"
                    data-testid="replay-branch-ambiguous-ancestry"
                  >
                    This lineage’s own history is not fully ordered either, so the text below is a
                    best-effort reading of it rather than an established sequence.
                  </p>
                )}
              </header>

              <pre
                className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed text-foreground"
                data-testid="replay-branch-content"
              >
                {branch.value.content}
              </pre>
            </section>
          );
        })}
      </div>
    </div>
  );
}
