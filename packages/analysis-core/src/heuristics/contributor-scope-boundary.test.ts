/**
 * The per-contributor SCOPING boundary — executable documentation for D14.
 *
 * ## What this file pins
 *
 * Decision D14 (`docs/superpowers/specs/2026-08-19-program-decision-log.md`)
 * reads "per-contributor AND per-scope". What shipped is per-contributor
 * ATTRIBUTION (`server/src/services/contributors/attribute-flags.ts`) and
 * per-contributor SCORING (`contributor-scores.ts`) of flags produced by a
 * single WHOLE-SCOPE heuristic run. Per-contributor **scoping** — re-running the
 * heuristics over one contributor's events at a time — is closed as
 * out-of-scope-by-analysis, and this file is the analysis in executable form.
 *
 * The claim being pinned is narrow and checkable: **for these heuristics,
 * narrowing the event scope to one contributor turns honest pair work into a
 * finding against a named student.** Each case below builds one honest-pair
 * fixture and asserts both halves:
 *
 *  - **(i)** the whole-scope run produces no finding of that shape; and
 *  - **(ii)** the same events, restricted to ONE contributor, DO produce it.
 *
 * Half (ii) is the load-bearing half. Without it (i) is satisfiable by a
 * heuristic that never fires at all, and the file would document nothing.
 *
 * ## The three failure modes
 *
 * **A — slicing defeats the Tier 2.2 reconstruction gate.**
 * `reconstruction-gate.ts` returns `null` (skip the file) when
 * `reconstructFileSegmented` answers `concurrent`, and a file only reaches
 * `concurrent` when its events span two contributors whose enrolment chains BOTH
 * verify (`reconstruct-segments.ts`, "The solo guarantee"). Restrict the scope to
 * one contributor and the short-circuit fires instead: every suppressed
 * `concurrent` verdict becomes a `determinate` one, and the content heuristics
 * that were skipping the file start comparing against it.
 *
 * **B — slicing destroys the content classification.**
 * `classify-external-changes.ts` DEFINES `git_merge_in` as "the post-change
 * sha256 equals a sha256 a provably different verified contributor recorded on
 * this path". Both operands live in the other contributor's events. Take them
 * out of scope and the same `fs.external_change` is `external` /
 * `git_unrecorded_in`, and every consumer fires. The same shape appears one
 * layer down in `internal-move.ts`, whose deletion ledger and per-character
 * provenance are read off the whole-scope replay.
 *
 * **C — the question is not about one person.**
 * `multiple_sessions_overlap` is defined over PAIRS of sessions and
 * `extension_hash_mismatch` reads no events at all. Neither has a
 * per-contributor form to compute; see the section header below for what
 * slicing costs them, which is a lost fact rather than a false accusation.
 *
 * ## What a failure here means
 *
 * A failure of (i) is a false-accusation regression: whole-scope analysis has
 * started flagging honest pair work. A failure of (ii) means the boundary this
 * file exists to hold has moved — either a heuristic gained a scope-independent
 * guard (in which case re-open D14 for it and update the classification in
 * `docs/heuristics.md`), or the fixture drifted and is no longer testing
 * anything. Neither is fixed by relaxing the assertion.
 *
 * ## The slice is a model, not a shipped code path
 *
 * {@link sliceToContributor} exists ONLY in this file. Nothing in
 * `analysis-core` narrows a bundle to one contributor, and nothing should — that
 * is the whole point. The helper is the smallest faithful model of the runner
 * this analysis declines to build: same events, same manifest, same contributor
 * stamp, one contributor's sessions.
 */

import { describe, expect, it } from 'vitest';
import { buildIndex } from '../index/build-index.js';
import { partitionSessionOverlaps } from '../coverage/session-overlap.js';
import type { Bundle } from '../loader/types.js';
import type { EventIndex } from '../index/event-index.js';
import {
  buildCollabScope,
  collabDocOpen,
  collabDocSave,
  collabExternalChange,
  collabGitEvent,
  collabPartnerSession,
  collabPullerSession,
  COLLAB_ALICE,
  COLLAB_BOB,
  COLLAB_C0,
  COLLAB_C1,
  COLLAB_FILE,
} from '../test-support/build-collab-scope.js';
import type { EventSpec } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import type { Flag, Heuristic, Severity } from './types.js';
import { externalEditsHeuristic } from './external-edits.js';
import { extensionHashMismatchHeuristic } from './extension-hash-mismatch.js';
import { idleThenCompleteHeuristic } from './idle-then-complete.js';
import { interSessionExternalChangeHeuristic } from './inter-session-external-change.js';
import { largePasteHeuristic } from './large-paste.js';
import { lowTypingHighOutputHeuristic } from './low-typing-high-output.js';
import { massExternalReplacementHeuristic } from './mass-external-replacement.js';
import { multipleSessionsOverlapHeuristic } from './multiple-sessions-overlap.js';
import { pasteIsSolutionHeuristic } from './paste-is-solution.js';
import { terminalActiveDuringExternalChangeHeuristic } from './terminal-active-during-external-change.js';
import { timeToFirstSaveAnomalyHeuristic } from './time-to-first-save-anomaly.js';

const cfg = DEFAULT_HEURISTIC_CONFIG;

// ---------------------------------------------------------------------------
// The model of a per-contributor scoping runner
// ---------------------------------------------------------------------------

type Scope = { bundle: Bundle; index: EventIndex };

/**
 * The bundle as a per-contributor scoping runner would present it: only the
 * named sessions, with the contributor stamp narrowed to match, and a freshly
 * built index (every reconstruction and classification memo is keyed weakly on
 * the `EventIndex`, so a fresh index is a genuinely fresh computation).
 *
 * The manifest, the seal and `rootKeyConfigured` are deliberately left intact.
 * A runner narrowing the *event* scope would not restate the signed manifest,
 * and keeping it is the adversarial choice: the collaboration triggers in
 * `classifyExternalChanges` stay as favourable as they can be, so anything that
 * still changes below changes for evidential reasons rather than because a pass
 * switched itself off.
 */
function sliceToContributor(scope: Scope, sessionIndexes: readonly number[]): Scope {
  const keep = sessionIndexes.map((i) => {
    const session = scope.bundle.sessions[i];
    if (session === undefined) throw new Error(`fixture has no session ${i}`);
    return session;
  });
  const ids = new Set(keep.map((s) => s.sessionId));
  const stamp = scope.bundle.contributors;
  const bundle: Bundle = {
    ...scope.bundle,
    sessions: keep,
    ...(stamp === undefined
      ? {}
      : {
          contributors: {
            ...stamp,
            bySession: new Map([...stamp.bySession].filter(([id]) => ids.has(id))),
            contributors: stamp.contributors.filter((c) => c.sessionIds.some((id) => ids.has(id))),
          },
        }),
  };
  return { bundle, index: buildIndex(bundle) };
}

function flagsOf(heuristic: Heuristic, scope: Scope): Flag[] {
  return heuristic.run(scope.index, scope.bundle, cfg);
}

function describeFlags(flags: readonly Flag[]): string {
  return flags.length === 0
    ? '(none)'
    : flags.map((f) => `${f.id} [${f.severity}/${f.confidence}]`).join(', ');
}

/** The message a reader gets when whole-scope analysis starts accusing a pair. */
function wholeScopeAccused(heuristic: Heuristic, flags: readonly Flag[]): string {
  return (
    `${heuristic.id} fired on HONEST PAIR WORK in the whole-scope run: ${describeFlags(flags)}.\n` +
    `This is the false-accusation direction. Two enrolled partners sharing one ` +
    `repository must not collect this finding for collaborating. Do not relax this ` +
    `assertion — find what stopped suppressing the pair.`
  );
}

/**
 * The message a reader gets when the whole-scope zero stops being the
 * contributor gate and starts being an inert fixture.
 */
function suppressionIsDead(heuristic: Heuristic): string {
  return (
    `${heuristic.id} does not fire on this fixture even with NO contributor verdict on the ` +
    `bundle, so the zero asserted for the stamped run proves nothing about the contributor ` +
    `gate — the fixture has stopped reaching the heuristic at all.\n` +
    `An unstamped bundle is the ordinary 1.x / unenrolled / no-root-key state and is ` +
    `documented to fail toward MORE findings, so a zero here is itself suspicious.`
  );
}

/** The message a reader gets when the boundary itself has moved. */
function boundaryMoved(heuristic: Heuristic, mode: 'A' | 'B' | 'C'): string {
  return (
    `${heuristic.id} did NOT fire when the same honest-pair events were narrowed to one ` +
    `contributor, so this file no longer demonstrates why per-contributor SCOPING is ` +
    `closed for it (failure mode ${mode}).\n` +
    `If you are adding a per-contributor scoping runner: this assertion is the reason ` +
    `not to, and a green run here is not permission — check WHY it went green. Either ` +
    `${heuristic.id} gained a scope-independent guard, in which case re-open D14 for it ` +
    `and move it in the classification table in docs/heuristics.md, or the fixture ` +
    `drifted and is asserting nothing. Deleting the assertion fixes neither.`
  );
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

function maxSeverity(flags: readonly Flag[]): Severity {
  return flags.reduce<Severity>(
    (worst, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst] ? f.severity : worst),
    'info',
  );
}

// ---------------------------------------------------------------------------
// Fixture vocabulary — one shared story
// ---------------------------------------------------------------------------
//
// Alice and Bob are two enrolled partners on one git repository. Bob writes the
// implementation and commits it; Alice pulls it and works on top. Every fixture
// below is a variation on that, and nothing in any of them is misconduct.

const IMPLEMENTATION =
  Array.from({ length: 24 }, (_, i) => `def helper_${i}(value):\n    return value * ${i} + 1`).join(
    '\n',
  ) + '\n';

const STARTER = '# starter\n';

const BLOCK =
  Array.from({ length: 10 }, (_, i) => `    accumulator = step_${i}(accumulator, data)`).join(
    '\n',
  ) + '\n';

function typed(path: string, text: string, line = 0): EventSpec {
  return {
    kind: 'doc.change',
    data: {
      path,
      deltas: [{ range: { start: { line, character: 0 }, end: { line, character: 0 } }, text }],
      source: 'typed',
    },
  };
}

function deleteLines(path: string, endLine: number): EventSpec {
  return {
    kind: 'doc.change',
    data: {
      path,
      deltas: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: endLine, character: 0 } },
          text: '',
        },
      ],
      source: 'typed',
    },
  };
}

function pasteOf(path: string, content: string): EventSpec {
  return {
    kind: 'paste',
    data: {
      path,
      content,
      length: content.length,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    },
  };
}

function heartbeat(t: number): EventSpec {
  return {
    kind: 'session.heartbeat',
    data: { focused: true, active_file: COLLAB_FILE, idle_since_ms: 0 },
    t,
  };
}

type Specs = Parameters<typeof buildCollabScope>[0];

/**
 * Bob commits the implementation; Alice already had the file open when she
 * pulled it. Two live lineages that `≺` does not order, so
 * `reconstructFileSegmented` answers `concurrent` and Tier 2.2 skips the file.
 *
 * `merge` is deliberately NOT set: landing HEAD on a descendant of Bob's commit
 * re-anchors the replay and makes the file `determinate` again, which is the
 * mode-B shape below, not this one.
 */
function pullIntoAnOpenFile(alice: { after?: EventSpec[] }): Specs {
  return [
    { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(IMPLEMENTATION) },
    {
      who: { studentRef: COLLAB_ALICE },
      events: collabPullerSession(IMPLEMENTATION, {
        before: [collabDocOpen(STARTER)],
        ...(alice.after === undefined ? {} : { after: alice.after }),
      }),
    },
  ];
}

/**
 * The same events twice: once with the contributor verdict stamped (a
 * Manifest 2.1 pair whose enrolment chains both verify) and once WITHOUT.
 *
 * The unstamped run is the control every "zero flags on honest pair work"
 * assertion needs. Unstamped is the ordinary state of a 1.x bundle, of a pair
 * where one partner never enrolled, and of a deployment with no root key
 * configured; `compareContributors` answers `'unknown'` there, every gate in
 * Tier 2.2 / 3.1 / 3.3 fails open, and the heuristics fire exactly as they did
 * before the collaboration work landed. So if the unstamped run also produces
 * nothing, the stamped zero was never evidence of a gate.
 */
async function stampedAndUnstamped(specs: Specs): Promise<{ pair: Scope; unstamped: Scope }> {
  return {
    pair: await buildCollabScope(specs),
    unstamped: await buildCollabScope(specs, { stamp: false }),
  };
}

/** Alice's session is index 1 in every two-session fixture. */
const ALICE_ONLY = [1];

// ---------------------------------------------------------------------------
// Failure mode A — slicing defeats the Tier 2.2 reconstruction gate
// ---------------------------------------------------------------------------

describe('failure mode A — a one-contributor scope makes `concurrent` files reconstructible', () => {
  it('low_typing_high_output would divide a partner-authored file by Alice’s keystrokes', async () => {
    const { pair, unstamped } = await stampedAndUnstamped(
      pullIntoAnOpenFile({
        after: [typed(COLLAB_FILE, '# note\n'), collabDocSave('# note\n' + IMPLEMENTATION)],
      }),
    );

    const whole = flagsOf(lowTypingHighOutputHeuristic, pair);
    expect(whole, wholeScopeAccused(lowTypingHighOutputHeuristic, whole)).toHaveLength(0);
    expect(
      flagsOf(lowTypingHighOutputHeuristic, unstamped).length,
      suppressionIsDead(lowTypingHighOutputHeuristic),
    ).toBeGreaterThan(0);

    const sliced = flagsOf(lowTypingHighOutputHeuristic, sliceToContributor(pair, ALICE_ONLY));
    expect(sliced.length, boundaryMoved(lowTypingHighOutputHeuristic, 'A')).toBeGreaterThan(0);
    expect(maxSeverity(sliced)).toBe('high');
  });

  it('paste_is_solution would call Alice’s paste the whole solution', async () => {
    // Alice pastes the block she and Bob wrote together while pairing on his
    // machine. Bob's own session carries the same file with an extra line, so
    // the file spans both partners and has no single final content.
    const { pair, unstamped } = await stampedAndUnstamped([
      {
        who: { studentRef: COLLAB_BOB },
        events: collabPartnerSession(IMPLEMENTATION + 'x = 1\n'),
      },
      {
        who: { studentRef: COLLAB_ALICE },
        events: [
          collabDocOpen(''),
          collabGitEvent(COLLAB_C0),
          pasteOf(COLLAB_FILE, IMPLEMENTATION),
          collabDocSave(IMPLEMENTATION),
        ],
      },
    ]);

    const whole = flagsOf(pasteIsSolutionHeuristic, pair);
    expect(whole, wholeScopeAccused(pasteIsSolutionHeuristic, whole)).toHaveLength(0);
    expect(
      flagsOf(pasteIsSolutionHeuristic, unstamped).length,
      suppressionIsDead(pasteIsSolutionHeuristic),
    ).toBeGreaterThan(0);

    const sliced = flagsOf(pasteIsSolutionHeuristic, sliceToContributor(pair, ALICE_ONLY));
    expect(sliced.length, boundaryMoved(pasteIsSolutionHeuristic, 'A')).toBeGreaterThan(0);
    expect(maxSeverity(sliced)).toBe('high');
  });

  it('time_to_first_save_anomaly would read the pull as 1k chars written in seconds', async () => {
    const { pair, unstamped } = await stampedAndUnstamped(
      pullIntoAnOpenFile({ after: [collabDocSave(IMPLEMENTATION)] }),
    );

    const whole = flagsOf(timeToFirstSaveAnomalyHeuristic, pair);
    expect(whole, wholeScopeAccused(timeToFirstSaveAnomalyHeuristic, whole)).toHaveLength(0);
    expect(
      flagsOf(timeToFirstSaveAnomalyHeuristic, unstamped).length,
      suppressionIsDead(timeToFirstSaveAnomalyHeuristic),
    ).toBeGreaterThan(0);

    const sliced = flagsOf(timeToFirstSaveAnomalyHeuristic, sliceToContributor(pair, ALICE_ONLY));
    expect(sliced.length, boundaryMoved(timeToFirstSaveAnomalyHeuristic, 'A')).toBeGreaterThan(0);
    expect(maxSeverity(sliced)).toBe('high');
  });

  it('idle_then_complete would read lunch-then-pull as an idle gap that produced the file', async () => {
    // Alice opens the starter, goes to lunch, comes back, pulls, saves.
    const { pair, unstamped } = await stampedAndUnstamped([
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(IMPLEMENTATION) },
      {
        who: { studentRef: COLLAB_ALICE },
        events: [
          { ...collabDocOpen(STARTER), t: 1_000 },
          heartbeat(2_000),
          { ...collabGitEvent(COLLAB_C0), t: 3_000 },
          { ...collabGitEvent(COLLAB_C1, [COLLAB_C0]), t: 4_000 },
          heartbeat(700_000),
          collabExternalChange(IMPLEMENTATION, { t: 701_000 }),
          { ...collabDocSave(IMPLEMENTATION), t: 702_000 },
        ],
      },
    ]);

    const whole = flagsOf(idleThenCompleteHeuristic, pair);
    expect(whole, wholeScopeAccused(idleThenCompleteHeuristic, whole)).toHaveLength(0);
    expect(
      flagsOf(idleThenCompleteHeuristic, unstamped).length,
      suppressionIsDead(idleThenCompleteHeuristic),
    ).toBeGreaterThan(0);

    const sliced = flagsOf(idleThenCompleteHeuristic, sliceToContributor(pair, ALICE_ONLY));
    expect(sliced.length, boundaryMoved(idleThenCompleteHeuristic, 'A')).toBeGreaterThan(0);
    expect(maxSeverity(sliced)).toBe('high');
  });

  it('mass_external_replacement would read the pull as a wholesale replacement', async () => {
    const { pair, unstamped } = await stampedAndUnstamped(
      pullIntoAnOpenFile({ after: [collabDocSave(IMPLEMENTATION)] }),
    );

    const whole = flagsOf(massExternalReplacementHeuristic, pair);
    expect(whole, wholeScopeAccused(massExternalReplacementHeuristic, whole)).toHaveLength(0);
    expect(
      flagsOf(massExternalReplacementHeuristic, unstamped).length,
      suppressionIsDead(massExternalReplacementHeuristic),
    ).toBeGreaterThan(0);

    const sliced = flagsOf(massExternalReplacementHeuristic, sliceToContributor(pair, ALICE_ONLY));
    expect(sliced.length, boundaryMoved(massExternalReplacementHeuristic, 'A')).toBeGreaterThan(0);
    expect(maxSeverity(sliced)).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Failure mode B — slicing destroys the content evidence the suppression needs
// ---------------------------------------------------------------------------

describe('failure mode B — a one-contributor scope cannot recognise a partner’s bytes', () => {
  /**
   * The merge shape: Alice's HEAD lands on a DESCENDANT of Bob's commit, so the
   * file re-anchors and Tier 2.2 answers `determinate`. Nothing is suppressed by
   * the reconstruction gate here; the only thing standing between honest pair
   * work and a finding is `git_merge_in`, which is a statement about content
   * only the other contributor's events can support.
   */
  function pullAfterMerge(beforeChange: EventSpec[] = []): Specs {
    return [
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(IMPLEMENTATION) },
      {
        who: { studentRef: COLLAB_ALICE },
        events: collabPullerSession(IMPLEMENTATION, { merge: true, beforeChange }),
      },
    ];
  }

  it('external_edits would charge Alice with an out-of-editor edit for `git pull`', async () => {
    const { pair, unstamped } = await stampedAndUnstamped(pullAfterMerge());

    const whole = flagsOf(externalEditsHeuristic, pair);
    expect(whole, wholeScopeAccused(externalEditsHeuristic, whole)).toHaveLength(0);
    expect(
      flagsOf(externalEditsHeuristic, unstamped).length,
      suppressionIsDead(externalEditsHeuristic),
    ).toBeGreaterThan(0);

    const sliced = flagsOf(externalEditsHeuristic, sliceToContributor(pair, ALICE_ONLY));
    expect(sliced.length, boundaryMoved(externalEditsHeuristic, 'B')).toBeGreaterThan(0);
    expect(maxSeverity(sliced)).toBe('high');
  });

  it('terminal_active_during_external_change would report the terminal git ran in', async () => {
    const { pair, unstamped } = await stampedAndUnstamped(
      pullAfterMerge([
        {
          kind: 'terminal.open',
          data: { terminal_id: 't1', shell: '/bin/zsh', shell_integration: true },
        },
      ]),
    );

    const whole = flagsOf(terminalActiveDuringExternalChangeHeuristic, pair);
    expect(
      whole,
      wholeScopeAccused(terminalActiveDuringExternalChangeHeuristic, whole),
    ).toHaveLength(0);
    expect(
      flagsOf(terminalActiveDuringExternalChangeHeuristic, unstamped).length,
      suppressionIsDead(terminalActiveDuringExternalChangeHeuristic),
    ).toBeGreaterThan(0);

    const sliced = flagsOf(
      terminalActiveDuringExternalChangeHeuristic,
      sliceToContributor(pair, ALICE_ONLY),
    );
    expect(
      sliced.length,
      boundaryMoved(terminalActiveDuringExternalChangeHeuristic, 'B'),
    ).toBeGreaterThan(0);
    // Recorded at `info`, so the harm of slicing here is a noisy queue rather
    // than a severe accusation. Asserted so a future severity change is a
    // deliberate edit to this line and not a silent one.
    expect(maxSeverity(sliced)).toBe('info');
  });

  it('inter_session_external_change would compare Alice’s two sessions across Bob’s work', async () => {
    // The suppression here is NOT `git_merge_in` — this heuristic never consults
    // the external-change classifier. It compares CONSECUTIVE sessions and skips
    // a pair belonging to provably different contributors
    // (`inter-session-external-change.ts`, Tier 3.3). Whole-scope the order is
    // Alice, Bob, Alice, so both consecutive pairs are cross-contributor and both
    // are skipped. Drop Bob and Alice's two sessions become adjacent, with his
    // work sitting in the difference between them.
    const { pair, unstamped } = await stampedAndUnstamped([
      {
        who: { studentRef: COLLAB_ALICE },
        events: [collabDocOpen(STARTER), collabDocSave(STARTER), collabGitEvent(COLLAB_C0)],
      },
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(IMPLEMENTATION) },
      {
        who: { studentRef: COLLAB_ALICE },
        events: [
          collabGitEvent(COLLAB_C1, [COLLAB_C0]),
          collabDocOpen(IMPLEMENTATION),
          collabDocSave(IMPLEMENTATION),
        ],
      },
    ]);

    const whole = flagsOf(interSessionExternalChangeHeuristic, pair);
    expect(whole, wholeScopeAccused(interSessionExternalChangeHeuristic, whole)).toHaveLength(0);
    expect(
      flagsOf(interSessionExternalChangeHeuristic, unstamped).length,
      suppressionIsDead(interSessionExternalChangeHeuristic),
    ).toBeGreaterThan(0);

    const sliced = flagsOf(interSessionExternalChangeHeuristic, sliceToContributor(pair, [0, 2]));
    expect(sliced.length, boundaryMoved(interSessionExternalChangeHeuristic, 'B')).toBeGreaterThan(
      0,
    );
    expect(maxSeverity(sliced)).toBe('high');
  });

  it('large_paste would lose the internal-move evidence that keeps a refactor at `info`', async () => {
    // Alice cuts a block Bob typed and pastes it lower down — ordinary
    // refactoring in a shared repository. `internal-move.ts` recognises it from
    // the deletion ledger, whose `own` verdict comes from per-character
    // provenance read off the WHOLE-SCOPE replay. Bob's keystrokes are what make
    // the deleted region "the student's own work"; without them there is no
    // ledger entry and the paste is an external paste.
    //
    // Note this mechanism is `internal-move.ts`, not `classify-external-changes.ts`:
    // `classifyInternalMoves` takes no `Bundle` and never consults the
    // external-change classifier. It is grouped under B because the destroyed
    // operand is again content only the other contributor's events carry.
    //
    // The unstamped control the mode-A/B cases above use is deliberately absent
    // here, and its absence is the point: because the classifier never reads
    // identity, an unstamped run of this fixture ALSO answers `internal_move`.
    // What this case demonstrates is therefore not a contributor gate but a
    // plain scope dependency — the evidence is in the other contributor's
    // events, whether or not anyone has proved whose they are.
    const pair = await buildCollabScope([
      {
        who: { studentRef: COLLAB_BOB },
        events: [
          collabDocOpen('', COLLAB_FILE),
          typed(COLLAB_FILE, BLOCK),
          collabDocSave(BLOCK, COLLAB_FILE),
          collabGitEvent(COLLAB_C1, [COLLAB_C0]),
        ],
      },
      {
        who: { studentRef: COLLAB_ALICE },
        events: [
          collabGitEvent(COLLAB_C0),
          collabGitEvent(COLLAB_C1, [COLLAB_C0]),
          deleteLines(COLLAB_FILE, 10),
          pasteOf(COLLAB_FILE, BLOCK),
          collabDocSave(BLOCK, COLLAB_FILE),
        ],
      },
    ]);

    // large_paste always emits — an internal move is recorded, not erased. What
    // whole-scope analysis establishes is that it is a MOVE, which is `info` and
    // scores zero. So (i) here is "nothing above info", not "nothing".
    const whole = flagsOf(largePasteHeuristic, pair);
    expect(whole).toHaveLength(1);
    expect(maxSeverity(whole), wholeScopeAccused(largePasteHeuristic, whole)).toBe('info');

    const sliced = flagsOf(largePasteHeuristic, sliceToContributor(pair, ALICE_ONLY));
    expect(sliced, boundaryMoved(largePasteHeuristic, 'B')).toHaveLength(1);
    expect(
      SEVERITY_RANK[maxSeverity(sliced)],
      boundaryMoved(largePasteHeuristic, 'B'),
    ).toBeGreaterThan(SEVERITY_RANK.info);
  });
});

// ---------------------------------------------------------------------------
// Failure mode C — nothing to scope
// ---------------------------------------------------------------------------

describe('failure mode C — the question is not about one contributor', () => {
  /**
   * These two are in the must-stay list for a DIFFERENT reason from A and B, and
   * the assertions below are shaped differently because of it.
   *
   * A and B are false-ACCUSATION hazards: slicing manufactures a finding against
   * a named student. These two are not. `multiple_sessions_overlap` is defined
   * over pairs of sessions, so a one-contributor scope simply never enumerates a
   * cross-contributor pair; `extension_hash_mismatch` reads no events at all.
   * Slicing them costs a FACT, never gains an accusation.
   *
   * That difference was worth checking rather than assuming: the natural form of
   * assertion (ii) — "the slice would fire" — is FALSE for both, and writing it
   * anyway would have pinned something untrue.
   */

  it('multiple_sessions_overlap: slicing removes the pair, and with it the exculpatory fact', async () => {
    // Bob's session runs long and Alice's starts inside it — two partners at one
    // table. `coverage/session-overlap.ts` puts this pair in `collaboration`, so
    // the heuristic emits nothing and the coverage stage can state why.
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const at = (ms: number): string => new Date(base + ms).toISOString();
    const pair = await buildCollabScope([
      {
        who: { studentRef: COLLAB_BOB },
        events: [
          { ...collabDocOpen(''), wall: at(600_000) },
          { ...collabDocSave(IMPLEMENTATION), wall: at(7_200_000) },
        ],
      },
      {
        who: { studentRef: COLLAB_ALICE },
        events: [collabDocOpen(''), collabDocSave(IMPLEMENTATION)],
      },
    ]);

    const whole = flagsOf(multipleSessionsOverlapHeuristic, pair);
    expect(whole, wholeScopeAccused(multipleSessionsOverlapHeuristic, whole)).toHaveLength(0);

    // The pair IS seen, and is recorded as collaboration rather than judged.
    const wholePartition = partitionSessionOverlaps(pair.bundle, pair.index);
    expect(wholePartition.judged).toHaveLength(0);
    expect(
      wholePartition.collaboration,
      'the fixture must actually produce an overlapping pair, or the assertion below is vacuous',
    ).toHaveLength(1);

    // Sliced, the pair does not exist. Not "unjudged" — absent. There is no
    // per-contributor form of "these two sessions overlapped".
    const alice = sliceToContributor(pair, ALICE_ONLY);
    const slicedPartition = partitionSessionOverlaps(alice.bundle, alice.index);
    expect(
      [
        slicedPartition.judged.length,
        slicedPartition.collaboration.length,
        slicedPartition.multiMachine.length,
      ],
      `A per-contributor scope can no longer see the overlapping pair at all, so the ` +
        `§5.4 step 5 collaboration fact cannot be produced from it. If this now finds ` +
        `overlaps, something is comparing sessions across scopes — check what.`,
    ).toEqual([0, 0, 0]);
    expect(flagsOf(multipleSessionsOverlapHeuristic, alice)).toHaveLength(0);
  });

  it('extension_hash_mismatch: there is no event evidence to scope, only builds to drop', async () => {
    const pair = await buildCollabScope([
      { who: { studentRef: COLLAB_BOB }, events: collabPartnerSession(IMPLEMENTATION) },
      { who: { studentRef: COLLAB_ALICE }, events: collabPullerSession(IMPLEMENTATION) },
    ]);

    // The heuristic's `index` parameter is unused, so narrowing the event scope
    // changes nothing: identical flags, identical severities.
    const whole = flagsOf(extensionHashMismatchHeuristic, pair);
    const sliced = flagsOf(extensionHashMismatchHeuristic, sliceToContributor(pair, ALICE_ONLY));
    expect(
      sliced,
      `extension_hash_mismatch reads only the signed manifest, so a per-contributor ` +
        `event scope cannot change its answer. If this differs, the heuristic has ` +
        `started reading events and its row in docs/heuristics.md is stale.`,
    ).toEqual(whole);

    // The only thing a runner COULD narrow is the set of observed builds — and
    // that is where the loss lives. A rolling-sealed group bundle carries one
    // signed manifest per session, so each partner's build is checked; keep only
    // one partner's and the other's build goes unexamined.
    const bothBuilds: Scope = {
      ...pair,
      bundle: {
        ...pair.bundle,
        rollingSeal: {
          seals: [],
          defects: [],
          observedExtensionHashes: ['a'.repeat(64), 'b'.repeat(64)],
        },
      },
    };
    const onePartnersBuild: Scope = {
      ...pair,
      bundle: {
        ...pair.bundle,
        rollingSeal: { seals: [], defects: [], observedExtensionHashes: ['a'.repeat(64)] },
      },
    };
    const bothFlags = flagsOf(extensionHashMismatchHeuristic, bothBuilds);
    const oneFlags = flagsOf(extensionHashMismatchHeuristic, onePartnersBuild);
    expect(
      bothFlags.length - oneFlags.length,
      `Checking every build that touched the work is the whole point of reading ` +
        `observedExtensionHashes rather than the union manifest's single scalar. A ` +
        `per-contributor scope would drop the partner's build from that set.`,
    ).toBe(1);
  });
});
