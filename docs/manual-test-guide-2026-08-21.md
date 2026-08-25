# Manual test guide — the 2026-08-21 changes

**Companion to `docs/manual-test-guide.md`, not a replacement.** That guide covers the whole
system end to end and is still the one to run before a semester. This one covers only what
changed on 2026-08-21, and it is weighted toward the things automated tests cannot prove:
that a real student doing an honest thing is not accused, and that a grader reading the screen
is told the truth.

**How to read a result.** Most of what follows is checking that something does **not** happen.
A green run here is mostly silence. Where a check says "must NOT fire", a firing flag is a
release blocker, not a curiosity — the branch's own bar is that no high-severity flag is
reachable by honest work.

**Order matters.** §1 sets up fixtures that §2–§4 reuse.

---

## 0. Before anything

```bash
cd ~/projects/provenance
git switch feat/manifest-2.0-trust-chain
npm run build
docker compose up -d           # Postgres + MinIO for local dev
npm run db:migrate --workspace=packages/server
```

Confirm the migration chain reaches **0031** (`cross_flag_exclusions`):

```bash
psql "$DATABASE_URL" -c "\dt cross_flag_exclusions"
psql "$DATABASE_URL" -c "select count(*) from drizzle.__drizzle_migrations;"
```

If `cross_flag_exclusions` is missing, the migration did not run — check that
`packages/server/db/migrations/meta/_journal.json` has its entry. `migrate` is journal-driven and
**silently skips** a migration missing from the journal. That silence is the failure mode.

Start the API and worker in one terminal, the analyzer in another:

```bash
npm run dev --workspace=packages/server
npm run dev --workspace=packages/analyzer     # :5173
```

**Expected on worker start-up**, and it is not a bug:

```
worker: DATABASE_POOL_MAX has thin headroom above INGEST_CONCURRENCY +
INGEST_STAGE_CONCURRENCY + RECOMPUTE_MAX_PARALLEL …
```

At shipped defaults the three concurrency knobs sum to 9 against a pool of 10. That is legal but
tight, which is exactly what the warning says. **Check it is a `warn` and the worker keeps
running.** If the worker exits, that is a regression — this was deliberately not made fatal
because the deployment is live.

---

## 1. The honest-student fixtures

Everything in §2 depends on these. Build them once, keep them.

You need **two enrolled students** on **one shared git repository**, both recording. Follow
`manual-test-guide.md` §1 for keys and §2.2 for enrolment if you have not already.

```bash
# one shared class repository, assignment as a SUBDIRECTORY.
# This layout is the point — see §4.1.
mkdir -p ~/tmp/cs61b-class && cd ~/tmp/cs61b-class
git init && mkdir -p hw1 && cp <staff manifest> hw1/.provenance-manifest
git add -A && git commit -m "skeleton"
```

Clone it twice — `alice/` and `bob/` — and open `hw1/` in a recorder in each.

### Fixture A — the honest pull

1. **Bob** types a real solution in `hw1/Solver.java`. Let the recorder run. Commit and push.
2. **Alice** — with `Solver.java` **CLOSED in her editor** — runs `git pull`.
3. Alice opens the file, reads it, makes one small edit, saves.
4. Both seal and submit.

Closing the file in step 2 is not incidental. It is what makes Alice's recorded typing zero
against a file that grew by hundreds of characters, which is the exact shape that used to
produce three separate maximum-severity accusations against her.

### Fixture B — the honest boilerplate paste

One student, solo, no git needed.

1. Hand-type a file of **60+ lines** in the editor. Slowly, like a person.
2. Paste in a **3-line** import block or licence header from elsewhere.
3. Save, seal, submit.

### Fixture C — the real thing, which must still be caught

1. Fresh file. Paste an entire **20+ line** working solution in one action.
2. Save, seal, submit.

If §2 turns everything green but Fixture C is also silent, the fix silenced the detector and
that is worse than the bug it replaced. **C is the control.**

---

## 2. False accusations — the release-blocking checks

Ingest all three fixtures. Open each submission's **Overview** tab.

### 2.1 Fixture A — the honest pull

| Flag                           | Required result                       |
| ------------------------------ | ------------------------------------- |
| `low_typing_high_output`       | **MUST NOT FIRE** on Alice            |
| `time_to_first_save_anomaly`   | **MUST NOT FIRE** on Alice            |
| `idle_then_complete`           | **MUST NOT FIRE** on Alice            |
| `external_edits`               | must not fire (was already protected) |
| `mass_external_replacement`    | must not fire (was already protected) |
| `paste_shared_across_students` | **MUST NOT FIRE** on the pair         |
| `multiple_sessions_overlap`    | must not fire                         |

All three of the first group fired at **high severity, confidence 1.0** before this change. They
now subtract content the system can cryptographically prove came from a partner's recorded work.

**Then break it deliberately, to prove the subtraction is narrow.** Have Alice pull, then paste
900 characters nobody recorded. `low_typing_high_output` **must fire**. If it stays silent, the
discount is too wide and the heuristic is now blind.

### 2.2 Fixture A, second machine

Repeat with Alice on a **second machine** (a second enrolment, per D5 — no secret copying).

- `multiple_sessions_overlap` **must not fire.** It keys on the per-machine student key, not the
  per-session key.

### 2.3 Fixture B — the honest boilerplate

- `paste_is_solution` **MUST NOT FIRE.**

Before this change the flag measured how much of the _paste_ survived, which is trivially 100%
for any small paste nobody deleted. A 3-line import block scored 1.0 and raised the catalogue's
most damning finding.

### 2.4 Fixture C — the control

- `paste_is_solution` **MUST FIRE**, high, confidence 0.85.
- Open the flag's detail. It should report coverage as a fraction of the **final file**
  (`coverageRatio`), with `survivalRatio` alongside as context.

**Boundary probe.** Repeat Fixture C with a **9-line** paste that is 100% of the file. It must
**not** fire — below the 10-line floor there is no "solution" to have pasted, and `large_paste`
would not raise even `medium` there. Now try 11 lines: it must fire.

### 2.5 `no_intermediate_errors`

This one had three separate defects. Test each.

**Scope.** In one session, run commands that fail — `javac` with a syntax error, twice — then fix
and run clean. In a _second_ session run one clean command.

- The flag **must not** claim "no terminal errors detected". It previously reported per-session,
  so a log containing three failures still produced a clean verdict naming a different session.

**Absent exit codes.** Run commands in a terminal **without shell integration** (the recorder
cannot see exit codes).

- The flag **must not** report "all commands exited with code 0". Absence of capture is not
  evidence of success. It should stand down.

**Volume floor.** A submission with one `ls` and one keystroke.

- **Must not fire.** Fewer than 5 commands with recorded exit codes is not evidence of anything.

---

## 3. Group work a grader can actually read

### 3.1 The exclusion register

Open **Cross-flags** for the semester containing Fixture A.

- There is a panel explaining what was deliberately **not** compared.
- It names the shared commits that proved the two submissions are one repository lineage.
- **It names BOTH partners for each member**, not one. This is the check that matters: the panel
  exists to say "these two are a partnership", so naming one arbitrary submitter defeats its
  purpose.
- It is **not** rendered as a finding. No severity, no score, no red.

Also check `/local` → drop both `.zip` files → **Compare**. The same explanation appears there.
The two surfaces should agree; they deliberately share wording.

### 3.2 Mixed recorder versions — the sentinel case

This needs one partner on a recorder that emits the repository discriminator and one on an
older build. If you cannot produce an old build, skip and note it — it is the one check here
with no easy fixture.

- The pair must **still** be excluded. Previously a version mismatch produced different keys for
  the same commit, so the pair was compared and false-accused.
- **The converse must hold**: two students who merely cloned the same course skeleton and never
  collaborated must **still be compared**. If they are excluded, detection is switched off for the
  whole course and this is a serious regression.

### 3.3 Group ownership is deterministic

Ingest the same group export **twice** (or re-ingest after a purge).

```bash
psql "$DATABASE_URL" -c \
  "select id, student_id, version_index, superseded_by from submissions
   where assignment_id = '<id>' order by version_index;"
```

- `student_id` is **the same student both times.** It is tie-broken on the lowest roster SID, so
  the race no longer decides it.
- Submit **again** as the group. The new row must **supersede** the previous one —
  `version_index` increments and the supersede chain points correctly. Previously every group
  resubmission restarted at version 1 and none superseded any other, so a grader saw several
  "first" submissions.

### 3.4 Cohort search finds either partner

In the cohort list, search for **each** partner by name, then by SID.

- Both find the group submission. Previously only the submitter of record did, and because that
  is now deterministic the _same_ partner was consistently unfindable.
- The row still displays under its submitter of record with the full partner list — so searching
  "Grace" can return a row headed "Ada". That is expected.
- Search a roster student who contributed to nothing: **zero results.** Enrolment is not
  submission.
- **Protected mode:** enable it and search a partner's real name. The search must be **suppressed
  entirely**, not masked — you must not be able to use it as an oracle to learn who "Student 4"
  is. This is the one check in §3 that is a security property, not a usability one.

---

## 4. The recorders

### 4.1 The shared class repository — the layout that was broken

Using the §1 layout (repo root **above** the assignment directory), in **JetBrains**:

- Run a git command in `hw1/`. A `git.event` **must** be recorded.

This was silently dropped until 2026-08-21 — provjet only matched repositories at or _below_ the
assignment root, so in the standard 61B layout git capture did nothing at all and said nothing
about it. Check the same in VS Code and Neovim; both were already correct, and there are now
regression tests, but this is the flagship layout and worth eyes on it.

### 4.2 Capability reports

Open a fresh bundle from each of the three recorders and check `session.start` carries the
three §5.6 fields (or omits them — never `null`):

```bash
unzip -p <bundle>.zip '*.slog' | head -1 | python3 -m json.tool | head -40
```

- `git_capture`, `witness_capture`, `file_scope` present where applicable.
- **Absent is legal.** Every bundle recorded before these existed omits all three, permanently,
  and that must never read as a defect.

**The `not_owned` case, JetBrains only.** Open a project with **two** assignment directories, one
a git repository and one not, both recording. The session on the non-repository assignment should
report `git_capture: not_owned` — git worked, but everything it could see was out of scope.

### 4.3 Cross-implementation gates

```bash
# monorepo
npm run test:tools
# provjet
cd ~/projects/provenance-jetbrains-recorder && ./gradlew :core:test :recorder:test
# provnvim
cd ~/projects/provenance-neovim-recorder && make test
```

Expected: tools 188 · provjet core 188 / recorder 592 · provnvim 1358.

**Conformance vectors are now reproducible.** Regenerate twice and diff — the outputs must be
byte-identical:

```bash
cd ~/projects/provenance
npm run build --workspace=packages/analysis-core     # REQUIRED — the exporter reads dist/, not src/
npx tsx tools/export-conformance-vectors.ts --out /tmp/v1
npx tsx tools/export-conformance-vectors.ts --out /tmp/v2
diff -rq /tmp/v1 /tmp/v2 && echo REPRODUCIBLE
```

If `golden-bundle.json` / `.zip` differ, you skipped the build step. That trips everyone.

---

## 5. Coverage — "we could not check" vs "nothing happened"

Open any submission → **Overview** → the **Recording coverage** panel.

- **Peer witnessing** appears when something was witnessed or read. `unwitnessed` must read as
  **ordinary and blameless** — it is the state of every solo submission and every bundle recorded
  before witnessing existed. If the wording implies a deficiency, that is a bug: this evidence must
  never name a person on its own, and `disappeared` in particular is not misconduct (a checkout or
  a stash removes a partner's log).
- **Git observation** appears always. Confirm it distinguishes "no git activity happened" from
  "git could not be observed". A pre-§5.6 bundle shows `unknown`, which is neither.

Read this panel as a grader would, and ask whether any line could be mistaken for an
accusation. That judgement is the test — no automated check can make it.

---

## 6. Operator

### 6.1 Recompute concurrency

`RECOMPUTE_MAX_PARALLEL` is now live (it was declared and read by nothing).

```bash
curl -X POST "$API/v1/semesters/<id>/recompute" -H "Authorization: Bearer $TOKEN"
```

- Worker logs show submissions starting in **batches of 4** (the default), not one at a time.
- Flags and scores after a concurrent recompute are **identical** to before it. A retry must
  produce the same result; that invariant is why the batch is grouped per submission internally.

Set `RECOMPUTE_MAX_PARALLEL=8` and restart. The pool warning should get louder (margin shrinks).
Set `DATABASE_POOL_MAX=20` and it should go quiet.

### 6.2 Pagination

Every list, past page 1 — cohort, cross-flags, students. With the cohort search now matching any
contributor, re-check that a group submission appears **exactly once** across pages and that the
total count is stable. This branch has already had a keyset bug that both dropped and re-served
rows sharing a millisecond.

---

## 7. Traps

- **The exporter reads `dist/`.** A fix verified against `src/` alone appears not to work.
- **`migrate` is journal-driven.** A migration missing from `_journal.json` is skipped in silence.
- **The pool warning is expected** at default settings. It is a warning by choice.
- **A green Fixture A means nothing without Fixture C.** Silence can mean "fixed" or "broken
  detector". Always run the control.
- **`unwitnessed`, `unknown`, `absent` and `not_owned` are not deficiencies.** If any of them
  render as a problem, the fix is the wording, not the data.
- **The full server suite takes ~42 minutes** (144 files, each with its own Postgres + MinIO
  container). Do not run two of them at once — that is what made this look flaky for weeks. If a
  test fails on a container timeout rather than an assertion, the machine was loaded, not the code
  wrong.

---

## 8. Known open items, so you do not report them as bugs

- **A stale tuned threshold.** If any pilot course tuned `paste_is_solution`, its stored key
  (`lineOverlap`) no longer exists. It falls back to defaults gracefully but **silently** — worth
  checking whether any course actually tuned it.
- **An analyzer test flake.** The suite occasionally exits non-zero with all 1357 tests passing,
  from an async load resolving after the test environment tears down
  (`LoadView.test.tsx` → `BundleContext`). Test hygiene, not a product defect.
- **`paste_is_solution` still cannot see a single-line paste.** A 600-character one-line paste
  that is 100% of a file no longer raises _this_ flag; `large_paste` and `low_typing_high_output`
  both still do, so no evidence is lost.
- **PRD §7.4 wording vs implementation.** `no_intermediate_errors` never checked "from empty", and
  nothing distinguishes a passing test run from a successful `ls` — it does not read the command
  line. Documented, not fixed.
