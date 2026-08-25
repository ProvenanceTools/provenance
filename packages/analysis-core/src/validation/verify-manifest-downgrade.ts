/**
 * Manifest downgrade detection — a 1.x assignment manifest carrying
 * Manifest 2.0-only fields.
 *
 * Program spec §3, step 0
 * (`docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`).
 *
 * ## The attack this is the detection for
 *
 * Manifest 2.0's chain walk refuses a non-2.0 manifest at step 0. The reason is
 * a real attack: at 1.x, `course_id`, `collaboration`, `submission`, `scope` and
 * `policy` are NOT inside the signed payload, and `course_cert` is not part of
 * the format at all. So a student holding a manifest their own course
 * genuinely signed at 1.x can staple on:
 *
 *   - that course's `course_cert` — public, root-signed, copyable verbatim out
 *     of any 2.0 manifest the course ever issued;
 *   - a matching `course_id`, satisfying chain step 3;
 *   - an invented `policy` switching every capture signal off.
 *
 * Every signature in the resulting artifact still verifies individually. The
 * 1.x payload signature covers only the four 1.x fields, and the certificate's
 * root signature covers only the certificate.
 *
 * ## Why this is a detection and not a refusal
 *
 * The attack is already neutralised, twice over. `parseManifestValue` returns
 * early for any non-2.0 `format_version` and the object it hands back carries
 * only the four 1.x fields plus `sig`, so the invented policy never reaches
 * `resolveCapturePolicy` and the off-switch is never granted; and step 0 makes
 * the chain walk refuse with an honest cause rather than a misleading
 * `missing_course_cert`.
 *
 * What was missing was any signal that someone TRIED. Making check 2 fail on
 * this was considered and rejected (commit 4291477): the failure was
 * unreachable without also failing every honest 1.x bundle, because every
 * current recorder embeds the 1.x manifest it activated against. A refusal
 * firing on 100% of a grandfathered cohort is not a detection.
 *
 * This is the positive form instead. An honest 1.x manifest carries **none** of
 * these fields — no 1.x signer has ever emitted one, in any of the three
 * recorders or in course-staff tooling. One that carries them was modified
 * after it was signed, and the modification is legible even though it achieved
 * nothing.
 *
 * ## Where the evidence lives
 *
 * On the RAW `session.start.data.manifest` object, and nowhere else. The
 * loader hands each event's `data` through from `JSON.parse` untouched
 * (`log-core/ndjson.ts` validates that `data` is an object and does not rebuild
 * it), so the stapled keys survive into the bundle verbatim.
 *
 * Every *parsed* path has already destroyed the evidence:
 * `readSessionManifests` runs each embedded manifest through
 * `parseManifestValue`, which strips every 2.0-only field below 2.0 — which is
 * precisely what makes the attack harmless and precisely what makes the parsed
 * form useless here. This module therefore reads the raw object directly and
 * deliberately does not go through `readSessionManifests`.
 *
 * ## Which fields are anomalous, and which are not
 *
 * {@link MANIFEST_2_ONLY_FIELDS} is a CLOSED list of the six keys this reader
 * knows to be 2.0-only: the five 2.0 additions to the signed payload, plus
 * `course_cert`, which travels outside it. Their presence on a sub-2.0 manifest
 * is impossible by construction, so it is evidence rather than inference.
 *
 * Two deliberate exclusions:
 *
 *  - **`format_version` itself is NOT anomalous.** A 1.x manifest may carry
 *    `format_version: '1.0'` or `'1.1'` — `parseManifestValue` accepts any
 *    `1.*` — and it is the field's *absence*, not its presence, that identifies
 *    a pre-2.0 manifest. Treating a stamped 1.x version as suspicious would
 *    false-positive on every manifest written by tooling that stamps it.
 *  - **Unknown top-level keys are ignored.** Program spec §3 requires them to
 *    stay ignorable for forward compatibility, and canonicalization operates on
 *    named fields only, so an unknown key cannot change the signed bytes. That
 *    is also why the version test below only ever looks at `1.*`: a 3.0
 *    manifest read by a 2.0-era reader legitimately carries every 2.0 field and
 *    more, and is not this reader's to judge.
 *
 * ## Not one of the eight
 *
 * PRD §5.4's eight checks are a frozen, persisted contract: the server has
 * eight `check_N_status` columns, asserts `checks.length === 8` at ingest, and
 * reconstructs stored reports on the same assumption. So this check is
 * deliberately NOT added to `ValidationReport.checks`.
 *
 * It is instead computed by `runValidation` alongside the other bundle-level
 * detections and returned on `ValidationReport.bundleDetections`, from where
 * `heuristics/integrity-flags.ts` turns it into a `Flag` through the same
 * `CHECK_META` mapping it uses for the eight. That placement is what keeps it
 * idempotent between ingest and recompute: both call `runValidation` against a
 * freshly parsed bundle, so the verdict is recomputed every time rather than
 * resurrected from a stored row that never carried it. `bundleDetections` is
 * deliberately excluded from `overall`, which stays derived from the eight.
 */

import { MANIFEST_FORMAT_VERSION_LEGACY } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

const LABEL = 'Manifest 2.0 fields on a 1.x assignment manifest';

/**
 * The closed set of keys that arrived with Manifest 2.0 and can never appear on
 * a manifest a 1.x signer produced.
 *
 * Order is fixed so `detail` is deterministic for snapshots and staff-facing
 * export. `course_cert` leads because it is the stapled artifact the attack
 * turns on.
 */
export const MANIFEST_2_ONLY_FIELDS = [
  'course_cert',
  'course_id',
  'collaboration',
  'submission',
  'scope',
  'policy',
] as const;

export type Manifest2OnlyField = (typeof MANIFEST_2_ONLY_FIELDS)[number];

type Offence = {
  sessionId: string;
  formatVersion: string;
  fields: Manifest2OnlyField[];
};

/**
 * Read the manifest's declared version WITHOUT parsing it.
 *
 * Returns `null` when the raw value is not a manifest-shaped object at all, or
 * when `format_version` is present but not a string. Both are malformed rather
 * than downgraded, and check 2 already reports them as
 * `embedded_manifest_invalid`; re-reporting them here would double-count one
 * defect as two findings.
 */
function rawFormatVersion(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const declared = (raw as Record<string, unknown>)['format_version'];
  if (declared === undefined) return MANIFEST_FORMAT_VERSION_LEGACY;
  if (typeof declared !== 'string') return null;
  return declared;
}

/**
 * Detect 2.0-only fields on a sub-2.0 embedded manifest.
 *
 * Pure and synchronous — no crypto, no I/O. It asks one structural question,
 * and the answer does not depend on any key being configured, so it is
 * available on every deployment including one with no root public key.
 *
 * Statuses:
 *  - `fail`    — at least one session embeds a 1.x manifest carrying at least
 *                one 2.0-only field.
 *  - `pass`    — at least one 1.x manifest was inspected and all were clean.
 *  - `skipped` — nothing sub-2.0 to inspect: a pre-2.0 recorder that embeds no
 *                manifest, a genuine 2.0 bundle, a future format version, or a
 *                malformed embedded manifest (check 2's finding, not this one).
 */
export function verifyManifestDowngrade(bundle: Bundle): ValidationCheck {
  const offences: Offence[] = [];
  let inspected = 0;

  for (const session of bundle.sessions) {
    const raw: unknown = session.firstEvent.data.manifest;
    if (raw === undefined || raw === null) continue;

    const formatVersion = rawFormatVersion(raw);
    if (formatVersion === null) continue;
    // 2.0 and anything beyond it are out of scope — see the docstring.
    if (!formatVersion.startsWith('1.')) continue;

    inspected++;
    const obj = raw as Record<string, unknown>;
    const fields = MANIFEST_2_ONLY_FIELDS.filter((f) => obj[f] !== undefined);
    if (fields.length > 0) {
      offences.push({ sessionId: session.sessionId, formatVersion, fields: [...fields] });
    }
  }

  if (offences.length > 0) {
    const per = offences
      .map(
        (o) =>
          `session ${o.sessionId} (format_version ${o.formatVersion}) carries ${o.fields.join(', ')}`,
      )
      .join('; ');

    return {
      id: 'manifest_downgrade',
      label: LABEL,
      status: 'fail',
      detail:
        `Embedded assignment manifest below format_version 2.0 carries Manifest 2.0-only ` +
        `field(s): ${per}. A 1.x manifest's signature covers only assignment_id, semester, ` +
        `issued_at and files_under_review, so these fields sit outside it and no 1.x signer ` +
        `ever emits them — their presence means the manifest was modified after it was signed. ` +
        `Nothing was granted by it: every 2.0-only field is stripped from a sub-2.0 manifest ` +
        `before any reader consults it, so no capture policy was honoured, no certificate was ` +
        `believed, and the recording itself is unaffected.`,
      supportingSeqs: offences.map((o) => ({ sessionId: o.sessionId, seq: 0 })),
    };
  }

  if (inspected === 0) {
    return {
      id: 'manifest_downgrade',
      label: LABEL,
      status: 'skipped',
      detail:
        'No session embeds an assignment manifest below format_version 2.0, so there is ' +
        'nothing for this check to inspect.',
    };
  }

  return {
    id: 'manifest_downgrade',
    label: LABEL,
    status: 'pass',
    detail:
      `${inspected} embedded 1.x manifest(s) inspected; none carries a Manifest 2.0-only ` +
      `field. This is what an honest 1.x manifest looks like.`,
  };
}
