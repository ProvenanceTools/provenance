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
| D12 | **Repository discriminator = root-commit sha.** Reader half landed 2026-08-20; the writer half is deliberately outstanding.                                                                                                                                    | Both partners on one repo derive the same value offline, which is what makes cross-contributor DAG correlation possible. A submodule has a different root commit, so it discriminates correctly.                                                                                                                                                                                                                                                                                                                                                                                             |
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

- **Worktrees are created from `main`, not the feature branch. 22 of 22 times.** Every agent must
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
  `0028` ingest_jobs.skipped · `0029` submission_contributors.
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
**log-core 619 · analysis-core 1073 · recorder 583 · analyzer 1287 · tools 174 ·
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
2. **One consolidated `/architecture` diagram pass.** Ten nodes are owed and no `.dot`/`.svg` has
   been touched all session (deliberately — concurrent agents would collide):
   `contrib`, `dag`, `order`, `recon`, `v8` on `analysis.dot`; `students` **and
   `submission_contributors`** on `er.dot`; a contributor-stamp node on `readpath.dot`; a
   `recorder.dot` `explain` reshape; and `/enroll` + `/compose/manifest`
   route nodes on `master.dot` / `ecosystem.dot`. Node _detail_ cannot be authored before the node
   exists — `nodes.coverage.test.ts` fails on metadata for a node no SVG contains.
   Existing nodes whose detail the D9 cut-over made WRONG were corrected in place (er.dot
   `roster_entries` / `submissions` / `ingest_files`; ingest.dot dedup, version allocation and the
   Gradescope stage), because that needs no new node.

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
- ~~`submission_contributors` cut-over (D9), `Flag.contributor_id`.~~ **DONE 2026-08-21**, see
  below. **Per-contributor heuristic scoping is still owed** — heuristics still run ONCE over the
  whole scope; what landed is per-contributor ATTRIBUTION and SCORING of the resulting flags.
- Peer witnessing (`peer.observed`) — **reader half DONE 2026-08-20** (see below). The
  **writer half is deliberately not built**: the directory watcher in the three recorders.
  ~~and the `session.start` witnessing-availability capability report §5.6 item 3 calls for.~~
  **That report is DONE 2026-08-21** — see "the three `session.start` capability reports" below.
- The three `session.start` capability reports (§5.6) — **reader + VS Code writer DONE
  2026-08-21** (see below). The **provjet and provnvim ports are outstanding**, to the writer
  contract recorded below.
- The repository discriminator (D12) — **reader half DONE 2026-08-20** (see below). The
  **writer half is deliberately not built**: deriving and emitting `root_commit_sha` in the three
  recorders, to the writer contract recorded below.
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

### Landed 2026-08-20 — peer witnessing, reader half (Tier 4.1 + 4.3)

Readers before writers, exactly as Manifest 2.0 and the rolling seal did. **No recorder emits
`peer.observed`, and none should until the writer contract below is taken.**

**The event kind.** `peer.observed`, in `EventKindMap`, with the shape §5.5 pins:
`{ file, sha256, bytes, session_id, seq_high, last_hash, state }` where `state` is
`appeared | grew | shrank | disappeared | unparseable`. The three foreign-chain reads —
`session_id`, `seq_high`, `last_hash` — are nullable **permanently**: `null` means "the recorder
could not read this", which is not a value. There is no student ref, no key, no git author and no
path outside `.provenance/`; the payload names a FILE and a CHAIN POSITION, and a test pins the key
set so it cannot widen by accident.

**Compatibility, both directions.** An older reader is unaffected — `parseEntries` does not reject
unknown `kind` values (PRD §5.1) and the chain is computed over the envelope without interpreting
`data`, so the entry parses, chains and validates. A newer reader meeting a bundle with none is
unaffected, which is every bundle in existence.

**The five verdicts.** Reconciled against the logs actually present, one witness yields five
DIFFERENT facts, and collapsing any two is a wrongful accusation:

| verdict         | means                                            | may it be evidence?                                                                 |
| --------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `corroborated`  | present, reaches the witnessed seq, hash matches | no — it is the clean case                                                           |
| `absent`        | witnessed, no log for that session in the bundle | **no.** Suspicious only in combination — a partner who has not pushed produces this |
| `short`         | the log stops before the witnessed seq           | yes, subject to authority                                                           |
| `tip_mismatch`  | reaches the witnessed seq with a different hash  | yes, subject to authority — the strongest signal here                               |
| `indeterminate` | we cannot check                                  | no                                                                                  |

Plus `unwitnessed`, tracked per SESSION rather than as a verdict so it cannot acquire one by
accident: a present log no witness names. **This is the ordinary case** — no recorder emits the
kind — and it is entirely blameless.

**`sha256` is deliberately NOT the corroboration test.** A foreign log is append-only and its owner
keeps recording, so the bytes a witness saw are normally a PREFIX of the bytes finally committed:
digest inequality is the NORMAL case. Comparing digests instead of chain positions is the
prefix-versus-whole-file error behind bugs 5, 10 and 12, and a test drives exactly that shape and
requires `corroborated`. `seq_high` + `last_hash` are the commitment; `seq_high` alone would make
truncation detectable only by LENGTH, which a forger can match.

**Trustworthiness follows the witnessing session's identity**, because a witness is a claim about
somebody else's artifact and is worth exactly what the chain carrying it is worth: `attributed` →
`established`, `unattributed` → `inferred`, `unverifiable` → `unknown`. `unattributed` is graded as
real evidence on purpose — that chain still verifies, and downgrading it would discard honest
evidence from every unenrolled student, the majority case today. `isWitnessAlterationEvidence` is
the single gate, and it excludes both `absent` and any `unverifiable` witness. **Nothing here ever
names a person**: a witness establishes that a LOG was altered, never who altered it (§5, S26).

Two witnesses that prove nothing are excluded rather than counted — a **self-witness** (a chain
cannot corroborate itself) and one about another session of a **proven same contributor** (not
independent). The latter fires only on `compareContributors === 'same'`, so an unproven
relationship can never discard evidence.

Two `.slog` files claiming one logical id resolve on what they **agree** about, with genuine
disagreement going to `indeterminate` — the answer `resolveAmbiguousCoverage` already settled for
bug 12, rather than falling through to the harsher branch.

**This is what finally distinguishes a partner's-seal-without-log from a deletion.** Bug 13 fixed
`no_session_log`'s wording and said explicitly that nothing in an archive can tell a log that was
never pushed from one that was removed, and that only peer witnessing could. That evidence now has
a reader. An `absent` verdict names the log the seal names; combined with the seal it is the pair
that separates the two readings — and, correctly, `absent` on its own still is not a finding.

**No `Flag`, no ninth check, no severity, no score.** Facts only. What a grader is shown, and in
what wording, is a §6 presentation decision that belongs with the contributor schema.

**Floor placement — flagged, not settled.** `peer.observed` is on `FLOOR_EVENT_KINDS`. The stated
floor test points the other way (it is the most privacy-sensitive signal in the protocol, being the
only one describing a DIFFERENT student's artifact, and sensitivity argues FOR a knob), and §8 item
5 — is one student's recorder hashing another's log inside the approved protocol? — is **open**.
It is floor because §5.6 item 3 already assigns the disambiguation elsewhere: whether witnessing was
AVAILABLE is a `session.start` capability report, alongside `git_capture`, not a capture knob. A
capability report says "I could not"; a knob says "I was told not to". Adding a `policy.capture` key
now would publish a course-SIGNED manifest field to two sibling repos ahead of the decision that
gives it meaning — the readers-before-writers inversion §9 forbids. **If §8 item 5 comes back
requiring a per-course off switch, move the entry to `POLICY_GATED_EVENT_KINDS` with a
`peer_observation` key, in the same change as the recorders' watcher.** Nothing emits the kind, so
today the placement governs nothing.

**Vector drift**, verified by regenerating before and after: `peer-observed.json` is new;
`capture-policy.json` gains **one line** (`floor_event_kinds` appends `peer.observed`);
`golden-bundle.{json,zip}` differ for the known pre-existing reason and were confirmed to differ
across two runs with NO change at all; every other vector is byte-identical. Adding an event kind
**necessarily** perturbs `capture-policy.json`, because that vector publishes the complete kind
partition — floor was the minimal spelling, since a knob would also have moved `defaults`,
`policy_gated_event_kinds` and every `expected` object. Nothing was written into the sibling repos.

### The writer contract — what the three recorders must emit

Written down here so the ports are mechanical rather than re-derived three times.

> **CORRECTIONS FROM THE FIRST IMPLEMENTATION (VS Code, 2026-08-20).** The contract below was
> written from the reader side, before anything emitted the kind. Implementing it surfaced seven
> gaps. **provjet and provnvim must follow these, or three recorders will describe one event three
> different ways** — which is precisely the divergence the shared vectors exist to prevent.
>
> 1. **The five `state` values do not partition reality.** A same-length rewrite is neither `grew`
>    nor `shrank`. VS Code reports `grew` and emits `bytes` alongside, so a reader can see the
>    length did not change. `shrank` is described in the vectors as "catches a truncation", so
>    reaching for it here would lean a _descriptive_ field toward accusation. **Ports must make the
>    same choice.**
> 2. **An unchanged file must NOT be re-emitted.** The contract never said. Emitting
>    unconditionally re-witnesses every partner log at every checkpoint, forever.
> 3. **`disappeared` requires a prior observation.** "Carries the last state seen" is unreachable
>    if you never saw it; a delete for a never-observed file has no honest digest. Skip.
> 4. **A local read failure is not an absence.** `EACCES`/`EIO` is a fact about _your_ machine, not
>    the partner's file. Emit nothing. Only `ENOENT`/`ENOTDIR` may reach `disappeared`.
> 5. **`state: 'unparseable'` REQUIRES all three chain fields null.** Item 6 below says they are
>    all-null or all-non-null, which is true but incomplete: a port emitting `grew` with all-nulls
>    passes the narrowing while violating the intent. Route every unreadable chain to `unparseable`.
> 6. **Item 3's "or a timer, whichever is later" is ambiguous and reads backwards** — running both
>    gives whichever is _sooner_. VS Code wired checkpoint + dispose and no timer: a long-idle
>    session delays witnessing but never loses it, because dispose always drains.
> 7. **`rev-parse --is-shallow-repository` needs git ≥ 2.15.** Older git errors out, which lands in
>    "omit on any failure" — correct, but ports should know that is the mechanism rather than
>    treating it as a special case.
>
> Also settled while implementing: only `*.slog` is witnessed (not `.slog.meta`, not rolling
> manifests — the payload's chain fields are by definition reads of a `.slog`), and the recorder
> may **spawn git** for the discriminator (`execFile`, no shell, fixed args, 5s timeout, injectable
> seam), approved by the product owner 2026-08-20 because the VS Code git API cannot walk
> first-parent lineage and the alternative is thousands of async calls at activation.

1. **One `FileSystemWatcher` on the `.provenance/` directory**, not one per file, and distinct from
   the `files_under_review` watchers.
2. **Callbacks enqueue a filename and return.** No I/O, no hashing, no parsing on the callback —
   the `<1 ms` p99 budget dies otherwise.
3. **Drain on the checkpoint cadence** (every 100 entries) or a timer, whichever is later, rate
   limited to at most one observation per file per interval. Same drain point as the rolling seal.
4. **Exclude the recorder's own files by path.** A self-witness is circular; the reader excludes it
   anyway, but a recorder must not produce it.
5. **Never rename, rewrite, or delete a foreign file.** `state: 'unparseable'` is the entire
   response to one that cannot be read. This was a live defect once (bug 2).
6. **Emit `null` fields explicitly.** Omitting them changes the canonical bytes and therefore the
   chain hash. `session_id` / `seq_high` / `last_hash` are all-null or all-non-null; a payload with
   some of them is rejected by every reader.
7. **`seq_high: 0` is legal** — a foreign log holding only its `session.start`. A truthiness check
   turns the shortest honest witness into a malformed one.
8. **`sha256` is lowercase hex** over the file's exact bytes at observation time, and `bytes` is
   that file's length. Both are corroborating detail; the chain fields are the commitment.
9. **`state` is descriptive, never a verdict.** `disappeared` is not misconduct — a checkout or a
   stash removes a partner's `.slog` from the working tree — and its digest and chain fields carry
   the LAST state seen, which is what makes the observation evidentiary.
10. **Also owed, and not part of this kind:** the `session.start` witnessing-availability capability
    report (§5.6 item 3), without which "no witnesses" cannot be told from "witnessing was
    impossible". The reader treats `unwitnessed` as blameless either way, so shipping the watcher
    first is safe, but the pair is what makes the absence-vs-disabled rule hold.

Conformance: `peer-observed.json`, thirteen cases, each publishing the narrowing verdict alongside
the canonical bytes and chain hash so a port asserts **accept and reject**, not only the happy path.

### Landed 2026-08-20 — the repository discriminator, reader half (D12)

Readers before writers, exactly as Manifest 2.0, the rolling seal and peer witnessing did. **No
recorder emits `root_commit_sha`, and none should until the writer contract below is taken.**

**The payload field.** `GitEventPayload.root_commit_sha?: string` — the repository's root-commit
sha, lowercase hex, 40 characters for a sha-1 repository or 64 for sha-256. The narrowing is
`log-core/git-event.ts`'s `readRepositoryDiscriminator`, in log-core rather than in the reader for
the same reason `peer-observed.ts` is: four consumers need identical rules — this monorepo's
analyzer and server through `analysis-core`, plus the two sibling recorder repos, which need them
to EMIT conformant payloads.

It returns **three** answers, not two, and the third is what makes the second safe:

| answer      | means                            | consequence                                                         |
| ----------- | -------------------------------- | ------------------------------------------------------------------- |
| `absent`    | no field (or an explicit `null`) | folded into `ASSUMED_SINGLE_REPOSITORY` — exactly today's behaviour |
| `recorded`  | a usable root-commit sha         | its own repository key, `repository:<sha>`                          |
| `malformed` | present and not a commit sha     | folded in with the unlabelled ones, and **counted**                 |

`absent` and `malformed` reach the same repository and are still different variants on purpose: one
is a recorder with nothing to say, the other a recorder that said something wrong, and only the
second is worth counting. **Neither is ever a finding.**

**Why the value's SHAPE is checked when `readSha` deliberately checks nothing.** The jobs differ. A
`sha` is only compared for equality against other recorded shas, and normalizing there could merge
two genuinely distinct commits. This value is a NAMESPACE KEY and a privacy boundary: S14(b) forbids
the repository path and the remote URL precisely because a path is arguably an identifier and a
remote URL embeds the org and often the student's own username. The shape check is the one place a
nonconforming writer's path or URL can be stopped before it reaches a staff-facing UI. Rejecting
costs only correlation — the observation still lands, unlabelled.

**Compatibility, both directions.** An older reader meeting the new field is unaffected: `git.event`
payload readers ignore keys they do not know, the chain is computed over the envelope without
interpreting `data`, and every field on this payload is optional permanently (1.x support is
permanent, program spec §9). A newer reader meeting a bundle without the field is unaffected, which
is **every bundle in existence** — the absent case is byte-identical to the pre-D12 world, and the
vector proves it: `root_commit_sha_absent_shallow_clone` hashes to exactly the same value as the
pre-existing `root_commit` case. Omission is the writer rule; `null` is accepted by readers so a
nonconforming log still parses, but the two canonicalize differently and therefore chain to
different hashes, exactly as `parents: []` and an absent `parents` do.

**What replaced the `KNOWN LIMITATION` test.** It was replaced, not deleted, and not weakened. The
merge it pinned is still the honest answer for a scope where nothing names a repository, so that
assertion survives verbatim under the name `was the KNOWN LIMITATION: two UNLABELLED repositories
still merge, and say so` — which is the state of every bundle today. What is new is
`two repositories in one scope`, driving the SAME fixture with discriminators: two separate sha
spaces, one sha yielding two distinct nodes, `compareCommits` answering **`unknown`** where it used
to answer a fabricated `before`, no cross-repository ancestry, and ordering still working WITHIN a
repository.

**Degradation, and why none of it can accuse anybody.**

- **A shallow clone** has no reachable root commit — the boundary commit it reports has no parents
  and is not a root — so the writer OMITS the field and the scope is simply unlabelled. No defect,
  no count, no finding. `recordedRoot` still means root-or-truncated-lineage (S15) and nothing here
  changes that.
- **Several root commits in one repository** (an orphan branch, a squashed import merged in) is
  ordinary. Which one the writer names is pinned below; the reader never relates the discriminator
  to the commit graph, so it needs no rule at all.
- **Two partners deriving DIFFERENT roots for one repository** — reachable when one partner's
  history reaches a root the other's does not — costs exactly what having no discriminator costs:
  the shared commit becomes two nodes and the two groups do not correlate. It is a **loss** of
  evidence, never a manufactured one.
- **A mixed scope** (one partner on a newer recorder, or on a shallow clone) is reported as
  `'mixed'` and the two groups are NOT correlated. Rounding it to `'discriminated'` would imply the
  unlabelled observations had been placed; rounding it to `'assumed_single'` would deny that a
  repository was named. Assuming the unlabelled ones belong to the named repository is precisely the
  merge the field exists to prevent.

**Nothing downstream needed redesigning**, which is what the original `(repository, sha)` keying
bought. `order/`'s `≺` already skips cross-repository edges
(`origin.repository !== target.repository`), and `classify-external-changes.ts` already skips
cross-repository observations, so a split degrades to `unordered` / `no_observations` —
corroboration only — rather than to a flag. `coverage/`, `order/`, `identity/` and `witness/` were
not touched.

**Vector drift**, verified by regenerating before and after into a scratch directory:
`git-event.json` gains three notes and nine cases and **removes nothing** — the diff has zero `<`
lines, so every existing case is byte-identical, which is what keeps this from being a breaking
change to provjet and provnvim. A second exporter helper carries the new `discriminator` verdict
field so no existing case OBJECT changes either. `golden-bundle.{json,zip}` differ for the known
pre-existing reason and were confirmed to differ across two runs with no change at all. Every other
vector is byte-identical. Nothing was written into the sibling repos.

**Mutation testing**, seven mutations, every one caught:

| mutation                                                             | caught by                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| absent becomes a DISTINCT repository (every legacy bundle fragments) | 58 tests in 6 files, incl. `a bundle that records no discriminator > produces one sentinel repository`       |
| absent adopts the first PRESENT value (unrelated repos merge)        | `a scope where only some observations name a repository > does not correlate…`                               |
| every repository merged into the first labelled one                  | `two repositories in one scope > reports a cross-repository comparison as unknown…`                          |
| the reader ignores the field (the old stub)                          | 9 tests, incl. `two repositories in one scope > keeps them in separate sha spaces`                           |
| absence becomes a problem (a shallow clone is a defect)              | `a shallow clone… > degrades to the unlabelled repository with no defect and no finding`                     |
| absent and empty collapsed                                           | `rejects the empty string…` + `a discriminator that is present and unusable > counts what it could not read` |
| the shape check dropped (a path becomes a repository key)            | 7 log-core tests + `never lets the unusable value appear as a repository key`                                |

**Owed, flagged not fixed** — both sit in directories this change was scoped out of:

1. `coverage/coverage-facts.ts` computes `repositoryAssumedSingle` as `!discriminatorRecorded`,
   which under-reports a `'mixed'` scope: part of that graph IS folded into the sentinel. The
   correct predicate is `repositories.includes(ASSUMED_SINGLE_REPOSITORY)`.
2. `analyzer`'s `CoveragePanel` renders "The signed log format does not yet carry a repository
   discriminator". The format now does; no recorder emits it. The sentence stays true in practice
   until the writer half lands, and should be reworded with it.

Neither is reachable today, because nothing emits the field.

### The writer contract for `root_commit_sha` — what the three recorders must emit

Written down here so the ports are mechanical rather than re-derived three times. The reader is
correct whatever the writer picks — the value is opaque and compared only for equality — so this
contract exists to make three recorders derive the SAME value, which is the only thing that makes
correlation work at all.

> **CORRECTIONS FROM THE FIRST IMPLEMENTATION (VS Code, 2026-08-20).** The contract below says what
> value to derive and says nothing about how to reach `git`, which is the half that differs by
> machine. Hardening the VS Code writer for platforms other than the one it was written on surfaced
> seven gaps. **provnvim already shells out and has the identical question.**
>
> **CORRECTED 2026-08-20 by the provjet port: items 1-3 and 5-6 do NOT apply to provjet.** It uses
> the IntelliJ VCS API (`git4idea`'s `Git.runCommand` + `GitLineHandler`), whose `GitExecutable`
> _is_ the resolved-path ladder these items prescribe — so it already works where `git` is off the
> IDE's PATH, and on WSL / remote / IJent. Fixed argv, no shell, subcommands from a closed
> two-entry map. Item 4 (per-line CRLF trim) **did** bite — `"false\r" != "false"` would have made
> every Windows repository look shallow and omit the field — and item 7 (resolve once per wiring)
> applied. **The lesson for a future port: read your host's VCS integration before assuming you
> must spawn.** provjet's residual cost is that `Git.runCommand` exposes no timeout knob; accepted
> for a local object-DB read on a bounded background executor.
>
> 1. **Do not spawn a bare `git`.** `execFile('git', …)` needs git on the `PATH` the editor
>    INHERITED, and on Windows that is routinely not the PATH a GUI-launched application has — which
>    is exactly why VS Code ships a `git.path` setting and why its git extension publishes the binary
>    it resolved as `api.git.path`. A recorder can therefore fail to find a git its own host is
>    happily using. Resolve an ORDERED ladder, most specific first: the host's own resolved binary,
>    then the host's configured path, then bare `git`. Each port asks its own host the same two
>    questions; the ladder and the fall-through rules are what must match.
> 2. **The configured path may be an ARRAY, not only a string.** `git.path` is documented as "a path,
>    or an array of paths to look up", and a port that assumes a string gets `undefined` — or worse,
>    coerces the array to `"a,b"`, a path that exists nowhere. Try the entries in order. Drop entries
>    that are blank or not strings; keep the rest VERBATIM, never trimmed and never quoted.
> 3. **Fall through only for a candidate that never STARTED.** `ENOENT`, `ENOTDIR`, `EACCES`,
>    `EPERM`, `EINVAL` mean "this is not a runnable git", so the next candidate deserves a turn. A
>    non-zero exit and a TIMEOUT mean git was found and answered, and must NOT ladder: three
>    candidates each burning the 5s timeout puts a 15s stall in front of activation, and re-asking a
>    different binary in the same directory can only hear the same thing.
> 4. **Trim EVERY LINE, not just the whole output.** On Windows git's stdout is CRLF:
>    `'false\r\n' !== 'false'` silently makes every repository look shallow, and a `\r`-suffixed sha
>    is not lowercase hex, so rule 7 rejects it. Neither produces an error — they produce an entire
>    platform that omits the field and quietly fails to correlate. Trim at the point the sha is
>    parsed, not only once at the end.
> 5. **No shell, and accept its corollary.** `execFile`/`spawn` with an argv, never `exec` with a
>    command line: the Windows default install is `C:\Program Files\Git\cmd\git.exe`, and passing an
>    argv means that space needs no quoting and behaves identically on every platform. The corollary
>    is that a `.cmd`/`.bat` git wrapper cannot be launched at all — it gives way to the next
>    candidate like anything else that will not start. Adding a shell to support one buys back every
>    cross-platform quoting difference the argv form exists to avoid.
> 6. **"Git could not be found" is rule 5's omission, not a new answer.** No sentinel value, no
>    diagnostic field on the payload, no defect count — the same silent omit as a shallow clone. Note
>    also that an unreachable `cwd` and a missing binary are BOTH `ENOENT` from spawn and cannot be
>    told apart, so a repository root that has vanished walks the whole ladder before omitting. That
>    is harmless — once per repository, at setup — but a port that logs "git is not installed" for it
>    will be wrong.
> 7. **Resolve the executable once per WIRING; derive the value once per REPOSITORY.** Rule 1 is
>    about the value. Re-reading host configuration for every repository in the scope is waste on top
>    of it, and the answer cannot differ between two repositories in one session.
>
> **What is NOT proved.** All of the above is pinned by unit tests over Windows- and Linux-shaped
> inputs through an injectable spawn seam, plus real-git tests on macOS. No CI runner and no
> developer machine on this program has yet executed the writer on Windows or Linux, so the parsing
> and the resolution are pinned, and the platform behaviour of the spawn itself is not. A port that
> can run its own CI on Windows should say so, because it would be the first real evidence anyone
> has.

1. **Derive once per repository, at git-wiring setup**, not per event. It cannot change for the life
   of a repository, and it must not cost anything on the event path.
2. **The value is the root of HEAD's first-parent lineage** — `rev-list --max-parents=0
--first-parent HEAD`. First-parent, because that lineage stays on the mainline when an imported
   history is merged in, which is what keeps two partners agreeing.
3. **If that yields more than one root, take the lexicographically smallest.** Deterministic, so two
   partners with the same history agree. Several roots is ORDINARY — an orphan branch, a squashed
   import — and is never a finding.
4. **OMIT the field when the repository is shallow** (`rev-parse --is-shallow-repository` is
   `true`). A shallow clone's boundary commit has no parents and is NOT a root: emitting it would
   publish a value a full clone of the same repository disagrees with.
5. **OMIT the field on any failure** — the command errors, times out, or returns nothing. Absent is
   a legal, permanent, blameless answer, and guessing is worse than silence.
6. **OMIT, never `null`.** Omission and `null` canonicalize differently and therefore chain to
   different hashes. Readers accept `null` as absence so a nonconforming log still parses; a writer
   that emits it is nonconforming.
7. **Lowercase hex, verbatim, 40 or 64 characters.** No truncation, no abbreviation, no case
   folding. Every reader rejects anything else, and a rejected value is a repository the partners
   silently fail to correlate on.
8. **Never the repository path and never a remote URL**, in this field or any other. That is
   S14(b)'s constraint and it is the reason the reader shape-checks at all.
9. **One value per repository OBSERVED.** A session that sees a submodule as well as its outer
   repository labels each event with its own repository's root. Labelling a submodule event with the
   outer repository's root re-creates the exact merge this field exists to prevent.
10. **Emit it on every `git.event` that carries a `sha`**, not only on commits. An unlabelled
    observation does not correlate even when its neighbours in the same session do.

Conformance: `git-event.json`, nine new cases, each publishing the narrowing verdict alongside the
canonical bytes and chain hash so a port asserts **accept and reject**, not only the happy path.

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

### Landed 2026-08-21 — the three `session.start` capability reports (§5.6)

Readers before writers, then the VS Code writer in the same change — which is a **departure from
the rolling seal / peer witnessing / D12 pattern and is deliberate**. Those three are new
EVIDENCE, where shipping a writer ahead of a reader means a bundle nobody can read. These are new
CONTEXT for evidence that already exists: nothing branches on them, absence is the permanent
ordinary answer, and the reader was built first in the same diff. Splitting them would have left
the honest consumer with no producer to test against.

**The three fields.** All on `SessionStartPayload`, all optional **permanently** (1.x support is
permanent, program spec §9). The narrowing is `log-core/session-capabilities.ts`, in log-core
rather than in the reader for the same reason `peer-observed.ts` and `git-event.ts` are: four
consumers need identical rules — this monorepo's analyzer and server through `analysis-core`, plus
the two sibling recorder repos, which need them to EMIT conformant payloads.

| field             | shape                                         | §5.6 |
| ----------------- | --------------------------------------------- | ---- |
| `git_capture`     | `'available' \| 'unavailable' \| 'not_owned'` | 2    |
| `witness_capture` | `'available' \| 'unavailable'`                | 3    |
| `file_scope`      | `{ watched: string[]; complete: boolean }`    | 1    |

Each reader returns **three** answers, the D12 shape — `absent` / `recorded` / `malformed` — and
the third is what makes the second safe. `git_capture` and `witness_capture` are CLOSED ENUMS, so a
value outside the set is a nonconforming writer and never reaches a staff-facing surface as if it
meant something.

**`witness_capture` has two values where `git_capture` has three, and that is not an oversight.**
There is no witnessing analogue of `not_owned`: a recorder witnesses the `.provenance/` directory
it is itself writing into, so there is no ownership question to route on. Inventing a third value
to make the enums look alike would publish a state no recorder can be in.

**Why item 1 is the resolved LIST and not a count or the glob set.** S25's problem is that "no
events for this file" is ambiguous between _nothing happened_ and _it was never watched_. A COUNT
cannot answer it — you cannot ask a number whether it contains `Solver.java`. The unresolved GLOB
SET cannot either, and worse: it would require three hand-written ports and one analyzer to agree
on a matcher, which S25 itself names as a divergence risk and parent spec §10 exists to prevent.
Publishing the RESULT keeps exactly one matcher wherever it eventually lives, and is stable across
whatever the still-open `scope: 'repo'` decision (§8.7) settles on — every candidate resolution
produces a list of paths.

**`complete` is a required boolean, not an optional `truncated` flag.** A consumer must read a
path's absence from a truncated list as _unknown_, never as _not watched_; the field exists to
remove an inference, so it must never itself require one. An EMPTY `watched` with `complete: true`
is a real answer — "the scope resolved to nothing" — and is not absence.

**Privacy (S14(b)), which item 1 is the risky one for.** Paths are ASSIGNMENT-ROOT-RELATIVE,
verbatim, which is the same category `doc.open.path` already carries — so the field introduces no
new class of identifier. The reader shape-checks every entry and rejects an absolute path (POSIX,
Windows drive, UNC), any colon outside a drive letter (which is every remote-URL spelling,
including git's scp-style `user@host:path`) and any `..` segment. A single bad entry rejects the
**WHOLE set**: dropping only the offender would hand a consumer a silently NARROWED list, which
then says "this file was not watched" about a file that was. That is `validatePeerObservedPayload`'s
rule, for the same reason.

**None of the three is ever a finding.** No `Flag`, no ninth check, no severity, no score. They
exist to make an EXISTING finding readable — D16's `git_unrecorded_in` above all — and to let the
coverage stage say "we could not check" rather than implying "there was nothing to check". Nothing
was added to `policy.capture`: a capability report says "I could not", a knob says "I was told not
to", and `policy.ts` already names `git_capture` as the reason `peer.observed` is floor rather than
knobbed.

**Compatibility.** An older reader meeting these fields is unaffected: `session.start` payload
readers ignore keys they do not know and the chain is computed over the envelope without
interpreting `data`. A newer reader meeting a bundle without them is unaffected, which is **every
bundle in existence** — and the vector proves the bytes: `no_capability_reports` is the pre-§5.6
payload spelled literally, and `session-capabilities.test.ts` pins its canonical JSON character for
character so the hash cannot move unnoticed. Omission is the writer rule; the four
`*_null_is_not_absent` cases read as absence and hash **differently**, exactly as `parents: []` and
an absent `parents` do.

**Where the readers are consumed.** `analysis-core/src/capability/session-capabilities.ts` is the
one reader; `reconcileWitnesses` consumes it for item 3, gaining `witnessingCapability` at bundle
level and a per-session `capability`. That `capability` is on a **DIFFERENT AXIS** from `state`:
`state` says whether anyone witnessed this log, `capability` says whether this log's recorder could
have witnessed anyone. `unwitnessed` stays blameless in all three states — what changes is what a
surface is entitled to SAY about it.

**The bundle-level summaries require unanimity to say `impossible`.** One session saying "git was
unavailable to me" does not mean the scope had no git observation; a partner's session may have had
it. So `'impossible'` needs NO session reporting available AND every session reporting at all — a
single unreported session takes the answer to `'unknown'`, because that session might have been the
capable one. Fail toward not knowing.

**Vector drift**, verified by regenerating before and after into a scratch directory:
`session-capabilities.json` is NEW (26 cases) and **every other vector is byte-identical** — the
diff is one added file. `golden-bundle.{json,zip}` differ for the known pre-existing reason and
were confirmed to differ across two runs with NO change at all. `capture-policy.json` is
deliberately untouched: that vector publishes the event-KIND partition, and this change adds no
kind. Nothing was written into the sibling repos.

**Mutation testing**, ten mutations. Nine caught first time; the tenth exposed a vacuous test and
got a fix. See the report's table — the one worth carrying here is that
`recorder-context`'s null-vs-omit assertion was originally driven on a session where all three
reports were established, so there was nothing there to spell wrongly. **Bug 12's lesson again, in
its exact shape.**

### The writer contract for the capability reports — what the two ports must emit

Written down here so provjet and provnvim are mechanical rather than re-derived twice. The VS Code
writer is the reference implementation; where a rule below names a VS Code mechanism, a port must
answer its own host's equivalent question, not copy the mechanism.

1. **A capability report is not a capture knob.** Nothing here is policy-gated, nothing here reads
   `policy.capture`, and nothing here is ever a finding. If a port finds itself adding a manifest
   key, it has taken a wrong turn.
2. **OMIT, never `null`.** Omission and `null` canonicalize differently and therefore chain to
   different hashes. Readers accept `null` as absence so a nonconforming log still parses; a writer
   that emits it is nonconforming. Spread the key conditionally — do not assign `undefined` and
   trust the canonicalizer to drop it, because that makes the payload's shape depend on a
   canonicalizer detail three ports each have to reproduce.
3. **Report BEFORE the first entry is chained.** `session.start` is seq 0, so every value must be
   resolved before it is emitted. In VS Code this moved the `.provenance/` watcher's creation to
   before `session.start`; a port whose host resolves later must restructure rather than report a
   value it will only learn afterwards.
4. **`git_capture` — ask the same function the wiring routes on.** VS Code extracted
   `resolveGitApi` and `probeGitCapture` so the report and the behaviour cannot drift; two
   implementations of "is the git integration reachable" would agree today and drift later, and the
   drift would be silent. A port must derive the value from the same code path its wiring uses.
   - `'unavailable'` — the host exposes no git integration, or obtaining it failed. Exactly the
     condition on which the wiring becomes inert.
   - `'not_owned'` — git works, the host knows about at least one repository, and NONE is in this
     session's assignment scope, so every event would be dropped by the ownership gate.
   - `'available'` — git works and either a repository is owned **or the host knows about none
     yet**. **Zero repositories is `available`, not `not_owned`** — there is nothing to route, and
     an ownership answer would be a claim the evidence does not support.
   - OMIT when the repository list or the ownership predicate is itself unusable. Absent is legal,
     permanent and blameless; guessing is worse than silence (D12 writer rule 5).
   - It is a SNAPSHOT at session start. A repository opened later can change what would have been
     true, so `not_owned` means "at session start, nothing git could see was in scope" and never
     "no owned repository existed at any point".
5. **`witness_capture` — the capability IS the artifact.** Create the one directory watcher, once,
   and report whether it could be created; then hand THAT watcher to the witnessing wiring. Probing
   with a second, throwaway watcher lets the report and the wiring disagree, which is the failure
   this field exists to prevent. Two values only.
6. **`file_scope` — publish the RESULT, not the rule.** Assignment-root-relative paths, verbatim,
   in resolution order. Never absolute, never a URL, never a `..` segment: a port that cannot
   guarantee that must OMIT the field rather than publish one. `log-core`'s `buildFileScope` does
   the check and returns `undefined` on any bad entry — a port should mirror its rules exactly,
   because a path this repo's reader rejects is a set the analyzer discards whole.
7. **Cap at 4096 entries and set `complete: false` when the cap bites.** The three recorders must
   cap at the SAME number, or two ports disagree about when `complete` goes false. Today's resolver
   is the manifest's own `files_under_review` — a hand-authored course list — so the cap never
   bites; it is there so a future `scope: 'repo'` resolver cannot put an unbounded list inside one
   hash-chained entry by accident.
8. **`complete` is always present.** It is a required boolean inside a payload the writer owns
   (peer-witnessing writer rule 6, same reason). An empty `watched` with `complete: true` is a real
   answer and must be emitted rather than suppressed.
9. **The three are INDEPENDENT.** A port may land one before the others; each is omitted on its own
   terms. Do not group them into one object — a port that implements two would then have to choose
   a spelling for the third, and the honest spelling is "not there".
10. **Do not report a capability the port does not actually have.** A recorder with no witnessing
    implementation at all OMITS `witness_capture`; it does not report `'unavailable'`. `'unavailable'`
    means "I tried and could not", absence means "I do not report this". A reader treats them
    differently and a grader reads them differently.

Conformance: `session-capabilities.json`, 26 cases, each publishing all three narrowing verdicts
alongside the canonical bytes and chain hash so a port asserts **accept and reject**, not only the
happy path.

### Landed 2026-08-21 — the `submission_contributors` cut-over (D9 + D14)

**Migration `0029`.** One group bundle is now ONE `submissions` row with N contributors, replacing
the fan-out in which the same bytes were ingested once per co-submitter into N rows with N
duplicated blobs.

**Version uniqueness — the part that could have gone silently wrong.** `submissions_version_key`
was `UNIQUE (semester_id, assignment_id, student_id, version_index)` and `create-submission.ts`
locks the same three columns `FOR UPDATE`. Making `student_id` nullable breaks BOTH, without an
error anywhere: Postgres treats NULLs as **distinct**, so the constraint stops constraining group
rows; and `WHERE student_id = NULL` is never true, so the lock selects **zero** rows — `maxVersion`
stays 0, every resubmission is allocated version 1 for ever, `supersededIds` is always empty, and
the supersede chain never forms.

The fix is a new `version_owner_key`, and it is **`GENERATED ALWAYS` by Postgres**, not written by
application code:

```
student_id IS NOT NULL  ->  "student:" || student_id
student_id IS NULL      ->  "group:"   || group_key
both NULL               ->  NULL, which the NOT NULL rejects
```

Generated rather than application-supplied, and this is the whole argument: a derived column cannot
disagree with its row. Postgres refuses any attempt to write it (`cannot insert a non-DEFAULT
value`), so there is no code path — present or future, production or test — that can put a wrong
lineage on a row. It is not a convention, and not a `CHECK` that the wrong value could still
satisfy. Three consequences worth keeping:

- for every row predating 0029 the derived value is `"student:" || student_id`, so the new
  constraint partitions the existing table **point-for-point** as the old one did. "Existing
  submissions are unaffected" is a property of the schema, not a claim about test coverage;
- **no INSERT site in the codebase had to change** — Drizzle omits generated columns — which is
  itself part of that proof. The first attempt used an application-written column and broke ~20
  test files; that churn was the signal to look for the better design;
- a submission with no lineage at all is **unrepresentable** rather than merely unexpected.

Verified against real Postgres 16 before adoption (unique-on-generated is accepted; solo duplicates
still collide; two different groups at version 1 coexist; the same group twice does not; both-null
fails NOT NULL; an explicit write is refused), and again by the migration test.

**A real defect the migration test caught, which would have failed every deploy.** Migration 0006
declared that constraint **inline and unnamed** inside `CREATE TABLE`, so Postgres auto-generated
and truncated its name. `submissions_version_key` — the name the Drizzle schema has always
declared — **was never the name the database used**. `DROP CONSTRAINT submissions_version_key`
therefore errors on every real database, empty or populated. 0029 now finds it by its **column
set** and `RAISE`s if it is absent, because silently dropping nothing would leave the old
student-keyed constraint in place and reject exactly the group submissions the migration exists to
allow. (Post-0029 the constraint really is called that, so the schema's claim becomes true for the
first time.) **Generalisable:** a name that appears only in the ORM and never in the migration SQL
is not a name — it is a guess, and nothing was checking it.

**The join table.** One row per PERSON, reconciling the roster side (the submitter) with the bundle
side (`establishBundleContributors`, grouped on the verified `student_ref`) onto ONE row via a
partial unique index on `(submission_id, roster_entry_id)`. A co-submitter who also recorded
arrives from both sources, and two rows for one human would not merely duplicate a name — it would
**split their score across two apparent people**.

**What deliberately gets no row.** `unattributed` sessions (no identity block — the ordinary,
blameless state for almost every bundle today) and `unverifiable` ones. `analysis-core` gives each a
SINGLETON key precisely because two of them are neither provably one person nor provably two, so a
row per session would turn an ordinary five-session solo bundle into five apparent contributors —
and would break the sole-contributor scoring rule below. `unverifiable` is worse: the block NAMES
someone, and promoting it is exactly how a forged identity block would launder work onto the student
it names.

**D14 scoring.** `flags.contributor_key` (`''` = scope-level, the default). A flag is charged to a
contributor only when all its supporting evidence sits in ONE session AND that session is
`attributed` — §6 Rule 2. This deliberately **under**-attributes: a multi-session flag earned by one
partner stays scope-level. Under-attribution costs a partner nothing (the finding is still visible
at full severity in the scope roll-up); over-attribution puts a name on a finding the evidence does
not support. When the two are not equally cheap, fail toward the harmless one.

The **sole-contributor rule** is what keeps solo unchanged: with exactly one contributor they are
charged EVERYTHING, scope-level flags included, so their total equals the scope score exactly. With
one contributor there is no innocent partner to protect. Without it, every solo student's rollup
score would have silently dropped the day this shipped.

**Deviation from spec §7, flagged:** the spec says `flags.contributor_id`; this is
`flags.contributor_key`, a text key rather than a uuid FK. `flags` and `submission_contributors` are
both rewritten wholesale on a recompute, and an FK between two wholesale-rewritten tables forces a
delete ORDER whose violation is silent under `ON DELETE SET NULL` — attribution would just
disappear. The key is also stable across recomputes where a generated uuid is not, and
`flags.session_id` is already a bare logical id in the same table.

**Read paths.** All nine sites moved. The roster join went INNER → **LEFT** on the cohort list
(main + count), facets (×3), the summary, the cross-flag participants and the dry-run movers; the
`studentId` filter became an `EXISTS` on contributors (so a partner finds their own group work, and
nothing fans out to inflate `COUNT(*)`); the students rollup groups on contributors and sums the
**contributor's** score, not the submission's; assignment stats count distinct `roster_entry_id` in
their own CTE, so joining contributors cannot weight `COUNT(*)`, `AVG` and the percentiles by group
size.

Two of those INNER joins were live hazards rather than theoretical ones. The **summary** returned
`null` on an empty join and the route turned it into a **404**, so a submission with no single
owning student took down the entire detail shell; `null` now means only "no such submission". The
**cross-flag participants** join silently DROPPED a participant, so a two-party cross flag could
render as one-party — the caller does `?? []` and an empty list reads as "no participants" rather
than "we lost them".

The cohort list's student sort also needed `COALESCE(display_name, '')`: a keyset predicate
`display_name > $cursor` is NULL — never true — for a null-named row, which would make it
unreachable on every page after the first. Provably identity for existing data (the column is NOT
NULL and the join was INNER, so no pre-0029 row can produce a NULL). **Known gap, not closed:** the
protected-mode sorts order by `protected_index`, which was ALREADY nullable, and the same argument
applies; coalescing it would move existing NULL-index rows in the ordering, which is a behaviour
change to shipped data this task had no mandate for.

**The old fan-out, and `dedup.ts`.** `dedupFile` lost its `studentId` parameter and is blob-scoped
on every path again, as it originally was. The second co-submitter is ATTACHED to the existing
submission (`attachCoSubmitter`) instead of creating a row. Identical bytes really are the same
artifact — per-session uuids, keys and timestamps make coincidence impossible — so the narrow key
was never distinguishing two artifacts, only two SUBMITTERS of one, which the join table now
represents directly. The attach uses an **untargeted** `ON CONFLICT DO NOTHING`: the person can
collide on `contributor_key` OR on the partial person index (when the bundle side already named
them under an `attributed:` key), and a targeted conflict **raises** on that second path. That was
found by mutation — a targeted conflict passed every test until a regression was written for it.

**Existing fanned-out submissions are NOT merged.** Rows persist for audit, and merging would
rewrite history that `flags`, `cross_flag_participants` and `ingest_files` all point at. They stay
as N one-contributor submissions and read exactly as they do today; only NEW ingests take the new
shape.

**Ordering: the contributor stage runs AFTER heuristics**, inside the same transaction, on all three
write paths (ingest, recompute, manual attach) through one `finalizeContributors`.
`establishBundleContributors` MUTATES the bundle and several heuristics read that stamp, and **the
ingest path has never stamped it** — so stamping earlier would change which flags ingest produces
for any bundle carrying identity. That is a product behaviour change this task had no mandate for,
so flag CONTENT is provably untouched.

**Noticed, not changed:** ingest-time heuristics run on an UNSTAMPED bundle while recompute-time
ones (via `loadSubmissionIndex`) run on a stamped one, so the two can produce different flags for
the same bundle. Pre-existing, not introduced or widened here, and worth a decision of its own.

**Contract change**, both ends in one diff: new `SubmissionContributorSchema`; `contributors[]`
added to `SubmissionRowSchema` and `SubmissionSummarySchema` (additive); `student` WIDENED to
nullable on those two plus `TopMoverSchema` and `CrossFlagParticipantSchema`. The widening is
justified rather than convenient — a group submission has no one student, and naming one anyway
attributes the whole submission, a partner's flags included, to a single named person. Solo
rendering is unchanged by construction, since a solo submission has exactly one contributor who is
the same person as `student`.

**The fan-out was not actually removed until the second attempt — and the test
that proved it was one that PASSED.** `ingest-gradescope.e2e.test.ts` asserts
the old shape (three submissions for two co-submitters sharing one blob, every
file `matched`), and it kept passing after the dedup cut-over. A green test
asserting the behaviour you just removed is a report that your change is inert.

Cause: phase 2 (dedup) and phase 5 (createSubmission) are separate
transactions, and the worker drains its pg-boss batch with `Promise.all`, up to
`INGEST_CONCURRENCY` files at once. Two co-submitters carry byte-identical
bundles, so both cleared dedup before either committed, and both created a
submission. **Serial execution looked perfect; only concurrency reinstated the
fan-out.** Every unit test was serial.

Fixed by taking a transaction-scoped `pg_advisory_xact_lock` on
(semester_id, blob_sha256) — the same key dedup uses, so it serialises only the
writers that genuinely collide on one artifact — and RE-CHECKING dedup inside
that transaction. `createSubmission` now returns a discriminated outcome, and
`'duplicate'` is handled exactly as a phase-2 hit.

That fix then exposed a second one: `storeContributors` pruned "any row not in
my set", which DELETED the partner who had just attached concurrently. It now
prunes only `attributed` rows — those are derived wholly from the bundle and it
is their sole author, whereas a `roster` row is a fact asserted by the roster
side and is not its to remove. **Two silent, concurrency-only student-losing
defects behind one green test.**

**Generalisable:** when a change is meant to alter behaviour, find the test that
asserts the OLD behaviour and make sure it FAILS. If nothing fails, the change
is either untested or inert, and those are indistinguishable from the outside.

**Mutation testing, ten mutations, each with its catching test:** unique key left on the nullable
`student_id` (the group-submission version tests + the migration test); every contributor charged
every flag (5 tests, including Bob charged 12 instead of 1); sole-contributor rule removed (3
tests); summary join back to INNER (the 404 test — `expected null not to be null`); cohort list join
back to INNER (2 tests); rollup summing the submission score per partner (`expected 12 to be 8`);
`unverifiable` allowed to name the student it claims to be (2 tests); the roster join dropped from
the rollup's recompute-status query (every test in `students.test.ts`); and the over-aggressive
contributor prune (the two new concurrency regressions). Two mutations were NOT caught when first
tried — the targeted `ON CONFLICT`, and the prune rule — and both got regression tests.

---

### Known gaps, deliberately accepted

- **Neither-partner-enrolled** leaves shared-repo ownership undecidable; the quarantine and
  `prev_session_id` defects remain reachable in exactly that configuration. Closing it needs
  enrollment or peer witnessing.
- **`prev_session_id` is still set only on the dangling path**, so §7 mechanism 1 cannot detect
  removal of a cleanly-ended session. Changing it alters solo semantics — a product call.
- ~~**Multi-repo scopes are unsound** until D12 lands.~~ **Closed for a LABELLED scope, 2026-08-20**
  — and still open for every bundle in existence, because no recorder emits the discriminator yet.
  A scope where nothing names a repository still merges, which is the honest answer when the
  evidence carries no repository at all; what closes it for real is the writer half. The
  `KNOWN LIMITATION` test was replaced rather than deleted, exactly as intended: it now pins the
  merge as the answer for an UNLABELLED scope, and a new `two repositories in one scope` block
  asserts the sound one.
- **`markFormatter()` has no production caller**, so `explanation: 'formatter'` is unreachable
  despite PRD §4.5 promising it. D16 is therefore scoped to the `'git'` tag only — `'formatter'`
  is a narrower claim the decision does not reach, and no shipped bundle can carry it anyway.
- **D16 flags honest pairs whose partner was not recording.** Their genuine work arrives as bytes
  nobody recorded, which is `git_unrecorded_in` by definition. Accepted on the user's decision, and
  handled by text rather than by score: the flag establishes only that the content has no recorded
  authorship _in this scope_ and says so. Enrolment coverage is what actually closes it.
