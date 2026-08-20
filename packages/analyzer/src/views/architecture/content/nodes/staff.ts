import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `staff` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Access control ────────────────────────────────────────────────────────
  login: {
    title: '/login · Google OAuth',
    body: 'The sign-in button is a form POST, not a link: the browser posts to /auth/google/start, the server generates the PKCE pair and the CSRF state, and answers with a 302 to Google’s authorize URL. The return path is validated server-side before any of that: it must begin with a single slash and contain neither "//" nor "://", so the login flow cannot be used as an open redirect to an attacker’s host.\n\nThe state and the PKCE verifier live in a short-lived HMAC-signed cookie (__Host-prov_oauth, ten minutes) rather than in a database row. That avoids a write on every login attempt, including the ones nobody completes, and the signature is what makes it safe: an unsigned client-side state would be forgeable. The callback reads the cookie and clears it in the same breath, so a state is single-use whether or not the exchange succeeds.',
    links: [
      { label: 'auth.ts', href: `${GH}/packages/server/src/api/v1/routes/auth.ts` },
      { label: 'cookies.ts', href: `${GH}/packages/server/src/auth/cookies.ts` },
    ],
  },
  hd: {
    title: 'Hosted-domain claim check',
    body: 'Authentication succeeds only when the Google ID token’s hd claim matches AUTH_ALLOWED_HOSTED_DOMAINS. It is the primary access control on the analyzer: the single check keeping non-institutional Google accounts out.',
    invariant: 'Do not loosen the hd check.',
    links: [{ label: 'auth', href: `${GH}/packages/server/src/auth` }],
  },
  deny: {
    title: 'Rejected at the callback',
    body: 'Rejection happens after the code exchange, on the claims of the verified ID token, not on the login hint the browser sent to Google’s account picker, which is a suggestion the user is free to ignore. A second gate follows it: an identity whose email_verified claim is false is refused too, because an unverified address can be asserted rather than owned, and invitations are activated by matching on exactly that address.\n\nBoth gates return before the user upsert, so a rejected identity leaves nothing behind: no user row, no session, no membership. The analyzer renders the returned code as a specific sentence (HOSTED_DOMAIN_MISMATCH tells the visitor to use their institutional account), which is the opposite of the recorder’s deliberate silence: here the person is already known to be a human trying to log in, and a generic failure would just generate support mail.',
    invariant:
      'The domain and email-verified gates run before any row is written. A refused login creates no user.',
    links: [
      { label: 'auth.ts', href: `${GH}/packages/server/src/api/v1/routes/auth.ts` },
      { label: 'LoginView.tsx', href: `${GH}/packages/analyzer/src/views/login/LoginView.tsx` },
    ],
  },
  sess: {
    title: 'Cookie session',
    body: 'A session is 32 bytes of CSPRNG output, base64url-encoded, in a cookie carrying the __Host- prefix in production, which the browser only honours alongside Secure and Path=/ and no Domain, so the cookie cannot be planted by a sibling subdomain. Expiry is enforced in the lookup’s WHERE clause rather than in JavaScript, which means it is measured by the database clock that stamped the row, uses the index, and never transfers an expired session over the wire at all.\n\nThe same row carries view-as: a superadmin can adopt another user’s view, and the columns recording it sit on the session rather than in a token, so exiting is a write to one row and the superadmin’s real identity is never lost for audit. Authorization treats that mode as strictly read-only: every non-read action is refused while it is active, because the point is to see what someone else sees, not to act as them.',
    links: [
      { label: 'sessions.ts', href: `${GH}/packages/server/src/auth/sessions.ts` },
      { label: 'authorize.ts', href: `${GH}/packages/server/src/auth/authorize.ts` },
    ],
  },
  role: {
    title: 'Membership role for this semester',
    body: 'There is no course-level and no global staff role. A membership row is keyed on (user, semester) and carries admin or grader, so access is granted one semester at a time and a TA from last spring keeps exactly the semester they were added to. Every route authorizes against the semester named in its own path, which is what makes that grain real rather than decorative.\n\nThe split between the two roles is coarse on purpose: grader covers read, and both write and admin require admin. Ingest, roster commits, tuning and recompute are therefore admin-only, while the entire review surface (cohort, drill-in, cross-flags) is open to a grader. Superadmin bypasses the membership check entirely, with one exception that says what the feature is for: in view-as mode the bypass is suspended and the target’s memberships are honoured strictly, so a superadmin checking why a TA cannot see a page actually cannot see it either.',
    links: [
      { label: 'authorize.ts', href: `${GH}/packages/server/src/auth/authorize.ts` },
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
    ],
  },
  tok: {
    title: 'API tokens',
    body: 'A token reads prov_<prefix>_<random>. Only the 8-character prefix and an argon2id hash are stored; the secret is displayed once and cannot be recovered. The prefix exists so that verification is a single indexed lookup followed by one hash comparison rather than an argon2 verify against every token in the table.\n\nThree scopes are carried: read_only, an optional allow-list of semester ids, and include_blobs. The last one is separate from ordinary read for a reason: everything else a token can fetch is derived (scores, flags, event rows), while the bundle download hands over the signed evidence itself, so it takes its own scope and is the one read action written to the audit log. Scopes only ever subtract: after the token checks pass, the request is authorized against the owner’s memberships exactly like a browser session, so a token can never reach a semester its owner cannot.',
    invariant:
      'Scopes narrow, never widen. A token is still authorized against its owner’s membership for the semester in the path.',
    links: [
      { label: 'tokens.ts', href: `${GH}/packages/server/src/auth/tokens.ts` },
      { label: 'authorize.ts', href: `${GH}/packages/server/src/auth/authorize.ts` },
    ],
  },

  // ── Getting data in ───────────────────────────────────────────────────────
  ing: {
    title: 'Ingest',
    body: 'Two upload routes sit behind this page. The plain one takes bundle zips and matches each student by applying the semester’s filename-convention regex to the uploaded filename. The Gradescope one is the primary path and works differently: it reads submission_metadata.yml, upserts the roster from it, rebuilds a sealed bundle zip per submission folder, and stages a match_sid hint so the worker matches on metadata and never consults the regex at all. A course using Gradescope therefore needs no roster upload and no filename convention to get started.\n\nUpload is admin-only and bounded on four axes (per-bundle bytes, per-batch bytes, per-batch file count, and whether a roster is required) because this endpoint accepts an archive from a human and unzips it. A zip of zips is expanded and each inner archive staged separately, which is what a staff member gets when they collect submissions by hand.',
    links: [
      { label: 'ingest.ts', href: `${GH}/packages/server/src/api/v1/routes/ingest.ts` },
      {
        label: 'parse-export.ts',
        href: `${GH}/packages/server/src/services/ingest/gradescope/parse-export.ts`,
      },
    ],
  },
  job: {
    title: 'Poll the ingest job',
    body: 'Upload answers 202 with a job id and nothing else; the page polls until the job reaches a terminal state. Four are terminal, and partial is the one that matters: a three-hundred-file export where two bundles fail to parse must not report as a failure, because the other two hundred and ninety-eight submissions are ingested and reviewable. The per-file statuses carry the real story (matched, unmatched, duplicate, superseded, failed, discarded) and the counts are the first thing a staff member reads.\n\nNothing schedules the transition. Every per-file job, on success or terminal failure, counts the files still pending for its parent; whichever worker sees zero enqueues the finalize job under the job id as a singleton key, so several workers simultaneously concluding "I am last" collapse to exactly one finalize. Cancel is only offered while the job is queued or running, since a terminal job has nothing left to stop.',
    links: [
      { label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` },
      {
        label: 'IngestJobView.tsx',
        href: `${GH}/packages/analyzer/src/views/ingest/IngestJobView.tsx`,
      },
    ],
  },
  unm: {
    title: 'The unmatched tray',
    body: 'A file lands here for one of two reasons: the filename did not match the semester’s convention, or it did and the captured student id is not in the roster. In both cases the bundle itself is fine (parsed, staged, intact) and the only thing missing is which person it belongs to. Treating that as a failed file would throw away real evidence over a roster typo or a student who renamed their zip, so it gets a status of its own and a queue a human can work through.\n\nAttaching runs the same pipeline phases the worker would have run (create the submission, then stats, validation and heuristics) so an attached file is indistinguishable from one that matched on the first pass. The whole operation holds a row lock on the ingest file, which is how two admins clicking Attach at the same moment serialize into one success and one 409 rather than two submissions. Discarding is a status transition, not a delete: the row stays, with the reason, and both actions are written to the audit log.',
    invariant:
      'Unmatched means the identity is unknown, never that the bundle is bad. Discard changes status; it never removes the row.',
    links: [
      { label: 'attach.ts', href: `${GH}/packages/server/src/services/ingest/attach.ts` },
      {
        label: 'match-student.ts',
        href: `${GH}/packages/server/src/services/ingest/match-student.ts`,
      },
    ],
  },
  ros: {
    title: '/roster',
    body: 'A CSV upload never writes anything. It is parsed, diffed against the current roster into additions, updates and deletions, and returned as a preview the admin has to look at before committing. Deletions need a separate explicit flag on top of that, because the common mistake is uploading a section CSV over a whole-course roster and silently dropping four hundred students.\n\nThe preview lives in an in-memory cache for thirty minutes and is forfeited on restart. That is deliberate rather than unfinished: a diff is a proposal about a roster that may itself have changed, so an old one is not worth honouring. The roster is also what makes the unmatched tray small: the filename convention resolves a captured student id against these rows, so a pile of unmatched files is usually a roster problem rather than a recorder one.',
    links: [
      { label: 'diff.ts', href: `${GH}/packages/server/src/services/roster/diff.ts` },
      {
        label: 'preview-cache.ts',
        href: `${GH}/packages/server/src/services/roster/preview-cache.ts`,
      },
    ],
  },

  // ── Triage ────────────────────────────────────────────────────────────────
  cohort: {
    title: 'The cohort list',
    body: 'Every filter and the sort live in the URL, so a view is a link: "the fourteen submissions on hw3 with an unexplained external edit" is something one grader can paste to another rather than describe. Paging is keyset on (sort key, id) rather than an offset, which keeps the last page of a fifty-thousand-row semester as cheap as the first, and superseded submissions are excluded unless asked for so a resubmission does not appear twice.\n\nTwo details are worth knowing before relying on them. Saved views are localStorage, keyed by semester: they belong to one browser and are not shared with the course. And the CSV export walks the cursor with the filters currently applied rather than dumping the rows already on screen, so it exports the whole filtered set, up to a hard cap that exists to stop an empty filter from downloading the semester.',
    links: [
      { label: 'list.ts', href: `${GH}/packages/server/src/services/cohort/list.ts` },
      {
        label: 'ExportCurrentView.tsx',
        href: `${GH}/packages/analyzer/src/views/cohort/ExportCurrentView.tsx`,
      },
    ],
  },
  q: {
    title: 'Does this one warrant a human?',
    body: 'The score is a ranking key, not a measurement. It is a plain sum of per-flag contributions with no normalization and no ceiling, computed under one semester’s weights, and every flag records the config version it was scored under, so two submissions in the same cohort are comparable and two numbers from different semesters, or from either side of a tuning change, are not. There is no threshold stored anywhere above which a submission is anything.\n\nThat is why this diamond is a person rather than a rule. The system’s entire claim is about order: it puts the submissions whose process evidence is unusual at the top so a limited number of review hours land where the evidence is. Whether the fourth one down is worth opening is a question about the course, the assignment and the student, and nothing in the database is in a position to answer it.',
    links: [
      { label: 'compute.ts', href: `${GH}/packages/server/src/services/scoring/compute.ts` },
      { label: 'Analyzer PRD', href: `${GH}/docs/analyzer-v3-prd.md` },
    ],
  },
  none: {
    title: 'No action',
    body: 'Closing a submission writes nothing at all. There is no reviewed column, no triage status, no per-flag acknowledgement, so tomorrow the queue is rebuilt from the same evidence and this submission sits at the same rank, indistinguishable from one nobody has opened. On a large cohort that is a real cost: two graders can work the same top twenty without either knowing.\n\nIt is still the right default. A second record of who has been looked at, living beside the institution’s actual conduct process and quietly diverging from it, is exactly the artefact a hearing cannot afford. The only durable trace a review leaves here is an audit row when someone downloads the bundle (ordinary reads of the cohort or a submission are not logged) and the evidence document the reviewer took away.',
    links: [
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
      { label: 'bundle.ts', href: `${GH}/packages/server/src/api/v1/routes/bundle.ts` },
    ],
  },

  // ── The five (six) views of one submission ────────────────────────────────
  t1: {
    title: 'Overview',
    body: 'Overview is the default tab, which is precisely why it does not load the event index. The full index is the most expensive fetch in the application, and paying for it every time someone glances at a submission would tax the ninety per cent of visits that end in "no". It is requested only once a flag drawer is actually opened.\n\nThe assignment-manifest card sits here for a reason that is about reading, not layout. It names the course, the collaboration and submission modes, the certificate’s validity, the offline trust-chain verdict — and, most importantly, the capture signals the course switched off. Without that last list a reviewer looking at a submission from a course that disabled terminal capture sees no terminal events and no terminal-related flags, and has no way to distinguish that from a student who never opened one; absent by policy and absent by omission look identical on screen unless the policy is on screen too. The card renders nothing at all for a 1.x bundle with nothing disabled, because an empty card is worse than no card, so callers mount it unconditionally. The same component serves the offline /local overview.\n\nThe recording-coverage panel sits here for the same reason, above the validation result and the flags rather than below them, because it is the context a reader needs in order to read those correctly: which sessions are attributed, whether an identity check was possible at all, which commits no surviving session covers, which log tails no signature reaches, which artifacts were dropped, and which pairs of contributors were recording at the same time. Nothing in it is a flag, contributes to a score, or fails a check, and it is drawn in the neutral status palette rather than the flag one for exactly that reason. It is one panel per submission, not one per tab — it lived in the Replay tab, collapsed, which is neither always visible nor the right scope for a fact about the whole submission. On the server-backed route it says the facts were not fetched: that view reads API rows rather than a parsed bundle, and a panel of zeroes would assert no commits, no contributors and no root key, which is a stronger and false claim than not available.\n\nUntil the index arrives, the drawer degrades rather than blocks: supporting rows show their bare global event number and their jump buttons still work, because a supporting seq is all either destination needs to resolve the event and the session along with it. The flags themselves render through the same panel and drawer the offline /local route uses, so a reviewer opens a finding and lands on its evidence instead of reading a list of heuristic ids.',
    links: [
      { label: 'Overview.tsx', href: `${GH}/packages/analyzer/src/views/submission/Overview.tsx` },
      {
        label: 'CoveragePanel.tsx',
        href: `${GH}/packages/analyzer/src/views/coverage/CoveragePanel.tsx`,
      },
      {
        label: 'AssignmentManifestCard.tsx',
        href: `${GH}/packages/analyzer/src/components/AssignmentManifestCard.tsx`,
      },
    ],
  },
  t2: {
    title: 'Timeline',
    body: 'The tab pages the events endpoint to exhaustion and builds the same EventIndex the offline route builds from a zip, then mounts the same component. One implementation of "browse a bundle’s events" serves both paths, so a filter or a detail pane written once works in both.\n\nIt used to be a bespoke list that sliced the first five hundred rows out of a query already capped at two thousand. On a large submission that silently showed a fraction of the stream, and the missing part is exactly where someone hunting an anomaly would be looking. The current ceiling is far higher and, more importantly, is surfaced as a visible error when it is hit: for this product a truncated timeline is strictly worse than a refusal, because a refusal cannot be mistaken for a quiet session.',
    invariant:
      'A timeline that cannot show every event says so. It never silently renders a prefix.',
    links: [
      { label: 'Timeline.tsx', href: `${GH}/packages/analyzer/src/views/submission/Timeline.tsx` },
      {
        label: 'useFullEventIndex.ts',
        href: `${GH}/packages/analyzer/src/data/useFullEventIndex.ts`,
      },
    ],
  },
  jump: {
    title: 'Every flag carries a supporting seq',
    body: 'This is what turns a finding into an argument. A flag is not a label on a submission; it is a list of positions in that submission’s event stream, and clicking one lands the reviewer on the moment itself (the paste, the external write, the gap) where they can read what surrounds it and decide the heuristic is wrong.\n\nThe identifier doing the work is a globalIdx: the event’s position in the whole chronological stream across every session, not a session-local sequence number. Ingest translates analysis-core’s session-scoped keys into it precisely because a bare seq is ambiguous the moment a submission has two sessions, and the flags whose evidence spans a session boundary are the ones most worth landing on. Resolution goes through the number the server actually sent rather than by indexing into the client’s own re-sorted array, and a supporting seq that cannot be resolved is dropped instead of passed through: the jump controls skip a flag with no landable evidence rather than jumping to nowhere.',
    invariant:
      'A supporting seq is a globalIdx, resolved by lookup. Never treat it as a position in a locally sorted array.',
    links: [
      {
        label: 'global-seq-lookup.ts',
        href: `${GH}/packages/analyzer/src/data/global-seq-lookup.ts`,
      },
      { label: 'Replay.tsx', href: `${GH}/packages/analyzer/src/views/submission/Replay.tsx` },
    ],
  },
  t3: {
    title: 'Replay',
    body: 'The viewport follows the student’s caret, which works for everything the student did and fails for the one event that matters most. An fs.external_change is by definition something outside the editor writing the file: it moves no cursor, so a reviewer can play straight past the highest-signal event in the bundle without ever seeing the lines it touched. So an external change takes the viewport, and hands it back at the student’s next edit, paste or cursor move in that file.\n\nWhich event holds the viewport is derived purely from the playhead (scan backwards for an external change reached before any of those three kinds) with no timers and no retained state. That is why scrubbing backwards onto an external write frames it exactly the way playing into it does. doc.save is deliberately not one of the events that ends the reveal: the recorder emits the save from the same continuation as the external change and they routinely share a wall-clock timestamp, so counting it would end the jump in the tick it began.',
    links: [
      {
        label: 'external-change-focus.ts',
        href: `${GH}/packages/analyzer/src/views/replay/external-change-focus.ts`,
      },
      {
        label: 'FollowCursor.tsx',
        href: `${GH}/packages/analyzer/src/views/replay/FollowCursor.tsx`,
      },
    ],
  },
  t4: {
    title: 'Validation',
    body: 'The eight checks are computed once, when the bundle is ingested, and stored. This tab renders that stored row rather than re-deriving it, so what a reviewer reads is the verdict on the bundle as it arrived, in the state it arrived in. A recompute is the only thing that rewrites it.\n\nThe roll-up is pessimistic where it counts: any failing check fails the bundle, but a check that could not run downgrades the whole thing to warn rather than leaving it at pass. A check that did not execute is not evidence of correctness, and a legacy bundle carrying no submitted files should not be able to present itself as fully verified. Failures also arrive on Overview a second time, as flags with confidence 1.0. The duplication is deliberate, so that a reviewer who never opens this tab still cannot miss a broken chain.',
    links: [
      {
        label: 'run-validation.ts',
        href: `${GH}/packages/analysis-core/src/validation/run-validation.ts`,
      },
      {
        label: 'Validation.tsx',
        href: `${GH}/packages/analyzer/src/views/submission/Validation.tsx`,
      },
    ],
  },
  t5: {
    title: 'Source',
    body: 'The submitted bytes are not stored (ingest strips them once check 8 has run) so this tab is assembled from two surviving things: the signed manifest, which fixes each file’s sha256 at seal time, and the event stream, from which the content is reconstructed. The per-file badge is the manifest’s hash compared against what the recorder observed on disk, so a match badge means the reconstruction you are reading is the submitted source and a mismatch means it is the last state the log recorded, which by construction is not what was handed in.\n\nTwo empty states are not errors and should not be read as ones. A retention-swept semester has no blob left to re-parse, so the tab says the source is unavailable while the flags and scores derived from it remain. A format 1.0 bundle predates submission_files entirely and simply has no file list to show.',
    links: [
      { label: 'Source.tsx', href: `${GH}/packages/analyzer/src/views/submission/Source.tsx` },
      {
        label: 'submitted-files.ts',
        href: `${GH}/packages/server/src/services/submissions/submitted-files.ts`,
      },
    ],
  },

  // ── The tuning loop ───────────────────────────────────────────────────────
  judge: {
    title: 'Is the flag class firing on ordinary work?',
    body: 'This question has two different answers in the tuning UI and they are not equivalent. Dropping a weight to zero keeps the flag on every submission that produced it, worth nothing to the score: the finding stays in the record and a reviewer looking at that specific submission still sees it. Disabling the heuristic means its flags are not written at all on the next recompute: the evidence leaves the database, not just the ranking.\n\nBoth are reversible, because everything is re-derived from the stored bundle rather than accumulated: re-enable and recompute and the flags come back identical. But between the change and that recompute, a disabled heuristic’s findings are simply absent from the cohort, which is a different thing to have done than de-prioritising them. Zero weight is the honest instrument for "this fires too often here"; disabling is for a heuristic that does not apply to this course at all.',
    links: [
      {
        label: 'recompute-submission.ts',
        href: `${GH}/packages/server/src/services/scoring/recompute-submission.ts`,
      },
      { label: 'heuristics catalogue', href: `${GH}/docs/heuristics.md` },
    ],
  },
  tune: {
    title: '/tuning',
    body: 'The page exposes exactly two controls per finding (an enable toggle and a weight from 0.0 to 2.0), one row for each of the known finding ids, which is more than the per-submission heuristics because the list also covers the two cross-submission findings and the integrity findings derived from the validation checks. It does not expose thresholds. The stored config shape does have a per-flag thresholds object, and the recompute worker does forward it into analysis-core’s config, so thresholds are reachable through the API; no screen writes them.\n\nEditing is safe against a second admin. The config is per-semester and versioned, every commit carries the version it was based on, and a stale commit is refused with a conflict rather than merged. The UI’s only offer is to reload, because silently merging two people’s weight changes produces a configuration neither of them chose. Before committing, each adjustment debounces into a dry run over the real cohort, and the first one fires on page load with the config unchanged so the "before" series in the histogram is the actual current distribution rather than a placeholder.',
    invariant:
      'A commit carries the version it was based on. Concurrent edits conflict; they are never merged.',
    links: [
      {
        label: 'TuningView.tsx',
        href: `${GH}/packages/analyzer/src/views/heuristics/TuningView.tsx`,
      },
      {
        label: 'heuristic-config.ts',
        href: `${GH}/packages/server/src/api/v1/routes/heuristic-config.ts`,
      },
    ],
  },
  recomp: {
    title: 'Cohort recompute',
    body: 'Committing enqueues a job that enumerates the semester’s non-superseded submissions, marks them stale, and fans out one job per submission; the last one to finish enqueues the finalize under a singleton key, the same pattern ingest uses. Each per-submission job re-reads the stored bundle and derives everything again from it.\n\nEverything means everything. Validation is re-run rather than read back from the stored row: reusing it meant a recompute could never correct a wrong verdict, and because the report feeds the heuristics, a stale check-8 failure kept re-emitting a high-severity flag on every pass. Per-file statistics are rewritten for the same reason: two of their columns, whether a reconstruction is tainted and how many characters arrived by external write, are downstream of exactly the verdicts a recompute exists to revise, and leaving them frozen meant the flags quietly got fixed while the stats went on telling staff the old story. Re-running is safe against a stripped bundle because every check reads the signed manifest, the chain, or recorded event hashes, none of which are stripped.',
    invariant:
      'A recompute re-derives from the stored bundle. Nothing is carried forward from the previous run.',
    links: [
      {
        label: 'recompute-submission.ts',
        href: `${GH}/packages/server/src/services/scoring/recompute-submission.ts`,
      },
      { label: 'recompute.ts', href: `${GH}/packages/server/src/jobs/recompute.ts` },
    ],
  },

  // ── Outcomes ──────────────────────────────────────────────────────────────
  xflags: {
    title: '/cross-flags',
    body: 'The per-submission queue cannot see a shared paste, because the evidence is only visible from outside a single bundle. These findings are semester-scoped for that reason, and they are not part of any submission’s pipeline: ingest finalization enqueues one sweep for the whole semester, collapsed by singleton key so a hundred-file batch produces one recomputation rather than a hundred.\n\nThe set is replaced atomically on every sweep (deleted and reinserted) which has a consequence worth knowing before you rely on it: a cross-flag id is not a stable handle, so a link to a detail page can stop resolving after the next ingest. What makes the page usable anyway is that each participant carries their own supporting seqs. A group is not an assertion that two students are similar; it is a set of specific moments in each student’s own log, and a reviewer can open either one and watch it happen.',
    links: [
      {
        label: 'cross-flags.ts',
        href: `${GH}/packages/server/src/api/v1/routes/cross-flags.ts`,
      },
      {
        label: 'paste-shared-across-students.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/cross/paste-shared-across-students.ts`,
      },
    ],
  },
  exp: {
    title: 'Evidence export',
    body: 'Only one of the two entry points exists. The submission tab shown here is a v3.1 stub that renders a sentence: it was written against an asynchronous PDF job endpoint that never shipped, and the markdown route it also called has no server handler either, so rather than leave a button that 404s the panel says so. The working findings export is the browser-side one under /local: a staff member preparing a conduct case today drops the bundle there and generates the document from it.\n\nThe document itself is the validation report, the flag list with the events supporting each finding, and a checksum of the input bundle, rendered by a pure function that takes its timestamp by injection so the same bundle produces the same output. Taking an export also writes nothing anywhere: the audit trail records downloading a bundle, not producing a report from one.',
    links: [
      {
        label: 'ExportPanel.tsx',
        href: `${GH}/packages/analyzer/src/views/submission/ExportPanel.tsx`,
      },
      {
        label: 'findings-markdown.ts',
        href: `${GH}/packages/analyzer/src/export/findings-markdown.ts`,
      },
    ],
  },
  audit: {
    title: 'audit_log',
    body: 'Rows are written only on a 2xx: the table records completed actions, not attempts, so a refused ingest or a failed attach leaves no entry. Each row names the actor twice where that applies (the user id and, separately, the token id) so an action taken by a script is attributable both to the credential and to the person who created it, alongside the address, the user agent and a jsonb detail blob the route fills in with what actually changed.\n\nThe insert is fire-and-forget, and warns rather than throwing if it fails. That is a deliberate trade of completeness for availability: an audit failure must not turn a successful roster commit into an error the admin sees. Coverage is likewise partial by design: writes and the privileged reads are logged, ordinary cohort and submission reads are not, and the one read that is logged is the bundle download, because that is the moment the signed evidence leaves the system. Nothing in the application ever deletes from this table.',
    invariant: 'Append-only, and written only after the action succeeded.',
    links: [
      { label: 'audit.ts', href: `${GH}/packages/server/src/api/middleware/audit.ts` },
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [
  // The actor the diagram starts from. It names the reader, not a mechanism.
  'staff',
];
