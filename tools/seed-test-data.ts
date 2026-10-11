/**
 * DB-direct test data seeder (dev only).
 *
 * Populates the existing `cs61a / fa26` semester with:
 *   - 80 roster_entries
 *   - 5 assignments
 *   - 1 ingest_jobs row (status='succeeded')
 *   - ~85% of (student × assignment) cross product as submissions
 *   - A handful of events per submission (timeline isn't empty)
 *   - per_file_stats per submission
 *   - Flags sprinkled across ~30% of submissions, mix of real heuristic IDs
 *   - A few cross_flags with 2-3 participants each
 *
 * Does NOT stage any blobs in RustFS — replay view will be broken.
 * Does NOT write validation_results — validation report panel will be empty.
 *
 * Usage:
 *   npx tsx --env-file=packages/server/.env tools/seed-test-data.ts
 *
 * Idempotent: wipes prior seeded data scoped to (semester_id, ingest_job 'seed')
 * before inserting.
 */

import postgres from 'postgres';
import { createDb } from '../packages/server/src/db/client.js';
import { recomputeSubmission } from '../packages/server/src/services/scoring/recompute-submission.js';
import { DEFAULT_SERVER_CONFIG } from '../packages/server/src/services/heuristics/config.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SEMESTER_COURSE_SLUG = 'cs61a';
const SEMESTER_SLUG = 'fa26';
const UPLOADER_EMAIL = 'aaryanm@berkeley.edu';

const N_CLEAN_STUDENTS = 200; // pure normal-flavor, no flags ever
const N_MIXED_STUDENTS = 80; // existing mixed distribution (paste-heavy/idle/normal)
const N_STUDENTS = N_CLEAN_STUDENTS + N_MIXED_STUDENTS;
const SUBMISSION_RATE = 0.85; // 85% chance a given student submits a given assignment

const ASSIGNMENTS = [
  { id_str: 'hw01', label: 'HW 1: Intro to Python', sort: 1 },
  { id_str: 'lab01', label: 'Lab 1: Control Flow', sort: 2 },
  { id_str: 'hw02', label: 'HW 2: Higher-Order Functions', sort: 3 },
  { id_str: 'proj01', label: 'Project 1: Hog', sort: 4 },
  { id_str: 'hw03', label: 'HW 3: Recursion', sort: 5 },
];

const FIRST_NAMES = [
  'Aarav',
  'Aisha',
  'Alex',
  'Amelia',
  'Anna',
  'Arjun',
  'Ava',
  'Ben',
  'Cameron',
  'Carlos',
  'Chloe',
  'Daniel',
  'Diana',
  'Diego',
  'Dmitri',
  'Elena',
  'Ethan',
  'Eva',
  'Fatima',
  'Felix',
  'Gabriela',
  'Grace',
  'Hannah',
  'Henry',
  'Hiro',
  'Ibrahim',
  'Isabel',
  'Jacob',
  'Jasmine',
  'Jin',
  'Julia',
  'Kai',
  'Kavya',
  'Keith',
  'Kenji',
  'Lara',
  'Leo',
  'Lin',
  'Lucas',
  'Maya',
  'Mei',
  'Mira',
  'Nadia',
  'Nathan',
  'Noah',
  'Olivia',
  'Omar',
  'Priya',
  'Rafael',
  'Ravi',
  'Ria',
  'Ryan',
  'Sam',
  'Sara',
  'Sienna',
  'Sofia',
  'Sora',
  'Tariq',
  'Theo',
  'Uma',
  'Victor',
  'Wei',
  'Xochitl',
  'Yara',
  'Yusuf',
  'Zara',
  'Zoe',
];

const LAST_NAMES = [
  'Anderson',
  'Brown',
  'Chen',
  'Davis',
  'Espinoza',
  'Fernandez',
  'Garcia',
  'Hernandez',
  'Ito',
  'Johnson',
  'Kim',
  'Lopez',
  'Martinez',
  'Nakamura',
  'Okafor',
  'Patel',
  'Quintero',
  'Rodriguez',
  'Singh',
  'Tanaka',
  'Uchida',
  'Vargas',
  'Wang',
  'Xu',
  'Yamamoto',
  'Zhang',
];

// Real heuristic IDs from packages/analyzer/src/heuristics/*.ts
const HEURISTICS: Array<{
  id: string;
  severities: Array<'info' | 'low' | 'medium' | 'high'>;
  detailFactory: () => Record<string, unknown>;
}> = [
  {
    id: 'large_paste',
    severities: ['low', 'medium', 'high'],
    detailFactory: () => ({
      char_count: 200 + Math.floor(Math.random() * 800),
      file_path: 'hw.py',
    }),
  },
  {
    id: 'paste_is_solution',
    severities: ['medium', 'high'],
    detailFactory: () => ({
      file_path: 'hw.py',
      paste_chars: 400 + Math.floor(Math.random() * 600),
      final_overlap_ratio: 0.85 + Math.random() * 0.14,
    }),
  },
  {
    id: 'idle_then_complete',
    severities: ['low', 'medium'],
    detailFactory: () => ({
      idle_ms: 1000 * 60 * (10 + Math.floor(Math.random() * 30)),
      chars_typed_after: 50 + Math.floor(Math.random() * 200),
    }),
  },
  {
    id: 'gap_in_heartbeats',
    severities: ['info', 'low'],
    detailFactory: () => ({
      gap_ms: 1000 * (60 + Math.floor(Math.random() * 600)),
    }),
  },
  {
    id: 'ai_extension_active',
    severities: ['low', 'medium'],
    detailFactory: () => ({
      extension_ids: ['github.copilot'],
      seen_at_seq: 5,
    }),
  },
  {
    id: 'low_typing_high_output',
    severities: ['medium', 'high'],
    detailFactory: () => ({
      file_path: 'hw.py',
      chars_typed: 12 + Math.floor(Math.random() * 30),
      final_length: 500 + Math.floor(Math.random() * 800),
    }),
  },
  {
    id: 'time_to_first_save_anomaly',
    severities: ['info', 'low'],
    detailFactory: () => ({
      ms_to_first_save: 1000 * 60 * (60 + Math.floor(Math.random() * 120)),
    }),
  },
  {
    id: 'no_intermediate_errors',
    severities: ['info'],
    detailFactory: () => ({
      saves_observed: 1 + Math.floor(Math.random() * 3),
    }),
  },
];

// Cross-heuristic IDs
const CROSS_HEURISTICS = [
  { id: 'shared_paste_content', severity: 'high' as const },
  { id: 'editing_pattern_clone', severity: 'medium' as const },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function uuid(): string {
  return crypto.randomUUID();
}

function fakeHex(len: number): string {
  let s = '';
  const chars = '0123456789abcdef';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

function makeSid(i: number): string {
  return String(30000001 + i);
}

function makeName(i: number): string {
  const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
  const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length]!;
  return `${first} ${last}`;
}

function severityFromFlags(severities: string[]): string {
  const order = ['info', 'low', 'medium', 'high'];
  let max = 'info';
  for (const s of severities) if (order.indexOf(s) > order.indexOf(max)) max = s;
  return max;
}

// ---------------------------------------------------------------------------
// Event generation
// ---------------------------------------------------------------------------

type EventRow = {
  submission_id: string;
  seq: number;
  session_id: string;
  t: number;
  wall: Date;
  kind: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

/**
 * Submission "flavors" — each one is engineered so the real heuristic suite
 * fires a specific, isolatable set of flags. This lets the tuning UI show
 * meaningful tier changes when individual heuristics are disabled (e.g.,
 * disabling `large_paste` should drop the LARGE_PASTE_ONLY cohort from
 * high → info, while leaving PASTE_IS_SOLUTION-only subs at high).
 *
 *   normal               — clean; no flags
 *   large_paste_only     — paste not mirrored into file → large_paste only (high)
 *   paste_is_solution    — small paste matches final → paste_is_solution (high)
 *   ttfs_anomaly         — 600 typed chars in <30s after open → time_to_first_save_anomaly (high)
 *   idle_then_complete   — small initial save, 12+ min idle, post-idle ramp → idle + gap (medium/low)
 *   gap_only             — 6 min heartbeat gap, no size ramp → gap_in_heartbeats (info)
 *   ai_extension         — github.copilot in ext.snapshot, otherwise clean → ai_extension_active (low)
 *   combo                — the original "obvious cheater": fires 4 high heuristics at once
 */
type Flavor =
  | 'normal'
  | 'large_paste_only'
  | 'paste_is_solution'
  | 'ttfs_anomaly'
  | 'idle_then_complete'
  | 'gap_only'
  | 'ai_extension'
  | 'combo';

function generateEvents(submissionId: string, startWall: Date, flavor: Flavor): EventRow[] {
  const events: EventRow[] = [];
  const sessionId = uuid();
  let seq = 0;
  let t = 0;
  let prevHash = '0'.repeat(64);

  const push = (kind: string, payload: Record<string, unknown>, dtMs: number): void => {
    t += dtMs;
    const wall = new Date(startWall.getTime() + t);
    const hash = fakeHex(64);
    events.push({
      submission_id: submissionId,
      seq,
      session_id: sessionId,
      t,
      wall,
      kind,
      payload,
      prev_hash: prevHash,
      hash,
    });
    prevHash = hash;
    seq++;
  };

  const file = 'hw.py';
  const range = (line: number, ch: number) => ({
    start: { line, character: ch },
    end: { line, character: ch },
  });

  // Helpers
  const typedDelta = (line: number, text: string, dtMs: number) =>
    push(
      'doc.change',
      { path: file, source: 'typed', deltas: [{ range: range(line, 0), text }] },
      dtMs,
    );

  const save = (dtMs: number) => push('doc.save', { path: file, sha256: fakeHex(64) }, dtMs);

  push(
    'session.start',
    {
      session_id: sessionId,
      prev_session_id: null,
      assignment_id: 'hw01',
      semester: 'fa26',
      recorder: { version: '0.0.1', extension_id: 'provenance.recorder' },
      session_pubkey: fakeHex(64),
    },
    0,
  );

  // Only the ai_extension and combo flavors include github.copilot.
  const extensions =
    flavor === 'ai_extension' || flavor === 'combo'
      ? [
          { id: 'ms-python.python', version: '2024.0.0', enabled: true },
          { id: 'github.copilot', version: '1.180.0', enabled: true },
        ]
      : [{ id: 'ms-python.python', version: '2024.0.0', enabled: true }];
  push('ext.snapshot', { extensions }, 100);

  push('doc.open', { path: file, sha256: fakeHex(64), line_count: 0, content: '' }, 200);

  switch (flavor) {
    case 'normal':
    case 'ai_extension': {
      // Steady typing. Same shape for both flavors — the only difference is
      // whether copilot was in ext.snapshot above. ai_extension_active fires
      // on the extension list alone, regardless of edit patterns.
      for (let i = 0; i < 10; i++) {
        typedDelta(i, `# normal line ${i}\n`, 2000 + Math.floor(Math.random() * 5000));
      }
      save(45_000); // save well after the 30s ttfs window
      break;
    }

    case 'large_paste_only': {
      // Goal: fire large_paste alone (NOT paste_is_solution).
      //
      // Reconstruction applies paste events directly to file content, so just
      // "not mirroring" the paste as a doc.change isn't enough — paste_is_solution
      // would still see the pasted lines in the final file. Instead: paste the
      // block, then immediately delete the pasted range and retype completely
      // different content over it. large_paste sees the paste event (fires
      // high — 580 chars); paste_is_solution sees zero shared lines.
      for (let i = 0; i < 12; i++) {
        typedDelta(i, `result_${i} = compute(value_${i})\n`, 2500);
      }
      const pasteLines = Array.from(
        { length: 22 },
        (_, i) => `    abandoned_${i} = transform(token_${i})`,
      );
      const pasteContent = pasteLines.join('\n') + '\n';
      push(
        'paste',
        {
          path: file,
          range: range(12, 0),
          length: pasteContent.length,
          sha256: fakeHex(64),
          content: pasteContent,
        },
        500,
      );
      // Delete the entire pasted range (lines 12 through 12+22) and replace
      // with different typed content. After this, the final file contains
      // the original 12 typed lines plus the replacement — none of the paste.
      push(
        'doc.change',
        {
          path: file,
          source: 'typed',
          deltas: [
            {
              range: {
                start: { line: 12, character: 0 },
                end: { line: 12 + pasteLines.length, character: 0 },
              },
              text: '',
            },
          ],
        },
        800,
      );
      // Retype different content at the same location.
      for (let i = 0; i < 10; i++) {
        typedDelta(12 + i, `final_${i} = wrap(result_${i})\n`, 1500);
      }
      save(5000);
      break;
    }

    case 'paste_is_solution': {
      // Small paste (under large_paste's 200-char / 10-line thresholds) whose
      // content IS mirrored as paste_confirmed. Lots of typed content around it.
      // Result: paste_is_solution fires (line-overlap match), large_paste does
      // not (too small), low_typing_high_output does not (typed >> delta).
      for (let i = 0; i < 14; i++) {
        typedDelta(i, `helper_${i} = lambda x: x + ${i}\n`, 2500);
      }
      // 6 lines, ~150 chars — under both large_paste thresholds.
      const pasteLines = [
        '    if value == 0:',
        '        return 1',
        '    elif value < 0:',
        '        return -1',
        '    else:',
        '        return value',
      ];
      const pasteContent = pasteLines.join('\n') + '\n';
      push(
        'paste',
        {
          path: file,
          range: range(14, 0),
          length: pasteContent.length,
          sha256: fakeHex(64),
          content: pasteContent,
        },
        400,
      );
      push(
        'doc.change',
        {
          path: file,
          source: 'paste_confirmed',
          deltas: [{ range: range(14, 0), text: pasteContent }],
        },
        50,
      );
      save(45_000);
      break;
    }

    case 'ttfs_anomaly': {
      // doc.open → first doc.save within 30s, with > 500 chars in the file.
      // Lots of typed chars in one go to keep low_typing_high_output silent
      // (delta/typed ratio = 1).
      const bigText =
        Array.from({ length: 35 }, (_, i) => `result_${i} = compute(value_${i})`).join('\n') + '\n';
      typedDelta(0, bigText, 4000);
      save(2000); // total t from doc.open ≈ 6s, well under 30s
      break;
    }

    case 'idle_then_complete': {
      // Small initial save → 12 min idle (above both idleGapMs=10min and
      // gapThresholdMs=5min) → post-idle ramp doubling content within 60s.
      typedDelta(0, '# todo: implement\n', 1000);
      save(500);

      // 12 minute idle gap between two heartbeats.
      push(
        'session.heartbeat',
        { focused: false, active_file: file, idle_since_ms: 30_000 },
        30_000,
      );
      push(
        'session.heartbeat',
        { focused: false, active_file: file, idle_since_ms: 720_000 },
        720_000,
      );

      // Post-idle ramp inside 60s window.
      const rampText =
        Array.from({ length: 30 }, (_, i) => `    step_${i}(value)`).join('\n') + '\n';
      typedDelta(1, rampText, 5000);
      save(3000);
      break;
    }

    case 'gap_only': {
      // 6 minute heartbeat gap (> gapThresholdMs=5min) but no significant
      // post-idle ramp, so idle_then_complete does NOT fire.
      for (let i = 0; i < 6; i++) {
        typedDelta(i, `line_${i} = ${i}\n`, 2000);
      }
      push(
        'session.heartbeat',
        { focused: false, active_file: file, idle_since_ms: 30_000 },
        30_000,
      );
      push(
        'session.heartbeat',
        { focused: false, active_file: file, idle_since_ms: 360_000 },
        360_000,
      );
      for (let i = 6; i < 10; i++) {
        typedDelta(i, `line_${i} = ${i}\n`, 2000);
      }
      save(45_000);
      break;
    }

    case 'combo': {
      // The "obvious cheater": large paste mirrored into final file, < 30s to
      // first save, near-zero typed chars. Fires large_paste + paste_is_solution
      // + low_typing_high_output + time_to_first_save_anomaly + ai_extension_active.
      typedDelta(0, 'def\n', 1500);
      const pasteLines = Array.from(
        { length: 22 },
        (_, i) => `    result = compute_step_${i}(value)`,
      );
      const pasteContent = pasteLines.join('\n') + '\n';
      push(
        'paste',
        {
          path: file,
          range: range(1, 0),
          length: pasteContent.length,
          sha256: fakeHex(64),
          content: pasteContent,
        },
        400,
      );
      push(
        'doc.change',
        {
          path: file,
          source: 'paste_confirmed',
          deltas: [{ range: range(1, 0), text: pasteContent }],
        },
        50,
      );
      save(1500);
      break;
    }
  }

  push('session.end', { reason: 'user_closed' }, 1000);
  return events;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL not set. Did you pass --env-file=packages/server/.env?');
    process.exit(1);
  }

  const sql = postgres(url, { max: 4 });

  try {
    // Look up semester + user.
    const semRows = await sql<Array<{ id: string }>>`
      SELECT s.id
      FROM semesters s
      JOIN courses c ON c.id = s.course_id
      WHERE c.slug = ${SEMESTER_COURSE_SLUG} AND s.slug = ${SEMESTER_SLUG}
      LIMIT 1
    `;
    if (semRows.length === 0) {
      throw new Error(
        `Semester ${SEMESTER_COURSE_SLUG}/${SEMESTER_SLUG} not found. Bootstrap it first.`,
      );
    }
    const semesterId = semRows[0]!.id;

    const userRows = await sql<Array<{ id: string }>>`
      SELECT id FROM users WHERE email = ${UPLOADER_EMAIL} LIMIT 1
    `;
    if (userRows.length === 0) {
      throw new Error(`User ${UPLOADER_EMAIL} not found.`);
    }
    const uploaderId = userRows[0]!.id;

    console.log(`Targeting semester ${semesterId}, uploader ${uploaderId}`);

    // --------------------------------------------------------
    // Wipe previously-seeded data for this semester.
    // Order matters due to FK constraints.
    // --------------------------------------------------------
    console.log('Wiping previously-seeded data...');
    await sql.begin(async (tx) => {
      // Find prior seed ingest jobs.
      const oldJobs = await tx<Array<{ id: string }>>`
        SELECT id FROM ingest_jobs
        WHERE semester_id = ${semesterId} AND summary->>'origin' = 'seed-test-data'
      `;
      for (const j of oldJobs) {
        await tx`DELETE FROM submissions WHERE ingest_job_id = ${j.id}`;
        await tx`DELETE FROM ingest_jobs WHERE id = ${j.id}`;
      }
      // Wipe roster + assignments + cross_flags scoped to this semester.
      await tx`DELETE FROM cross_flags WHERE semester_id = ${semesterId}`;
      await tx`DELETE FROM roster_entries WHERE semester_id = ${semesterId}`;
      await tx`DELETE FROM assignments WHERE semester_id = ${semesterId}`;
      // Recompute jobs reference heuristic_configs — wipe both for a clean slate.
      await tx`DELETE FROM recompute_jobs WHERE semester_id = ${semesterId}`;
      await tx`DELETE FROM heuristic_configs WHERE semester_id = ${semesterId}`;
    });

    // --------------------------------------------------------
    // Heuristic config — active v1 with all 24 known heuristics enabled,
    // default weight 1.0, default severity_weights {info:0, low:1, medium:3, high:8}.
    // Submissions reference this via heuristic_config_version=1.
    // --------------------------------------------------------
    const KNOWN_HEURISTIC_IDS = [
      'large_paste',
      'external_edits',
      'low_typing_high_output',
      'chain_broken',
      'paste_is_solution',
      'mass_external_replacement',
      'time_to_first_save_anomaly',
      'idle_then_complete',
      'no_intermediate_errors',
      'paste_matches_known_source',
      'ai_extension_active',
      'extension_hash_mismatch',
      'extension_set_changed_mid_assignment',
      'clock_jumps',
      'gap_in_heartbeats',
      'manifest_sig_invalid',
      'session_binding_invalid',
      'monotonic_t_regression',
      'monotonic_wall_regression',
      'shell_integration_disabled',
      'terminal_active_during_external_change',
      'multiple_sessions_overlap',
      'editing_pattern_clone',
      'paste_shared_across_students',
    ];
    const heuristicConfig = {
      per_flag: Object.fromEntries(
        KNOWN_HEURISTIC_IDS.map((id) => [id, { enabled: true, weight: 1.0 }]),
      ),
      severity_weights: { info: 0, low: 1, medium: 3, high: 8 },
      config_format_version: 1,
    };
    console.log('Seeding active heuristic config (v1)...');
    await sql`
      INSERT INTO heuristic_configs
        (semester_id, version, config, set_by, note, is_active)
      VALUES
        (${semesterId}, 1, ${sql.json(heuristicConfig)}, ${uploaderId},
         'seed-test-data initial config', true)
    `;

    // --------------------------------------------------------
    // Roster
    // --------------------------------------------------------
    console.log(`Seeding ${N_STUDENTS} roster entries...`);
    const studentIds: string[] = [];
    for (let i = 0; i < N_STUDENTS; i++) {
      const id = uuid();
      const sid = makeSid(i);
      const name = makeName(i);
      const email = `${name.toLowerCase().replace(/[^a-z]/g, '')}@berkeley.edu`;
      await sql`
        INSERT INTO roster_entries (id, semester_id, sid, display_name, email)
        VALUES (${id}, ${semesterId}, ${sid}, ${name}, ${email})
      `;
      studentIds.push(id);
    }

    // --------------------------------------------------------
    // Assignments
    // --------------------------------------------------------
    console.log(`Seeding ${ASSIGNMENTS.length} assignments...`);
    const assignmentIds: string[] = [];
    for (const a of ASSIGNMENTS) {
      const id = uuid();
      await sql`
        INSERT INTO assignments (id, semester_id, assignment_id_str, label, sort_order)
        VALUES (${id}, ${semesterId}, ${a.id_str}, ${a.label}, ${a.sort})
      `;
      assignmentIds.push(id);
    }

    // --------------------------------------------------------
    // Ingest job
    // --------------------------------------------------------
    const ingestJobId = uuid();
    const now = new Date();
    await sql`
      INSERT INTO ingest_jobs
        (id, semester_id, uploaded_by, status, summary, started_at, completed_at)
      VALUES
        (${ingestJobId}, ${semesterId}, ${uploaderId}, 'succeeded',
         ${sql.json({ origin: 'seed-test-data', files: 0 })},
         ${new Date(now.getTime() - 60 * 60 * 1000)}, ${now})
    `;

    // --------------------------------------------------------
    // Submissions + events + per_file_stats + flags
    // --------------------------------------------------------
    console.log('Seeding submissions, events, stats, flags...');
    let nSubs = 0;
    let nFlags = 0;
    const allSubmissionIds: string[] = [];
    const pasteSubsByAssignment: Record<string, string[]> = {};

    for (let s = 0; s < studentIds.length; s++) {
      const studentId = studentIds[s]!;
      for (let a = 0; a < assignmentIds.length; a++) {
        if (Math.random() > SUBMISSION_RATE) continue;

        const assignmentId = assignmentIds[a]!;
        const assignmentStr = ASSIGNMENTS[a]!.id_str;
        const subId = uuid();

        // Cohort split: first N_CLEAN_STUDENTS are pure normal, rest get a
        // mix of single-heuristic-isolating flavors plus the combo "obvious
        // cheater" pattern. Each flavor fires a specific set of flags so
        // disabling individual heuristics in the tuning UI produces visible
        // tier changes.
        const isClean = s < N_CLEAN_STUDENTS;

        let flavor: Flavor;
        if (isClean) {
          flavor = 'normal';
        } else {
          // Roughly even distribution across the suspicious flavors.
          const rng = Math.random();
          if (rng < 0.1)
            flavor = 'normal'; // mixed-cohort student with a clean assignment
          else if (rng < 0.25) flavor = 'large_paste_only';
          else if (rng < 0.4) flavor = 'paste_is_solution';
          else if (rng < 0.55) flavor = 'ttfs_anomaly';
          else if (rng < 0.7) flavor = 'idle_then_complete';
          else if (rng < 0.8) flavor = 'gap_only';
          else if (rng < 0.92) flavor = 'ai_extension';
          else flavor = 'combo';
        }

        // score_total + score_max_severity will be filled in by recomputeSubmission
        // after events are inserted. Insert defaults here.
        const blobObjectKey = `semesters/${semesterId}/submissions/${subId}/bundle.zip`;
        const blobSha = `seed-${subId}`;

        await sql`
          INSERT INTO submissions (
            id, semester_id, assignment_id, student_id, blob_object_key, blob_sha256,
            recorder_version, format_version, source_filename, ingest_job_id,
            version_index, score_total, score_max_severity, validation_status,
            heuristic_config_version, recompute_status, ingested_at, created_at
          ) VALUES (
            ${subId}, ${semesterId}, ${assignmentId}, ${studentId},
            ${blobObjectKey}, ${blobSha},
            '0.0.1', '1.0',
            ${`${assignmentStr}-${makeSid(s)}.zip`},
            ${ingestJobId}, 1,
            0, 'info', 'pass',
            1, 'fresh', ${now}, ${now}
          )
        `;
        nSubs++;
        allSubmissionIds.push(subId);

        // Events
        const startWall = new Date(now.getTime() - (1 + Math.random() * 48) * 3600_000);
        const events = generateEvents(subId, startWall, flavor);
        for (const e of events) {
          await sql`
            INSERT INTO events
              (submission_id, seq, session_id, t, wall, kind, payload, prev_hash, hash)
            VALUES
              (${e.submission_id}, ${e.seq}, ${e.session_id}, ${e.t}, ${e.wall},
               ${e.kind}, ${sql.json(e.payload)}, ${e.prev_hash}, ${e.hash})
          `;
        }

        // per_file_stats — rough approximations per flavor. These rows mostly
        // feed the per-submission stats panel in the UI; the heuristic suite
        // recomputes flags from events, so exact accuracy here is not critical.
        const pasteFlavors: Flavor[] = ['large_paste_only', 'paste_is_solution', 'combo'];
        const chTyped =
          flavor === 'idle_then_complete'
            ? 30
            : flavor === 'combo'
              ? 4
              : flavor === 'ttfs_anomaly'
                ? 600
                : 250 + Math.floor(Math.random() * 200);
        const chPasted = pasteFlavors.includes(flavor)
          ? flavor === 'paste_is_solution'
            ? 150
            : 580
          : 0;
        const finalLen = chTyped + chPasted;
        const saves = flavor === 'idle_then_complete' ? 2 : 1;
        await sql`
          INSERT INTO per_file_stats
            (submission_id, file_path, chars_typed, chars_pasted, chars_external_change_delta,
             saves, final_length, start_length, reconstruction_tainted)
          VALUES
            (${subId}, 'hw.py', ${chTyped}, ${chPasted}, 0,
             ${saves}, ${finalLen}, 0, false)
        `;
      }
    }

    // --------------------------------------------------------
    // Recompute pass — run the real heuristic suite against each submission's
    // events. Writes flag rows + score_total + score_max_severity that are
    // CONSISTENT with what the dry-run preview will compute.
    //
    // We deliberately bypass the API/pg-boss and call the service directly so
    // this remains a one-shot dev script (no worker dependency).
    // --------------------------------------------------------
    console.log(`Recomputing ${allSubmissionIds.length} submissions via real heuristics...`);
    process.env['NODE_ENV'] ??= 'development';
    process.env['AUTH_COOKIE_SIGNING_SECRET'] ??= 'dev-secret-not-used-here';
    const { sql: drizzleSql, db } = createDb(url, 8);
    try {
      // Use the same config we just inserted as the active config.
      const serverConfig = DEFAULT_SERVER_CONFIG;
      let done = 0;
      // Process serially to avoid saturating the pool; each recompute opens a tx.
      for (const subId of allSubmissionIds) {
        try {
          await recomputeSubmission(db, subId, semesterId, serverConfig, 1);
        } catch (e) {
          console.error(`  recompute failed for ${subId}:`, (e as Error).message);
        }
        done++;
        if (done % 100 === 0) console.log(`  ${done}/${allSubmissionIds.length}`);
      }
    } finally {
      await drizzleSql.end();
    }

    // Verify final flag counts.
    const finalFlagCount = await sql<Array<{ count: number }>>`
      SELECT count(*)::int FROM flags
      WHERE semester_id = ${semesterId}
    `;

    console.log(
      `Done. Seeded ${N_STUDENTS} students, ${ASSIGNMENTS.length} assignments, ` +
        `${nSubs} submissions, ${finalFlagCount[0]?.count ?? 0} flags from real heuristics.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
