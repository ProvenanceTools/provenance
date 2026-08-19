import { describe, it, expect } from 'vitest';
import { parseManifestValue } from '@provenance/log-core';
import type { Manifest } from '@provenance/log-core';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import {
  buildTrustChainKeys,
  buildManifest2,
  buildManifest1x,
  sessionStart1x,
  sessionStart2,
} from '../test-support/build-manifest-2.js';
import { loadBundle } from '../loader/parse-bundle.js';
import type { Bundle } from '../loader/types.js';
import { verifyManifestDowngrade, MANIFEST_2_ONLY_FIELDS } from './verify-manifest-downgrade.js';

async function load(built: { zipBuffer: ArrayBuffer }): Promise<Bundle> {
  const res = await loadBundle(built.zipBuffer, 'b.zip', () => '2026-01-01T00:00:00.000Z');
  if (!res.ok) throw new Error(`load failed: ${JSON.stringify(res.error)}`);
  return res.value;
}

/**
 * The attack, built exactly as the spec describes it (§3 step 0).
 *
 * Start from a manifest the course GENUINELY signed at 1.x — real signature,
 * real payload, nothing forged. Then staple on:
 *
 *   - that course's `course_cert`, which is public and root-signed and can be
 *     copied verbatim out of any 2.0 manifest the course ever issued;
 *   - a matching `course_id`, so step 3 of the chain walk would be satisfied;
 *   - an invented `policy` switching every capture signal off.
 *
 * At 1.x none of those three fields is inside the signed payload, so the 1.x
 * signature still verifies and the certificate's root signature still verifies.
 * Every signature in the artifact is individually valid. What is NOT valid is
 * the artifact: no 1.x signer ever emitted these fields.
 */
async function stapledLegacyManifest(formatVersion?: string): Promise<Record<string, unknown>> {
  const keys = await buildTrustChainKeys();
  const honest = await buildManifest1x({
    keys,
    ...(formatVersion === undefined ? {} : { formatVersion }),
  });
  const real2 = await buildManifest2({ keys });

  const stapled: Record<string, unknown> = { ...honest };
  if (formatVersion === undefined) delete stapled['format_version'];
  stapled['course_cert'] = real2.course_cert;
  stapled['course_id'] = 'berkeley-cs61b';
  stapled['policy'] = {
    capture: { selection_change: false, focus_change: false, terminal: false },
  };
  return stapled;
}

function sessionStartRaw(manifest: Record<string, unknown>): Record<string, unknown> {
  return {
    manifest_sig: manifest['sig'],
    manifest,
    host: {
      editor: 'vscode',
      editor_version: '1.100.0',
      editor_build: '',
      platform: 'darwin',
    },
  };
}

// ---------------------------------------------------------------------------
// The true positive
// ---------------------------------------------------------------------------

describe('verifyManifestDowngrade — the stapled 1.x manifest', () => {
  it('fails on a genuinely-signed 1.x manifest carrying course_cert, course_id and policy', async () => {
    const stapled = await stapledLegacyManifest();
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStartRaw(stapled) }] }),
    );

    const check = verifyManifestDowngrade(bundle);

    expect(check.id).toBe('manifest_downgrade');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('course_cert');
    expect(check.detail).toContain('course_id');
    expect(check.detail).toContain('policy');
    expect(check.supportingSeqs).toEqual([{ sessionId: bundle.sessions[0]!.sessionId, seq: 0 }]);
  });

  it('fires when format_version is absent entirely (a true pre-2.0 manifest)', async () => {
    const stapled = await stapledLegacyManifest();
    expect(stapled['format_version']).toBeUndefined();

    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStartRaw(stapled) }] }),
    );
    expect(verifyManifestDowngrade(bundle).status).toBe('fail');
  });

  it('fires on a 1.1 manifest too — every 1.x version signs the same four fields', async () => {
    const stapled = await stapledLegacyManifest('1.1');
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStartRaw(stapled) }] }),
    );

    const check = verifyManifestDowngrade(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('1.1');
  });

  it('fires on ANY single 2.0-only field, not just the three the attack uses', async () => {
    const keys = await buildTrustChainKeys();
    for (const field of MANIFEST_2_ONLY_FIELDS) {
      const honest = await buildManifest1x({ keys });
      const stapled: Record<string, unknown> = { ...honest, [field]: 'anything' };
      const bundle = await load(
        await buildTestBundle({ sessions: [{ sessionStart: sessionStartRaw(stapled) }] }),
      );

      const check = verifyManifestDowngrade(bundle);
      expect(check.status, `expected ${field} to be anomalous at 1.x`).toBe('fail');
      expect(check.detail).toContain(field);
    }
  });

  it('names every offending session when a bundle carries more than one', async () => {
    const stapled = await stapledLegacyManifest();
    const bundle = await load(
      await buildTestBundle({
        sessions: [
          { sessionStart: sessionStartRaw(stapled) },
          { sessionStart: sessionStartRaw(stapled) },
        ],
      }),
    );

    const check = verifyManifestDowngrade(bundle);
    expect(check.status).toBe('fail');
    expect(check.supportingSeqs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The false positives that matter more than the true positive
// ---------------------------------------------------------------------------

describe('verifyManifestDowngrade — honest bundles must never trip it', () => {
  it('passes an honest 1.x manifest embedded by a CURRENT recorder', async () => {
    // The grandfathered-cohort case. Every current recorder writes
    // `session.start.data.manifest` unconditionally, 1.x manifests included.
    // A refusal that fires on 100% of such a cohort is not a detection.
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest1x({ keys });
    const bundle = await load(
      await buildTestBundle({
        sessions: [
          { sessionStart: sessionStart1x(manifest) },
          { sessionStart: sessionStart1x(manifest) },
        ],
      }),
    );

    const check = verifyManifestDowngrade(bundle);
    expect(check.status).toBe('pass');
  });

  it('skips a pre-2.0 recorder bundle that embeds no manifest at all', async () => {
    const bundle = await load(await buildTestBundle({ sessions: [{}, {}] }));
    expect(verifyManifestDowngrade(bundle).status).toBe('skipped');
  });

  it('skips a genuine 2.0 bundle — every one of these fields belongs there', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys });
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStart2(manifest) }] }),
    );

    expect(verifyManifestDowngrade(bundle).status).toBe('skipped');
  });

  it('ignores a FUTURE format version — a 3.0 manifest is not this reader’s to judge', async () => {
    // Forward compatibility. A 3.0 manifest read by a 2.0-era reader carries
    // fields this reader does not know about and may legitimately carry every
    // 2.0 field too. Flagging it would turn the next format bump into a
    // repo-wide false-positive event.
    const keys = await buildTrustChainKeys();
    const real2 = await buildManifest2({ keys });
    const future: Record<string, unknown> = { ...real2, format_version: '3.0' };

    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStartRaw(future) }] }),
    );
    expect(verifyManifestDowngrade(bundle).status).toBe('skipped');
  });

  it('ignores unknown top-level keys on a 1.x manifest (forward compatibility)', async () => {
    const keys = await buildTrustChainKeys();
    const honest = await buildManifest1x({ keys });
    const withExtras: Record<string, unknown> = {
      ...honest,
      some_future_field: 'hello',
      another: { nested: true },
    };

    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStartRaw(withExtras) }] }),
    );
    expect(verifyManifestDowngrade(bundle).status).toBe('pass');
  });

  it('treats a 1.x format_version field as additive, never as the anomaly', async () => {
    // `format_version: '1.0'` is written by current tooling on an honest 1.x
    // manifest. Only its ABSENCE identifies a pre-2.0 manifest; its presence at
    // a 1.x value carries no claim at all.
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest1x({ keys, formatVersion: '1.0' });
    expect(manifest.format_version).toBe('1.0');

    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStart1x(manifest) }] }),
    );
    expect(verifyManifestDowngrade(bundle).status).toBe('pass');
  });

  it('does not throw on a malformed embedded manifest', async () => {
    // Check 2 already reports this as `embedded_manifest_invalid`; this check
    // must not double-report it or blow up on it.
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: { manifest: 'not-an-object' } }] }),
    );
    expect(verifyManifestDowngrade(bundle).status).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// The evidence source
// ---------------------------------------------------------------------------

describe('verifyManifestDowngrade — reads the RAW embedded manifest', () => {
  it('sees fields that parseManifestValue would have stripped', async () => {
    // This is the whole reason the check can exist. `parseManifestValue` drops
    // every 2.0-only field below 2.0, so any consumer reading the PARSED form
    // is looking at an artifact with the evidence already removed. The raw
    // object survives on `session.start.data.manifest` because the loader hands
    // `data` through from JSON.parse untouched.
    const stapled = await stapledLegacyManifest();
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStartRaw(stapled) }] }),
    );

    const raw = bundle.sessions[0]!.firstEvent.data.manifest as unknown as Record<string, unknown>;
    expect(raw['course_cert']).toBeDefined();
    expect(raw['policy']).toBeDefined();

    // …while the parsed form has none of it.
    const parsed = parseManifestValue(raw);
    expect(parsed.ok).toBe(true);
    const value = (parsed as { ok: true; value: Manifest }).value;
    expect(value.course_cert).toBeUndefined();
    expect(value.course_id).toBeUndefined();
    expect(value.policy).toBeUndefined();

    expect(verifyManifestDowngrade(bundle).status).toBe('fail');
  });
});
