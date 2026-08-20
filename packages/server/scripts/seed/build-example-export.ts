/**
 * Builds the example Gradescope export ZIP used to seed a dev database.
 *
 * The output mirrors what Gradescope's "Download Submissions" produces AFTER a
 * student uploads the recorder's sealed bundle .zip: Gradescope extracts the
 * upload, so each submission appears as a FLAT folder of the bundle's files —
 * NOT a `.provenance/` subdirectory (that is only the recorder's on-disk working
 * dir; `sealBundle` flattens it at the zip root, see recorder PRD §5.3 and
 * `packages/analyzer/src/loader/unzip.ts`). The archive therefore contains:
 *   submission_metadata.yml              — submitter identities per submission
 *   submission_<key>/manifest.json       — signed BundleManifest 1.1
 *   submission_<key>/manifest.sig        — ed25519 sig over the canonical manifest
 *   submission_<key>/session-<uuid>.slog — NDJSON event log (hash-chained)
 *   submission_<key>/session-<uuid>.slog.meta — encrypted key + signed checkpoints
 *   submission_<key>/<assignment>.py     — the submitted file (whitelisted in the manifest)
 * plus a few non-bundle folders to exercise the "skipped" path.
 *
 * The bundles are produced with the SAME code path the real recorder seal uses
 * (`@provenance/log-core`: chainEntry/serializeEntry for the slog, the shared
 * session-key encryption, signed checkpoints, signBundleManifest), so a seed
 * bundle is byte-shape-identical to a real one: a real per-session ed25519
 * keypair, a real XChaCha20-encrypted session privkey, a real course manifest
 * signature (reused as the key-derivation IKM), an allowlisted extension hash,
 * unique session UUIDs, and doc.save hashes that actually reconstruct from the
 * recorded edits (so Check 7 passes by reconstruction and Check 8 matches).
 *
 * Everything except the per-build ed25519 keys is deterministic — roster,
 * assignments, event timelines, UUIDs and paste contents are all derived from
 * the student index, so the cohort, flags and cross-flags are stable across
 * regenerations (only the random signing keys, and the sigs/ciphertext derived
 * from them, change build-to-build).
 *
 * The cohort is sized for a realistic browse (~700 students across three
 * assignments) and seeds a spread of heuristic findings:
 *   - most students type normally (no flags),
 *   - some paste a large unique blob       → `large_paste` (per submission),
 *   - clusters of students paste IDENTICAL blobs on the same assignment
 *                                          → `large_paste` + `paste_shared_across_students`,
 *   - a fraction work long (>100-entry) sessions that carry signed checkpoints,
 *   - a few group submissions (co-submitters share a bundle) and a few
 *     no-recorder folders (rostered but skipped).
 *
 * This is dev tooling, not shipped server code — hence it lives under
 * `scripts/` and is free to import directly from `@provenance/log-core`.
 */

import JSZip from 'jszip';
import {
  chainEntry,
  serializeEntry,
  sha256Hex,
  canonicalize,
  GENESIS_PREV_HASH,
  generateSessionKeypair,
  encryptSessionPrivkey,
  signCheckpoint,
  signBundleManifest,
  signManifest,
} from '@provenance/log-core';
import type { BundleManifest, SlogMeta, Checkpoint, Envelope, Range } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Constants tied to real recorder behaviour
// ---------------------------------------------------------------------------

/** Tracks packages/recorder/package.json — the version the recorder stamps into session.start. */
const SEED_RECORDER_VERSION = '0.2.0';
/** A plausible VS Code build; the recorder VSIX requires ≥ 1.94. */
const SEED_VSCODE_VERSION = '1.94.2';
/**
 * One of the analyzer's known-good recorder hashes, so seed bundles are NOT
 * flagged `extension_hash_mismatch`. Keep in sync with
 * packages/analyzer/src/heuristics/config/known-good-extension-hashes.json.
 */
const SEED_EXTENSION_HASH = 'eb452af1aca3234fcdd23708e491d18b37ae26e2c46df893f787cf2fd9a13932';
/** Matches the recorder's CHECKPOINT_INTERVAL (extension.ts): one signed checkpoint per 100 entries. */
const CHECKPOINT_INTERVAL = 100;
/** Platforms the cohort's machines run, varied per student for realism. */
const PLATFORMS = ['darwin', 'linux', 'win32'] as const;
/** Base wall-clock epoch for the cohort's sessions (deterministic; spread per student). */
const SEED_EPOCH_MS = Date.parse('2026-06-10T15:00:00.000Z');

// A dedicated, clearly-labelled namespace so the seed NEVER collides with or
// mutates a real semester someone is working in. `ensureSemester` keys on this
// slug, so re-running only ever touches the seed's own semester.
export const SEED_SEMESTER = {
  courseName: 'CS 61A (seed)',
  courseSlug: 'seed-cs61a',
  term: 'fa' as const,
  year: 2026,
  slug: 'seed-demo',
  displayName: 'Seed Demo — CS 61A',
  // Gradescope ingest matches by metadata sid, not filename, but the column is
  // required and used by the non-Gradescope upload path.
  filenameConvention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
};

/** Semester string baked into each bundle manifest (cosmetic; ingest uses the DB semester). */
export const SEED_BUNDLE_SEMESTER = 'fa2026';

/** Assignments the cohort is spread across (drives the analyzer's assignment switcher). */
export const SEED_ASSIGNMENTS = ['hw10', 'hw11', 'proj02'] as const;

/** Default cohort size. */
export const SEED_STUDENT_COUNT = 700;

// ---------------------------------------------------------------------------
// Deterministic roster generation
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'Alice',
  'Bob',
  'Carol',
  'Dan',
  'Erin',
  'Frank',
  'Grace',
  'Hassan',
  'Iris',
  'Jian',
  'Kavya',
  'Leo',
  'Mira',
  'Noah',
  'Omar',
  'Priya',
  'Quinn',
  'Rosa',
  'Sam',
  'Tara',
  'Umar',
  'Vera',
  'Wes',
  'Xinyi',
  'Yara',
  'Zach',
  'Ana',
  'Bao',
  'Chloe',
  'Diego',
];
const LAST_NAMES = [
  'Adams',
  'Bauer',
  'Chen',
  'Diaz',
  'Evans',
  'Foster',
  'Gupta',
  'Huang',
  'Ito',
  'Jain',
  'Kim',
  'Lopez',
  'Mehta',
  'Nguyen',
  'Okoro',
  'Park',
  'Qureshi',
  'Rao',
  'Silva',
  'Tanaka',
  'Ueda',
  'Vargas',
  'Wong',
  'Xu',
  'Yadav',
  'Zhang',
  'Ali',
  'Brooks',
  'Cruz',
  'Dubois',
];

export interface SeedSubmitter {
  name: string;
  sid: string;
  email: string;
}

/** Deterministic student for index i (0-based). sids start at 200001. */
function makeStudent(i: number): SeedSubmitter {
  const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
  const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length]!;
  const sid = String(200001 + i);
  return {
    name: `${first} ${last}`,
    sid,
    email: `${first}.${last}${i}@berkeley.edu`.toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Paste-content plans
// ---------------------------------------------------------------------------

/**
 * Shared paste snippets. Students assigned the same snippet paste byte-identical
 * content, so the cross heuristic groups them (sha256-exact) into one
 * `paste_shared_across_students` flag. Two snippets per assignment; one of each
 * pair is long enough (≥500 chars) to be high-severity `large_paste` too.
 */
const SHARED_SNIPPETS: Array<{ assignment: string; text: string }> = SEED_ASSIGNMENTS.flatMap(
  (assignment, ai) => [
    {
      assignment,
      text:
        `# ${assignment} — shared solution A\n` +
        Array.from(
          { length: 14 },
          (_, j) => `    acc = acc + step(${(ai + 1) * (j + 1)})  # line ${j}`,
        ).join('\n') +
        '\n    return acc\n',
    },
    {
      assignment,
      text:
        `# ${assignment} — shared solution B\n` +
        Array.from(
          { length: 34 },
          (_, j) => `    total = total + helper(${(ai + 2) * (j + 3)}, ${j})  # row ${j}`,
        ).join('\n') +
        '\n    return total\n',
    },
  ],
);

/** A unique (per-student) large paste — distinct lines so solos never group together. */
function soloPasteText(student: SeedSubmitter): string {
  const lines = Array.from(
    { length: 12 },
    (_, j) =>
      `result_${student.sid}_${j} = compute(${(Number(student.sid) * (j + 1)) % 97}, "${student.name}")`,
  );
  return `# personal work — ${student.name} (${student.sid})\n${lines.join('\n')}\n`;
}

type PastePlan = { kind: 'clean' } | { kind: 'solo' } | { kind: 'shared'; snippetIndex: number };

/** Deterministic per-bundle paste plan. Keyed off the bundle's first submitter index. */
function pastePlanFor(studentIndex: number, assignment: string): PastePlan {
  if (studentIndex % 7 === 0) {
    const pool = SHARED_SNIPPETS.map((s, idx) => ({ s, idx })).filter(
      (e) => e.s.assignment === assignment,
    );
    const pick = pool[Math.floor(studentIndex / 7) % pool.length]!;
    return { kind: 'shared', snippetIndex: pick.idx };
  }
  if (studentIndex % 5 === 0) return { kind: 'solo' };
  return { kind: 'clean' };
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so each student's timeline is varied but reproducible.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** djb2 of a string → uint32, to perturb a student's PRNG per assignment. */
function strHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Event-stream construction (faithful: exact content reconstruction)
// ---------------------------------------------------------------------------

type EventSpec = { kind: string; data: Record<string, unknown> };

/** The single file a seed submission works on, named after the assignment. */
function submittedPathFor(assignmentId: string): string {
  return `${assignmentId}.py`;
}

/** A small starter skeleton the student "opens" (seeds doc.open content). */
function skeletonFor(assignmentId: string): string {
  return (
    `# ${assignmentId} — CS 61A\n` +
    `from operator import add, mul\n\n\n` +
    `def solve(data):\n    """TODO: implement."""\n    pass\n`
  );
}

/** Deterministic per-student typed line of code (unique so solos don't collide). */
function typedLine(student: SeedSubmitter, j: number): string {
  const n = (Number(student.sid) + j * 7) % 50;
  return `    step_${j} = transform(data[${n}], ${j})\n`;
}

/** Zero-width Range at the current end of `content` (so a delta/paste appends). */
function endRange(content: string): Range {
  const lines = content.split('\n');
  const last = lines.length - 1;
  const pos = { line: last, character: lines[last]!.length };
  return { start: pos, end: { ...pos } };
}

/**
 * Weighted mix of edit actions, drawn fresh each step from the SAME alphabet for
 * every student (doc.change is a minority, ~27%, so there are no long typing runs
 * and no universally-shared `doc.change|doc.change|doc.change` backbone). Each
 * student's short, independently-seeded random draw realizes a different small
 * subset of the possible event-kind 3-grams, which keeps the coarse cohort-wide
 * `editing_pattern_clone` heuristic (Jaccard ≥ 0.3 over kind 3-grams) from
 * collapsing normal students into clones. doc.open/doc.save are NOT in the mix —
 * they're placed structurally so reconstruction stays anchored (Check 7).
 */
const MIX_KINDS: ReadonlyArray<{ kind: string; w: number }> = [
  { kind: 'doc.change', w: 3 },
  { kind: 'selection.change', w: 2 },
  { kind: 'session.heartbeat', w: 2 },
  { kind: 'focus.change', w: 2 },
  { kind: 'git.event', w: 1 },
  { kind: 'terminal.open', w: 1 },
  { kind: 'doc.close', w: 1 },
];
const MIX_TOTAL_WEIGHT = MIX_KINDS.reduce((n, k) => n + k.w, 0);

/** Build one cosmetic (non-content) event of the given kind. */
function cosmeticForKind(kind: string, rng: () => number, path: string): EventSpec {
  switch (kind) {
    case 'selection.change':
      return { kind, data: { path, range: endRange(''), was_selection: rng() < 0.4 } };
    case 'session.heartbeat':
      return { kind, data: { focused: true, active_file: path, idle_since_ms: 0 } };
    case 'focus.change':
      return { kind, data: { gained: rng() < 0.5 } };
    case 'git.event':
      return { kind, data: { operation: rng() < 0.5 ? 'status' : 'diff' } };
    case 'doc.close':
      return { kind, data: { path } };
    default:
      return {
        kind: 'terminal.open',
        data: { terminal_id: 't1', shell: 'bash', shell_integration: true },
      };
  }
}

/**
 * Build one bundle's post-session.start event stream while tracking file content
 * exactly, so every doc.save sha256 reconstructs from the recorded doc.open
 * content + doc.change/paste edits (Check 7 passes by reconstruction) and the
 * submitted file equals the final recorded state (Check 8 matches).
 *
 * The FIRST doc.save is the freshly-opened skeleton (< 500 chars), which keeps
 * `time_to_first_save_anomaly` from firing regardless of session timing.
 */
function buildEventStream(
  assignmentId: string,
  student: SeedSubmitter,
  plan: PastePlan,
  longSession: boolean,
  rng: () => number,
): { events: EventSpec[]; submittedPath: string; submittedContent: string } {
  const path = submittedPathFor(assignmentId);
  let content = skeletonFor(assignmentId);
  let typed = 0;
  const events: EventSpec[] = [];

  const typeOneLine = (): EventSpec => {
    const range = endRange(content);
    const line = typedLine(student, typed);
    content += line;
    typed++;
    return { kind: 'doc.change', data: { path, deltas: [{ range, text: line }], source: 'typed' } };
  };
  const save = (): EventSpec => ({ kind: 'doc.save', data: { path, sha256: sha256Hex(content) } });

  let pasteText: string | null =
    plan.kind === 'solo'
      ? soloPasteText(student)
      : plan.kind === 'shared'
        ? SHARED_SNIPPETS[plan.snippetIndex]!.text
        : null;
  const emitPasteInto = (sink: EventSpec[]): void => {
    if (pasteText === null) return;
    const range = endRange(content);
    const text = pasteText;
    content += text;
    pasteText = null;
    sink.push({
      kind: 'paste',
      data: { path, range, length: text.length, sha256: sha256Hex(text), content: text },
    });
  };

  // A small random lead-in (window focus / idle heartbeats before the file is
  // opened) so doc.open isn't pinned to a fixed position in every bundle's kind
  // stream — otherwise [session.start|doc.open|…] would be a shared 3-gram across
  // the whole cohort and inflate editing_pattern_clone.
  const leadIn = Math.floor(rng() * 3);
  for (let i = 0; i < leadIn; i++) {
    events.push(cosmeticForKind(rng() < 0.5 ? 'focus.change' : 'session.heartbeat', rng, path));
  }

  // Open the file — inline content anchors reconstruction (Check 7).
  events.push({
    kind: 'doc.open',
    data: {
      path,
      sha256: sha256Hex(content),
      line_count: content.split('\n').length,
      content,
      truncated: false,
    },
  });

  // A short weighted-random mix from the shared alphabet (see MIX_KINDS). There
  // is exactly ONE doc.save — the FINAL save — so the kind stream carries no
  // shared save-grams; combined with the short random draw this keeps the coarse
  // cohort-wide editing_pattern_clone metric near-silent for normal students.
  // Long sessions just draw a longer mix (>100 entries → real signed checkpoints).
  // Keep the minimum comfortably above ~12 events: tiny kind streams have tiny
  // distinct-3-gram sets that two short bundles can easily overlap past the 0.3
  // Jaccard threshold, which is the only source of editing_pattern_clone noise.
  const mixLen = longSession ? 105 + Math.floor(rng() * 60) : 14 + Math.floor(rng() * 14);
  const pasteAt = pasteText !== null ? 1 + Math.floor(rng() * Math.max(1, mixLen - 1)) : -1;
  for (let i = 0; i < mixLen; i++) {
    if (i === pasteAt) emitPasteInto(events);
    let r = rng() * MIX_TOTAL_WEIGHT;
    let kind = MIX_KINDS[MIX_KINDS.length - 1]!.kind;
    for (const k of MIX_KINDS) {
      if (r < k.w) {
        kind = k.kind;
        break;
      }
      r -= k.w;
    }
    if (kind === 'doc.change') events.push(typeOneLine());
    else events.push(cosmeticForKind(kind, rng, path));
  }

  if (typed === 0) events.push(typeOneLine()); // the file must actually change
  emitPasteInto(events); // if the insertion point fell at/after the mix end
  // The single final save records the submitted file's final hash (Check 8 match).
  // buildBundleFiles guarantees this save lands > 30s after the doc.open, so
  // time_to_first_save_anomaly never fires even though content now exceeds 500 chars.
  events.push(save());

  // A small random wind-down (blur the window / close the tab after saving) so
  // doc.save isn't pinned to the last position in every bundle's kind stream.
  const windDown = Math.floor(rng() * 3);
  for (let i = 0; i < windDown; i++) {
    events.push(cosmeticForKind(rng() < 0.5 ? 'focus.change' : 'doc.close', rng, path));
  }

  return { events, submittedPath: path, submittedContent: content };
}

// ---------------------------------------------------------------------------
// Bundle file-set construction (real crypto via the shared log-core core)
// ---------------------------------------------------------------------------

/** Deterministic, random-looking UUIDv4 string from a seed (stable across regens). */
function deterministicUuid(seed: string): string {
  const h = sha256Hex(`seed-uuid:${seed}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Inter-event gap in ms: usually a few seconds, occasionally a longer "thinking" pause. */
function eventGapMs(rng: () => number): number {
  if (rng() < 0.08) return 8_000 + Math.floor(rng() * 52_000);
  return 400 + Math.floor(rng() * 5_000);
}

/**
 * Build the FLAT file set of one sealed bundle (the names + bytes that land at
 * the submission folder root), using the same log-core routines the recorder
 * seal uses. Returns a map of file name → contents.
 */
async function buildBundleFiles(
  assignmentId: string,
  student: SeedSubmitter,
  plan: PastePlan,
  longSession: boolean,
  courseSig: string,
): Promise<Record<string, string>> {
  const rng = mulberry32((Number(student.sid) ^ strHash(assignmentId)) >>> 0);
  const keypair = await generateSessionKeypair();
  const sessionId = deterministicUuid(`${assignmentId}:${student.sid}`);
  // The uuid in the `.slog` FILENAME — a DIFFERENT value from the logical
  // `session_id` above, exactly as production mints them (the writer names the
  // file `session-${randomUUID()}.slog` in `session-registry.ts`, while the
  // logical id is `recorderContext.session_id`).
  //
  // This one matters most of the four generators: it seeds the DEMO DATABASE, so
  // spelling both ids with one value made every bundle a reader could reach by
  // hand an A === B bundle. Anything checked against the demo data — by a person
  // or by a test — was therefore structurally incapable of reproducing an
  // id-space crossing, which is the exact property that hid a maximum-severity
  // false accusation (`log_bytes_match` firing on every honest git submission)
  // from 972 passing tests. See `analysis-core`'s `fakeLogFileUuid`.
  const logFileUuid = deterministicUuid(`logfile:${assignmentId}:${student.sid}`);
  const machineId = sha256Hex(`seed-machine:${student.sid}:${sessionId}`);
  const platform = PLATFORMS[Number(student.sid) % PLATFORMS.length]!;

  const { events, submittedPath, submittedContent } = buildEventStream(
    assignmentId,
    student,
    plan,
    longSession,
    rng,
  );

  const startData = {
    format_version: '1.0',
    session_id: sessionId,
    prev_session_id: null,
    assignment: { id: assignmentId, semester: SEED_BUNDLE_SEMESTER },
    manifest_sig: courseSig,
    machine_id: machineId,
    vscode: { version: SEED_VSCODE_VERSION, commit: '', platform },
    recorder: { version: SEED_RECORDER_VERSION, extension_id: 'provenance.recorder' },
    session_pubkey: keypair.publicKeyHex,
  };

  // Chain the entries exactly as the recorder does (log-core chainEntry +
  // serializeEntry), signing a checkpoint every CHECKPOINT_INTERVAL entries.
  const baseMs = SEED_EPOCH_MS + (Number(student.sid) % 5000) * 60_000;
  let prevHash = GENESIS_PREV_HASH;
  let t = 0;
  let entryCount = 0;
  const lines: string[] = [];
  const checkpoints: Checkpoint[] = [];

  const append = async (
    seq: number,
    kind: string,
    data: Record<string, unknown>,
  ): Promise<void> => {
    const envelope = {
      seq,
      t,
      wall: new Date(baseMs + t).toISOString(),
      kind,
      data,
    } as unknown as Envelope;
    const entry = chainEntry(prevHash, envelope);
    lines.push(serializeEntry(entry).trimEnd());
    prevHash = entry.hash;
    entryCount++;
    if (entryCount % CHECKPOINT_INTERVAL === 0) {
      checkpoints.push(await signCheckpoint(entry.seq, entry.hash, keypair.privateKey));
    }
  };

  await append(0, 'session.start', startData);
  // Force the single doc.save to land > 30s after the doc.open so
  // time_to_first_save_anomaly never fires (content > 500 chars by then).
  let openT = 0;
  for (let i = 0; i < events.length; i++) {
    t += eventGapMs(rng);
    if (events[i]!.kind === 'doc.open') openT = t;
    if (events[i]!.kind === 'doc.save') t = Math.max(t, openT + 35_000);
    await append(i + 1, events[i]!.kind, events[i]!.data);
  }
  const slogText = lines.join('\n') + '\n';

  // Encrypt the session privkey under the course manifest sig (the real IKM),
  // and assemble the .slog.meta exactly as MetaWriter does (canonicalized).
  const encryptedPrivkey = await encryptSessionPrivkey(keypair.privateKey, courseSig, sessionId);
  const meta: SlogMeta = {
    format_version: '1.0',
    session_id: sessionId,
    session_pubkey: keypair.publicKeyHex,
    encrypted_session_privkey: encryptedPrivkey,
    checkpoints,
  };
  const metaJson = canonicalize(meta);

  const manifest: BundleManifest = {
    format_version: '1.1',
    assignment_id: assignmentId,
    semester: SEED_BUNDLE_SEMESTER,
    extension_hash: SEED_EXTENSION_HASH,
    sessions: [
      {
        session_id: sessionId,
        prev_session_id: null,
        slog_sha256: sha256Hex(slogText),
        meta_sha256: sha256Hex(metaJson),
      },
    ],
    submission_files: [
      { path: submittedPath, status: 'present', sha256: sha256Hex(submittedContent) },
    ],
  };
  const signed = await signBundleManifest(manifest, keypair.privateKey);

  return {
    'manifest.json': signed.canonicalJson,
    'manifest.sig': signed.signatureHex,
    // Filenames take the FILE uuid; the manifest above takes the LOGICAL id.
    [`session-${logFileUuid}.slog`]: slogText,
    [`session-${logFileUuid}.slog.meta`]: metaJson,
    [submittedPath]: submittedContent,
  };
}

// ---------------------------------------------------------------------------
// Submission plan
// ---------------------------------------------------------------------------

interface SeedSubmission {
  folder: string;
  /** Assignment baked into the bundle manifest, or null for the no-recorder case. */
  assignmentId: string | null;
  submitters: SeedSubmitter[];
  plan: PastePlan;
  /** Long (>100-entry) session → carries signed checkpoints. */
  longSession: boolean;
}

export interface SeedStats {
  roster: number;
  bundles: number;
  submissionsQueued: number;
  skipped: number;
  assignments: readonly string[];
  pasteBundles: number;
  sharedClusters: number;
  longSessions: number;
}

const N_GROUPS = 6; // group submissions (two co-submitters share one bundle)
const N_SKIPS = 6; // no-recorder folders (rostered, skipped)

export function planSubmissions(studentCount: number): {
  subs: SeedSubmission[];
  stats: SeedStats;
} {
  const subs: SeedSubmission[] = [];
  let si = 0;
  const next = (): SeedSubmitter => makeStudent(si++);
  let pasteBundles = 0;
  let longSessions = 0;

  // Group submissions — two co-submitters, normal typed work.
  for (let g = 0; g < N_GROUPS && si + 2 <= studentCount; g++) {
    const assignment = SEED_ASSIGNMENTS[g % SEED_ASSIGNMENTS.length]!;
    const submitters = [next(), next()];
    subs.push({
      folder: `submission_group_${g}`,
      assignmentId: assignment,
      submitters,
      plan: { kind: 'clean' },
      longSession: false,
    });
  }

  // No-recorder folders — rostered but skipped.
  for (let k = 0; k < N_SKIPS && si < studentCount; k++) {
    subs.push({
      folder: `submission_skip_${k}`,
      assignmentId: null,
      submitters: [next()],
      plan: { kind: 'clean' },
      longSession: false,
    });
  }

  // Solo submissions for the remaining students. A SMALL fixed fraction work
  // long (>100-entry) sessions so a handful of bundles carry signed checkpoints;
  // kept rare because any >100-event stream saturates the event-kind 3-gram space
  // and clones with the other long sessions under editing_pattern_clone.
  let soloOrdinal = 0;
  while (si < studentCount) {
    const idx = si;
    const student = next();
    const assignment = SEED_ASSIGNMENTS[idx % SEED_ASSIGNMENTS.length]!;
    const plan = pastePlanFor(idx, assignment);
    const longSession = soloOrdinal % 80 === 40; // ~8 long sessions at the default 700
    soloOrdinal++;
    if (plan.kind !== 'clean') pasteBundles++;
    if (longSession) longSessions++;
    subs.push({
      folder: `submission_s${idx}`,
      assignmentId: assignment,
      submitters: [student],
      plan,
      longSession,
    });
  }

  const bundles = subs.filter((s) => s.assignmentId !== null);
  const stats: SeedStats = {
    roster: subs.reduce((n, s) => n + s.submitters.length, 0),
    bundles: bundles.length,
    submissionsQueued: bundles.reduce((n, s) => n + s.submitters.length, 0),
    skipped: subs.length - bundles.length,
    assignments: SEED_ASSIGNMENTS,
    pasteBundles,
    sharedClusters: SHARED_SNIPPETS.length,
    longSessions,
  };
  return { subs, stats };
}

// ---------------------------------------------------------------------------
// ZIP assembly
// ---------------------------------------------------------------------------

const EXPORT_ROOT = 'assignment_seed_export/';

/** Render the Ruby-symbol `submission_metadata.yml` Gradescope emits. */
function renderMetadata(subs: SeedSubmission[]): string {
  let out = '';
  for (const sub of subs) {
    out += `${sub.folder}:\n  :submitters:\n`;
    for (const s of sub.submitters) {
      out += `  - :name: ${s.name}\n    :sid: '${s.sid}'\n    :email: ${s.email}\n`;
    }
  }
  return out;
}

/**
 * Build the full Gradescope export ZIP for a cohort of `studentCount` students.
 * Returns the ZIP bytes plus a summary of what's in it.
 */
export async function buildSeedExport(
  studentCount: number = SEED_STUDENT_COUNT,
): Promise<{ bytes: Uint8Array; stats: SeedStats }> {
  const { subs, stats } = planSubmissions(studentCount);

  // One course signing key for the whole cohort, with a distinct signed manifest
  // per assignment — the per-assignment sig is the session.start manifest_sig AND
  // the IKM the session privkey is encrypted under (recorder PRD §4.6).
  const courseKeypair = await generateSessionKeypair();
  const courseSigByAssignment = new Map<string, string>();
  for (const assignment of SEED_ASSIGNMENTS) {
    const sig = await signManifest(
      {
        assignment_id: assignment,
        semester: SEED_BUNDLE_SEMESTER,
        issued_at: '2026-01-01T00:00:00.000Z',
        files_under_review: [submittedPathFor(assignment)],
      },
      courseKeypair.privateKey,
    );
    courseSigByAssignment.set(assignment, sig);
  }

  const outer = new JSZip();
  outer.file(`${EXPORT_ROOT}submission_metadata.yml`, renderMetadata(subs));
  // A stray macOS file, to prove the loader ignores archive noise.
  outer.file(`${EXPORT_ROOT}.DS_Store`, new Uint8Array([0]));

  for (const sub of subs) {
    const prefix = `${EXPORT_ROOT}${sub.folder}/`;
    if (sub.assignmentId === null) {
      outer.file(`${prefix}answers.txt`, new TextEncoder().encode('submitted without recorder\n'));
      continue;
    }
    const courseSig = courseSigByAssignment.get(sub.assignmentId)!;
    const files = await buildBundleFiles(
      sub.assignmentId,
      sub.submitters[0]!,
      sub.plan,
      sub.longSession,
      courseSig,
    );
    // FLAT into the submission folder — exactly how Gradescope extracts a sealed bundle.
    for (const [name, contents] of Object.entries(files)) {
      outer.file(`${prefix}${name}`, contents);
    }
  }

  const buf = await outer.generateAsync({ type: 'arraybuffer' });
  return { bytes: new Uint8Array(buf), stats };
}
