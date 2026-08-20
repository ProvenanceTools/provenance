import type { ArchNode } from '../types.js';
import { GH, GH_PROVGATE } from './links.js';

/** Nodes in the `master` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Lane 1 · student machine ──────────────────────────────────────────────
  edt: {
    title: 'The editor recorders',
    body: 'Three independent recorders exist: a VS Code extension, a JetBrains plugin, a Neovim plugin. The host layer is the only part of them that differs. The envelope, the JCS canonicalization and the chaining rule are reimplemented per language against the same pinned test vectors, because what the analyzer consumes is the log format, not any particular codebase.\n\nThe consequence shows up in the extension allowlist, which is deliberately producer-agnostic: extension_hash is a sha256 over the recorder’s installed file tree, taken by walking sorted relative paths and hashing "<path>\\0<bytes>" per file. A .vsix, a JetBrains plugin zip and a Neovim plugin’s lua/ tree therefore all produce hashes of the same kind and live in the same list. A recorder absent from that list does not fail. It raises a medium-severity flag, because a mismatch is as likely to mean "staff have not published the new build’s hash yet" as it is to mean a modified recorder.',
    links: [
      {
        label: 'known-good-extension-hashes.json',
        href: `${GH}/packages/analysis-core/src/heuristics/config/known-good-extension-hashes.json`,
      },
      {
        label: 'extension-hash.ts',
        href: `${GH}/packages/recorder/src/commands/extension-hash.ts`,
      },
    ],
  },
  gate: {
    title: 'Is this folder an assignment?',
    body: 'The editor loads the recorder at all only because a workspace contains a file named .provenance-manifest or provenance-manifest at any depth. That is a filename match, which anyone can satisfy; the gate that matters is the next one, a walk of the trust chain — the root public key compiled into the recorder’s own source verifies the course_cert travelling inside the manifest, and that certificate’s course key verifies the manifest payload. Only course staff can produce a manifest the recorder will act on, and one recorder build now serves every course.\n\nEverything downstream in this diagram (the log, the bundle, the server, the flags) exists only past this diamond. That is why the failure branch is silent rather than an error dialog: a student who installs the recorder and then opens an unrelated project must see and pay nothing, and someone editing a manifest must not be told which of their attempts got the format right.',
    invariant:
      'No verified, course-signed manifest means no session, no files, and no UI. Presence of the filename alone is never enough.',
    links: [
      {
        label: 'manifest-loader.ts',
        href: `${GH}/packages/recorder/src/activation/manifest-loader.ts`,
      },
      { label: 'Recorder PRD §4.1', href: `${GH}/docs/prd.md` },
    ],
  },
  dorm: {
    title: 'Dormant · nothing is recorded',
    body: '"Nothing is recorded" is meant literally, not as a summary. In a folder with no verifying manifest the recorder creates no .provenance/ directory, opens no log file, registers no document listeners and starts no timers. There is no local buffer that would be flushed later and nothing to purge afterwards, because nothing was ever produced.\n\nThis is the property that makes the recorder installable on a student’s own machine rather than a lab image. The tool is inert everywhere except inside a folder the course has signed, so "does it watch my other projects?" has an answer that can be checked by reading the source rather than trusted.',
    links: [{ label: 'extension.ts', href: `${GH}/packages/recorder/src/extension.ts` }],
  },
  sstart: {
    title: 'session.start',
    body: 'Each session generates a fresh ed25519 keypair and writes session.start as entry seq 0. The payload carries the session UUID, the assignment and semester, a machine id, the session public key, a host block naming the editor, its version, its build and the platform — and, at 2.0, the entire signed manifest: the course-signed payload, its signature, and the root-signed certificate. Carrying the whole document rather than only its signature is what lets the analyzer re-walk the trust chain offline, and it is how the capture policy in force reaches analysis at all. The private key is never written in the clear: it is encrypted with XChaCha20-Poly1305 under a key derived by HKDF-SHA256 from the manifest’s own signature, and only the ciphertext reaches the .slog.meta sidecar.\n\nBinding to the manifest signature is what makes the key assignment-specific rather than merely secret: recovering it requires the course manifest for that assignment, so a log lifted from one assignment cannot be re-signed into another. The signature itself is also copied into the payload, which is what lets validation check 2 assert that every session in a bundle was started against the same assignment manifest. The machine id runs the other way: it is salted with the session UUID, so it identifies "same machine within this session" without becoming a stable identifier that could be correlated across assignments.',
    links: [
      {
        label: 'session-keys.ts',
        href: `${GH}/packages/log-core/src/session-keys.ts`,
      },
      {
        label: 'recorder-context.ts',
        href: `${GH}/packages/recorder/src/session/recorder-context.ts`,
      },
    ],
  },
  sig: {
    title: 'Signal capture',
    body: 'The recorder records document opens, changes, saves and closes, selection and focus changes, pastes, external file changes, terminal commands, git state changes, periodic extension snapshots and heartbeats, for any file inside the assignment root, not only the files under review. The narrower list matters in one place only: the expected-content model and its file watchers cover files_under_review, because those are the files whose external modification is evidence.\n\nSome of that list is now a course’s to narrow. The manifest carries a signed capture policy, and the recorder checks it at a single choke point inside emit, so a course can switch off selection changes, focus changes or terminal capture and lengthen the heartbeat cadence. It cannot go further: every other kind here is on a hard floor that the policy schema has no key to express, because reconstruction, validation and the exculpatory heuristics depend on them.\n\nWhat is excluded outright is as deliberate as what is included. Documents outside the assignment root are dropped, non-file URI schemes (untitled buffers, output panels, git overlays) are dropped, and the recorder’s own artefacts (everything under .provenance/ and the activation manifest) are dropped. That last exclusion is not tidiness: a student opening the live log would otherwise trigger a feedback loop in which each append re-enters as a document change and appends again.\n\nOne kind in the vocabulary is not produced by any recorder yet. peer.observed records that a foreign .provenance/ log was seen in the working tree — its filename, byte digest, and the foreign chain\u2019s highest seq and final hash — written into the observing session\u2019s own signed chain. It is how deleting a partner\u2019s log leaves evidence that it existed, and it is the only thing that can tell a rolling seal whose log was never pushed from one whose log was removed. Note it does not contradict the .provenance/ exclusion above: that rule drops the directory as DOCUMENT content, while a witness reads a foreign file\u2019s bytes to hash them and never re-enters as an edit. The readers landed first, deliberately \u2014 the type, the narrowing, the conformance vectors and the reconciliation \u2014 and the directory watcher in the three recorders lands after them, which is the migration ordering the format rule requires.',
    links: [
      { label: 'doc-wiring.ts', href: `${GH}/packages/recorder/src/wiring/doc-wiring.ts` },
      { label: 'Recorder PRD §4.2', href: `${GH}/docs/prd.md` },
    ],
  },
  chain: {
    title: 'Hash chain',
    body: 'Every log entry is linked to its predecessor by a SHA-256 hash taken over the previous entry’s hash concatenated with the JCS-canonical form of this entry. Editing any entry after the fact breaks every link after it, and the break is locatable to an exact sequence number.\n\nThere is exactly one chaining function per language implementation, and every code path that produces a log entry goes through it. Two chaining paths would mean two behaviours, and therefore a seam to exploit.',
    invariant:
      'Exactly one chaining function. Every log-producing path goes through it, in all four repositories.',
    links: [
      { label: 'hash-chain.ts', href: `${GH}/packages/log-core/src/hash-chain.ts` },
      { label: 'Recorder PRD §5.2', href: `${GH}/docs/prd.md` },
    ],
  },
  slog: {
    title: 'The .slog file',
    body: 'One session writes one file, named session-<uuid>.slog, opened in append mode and never rewritten. Newline-delimited JSON is the format because it degrades well: a crash or a full disk truncates the last line and costs one entry, whereas a single JSON array would leave a file that no parser accepts at all.\n\nAppend-only is a property of the whole system, not just of this file. There is no update and no delete anywhere in the log path, so a session that went wrong is corrected by writing more entries, never by editing earlier ones. The parser reflects that: it validates each line’s shape but deliberately accepts unknown event kinds, so a newer recorder’s logs stay readable by an older analyzer.',
    invariant: 'Append-only. No code path anywhere updates or deletes a log entry.',
    links: [
      { label: 'ndjson.ts', href: `${GH}/packages/log-core/src/ndjson.ts` },
      { label: 'session-writer.ts', href: `${GH}/packages/recorder/src/io/session-writer.ts` },
    ],
  },
  ckpt: {
    title: 'Signed checkpoint',
    body: 'Every hundredth entry, the recorder signs canonicalize({hash, seq}) with the session private key and appends the result to the .slog.meta sidecar. The chain already makes tampering detectable; a checkpoint is what makes a range of the chain attributable: it proves those entries were produced by the holder of a key that is itself bound to the course manifest.\n\nThe interval exists because sessions end badly more often than they end cleanly. A signature computed only at seal time would leave a log that crashed at minute forty with no signature at all; checkpointing means everything up to the last multiple of a hundred stays provable no matter how the process died. Signing is deliberately off the hot path: entries are hashed synchronously and the checkpoint signature is chained onto a pending promise that teardown drains, so an ed25519 operation never blocks an editor event handler.\n\nA checkpoint now does a second thing: it rewrites the ROLLING SEAL. A git-submitted assignment never runs seal — the student pushes, the grader clones — so the seal moves off the submission event and onto the recording. Immediately after the checkpoint lands in the sidecar, the recorder rewrites .provenance/manifest-<session_id>.json and its .sig: a format_version 1.2 bundle manifest covering exactly that one session, signed by that session’s own key. It is written once at session start too, so a session that never reaches a hundred entries is still sealed, and once more at teardown over the fully flushed log. Whatever is committed to git is therefore always a valid seal of that moment.',
    links: [
      {
        label: 'checkpoint-signer.ts',
        href: `${GH}/packages/log-core/src/checkpoint-signer.ts`,
      },
      {
        label: 'session-registry.ts',
        href: `${GH}/packages/recorder/src/session/session-registry.ts`,
      },
    ],
  },
  seal: {
    title: 'Seal',
    body: 'Sealing hashes every log in the assignment’s .provenance/ directory, records the final on-disk sha256 of every file under review (including the ones that turned out to be missing), signs the resulting manifest with the session key, and writes manifest.json and manifest.sig atomically over exactly the canonical bytes that were signed.\n\nIt never refuses. A chain that fails validation or a log that will not parse becomes a warning in the manifest and a message to the student, and the bundle is written regardless. A student whose recording was interrupted must still be able to submit, and integrity evidence is far more useful to staff inside a bundle than withheld from one. Quarantined .corrupt- files are the single exception to "everything in the directory": they are excluded from the zip, while the recorder.recovered_from_corruption event in the log still records that they existed.\n\nBecause the zip is everything in the directory, and the directory now also holds a rolling seal per session, a classically sealed bundle carries BOTH shapes. manifest.json and manifest.sig are unchanged to the byte — a rolling manifest is neither a session nor a submission file, so it contributes nothing to what the classic manifest says — and the classic manifest still wins as the bundle’s manifest on the read side. The rolling seals travel alongside it and are verified alongside it: check 1 requires both, and neither is allowed to excuse the other.',
    invariant:
      'Sealing never aborts on a broken chain. Tampering is surfaced by the analyzer’s checks, not by refusing to produce a bundle.',
    links: [
      { label: 'seal.ts', href: `${GH}/packages/recorder/src/commands/seal.ts` },
      { label: 'bundle-sign.ts', href: `${GH}/packages/log-core/src/bundle-sign.ts` },
    ],
  },
  bundle: {
    title: 'The bundle .zip',
    body: 'This is the only artefact that ever leaves the student’s machine, and it is a snapshot rather than a stream: the session keeps recording after the zip is written, and sealing again produces another one. Nothing is uploaded in the background, and there is no channel from the recorder to any server at any point.\n\nThe student’s source travels inside it, at the zip root, mirroring the workspace layout. That is required at this stage: validation check 8 compares the submitted bytes against the last on-disk hash the recorder observed, and it can only do that with the bytes present. The server strips them immediately after that comparison, so source lives in this artefact and in the ingest process’s memory, and nowhere else.',
    links: [
      { label: 'Recorder PRD §5.3', href: `${GH}/docs/prd.md` },
      { label: 'seal.ts', href: `${GH}/packages/recorder/src/commands/seal.ts` },
    ],
  },

  // ── Lane 2 · transport ────────────────────────────────────────────────────
  gs: {
    title: 'Gradescope',
    body: 'Gradescope unzips whatever a student uploads. A bundle submitted there does not survive as a .zip. It arrives in the staff export as a folder of loose files per submission, under one top-level directory alongside a submission_metadata.yml that names the submitters.\n\nThat is why the server cannot forward what Gradescope hands it unchanged. The Gradescope ingest path locates the metadata, rebuilds a flat bundle zip from each submission folder, and stages one ingest row per submitter, which is also how group submissions produce one submission per co-submitter from a single set of bytes. The rebuild is byte-deterministic, because the rebuilt archive’s sha256 is what dedup keys on.',
    links: [
      {
        label: 'parse-export.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/parse-export.ts`,
      },
      {
        label: 'build-bundle-zip.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/build-bundle-zip.ts`,
      },
    ],
  },
  pgate: {
    title: 'provgate',
    body: 'provgate is a separate Python service, not a workspace in this repo. It is a pure HTTP client of the public API (it logs into Gradescope, pulls each configured course’s bulk export on a schedule, prunes it, and POSTs the delta), so adding it required no change to the server at all.\n\nIts per-assignment watermark is an optimisation and nothing more. If the watermark is stale, wrong, or lost, the only consequence is that provgate forwards submissions the server has already seen, and content-hash dedup discards them for the cost of one indexed lookup. Correctness therefore lives on the server side, which is the right place for it: a sync gateway that has to be right about what it has already sent is a gateway that silently drops submissions when it is wrong.',
    links: [
      { label: 'provgate README', href: `${GH_PROVGATE}/README.md` },
      { label: 'prune.py', href: `${GH_PROVGATE}/src/provgate/sync/prune.py` },
    ],
  },
  prune: {
    title: 'Prune to delta',
    body: 'Pruning rewrites the export archive to contain only the submission folders that have not been forwarded yet. submission_metadata.yml is copied through verbatim, never regenerated and never filtered to match, because Gradescope constructs the metadata keys from the same folder names, and a rewritten metadata file is a second source of truth that can disagree with the first.\n\nThe result is that a pruned export is still a valid Gradescope export as far as the server is concerned, and the server needs no notion of "this one came from a gateway". Entries that are only archive noise (__MACOSX/, .DS_Store) are dropped on the way through.',
    links: [{ label: 'prune.py', href: `${GH_PROVGATE}/src/provgate/sync/prune.py` }],
  },
  upl: {
    title: 'Staff upload',
    body: 'The direct upload path never buffers a body in memory. A single-request upload is streamed straight to a temp file and handed to the same streaming ingest the local-path CLI uses, so the ceiling is disk, not the roughly 2 GiB that multipart form parsing imposes.\n\nAbove a threshold the browser switches to the chunked path, which is backed by an S3/MinIO multipart upload. Part state therefore lives in object storage rather than server memory, which is what makes it correct across several API processes behind a load balancer and durable across restarts; an interrupted upload resumes by listing the parts already received and re-sending only the gaps. There is no server-side upload session table: the (semester, upload id) pair derives the storage key, and every chunk request is re-authorized against the semester.',
    links: [
      {
        label: 'resumable-upload.ts (server)',
        href: `${GH}/packages/server/src/services/ingest/resumable-upload.ts`,
      },
      {
        label: 'resumable-upload.ts (client)',
        href: `${GH}/packages/analyzer/src/api/resumable-upload.ts`,
      },
    ],
  },
  local: {
    title: '/local · offline mode',
    body: 'The /local routes load a bundle from a dropped .zip and run the identical analysis-core build the server runs (the same loader, the same eight checks, the same eighteen heuristics) entirely inside the browser tab. Nothing is uploaded, no submission row is created, and the analysis leaves no trace anywhere. It is what makes a single bundle reviewable without provisioning any infrastructure at all.\n\nIt is nonetheless staff-gated: the /local subtree sits behind the same login and staff check as the rest of the app. Offline analysis is a deployment property, not an authorization one, and a page that renders a student’s source and flags should not be reachable by anyone with the URL.',
    links: [
      { label: 'LocalShell.tsx', href: `${GH}/packages/analyzer/src/views/local/LocalShell.tsx` },
      { label: 'analysis-core', href: `${GH}/packages/analysis-core/src/index.ts` },
    ],
  },

  // ── Lane 3 · server ───────────────────────────────────────────────────────
  api: {
    title: 'Hono API',
    body: 'Two principal types reach the API. Interactive users authenticate through Google OAuth, and the callback rejects any identity whose ID token lacks an hd claim matching the configured hosted domains. The check is on the verified token, not the login hint sent to Google’s account picker, and it is the single thing keeping the analyzer to one institution. Machine clients use API tokens: only an 8-character prefix and an argon2id hash are stored, the secret is displayed once, and each token carries scopes for read-only, permitted semesters, and blob access.\n\nRate limiting is per principal and per route class, with a token bucket held in Postgres in production so the limit is shared across API processes rather than per-instance. Every route is authorized against the specific semester in its path, so a token scoped to one course cannot read another even when the caller is otherwise legitimate.',
    invariant:
      'Authentication succeeds only when the verified Google ID token’s hd claim is in AUTH_ALLOWED_HOSTED_DOMAINS.',
    links: [
      { label: 'auth.ts', href: `${GH}/packages/server/src/api/v1/routes/auth.ts` },
      { label: 'tokens.ts', href: `${GH}/packages/server/src/auth/tokens.ts` },
      {
        label: 'rate-limit-pg.ts',
        href: `${GH}/packages/server/src/api/middleware/rate-limit-pg.ts`,
      },
    ],
  },
  dedup: {
    title: 'Content-hash dedup',
    body: 'Before any heavy processing, ingest rejects a bundle whose (semester_id, blob_sha256) pair it has already seen. Because this check is cheap and happens first, re-sending an unchanged bundle costs almost nothing.\n\nThat property is what lets provgate treat its watermark as an optimisation rather than a correctness mechanism: if the watermark is wrong, dedup still prevents duplicate submissions.',
    invariant: 'Dedup runs before any heavy processing, never after.',
    links: [{ label: 'dedup.ts', href: `${GH}/packages/server/src/services/ingest/dedup.ts` }],
  },
  skip: {
    title: 'Skip · already ingested',
    body: 'A duplicate is not silently discarded. The ingest file row is marked duplicate and linked to the submission whose bytes it matched, so the upload is still visible in the job’s report and still resolves to something the reviewer can open. "Skip" means "produce no second submission", not "forget this happened".\n\nThat is what makes retries and overlapping uploads safe to encourage. A pg-boss retry, a staff member re-uploading the same export, and a gateway forwarding a batch twice all converge on the same state, which is why the pipeline can be described as idempotent at all.\n\nThe Gradescope path narrows the key to (semester, student, blob) rather than (semester, blob), because two co-submitters of one group bundle legitimately share identical bytes and each must get their own submission.',
    links: [
      { label: 'dedup.ts', href: `${GH}/packages/server/src/services/ingest/dedup.ts` },
      { label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` },
    ],
  },
  queue: {
    title: 'pg-boss',
    body: 'The queue is Postgres. pg-boss owns its own tables and we never mirror queue state into domain tables: job status and ingest-file status are separate questions with separate answers, and conflating them is how a retried job ends up reporting a stale outcome.\n\nThere is no scheduler deciding when a batch is finished. Every ingest-file job, on success or terminal failure, counts the files still pending for its parent job; whichever worker sees zero enqueues the finalize job with the job id as pg-boss’s singleton key, so simultaneous claims of "I am last" collapse to exactly one queued finalize. The alternative, a fixed delay or an external timer, has to guess at how long a batch takes.',
    links: [{ label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` }],
  },
  pipe: {
    title: 'The ingest pipeline',
    body: 'One job runs one file through ordered phases: dedup, parse, match the student to the roster, create the submission, then compute statistics, validation and heuristics inside a single transaction. Ordering is not incidental: dedup has to precede parsing so that a repeat costs one indexed lookup rather than a full unzip, and the submission row has to exist before anything derived from it can be written.\n\nA retry must produce the same flags and the same statistics, and the tests assert it. The phases are therefore either idempotent or guarded by status: an already-resolved file is skipped, version allocation is row-locked so two concurrent workers cannot claim the same index, and a transient database failure before the submission exists re-throws so pg-boss retries rather than marking the file permanently failed.',
    invariant: 'Stages are ordered and idempotent. A retry produces the same flags and stats.',
    links: [
      { label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` },
      {
        label: 'create-submission.ts',
        href: `${GH}/packages/server/src/services/ingest/create-submission.ts`,
      },
    ],
  },
  strip: {
    title: 'Source stripping',
    body: 'After every in-memory computation that needs the student’s code (statistics, all eight validation checks, and the full heuristic pass), the server deletes the source files from the bundle and stores only the signed manifest and the logs.\n\nThis is the single largest cost lever in the system, and it is why storage on a 1 TB quota is viable at cohort scale.',
    invariant:
      'Stripping happens after all computation and never touches manifest.json or manifest.sig; the stored bundle must stay signature- and chain-verifiable.',
    links: [
      {
        label: 'strip-bundle.ts',
        href: `${GH}/packages/server/src/services/ingest/strip-bundle.ts`,
      },
    ],
  },
  pg: {
    title: 'Postgres',
    body: 'Twenty-one tables hold identity, roster, submissions, per-file statistics, validation results, flags, heuristic configs and cross-flags. There is no events table, and reintroducing one needs explicit approval: events were the dominant and never-purged storage cost, and every read path that needs them can re-derive them from the bundle blob instead.\n\nRows are kept forever. Retention deletes blobs only, so a semester that has been swept still shows its cohort, its scores and its flags. What it loses is the ability to open the underlying evidence. Deleting the rows would make the system unable to answer questions about a case that is still open years later, which is the situation the product exists to serve.',
    invariant: 'No events table. Retention deletes blobs only; submission rows persist for audit.',
    links: [
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
      { label: 'retention-sweep.ts', href: `${GH}/packages/server/src/jobs/retention-sweep.ts` },
    ],
  },
  blob: {
    title: 'Blob store',
    body: 'The storage layer is an interface with two implementations: S3-compatible object storage (MinIO in development) and a plain filesystem backend for the apphost deployment, where blobs are ordinary files under a storage root and every key is resolved through a single gate that rejects traversal outside the root or into the multipart staging tree.\n\nThe filesystem backend is where the quota matters. The mount has a hard limit with no headroom, so an hourly cron statfs’s it and raises warn and critical notifications as usage crosses its thresholds. Source stripping is what keeps that curve flat; the quota check is what catches the day it is not enough.',
    links: [
      { label: 'fs-blobs.ts', href: `${GH}/packages/server/src/services/storage/fs-blobs.ts` },
      {
        label: 'storage-quota-check.ts',
        href: `${GH}/packages/server/src/jobs/storage-quota-check.ts`,
      },
    ],
  },
  reparse: {
    title: 'loadSubmissionIndex',
    body: 'Every read path that needs the raw event stream (the events API, replay, file reconstruction, per-submission recompute, cross-flag feature extraction) unzips the stored bundle and rebuilds its index on demand. Nothing about the events is precomputed into rows.\n\nThe trade is deliberate. Materialised events cost storage permanently and are read for a small fraction of submissions; re-parsing costs CPU only for the submissions someone actually opens, and the parse is memoized in a small process-local LRU. The cache key includes the bundle’s sha256, not just the submission id, so a re-ingested or superseded blob can never serve a stale parse and no cross-process invalidation is needed. Re-parsing works against the stripped bundle because reconstruction derives file content from the log, never from stored source bytes.\n\nTwo crypto verdicts are established here rather than at the callers, and cached with the parse: the Manifest 2.0 trust chain, and contributor resolution — which contributor produced each session, from session.start.identity alone. Both take the deployment’s root public key as a parameter. A deployment with no root key still serves every submission; identified sessions then read “we could not check” rather than “we checked and it failed”, and a session with no identity block stays blamelessly unattributed.',
    links: [
      {
        label: 'load-index.ts',
        href: `${GH}/packages/server/src/services/bundle/load-index.ts`,
      },
      {
        label: 'reconstruct-file-provenance.ts',
        href: `${GH}/packages/analysis-core/src/index/reconstruct-file-provenance.ts`,
      },
      {
        label: 'resolve-contributors.ts',
        href: `${GH}/packages/analysis-core/src/identity/resolve-contributors.ts`,
      },
    ],
  },

  // ── Lane 4 · analysis ─────────────────────────────────────────────────────
  valid: {
    title: 'The eight validation checks',
    body: 'The checks run in spec order: manifest signature, session-to-manifest binding, hash chain, sequence gaps, monotonic t, monotonic wall clock, doc.save hash consistency, and submitted-code match. They answer a different question from the heuristics, not "does this look like misconduct" but "can this log be trusted as a record at all", and their verdicts are cryptographic rather than statistical, which is why the flags derived from them carry confidence 1.0.\n\nCheck 2 is the one that grew. It used to compare manifest signatures between sessions and stop there, because the signed payload never entered the bundle. A 2.0 session.start carries the whole manifest, so the check now re-walks root key → certificate → manifest → session offline, with the root key supplied as configuration rather than hardcoded — analysis-core is isomorphic and holds no keys of its own.\n\nThe roll-up is deliberately pessimistic in the middle: any failure makes the bundle fail, but a skipped check makes it warn rather than pass. A check that could not run is not evidence of correctness, and a legacy 1.0 bundle (which carries no submission_files and so cannot be checked against submitted code) should not be able to present itself as fully verified. The same rule covers a deployment with no root key configured: check 2 reports skipped rather than inventing a verdict. The wall-clock check is the one with a deliberate excuse built in: a regression is forgiven when a clock.skew event was recorded in the window spanning it, because the recorder noticing its own clock jump is different from a log with rewritten timestamps.',
    links: [
      {
        label: 'run-validation.ts',
        href: `${GH}/packages/analysis-core/src/validation/run-validation.ts`,
      },
      {
        label: 'verify-submitted-code.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-submitted-code.ts`,
      },
    ],
  },
  heur: {
    title: 'Per-submission heuristics',
    body: 'Eighteen heuristics run in a fixed registry order over the event index: paste size and shape, unexplained external edits, typed-versus-final-output ratio, time to first save, idle-then-complete, absence of intermediate errors, AI extension presence, extension set changes, clock jumps, heartbeat gaps, overlapping sessions, extension hash. All of them are pure synchronous functions of the index, the bundle and a config, so the same inputs always give the same flags.\n\nThe failing validation checks are folded in afterwards by an adapter rather than reimplemented as heuristics. It re-analyses nothing; it translates check failures into the same Flag shape so the cohort list, the scoring formula and the export all handle cryptographic and behavioural findings through one path. Every heuristic reasons over process evidence (events, timings, shapes) and never over the meaning of the student’s code.',
    links: [
      {
        label: 'run-heuristics.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/run-heuristics.ts`,
      },
      { label: 'heuristics catalogue', href: `${GH}/docs/heuristics.md` },
    ],
  },
  cross: {
    title: 'Cross-submission heuristics',
    body: 'Two heuristics compare submissions with each other. The first groups pastes of at least a hundred characters across bundles by content identity, joining a group on either an exact sha256 match or a high line-overlap ratio, one group covering both mechanisms, because splitting exact and fuzzy into separate flag types fragments what is really one finding. The second compares editing rhythm: Jaccard similarity over the set of 3-grams of each bundle’s event-kind stream, which is insensitive to content and therefore says nothing about what was written, only about how.\n\nThey run on a different schedule from everything else in this lane. Per-submission analysis belongs to one file’s job; a cross-submission comparison is meaningful only across a cohort, so ingest finalization enqueues a separate semester-scoped sweep, collapsed by singleton key so a batch of a hundred files produces one recomputation rather than a hundred.',
    links: [
      {
        label: 'paste-shared-across-students.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/cross/paste-shared-across-students.ts`,
      },
      {
        label: 'editing-pattern-clone.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/cross/editing-pattern-clone.ts`,
      },
    ],
  },
  flags: {
    title: 'Ranked flags',
    body: 'Flags sort by severity, then confidence, then the first supporting event, then flag id. The last two keys carry no judgement. They exist so that two runs over the same bundle produce byte-identical output, which is what makes snapshot tests and exported evidence comparable at all. Each flag stores the weight that was in force when it was computed, so a score can always be explained by the configuration that produced it.\n\nInfo-severity flags are worth understanding, because they look like noise and are not. The default severity weights are 0 for info, 1 for low, 3 for medium and 8 for high, so an info flag contributes exactly nothing to the score and cannot pull a submission up the queue. That is how the system records a finding it has decided not to act on: a large paste that turns out to be the student relocating their own previously-typed code stays in the record, with its size and its origin, downgraded to info rather than deleted. Evidence is never destroyed to reduce noise; it is de-weighted, so that a reviewer looking at a specific submission still sees it.',
    invariant:
      'Ranking is fully deterministic. Findings are de-weighted, never dropped: an info flag is a recorded finding worth zero score.',
    links: [
      {
        label: 'run-heuristics.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/run-heuristics.ts`,
      },
      {
        label: 'heuristics/config.ts (server)',
        href: `${GH}/packages/server/src/services/heuristics/config.ts`,
      },
    ],
  },

  // ── Lane 5 · course staff ─────────────────────────────────────────────────
  spa: {
    title: 'Analyzer SPA',
    body: 'The cohort list is the product’s primary claim: a semester’s submissions ordered by score so that attention goes where the evidence is, with filters for severity, score range, specific findings and recorder version, and keyset pagination rather than offsets so deep pages stay cheap on a fifty-thousand-row semester.\n\nIt also carries protected mode. When a principal is protected, student identity never leaves the server: names and student ids are replaced with stable placeholders derived from a per-roster index, falling back to a slice of the random row UUID if that index is somehow absent, so masking can never degrade into real identifiers. This is what lets a course run the review with the reviewer blind to who they are looking at until a decision to look closer has already been made.',
    links: [
      { label: 'cohort/list.ts', href: `${GH}/packages/server/src/services/cohort/list.ts` },
      { label: 'protect.ts', href: `${GH}/packages/server/src/services/protect.ts` },
    ],
  },
  triage: {
    title: 'Worth a human?',
    body: 'This diamond is a person, and that is the design. Nothing downstream of it is automated: the system produces no verdict, no threshold above which a submission is "cheating", and no message to anyone. Flags rank a queue; they do not decide anything.\n\nIt is also the boundary the product refuses to cross in the other direction. No analysis anywhere reasons about the meaning of the student’s code: every heuristic reads process evidence, and the deliberate absence of any classifier over source is what keeps the output arguable. A reviewer can be shown exactly which events produced a flag and can disagree with the conclusion; a model score over the code would leave them nothing to disagree with.',
    links: [{ label: 'Analyzer PRD', href: `${GH}/docs/analyzer-v3-prd.md` }],
  },
  drill: {
    title: 'Drill in',
    body: 'The shell has six tabs. Overview carries the summary, the validation result and the flags; timeline is the filterable event stream; replay reconstructs a file as it existed at any point by applying the recorded deltas forward; validation shows the eight checks with the entries that failed them; source shows the submitted files. The sixth, Export, is a v3.1 stub (see the export node).\n\nSource is the tab with the subtlety, because the submitted bytes are not stored. The file list and its per-file verdicts come from the signed manifest compared against the recorded on-disk hashes, and the content shown is reconstructed from the event stream. So for a file that matches, what you read is the submitted source, and for a file that does not, what you read is the recorded final state, which by definition differs from what was handed in. The one case reconstruction cannot reproduce, bytes altered without touching the manifest, was caught at ingest and is recorded in the stored validation result.',
    links: [
      { label: 'Source.tsx', href: `${GH}/packages/analyzer/src/views/submission/Source.tsx` },
      {
        label: 'submitted-files.ts',
        href: `${GH}/packages/server/src/services/submissions/submitted-files.ts`,
      },
    ],
  },
  close: {
    title: 'No action',
    body: 'There is no dismissed state. The schema has no reviewed flag, no triage status and no per-flag acknowledgement, so closing a submission writes nothing and the ranked list looks exactly the same tomorrow.\n\nThat is a real constraint on how a course uses the tool rather than an oversight to route around. Case tracking belongs in whatever system already records academic-integrity cases, and duplicating it here would produce a second, quietly diverging record of who has been looked at, precisely the kind of artefact a conduct process cannot afford. The system’s memory of a review is the export the reviewer took, not a checkbox.',
    links: [{ label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` }],
  },
  tune: {
    title: 'Tuning UI',
    body: 'The sliders are per-heuristic weights, one for each of the twenty-nine known finding ids, from 0.0 to 2.0, alongside an enable toggle each, not the thresholds inside the heuristics themselves, which live in analysis-core’s heuristics config and are not exposed by this UI at all. The list is wider than the eighteen per-submission heuristics because it also covers the two cross-submission findings and the integrity findings derived from the validation checks. Weight multiplies the severity weight and the confidence to give a flag’s score contribution, so tuning changes what rises to the top of the queue without changing what was detected.\n\nNothing commits blind. Every adjustment debounces into a dry run that returns the score histogram before and after, the number of submissions whose tier would change, and the largest movers, so a course can see the effect of a change on the actual cohort before applying it. Committing writes a new config version and enqueues a recompute; flags keep the version and the weight they were computed under, so an old score stays explainable after the configuration has moved on.',
    links: [
      {
        label: 'TuningView.tsx',
        href: `${GH}/packages/analyzer/src/views/heuristics/TuningView.tsx`,
      },
      {
        label: 'heuristics/config.ts',
        href: `${GH}/packages/server/src/services/heuristics/config.ts`,
      },
    ],
  },
  exp: {
    title: 'Findings export',
    body: 'The findings document is a self-contained report: the validation report, the flag list with the events that support each one, a checksum of the input bundle, and, in the PDF form, rendered screenshots of the replay at the moment of every flag of medium severity or above. Rendering is pure and takes its timestamp by injection, so the same bundle exports the same document.\n\nIt is drawn dashed because only one of its two entry points exists. The export runs in the browser-side /local path; the server-backed submission’s Export tab is a v3.1 stub that renders a sentence and nothing else, because the async PDF job endpoint it was written against never shipped and the markdown sync route has no server handler either. A staff member preparing a conduct case currently produces the document from a bundle in /local rather than from the server-backed submission view.',
    links: [
      {
        label: 'findings-markdown.ts',
        href: `${GH}/packages/analyzer/src/export/findings-markdown.ts`,
      },
      {
        label: 'ExportPanel.tsx',
        href: `${GH}/packages/analyzer/src/views/submission/ExportPanel.tsx`,
      },
    ],
  },
  enroll: {
    title: '/enroll',
    body: 'The only route in this analyzer a student rather than course staff can reach, and the only way a student obtains a credential. It is guarded by RequireAuth and nothing else: no RequireStaff, because a student has no memberships row and would be bounced straight to /home, and no app shell, because the staff chrome is navigation they cannot use. A student session gets a 200 from /me with an empty memberships array, and that is the whole entitlement.\n\nThere is no course and no semester in the path, and that absence is the design rather than an omission. The predecessor posted to a semester-scoped route and needed a semester uuid in the query string; a 2.1 credential names an institution and nothing else, so one credential serves every course the student will ever take, forever. The error handling reflects it structurally — there is no roster branch and no not-found branch, because the path carries no id that could be missing.\n\nIt is a PASTE, not a keypair generator. The master secret and the private key are generated by the recorder and never leave the machine; the page takes the public half the student reads out of their editor, posts it to the credential endpoint, and hands back the issued credential as a one-line paste to import. There is no code path here that generates, receives or transmits private key material, and there must never be one.\n\nThe hazard the page is built around is that a master secret and a public key are both sixty-four lowercase hex characters, so a student who copies the wrong line ships their private identity to the server. Two partial defences, both necessary. The recorder marks an exported secret with a provenance-secret-v1: prefix and the page refuses anything carrying it — checked before extraction, not after — and a prose heuristic catches a student who pastes the surrounding document without the marked line. A bare secret with the marker stripped remains indistinguishable, and the page says so in an amber warning rather than pretending otherwise.',
    invariant:
      'Institution-scoped: no course, no semester, one credential forever. And no private key material touches this page, in either direction.',
    links: [
      {
        label: 'EnrollView.tsx',
        href: `${GH}/packages/analyzer/src/views/enroll/EnrollView.tsx`,
      },
      {
        label: 'credential.ts (server route)',
        href: `${GH}/packages/server/src/api/v1/routes/credential.ts`,
      },
    ],
  },
  compose: {
    title: '/compose/manifest',
    body: 'The staff manifest composer: build a .provenance-manifest, sign it with the course private key, and download it into the assignment repository. It closes the loop this plate opens with, because the manifest it produces is precisely the artifact the workspace gate checks before the recorder will record anything.\n\nSigning happens in the browser, and the course private key never leaves the machine. That is not a convenience — the course key is deliberately offline, which is the entire reason a server-held enrollment subkey exists at all. A server that could sign manifests could weaken any course’s capture policy, and the capture policy is signed precisely so a professor can turn capture down while a student cannot turn it off.\n\nThe mechanics are stricter than the promise. The key is chosen with a file picker and the component never reads the file except inside the sign handler — not on selection, not to preview the public half, not to check it against the certificate; the retained state is a File handle, and a handle is not key material. Inside the handler the text is read, passed straight to the composer, and dropped on return: a parameter and a local, never state, never a ref, never a closure that outlives the call. Derived bytes are zeroed in a finally and only the public half is returned. The module imports no API client and touches no storage, no cookies and no console. A dedicated leak test drives a real signing run and asserts the key hex appears in no request, no storage write, no log argument, no beacon, no produced blob, and no DOM node or attribute.\n\nThe certificate is uploaded by staff rather than fetched, and the root public key comes from the browser build or is pasted, mirroring the CLI flag. Without a root key the page refuses to produce a 2.0 manifest at all rather than emitting one nobody can anchor.\n\nBecause this is signed-format code living in a UI package, correctness is pinned by composition rather than by unit tests: a gate under tools/ spawns the real sign-manifest.ts as a subprocess and compares octets, at 2.0 and at 1.0, including the trailing newline and including the signature itself. It runs under the tools suite, which is not part of the workspace test run.',
    invariant:
      'The course private key is read inside the sign handler and dropped on return. It is never state, never a request, never storage — and the output is byte-identical to the CLI.',
    links: [
      {
        label: 'ManifestComposerView.tsx',
        href: `${GH}/packages/analyzer/src/views/compose/ManifestComposerView.tsx`,
      },
      {
        label: 'manifest-composer-conformance.test.ts',
        href: `${GH}/tools/manifest-composer-conformance.test.ts`,
      },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = ['stu'];
