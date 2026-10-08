/**
 * reviewed-scope.ts — which paths the per-file heuristics may evaluate.
 *
 * A student's editor opens plenty of files that are not part of what is graded:
 * build and test artifacts written by a tool, workspace settings, scratch
 * files. Their content is frequently machine-written, so the per-file
 * heuristics (paste size, typed-vs-final ratio, paste-is-solution, ...) fire on
 * them with no bearing on the student's own work.
 *
 * When the signed manifest says what is under review, only paths whose role is
 * `reviewed` are evaluated. This reuses log-core's `resolvePathRole` — the one
 * matcher the recorders also use — rather than a second implementation.
 *
 * A manifest carrying NO scope information at all (all three lists empty, e.g.
 * a bundle sealed before scope existed) keeps the historical behaviour:
 * every path is evaluated. `attachment` paths are never captured and are
 * treated as not reviewed.
 *
 * Only the per-file heuristics call this, and they filter their OUTPUT (which
 * file a flag is about), not the EventIndex: session-level heuristics and the
 * internal-move classifier still see every event, so a paste sourced from a
 * scratch file is still recognised as the student moving their own text.
 */

import { resolvePathRole, scopeFromManifest } from '@provenance/log-core';
import type { ResolvedScope } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import {
  bundleCapturePolicyTrust,
  isManifest2Binding,
  readSessionManifests,
} from '../manifest/bundle-manifest.js';

export type ReviewedPathPredicate = (path: string) => boolean;

const ALL_PATHS: ReviewedPathPredicate = () => true;

/**
 * The scope this bundle declares, or `null` when it declares none.
 *
 * Sources, strongest first:
 *  1. The manifest each session embedded in `session.start`, unioned across
 *     sessions. A 2.0 manifest is honoured only once the bundle's trust chain
 *     verified: scope can only SUPPRESS flags, so an unverified claim narrows
 *     nothing (the same rule `resolveBundleCapturePolicy` applies to policy).
 *     A 1.x manifest carries no chain to verify and is read as it stands.
 *  2. Absent any embedded manifest, the sealed bundle manifest's
 *     `submission_files`, whose per-file `role` records what the recorder
 *     treated as reviewed vs attachment.
 */
function declaredScope(bundle: Bundle): ResolvedScope | null {
  const track = new Set<string>();
  const ignore = new Set<string>();
  const attachments = new Set<string>();
  let sawEmbedded = false;

  for (const binding of readSessionManifests(bundle)) {
    if (binding.manifest === null) continue;
    sawEmbedded = true;
    if (isManifest2Binding(binding) && bundleCapturePolicyTrust(bundle) !== 'verified') {
      // Unverified 2.0 claim: evaluate everything, as for a bundle with no scope.
      return null;
    }
    const scope = scopeFromManifest(binding.manifest);
    for (const e of scope.track) track.add(e);
    for (const e of scope.ignore) ignore.add(e);
    for (const e of scope.attachments) attachments.add(e);
  }

  if (!sawEmbedded) {
    for (const f of bundle.manifest.submission_files ?? []) {
      (f.role === 'attachment' ? attachments : track).add(f.path);
    }
  }

  if (track.size === 0 && ignore.size === 0 && attachments.size === 0) return null;
  return { track: [...track], ignore: [...ignore], attachments: [...attachments] };
}

export function reviewedPathPredicate(bundle: Bundle): ReviewedPathPredicate {
  const scope = declaredScope(bundle);
  if (scope === null) return ALL_PATHS;
  return (path) => resolvePathRole(path, scope) === 'reviewed';
}
