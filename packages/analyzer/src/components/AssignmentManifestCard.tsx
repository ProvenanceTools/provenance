/**
 * AssignmentManifestCard — the Manifest 2.0 metadata a bundle carries
 * (program spec §3/§4): course, capability flags, certificate validity, the
 * offline trust-chain verdict, and — most importantly — which capture signals
 * the course switched off.
 *
 * That last list is why this card exists. Without it a reviewer reading a
 * submission from a course that disabled terminal capture sees no terminal
 * events and no terminal-related flags, and has no way to tell that from a
 * student who never opened one. Absent by policy and absent by omission look
 * identical on screen unless the policy is on screen too.
 *
 * Presentational only. It renders nothing for a 1.x bundle with nothing
 * disabled — an empty card is worse than no card — so callers can mount it
 * unconditionally. Used by both the server-backed submission Overview and the
 * in-browser `/local` overview; both pass the same `AssignmentManifest` shape.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Badge } from '@/components/ui/badge.js';
import type { AssignmentManifest } from '@provenance/shared/api-schemas';
import { manifestFacts, disabledSignalLabels, hasManifestFacts } from '../lib/manifest-facts.js';
import type { ManifestFact } from '../lib/manifest-facts.js';

const TONE_CLASSES: Record<NonNullable<ManifestFact['tone']>, string> = {
  normal: 'text-gray-900',
  warn: 'text-amber-700',
  bad: 'text-red-700',
};

export function AssignmentManifestCard({ manifest }: { manifest: AssignmentManifest | undefined }) {
  if (!hasManifestFacts(manifest) || manifest === undefined) return null;

  const facts = manifestFacts(manifest);
  const disabled = disabledSignalLabels(manifest);

  return (
    <Card data-testid="assignment-manifest-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Assignment manifest</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {facts.length > 0 && (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 text-sm">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt className="text-gray-500">{fact.label}</dt>
                <dd
                  className={`font-medium break-words ${TONE_CLASSES[fact.tone ?? 'normal']}`}
                  data-testid={`manifest-fact-${fact.label.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        )}

        <div data-testid="manifest-capture-policy">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Capture policy
          </p>
          {disabled.length === 0 ? (
            <p className="text-sm text-gray-600">
              All capture signals were enabled for this assignment.
            </p>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                This course disabled the following signals. Their absence from the log is course
                policy, not student behaviour, and heuristics that depend on them did not run.
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {disabled.map((label) => (
                  <li key={label}>
                    <Badge variant="secondary" data-testid={`manifest-disabled-${label}`}>
                      {label}
                    </Badge>
                  </li>
                ))}
              </ul>
            </>
          )}
          {manifest.heartbeat_interval_ms !== 30_000 && (
            <p className="mt-2 text-xs text-gray-500" data-testid="manifest-heartbeat-interval">
              Heartbeat cadence: {Math.round(manifest.heartbeat_interval_ms / 1000)}s (default 30s).
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
