/**
 * Presentation helpers for the Manifest 2.0 metadata a bundle carries
 * (program spec §3/§4).
 *
 * Pure functions, no React, so both surfaces can share them: the server-backed
 * submission Overview (which gets the shape from the API) and the in-browser
 * `/local` view (which computes it from a parsed Bundle via
 * `summarizeBundleManifest`). The two produce the identical shape, so the
 * mapping to labels lives here once.
 *
 * The load-bearing one is {@link disabledSignalLabels}. Staff reading a
 * submission need to know which signals are absent BY COURSE POLICY rather than
 * by student omission — "this course does not record terminals" reads very
 * differently from "they never opened a terminal", and only one of them is
 * evidence of anything.
 */

import type { AssignmentManifest } from '@provenance/shared/api-schemas';

export type ManifestFact = {
  label: string;
  value: string;
  /** `warn` and `bad` let a view tint the value without knowing what it means. */
  tone?: 'normal' | 'warn' | 'bad';
};

/** Human labels for the gated capture signals. */
export const CAPTURE_SIGNAL_LABELS: Record<string, string> = {
  selection_change: 'Cursor & selection',
  focus_change: 'Window focus',
  terminal: 'Terminal',
  doc_open_close: 'File open/close',
  inline_content: 'Inline paste content',
};

export function captureSignalLabel(signal: string): string {
  return CAPTURE_SIGNAL_LABELS[signal] ?? signal;
}

/** The disabled capture signals, as display labels. Empty for a 1.x bundle. */
export function disabledSignalLabels(manifest: AssignmentManifest): string[] {
  return manifest.disabled_signals.map(captureSignalLabel);
}

/**
 * One-line verdict on the offline trust chain (root → course_cert → manifest →
 * session), matching what validation check 2 reports.
 */
export function trustChainFact(manifest: AssignmentManifest): ManifestFact {
  switch (manifest.trust_chain) {
    case 'legacy':
      return {
        label: 'Trust chain',
        value: 'Not applicable (format 1.x)',
        tone: 'normal',
      };
    case 'unconfigured':
      return {
        label: 'Trust chain',
        value: 'Not verified — no root key configured',
        tone: 'warn',
      };
    case 'invalid':
      return {
        label: 'Trust chain',
        value: manifest.trust_chain_detail ?? 'Failed verification',
        tone: 'bad',
      };
    case 'verified':
      if (manifest.cert !== null && !manifest.cert.in_window) {
        return {
          label: 'Trust chain',
          value: `Verified — certificate ${manifest.cert.window_reason ?? 'out of window'}`,
          tone: 'warn',
        };
      }
      return { label: 'Trust chain', value: 'Verified offline', tone: 'normal' };
  }
}

/**
 * The manifest facts worth showing next to the assignment, in display order.
 *
 * Returns an empty list for a 1.x bundle: it carries no course id, no
 * capability flags and no policy, and rendering four "—" rows would imply the
 * information is missing rather than that the format predates it.
 */
export function manifestFacts(manifest: AssignmentManifest): ManifestFact[] {
  if (manifest.format_version !== '2.0') return [];

  const facts: ManifestFact[] = [];
  if (manifest.course_id !== null) {
    facts.push({ label: 'Course', value: manifest.course_id });
  }
  if (manifest.collaboration !== null) {
    facts.push({
      label: 'Collaboration',
      value: manifest.collaboration === 'group' ? 'Group' : 'Solo',
    });
  }
  if (manifest.submission !== null) {
    facts.push({
      label: 'Submission',
      value: manifest.submission === 'git' ? 'Git repository' : 'Sealed bundle',
    });
  }
  if (manifest.scope !== null) {
    facts.push({
      label: 'Scope',
      value: manifest.scope === 'repo' ? 'Whole repository' : 'Directory',
    });
  }
  facts.push(trustChainFact(manifest));

  if (manifest.cert !== null) {
    facts.push({
      label: 'Certificate validity',
      value: `${manifest.cert.valid_from} → ${manifest.cert.valid_until}`,
      tone: manifest.cert.in_window ? 'normal' : 'warn',
    });
  }

  return facts;
}

/**
 * Should the manifest panel render at all?
 *
 * A 1.x bundle with nothing disabled has nothing to say, and an empty panel is
 * worse than no panel.
 */
export function hasManifestFacts(manifest: AssignmentManifest | undefined): boolean {
  if (manifest === undefined) return false;
  return manifest.format_version === '2.0' || manifest.disabled_signals.length > 0;
}
