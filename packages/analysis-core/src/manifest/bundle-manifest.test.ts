import { describe, it, expect } from 'vitest';
import { DEFAULT_CAPTURE_POLICY } from '@provenance/log-core';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import {
  buildTrustChainKeys,
  buildManifest2,
  sessionStart2,
} from '../test-support/build-manifest-2.js';
import { loadBundle } from '../loader/parse-bundle.js';
import type { Bundle } from '../loader/types.js';
import {
  readSessionManifests,
  resolveBundleCapturePolicy,
  isSignalCaptured,
  bundleHeartbeatIntervalMs,
  verifyBundleTrustChain,
  establishBundleTrust,
  summarizeBundleManifest,
} from './bundle-manifest.js';

async function load(built: { zipBuffer: ArrayBuffer }): Promise<Bundle> {
  const res = await loadBundle(built.zipBuffer, 'b.zip', () => '2026-01-01T00:00:00.000Z');
  if (!res.ok) throw new Error(`load failed: ${JSON.stringify(res.error)}`);
  return res.value;
}

describe('readSessionManifests', () => {
  it('returns a null manifest for every session of a 1.x bundle', async () => {
    const bundle = await load(await buildTestBundle({ sessions: [{}, {}] }));
    const bindings = readSessionManifests(bundle);
    expect(bindings).toHaveLength(2);
    for (const b of bindings) {
      expect(b.manifest).toBeNull();
      expect(b.manifestError).toBeNull();
      expect(b.manifestSig).toBe('placeholder-sig');
    }
  });

  it('extracts the embedded manifest from a 2.0 bundle', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys });
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStart2(manifest) }] }),
    );
    const [binding] = readSessionManifests(bundle);
    expect(binding!.manifest?.course_id).toBe('berkeley-cs61b');
    expect(binding!.manifestSig).toBe(manifest.sig);
  });

  it('reports a shape error rather than throwing when the embedded manifest is malformed', async () => {
    const bundle = await load(
      await buildTestBundle({
        sessions: [{ sessionStart: { manifest: { format_version: '2.0', assignment_id: 'x' } } }],
      }),
    );
    const [binding] = readSessionManifests(bundle);
    expect(binding!.manifest).toBeNull();
    expect(binding!.manifestError).toContain('semester');
  });
});

describe('resolveBundleCapturePolicy', () => {
  it('resolves a 1.x bundle to the default (everything on) policy', async () => {
    const bundle = await load(await buildTestBundle({ sessions: [{}] }));
    const resolved = resolveBundleCapturePolicy(bundle);
    expect(resolved.source).toBe('default');
    expect(resolved.effective).toEqual(DEFAULT_CAPTURE_POLICY);
    expect(resolved.disabledSignals).toEqual([]);
  });

  it('reads the course policy out of a VERIFIED 2.0 manifest', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys,
      policy: {
        capture: { selection_change: false, terminal: false, heartbeat_interval_ms: 90_000 },
      },
    });
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStart2(manifest) }] }),
    );
    await establishBundleTrust(bundle, keys.rootPubkeyHex);

    const resolved = resolveBundleCapturePolicy(bundle);
    expect(resolved.source).toBe('manifest_2_0');
    expect(resolved.effective.selection_change).toBe(false);
    expect(resolved.effective.terminal).toBe(false);
    expect(resolved.effective.focus_change).toBe(true);
    expect(resolved.effective.heartbeat_interval_ms).toBe(90_000);
    expect(resolved.disabledSignals).toEqual(['selection_change', 'terminal']);
    expect(resolved.claimedDisabledSignals).toEqual(['selection_change', 'terminal']);
  });

  it('ignores the policy of a 2.0 manifest whose chain has not been verified', async () => {
    // The gate the whole policy mechanism rests on: `policy` lives inside the
    // signed payload so a professor can turn capture down and a student cannot
    // turn it off, and that only holds if the signature is checked FIRST. An
    // unstamped bundle — nobody ran check 2, or it failed — resolves to the
    // defaults: everything captured, heuristics fire, staff review.
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys,
      policy: {
        capture: { selection_change: false, terminal: false, heartbeat_interval_ms: 90_000 },
      },
    });
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStart2(manifest) }] }),
    );

    const resolved = resolveBundleCapturePolicy(bundle);
    expect(resolved.source).toBe('unverified_manifest');
    expect(resolved.effective).toEqual(DEFAULT_CAPTURE_POLICY);
    expect(resolved.disabledSignals).toEqual([]);
    // …but the refused request is still reported, so staff can see it.
    expect(resolved.claimedDisabledSignals).toEqual(['selection_change', 'terminal']);
    expect(isSignalCaptured(bundle, 'terminal')).toBe(true);
    expect(bundleHeartbeatIntervalMs(bundle)).toBe(30_000);

    // A failed verification is not merely "not yet verified": stamping the
    // verdict from a chain that did not check out must leave it ignored too.
    const wrongRoot = await buildTrustChainKeys(0x33, 0x44);
    await establishBundleTrust(bundle, wrongRoot.rootPubkeyHex);
    expect(resolveBundleCapturePolicy(bundle).disabledSignals).toEqual([]);
  });

  it('takes the most restrictive value when sessions disagree', async () => {
    const keys = await buildTrustChainKeys();
    const permissive = await buildManifest2({ keys, policy: { capture: {} } });
    const strict = await buildManifest2({
      keys,
      policy: { capture: { focus_change: false, heartbeat_interval_ms: 120_000 } },
    });
    const bundle = await load(
      await buildTestBundle({
        sessions: [
          { sessionStart: sessionStart2(permissive) },
          { sessionStart: sessionStart2(strict) },
        ],
      }),
    );
    // Both manifests are genuinely signed; the sessions disagreeing is what is
    // under test, so the bundle is stamped verified directly rather than
    // through the chain walk (which rejects a mixed `manifest_sig` bundle).
    bundle.capturePolicyTrust = 'verified';

    const resolved = resolveBundleCapturePolicy(bundle);
    // Disabled anywhere → treated as disabled everywhere: absence is explained.
    expect(resolved.effective.focus_change).toBe(false);
    // Longest interval wins so interval-derived thresholds stay permissive.
    expect(resolved.effective.heartbeat_interval_ms).toBe(120_000);
  });

  it('isSignalCaptured / bundleHeartbeatIntervalMs are 1.x-safe', async () => {
    const bundle = await load(await buildTestBundle({ sessions: [{}] }));
    expect(isSignalCaptured(bundle, 'terminal')).toBe(true);
    expect(isSignalCaptured(bundle, 'selection_change')).toBe(true);
    expect(bundleHeartbeatIntervalMs(bundle)).toBe(30_000);
  });
});

describe('verifyBundleTrustChain', () => {
  it('reports "legacy" for a 1.x bundle even when a root key is configured', async () => {
    const keys = await buildTrustChainKeys();
    const bundle = await load(await buildTestBundle({ sessions: [{}] }));
    const result = await verifyBundleTrustChain(bundle, keys.rootPubkeyHex);
    expect(result.kind).toBe('legacy');
  });

  it('verifies root → course → manifest → session for a well-formed 2.0 bundle', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys });
    const bundle = await load(
      await buildTestBundle({
        sessions: [
          { sessionStart: sessionStart2(manifest) },
          { sessionStart: sessionStart2(manifest) },
        ],
      }),
    );
    const result = await verifyBundleTrustChain(bundle, keys.rootPubkeyHex);
    expect(result.kind).toBe('verified');
    if (result.kind !== 'verified') throw new Error('unreachable');
    expect(result.chain.course_id).toBe('berkeley-cs61b');
    expect(result.chain.course_pubkey).toBe(keys.coursePubkeyHex);
    expect(result.chain.window.in_window).toBe(true);
  });

  it('rejects a certificate signed by the wrong root key', async () => {
    const keys = await buildTrustChainKeys();
    const other = await buildTrustChainKeys(0x33, 0x44);
    const manifest = await buildManifest2({ keys });
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStart2(manifest) }] }),
    );
    const result = await verifyBundleTrustChain(bundle, other.rootPubkeyHex);
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_root_signature');
  });

  it('rejects a manifest whose course_id does not match its certificate', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys,
      courseId: 'berkeley-cs61c',
      certCourseId: 'berkeley-cs61b',
    });
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStart2(manifest) }] }),
    );
    const result = await verifyBundleTrustChain(bundle, keys.rootPubkeyHex);
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') throw new Error('unreachable');
    expect(result.error.kind).toBe('course_id_mismatch');
  });

  it('rejects a session whose manifest_sig is not the embedded manifest sig', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys });
    const bundle = await load(
      await buildTestBundle({
        sessions: [{ sessionStart: { ...sessionStart2(manifest), manifest_sig: 'a'.repeat(128) } }],
      }),
    );
    const result = await verifyBundleTrustChain(bundle, keys.rootPubkeyHex);
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') throw new Error('unreachable');
    expect(result.error.kind).toBe('manifest_sig_mismatch');
  });

  it('rejects a policy tampered with after signing', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys });
    const tampered = { ...manifest, policy: { capture: { selection_change: false } } };
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStart2(tampered) }] }),
    );
    const result = await verifyBundleTrustChain(bundle, keys.rootPubkeyHex);
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_course_signature');
  });

  it('reports "unconfigured" when no root public key is available', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys });
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStart2(manifest) }] }),
    );
    const result = await verifyBundleTrustChain(bundle);
    expect(result.kind).toBe('unconfigured');
  });
});

describe('summarizeBundleManifest', () => {
  it('summarizes a 1.x bundle with no course metadata and no disabled signals', async () => {
    const bundle = await load(await buildTestBundle({ sessions: [{}] }));
    const summary = await summarizeBundleManifest(bundle);
    expect(summary.format_version).toBe('1.x');
    expect(summary.course_id).toBeNull();
    expect(summary.collaboration).toBeNull();
    expect(summary.disabled_signals).toEqual([]);
    expect(summary.trust_chain).toBe('legacy');
  });

  it('summarizes a 2.0 bundle including cert window and disabled signals', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys,
      collaboration: 'group',
      submission: 'git',
      scope: 'repo',
      policy: { capture: { focus_change: false, terminal: false } },
    });
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStart2(manifest) }] }),
    );
    const summary = await summarizeBundleManifest(bundle, keys.rootPubkeyHex);
    expect(summary.format_version).toBe('2.0');
    expect(summary.course_id).toBe('berkeley-cs61b');
    expect(summary.collaboration).toBe('group');
    expect(summary.submission).toBe('git');
    expect(summary.scope).toBe('repo');
    expect(summary.disabled_signals).toEqual(['focus_change', 'terminal']);
    expect(summary.trust_chain).toBe('verified');
    expect(summary.cert).toEqual({
      course_id: 'berkeley-cs61b',
      course_pubkey: keys.coursePubkeyHex,
      valid_from: '2026-08-20',
      valid_until: '2027-01-15',
      in_window: true,
      window_reason: null,
    });
  });

  it('marks an out-of-window certificate without failing the chain', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys,
      issuedAt: '2027-06-01T00:00:00Z',
    });
    const bundle = await load(
      await buildTestBundle({ sessions: [{ sessionStart: sessionStart2(manifest) }] }),
    );
    const summary = await summarizeBundleManifest(bundle, keys.rootPubkeyHex);
    expect(summary.trust_chain).toBe('verified');
    expect(summary.cert?.in_window).toBe(false);
    expect(summary.cert?.window_reason).toBe('after_valid_until');
  });
});
