/**
 * Format utilities for the analyzer UI.
 */

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * Rules:
 *   >= 1 hour  → "1h 23m"
 *   >= 1 min   → "45m 12s"
 *   < 1 min    → "12s"
 *   0 or < 0   → "0s"
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Format an event wall timestamp as local `HH:MM:SS.mmm`.
 * Unparseable input (Invalid Date) returns an em dash — `new Date` does not
 * throw on bad strings, so we gate on `getTime()`.
 */
export function formatWall(wall: string): string {
  const d = new Date(wall);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

const COMMAND_MAX = 60;

/**
 * One-line summary of a `terminal.command` payload: truncated command, plus
 * `exit N` when `exit_code` is a number (shell integration may omit it).
 */
export function summarizeTerminalCommand(payload: Record<string, unknown> | null): string {
  if (payload === null) return '';
  const cmd = typeof payload['command'] === 'string' ? payload['command'] : '';
  const truncated = cmd.length > COMMAND_MAX ? cmd.slice(0, COMMAND_MAX) + '…' : cmd;
  const exit = payload['exit_code'];
  if (typeof exit === 'number') {
    return truncated ? `${truncated} · exit ${exit}` : `exit ${exit}`;
  }
  return truncated;
}
