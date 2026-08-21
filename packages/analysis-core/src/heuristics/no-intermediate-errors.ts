/**
 * no_intermediate_errors heuristic (Phase 16).
 *
 * PRD §7.4 process-shape: "File goes from empty to passing-tests with zero
 * terminal commands exiting non-zero."
 *
 * WHAT THIS FLAG IS AND IS NOT EVIDENCE FOR
 *
 * "The student never saw an error" is consistent with "they pasted working
 * code" AND with "they are a strong programmer who got it right". Those are
 * indistinguishable on a short session, so the flag is only worth raising when
 * the clean record is long enough to be a process shape rather than an
 * ordinary morning: real terminal use produces non-zero exits from typos
 * alone. Hence `minCommandsWithExitCode`. It stays medium/0.65 because even
 * above the floor the innocent reading is at least as likely as the guilty
 * one — this is a pointer for a human, never a conclusion.
 *
 * It also does NOT distinguish a test run from `ls`: the recorder's
 * terminal.command payload carries the command line, but classifying "was that
 * a test run" is a per-course question this heuristic deliberately does not
 * answer. Read the flag as "N observed commands, none failed", nothing more.
 *
 * SCOPE: the whole submission, not one session.
 *
 * The claim "the development process shows no error-and-fix cycle" is a claim
 * about the work, so it is evaluated across every session in the bundle. It
 * used to be evaluated per session, which flagged the single most ordinary
 * honest workflow there is: fight failing tests in session 1, come back and do
 * one clean run in session 2 → a `medium` flag titled "No terminal errors
 * detected" against a log containing three failures.
 *
 * Shell integration is what makes exit codes visible. Any session whose
 * terminal.open reports `shell_integration: false` gets a per-session
 * `'skipped'` info flag, and — because errors in that session would have been
 * invisible — suppresses the submission-wide flag entirely.
 *
 * When shell integration is enabled everywhere:
 *   - Count terminal.command events across ALL sessions that actually REPORTED
 *     an exit code. `exit_code` is optional on TerminalCommandPayload (absent
 *     when the command hadn't finished). Absent used to count as a success,
 *     so a bundle where nothing reported an exit code raised the flag on zero
 *     evidence — absence of capture read as evidence of success. Absent now
 *     counts as nothing at all: neither a failure nor toward the floor.
 *   - Any reported non-zero exit → the error-and-fix cycle is present → no flag.
 *   - Otherwise, with ≥ minCommandsWithExitCode clean reported exits and some
 *     file activity in the bundle → one flag for the submission.
 *
 * Severity: medium. Confidence: 0.65.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import { isSignalCaptured } from '../manifest/bundle-manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(prefix: string, sessionId: string, idx: number): string {
  return `no_intermediate_errors-${prefix}-${sessionId}-${idx}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[] {
  // Absence-vs-disabled (program spec §4). With terminal capture switched off
  // there are no terminal.open / terminal.command events to reason about, and
  // "no non-zero exit codes were observed" would be an artefact of policy
  // rather than of how the student worked.
  if (!isSignalCaptured(bundle, 'terminal')) return [];

  const { minCommandsWithExitCode } = config.noIntermediateErrors;

  const flags: Flag[] = [];
  let flagIndex = 0;

  // -------------------------------------------------------------------------
  // Pass 1 (per session): capture gaps. A session whose terminal reported
  // shell_integration: false could have contained any number of failures we
  // never saw, so it is reported as such AND suppresses the positive flag.
  // -------------------------------------------------------------------------
  let anyShellIntegrationDisabled = false;

  for (const [sessionId, sessionEvents] of index.bySessionId) {
    const terminalOpenEvents = sessionEvents.filter((e) => e.kind === 'terminal.open');

    const disabled = terminalOpenEvents.some(
      (e) => (e.payload as Record<string, unknown> | null)?.['shell_integration'] === false,
    );
    if (!disabled) continue;
    anyShellIntegrationDisabled = true;

    const seqKey0 =
      terminalOpenEvents[0] !== undefined
        ? `${sessionId}:${terminalOpenEvents[0].seq}`
        : `${sessionId}:0`;
    flags.push({
      id: flagId('skipped', sessionId, flagIndex++),
      heuristic: 'no_intermediate_errors',
      title: 'Shell integration disabled — cannot check for intermediate errors',
      severity: 'info',
      confidence: 1.0,
      supportingSeqs: terminalOpenEvents.map((e) => `${e.sessionId}:${e.seq}`),
      description:
        'Shell integration is disabled in this session. The no_intermediate_errors ' +
        'heuristic requires shell integration to detect terminal exit codes. ' +
        'Manually review terminal usage for this session.',
      detail: {
        sessionId,
        reason: 'shell_integration_disabled',
        firstTerminalOpenSeq: seqKey0,
      },
    });
  }

  // Errors would have been invisible in at least one session, so a
  // submission-wide "no errors were seen" claim is unsupportable.
  if (anyShellIntegrationDisabled) return flags;

  // -------------------------------------------------------------------------
  // Pass 2 (whole submission): "the development process shows no error-and-fix
  // cycle" is a claim about the WORK, so every session counts toward it. A
  // failure in session 1 means the cycle happened, however clean session 2 is.
  // -------------------------------------------------------------------------
  let hasAnyTerminal = false;
  let hasFileActivity = false;
  let hasNonZeroExit = false;
  let commandsWithoutExitCode = 0;
  const cmdSeqKeys: string[] = [];

  for (const e of index.ordered) {
    switch (e.kind) {
      case 'terminal.open':
        hasAnyTerminal = true;
        break;
      case 'terminal.command': {
        const exitCode = (e.payload as Record<string, unknown> | null)?.['exit_code'];
        if (typeof exitCode !== 'number') {
          // Never finished / never reported. Not a success, not a failure,
          // and not evidence of either.
          commandsWithoutExitCode++;
          break;
        }
        cmdSeqKeys.push(`${e.sessionId}:${e.seq}`);
        if (exitCode !== 0) hasNonZeroExit = true;
        break;
      }
      case 'doc.save':
      case 'doc.change':
      case 'paste':
        hasFileActivity = true;
        break;
      default:
        break;
    }
  }

  // No terminal at all: we cannot tell "never ran anything" from "ran it
  // outside the recorder", so we say nothing.
  if (!hasAnyTerminal) return flags;
  // The error-and-fix cycle is present. This is the normal path.
  if (hasNonZeroExit) return flags;
  // Nothing was written, so there is no solution whose arrival to explain.
  if (!hasFileActivity) return flags;
  // Too few observed runs for "none of them failed" to mean anything.
  if (cmdSeqKeys.length < minCommandsWithExitCode) return flags;

  flags.push({
    id: `no_intermediate_errors-no_errors`,
    heuristic: 'no_intermediate_errors',
    title: `No failed terminal command across ${cmdSeqKeys.length} runs`,
    severity: 'medium',
    confidence: 0.65,
    supportingSeqs: cmdSeqKeys,
    description:
      `${cmdSeqKeys.length} terminal command(s) across this submission reported an exit code and ` +
      `every one of them was 0` +
      (commandsWithoutExitCode > 0
        ? ` (a further ${commandsWithoutExitCode} reported no exit code and were not counted either way)`
        : '') +
      `. Development normally leaves a trail of failed runs, so its complete absence is worth a ` +
      `look — but a strong student who wrote correct code first time produces exactly this shape, ` +
      `and this heuristic does not distinguish a test run from an 'ls'. Read it as "no failure was ` +
      `observed", not as "the code was not written".`,
    detail: {
      commandsWithExitCode: cmdSeqKeys.length,
      commandsWithoutExitCode,
      minCommandsWithExitCode,
      nonZeroExitFound: false,
    },
  });

  return flags;
}

export const noIntermediateErrorsHeuristic: Heuristic = {
  id: 'no_intermediate_errors',
  label: 'No intermediate terminal errors',
  run,
};
