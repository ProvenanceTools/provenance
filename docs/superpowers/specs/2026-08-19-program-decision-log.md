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

| #   | Decision                                                                                                                                                                               | Why                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Institution-scoped identity**, replacing course-scoped. One student, one key, one global `student_ref`, one credential, obtained once.                                               | Rosters are populated by Gradescope ingest **after** a submission, but identity is needed **before** work. The old `mint.ts` required a roster match, so a student could never enrol before their first submission. A confirmed deadlock, not a preference. |
| D2  | **Fully global HKDF derivation** — no user-derived input in `info`.                                                                                                                    | The recorder can show a student their public key with zero configuration. Cost, accepted: cross-institution unlinkability is gone.                                                                                                                          |
| D3  | **A new `students` table**, keyed `(institution_id, sso_subject)` on the Google `sub` claim — not email.                                                                               | Emails get reassigned; `sub` does not. Allocatable before any roster row exists, which is what breaks the deadlock.                                                                                                                                         |
| D4  | **2.0 credential _minting_ retired; 2.0 _verification_ kept forever.**                                                                                                                 | The 2.0 minting route never shipped (absent from `main`, added and superseded within this branch). Verification must survive permanently — archived bundles are the adjudication case that justifies the system.                                            |
| D5  | **Multiple machines per student is a first-class flow.** Each machine enrols independently, generating its own keypair; the shared `student_ref` groups them into one contributor.     | Explicit user requirement. Note this means _no secret copying is needed_ to use a second machine; export/import is a **backup** path, not a migration step.                                                                                                 |
| D6  | **Keypair, not a bearer token.**                                                                                                                                                       | A UUID is copyable and repudiable ("someone must have got my token"). A signature over the session's ephemeral key is not. And the server holds only public keys, so a database breach forges nobody.                                                       |
| D7  | **`final: true` on the dispose-time rolling seal.**                                                                                                                                    | A rolling seal is signed _before_ the log's trailing bytes exist, so it commits only to a prefix. `final` restores whole-file semantics when the log provably cannot grow. Absence is never a finding.                                                      |
| D8  | **The integrity hole is fixed as bundle-level Flags, not a 9th validation check.**                                                                                                     | The PRD §5.4 eight are a frozen persisted contract (eight `check_N_status` columns, a `checks.length === 8` assert at ingest). Catalogue went 26 → **29**.                                                                                                  |
| D9  | **S4 cuts over to the `submission_contributors` join table** as the live path.                                                                                                         | User's decision, taken with the blast radius (12+ read paths, 6 Zod schemas, 7 analyzer call sites) on the table.                                                                                                                                           |
| D10 | **Ingest modes: `bundle_zip` / `repo_whole` / `repo_scoped`**, per-assignment default with per-request override, API-driven for provgate. A batch declares its type; a mismatch fails. | User's decision. The homogeneity guarantee converts per-file guessing into a per-batch assertion.                                                                                                                                                           |
| D11 | **Manifest composer signs in the browser**; the course private key never leaves staff's machine.                                                                                       | The course key is deliberately offline — that is why a server-held _enrollment_ subkey exists. A server that could sign manifests could weaken any course's capture policy.                                                                                 |
| D12 | **Repository discriminator = root-commit sha** (not yet emitted; format change pending).                                                                                               | Both partners on one repo derive the same value offline, which is what makes cross-contributor DAG correlation possible. A submodule has a different root commit, so it discriminates correctly.                                                            |
| D13 | **Unenrolled contributors show as `unattributed`**, not blocked and not flagged.                                                                                                       | An administrative gap must never present to a grader as an integrity signal.                                                                                                                                                                                |
| D14 | **Group scoring is per-contributor _and_ per-scope.**                                                                                                                                  | Only shape where a grader can act on one partner without implicating the other.                                                                                                                                                                             |
| D15 | **IRB/CPHS approval is the user's problem.** S6 is not an engineering blocker.                                                                                                         | Stated by the user.                                                                                                                                                                                                                                         |

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

---

## 4. Traps — these will bite again

- **Worktrees are created from `main`, not the feature branch. 16 of 16 times.** Every agent must
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

Suites, all measured in the main tree:
**log-core 541 · analysis-core 917 · recorder 582 · analyzer 1215 · tools 150 ·
server 1420/1422 (2 confirmed flakes) · provjet 589 · provnvim 1007.**
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

- Branched replay UI (Tier 5.3), including surfacing a suppressed concurrent overlap as a **visible
  fact** — today a proven-different overlap yields _no flag and no fact_, which is weaker than the
  spec intends.
- `submission_contributors` cut-over (D9), per-contributor heuristic scoping, `Flag.contributor_id`.
- Peer witnessing (`peer.observed`) — tri-repo format change.
- **Open product call from Tier 3.1:** should a content-derived `git_unrecorded_in` override the
  recorder's `explanation: 'git'` tag in `external_edits`? Today the tag still suppresses, so a
  finding the content test says is real can be silenced by a 2-second timing window. Overriding
  surfaces it — and also surfaces it for honest pairs whose partner simply was not recording.
  Deliberately not decided by an agent: it changes findings for real students.
- The repository discriminator (D12) as a signed-format change, with vectors.
- **provjet has no AUTOMATED cross-implementation gate.** Verified 2026-08-20: provnvim's
  `scripts/e2e/run_e2e.sh` produces a bundle via headless Neovim and hands it to the real monorepo
  `analysis-core`; the monorepo has `tools/recorder-seal-conformance.test.ts` for VS Code. provjet
  produces e2e bundles under `recorder/build/` but its `EndToEndRecoveryValidationTest` only
  _mentions_ the Node-side `loadBundle + runValidation` in a comment — it is run separately, by
  hand. That is the same asymmetry that left the VS Code recorder's written output unvalidated
  until this session, and it is the test class that has caught the most. **Automate it.**

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
  despite PRD §4.5 promising it.
