import type { ArchNode } from '../types.js';
import { GH, GH_PROVGATE } from './links.js';

/** Nodes in the `ingest` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Entry ─────────────────────────────────────────────────────────────────
  e_http: {
    title: 'HTTP upload',
    body: 'The single-request route never holds the body in memory. The archive field is streamed straight to a temp file and the on-disk path is handed to the same reader the CLI uses, so the ceiling is disk and INGEST_MAX_UPLOAD_BYTES rather than the roughly 2 GiB that multipart/FormData parsing imposes. A Content-Length above the cap is refused before a byte is read.\n\nAll three upload entry points are scope-aware, and the shape of the per-request declaration follows the shape of the body rather than the route: the two multipart routes — the plain file upload and the Gradescope export — take flat scope_mode / scope_path_glob / scope_on_multiple query parameters, because their bodies are reserved for the archive; the chunked route’s completion call has a JSON body and takes the nested ingest_scope object, which rides its pg-boss payload so it survives the 202 that comes back before staging runs. Two spellings, one per body type, folded into the identical object by the identical function. The plain upload route was the odd one out until 2026-08: it had no scope handling at all, so it understood exactly two shapes — a sealed bundle, and an archive whose entries are all .zip — and a git repo zip matched neither. It fell through to the bundle branch and was staged whole, which handed the loader a tree it cannot parse. The bad part was that it did not error, and that this is the route staff reach for to re-ingest or fix up by hand, which is precisely when the automated path has already gone wrong. It now runs the same discovery and the same resolution as the export path, so a repo fans out into one submission per accepted scope and every scope that does not become one is reported in the same skipped array. The guard that makes that safe is decided from entry NAMES alone: an archive is a repo only if some non-junk entry sits under a .provenance/ directory. A sealed bundle is flat by construction, so it can never satisfy that, is never rebuilt, and stages the exact bytes that were sent — its blob sha256, the dedup key, is unchanged by construction rather than by argument.\n\nThe point at which the browser switches to the chunked path is not really a judgement about size: it is pinned to exactly one chunk, 16 MiB. The deployment sits behind an nginx whose client_max_body_size is around 20 MiB, so any single request carrying more than one part is rejected before it reaches the app. Splitting at one chunk guarantees that neither a part PUT nor a single-shot POST can ever exceed that limit. Part state lives in the S3/MinIO multipart upload rather than in a server-side table, so a resume works across API processes and across restarts.',
    links: [
      {
        label: 'resumable-upload.ts (client)',
        href: `${GH}/packages/analyzer/src/api/resumable-upload.ts`,
      },
      {
        label: 'stream-upload.ts',
        href: `${GH}/packages/server/src/services/ingest/stream-upload.ts`,
      },
      { label: 'repo-zip.ts', href: `${GH}/packages/server/src/services/ingest/repo-zip.ts` },
    ],
  },
  e_cli: {
    title: 'ingest:local',
    body: 'The reader opens the export with yauzl and drains its central directory first (filenames and offsets only, no file bytes, even at 10 GB), then opens a read stream per entry on demand. Peak memory is one submission folder plus one rebuilt bundle, whatever the archive weighs.\n\nIt deliberately does not enforce INGEST_MAX_BATCH_BYTES. That cap exists to bound the in-memory HTTP path, and ingesting an arbitrarily large export straight from disk is the entire reason this entry point exists; the per-bundle size cap and the file-count cap still apply. It is not a parallel implementation either: the HTTP routes stream their upload to a temp file and then call this same function, so there is exactly one piece of code in the system that reads a Gradescope export.',
    links: [
      { label: 'local-path.ts', href: `${GH}/packages/server/src/services/ingest/local-path.ts` },
      {
        label: 'stream-export.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/stream-export.ts`,
      },
    ],
  },
  e_gate: {
    title: 'provgate · hourly delta',
    body: 'The gateway enters through the same authenticated route a staff member uses. There is no flag on the job that says "this came from a gateway", no separate code path, and no trust relationship beyond the API token’s scopes, which is what makes provgate replaceable by a shell script, a cron job, or nothing at all.\n\nIts per-assignment watermark is therefore an optimisation and never a correctness mechanism. A stale, lost or wrong watermark means submissions the server has already seen get forwarded again, and the dedup below discards them for the cost of one indexed lookup. A gateway that had to be right about what it had already sent would silently drop submissions on the day it was wrong.',
    links: [
      { label: 'prune.py', href: `${GH_PROVGATE}/src/provgate/sync/prune.py` },
      { label: 'ingest.ts routes', href: `${GH}/packages/server/src/api/v1/routes/ingest.ts` },
    ],
  },

  // ── Stage 1 · parse ───────────────────────────────────────────────────────
  meta: {
    title: 'submission_metadata.yml',
    body: 'Gradescope unzips whatever a student uploads, so there is no bundle .zip left in the export. A submission is a folder of loose files, and this metadata file is the only thing tying that folder to a person. Its top-level keys are the submission folder names and each carries a submitters list, so identity comes from the export rather than from the filename. That is why a Gradescope-sourced submission never runs the semester’s filename convention.\n\nThe format is Ruby-flavoured YAML: mapping keys are Ruby symbols and serialize with a leading colon (:submitters, :sid, :name). Submitters with no sid are dropped, because sid is the roster key and a submitter that cannot be matched cannot be rostered either. This file is also the reason provgate copies it through verbatim when it prunes an export: it is the join key for every folder in the archive, and a regenerated copy would be a second source of truth that can disagree with the first.',
    links: [
      {
        label: 'parse-metadata.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/parse-metadata.ts`,
      },
      {
        label: 'upsert-roster.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/upsert-roster.ts`,
      },
    ],
  },
  hasmeta: {
    title: 'Is this a Gradescope export?',
    body: 'The metadata is found by scanning the central directory for the shallowest path ending in submission_metadata.yml, skipping __MACOSX noise, so an export that someone re-zipped inside an extra wrapping folder still resolves. Everything downstream keys off the prefix that scan produces: entries that do not start with it are ignored, and the first path segment after it is the submission folder.\n\nThe "no" branch is different in kind from every other failure in this diagram. It is answered synchronously, as a 400 on the upload request, before any ingest job or ingest_files row exists: nothing was staged and there is nothing to inspect afterwards. Every failure further down is recorded on a row that survives and can be looked at later.',
    links: [
      {
        label: 'stream-export.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/stream-export.ts`,
      },
      { label: 'ingest.ts routes', href: `${GH}/packages/server/src/api/v1/routes/ingest.ts` },
    ],
  },
  scope: {
    title: 'The declared submission type',
    body: 'A batch declares what shape its submissions are, and a mismatch fails rather than ingesting as something it is not. Four modes: self_identifying (the default) accepts every sealed .provenance/ scope wherever it sits; bundle_zip is the classic sealed archive, exactly one scope at the tree root; repo_whole treats a git repo as one scope at the repo root and EXCLUDES nested scopes rather than fanning them out; repo_scoped selects scopes by path_glob. The declaration converts per-file guessing into a per-batch assertion, which is the whole argument for having it.\n\nIt comes from the assignment row, or from a per-request override that beats it. The override is simply a resolver that ignores its assignment key, so nothing below the entry point can tell which of the two it got, and it short-circuits the per-assignment lookup entirely, because a declaration about the whole batch leaves nothing per-assignment to read. All three upload routes now offer it, in two spellings that follow the route’s BODY rather than the route: the two multipart routes take flat scope_mode / scope_path_glob / scope_on_multiple query parameters, and the JSON finalize takes a nested ingest_scope object. Both are folded into the same object and re-narrowed through the same parser.\n\nA repo-shaped archive is recognised from entry NAMES alone: it is a repo iff some non-junk entry sits under a .provenance/ directory. A sealed bundle is flat by construction, so it can never satisfy that predicate, is never rebuilt, and stages the exact bytes uploaded — which means its blob_sha256, the dedup key, is unchanged by construction rather than by test. The accepted cost of deciding it that way is that the declared type is asserted only on the repo-shaped branch, so a repo_scoped batch handed a flat bundle ingests it rather than rejecting it; asserting there would mean rebuilding a flat bundle to read its declared assignment id, which changes the staged bytes of the exact shape this was required to leave alone.\n\nThe plain multipart route was the outlier and it was an oversight rather than a decision: it had ZERO scope handling, so the expander understood only "a bundle" and "a zip of bundles", a git repo zip matched neither, and it fell through to staging the whole repository as one malformed bundle — without erroring, on the one path staff use for a manual re-ingest or a fixup. The adapter that closes it ADAPTS rather than reimplements: discovery, resolution, entry selection, entry order and the ZIP rebuild are the same functions the Gradescope path calls, with the same arguments in the same order, and a test drives one repo tree through both and requires byte-identical rebuilt bundles.\n\nA scope counts as sealed by EITHER shape — the classic manifest.json, or the per-session manifest-<session_id>.json a git submission carries. Recognising only the classic name here discarded every rolling-sealed scope as no_seal and made git submission produce nothing at all.\n\nOne gap is inherent and unfixed: a fanned-out non-root scope is staged as <stem>/<scope>.zip, which no semester filename convention can match, so it lands in the unmatched tray. One upload became N submissions and a filename encodes one identity. The Gradescope path only avoids it by carrying match_sid in its export metadata, which this route has no equivalent of; a root scope keeps the uploaded filename verbatim, so repo_whole still matches as before.',
    invariant:
      'A flat sealed bundle is never rebuilt. Its staged bytes — and therefore its dedup key — are unchanged by construction, not by assertion.',
    links: [
      {
        label: 'repo-scopes.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/repo-scopes.ts`,
      },
      { label: 'repo-zip.ts', href: `${GH}/packages/server/src/services/ingest/repo-zip.ts` },
      {
        label: '0026_ingest_scope_submission_types.sql',
        href: `${GH}/packages/server/db/migrations/0026_ingest_scope_submission_types.sql`,
      },
    ],
  },
  skiplist: {
    title: 'The skipped array',
    body: 'A scope the declaration refused produces no ingest_files row — that is what being skipped means — and the job summary is nothing but a count of those rows. So without somewhere to put them, the reasons a batch dropped half its scopes reach nobody.\n\nThe refusals share one channel rather than each getting its own: no_seal, scope_excluded, ambiguous_scope, submission_type_mismatch, no_manifest, no_submitters, bundle_too_large. A heterogeneous batch is therefore reported through the same list as a .provenance/ nothing signs, which is what lets provgate and the job view render one thing.\n\nFailure is per SUBMISSION, never per batch. The export is streamed folder by folder and staged incrementally with no transaction spanning it, and rows are never deleted, so aborting mid-batch would strand a half-ingested submission with no way back. A repo_scoped glob that selects nothing is included in that: otherwise a typo’d glob drops a whole cohort while the ingest reports success.\n\nThe column is nullable WITH NO DEFAULT, and the three states are three different answers. Null means resolution has not finished — still staging, or aborted part-way. An empty array means it finished and skipped nothing, which is a positive statement. A populated array is the list. Collapsing null and empty is exactly how the chunked upload path used to report a heterogeneous batch as clean, and the two paths differ in whether they ever have to spend a null: the single-shot route resolves inside the request, so its inline field is not nullable and there is no instant at which its honest answer is "unknown".\n\nIt is written once, by full replacement, BEFORE the finalize gate opens, and no other write path names the column — so when every scope is rejected the job is marked failed rather than left queued (nothing will be enqueued, so nothing would ever finalize it) and the reasons still survive.',
    links: [
      {
        label: '0028_ingest_jobs_skipped.sql',
        href: `${GH}/packages/server/db/migrations/0028_ingest_jobs_skipped.sql`,
      },
      { label: 'job-control.ts', href: `${GH}/packages/server/src/services/ingest/job-control.ts` },
    ],
  },
  fanout: {
    title: 'Fan out',
    body: 'The unit is an assignment scope times a submitter, not a folder. A folder is walked for every .provenance/ at any depth, and each one is synthesized into its own flat bundle carrying that directory’s own relative paths, so a cloned 61B repo holding proj2/ and lab5/ becomes two independent submissions rather than one unusable archive. Scopes are self-identifying — the manifest carries assignment_id and semester — so nothing has to be told where to look.\n\nEach scope’s bundle is shared by every co-submitter of a group submission, and each of them gets their own ingest_files row and their own queued job — but, since migration 0029, ONE submission between them: the first to be processed creates it and the rest attach to it as contributors, which is why the Gradescope path no longer narrows its dedup key by student. The rebuild that produces those bytes is byte-deterministic, because its sha256 is what dedup keys on, and a flat folder with a single root .provenance/ still yields exactly one scope with byte-identical entries, so the classic Gradescope path is unmoved.\n\n"Bounded" is two independent limits. The stager keeps at most INGEST_STAGE_CONCURRENCY per-bundle tasks in flight (default 1, exactly serial) with backpressure, so the producer cannot run ahead of the writers; the worker separately claims batches of INGEST_CONCURRENCY files. "Cancellable" is cooperative: cancelling does not remove queued jobs from pg-boss, it sets ingest_jobs.status, which every file job re-reads before doing any work and then marks its still-pending row discarded. One gate covers queued, in-flight and restart-replayed jobs alike.',
    invariant:
      'A job is never finalized while staging_complete is false. During streaming staging, a momentarily-empty pending count must not settle the job.',
    links: [
      { label: 'local-path.ts', href: `${GH}/packages/server/src/services/ingest/local-path.ts` },
      {
        label: 'repo-scopes.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/repo-scopes.ts`,
      },
      { label: 'repo-zip.ts', href: `${GH}/packages/server/src/services/ingest/repo-zip.ts` },
      { label: 'job-control.ts', href: `${GH}/packages/server/src/services/ingest/job-control.ts` },
    ],
  },
  pbun: {
    title: 'Parse bundle',
    body: 'This is the same isomorphic loader the browser’s /local route runs: unzip into the flat bundle shape the recorder seals, parse each .slog line as NDJSON, pair every log with its .slog.meta sidecar, and sort the sessions by the wall clock of their first event. It returns a discriminated result rather than throwing, which is what lets one malformed archive cost exactly one row.\n\nWhat it does not do is verify anything. Signature checking and the hash chain belong to validation, further down; the loader’s job is to produce a typed bundle or a precise reason it could not. A bundle whose chain is broken parses perfectly well and proceeds: refusing to ingest a tampered bundle would destroy the evidence the system exists to collect. The parsed result then stays in memory, source files included, and is the single copy every later stage reads.',
    links: [
      {
        label: 'parse-bundle-phase.ts',
        href: `${GH}/packages/server/src/services/ingest/parse-bundle-phase.ts`,
      },
      {
        label: 'parse-bundle.ts',
        href: `${GH}/packages/analysis-core/src/loader/parse-bundle.ts`,
      },
    ],
  },
  pfail: {
    title: 'Parse failure',
    body: 'A parse failure settles one file. The row’s status becomes failed with a structured {phase, cause, detail}, its siblings carry on, and the job finalizes as partial rather than failed: a single unreadable folder in a 700-student export must not cost the other 699. The causes are the loader’s own error kinds: not_a_zip, missing_manifest, invalid_manifest, missing_signature, unexpected_file, or a per-session shape error that carries the offending line number.\n\nThe structured error is the product, not a log line. It is what the unmatched and job views render, and it is why "cause" is a closed set of kinds rather than a message: staff need to tell "this student uploaded the wrong file" apart from "this recorder produced something we cannot read", and those two lead to different conversations.',
    links: [
      {
        label: 'parse-bundle-phase.ts',
        href: `${GH}/packages/server/src/services/ingest/parse-bundle-phase.ts`,
      },
      { label: 'job-control.ts', href: `${GH}/packages/server/src/services/ingest/job-control.ts` },
    ],
  },

  // ── Dedup ─────────────────────────────────────────────────────────────────
  dd: {
    title: 'Dedup — the declared group, then the content hash',
    body: 'One indexed lookup, taken before the blob is unzipped, before the roster is touched and before any analysis runs. The ordering is the whole point: a re-send costs an index probe rather than a full parse plus eight checks plus eighteen heuristics, which is what allows every upstream sender (a gateway, a staff member re-uploading, a retried job) to be sloppy about what it has already delivered.\n\nThe key really is the pair on the label, on every path, as of migration 0029. It was not always: files arriving with a match hint — the Gradescope path — used to dedup on (semester, student, blob) instead, because two co-submitters of one group submission legitimately share identical bytes and a blob-only key would collapse the second of them into a duplicate and lose a student’s submission.\n\nThat narrowing is no longer needed, because losing the student is no longer the consequence. A duplicate that arrives with a match hint ATTACHES that student to the existing submission as a contributor, so the person survives without the artifact being stored twice. Identical bytes really do mean the same artifact — a bundle carries per-session uuids, per-session keys and wall-clock timestamps, so two people cannot produce one by coincidence — and what the narrow key was actually distinguishing was never two artifacts but two SUBMITTERS of one, which submission_contributors now represents directly. The attach is an untargeted ON CONFLICT DO NOTHING, because the person can already be present under either a roster key or an attributed one, and both mean the same thing.\n\nThis check alone is not sufficient, and that is worth knowing: it and the submission INSERT are separate transactions, and the worker drains its pg-boss batch with Promise.all, so two co-submitters can both clear this probe before either commits. Phase 5 therefore re-checks the same key inside its own transaction under a pg_advisory_xact_lock, and the loser is reported as a duplicate there instead of creating a second submission. Without that, the fan-out came back under concurrency while every serial test stayed green.\n\nSince migration 0033 the blob hash is no longer the FIRST key asked. A file carrying a source_group_key — the declared Gradescope group, <folderKey>/<scopePath> — is looked up on (semester_id, source_group_key) first, and only a miss there falls through to the blob probe. The ordering is the fix. Collapsing two co-submitters onto one submission previously depended on their bytes matching, and their bytes matched only because local-path.ts happens to await ONE shared rebuild promise for the whole group: a detail of that function, not an invariant. Any divergence at all — scope resolution, entry ordering, the zip writer, a folder partly skipped for no_seal — split a declared group into two submissions of one repository in one assignment, which is exactly the shape the cross heuristics fire on at high severity. When both probes would fire they name the same submission; when only one does, it is this one, because bytes can diverge and a declaration cannot. Every non-Gradescope file has a null key and takes exactly the path it always took.\n\nA second, live erasure sat beside it and had nothing to do with Gradescope. Phase 2 gated attachCoSubmitter on a non-null hint, but that hint comes from match_sid, which only the Gradescope path sets; on the FILENAME path the student is not resolved until phase 4. So the second student of a byte-identical pair got status duplicate, matched_student_id null and no contributor row at all, while the job reported succeeded. Timing masked it rather than preventing it: when the two files raced past phase 2 together, the phase-5 late-duplicate branch caught the loser instead, by which point phase 4 had run, so whether a student survived depended on how the batch interleaved. Phase 2 now resolves the submitter from the filename when there is no hint, through the same resolveSubmitterFromFilename that matchStudent calls, so the two cannot disagree.',
    invariant:
      'Dedup precedes parse, match and analysis, and the declared group precedes the bytes. Nothing expensive may be moved in front of it.',
    links: [
      { label: 'dedup.ts', href: `${GH}/packages/server/src/services/ingest/dedup.ts` },
      { label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` },
    ],
  },
  ddskip: {
    title: 'Skip · already ingested',
    body: 'Nothing is thrown away. The row is marked duplicate and linked to the submission whose bytes it matched, so the upload still appears in the job’s summary and still resolves to something a reviewer can open. Skip means "produce no second submission", not "forget this happened". Because duplicate is a clean outcome, a job made entirely of re-sends finalizes as succeeded rather than partial.\n\nOne subtlety about the key: the recorded sha256 is of the bundle as it arrived, not of the object the server ends up storing. Stripping rewrites the archive, so the stored blob’s own hash differs by design. The recorded value is the stable identity of what the student submitted, and it doubles as the cache key for re-parsing, which is what stops a superseded or re-ingested blob from ever serving a stale parse.',
    links: [
      { label: 'dedup.ts', href: `${GH}/packages/server/src/services/ingest/dedup.ts` },
      {
        label: 'create-submission.ts',
        href: `${GH}/packages/server/src/services/ingest/create-submission.ts`,
      },
    ],
  },

  // ── Stage 2 · match ───────────────────────────────────────────────────────
  roster: {
    title: 'Roster upsert',
    body: 'The roster is populated from the export itself, once, up front (before any per-file job runs), which is why a Gradescope upload works against a semester with no roster at all and needs no CSV. Matching is on (semester_id, sid), the same key the worker later uses to resolve a file’s match hint, so the sids written here line up exactly with the sids matched afterwards.\n\nIt adds and updates and never deletes, unlike the CSV commit flow, which can. The metadata names only the students who actually submitted, so a delete-capable upsert would remove everyone who did not. Name and email overwrite a stored value only when the metadata carries one, so a row missing a name cannot blank a display name that is already there, and newly inserted rows are assigned a per-semester protected index so protected mode shows a stable "Student N" rather than falling back to a slice of a UUID.',
    links: [
      {
        label: 'upsert-roster.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/upsert-roster.ts`,
      },
      { label: 'local-path.ts', href: `${GH}/packages/server/src/services/ingest/local-path.ts` },
    ],
  },
  match: {
    title: 'Does this map to a roster entry?',
    body: 'Two routes reach the same answer. A file staged from a Gradescope export carries a match hint taken from the metadata and resolves against the roster directly, with the assignment read from the signed bundle manifest. Everything else runs the semester’s filename convention (a regex that must compile and must contain a named sid group) with the assignment coming from an optional capture and falling back to the manifest.\n\nThere are exactly two ways to miss, and they are recorded separately on purpose: no_filename_match means the convention did not apply, which is usually a problem with the whole batch, while unknown_sid means it applied and produced an sid nobody on the roster has, which is one student. The lookup itself is injected as a resolver function, so the matching rule stays a pure function with no database inside it and is tested as one.',
    links: [
      {
        label: 'match-student.ts',
        href: `${GH}/packages/server/src/services/ingest/match-student.ts`,
      },
      {
        label: 'filename-convention.ts',
        href: `${GH}/packages/server/src/services/ingest/filename-convention.ts`,
      },
    ],
  },
  unm: {
    title: 'Unmatched queue',
    body: 'An unmatched bundle is evidence that has arrived and cannot yet be attributed. Dropping it would lose a submission over a filename typo or a roster that was uploaded late, so it stays in its own paginated tray with its staged blob intact: unmatched is the one status whose blob is never moved out of staging, precisely so it can still be attached later.\n\nAttaching is not a bookkeeping update. It re-runs the pipeline from submission creation onward against that staged blob, inside a transaction that holds a row lock on the ingest file, so two admins clicking at once serialize and the loser gets a 409 rather than a second submission. It also enqueues the semester’s cross-flag recompute itself, because only ingest and recompute finalization do that automatically. If the manifest’s assignment disagrees with the admin’s choice, that is returned as a non-blocking warning: the human has more context than the manifest, and the disagreement is worth recording rather than refusing.',
    invariant:
      'Nothing is dropped for want of a match. Every unmatched file keeps its staged blob and its row until a human attaches or discards it.',
    links: [
      { label: 'attach.ts', href: `${GH}/packages/server/src/services/ingest/attach.ts` },
      { label: 'unmatched.ts', href: `${GH}/packages/server/src/api/v1/routes/unmatched.ts` },
    ],
  },

  // ── Stage 3 · analyse ─────────────────────────────────────────────────────
  stats: {
    title: 'Per-file statistics',
    body: 'Characters typed, characters pasted, the net delta attributable to external changes and the save count all come straight off the event index. The final length does not: the file is replayed from its events to the end of the stream and the resulting content is measured, so the number reflects what the log says the file became, never anything read off disk. The starting length is the length of the content carried on that file’s first doc.open, which recorders before v1.1 did not record, so it reads 0 for those bundles rather than pretending to be known.\n\nEach row also carries whether the reconstruction behind it was tainted. That travels with the statistics rather than beside them because the derived ratios (typed versus final output above all) are only as trustworthy as the replay underneath, and a reviewer comparing two submissions needs to know which of the two numbers is soft. The write is an upsert keyed on (submission, file path), so a later recompute overwrites in place instead of accumulating.',
    links: [
      { label: 'stats.ts', href: `${GH}/packages/server/src/services/ingest/stats.ts` },
      {
        label: 'reconstruct-file-provenance.ts',
        href: `${GH}/packages/analysis-core/src/index/reconstruct-file-provenance.ts`,
      },
    ],
  },
  val: {
    title: 'The eight validation checks',
    body: 'The checks run here once, and the row they write is what every read path serves afterwards. The analyzer does not re-validate a stored bundle on demand. Each status lands in its own column in spec order with the full per-check detail as jsonb, the roll-up is copied onto the submission so the cohort list can filter without a join, and a report that comes back with anything other than eight checks throws rather than quietly writing a short row.\n\nOne piece of configuration reaches in here: the Manifest 2.0 root public key, threaded through as an option rather than read from a constant, because analysis-core is isomorphic and holds no keys. Check 2 uses it to walk a 2.0 bundle’s trust chain offline. Leaving it unset is a supported state and produces skipped rather than a guess in either direction — which the roll-up then turns into warn, never pass.\n\nThe submitted bytes matter for less of this than it looks. Check 8 compares the signed manifest’s sha256 for a file against the last on-disk hash the recorder observed, and both of those survive stripping; what genuinely needs the bytes is its tamper sub-check, which asks whether the archive’s contents hash to what the manifest claims. That question can only be asked while the archive still contains them, and it is the reason validation runs before the strip rather than after it.',
    links: [
      { label: 'validation.ts', href: `${GH}/packages/server/src/services/ingest/validation.ts` },
      {
        label: 'verify-submitted-code.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-submitted-code.ts`,
      },
    ],
  },
  heur: {
    title: 'Heuristics and integrity flags',
    body: 'Eighteen heuristics run in fixed registry order over the index that was built once and shared with the statistics phase, and the failing validation checks are then folded in by an adapter rather than reimplemented as heuristics. Nothing is re-analysed: the adapter translates check failures into the same flag shape, so cryptographic and behavioural findings reach the cohort list, the score and the export through one path.\n\nThe semester’s active configuration is applied at write time rather than inside the heuristics. Thresholds are forwarded into the analysis engine; then each flag is dropped entirely if its heuristic is disabled, and otherwise stored together with the weight and the config version in force when it was computed. A disabled heuristic therefore leaves no row at all, which is why turning one back on requires a recompute rather than a re-read, and why an old score stays explainable after the configuration has moved on.',
    links: [
      {
        label: 'run-per-submission.ts',
        href: `${GH}/packages/server/src/services/heuristics/run-per-submission.ts`,
      },
      {
        label: 'run-heuristics.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/run-heuristics.ts`,
      },
    ],
  },

  // ── Per-submission transaction ────────────────────────────────────────────
  upa: {
    title: 'Upsert assignment',
    body: 'DO UPDATE is the reflex here and it is wrong twice over. It takes a row-level write lock on the conflicting row, so every worker ingesting the same assignment would serialize on one row for the length of its transaction, precisely the case a large batch hits constantly. And it would write the values being inserted, including the label, which is set to the raw assignment id string from the manifest and which staff rename by hand through the assignments API. Every subsequent submission would quietly reset a name the course had chosen.\n\nDO NOTHING returns no row on conflict, so the fallback SELECT is not optional: it is how the id gets read back on the common path where the assignment already exists. A fallback that then finds nothing is treated as an internal error rather than retried: there is no consistent state in which the conflict fired and the row is absent, and inventing a second assignment row would split the cohort in two.',
    links: [
      {
        label: 'create-submission.ts',
        href: `${GH}/packages/server/src/services/ingest/create-submission.ts`,
      },
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
    ],
  },
  ver: {
    title: 'Allocate version_index',
    body: 'The new index is one above the highest existing version for this (semester, assignment, version_owner_key) LINEAGE, read under a raw SELECT … FOR UPDATE. It is raw SQL for a mundane reason (Drizzle exposes no typed forUpdate() on select) but the lock is the interesting part: it serializes only the workers that genuinely collide on one lineage’s assignment, leaving the rest of a batch fully parallel. A coarser lock would turn a cohort import into a queue.\n\nThe lineage, rather than the student, is what makes this survive migration 0029 making student_id nullable. WHERE student_id = NULL is never true, so scoping the lock on the student column would have selected ZERO rows for a group submission: maxVersion stays 0, every resubmission is allocated version 1 for ever, supersededIds is always empty, and the supersede chain never forms — with no error anywhere. version_owner_key is NOT NULL and GENERATED by Postgres from (student_id, group_key), so the predicate is total and no caller can spell it wrongly.\n\nA row lock covers rows that exist, so a lineage’s very first submission has nothing to lock; the unique constraint on (semester, assignment, version_owner_key, version_index) is the backstop for that case and aborts the loser rather than allowing two version 1s. Allocation is also where superseding is decided: every row the lock returned has its superseded pointer set to the new submission, which is what keeps the cohort list to one current version per lineage while every earlier version stays readable.',
    links: [
      {
        label: 'create-submission.ts',
        href: `${GH}/packages/server/src/services/ingest/create-submission.ts`,
      },
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
    ],
  },
  mv: {
    title: 'Move blob',
    body: 'There is never a full bundle at rest under a submission key. The staged object is read, stripped in memory, and only the stripped bytes are written to the final key, so stripping is not something applied afterwards to a stored archive, and no window exists in which the student’s source sits at its permanent location. The bytes are buffered before the write so a streaming connection is not held open across the database insert.\n\nThe staging copy is deleted last and best-effort. If that delete fails the submission is already correct and the staged object is left behind; a failure of the write itself is a different thing entirely: it throws, the transaction rolls back, and no submission row is ever created. Blob operations cannot join a database transaction, so the ordering is chosen to make the survivable failure the one that costs storage rather than consistency.',
    links: [
      {
        label: 'create-submission.ts',
        href: `${GH}/packages/server/src/services/ingest/create-submission.ts`,
      },
      { label: 'keys.ts', href: `${GH}/packages/server/src/services/storage/keys.ts` },
    ],
  },
  strip: {
    title: 'Strip student source',
    body: 'What survives is exactly the seal plus every .slog and .slog.meta; everything else is dropped. The seal is whichever shape the bundle carries: manifest.json and manifest.sig for a classic sealed upload, or the per-session manifest-<session_id>.json and .sig pair for a git submission sealed by the recorder as the student works. Both are copied verbatim and never rewritten: they still list submission files that are no longer in the archive, and that is correct, because the signature is over the manifest, not over the zip. Entry order and timestamps in the output are fixed so the stripped bytes are reproducible.\n\nThe rolling pair has to be named explicitly here, and the pattern comes from log-core rather than being re-spelled locally. A git-submitted bundle has no manifest.json at all, so an allowlist that names only the classic pair deletes the one thing sealing it — leaving a stored blob the loader rejects outright and that can never be re-verified. The same pattern is what keeps a decoy like manifest-notes.json from being mistaken for a seal and kept.\n\nThis can only happen after every computation that reads source, and there is precisely one: check 8’s tamper sub-check, which hashes the submitted bytes against the manifest’s claim about them. Statistics, replay, file reconstruction and all eighteen heuristics derive content from the event stream instead, which is why a stripped bundle stays fully usable for everything except that one question, and why storage against a fixed quota stays flat as cohorts grow.',
    invariant:
      'Stripping runs after all in-memory computation and never touches a signed manifest — classic manifest.json/manifest.sig or rolling manifest-<session_id>.json/.sig. The stored bundle must remain signature- and chain-verifiable.',
    links: [
      {
        label: 'strip-bundle.ts',
        href: `${GH}/packages/server/src/services/ingest/strip-bundle.ts`,
      },
      { label: 'zip-writer.ts', href: `${GH}/packages/server/src/services/ingest/zip-writer.ts` },
    ],
  },
  ins: {
    title: 'Insert the derived rows',
    body: 'The cluster draws one transaction; there are two. The submission row, its version allocation and the blob move commit in their own transaction, and the per-file statistics, the validation result, the flags and the ingest file’s status transition are written afterwards in a second one. Merging them would mean holding the blob write open across the whole analysis, which is the longest part of the job.\n\nThe split shows when the second transaction fails: the submission row exists and stays, the derived rows do not, and the ingest file is marked failed with the phase that broke (compute_stats, run_validation or run_heuristics), so the failure is attributable rather than generic. The worker deliberately does not re-throw for a retry at that point, because the staging blob has already been deleted and there is nothing left to re-parse.',
    invariant:
      'Only failures before the submission row exists are retried. Past that point the staging blob is gone, and the file is settled as failed rather than replayed.',
    links: [
      { label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` },
      {
        label: 'create-submission.ts',
        href: `${GH}/packages/server/src/services/ingest/create-submission.ts`,
      },
    ],
  },
  lock: {
    title: 'The advisory locks',
    body: 'Transaction-scoped pg_advisory_xact_locks taken before the submission is created, with the dedup check RE-RUN inside each. There are two of them now, mirroring phase 2’s two keys: one on (semester_id, blob_sha256) and, only when the file carries a declared group, a second on (semester_id, "group:" + source_group_key), each followed by its own re-check SELECT. They are always taken in that order — blob, then group — so two writers can never hold them crosswise and deadlock, and a file with no group key takes exactly the one lock it always took and behaves identically. The whole arrangement exists because of a defect that every serial test in the repo passed over.\n\nDedup and submission creation are separate transactions, and the worker drains its pg-boss batch with Promise.all up to the configured concurrency. Two co-submitters carry byte-identical bundles, so both cleared dedup before either committed, and both created a submission — reinstating the exact per-student fan-out that migration 0029 had just removed. Serial execution looked perfect. The key is the same one dedup uses, so it serialises only the writers that genuinely collide on one artifact and nothing else waits.\n\nThe test that should have caught it was PASSING, and that is the more useful lesson. A Gradescope end-to-end test asserts the OLD shape — three submissions for two co-submitters sharing one blob — and it kept passing after the cut-over. A green test asserting the behaviour you just removed is a report that your change is inert. When a change is meant to alter behaviour, find the test that asserts the old behaviour and make sure it FAILS; if nothing fails, the change is either untested or inert, and from the outside those are indistinguishable.\n\nThe fix then exposed a second concurrency defect behind the same green test: the contributor store pruned "any row not in my set", which DELETED the partner who had just attached concurrently. It now prunes only attributed rows — those are derived wholly from the bundle and it is their sole author — while a roster row is a fact asserted by the roster side and is not its to remove.\n\nA duplicate detected inside either lock is not an error. createSubmission returns a discriminated outcome and the duplicate arm is handled exactly as a phase-2 dedup hit: attach the co-submitter, do not create a row.',
    invariant:
      'One artifact, many submitters — identified by the declared group first and by identical bytes second. Two workers may race for it; exactly one may create it.',
    links: [
      {
        label: 'create-submission.ts',
        href: `${GH}/packages/server/src/services/ingest/create-submission.ts`,
      },
      { label: 'dedup.ts', href: `${GH}/packages/server/src/services/ingest/dedup.ts` },
    ],
  },
  contrib: {
    title: 'The contributor stage',
    body: 'The last thing inside the per-submission transaction, on all three write paths — ingest, recompute and manual attach — through one finalizeContributors, so the three cannot drift. It resolves the bundle’s contributors, writes one row per person, attributes flags, and applies the per-contributor scores.\n\nIt runs AFTER heuristics, and that ordering is the load-bearing decision. establishBundleContributors MUTATES the bundle and several heuristics read that stamp, and the ingest path has never stamped it — so stamping earlier would change which flags an ingest produces for any bundle carrying identity. That is a change to product behaviour, not to plumbing, so flag CONTENT is provably untouched by the cut-over.\n\nThe consequence is noticed and deliberately not resolved here: ingest-time heuristics run on an UNSTAMPED bundle while recompute-time ones, which go through loadSubmissionIndex, run on a stamped one, so the two can produce different flags for the same bundle. It is pre-existing rather than introduced, and it is worth a decision of its own. Concretely it means the contributor-gated behaviour — segmented reconstruction, external-change reclassification, the overlap suppression — sees every session as unattributed at ingest, so at ingest only a manifest that declares itself a group scope reaches those paths.\n\nThe divergence now has a measured size rather than being left as "the two can differ", because contributor-scope-boundary.test.ts runs the same events twice — once stamped, once not — over a two-partner bundle in which Bob writes the implementation, commits it, and Alice pulls it. Stamped, EIGHT named heuristics produce zero flags between them: low_typing_high_output, paste_is_solution, time_to_first_save_anomaly, idle_then_complete, mass_external_replacement, external_edits, terminal_active_during_external_change and inter_session_external_change. Unstamped, every one of the eight fires. That is the honest scale of the asymmetry, and it is also the control the "zero flags on honest pair work" assertions need: without the unstamped run the zero could just as easily be a dead fixture as a working gate. Unstamped is not an exotic state either — it is the ordinary condition of a 1.x bundle, of a pair where one partner never enrolled, and of a deployment with no root key, in all of which compareContributors answers unknown and every gate fails open by design.\n\nWhat gets a row is one row per PERSON: the roster side (the submitter of record) and the bundle side (grouped on verified student_ref) reconciled onto one, so a co-submitter arriving from both sources is one human and not two. What gets NO row is unattributed and unverifiable sessions, each of which analysis-core deliberately gives a singleton key: a row per session would turn an ordinary five-session solo bundle into five apparent contributors, and promoting an unverifiable block — which NAMES someone — is exactly how a forged identity would launder work onto the student it names.',
    invariant:
      'After heuristics, always. Stamping earlier changes which flags an ingest produces, which is a product decision and not an ordering one.',
    links: [
      {
        label: 'finalize.ts',
        href: `${GH}/packages/server/src/services/contributors/finalize.ts`,
      },
      { label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` },
      {
        label: 'contributor-scope-boundary.test.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/contributor-scope-boundary.test.ts`,
      },
    ],
  },
  fail: {
    title: 'Rollback',
    body: 'This branch settles a file, not a job. The failure is not a transient database fault, so the worker does not re-throw for a queue retry: it marks that one row failed, its siblings continue, and the job finalizes as partial. The other route exists too: a transient fault before the submission was created leaves the row pending and re-throws, so the queue retries it with exponential backoff rather than burning a submission on a momentarily exhausted connection pool.\n\nThe rollback undoes the database side cleanly and the staged object under the ingest-staging prefix is what is left behind. Treating that as non-fatal is the deliberate part: an orphaned blob costs storage, whereas a half-created submission costs trust in every number derived from it.',
    links: [
      { label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` },
      {
        label: 'transient-error.ts',
        href: `${GH}/packages/server/src/db/transient-error.ts`,
      },
    ],
  },

  // ── Stage 4 · cross ───────────────────────────────────────────────────────
  xf: {
    title: 'Cohort-wide correlation',
    body: 'A cross-submission comparison is only meaningful across a cohort, so it cannot belong to any one file’s job. Finalization enqueues a single semester-scoped job whose singleton key is the semester, which collapses a hundred files finishing at once into one recomputation, and the job takes a transaction-scoped advisory lock on the semester so two of them can never interleave over the same rows.\n\nIt runs over compact features rather than bundles. Each non-superseded submission is re-parsed one at a time and reduced to its paste records plus a bounded n-gram fingerprint of its event-kind stream; holding full bundles and indices for a whole semester at once exhausted the worker. A semester with fewer than two submissions still runs the replace, so that a cohort which has shrunk has its stale cross-flags cleared rather than left standing.',
    links: [
      { label: 'run-cross.ts', href: `${GH}/packages/server/src/services/heuristics/run-cross.ts` },
      {
        label: 'recompute-cross-flags.ts',
        href: `${GH}/packages/server/src/jobs/recompute-cross-flags.ts`,
      },
    ],
  },
  xp: {
    title: 'cross_flags + participants',
    body: 'Cross-flags are semester-scoped and replaced wholesale: each run deletes the semester’s rows and re-inserts, with participants removed by cascade. Merging would be wrong on both counts: a later run can legitimately produce fewer flags, because a submission was superseded or a student left, and a flag whose membership grows with the cohort has no stable identity to merge on in the first place.\n\nParticipants are the join back to submissions. Each carries its own supporting event references as chronological indices, translated from the (session, seq) keys the heuristics emit through a map built during feature extraction, so the analyzer can jump straight to the events on both sides of a match rather than to the flag as a whole. The bundle ids the cross heuristics reason with are synthetic and exist only for the duration of a run.',
    links: [
      { label: 'run-cross.ts', href: `${GH}/packages/server/src/services/heuristics/run-cross.ts` },
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
    ],
  },

  done: {
    title: 'Cohort is ready',
    body: 'Idempotent here is an assembled property, not a single mechanism. It comes from four separate things: a status guard that skips any ingest file already resolved, upserts for the statistics and validation rows, a version allocation serialized by a row lock, and, for flags (which have no natural unique key and are inserted plainly), the fact that their transaction has not committed when a retry happens. Callers outside that transaction have to delete a submission’s flags first, and the recompute path does exactly that.\n\nWhat a retry guarantees, then, is that the same bundle yields the same rows, not that every stage is individually replayable: past the point where the submission exists, the file is not retried at all. Finalization is idempotent in the plainer sense: it refuses to recompute a job already in a terminal state, and a cancelled job keeps its status while its summary is refreshed so the counts from a cooperative cancel are still visible. Both of its writes set status, completed_at and summary and nothing else, which is what keeps the scope-resolution skip reasons on the job row alive: they were recorded before staging completed, they cannot be rebuilt from ingest_files because a skipped scope has no row there, and resetting them to empty on the way out would erase the only record those scopes ever existed.',
    links: [
      { label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` },
      { label: 'job-control.ts', href: `${GH}/packages/server/src/services/ingest/job-control.ts` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [];
