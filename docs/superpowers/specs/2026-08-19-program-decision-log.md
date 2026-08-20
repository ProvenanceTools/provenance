# Multi-course program — decision log and state of play

**Read this first when resuming work on `feat/manifest-2.0-trust-chain`.**

Companion documents, in reading order:

1. `2026-08-18-multicourse-program-architecture.md` — the umbrella spec. Pins every cross-repo contract.
2. `2026-08-19-git-collaboration-semantics.md` — the 31-scenario census of shared-repo behaviour, the ordering/reconstruction semantics, and the tiered worklist.
3. **This file** — what was decided, what was built, what was found, and what is still owed.

Where this file and an older spec disagree, **this file wins** — several spec statements were
overtaken by evidence (each such case is called out below with the reason).

---

## 1. Decisions on record — do not re-litigate

| #   | Decision                                                                                                                                                                                                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Institution-scoped identity**, replacing course-scoped. One student, one key, one global `student_ref`, one credential, obtained once.                                                                                                                       | Rosters are populated by Gradescope ingest **after** a submission, but identity is needed **before** work. The old `mint.ts` required a roster match, so a student could never enrol before their first submission. A confirmed deadlock, not a preference.                                                                                                                                                                                                                                                                                                                                  |
| D2  | **Fully global HKDF derivation** — no user-derived input in `info`.                                                                                                                                                                                            | The recorder can show a student their public key with zero configuration. Cost, accepted: cross-institution unlinkability is gone.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D3  | **A new `students` table**, keyed `(institution_id, sso_subject)` on the Google `sub` claim — not email.                                                                                                                                                       | Emails get reassigned; `sub` does not. Allocatable before any roster row exists, which is what breaks the deadlock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D4  | **2.0 credential _minting_ retired; 2.0 _verification_ kept forever.**                                                                                                                                                                                         | The 2.0 minting route never shipped (absent from `main`, added and superseded within this branch). Verification must survive permanently — archived bundles are the adjudication case that justifies the system.                                                                                                                                                                                                                                                                                                                                                                             |
| D5  | **Multiple machines per student is a first-class flow.** Each machine enrols independently, generating its own keypair; the shared `student_ref` groups them into one contributor.                                                                             | Explicit user requirement. Note this means _no secret copying is needed_ to use a second machine; export/import is a **backup** path, not a migration step.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D6  | **Keypair, not a bearer token.**                                                                                                                                                                                                                               | A UUID is copyable and repudiable ("someone must have got my token"). A signature over the session's ephemeral key is not. And the server holds only public keys, so a database breach forges nobody.                                                                                                                                                                                                                                                                                                                                                                                        |
| D7  | **`final: true` on the dispose-time rolling seal.**                                                                                                                                                                                                            | A rolling seal is signed _before_ the log's trailing bytes exist, so it commits only to a prefix. `final` restores whole-file semantics when the log provably cannot grow. Absence is never a finding.                                                                                                                                                                                                                                                                                                                                                                                       |
| D8  | **The integrity hole is fixed as bundle-level Flags, not a 9th validation check.**                                                                                                                                                                             | The PRD §5.4 eight are a frozen persisted contract (eight `check_N_status` columns, a `checks.length === 8` assert at ingest). Catalogue went 26 → **29**.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D9  | **S4 cuts over to the `submission_contributors` join table** as the live path.                                                                                                                                                                                 | User's decision, taken with the blast radius (12+ read paths, 6 Zod schemas, 7 analyzer call sites) on the table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D10 | **Ingest modes: `bundle_zip` / `repo_whole` / `repo_scoped`**, per-assignment default with per-request override, API-driven for provgate. A batch declares its type; a mismatch fails.                                                                         | User's decision. The homogeneity guarantee converts per-file guessing into a per-batch assertion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D11 | **Manifest composer signs in the browser**; the course private key never leaves staff's machine.                                                                                                                                                               | The course key is deliberately offline — that is why a server-held _enrollment_ subkey exists. A server that could sign manifests could weaken any course's capture policy.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D12 | **Repository discriminator = root-commit sha** (not yet emitted; format change pending).                                                                                                                                                                       | Both partners on one repo derive the same value offline, which is what makes cross-contributor DAG correlation possible. A submodule has a different root commit, so it discriminates correctly.                                                                                                                                                                                                                                                                                                                                                                                             |
| D13 | **Unenrolled contributors show as `unattributed`**, not blocked and not flagged.                                                                                                                                                                               | An administrative gap must never present to a grader as an integrity signal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D14 | **Group scoring is per-contributor _and_ per-scope.**                                                                                                                                                                                                          | Only shape where a grader can act on one partner without implicating the other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D15 | **IRB/CPHS approval is the user's problem.** S6 is not an engineering blocker.                                                                                                                                                                                 | Stated by the user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D16 | **Content overrides the timing tag.** A content-derived `git_unrecorded_in` is no longer suppressed by the recorder's `explanation: 'git'` tag in `external_edits`. `git_merge_in` still suppresses, severity is unchanged, and the tagger itself is retained. | A two-second timing window must not silence a finding the cryptographic content test says is real: it is a hole a student could learn to exploit by timing an out-of-editor paste right after any git command. Fail toward surfacing evidence. **Accepted cost:** it also fires for an honest pair whose partner simply was not recording, so the flag asserts no authorship — it says the content has no recorded authorship _in this scope_, names the unenrolled-partner reading alongside the guilty one, and says confirming every collaborator is enrolled is what distinguishes them. |

### Two spec statements that were overturned by evidence

- **`globalIdx` is NOT re-keyed.** `2026-08-19-git-collaboration-semantics.md` §5.2 says the
  migration "is not a candidate for incrementalism". That was written without knowing
  `flags.supporting_seqs` and `cross_flag_participants.supporting_seqs` are `int[]` of `globalIdx`
  values **persisted in Postgres** (`schema.ts:690`). Re-keying silently repoints every stored
  finding's evidence at different events — a grader shown fabricated evidence against a named
  student, with no error anywhere. `≺` is therefore exposed **only as a relation**
  (`compareEvents → before|after|concurrent|same|unknown`, returning a _string_ so it cannot be
  passed to `Array.sort`), with **no parallel integer field** either — two interchangeable-looking
  numbers, one of which is persisted, is a foot-gun. `build-index.ts` is untouched.
  **If the re-key is ever taken it needs automatic and total invalidation of every `flags` /
  `cross_flag_participants` row.** "The next recompute will fix it" is insufficient: recompute
  only runs on a config commit, so historical rows stay wrong in the interim.
- **`checkpoint_chain_valid` cannot catch an append past the final checkpoint**, and no checkpoint
  scheme can — such an append leaves every checkpoint verifying perfectly. Only `log_bytes_match`
  (and, for a finished session, `final`) catches it. Any doc implying otherwise is wrong.

---

### D10 as built — all three ingest entry points are scope-aware (2026-08-20)

The declared submission type is now offered by **every** upload route, not two of three. The
override's SHAPE follows the route's BODY, not the route:

| route                                 | body        | override shape                                                          |
| ------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| `POST /…/ingest`                      | `multipart` | flat `?scope_mode=…&scope_path_glob=…&scope_on_multiple=…` query params |
| `POST /…/ingest:gradescope`           | `multipart` | the same flat `scope_*` query params                                    |
| `POST /…/ingest/uploads/:id/complete` | JSON        | nested `ingest_scope` object in the body                                |

Two spellings, one per body type — `IngestScopeOverrideQuerySchema` + `ingestScopeFromQuery` fold
the flat form into the same object `FinalizeUploadRequestSchema` takes, and both are re-narrowed
through `parseIngestScopeConfig`, so nothing downstream can tell an override from a persisted
`assignments.ingest_scope` default. All three fall back to that default when no override is given.

`POST /…/ingest` was the outlier and it was an oversight, not a decision: it had **zero** scope
handling, so `tryExpandZipBundle` understood only "a bundle" and "a zip of bundles" and a git repo
zip matched neither. It fell through to `single-zip` and staged the whole repo as one malformed
bundle — **and did not error**, on the one path staff use for a manual re-ingest or a fixup.
`services/ingest/repo-zip.ts` closes it by ADAPTING, not reimplementing: discovery, resolution,
entry selection, entry order and the ZIP rebuild are all `repo-scopes.ts` / `build-bundle-zip.ts`,
called with the same arguments in the same order as `stream-export.ts` calls them. A test drives
the same repo tree through `openLocalExport` and through `expandRepoZip` and requires identical
scopes, identical reasons and **byte-identical** rebuilt bundles, so a divergent second copy fails.

The guard that keeps the pre-existing shapes untouched is decided from entry **names alone**: an
archive is a repo iff some non-junk entry sits under a `.provenance/` directory. A sealed bundle is
flat by construction, so it can never satisfy the predicate, is never rebuilt, and stages the exact
bytes uploaded — its `blob_sha256`, the dedup key, is unchanged **by construction**. The cost,
accepted deliberately: the declared type is asserted only on the repo-shaped branch, so a
`repo_scoped` batch handed a flat bundle ingests it rather than rejecting it. Asserting there would
mean rebuilding a flat bundle to read its declared assignment id, which changes the staged bytes of
the exact shape this change was required to leave alone.

Skips report through the existing channel only: `POST /…/ingest` resolves inside the request, so it
inlines the array in its 202 **and** writes it to `ingest_jobs.skipped` before the first enqueue.
Its inline field is **not** nullable — unlike the Gradescope routes' shared response, there is no
instant at which this route's honest answer is "unknown", so there is no `null` to spend and `[]`
is a positive statement. When every scope is rejected the job is marked `failed` rather than left
`queued` (nothing will be enqueued, so nothing would ever finalize it) and the reasons survive,
because `failIngestJob` does not name the `skipped` column.

**Known gap, unfixed:** a fanned-out non-root scope is staged as `<stem>/<scope>.zip`, which the
semester's filename convention cannot match, so it lands in the unmatched tray. That is inherent —
one upload became N submissions and a filename encodes one identity — and the Gradescope path only
avoids it by having `match_sid` from the export metadata, which this route has no equivalent of. A
root scope keeps the uploaded filename verbatim, so `repo_whole` still matches as before.

---

## 2. What was built

**Git-native submission, end to end.** Rolling seal at `format_version: '1.2'`
(`log-core/rolling-manifest.ts`), per-session filenames so a shared `.provenance/` is add-only and
merge-conflict-free — verified experimentally: git _does_ conflict on prefix-related appends to one
shared file. Loader accepts both shapes; VS Code recorder writes on every checkpoint; server
discovers rolling-sealed scopes.

**The collaboration spine.** Contributor resolution (`analysis-core/src/identity/`), the observed
commit DAG (`src/git/observed-dag.ts`), and the `≺` relation (`src/order/happens-before.ts`).

**Reconstruction that refuses to fabricate.** `determinate` / `concurrent` / `unknown`
(`src/index/reconstruct-segments.ts`). `determinateValue()` deliberately takes **no fallback
argument** — a default parameter is how "just use the first branch" gets written unnoticed.

**External changes classified by content, not timing** (Tier 3.1,
`analysis-core/src/index/classify-external-changes.ts`). `git_merge_in` /
`git_unrecorded_in` / `external` / `unclassified`, consumed by `external_edits`,
`mass_external_replacement` and `terminal_active_during_external_change`. Only `git_merge_in`
suppresses, and only on an exact sha256 match against a state a **provably different verified**
contributor recorded on the same path — never on a clock. Reclassified events stay in the index
and in the verdict map, so nothing is hidden. Gated on a collaborative scope, so a solo bundle is
byte-for-byte unaffected. Measured: 1.3 ms on a 10k-event scope, 9.7 ms on 40k; 0.02 ms for the
solo short-circuit. The explanation tagger is **kept and is no longer a bridge** — it is the only
mitigation for solo, 1.x and unenrolled scopes, where Tier 3.1 deliberately does not run.

**Institution identity.** log-core `institution.ts`, server `students` table + `POST
/api/v1/identity/credential`, analyzer `/enroll` (no semester, no course — a static URL).

**Staff manifest composer.** `/compose/manifest`, browser-side signing, byte-identical to
`tools/sign-manifest.ts` (proven by spawning the real CLI and comparing octets).

---

## 3. Bugs found that nobody was looking for

Every one of these was live on the branch and none was on any worklist.

1. **Tamper-evidence had a hole.** `slog_sha256` / `meta_sha256` and the signed checkpoints were
   _never verified_. An appended, correctly-chained entry passed all 8 checks. Fixed as
   `log_bytes_match` + `checkpoint_chain_valid`.
2. **A recorder would quarantine its partner's log.** Startup recovery listed every `.slog`, picked
   by wall clock, and renamed what it could not validate — with no ownership check. In a shared
   repo that destroys a partner's evidence and git blames the victim. Also a free attack: corrupt
   one byte of a partner's log and their own tooling deletes it.
3. **Every `git.event` was silently discarded** on nested layouts. The ownership gate used a
   _containment_ predicate written for files, handed a git repo root that sits _above_ the
   assignment root. The whole commit-graph feature was dark for the standard 61B layout.
4. **Ingest would have destroyed every git submission's seal.** `strip-bundle.ts`'s four-pattern
   allowlist matched no rolling manifest, so every stored git bundle would lose its only signed
   manifest — permanently unverifiable, since a signed manifest cannot be regenerated.
5. **The rolling seal false-accused 5 of 5 honest scenarios** at high severity / confidence 1.0,
   with detail text reading _"This is not recoverable from a benign cause."_ Cause: prefix vs
   whole-file semantics. This is the worst class of bug this system can have.
6. **A student could paste their private master secret into `/enroll`** and ship it to the server.
   A master secret and a public key are both 64 lowercase hex, and the whole-document fallback
   extracted the single hex run. Fixed with a `provenance-secret-v1:` marker, defended at both ends.
7. **`npm run build` failed on a clean checkout.** `--workspaces` iterates alphabetically, so
   `analysis-core` built before `log-core`. CI on a fresh clone could never have passed.
8. **62 `tools/` tests ran under nothing at all** — `tools/` is not an npm workspace.
9. **Check 8 was wall-clock-decided.** "Last recorded state" was last-write-wins over wall-sorted
   sessions, so with two partners on divergent branches whoever's clock ran slow got a
   high-severity "changed outside the recording".
10. **The rolling seal's prefix coverage was keyed on the wrong id, re-arming bug 5 in full.**
    `parse-bundle.ts` resolved each seal to the log files it covers through
    `new Map(sessionFiles.map((f) => [f.sessionId, f]))` — keyed by the `.slog` **FILENAME**
    uuid — and looked it up with `seal.sessionId`, the **LOGICAL** id the seal is named after.
    Production mints those independently (`session-${randomUUID()}.slog` in `session-registry.ts`
    vs `recorderContext.session_id`), so the lookup missed on **every session of every git
    submission**. The miss was a silent `continue`, so `coverage` came out **empty for the whole
    bundle** — and empty coverage is not inert: `verify-log-bytes.ts` reads its absence as "this is
    a classic seal" and applies **whole-file** equality to a digest that only ever committed to a
    **prefix**. So `log_bytes_match` failed at high severity / confidence 1.0 on every honest git
    submission whose last seal was non-final — a crash, a power cut, a full disk, or simply an
    archive taken mid-session. Bug 5's fix was correct and was never reaching production data.
    **This is the second id-space confusion** (bug 3 was the first: a containment predicate
    written for files, handed a git repo root). **And correcting the keying did not close the
    line.** The guard read `if (files === undefined || files === 'ambiguous') continue`, and only
    the `undefined` branch was the id-space miss. The `'ambiguous'` branch — set when two `.slog`
    files carry one logical session id — reached the **identical** empty-coverage,
    whole-file-equality, high-severity outcome by a second route, and stayed live for another
    three weeks. See bug 12. The lesson worth keeping: **fixing one branch of a conditional does
    not fix the conditional.** Ask what else reaches the same `continue`.

11. **A leftover file failed a whole git submission, and the git path had no guard at all.**
    All three recorders guard the ZIP path: `sealBundle` drops an artifact the analyzer could not
    open and reports it in the seal warnings. **The git path never runs seal** — the student
    pushes, the grader clones, and whatever is in `.provenance/` on disk IS the submission — so
    that guard protected it not at all, and the leftovers it exists to catch are precisely the
    ones a git submission carries. After a crash-recovery quarantine (`chain-recovery.ts` renames
    the damaged `.slog` to `.corrupt-<ISO>` and leaves the sidecar), the stranded `.slog.meta`
    reached the loader as `orphaned_meta`, which `unzip.ts` raised as a **hard error for the whole
    bundle, before any check ran**. `loadSubmissionIndex` throws on a load failure, so every
    server read path threw with it. One leftover file cost a student every session they had
    recorded, for a crash they could not have prevented.
    Fixed in the LOADER, as a read-side mirror of the seal guard: an artifact that cannot be
    analysed is dropped from the ANALYSIS and reported on `Bundle.droppedArtifacts`. Never from
    disk — the loader only reads, and in a shared repo those bytes may be a partner's evidence.
    The loader is the right layer because it is where all three consumers converge (server
    ingest, the analyzer's in-browser `/local`, the `tools/` gates); normalising in ingest would
    have fixed one of the three, and the recorder cannot fix it at all with no seal step to hook.
    The half that is easy to miss: the dropped session's **rolling seal must be dropped with it**,
    matched on the logical session id recovered from the sidecar. Left in place it becomes a
    `no_session_log` defect, which fails check 1 at high severity with text offering "either the
    log was deleted or the seal was planted" — so degrading gracefully would have converted the
    crash into an accusation, strictly worse than the load failure it replaced.

12. **The ambiguous rolling seal: silent, and accusatory, through the same line as bug 10.**
    `parse-bundle.ts`'s coverage guard dropped a seal whose logical session id was claimed by two
    `.slog` files — reachable by duplicating a log under a second filename: a hand copy of
    `.provenance/`, a backup taken before a push, an odd merge. The `continue` recorded **no
    defect**, so a genuine ambiguity the loader had detected was reported to nobody; and it
    recorded **no coverage entry**, which is not inert — `verify-log-bytes.ts` reads absent
    coverage as "classic seal" and applies **whole-file** equality to a non-final rolling digest
    that only ever committed to a prefix. `log_bytes_match` therefore failed at **high severity,
    confidence 1.0** with text asserting the log was modified after sealing, against a student
    whose only act was keeping a copy of their own directory. Bug 5, bug 10 and this are the same
    accusation reached three ways.
    Fixed by answering the seal rather than abandoning it. The loader keeps **every** `.slog`
    claiming an id and resolves the seal on what they **agree** about (`resolveAmbiguousCoverage`).
    Unanimity is an answer whichever file the seal was written over — and that deliberately
    includes a unanimous `no_match`, because "no file in this bundle claiming this session
    reproduces the sealed digest" is established regardless. Over-correcting was the real hazard
    here: if ambiguity always suppressed the verdict, appending to a `.slog` and copying it under a
    second filename would **switch `log_bytes_match` off**. Only genuine disagreement yields the
    new `indeterminate` coverage, which is read as **"we cannot check"** — the distinction
    `isIdentityCheckFailure` and `classify-external-changes.ts`'s `unclassified` already draw —
    never as a fallback to whole-file equality, and never silently: the digests it could not check
    are named in the check's own verdict text, and the ambiguity itself is a new
    `ambiguous_session_log` defect naming both files.

13. **`no_session_log` asserted a cause the evidence cannot reach.** A rolling seal whose `.slog`
    is not in the bundle failed check 1 with text offering _"either the log was deleted or the seal
    was planted"_. On the git path that is not established and is not even the likeliest reading: a
    partner who committed `.provenance/manifest-<id>.json` before their `.slog` landed, or whose
    `.slog` is caught by a `.gitignore`, produces the **identical** archive. An innocent partial
    push was being described to a grader as deletion or planting, at high severity, in a string
    persisted to `check_1_detail`.
    The finding is **kept**, and the severity is **kept** — a signed claim that can never be
    verified is a real hole in the record, hiding it would fail toward fewer findings, and the only
    lever available for lowering it is check 1's `manifest_sig` mapping, which is shared with
    genuine signature forgery. Lowering that to soften one defect would weaken the strongest
    detection in the check. What is wrong is not the severity of the gap but the **confidence of
    the interpretation**, and that is fixed in the text, exactly as D16 did for `git_unrecorded_in`:
    it now separates what is established (the seal is here, the log it names is not, so its
    signature can never be checked against any session key) from what is not (which of several
    readings applies), names the innocent reading alongside the others, and says what would settle
    it. **It is not fully resolvable here.** Nothing in an archive can distinguish a log that was
    never pushed from one that was removed. Only peer witnessing (`peer.observed`, Tier 4, a
    tri-repo format change, not built) can prove a log existed, and the text says so rather than
    implying the system could close the gap today.

### Why no test caught bug 10 — and the fixture rule that stops the next one

Nothing was wrong with the assertions. **Every fixture in the repo spelled both uuids with the
same value**, so the broken lookup hit and the honest reading came out. 972 `analysis-core` tests
and the `tools/recorder-seal-conformance` gate — the gate that exists precisely to drive real
recorder output through the real loader — were all green over a live maximum-severity false
accusation.

A fixture that cannot distinguish two ids **cannot fail on confusing them**. That is a property of
the fixture, not of the tests written against it, and no amount of extra assertions recovers it.

**The rule, now enforced by construction:** any fixture that produces a session gives its `.slog`
filename a uuid that **differs** from its logical `session.start` id **by default**
(`build-test-bundle.ts`'s `fakeLogFileUuid`, `recorder-seal-conformance`'s `logFileUuid`). A test
that needs them equal must pass `fileUuid` explicitly, which makes it a visible claim in the diff.
Generalised: **when two identifiers are the same shape and different values in production, a
fixture that makes them equal is not a simplification — it deletes a bug class from the reachable
test space.**

**Follow-through, 2026-08-20.** The rule now holds everywhere a fixture is produced. The four
remaining generators — `server/scripts/seed/build-example-export.ts`, `gen-large-fixture.ts`,
`bench-stages.ts`, `profile-large-bundle.ts` — mint a distinct log-file uuid by default, so the
**demo database no longer contains A === B bundles**; anything a person or a test checks against
the seed data can now reproduce an id crossing. Verified by mutation: reverting any one of them to
a shared id is caught by `verify-log-bytes.test.ts`'s "does NOT accuse the same append when the
seal is not final" (the bug-10 regression) and by the new
`loader/orphan-guard-git-path.test.ts`, which asserts a dropped sidecar's logical id differs from
its filename uuid. `tools/export-conformance-vectors.ts` is deliberately NOT changed: its A === B
filename is published to provjet and provnvim as a negative-match string, and perturbing a vector's
bytes is a breaking tri-repo change, not a refactor. It teaches the wrong shape and should be
corrected the next time those vectors are legitimately regenerated.

### Why no test caught bug 12 — a test that pinned the bug as the requirement

Here the fixture rule would not have helped, and nor would another assertion. A test **existed**
for the ambiguous branch — `parse-bundle.test.ts`, _"refuses to guess when two .slog files carry
the SAME logical session id"_ — and it asserted `coverage` came out `[]`. That is the exact shape
`verify-log-bytes.ts` reads as a classic whole-file commitment, so the test pinned the false
accusation **as the requirement**, complete with a comment explaining that refusing "leaves
whole-file equality in place — the same reading a classic bundle gets", which was written as a
safe fallback and is in fact the strictest possible reading of a prefix commitment.

**A test can be green, deliberate, well-commented and still be the bug.** The tell is available
without leaving the file: an assertion about an ABSENT value is only meaningful if you know what
the consumer does with absence. `coverage` is optional, and optional-means-classic was documented
three modules away. Any assertion of the form "we correctly record nothing" should be read as a
question — nothing is read by whom, as what?

The fix goes further than correcting the lookup: the filename id space is now a branded
`LogFileId` and `SessionFiles.sessionId` is renamed `logFileId`, so the original line is a
**compile error** (`Map<LogFileId, _>.get(string)`). Reintroducing it takes a deliberate cast —
verified by mutation. The brand is deliberately narrow, covering only `loader/`, the one place
both spaces are in scope at once; branding the logical id too would reach into `log-core`'s frozen
manifest shape and every read path in `analyzer` and `server`.

---

## 4. Traps — these will bite again

- **Worktrees are created from `main`, not the feature branch. 20 of 20 times.** Every agent must
  verify branch + ancestor and hard-reset before touching anything.
- **Worktrees have no `node_modules`**, and `@provenance/*` symlinks resolve to the MAIN checkout —
  so a worktree agent's tests can silently run against a different tree and report green. Run
  `npm ci` in the worktree; **re-verify in the main tree after every merge**.
- **Check your shell's cwd before trusting a verification run.** A `cd` into `packages/server` that
  persisted made `npm run build/typecheck/lint` report a false clean. Empty test output was the tell.
- **`npm run test --workspace=packages/X`, never `--root packages/X`.** `--root` bypasses package
  config: the recorder loses its `vscode` alias (4 suites fail to import) and the analyzer denies
  `docs/heuristics.md`. Both look like real failures and are not.
- **Never the bare root `npm run test`** — server testcontainers thrash the machine.
- **The server suite buffers to nothing without a TTY.** Use `--no-file-parallelism
--reporter=verbose`, budget >10 min. An agent lost 2h20m to a run that looked wedged and wasn't.
  (`--reporter=basic` does not exist in vitest 4.)
- **The server suite has genuine flakes** under testcontainers contention — different files fail on
  different runs and pass in isolation. Always re-run a failing file alone before calling it a
  regression. Never run two server suites concurrently; ~37 containers produces MinIO 503s that
  look exactly like real bugs.
- **`npm run build` before `npm run typecheck`**, and build `log-core` explicitly first — a stale
  `dist` produces confusing phantom errors downstream.
- **Explicit pathspec on every `git add`.** `docs/pilot-feedback-survey.txt` is the user's untracked
  work and must never be staged.
- **Two concurrent agents will claim the same migration number.** It happened: both took `0026`.
  Git merges the `.sql` files silently because the filenames differ, so the only signal is a
  conflict in `db/migrations/meta/_journal.json` — and if that had merged cleanly, two migrations
  would have shared an index and applied in **undefined order**. That works on an
  already-migrated database and corrupts a fresh deploy. Assign numbers explicitly when
  dispatching, make each agent state the number it used, and after resolving a renumber assert the
  journal for unique+ordered `idx` and monotonic `when`, then **apply the chain against a live
  database** — a filename renumber that leaves ordering broken passes every unit test.
  Current chain: `0026` ingest scope submission types · `0027` student_credentials ·
  `0028` ingest_jobs.skipped.
- **Conformance vectors are a tri-repo contract.** A change that perturbs an existing vector's bytes
  is a breaking change to provjet and provnvim, not a refactor. `golden-bundle.{json,zip}` is
  genuinely non-deterministic; leave it at committed bytes.
- **Identity vector updates must land in the SAME change as each repo's chain-walk port.** Splitting
  them leaves a sibling repo half-migrated, which is worse than un-migrated. (Learned the hard way:
  regenerating vectors for an unrelated task broke 3 provnvim tests.)

---

## 5. Method that is working — keep it

**Mutation testing is not optional.** Every agent must break its own implementation one line at a
time and prove specific tests go red. This repeatedly caught tests that looked fine and proved
nothing:

- an agent's own IRB no-author-identity test was not load-bearing (the hostile fixture spelled the
  field `authorEmail`, the test checked `author_email`);
- clock-skew tests were decorative because the fixtures carried no `wall` field;
- a detection computed correctly but never became a Flag — all 30 verifier tests passed anyway;
- two enrollment tests were vacuous because the challenger's email did not match the roster row.

**Composition testing catches what unit tests structurally cannot.** The `tools/` gates
(`recorder-seal-conformance`, `enrollment-paste-conformance`, `manifest-composer-conformance`) drive
real producers through real consumers. `tools/` is the one place allowed to span both dependency
graphs — it has no `package.json`, so no package acquires an edge.

**Agents should refuse bad instructions.** Several did, correctly: one proved `not_on_roster` was
not a deletable check (FK + NOT NULL made the roster row load-bearing); one refused to re-key
`globalIdx` and explained why the spec was wrong; one refused to compare a contributor's own
sessions across a partner's commit because that manufactures the accusation the task removes.

---

## 6. State and what is owed

Suites:
**log-core 541 · analysis-core 1020 · recorder 583 · analyzer 1287 · tools 174 ·
server 1488/1490 (2 testcontainers flakes) · provjet 589 · provnvim 1007.**
The analyzer figure carried here as `1223` was stale — branched replay took it
to 1298 before the coverage stage landed. analysis-core 1001 → 1020 and analyzer
1298 → 1287 are the SAME move, not a loss: the 16 fact-level tests relocated to
`analysis-core` with the code they now cover, and 7 were added (the partition
property, determinism, the always-visible and not-available states, and the
`unverifiable` ≠ `unattributed` counts test mutation testing turned up).
Server not re-run: no server code was touched.
The first five re-measured 2026-08-20 after the read-side orphan guard (bug 11);
analysis-core 973 → 988 and analyzer 1221 → 1223 are the guard's own tests plus
the id-space regressions. analysis-core 988 → 1001 is bugs 12 and 13: the
ambiguous-seal coverage tests, the duplicated-log verdict tests (including the
over-correction guard), and the `no_session_log` wording regression.
provjet and provnvim are carried forward and not re-measured since.
Server was re-measured too: the carried-forward `1420/1422` was stale (the real
total had grown to 1490). Both failures in the full run were
`Timed out after 10000ms while waiting for container ports to be bound to the
host` — `cohort.test.ts` (a known flake) and
`load-index.contributors.test.ts` (a new one) — and both files pass in
isolation, 27/27 and 8/8. Infrastructure, not logic.
Build, typecheck, lint clean. Branch ~145 commits, ~+50k lines vs `main`.

### Gating merge to `main`

1. **provjet and provnvim** need the rolling-seal write side and the 2.1 identity port. The monorepo
   shipping 2.1 while sibling recorders emit 2.0 is exactly the version skew the "readers before
   writers" rule exists to prevent.
2. **One consolidated `/architecture` diagram pass.** Nine nodes are owed and no `.dot`/`.svg` has
   been touched all session (deliberately — concurrent agents would collide):
   `contrib`, `dag`, `order`, `recon`, `v8` on `analysis.dot`; `students` on `er.dot`; a contributor
   -stamp node on `readpath.dot`; a `recorder.dot` `explain` reshape; and `/enroll` + `/compose/manifest`
   route nodes on `master.dot` / `ecosystem.dot`. Node _detail_ cannot be authored before the node
   exists — `nodes.coverage.test.ts` fails on metadata for a node no SVG contains.

### Definition of done

The system is finished when every row is true. Update this table as rows land — it is the
completion contract, not a wish list.

| Area                          | Done when                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Format**                    | Rolling seal + `final` implemented in **all three** recorders, each passing the shared `rolling-manifest` vector unmodified.                                                                                 |
| **Identity**                  | 2.1 chain walk ported to **all three** recorders, each carrying its own `enrollment.json` + `identity.json` vector updates **in the same change**.                                                           |
| **Cross-implementation gate** | Each recorder produces a real bundle that the real `loadBundle` + `runValidation` accepts. This is the only test class that has ever caught a defect the producing repo's own suite asserted was impossible. |
| **Collaboration**             | Contributor resolution, DAG, `≺`, segmented reconstruction — all landed — plus external-change reclassification, contributor-keyed heuristics, and the contributor schema cut-over.                          |
| **No false accusations**      | Every high-severity flag reachable by honest pair work has been driven by a test that proves it does _not_ fire. This is the bar the whole programme is judged against.                                      |
| **`/architecture`**           | Zero owed nodes; `nodes.coverage.test.ts` green; diagrams regenerate deterministically.                                                                                                                      |
| **Verification**              | Every suite measured in the MAIN tree, server flakes distinguished from regressions by isolated re-runs, migration chain applied against a live database.                                                    |

### Remaining work

- ~~Branched replay UI (Tier 5.3), including surfacing a suppressed concurrent overlap as a
  **visible fact**.~~ **DONE 2026-08-20.** See "The coverage stage" below — and read the
  correction there before repeating the briefing that was given for it.
- `submission_contributors` cut-over (D9), per-contributor heuristic scoping, `Flag.contributor_id`.
- Peer witnessing (`peer.observed`) — tri-repo format change.
- The repository discriminator (D12) as a signed-format change, with vectors.
- ~~provjet has no automated cross-implementation gate.~~ **DONE 2026-08-20.**
  `provjet/scripts/e2e/run_e2e.sh` + `verify-bundle-with-analyzer.mjs` now drive real
  JetBrains-produced archives (classic **and** rolling) through the real monorepo
  `analysis-core`; verified green. **All three recorders now have one**, and each has already
  caught something its own repo's suite could not: provnvim's found the orphaned rolling seal,
  provjet's found that shipping code the log never saw left the Gradle suite BUILD SUCCESSFUL
  while the gate went red, and the VS Code one found the seal path packing unopenable bundles.

### Landed 2026-08-20 — the id-space strings

All four staff-visible strings that named an id no file carries are fixed. Each sat on a FAILURE
path, where a staff member greps the archive for the id we printed and finds nothing — the tool's
own report unverifiable by inspection, at the one moment someone checks.

| Where                                                | Was                                                       | Now                                                                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loader/rolling-seal.ts` `no_session_log`            | `…but no session-<LOGICAL id>.slog is present`            | `…but no .slog in this bundle records that session` + names the space explicitly. Keeps `manifest-<id>.json`, which genuinely is named after the logical id. |
| `analyzer/views/load/ErrorPanel.tsx` `orphaned_meta` | `Session <FILE uuid> has a .slog.meta file…`              | `The file session-<uuid>.slog.meta is present, but its log session-<uuid>.slog is missing.`                                                                  |
| `ErrorPanel.tsx` `orphaned_slog`                     | same mislabel, separate literal — **this was the fourth** | names the file, same as above                                                                                                                                |
| `server/ingest/parse-bundle-phase.ts` `errorDetail`  | `sessionId: <FILE uuid>`                                  | `log file: session-<uuid>.slog (.slog filename uuid, not a session id)`                                                                                      |

Also reworded `errorDetail`'s `session_id_mismatch` branch: bare `slog=` / `meta=` read as "the
file is called this", sending a grader after filenames that do not exist, even though both values
genuinely are logical ids.

**Mutation testing was the whole value here.** Reverting each string to its old wording left every
suite green — all three fixes were unpinned, and a fix nothing can fail on is not a fix. Each now
has a regression test. `errorDetail` is exported for that reason: its output is persisted to
`ingest_files.error.detail` and read by staff, so the wording is contract, not internal.

**Reachability, flagged rather than acted on.** With the loader no longer failing a bundle on
either orphan shape, `LoaderError.orphaned_meta` / `orphaned_slog` are no longer produced. The
variants and their renderers are kept: `LoaderError` is the declared vocabulary of loader failures
and the server persists these `cause` values in `ingest_files` rows that outlive the change. Whether
to delete them outright is a separate call.

### Landed 2026-08-20 — the coverage stage, and a briefing premise that was wrong

**The correction, first, because the next person will be told the same thing.** The agent that
built the branched-replay UI was briefed that `multiple_sessions_overlap` "already populated
`detail` fields for suppressed pairs", so the fact only needed reading out. **That was wrong, and
the agent said so rather than building on it.** The suppression was
`if (comparison === 'different') continue;` at `multiple-sessions-overlap.ts:221` — taken _before_
`pairId`, before `emittedPairs`, and before the `detail` object existed. Those fields appear only on
**fired** flags, where `contributorComparison` can never be `'different'`. `run()` returns
`Flag[]` and nothing else; there was no side channel. A suppressed concurrent overlap therefore
produced **no flag and no fact** — exactly the gap the coverage panel exists to close, and the
reason the panel could not simply consume the heuristic.

Lacking the primitive, that agent **recomputed the overlap in the analyzer** and defended the
duplicate with a partition test driving one bundle through both implementations. The test was good.
The duplicate was still wrong — two implementations that agree today drift later, which this repo
has already paid for as "26 vs 25 flags" and "21 vs 25 tables".

**The stage now exists where §5.4 step 5 puts it**, in `analysis-core`:

- `coverage/session-overlap.ts` — the ONE enumeration of overlapping session pairs and the ONE
  `'different'` decision, returning a partition `{ judged, collaboration }`.
- `coverage/coverage-facts.ts` — the stage proper: concurrent recording, identity counts +
  `rootKeyConfigured`, commit-graph coverage, DAG defects, the single-repository caveat,
  unattested rolling-seal tails, `droppedArtifacts`.

`multiple_sessions_overlap` consumes `judged`; the coverage stage consumes `collaboration`. Its
BEHAVIOUR is unchanged — same pairs, same severity, same ids, description and `detail` — and all 28
of its existing tests pass untouched.

**Drift is now prevented by the type system, not by a test that compares two copies afterwards.**
`JudgedOverlap.comparison` is typed `'same' | 'unknown'`, so a suppressed pair is not merely
filtered out of the heuristic — it is **unrepresentable** there. `CollaborationOverlap` carries
`attributed` contributors, so an `unverifiable` or `unattributed` session is unrepresentable in the
coverage stage, which is the `unverifiable` ≠ `unattributed` rule enforced by the compiler rather
than by care. Verified by mutation: re-adding a local `if (comparison === 'different') continue;`
to the heuristic is **TS2367, a build failure**, not a silent divergence. The partition property
itself (disjoint, exhaustive over the overlapping pairs) is asserted directly, which is a smaller
and stronger claim than "two copies still match".

**The panel moved to the submission level.** It shipped inside the Replay tab, collapsed by
default, which failed §6 Rule 3 twice — a tab is not "always visible" and a collapsed panel is not
visible at all — and mis-scoped the facts: dropped artifacts, unattested seal tails, "no root key
configured" and "these two contributors recorded concurrently" describe the **submission**, not the
replay. It is now `analyzer/src/views/coverage/CoveragePanel.tsx`, mounted above the verdict
surfaces on both overview surfaces (server-backed `views/submission/Overview.tsx` and `/local`
`views/overview/OverviewView.tsx`). Rule 3 says a panel _per scope_, so there is one — those two
are one view with two implementations, not two places to look. No route was added, removed or
re-scoped, so this is not an `/architecture` route trigger.

"Always visible" means answering in all three states, because silence and "nothing to report" are
different claims: **no bundle** → "not available", **never zeroes** (the server route has API rows
and no parsed bundle, and a zeroed panel asserts "no commits observed, no contributors, no root
key" — stronger and false); **nothing to note** → says so, in the neutral palette; **facts** → the
sections.

**What the server would need for parity, NOT built.** `packages/shared` still has zero occurrences
of "contributor" while `load-index.ts:181` stamps them on every server read path — so the facts
exist server-side and cannot cross the wire. Closing it is additive and small, and it is the reason
the server-backed panel says "not available" rather than showing real facts:

1. A `coverage` object on `SubmissionSummarySchema` (`api-schemas.ts:906`), which already carries a
   `sessions[]` array derived from the same `loadSubmissionIndex` call — so the data is in hand at
   the exact call site and costs no extra parse.
2. Serialize `coverageFacts(bundle, index)` in the summary route. It is already pure and
   isomorphic; nothing new is computed.
3. `CoveragePanel` then takes facts directly rather than a `Bundle`, and the `bundle === null`
   branch narrows to "the server did not send them" instead of "this view cannot compute them".

The `ReadonlyMap` in `BundleContributors` does not serialize, so the wire shape must be the
`CoverageFacts` aggregate (plain arrays and numbers), never `BundleContributors` itself.

**Mutation testing earned its keep again**, and found an unpinned distinction nobody was looking
for: collapsing `unverifiable` and `unattributed` into one summed "not attributed" count in the
panel passed **every** existing assertion. The only test touching that copy drove the no-root-key
branch, which renders a different paragraph entirely, so the counts line was never pinned. Fixed
with a test that needed a fixture the repo did not have — an identity block that IS present and
does NOT verify on a deployment whose root key IS configured, built via `buildInstitutionIdentity`'s
`certSignedBy` so the anchor is not root-signed.

### Known gaps, deliberately accepted

- **Neither-partner-enrolled** leaves shared-repo ownership undecidable; the quarantine and
  `prev_session_id` defects remain reachable in exactly that configuration. Closing it needs
  enrollment or peer witnessing.
- **`prev_session_id` is still set only on the dangling path**, so §7 mechanism 1 cannot detect
  removal of a cleanly-ended session. Changing it alters solo semantics — a product call.
- **Multi-repo scopes are unsound** until D12 lands. `observed-dag.test.ts` contains a test that
  _deliberately asserts the unsound answer_, named `KNOWN LIMITATION`. Keep it live rather than
  skipping it: it will fail loudly when the discriminator lands and force an update.
- **`markFormatter()` has no production caller**, so `explanation: 'formatter'` is unreachable
  despite PRD §4.5 promising it. D16 is therefore scoped to the `'git'` tag only — `'formatter'`
  is a narrower claim the decision does not reach, and no shipped bundle can carry it anyway.
- **D16 flags honest pairs whose partner was not recording.** Their genuine work arrives as bytes
  nobody recorded, which is `git_unrecorded_in` by definition. Accepted on the user's decision, and
  handled by text rather than by score: the flag establishes only that the content has no recorded
  authorship _in this scope_ and says so. Enrolment coverage is what actually closes it.
