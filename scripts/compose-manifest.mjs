#!/usr/bin/env node
/**
 * Headless CLI for the full Manifest 2.0 (or 1.0) generation + signing pipeline.
 *
 * The command-line counterpart of the analyzer's `/compose/manifest` page.
 * Accepts every field that page exposes, builds the unsigned payload, signs
 * with the course key, staples the `course_cert` (at 2.0), self-verifies the
 * trust chain, and writes the result.
 *
 * Unlike `tools/sign-manifest.ts`, which signs an already-authored JSON file,
 * this script GENERATES the manifest from flags (or a `--config` JSON) so a
 * publishing CI pipeline never has to hand-write the unsigned shape.
 *
 * ---------------------------------------------------------------------------
 * CI / EXTERNAL PIPELINES — THIS IS NOT A DROP-IN SINGLE FILE
 * ---------------------------------------------------------------------------
 *
 * This script cannot be copied alone into another repo's CI. It imports
 * `@provenance/log-core` from this monorepo's workspace, so a job that wants
 * to run it MUST check out THIS repository (ProvenanceTools/provenance),
 * install, and build first. Typical shape:
 *
 *   # 1. Check out the provenance repo (pin a ref/tag in real CI)
 *   git clone https://github.com/ProvenanceTools/provenance.git
 *   cd provenance
 *   git checkout <tag-or-sha>          # pin for reproducibility
 *
 *   # 2. Install + build so @provenance/log-core resolves
 *   npm ci
 *   npm run build --workspace=packages/log-core
 *   # (or: npm run build)
 *
 *   # 3. Provide course key material via secrets / secure files, then compose
 *   export PROVENANCE_COURSE_KEYPAIR_PATH=/secure/course-keypair.json
 *   export PROVENANCE_COURSE_CERT_PATH=/secure/course-cert.json
 *   export PROVENANCE_ROOT_PUBLIC_KEY_HEX=<64-hex root public key>
 *
 *   node scripts/compose-manifest.mjs \
 *     --out /path/to/assignment-starter/.provenance-manifest \
 *     --config /path/to/assignment.json \
 *     # …or pass every field as flags (see below)
 *
 * Keys stay outside the checkout (CI secrets / mounted secure volume). The
 * script only reads them at sign time; it never embeds the root or course
 * private key into the manifest.
 *
 * ---------------------------------------------------------------------------
 * FIELD COVERAGE (same set as /compose/manifest)
 * ---------------------------------------------------------------------------
 *
 * There is no separate "exclude" field — the manifest name is `ignore`
 * (paths the recorder will not capture at all). Everything else the browser
 * composer exposes is here:
 *
 *   format                 --format 1.0|2.0              (default: 2.0)
 *   assignment_id          --assignment-id               required
 *   semester               --semester                    required
 *   issued_at              --issued-at                   default: now, UTC, whole seconds
 *   files_under_review     --files-under-review          required (comma/newline list)
 *   course_id              --course-id                   required at 2.0
 *   collaboration          --collaboration solo|group    (default: solo)
 *   submission             --submission bundle|git       (default: bundle)
 *   scope                  --scope directory|repo        (default: directory)
 *   ignore                 --ignore                      "exclude" list; default empty
 *   attachments            --attachments                 default empty
 *   policy.selection_change  --no-selection-change / --capture-selection-change
 *   policy.focus_change      --no-focus-change / --capture-focus-change
 *   policy.terminal          --no-terminal / --capture-terminal
 *   policy.heartbeat_interval_ms  --heartbeat-interval-ms  (default: 30000)
 *
 * Plus signing inputs (not signed fields): --course-keypair, --course-cert,
 * --root-pubkey (or the PROVENANCE_* env vars above).
 *
 * USAGE (2.0 — default)
 *   node scripts/compose-manifest.mjs \
 *     --out /path/to/assignment-starter/.provenance-manifest \
 *     --assignment-id hw03 \
 *     --semester fa26 \
 *     --files-under-review hw03.py,helpers.py \
 *     --course-id berkeley-cs61a \
 *     [--issued-at 2026-09-15T00:00:00Z]          (default: now, UTC, whole seconds)
 *     [--collaboration solo|group]                (default: solo)
 *     [--submission bundle|git]                   (default: bundle)
 *     [--scope directory|repo]                    (default: directory)
 *     [--ignore '*.class,target/']                (default: empty; this is the exclude list)
 *     [--attachments 'logs/,*.log']               (default: empty)
 *     [--no-selection-change] [--no-focus-change] [--no-terminal]
 *     [--heartbeat-interval-ms 30000]             (default: 30000)
 *     [--course-keypair <path>]   (default: PROVENANCE_COURSE_KEYPAIR_PATH, else .notes/dev-keypair.json)
 *     [--course-cert <path>]      (default: PROVENANCE_COURSE_CERT_PATH, else .notes/dev-course-cert.json)
 *     [--root-pubkey <64-hex>]    (default: PROVENANCE_ROOT_PUBLIC_KEY_HEX, else .notes/dev-root-keypair.json)
 *
 * USAGE (config file — flags override)
 *   node scripts/compose-manifest.mjs \
 *     --config assignment.json --out .provenance-manifest \
 *     --course-keypair /secure/cs61a.json --course-cert /secure/cs61a.cert.json
 *
 *   Config JSON uses the same field names as the browser composer form
 *   (`assignment_id`, `semester`, `issued_at`, `files_under_review`, `course_id`,
 *   `collaboration`, `submission`, `scope`, `ignore`, `attachments`, `policy`,
 *   and optionally `format`). Lists may be arrays or newline-/comma-separated
 *   strings.
 *
 * USAGE (1.0 — legacy)
 *   … --format 1.0 …
 *
 * USAGE (preview — no keys, no write)
 *   … --preview …      prints the unsigned JSON that would be signed and exits 0
 *
 * Or: npm run compose:manifest -- --out … --assignment-id … …
 *
 * Self-verification before write is mandatory: a tool that emits a manifest
 * that fails its own check is worse than no tool.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_COURSE_KEYPAIR_PATH = path.join(REPO_ROOT, '.notes', 'dev-keypair.json');
const DEFAULT_COURSE_CERT_PATH = path.join(REPO_ROOT, '.notes', 'dev-course-cert.json');
const DEFAULT_ROOT_KEYPAIR_PATH = path.join(REPO_ROOT, '.notes', 'dev-root-keypair.json');

// ---------------------------------------------------------------------------
// log-core (built workspace package)
// ---------------------------------------------------------------------------

let logCore;
try {
  logCore = await import('@provenance/log-core');
} catch (e) {
  console.error(
    'Could not import @provenance/log-core.\n' +
      'Run `npm run build` first, and run this script from the repo root.\n' +
      `Underlying error: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(2);
}

const {
  canonicalize,
  signManifest,
  verifyManifest,
  verifyManifestChain,
  parseCourseCert,
  validateScopeEntry,
  isExactEntry,
  DEFAULT_CAPTURE_POLICY,
  HEARTBEAT_INTERVAL_MAX_MS,
  HEARTBEAT_INTERVAL_MIN_MS,
  MANIFEST_FORMAT_VERSION_2,
  MANIFEST_FORMAT_VERSION_LEGACY,
  ok,
  err,
} = logCore;

// ---------------------------------------------------------------------------
// Form helpers (mirror the analyzer composer field set / defaults)
// ---------------------------------------------------------------------------

const DEFAULT_POLICY_FORM = {
  selection_change: DEFAULT_CAPTURE_POLICY.selection_change,
  focus_change: DEFAULT_CAPTURE_POLICY.focus_change,
  terminal: DEFAULT_CAPTURE_POLICY.terminal,
  heartbeat_interval_ms: DEFAULT_CAPTURE_POLICY.heartbeat_interval_ms,
};

/** UTC, whole seconds — matches the browser composer's issuedAtFrom. */
export function issuedAtFrom(now) {
  return `${now.toISOString().slice(0, 19)}Z`;
}

/** Blank/duplicate-trimmed path list — matches the browser composer's splitPathList. */
export function splitPathList(text) {
  const seen = new Set();
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function parsePathListFlag(value) {
  return splitPathList(value.replaceAll(',', '\n'));
}

export function buildPolicyBlock(policy) {
  return {
    capture: {
      selection_change: policy.selection_change,
      focus_change: policy.focus_change,
      terminal: policy.terminal,
      heartbeat_interval_ms: policy.heartbeat_interval_ms,
    },
  };
}

export function buildUnsignedManifest(form) {
  const base = {
    assignment_id: form.assignment_id.trim(),
    semester: form.semester.trim(),
    issued_at: form.issued_at.trim(),
    files_under_review: form.files_under_review,
  };

  if (form.format === MANIFEST_FORMAT_VERSION_LEGACY) return base;

  return {
    ...base,
    format_version: MANIFEST_FORMAT_VERSION_2,
    course_id: form.course_id.trim(),
    collaboration: form.collaboration,
    submission: form.submission,
    scope: form.scope,
    policy: buildPolicyBlock(form.policy),
    ignore: form.ignore,
    attachments: form.attachments,
  };
}

export function coercePathList(value, field) {
  if (value === undefined) return ok([]);
  if (typeof value === 'string') return ok(parsePathListFlag(value));
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === 'string')) {
      return err({ message: `Config field '${field}' must be an array of strings` });
    }
    return ok(splitPathList(value.join('\n')));
  }
  return err({
    message: `Config field '${field}' must be a string or an array of strings`,
  });
}

export function parseConfigObject(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err({ message: 'Config file must contain a JSON object' });
  }
  return ok(raw);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  '--config',
  '--out',
  '--format',
  '--assignment-id',
  '--semester',
  '--issued-at',
  '--files-under-review',
  '--course-id',
  '--collaboration',
  '--submission',
  '--scope',
  '--ignore',
  '--attachments',
  '--heartbeat-interval-ms',
  '--course-keypair',
  '--course-cert',
  '--root-pubkey',
  '--capture-selection-change',
  '--capture-focus-change',
  '--capture-terminal',
]);

const HELP_FLAGS = new Set(['--help', '-h']);

function parseBoolFlag(flag, value) {
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return ok(true);
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return ok(false);
  return err({ message: `${flag} expects true|false (got '${value}')` });
}

/**
 * Parse argv into a raw flag bag. Pure — no filesystem, no crypto.
 * Path-list flags may be repeated; values accumulate.
 */
export function parseComposeArgs(argv) {
  let help = false;
  let preview = false;
  const values = {};
  const filesUnderReview = [];
  const ignore = [];
  const attachments = [];
  let selectionChange;
  let focusChange;
  let terminal;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (HELP_FLAGS.has(token)) {
      help = true;
      continue;
    }
    if (token === '--preview') {
      preview = true;
      continue;
    }
    if (token === '--no-selection-change') {
      selectionChange = false;
      continue;
    }
    if (token === '--no-focus-change') {
      focusChange = false;
      continue;
    }
    if (token === '--no-terminal') {
      terminal = false;
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return err({ message: `${token} requires a value` });
      }
      if (token === '--files-under-review') {
        filesUnderReview.push(...parsePathListFlag(value));
      } else if (token === '--ignore') {
        ignore.push(...parsePathListFlag(value));
      } else if (token === '--attachments') {
        attachments.push(...parsePathListFlag(value));
      } else if (token === '--capture-selection-change') {
        const parsed = parseBoolFlag(token, value);
        if (!parsed.ok) return parsed;
        selectionChange = parsed.value;
      } else if (token === '--capture-focus-change') {
        const parsed = parseBoolFlag(token, value);
        if (!parsed.ok) return parsed;
        focusChange = parsed.value;
      } else if (token === '--capture-terminal') {
        const parsed = parseBoolFlag(token, value);
        if (!parsed.ok) return parsed;
        terminal = parsed.value;
      } else {
        values[token] = value;
      }
      i++;
      continue;
    }
    if (token.startsWith('--')) {
      return err({ message: `Unknown argument: ${token}` });
    }
    return err({
      message: `Unexpected positional argument: ${token} (pass flags like --out <path>)`,
    });
  }

  return ok({
    help,
    preview,
    configPath: values['--config'],
    outPath: values['--out'],
    format: values['--format'],
    assignmentId: values['--assignment-id'],
    semester: values['--semester'],
    issuedAt: values['--issued-at'],
    filesUnderReview: filesUnderReview.length > 0 ? filesUnderReview : undefined,
    courseId: values['--course-id'],
    collaboration: values['--collaboration'],
    submission: values['--submission'],
    scope: values['--scope'],
    ignore: ignore.length > 0 ? ignore : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    selectionChange,
    focusChange,
    terminal,
    heartbeatIntervalMs: values['--heartbeat-interval-ms'],
    courseKeypairPath: values['--course-keypair'],
    courseCertPath: values['--course-cert'],
    rootPubkeyHex: values['--root-pubkey'],
  });
}

// ---------------------------------------------------------------------------
// Resolve: flags > config > defaults
// ---------------------------------------------------------------------------

const COLLABORATION = new Set(['solo', 'group']);
const SUBMISSION = new Set(['bundle', 'git']);
const SCOPE = new Set(['directory', 'repo']);

const ISO_LIKE_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function pickString(flag, config) {
  if (flag !== undefined && flag.trim().length > 0) return flag.trim();
  if (config !== undefined && config.trim().length > 0) return config.trim();
  return undefined;
}

function firstBadScopeEntry(entries) {
  for (const entry of entries) {
    const problem = validateScopeEntry(entry);
    if (problem !== null) return `"${entry}" — ${problem.detail}`;
  }
  return null;
}

/**
 * Merge flags, config, and defaults. Pure aside from injected `now`.
 */
export function resolveComposeOptions(
  raw,
  config,
  env,
  now,
  defaults = {
    courseKeypairPath: DEFAULT_COURSE_KEYPAIR_PATH,
    courseCertPath: DEFAULT_COURSE_CERT_PATH,
  },
) {
  if (raw.help) {
    return err({ message: 'help' });
  }

  const formatRaw = raw.format ?? config?.format ?? MANIFEST_FORMAT_VERSION_2;
  if (formatRaw !== MANIFEST_FORMAT_VERSION_2 && formatRaw !== MANIFEST_FORMAT_VERSION_LEGACY) {
    return err({ message: `--format must be '1.0' or '2.0', got '${formatRaw}'` });
  }
  const format = formatRaw;

  const assignmentId = pickString(raw.assignmentId, config?.assignment_id);
  if (assignmentId === undefined) {
    return err({ message: 'Missing required --assignment-id (or config.assignment_id)' });
  }
  const semester = pickString(raw.semester, config?.semester);
  if (semester === undefined) {
    return err({ message: 'Missing required --semester (or config.semester)' });
  }

  const issuedAt = pickString(raw.issuedAt, config?.issued_at) ?? issuedAtFrom(now);
  if (!ISO_LIKE_RE.test(issuedAt)) {
    return err({
      message:
        `issued_at must be an ISO 8601 date or timestamp, e.g. 2026-09-08T00:00:00Z ` +
        `(got '${issuedAt}')`,
    });
  }

  let filesUnderReview;
  if (raw.filesUnderReview !== undefined) {
    filesUnderReview = raw.filesUnderReview;
  } else if (config?.files_under_review !== undefined) {
    const coerced = coercePathList(config.files_under_review, 'files_under_review');
    if (!coerced.ok) return coerced;
    filesUnderReview = coerced.value;
  } else {
    filesUnderReview = [];
  }
  if (filesUnderReview.length === 0) {
    return err({
      message:
        'Missing required --files-under-review (or config.files_under_review) — list at least one path',
    });
  }
  const filesProblem = firstBadScopeEntry(filesUnderReview);
  if (filesProblem !== null) {
    return err({ message: `files_under_review: ${filesProblem}` });
  }
  if (format === MANIFEST_FORMAT_VERSION_LEGACY) {
    for (const entry of filesUnderReview) {
      if (isExactEntry(entry)) continue;
      return err({
        message:
          `"${entry}" is a folder or suffix rule, which only exists at format 2.0. In a 1.x ` +
          'manifest it means a file with that literal name, so it would match nothing.',
      });
    }
  }

  let ignore = [];
  if (raw.ignore !== undefined) {
    ignore = raw.ignore;
  } else if (config?.ignore !== undefined) {
    const coerced = coercePathList(config.ignore, 'ignore');
    if (!coerced.ok) return coerced;
    ignore = coerced.value;
  }
  const ignoreProblem = firstBadScopeEntry(ignore);
  if (ignoreProblem !== null) {
    return err({ message: `ignore: ${ignoreProblem}` });
  }

  let attachments = [];
  if (raw.attachments !== undefined) {
    attachments = raw.attachments;
  } else if (config?.attachments !== undefined) {
    const coerced = coercePathList(config.attachments, 'attachments');
    if (!coerced.ok) return coerced;
    attachments = coerced.value;
  }
  const attachmentsProblem = firstBadScopeEntry(attachments);
  if (attachmentsProblem !== null) {
    return err({ message: `attachments: ${attachmentsProblem}` });
  }

  const collaborationRaw = pickString(raw.collaboration, config?.collaboration) ?? 'solo';
  if (!COLLABORATION.has(collaborationRaw)) {
    return err({
      message: `--collaboration must be 'solo' or 'group', got '${collaborationRaw}'`,
    });
  }
  const submissionRaw = pickString(raw.submission, config?.submission) ?? 'bundle';
  if (!SUBMISSION.has(submissionRaw)) {
    return err({
      message: `--submission must be 'bundle' or 'git', got '${submissionRaw}'`,
    });
  }
  const scopeRaw = pickString(raw.scope, config?.scope) ?? 'directory';
  if (!SCOPE.has(scopeRaw)) {
    return err({ message: `--scope must be 'directory' or 'repo', got '${scopeRaw}'` });
  }

  const courseId =
    format === MANIFEST_FORMAT_VERSION_2
      ? (pickString(raw.courseId, config?.course_id) ?? '')
      : '';

  if (format === MANIFEST_FORMAT_VERSION_2 && courseId.length === 0) {
    return err({ message: 'Missing required --course-id (or config.course_id) for format 2.0' });
  }

  if (!raw.preview && (raw.outPath === undefined || raw.outPath.trim().length === 0)) {
    return err({ message: 'Missing required --out <path> (or pass --preview)' });
  }

  const cfgPolicy = config?.policy;
  let heartbeatIntervalMs = DEFAULT_POLICY_FORM.heartbeat_interval_ms;
  if (raw.heartbeatIntervalMs !== undefined) {
    const n = Number(raw.heartbeatIntervalMs);
    if (!Number.isInteger(n)) {
      return err({
        message: `--heartbeat-interval-ms must be a whole number, got '${raw.heartbeatIntervalMs}'`,
      });
    }
    heartbeatIntervalMs = n;
  } else if (cfgPolicy?.heartbeat_interval_ms !== undefined) {
    if (!Number.isInteger(cfgPolicy.heartbeat_interval_ms)) {
      return err({
        message: 'Config policy.heartbeat_interval_ms must be a whole number',
      });
    }
    heartbeatIntervalMs = cfgPolicy.heartbeat_interval_ms;
  }
  if (
    heartbeatIntervalMs < HEARTBEAT_INTERVAL_MIN_MS ||
    heartbeatIntervalMs > HEARTBEAT_INTERVAL_MAX_MS
  ) {
    return err({
      message:
        `heartbeat_interval_ms must be between ${String(HEARTBEAT_INTERVAL_MIN_MS)} and ` +
        `${String(HEARTBEAT_INTERVAL_MAX_MS)} ms (got ${String(heartbeatIntervalMs)})`,
    });
  }

  const policy = {
    selection_change:
      raw.selectionChange ?? cfgPolicy?.selection_change ?? DEFAULT_POLICY_FORM.selection_change,
    focus_change: raw.focusChange ?? cfgPolicy?.focus_change ?? DEFAULT_POLICY_FORM.focus_change,
    terminal: raw.terminal ?? cfgPolicy?.terminal ?? DEFAULT_POLICY_FORM.terminal,
    heartbeat_interval_ms: heartbeatIntervalMs,
  };

  const form = {
    format,
    assignment_id: assignmentId,
    semester,
    issued_at: issuedAt,
    files_under_review: filesUnderReview,
    ignore: format === MANIFEST_FORMAT_VERSION_2 ? ignore : [],
    attachments: format === MANIFEST_FORMAT_VERSION_2 ? attachments : [],
    course_id: courseId,
    collaboration: collaborationRaw,
    submission: submissionRaw,
    scope: scopeRaw,
    policy,
  };

  return ok({
    preview: raw.preview,
    outPath: raw.preview ? null : raw.outPath,
    form,
    courseKeypairPath:
      raw.courseKeypairPath ?? env.PROVENANCE_COURSE_KEYPAIR_PATH ?? defaults.courseKeypairPath,
    courseCertPath: raw.courseCertPath ?? env.PROVENANCE_COURSE_CERT_PATH ?? defaults.courseCertPath,
    rootPubkeyHex: raw.rootPubkeyHex ?? env.PROVENANCE_ROOT_PUBLIC_KEY_HEX ?? null,
  });
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/compose-manifest.mjs \\
  --out <path> --assignment-id <id> --semester <id> --files-under-review <paths> \\
  [--course-id <id>] [--format 1.0|2.0] [--issued-at <ISO>] \\
  [--collaboration solo|group] [--submission bundle|git] [--scope directory|repo] \\
  [--ignore <paths>] [--attachments <paths>] \\
  [--no-selection-change] [--no-focus-change] [--no-terminal] \\
  [--heartbeat-interval-ms <ms>] \\
  [--course-keypair <path>] [--course-cert <path>] [--root-pubkey <hex>] \\
  [--config <json>] [--preview]

Headless counterpart of the analyzer's /compose/manifest page. Covers every
composer field (ignore = the exclude list; attachments; policy; etc.).
Pass fields as flags, or put them in --config JSON (flags override).
At format 2.0 (default) --course-id, a course keypair, and a course certificate
are required. --preview prints the unsigned payload and exits without signing.

CI: this is NOT a drop-in single file. Check out this provenance repo, run
\`npm ci\` + \`npm run build --workspace=packages/log-core\`, then invoke this
script from the repo root. See the file header comment for a full recipe.

npm run compose:manifest -- …`;

function die(message) {
  process.stderr.write(`[compose-manifest] ${message}\n`);
  process.exit(1);
}

function readJsonFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    die(`${label} not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`${label} at ${filePath} is not valid JSON: ${String(e)}`);
  }
}

function loadKeypair(keypairPath) {
  const parsed = readJsonFile(keypairPath, 'Course keypair');
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'root_sig' in parsed &&
    !('private_key_hex' in parsed)
  ) {
    die(
      'That is the course CERTIFICATE, not the keypair. Choose the file from ' +
        'tools/generate-course-keypair.ts.',
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.public_key_hex !== 'string' ||
    typeof parsed.private_key_hex !== 'string'
  ) {
    die(`Course keypair file ${keypairPath} is missing public_key_hex / private_key_hex.`);
  }
  return {
    public_key_hex: parsed.public_key_hex,
    private_key_hex: parsed.private_key_hex,
  };
}

function loadCourseCert(certPath) {
  const parsed = readJsonFile(certPath, 'Course certificate');
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    'private_key_hex' in parsed
  ) {
    die(
      'That is your course PRIVATE KEY file, not the certificate. The certificate is published ' +
        'to every student — choose the file from tools/mint-course-cert.ts.',
    );
  }
  const cert = parseCourseCert(parsed);
  if (!cert.ok) {
    die(
      'That file is not a course certificate. It needs course_id, course_pubkey, valid_from, ' +
        'valid_until and root_sig — the file tools/mint-course-cert.ts writes.',
    );
  }
  return cert.value;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function loadRootPubkeyHex(opts) {
  if (opts.rootPubkeyHex !== null && opts.rootPubkeyHex.length > 0) {
    return opts.rootPubkeyHex;
  }
  if (!fs.existsSync(DEFAULT_ROOT_KEYPAIR_PATH)) {
    die(
      'No root public key available (pass --root-pubkey or set PROVENANCE_ROOT_PUBLIC_KEY_HEX, ' +
        `or place a keypair at ${DEFAULT_ROOT_KEYPAIR_PATH}). Refusing to emit an unverified ` +
        'manifest.',
    );
  }
  const parsed = readJsonFile(DEFAULT_ROOT_KEYPAIR_PATH, 'Root keypair');
  if (typeof parsed.public_key_hex !== 'string') {
    die(`Root keypair at ${DEFAULT_ROOT_KEYPAIR_PATH} is missing public_key_hex.`);
  }
  return parsed.public_key_hex;
}

export async function runCompose(opts) {
  if (opts.preview) {
    const unsigned = buildUnsignedManifest(opts.form);
    process.stdout.write(JSON.stringify(unsigned, null, 2) + '\n');
    return;
  }

  const outPath = opts.outPath;
  console.log(`[compose-manifest] Format: ${opts.form.format}`);
  console.log(`[compose-manifest] Out: ${outPath}`);
  console.log(`[compose-manifest] Course keypair: ${opts.courseKeypairPath}`);

  const keypair = loadKeypair(opts.courseKeypairPath);
  console.log(`[compose-manifest] Course public key: ${keypair.public_key_hex}`);

  const unsigned = buildUnsignedManifest(opts.form);
  const privateKey = hexToBytes(keypair.private_key_hex);
  let sig;
  try {
    sig = await signManifest(unsigned, privateKey);
  } finally {
    privateKey.fill(0);
  }

  if (opts.form.format === MANIFEST_FORMAT_VERSION_LEGACY) {
    const signed = { ...unsigned, sig };
    const verified = await verifyManifest(signed, keypair.public_key_hex);
    if (!verified.ok) {
      die(
        `Refusing to write: the manifest this tool just signed did not verify ` +
          `(${JSON.stringify(verified.error)}). This is a bug — please report it.`,
      );
    }
    const parent = path.dirname(path.resolve(outPath));
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(outPath, canonicalize(signed) + '\n');
    console.log(`[compose-manifest] Manifest signed and written to ${outPath}`);
    console.log(`[compose-manifest] sig (128 hex chars): ${sig}`);
    return;
  }

  console.log(`[compose-manifest] Course cert: ${opts.courseCertPath}`);
  const cert = loadCourseCert(opts.courseCertPath);

  if (opts.form.course_id.trim() !== cert.course_id) {
    die(
      `course_id ("${opts.form.course_id}") does not match the certificate ("${cert.course_id}"). ` +
        'A manifest may not claim a course its certificate does not cover — the recorder checks ' +
        'exactly this (trust chain step 3) and would refuse to activate.',
    );
  }
  if (keypair.public_key_hex !== cert.course_pubkey) {
    die(
      'That keypair is not the one this certificate authorizes. The certificate vouches for a ' +
        'different public key, so a manifest signed with this key would fail trust chain step 2.',
    );
  }

  const signed = { ...unsigned, sig, course_cert: cert };
  const rootPubkeyHex = loadRootPubkeyHex(opts);
  const chainResult = await verifyManifestChain(signed, rootPubkeyHex);
  if (!chainResult.ok) {
    die(
      `Refusing to write: the manifest this tool just signed does not verify its own trust ` +
        `chain (${JSON.stringify(chainResult.error)}).\n` +
        'Common causes: manifest.course_id does not match course_cert.course_id, the course ' +
        'keypair does not match the certificate, or --root-pubkey does not match the root key ' +
        'that signed the certificate.',
    );
  }

  const parent = path.dirname(path.resolve(outPath));
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(outPath, canonicalize(signed) + '\n');
  console.log(`[compose-manifest] Manifest signed and written to ${outPath}`);
  console.log(`[compose-manifest] sig (128 hex chars): ${sig}`);
  console.log(`[compose-manifest] Chain verified: course_id=${chainResult.value.course_id}`);
  if (!chainResult.value.window.in_window) {
    console.log(
      `[compose-manifest] WARNING: cert is out of its validity window at issued_at ` +
        `(${chainResult.value.window.reason}). The recorder will still record (program spec §4); ` +
        `re-mint the certificate if this is unexpected.`,
    );
  }
}

async function main() {
  const parsed = parseComposeArgs(process.argv.slice(2));
  if (!parsed.ok) {
    die(`${parsed.error.message}\n\n${USAGE}`);
  }
  if (parsed.value.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }

  let config = null;
  if (parsed.value.configPath !== undefined) {
    if (!fs.existsSync(parsed.value.configPath)) {
      die(`Config file not found: ${parsed.value.configPath}`);
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(parsed.value.configPath, 'utf8'));
    } catch (e) {
      die(`Config file at ${parsed.value.configPath} is not valid JSON: ${String(e)}`);
    }
    const cfg = parseConfigObject(raw);
    if (!cfg.ok) die(cfg.error.message);
    config = cfg.value;
  }

  const resolved = resolveComposeOptions(parsed.value, config, process.env, new Date());
  if (!resolved.ok) {
    if (resolved.error.message === 'help') {
      process.stdout.write(USAGE + '\n');
      process.exit(0);
    }
    die(`${resolved.error.message}\n\n${USAGE}`);
  }

  await runCompose(resolved.value);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((e) => {
    console.error('[compose-manifest] Fatal error:', e);
    process.exit(1);
  });
}
