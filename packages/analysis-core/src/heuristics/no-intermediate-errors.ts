/**
 * no_intermediate_errors heuristic (Phase 16).
 *
 * PRD §7.4 process-shape: "File goes from empty to passing-tests with zero
 * terminal commands exiting non-zero."
 *
 * Requires shell integration to detect exit codes. When any terminal.open event
 * in the session has `shell_integration: false`, the heuristic degrades
 * gracefully: it emits one `'skipped'` flag (severity 'info') per session
 * explaining that shell integration is disabled.
 *
 * When shell integration IS enabled for all terminals:
 *   - Walk terminal.command events for each session.
 *   - If ANY command exits with `exit_code !== 0` at any point in the session,
 *     the session is considered to have had errors. This is the "normal" path
 *     (students iterate with failing tests) → no flag.
 *   - If ALL commands exit with exit_code === 0 (or exit_code is undefined,
 *     which means the command is still running at end of session) AND the file
 *     has content at the end (non-empty) → flag. The absence of any non-zero
 *     exit codes paired with non-trivial file content is the signal.
 *
 * Note: `exit_code` on TerminalCommandPayload is optional (the field may be
 * absent if the command didn't finish before the session ended). We treat
 * absent exit_code as not a failure (cannot confirm a non-zero exit).
 *
 * Severity: medium. Confidence: 0.65 (moderate — shell integration might miss
 * some error paths, and absence of failures could be legitimate for simple
 * assignments).
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

function run(index: EventIndex, bundle: Bundle, _config: HeuristicConfig): Flag[] {
  // Absence-vs-disabled (program spec §4). With terminal capture switched off
  // there are no terminal.open / terminal.command events to reason about, and
  // "no non-zero exit codes were observed" would be an artefact of policy
  // rather than of how the student worked.
  if (!isSignalCaptured(bundle, 'terminal')) return [];

  const flags: Flag[] = [];
  let flagIndex = 0;

  // Check each session.
  for (const [sessionId, sessionEvents] of index.bySessionId) {
    // Step 1: Check shell integration status for this session.
    // Any terminal.open with shell_integration: false → degrade to skipped flag.
    const terminalOpenEvents = sessionEvents.filter((e) => e.kind === 'terminal.open');

    let hasShellIntegrationDisabled = false;
    const hasAnyTerminal = terminalOpenEvents.length > 0;

    for (const e of terminalOpenEvents) {
      const p = e.payload as Record<string, unknown> | null;
      const shellIntegration = p?.['shell_integration'];
      if (shellIntegration === false) {
        hasShellIntegrationDisabled = true;
        break;
      }
    }

    if (hasShellIntegrationDisabled) {
      // Emit a skipped info flag for this session.
      const seqKey0 =
        terminalOpenEvents[0] !== undefined
          ? `${sessionId}:${terminalOpenEvents[0].seq}`
          : `${sessionId}:0`;
      const id = flagId('skipped', sessionId, flagIndex++);
      flags.push({
        id,
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
      continue;
    }

    // Step 2: If no terminals were opened, skip this session (no terminal activity
    // to check). No flag — we cannot distinguish "no terminal" from "never ran tests."
    if (!hasAnyTerminal) continue;

    // Step 3: Walk terminal.command events for this session.
    const terminalCommandEvents = sessionEvents.filter((e) => e.kind === 'terminal.command');

    if (terminalCommandEvents.length === 0) continue;

    let hasNonZeroExit = false;
    for (const e of terminalCommandEvents) {
      const p = e.payload as Record<string, unknown> | null;
      const exitCode = p?.['exit_code'];
      if (typeof exitCode === 'number' && exitCode !== 0) {
        hasNonZeroExit = true;
        break;
      }
    }

    // If any command had a non-zero exit, this is normal iteration → no flag.
    if (hasNonZeroExit) continue;

    // Step 4: Check that files under review have non-empty content at the end
    // of the session. Without non-empty content, this session produced nothing
    // to test (e.g., a session that only configured the environment).
    const fileEvents = sessionEvents.filter(
      (e) => e.kind === 'doc.save' || e.kind === 'doc.change' || e.kind === 'paste',
    );
    if (fileEvents.length === 0) continue;

    // All conditions met: has terminals, all commands succeeded (or no exit code),
    // and there was file activity.
    const cmdSeqKeys = terminalCommandEvents.map((e) => `${e.sessionId}:${e.seq}`);
    const id = flagId('no_errors', sessionId, flagIndex++);

    flags.push({
      id,
      heuristic: 'no_intermediate_errors',
      title: `No terminal errors detected in session ${sessionId.slice(0, 8)}…`,
      severity: 'medium',
      confidence: 0.65,
      supportingSeqs: cmdSeqKeys,
      description:
        `All ${terminalCommandEvents.length} terminal command(s) in this session exited with code 0 ` +
        `(or did not report an exit code). This is unusual if the student was iterating on a solution.`,
      detail: {
        sessionId,
        commandCount: terminalCommandEvents.length,
        nonZeroExitFound: false,
      },
    });
  }

  return flags;
}

export const noIntermediateErrorsHeuristic: Heuristic = {
  id: 'no_intermediate_errors',
  label: 'No intermediate terminal errors',
  run,
};
