/**
 * Duration formatting for the coverage panel.
 *
 * Presentation only, which is why it stays in the analyzer rather than moving
 * to `analysis-core` with the coverage stage: the stage computes milliseconds,
 * and how coarsely a human should be shown them is a UI decision.
 */

/** `3h 12m`, `47m`, `12s`. Deliberately coarse — this is context, not a measurement. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
