import type { ArchNode } from '../types.js';
import { GH, GH_PROVGATE } from './links.js';

/** Nodes in the `ingest` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Entry ─────────────────────────────────────────────────────────────────
  e_http: {
    title: 'HTTP upload',
    body: 'The single-request route never holds the body in memory. The archive field is streamed straight to a temp file and the on-disk path is handed to the same reader the CLI uses, so the ceiling is disk and INGEST_MAX_UPLOAD_BYTES rather than the roughly 2 GiB that multipart/FormData parsing imposes. A Content-Length above the cap is refused before a byte is read.\n\nThe point at which the browser switches to the chunked path is not really a judgement about size: it is pinned to exactly one chunk, 16 MiB. The deployment sits behind an nginx whose client_max_body_size is around 20 MiB, so any single request carrying more than one part is rejected before it reaches the app. Splitting at one chunk guarantees that neither a part PUT nor a single-shot POST can ever exceed that limit. Part state lives in the S3/MinIO multipart upload rather than in a server-side table, so a resume works across API processes and across restarts.',
    links: [
      {
        label: 'resumable-upload.ts (client)',
        href: `${GH}/packages/analyzer/src/api/resumable-upload.ts`,
      },
      {
        label: 'stream-upload.ts',
        href: `${GH}/packages/server/src/services/ingest/stream-upload.ts`,
      },
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
  fanout: {
    title: 'Fan out',
    body: 'The unit is an assignment scope times a submitter, not a folder. A folder is walked for every .provenance/ at any depth, and each one is synthesized into its own flat bundle carrying that directory’s own relative paths, so a cloned 61B repo holding proj2/ and lab5/ becomes two independent submissions rather than one unusable archive. Scopes are self-identifying — the manifest carries assignment_id and semester — so nothing has to be told where to look. What ingest_scope adds is a DECLARED SUBMISSION TYPE for the batch: self_identifying (the default) accepts every sealed scope; bundle_zip demands exactly one scope at the tree root; repo_whole keeps only the repo root and excludes nested scopes rather than fanning them out; repo_scoped selects scopes by path_glob. The declaration comes from the assignment row or, beating it, from a per-request override on the ingest call — the override is simply a resolver that ignores its assignment key, so nothing below the entry point knows which of the two it got.\n\nThat declaration is what makes a batch checkable for homogeneity. A submission whose shape does not match fails as submission_type_mismatch, and so does a repo_scoped glob that selects nothing — otherwise a typo’d glob drops a whole cohort while the ingest reports success. The failure is per SUBMISSION, never per batch: the export is streamed folder by folder and staged incrementally with no transaction spanning it, and rows are never deleted, so aborting mid-batch would strand a half-ingested one with no way back. A heterogeneous batch therefore shows up as a pile of these entries in the same skipped array as no_seal and scope_excluded — the existing channel, not a new one. A scope counts as sealed by either shape: the classic manifest.json, or the per-session manifest-<session_id>.json the recorder rewrites on every checkpoint, which is the only seal a git submission ever has. Recognising just the classic name here discarded every rolling-sealed scope as no_seal and made git submission produce nothing at all. no_seal now means a .provenance/ that genuinely nothing signs, and it is still reported against its scope rather than dropped. Then each scope’s bundle is shared by every co-submitter of a group submission, and each of them gets their own ingest_files row, their own queued job and their own submission, which is also why the Gradescope path has to narrow its dedup key by student. The rebuild that produces those bytes is byte-deterministic, because its sha256 is what dedup keys on — and a flat folder with a single root .provenance/ still yields exactly one scope with byte-identical entries, so the classic Gradescope path is unmoved.\n\n"Bounded" is two independent limits. The stager keeps at most INGEST_STAGE_CONCURRENCY per-bundle tasks in flight (default 1, exactly serial) with backpressure, so the producer cannot run ahead of the writers; the worker separately claims batches of INGEST_CONCURRENCY files. "Cancellable" is cooperative: cancelling does not remove queued jobs from pg-boss, it sets ingest_jobs.status, which every file job re-reads before doing any work and then marks its still-pending row discarded. One gate covers queued, in-flight and restart-replayed jobs alike.',
    invariant:
      'A job is never finalized while staging_complete is false. During streaming staging, a momentarily-empty pending count must not settle the job.',
    links: [
      { label: 'local-path.ts', href: `${GH}/packages/server/src/services/ingest/local-path.ts` },
      {
        label: 'repo-scopes.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/repo-scopes.ts`,
      },
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
    title: 'Content-hash dedup',
    body: 'One indexed lookup, taken before the blob is unzipped, before the roster is touched and before any analysis runs. The ordering is the whole point: a re-send costs an index probe rather than a full parse plus eight checks plus eighteen heuristics, which is what allows every upstream sender (a gateway, a staff member re-uploading, a retried job) to be sloppy about what it has already delivered.\n\nThe key is not always the pair on the label. Files that arrived with a match hint, which is the Gradescope path, dedup on (semester, student, blob) instead: two co-submitters of one group submission legitimately share identical bytes, and a blob-only key would collapse the second of them into a duplicate and lose a student’s submission. The plain upload path cannot narrow that way, because dedup deliberately runs before the student is known.',
    invariant:
      'Dedup precedes parse, match and analysis. Nothing expensive may be moved in front of it.',
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
    body: 'The new index is one above the highest existing version for this (semester, assignment, student) cohort, read under a raw SELECT … FOR UPDATE. It is raw SQL for a mundane reason (Drizzle exposes no typed forUpdate() on select) but the lock is the interesting part: it serializes only the workers that genuinely collide on one student’s assignment, leaving the rest of a batch fully parallel. A coarser lock would turn a cohort import into a queue.\n\nA row lock covers rows that exist, so a student’s very first submission has nothing to lock; the unique constraint on (semester, assignment, student, version_index) is the backstop for that case and aborts the loser rather than allowing two version 1s. Allocation is also where superseding is decided: every row the lock returned has its superseded pointer set to the new submission, which is what keeps the cohort list to one current version per student while every earlier version stays readable.',
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
    body: 'Idempotent here is an assembled property, not a single mechanism. It comes from four separate things: a status guard that skips any ingest file already resolved, upserts for the statistics and validation rows, a version allocation serialized by a row lock, and, for flags (which have no natural unique key and are inserted plainly), the fact that their transaction has not committed when a retry happens. Callers outside that transaction have to delete a submission’s flags first, and the recompute path does exactly that.\n\nWhat a retry guarantees, then, is that the same bundle yields the same rows, not that every stage is individually replayable: past the point where the submission exists, the file is not retried at all. Finalization is idempotent in the plainer sense: it refuses to recompute a job already in a terminal state, and a cancelled job keeps its status while its summary is refreshed so the counts from a cooperative cancel are still visible.',
    links: [
      { label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` },
      { label: 'job-control.ts', href: `${GH}/packages/server/src/services/ingest/job-control.ts` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [];
