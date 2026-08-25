/**
 * shell_integration_disabled heuristic (Phase 17).
 *
 * PRD §7.4 environment: "Terminal opened with shell integration disabled."
 *
 * When a `terminal.open` event carries `shell_integration: false`, the
 * recorder cannot observe terminal exit codes. This limits the effectiveness
 * of the `no_intermediate_errors` heuristic. Surfacing the disabled state
 * separately lets course staff know their terminal visibility is reduced.
 *
 * One flag per terminal.open event with `shell_integration: false`.
 * Severity: 'info'. Confidence: 1.0 (deterministic payload check).
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';
import { isSignalCaptured } from '../manifest/bundle-manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionId: string, terminalId: string, idx: number): string {
  const safeTermId = terminalId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `shell_integration_disabled-${sessionId}-${safeTermId}-${idx}`;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, _config: HeuristicConfig): Flag[] {
  // Absence-vs-disabled (program spec §4). Shell-integration state is only
  // observable through terminal.open. With terminal capture switched off the
  // absence of this flag would read as "shell integration was fine", which the
  // bundle carries no evidence for either way.
  if (!isSignalCaptured(bundle, 'terminal')) return [];

  const flags: Flag[] = [];
  let globalIdx = 0;

  for (const [, sessionEvents] of index.bySessionId) {
    const terminalOpenEvents = sessionEvents.filter((e) => e.kind === 'terminal.open');
    for (const ev of terminalOpenEvents) {
      const payload = ev.payload as Record<string, unknown> | null;
      if (payload?.['shell_integration'] !== false) continue;

      const terminalId =
        typeof payload?.['terminal_id'] === 'string' ? payload['terminal_id'] : 'unknown';
      const shell = typeof payload?.['shell'] === 'string' ? payload['shell'] : 'unknown';

      flags.push({
        id: flagId(ev.sessionId, terminalId, globalIdx++),
        heuristic: 'shell_integration_disabled',
        title: `Shell integration disabled in terminal (${shell})`,
        severity: 'info',
        confidence: 1.0,
        supportingSeqs: [`${ev.sessionId}:${ev.seq}`],
        description:
          `A terminal was opened with shell integration disabled (shell: "${shell}", ` +
          `terminal_id: "${terminalId}"). Without shell integration the analyzer cannot ` +
          `observe terminal exit codes, which reduces confidence in the ` +
          `no_intermediate_errors heuristic.`,
        detail: {
          sessionId: ev.sessionId,
          terminalId,
          shell,
        },
      });
    }
  }

  return flags;
}

export const shellIntegrationDisabledHeuristic: Heuristic = {
  id: 'shell_integration_disabled',
  label: 'Shell integration disabled in terminal',
  run,
};
