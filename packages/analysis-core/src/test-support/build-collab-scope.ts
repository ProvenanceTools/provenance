/**
 * Test-only helper: a two-partner scope with a `git pull`, for Tier 3.1.
 *
 * Every consumer of the external-change classification needs the same three
 * fixtures — a pull that delivered a partner's recorded work, a pull that
 * delivered content nobody recorded, and the solo control — and hand-rolling
 * the identity plumbing in each test file is how the three drift apart until one
 * of them is quietly testing nothing. (The decision log's §5 catalogue of
 * decorative tests is the reason this is shared rather than copied.)
 *
 * Not browser-safe by design: test infrastructure only.
 */

import { sha256Hex } from '@provenance/log-core';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle, type EventSpec } from '../test-support/build-test-bundle.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
  type IdentityTestKeys,
} from './build-identity.js';
import { establishBundleContributors } from '../identity/resolve-contributors.js';
import type { Bundle } from '../loader/types.js';
import type { EventIndex } from '../index/event-index.js';

export const COLLAB_ALICE = '9c8e1a70-2f2b-4c55-8f1e-6b4a0d9c7e21';
export const COLLAB_BOB = '3a1d0e55-8c44-4b2a-a7f0-11c9d2e3f4a5';

/** Full-length and distinct: the DAG compares shas exactly, never abbreviated. */
export const COLLAB_C0 = 'a'.repeat(40);
export const COLLAB_C1 = 'b'.repeat(40);
export const COLLAB_C2 = 'c'.repeat(40);

export const COLLAB_FILE = 'hw1.py';

let cachedKeys: IdentityTestKeys | null = null;
async function keys(): Promise<IdentityTestKeys> {
  cachedKeys ??= await buildIdentityKeys();
  return cachedKeys;
}

export type CollabWho = { studentRef: string } | 'anonymous';

/**
 * Build and index a bundle whose sessions carry real, verifiable institution
 * identities, and stamp the contributor verdict.
 *
 * `stamp: false` leaves the bundle unstamped — how a caller that forgot to
 * establish contributors sees the world, which must lose no findings.
 */
export async function buildCollabScope(
  specs: Array<{ who: CollabWho; events: EventSpec[] }>,
  opts: { stamp?: boolean } = {},
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const k = await keys();
  const sessions = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const sk = await seededKeypair(0x60 + i);
    sessions.push({
      events: spec.events,
      sessionStart: {
        session_pubkey: sk.pubkeyHex,
        ...(spec.who === 'anonymous'
          ? {}
          : {
              identity: await buildInstitutionIdentity({
                keys: k,
                sessionPubkeyHex: sk.pubkeyHex,
                studentRef: spec.who.studentRef,
              }),
            }),
      },
    });
  }

  const { zipBuffer } = await buildTestBundle({ sessions });
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  const bundle = result.value;
  if (opts.stamp !== false) await establishBundleContributors(bundle, k.root.pubkeyHex);
  return { bundle, index: buildIndex(bundle) };
}

/** A `git.event` naming a commit. `parents` omitted means "unrecorded", not "root". */
export function collabGitEvent(sha: string, parents?: string[]): EventSpec {
  return {
    kind: 'git.event',
    data: {
      operation: 'state_change',
      sha,
      commit_sha: sha,
      branch: 'main',
      ...(parents === undefined ? {} : { parents }),
    },
  };
}

export function collabDocOpen(content: string, path = COLLAB_FILE): EventSpec {
  return {
    kind: 'doc.open',
    data: { path, content, sha256: sha256Hex(content), line_count: 1 },
  };
}

export function collabDocSave(content: string, path = COLLAB_FILE): EventSpec {
  return { kind: 'doc.save', data: { path, sha256: sha256Hex(content) } };
}

/**
 * `explanation` stamps the recorder's timing-derived tag on the change, exactly
 * as `explanation-tags.ts` does when the write lands within its window after a
 * git state change. Needed to exercise D16, where a content-derived
 * `git_unrecorded_in` overrides an `explanation: 'git'` tag.
 */
export function collabExternalChange(
  content: string,
  opts: { path?: string; t?: number; explanation?: 'git' | 'formatter' } = {},
): EventSpec {
  const spec: EventSpec = {
    kind: 'fs.external_change',
    data: {
      path: opts.path ?? COLLAB_FILE,
      operation: 'modify',
      old_hash: sha256Hex('stale\n'),
      new_hash: sha256Hex(content),
      new_content: content,
      new_content_size: content.length,
      diff_size: content.length,
      ...(opts.explanation === undefined ? {} : { explanation: opts.explanation }),
    },
  };
  return opts.t === undefined ? spec : { ...spec, t: opts.t };
}

/** The partner's session: they wrote the work, saved it, and committed it. */
export function collabPartnerSession(content: string): EventSpec[] {
  return [collabDocOpen(''), collabDocSave(content), collabGitEvent(COLLAB_C1, [COLLAB_C0])];
}

/**
 * The puller's session: HEAD is established, HEAD moves, the file changes
 * underneath them.
 *
 * `before` / `after` let a caller splice in the events a particular heuristic
 * needs (a `terminal.open`, a following `doc.save`) without rebuilding the shape.
 *
 * `merge: true` lands HEAD on a DESCENDANT of the partner's commit rather than
 * on the commit itself. That changes nothing about the classification — it is
 * a fixture concern. Two sessions that both observe only `C1` are `concurrent`
 * under `≺` (a commit is not its own ancestor), so Tier 2.2 refuses to
 * reconstruct the file and any content heuristic skips it for that reason
 * instead — which would make a Tier 3.1 assertion pass without testing Tier 3.1.
 */
export function collabPullerSession(
  newContent: string,
  opts: {
    before?: EventSpec[];
    /** Spliced in after the git observations and before the external change. */
    beforeChange?: EventSpec[];
    after?: EventSpec[];
    merge?: boolean;
    /** Stamp the recorder's timing tag on the change — the D16 fixture. */
    explanation?: 'git' | 'formatter';
  } = {},
): EventSpec[] {
  return [
    ...(opts.before ?? []),
    collabGitEvent(COLLAB_C0), // first observation — establishes HEAD, NOT a move
    collabGitEvent(COLLAB_C1, [COLLAB_C0]), // the pull: HEAD moves
    ...(opts.merge === true ? [collabGitEvent(COLLAB_C2, [COLLAB_C1])] : []),
    ...(opts.beforeChange ?? []),
    collabExternalChange(newContent, {
      ...(opts.explanation === undefined ? {} : { explanation: opts.explanation }),
    }),
    ...(opts.after ?? []),
  ];
}
