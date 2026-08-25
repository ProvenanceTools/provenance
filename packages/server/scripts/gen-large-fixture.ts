/**
 * Generate a large Gradescope-export test fixture: N students, each with ONE
 * faithful signed ~E-event `.provenance` bundle. Defaults: 700 students × 50,000
 * events (the "700 large bundles" throughput scenario).
 *
 * DEV TOOLING — not shipped server code. Produces the SAME flat-folder Gradescope
 * export shape the seed and `profile-large-bundle.ts` use (each submission is a
 * flat folder of the sealed bundle's files; `submission_metadata.yml` carries the
 * sid→folder mapping), and uses the SAME `@provenance/log-core` crypto core
 * (real ed25519 session key, hash-chained slog, signed checkpoints every 100
 * entries, signed manifest, exact final doc.save reconstruction) so every bundle
 * passes validation. The extension hash matches the analyzer allowlist.
 *
 * Typing model: a realistic "fill in the method bodies" workload — one
 * doc.change per keystroke (single character; ~3.5% Enter) at a localized
 * interior cursor that advances and occasionally jumps, instead of one full line
 * appended at EOF. The newline rate, character mix and auto-indent are derived
 * from a real CS 61A homework/lab/project corpus, and mirror bench-stages.ts's
 * `methodfill` mode. The document is held as a line-cell array with a native
 * {line,character} cursor so each keystroke stays O(line) — preserving
 * O(text)-per-event generation cost at fixture scale.
 *
 *   npm run gen:fixture --workspace=packages/server
 *   npm run gen:fixture --workspace=packages/server -- --students 700 --events 50000 --out /tmp/fix.zip
 *
 * Memory-safe by construction: each ~E-event bundle (~17 MB at 50k) is built,
 * written to a staging directory on disk, and released before the next — so peak
 * heap is one bundle, not all N. The staging tree is then packaged with the
 * streaming system `zip` (no in-memory JSZip of the whole ~11 GB), and removed.
 *
 * Student sids are 200001..200000+N (matching the seed scheme). To INGEST the
 * fixture the target semester's roster must contain those sids and an `hw10`
 * assignment, else submissions land in the unmatched tray. The single batch can
 * exceed INGEST_MAX_BATCH_BYTES (default 5 GB) — raise it for the import.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ASSIGNMENT = 'hw10';
const SEMESTER_STR = 'fa2026';
// Matches the analyzer's known-good-extension-hashes allowlist (same as the seed).
const EXTENSION_HASH = 'eb452af1aca3234fcdd23708e491d18b37ae26e2c46df893f787cf2fd9a13932';
const RECORDER_VERSION = '0.2.0';
const VSCODE_VERSION = '1.94.2';
const CHECKPOINT_INTERVAL = 100;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const EXPORT_ROOT = 'large_export';
const FIRST_NAMES = ['Avery', 'Blake', 'Casey', 'Drew', 'Emerson', 'Finley', 'Gray', 'Harper'];
const LAST_NAMES = ['Nguyen', 'Patel', 'Kim', 'Garcia', 'Olsen', 'Ibrahim', 'Romano', 'Chen'];

function log(msg: string): void {
  process.stdout.write(`[fixture] ${msg}\n`);
}

function parseArgs(argv: string[]): {
  students: number;
  events: number;
  out: string;
  seed: number;
} {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (k?.startsWith('--')) a[k.slice(2)] = argv[i + 1] ?? '';
  }
  const students = Number(a['students'] ?? '700');
  const events = Number(a['events'] ?? '50000');
  const seed = Number(a['seed'] ?? '1');
  const out = a['out'] ?? path.join(__dirname, 'fixtures', `large-${students}x${events}.zip`);
  if (!Number.isInteger(students) || students < 1)
    throw new Error(`bad --students: ${a['students']}`);
  if (!Number.isInteger(events) || events < 100) throw new Error(`bad --events: ${a['events']}`);
  return { students, events, out, seed };
}

/** Shape 32 hex chars into a v4-looking uuid. Deterministic, like everything here. */
function uuidFromHex(hex32: string): string {
  return (
    `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-4${hex32.slice(13, 16)}-` +
    `8${hex32.slice(17, 20)}-${hex32.slice(20, 32)}`
  );
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pos = { line: number; character: number };

/** A zero-width range at position `p`. */
function rangeAt(p: Pos): Range {
  const at = { line: p.line, character: p.character };
  return { start: at, end: { ...at } };
}

// --- methodfill keystroke model (corpus-derived; mirrors bench-stages.ts) -----
// Realistic "fill in the method bodies" typing: one doc.change per keystroke
// (single character; ~3.5% Enter) at a localized interior cursor that advances
// and occasionally jumps, instead of one full line appended at EOF. The newline
// rate, character mix and auto-indent are derived from a real CS 61A
// homework/lab/project corpus (~2k student-written code lines, ~28 content chars
// per line). Backed by a line-cell array + a native {line,character} cursor so
// each keystroke stays O(line), preserving the generator's O(text)-per-event
// cost at fixture scale (no whole-file splice, no offset→position rescan).

// Enter probability per keystroke: ~1/(28+1) for ~28 content chars per line.
const FILL_NEWLINE_PROB = 0.035;

// Frequency-weighted content alphabet from the corpus (space ~10%, then
// English-ish letters plus the punctuation Python leans on). Sampled uniformly,
// so repeats encode weight.
const FILL_ALPHABET =
  '          ' + // space ×10
  'eeeeeeeeee' + // e ×10
  'tttttt' +
  'rrrrrr' +
  'ssssss' + // t/r/s ×6
  'nnnnn' +
  'aaaaa' +
  'iiiii' + // n/a/i ×5
  'llll' + // l ×4
  'ooo' +
  'fff' +
  '___' + // o/f/_ ×3
  'dd' +
  'cc' +
  '((' +
  '))' +
  'uu' +
  'pp' +
  'mm' +
  '::' +
  '==' + // ×2
  ',.hb[]01gywx*+'; // ×1

/**
 * Auto-indent target (in spaces) after Enter. CS 61A indentation clusters at
 * multiples of 4 (0:15% 4:38% 8:31% 12:13% 16:3%, mean ~6): a short random walk
 * in 4-space steps around the current level, biased to stay put.
 */
function nextIndent(cur: number, rng: () => number): number {
  const r = rng();
  let next: number;
  if (r < 0.45)
    next = cur; // continue at the same depth
  else if (r < 0.72)
    next = cur + 4; // open a block (line ended in `:`)
  else if (r < 0.95)
    next = cur - 4; // close a block
  else next = 0; // back to top level
  return Math.min(16, Math.max(0, next));
}

/** Leading-space count of `s`. */
function leadingSpaces(s: string): number {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  return i;
}

type EventSpec = { kind: string; data: Record<string, unknown> };

const MIX: ReadonlyArray<{ kind: string; w: number }> = [
  { kind: 'doc.change', w: 40 },
  { kind: 'selection.change', w: 38 },
  { kind: 'session.heartbeat', w: 8 },
  { kind: 'focus.change', w: 7 },
  { kind: 'git.event', w: 3 },
  { kind: 'terminal.open', w: 2 },
  { kind: 'doc.close', w: 2 },
];
const MIX_W = MIX.reduce((n, k) => n + k.w, 0);

interface Student {
  name: string;
  sid: string;
  email: string;
}

/**
 * Build one faithful sealed-bundle file set for a student (mirrors
 * profile-large-bundle.ts's crypto core), parameterized by event count, seed,
 * and student identity. Returns the flat files that go in the submission folder.
 */
async function buildBundleFiles(
  eventCount: number,
  courseSig: string,
  student: Student,
  seed: number,
): Promise<Record<string, string>> {
  const rng = mulberry32(seed);
  const keypair = await generateSessionKeypair();
  // Deterministic-but-unique session id per student.
  const sessionId = uuidFromHex(sha256Hex(`large-session:${student.sid}:${seed}`).slice(0, 32));
  // The uuid in the `.slog` FILENAME — a DIFFERENT value from the logical
  // `session_id` above, exactly as production mints them (the writer names the
  // file `session-${randomUUID()}.slog` in `session-registry.ts`, while the
  // logical id is `recorderContext.session_id`).
  //
  // Spelling both with one value is not a simplification: it deletes a whole bug
  // class from whatever this fixture is used to verify. A bundle in which the two
  // ids were CONFUSED would be byte-identical to one handling them correctly, so
  // nothing measured against it can reproduce an id-space crossing. That property
  // is precisely what hid a maximum-severity false accusation
  // (`log_bytes_match` firing on every honest git submission) from 972 tests.
  // `analysis-core`'s `fakeLogFileUuid` encodes the same rule for unit fixtures.
  const logFileUuid = uuidFromHex(sha256Hex(`large-logfile:${student.sid}:${seed}`).slice(0, 32));
  const machineId = sha256Hex(`large-machine:${student.sid}`);
  const path0 = `${ASSIGNMENT}.py`;

  const initialContent = `# ${ASSIGNMENT} — CS 61A\nfrom operator import add, mul\n\n\ndef solve(data):\n    pass\n`;
  // Document as a line-cell array (trailing '' = the empty final line); the live
  // file is `cells.join('\n')`, reconstructed once at doc.save. The cursor and
  // its current indent advance with each keystroke and jump ~4% of the time.
  const cells = initialContent.split('\n');
  const cursor: Pos = { line: -1, character: 0 };
  let curIndent = 0;
  let typed = 0;

  const startData = {
    format_version: '1.0',
    session_id: sessionId,
    prev_session_id: null,
    assignment: { id: ASSIGNMENT, semester: SEMESTER_STR },
    manifest_sig: courseSig,
    machine_id: machineId,
    vscode: { version: VSCODE_VERSION, commit: '', platform: 'darwin' },
    recorder: { version: RECORDER_VERSION, extension_id: 'provenance.recorder' },
    session_pubkey: keypair.publicKeyHex,
  };

  const baseMs = Date.parse('2026-06-10T15:00:00.000Z');
  const avgGap = Math.max(1, Math.floor(FOUR_HOURS_MS / eventCount));
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

  const cosmetic = (kind: string): EventSpec => {
    switch (kind) {
      case 'selection.change': {
        // The caret tracks the typing cursor (each keystroke moves it); clamp to
        // the document start before the first edit.
        const at = cursor.line < 0 ? { line: 0, character: 0 } : cursor;
        return { kind, data: { path: path0, range: rangeAt(at), was_selection: rng() < 0.4 } };
      }
      case 'session.heartbeat':
        return { kind, data: { focused: true, active_file: path0, idle_since_ms: 0 } };
      case 'focus.change':
        return { kind, data: { gained: rng() < 0.5 } };
      case 'git.event':
        return { kind, data: { operation: rng() < 0.5 ? 'status' : 'diff' } };
      case 'doc.close':
        return { kind, data: { path: path0 } };
      default:
        return {
          kind: 'terminal.open',
          data: { terminal_id: 't1', shell: 'bash', shell_integration: true },
        };
    }
  };

  await append(0, 'session.start', startData);

  let seq = 1;
  t += avgGap;
  const openT = t;
  await append(seq++, 'doc.open', {
    path: path0,
    sha256: sha256Hex(initialContent),
    line_count: cells.length,
    content: initialContent,
    truncated: false,
  });

  // Place the cursor for the next edit: the first edit (and ~4% of edits) jumps
  // to a fresh interior region and adopts that line's indentation.
  const placeCursor = (): void => {
    if (cursor.line < 0 || rng() < 0.04) {
      cursor.line = Math.max(
        0,
        Math.min(cells.length - 1, Math.floor((0.2 + rng() * 0.6) * cells.length)),
      );
      cursor.character = cells[cursor.line]!.length;
      curIndent = leadingSpaces(cells[cursor.line]!);
    }
  };

  const pasteAt1 = Math.floor(eventCount * 0.3);
  const pasteAt2 = Math.floor(eventCount * 0.7);
  for (let i = 0; i < eventCount; i++) {
    t += 1 + Math.floor(rng() * avgGap * 2);

    if (i === pasteAt1 || i === pasteAt2) {
      const blob =
        `# pasted helper block ${i}\n` +
        Array.from(
          { length: 20 },
          (_, j) => `    val_${i}_${j} = lookup(${j}) + offset(${i})`,
        ).join('\n') +
        '\n';
      placeCursor();
      const range = rangeAt(cursor);
      // Splice the multi-line blob into the cell array at the cursor. `parts` ends
      // in '' because `blob` ends in '\n'; the merged tail becomes that trailing
      // cell + the old line's suffix, so the cursor lands at the start of the
      // continuation line.
      const parts = blob.split('\n');
      const lineStr = cells[cursor.line]!;
      const left = lineStr.slice(0, cursor.character);
      const right = lineStr.slice(cursor.character);
      const newLines = [left + parts[0]!, ...parts.slice(1, -1), parts[parts.length - 1]! + right];
      cells.splice(cursor.line, 1, ...newLines);
      cursor.line += parts.length - 1;
      cursor.character = parts[parts.length - 1]!.length;
      curIndent = leadingSpaces(cells[cursor.line]!);
      await append(seq++, 'paste', {
        path: path0,
        range,
        length: blob.length,
        sha256: sha256Hex(blob),
        content: blob,
      });
      continue;
    }

    let r = rng() * MIX_W;
    let kind = MIX[MIX.length - 1]!.kind;
    for (const k of MIX) {
      if (r < k.w) {
        kind = k.kind;
        break;
      }
      r -= k.w;
    }
    if (kind === 'doc.change') {
      placeCursor();
      const range = rangeAt(cursor);
      let text: string;
      const lineStr = cells[cursor.line]!;
      if (rng() < FILL_NEWLINE_PROB) {
        // Enter: split the line and auto-indent the remainder onto a new cell.
        curIndent = nextIndent(curIndent, rng);
        const indent = ' '.repeat(curIndent);
        cells[cursor.line] = lineStr.slice(0, cursor.character);
        cells.splice(cursor.line + 1, 0, indent + lineStr.slice(cursor.character));
        cursor.line += 1;
        cursor.character = curIndent;
        text = '\n' + indent;
      } else {
        // A single content keystroke inserted in place.
        const c = FILL_ALPHABET[Math.floor(rng() * FILL_ALPHABET.length)]!;
        cells[cursor.line] =
          lineStr.slice(0, cursor.character) + c + lineStr.slice(cursor.character);
        cursor.character += 1;
        text = c;
      }
      typed++;
      await append(seq++, 'doc.change', {
        path: path0,
        deltas: [{ range, text }],
        source: 'typed',
      });
    } else {
      const ev = cosmetic(kind);
      await append(seq++, ev.kind, ev.data);
    }
  }

  // Reconstruct the final file once from the cell array (O(content), not per-edit).
  const content = cells.join('\n');

  t = Math.max(t, openT + 35_000);
  await append(seq++, 'doc.save', { path: path0, sha256: sha256Hex(content) });

  const slogText = lines.join('\n') + '\n';
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
    assignment_id: ASSIGNMENT,
    semester: SEMESTER_STR,
    extension_hash: EXTENSION_HASH,
    sessions: [
      {
        session_id: sessionId,
        prev_session_id: null,
        slog_sha256: sha256Hex(slogText),
        meta_sha256: sha256Hex(metaJson),
      },
    ],
    submission_files: [{ path: path0, status: 'present', sha256: sha256Hex(content) }],
  };
  const signed = await signBundleManifest(manifest, keypair.privateKey);

  return {
    'manifest.json': signed.canonicalJson,
    'manifest.sig': signed.signatureHex,
    // Filenames take the FILE uuid; the manifest above takes the LOGICAL id.
    [`session-${logFileUuid}.slog`]: slogText,
    [`session-${logFileUuid}.slog.meta`]: metaJson,
    [path0]: content,
  };
}

function makeStudent(i: number): Student {
  const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
  const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length]!;
  const sid = String(200001 + i);
  return {
    name: `${first} ${last}`,
    sid,
    email: `${first}.${last}.${sid}@berkeley.edu`.toLowerCase(),
  };
}

function runZip(cwd: string, outAbs: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // -1 = fastest compression (the slog hashes are high-entropy and barely
    // compress anyway); -r recurse, -q quiet, -X strip extra metadata.
    const zip = spawn('zip', ['-r', '-1', '-q', '-X', outAbs, EXPORT_ROOT], {
      cwd,
      stdio: 'inherit',
    });
    zip.on('error', reject);
    zip.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`zip exited ${code}`))));
  });
}

async function main(): Promise<void> {
  const { students, events, out, seed } = parseArgs(process.argv.slice(2));
  const outAbs = path.resolve(out);
  const staging = path.join(path.dirname(outAbs), `.fixture-staging-${process.pid}`);
  const rootDir = path.join(staging, EXPORT_ROOT);

  log(`generating ${students} students × ${events.toLocaleString()} events → ${outAbs}`);
  const tStart = Date.now();

  await rm(staging, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });
  await mkdir(path.dirname(outAbs), { recursive: true });
  await rm(outAbs, { force: true });

  // One course keypair + signed course manifest shared by every student (the
  // course-level manifest_sig the recorder embeds), each student a fresh session key.
  const courseKeypair = await generateSessionKeypair();
  const courseSig = await signManifest(
    {
      assignment_id: ASSIGNMENT,
      semester: SEMESTER_STR,
      issued_at: '2026-01-01T00:00:00.000Z',
      files_under_review: [`${ASSIGNMENT}.py`],
    },
    courseKeypair.privateKey,
  );

  const subs: Student[] = [];
  let metaYml = '';
  for (let i = 0; i < students; i++) {
    const student = makeStudent(i);
    subs.push(student);
    const folder = `submission_${student.sid}`;
    const files = await buildBundleFiles(events, courseSig, student, seed + i);

    const dir = path.join(rootDir, folder);
    await mkdir(dir, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(dir, name), contents);
    }
    metaYml += `${folder}:\n  :submitters:\n  - :name: ${student.name}\n    :sid: '${student.sid}'\n    :email: ${student.email}\n`;

    if ((i + 1) % 25 === 0 || i + 1 === students) {
      const elapsed = (Date.now() - tStart) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = (students - (i + 1)) / rate;
      log(`  ${i + 1}/${students} bundles (${rate.toFixed(1)}/s, ETA ${eta.toFixed(0)}s)`);
    }
  }

  await writeFile(path.join(rootDir, 'submission_metadata.yml'), metaYml);

  log(`packaging ${subs.length} submissions with system zip…`);
  await runZip(staging, outAbs);
  await rm(staging, { recursive: true, force: true });

  const { stat } = await import('node:fs/promises');
  const sz = (await stat(outAbs)).size;
  log('');
  log(`DONE in ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
  log(`fixture: ${outAbs}`);
  log(
    `size: ${(sz / 1024 / 1024).toFixed(0)} MB  (${students} students × ${events.toLocaleString()} events)`,
  );
  log(`sids: 200001..${200000 + students}, assignment '${ASSIGNMENT}', semester '${SEMESTER_STR}'`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[fixture] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
