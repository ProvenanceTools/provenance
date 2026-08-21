# Session handoff — 2026-08-20

**Point a new session at this file.** It is the resume point; everything else it needs is in the
repo.

## Read in this order

1. **`2026-08-19-program-decision-log.md`** — the durable record. Every decision with its reasoning,
   ~15 bugs found that nobody was looking for, the recurring traps, the definition of done, both
   writer contracts (plus seven corrections found by the first implementation). ~900 lines, kept
   current all session.
2. `2026-08-18-multicourse-program-architecture.md` — umbrella spec, cross-repo contracts.
3. `2026-08-19-git-collaboration-semantics.md` — 31-scenario shared-repo census.

**Where this file or the decision log disagrees with an older spec, they win.** Several spec
statements were overturned by evidence; each is called out with the reason.

---

## FIRST: the machine is in a bad state

**Docker is wedged.** Earlier it crashed outright
(`com.docker.virtualization: process terminated unexpectedly: use of closed network connection`),
was restarted, and is now half-alive: `docker info` **hangs past 120 s**.

**This produced 29 red server tests that are NOT real failures.** They look alarming — plain cases
like _"returns submissions with SubmissionRow shape"_ — but the error text is
`(HTTP code 500) server error` and 120 s timeouts. That is **testcontainers talking to the Docker
daemon**, not our HTTP server returning 500. I killed that run.

Confirmed directly, not inferred: **`docker run --rm hello-world` fails outright** and
`docker ps` reports zero containers. The daemon cannot start a container at all, so no
testcontainers suite can pass regardless of the code.

**Do not debug those failures. Do not treat the server suite as red.** Get Docker healthy first
(the user is aware; ask before restarting anything on their machine), confirm with
`docker run --rm hello-world`, then re-run.

---

## The one open verification gate

**Migration 0029 — the `submission_contributors` cut-over — is merged but its server suite has
never completed.** This is the riskiest change on the branch: it touches the table behind every
read path. Everything else is verified.

Run when Docker is healthy:

```
cd packages/server && npx vitest run --no-file-parallelism --reporter=verbose
```

`--reporter=verbose` is not optional — without it the run buffers to nothing and looks wedged for
hours (an agent lost 2h20m to exactly that). Budget >10 minutes.

**Target first:** `cohort.test.ts > GET /semesters/:semesterId/cross-flags > cursor pagination
round-trip`. The implementing agent believed it a pre-existing ordering flake (three cross-flags
seeded with identical severity/confidence, so page-2 order turns on random UUID tiebreaks) but said
plainly: _"that is reasoning, not evidence."_ Settle it.

Known-flaky files under container contention — re-run **alone** before calling any a regression:
`cohort.test.ts`, `assignments.test.ts`, `structure.test.ts`, `heuristic-config.test.ts`,
`files.test.ts`.

---

## State

Branch `feat/manifest-2.0-trust-chain`, unmerged to `main`, ~270 commits.

| suite         | count |                              |
| ------------- | ----- | ---------------------------- |
| log-core      | 619   | ✅                           |
| analysis-core | 1073  | ✅                           |
| recorder      | 667   | ✅                           |
| analyzer      | 1313  | ✅                           |
| tools         | 183   | ✅                           |
| provnvim      | 1270  | ✅ gate green                |
| provjet       | 737   | ✅ gate green                |
| **server**    | ~1490 | ⚠️ **UNVERIFIED since 0029** |

Build, typecheck, lint clean. All three recorders have a cross-implementation gate, and **each has
caught a defect its own repo's suite could not**.

**Built:** git submission end-to-end (rolling seal + `final` in all three recorders, loader, server
ingest with declared modes on all three entry points); institution-scoped identity in all three;
the collaboration spine (contributor resolution, commit DAG, `≺`, segmented reconstruction,
external-change reclassification, coverage stage); branched replay UI; peer witnessing **reader**;
repository discriminator **reader**; VS Code **writer** halves for both; staff manifest composer;
`submission_contributors` cut-over (migration 0029).

---

## In flight when this was written

Check before assuming anything is lost — agents commit incrementally and killed agents' commits
have always survived:

```
git branch --list 'worktree-agent-*'
git rev-list --count feat/manifest-2.0-trust-chain..<branch>
git -C ../provenance-neovim-recorder status --porcelain
git -C ../provenance-jetbrains-recorder status --porcelain
```

~~All three landed.~~ **DONE 2026-08-20** — nothing from this list is outstanding:

1. **provnvim writer halves** — landed, **1270** tests, e2e green.
2. **provjet writer halves** — landed, **737** tests, e2e green, `SessionHost` zero-line diff.
3. **Git-spawn portability hardening** — landed, recorder **667**.
4. **provnvim partner-log quarantine** (decision-log bug 2, found live by provnvim's own e2e) —
   fixed with an ownership gate on `student_ref`, in a module with **no write-capable seam** so a
   rename is unreachable rather than merely absent.

**All three recorders now emit both `peer.observed` and `root_commit_sha`.**

---

## Still owed

- **Sibling writer halves** (the two above, if they did not finish). Contracts are in the decision
  log **with seven corrections** from the VS Code implementation — a port that ignores them will
  describe the same event differently, which is the divergence the shared vectors exist to prevent.
- **Server parity for `CoverageFacts`.** `packages/shared` has zero occurrences of "contributor"
  while `load-index.ts` already stamps them; the exact three steps are in the decision log.
  Gotcha recorded there: `BundleContributors.bySession` is a `ReadonlyMap` and will not serialize —
  the wire shape must be the `CoverageFacts` aggregate.
- **`/architecture` consolidated diagram pass** — ~13 nodes owed (`extclass`, `witness`, `coverage`,
  `submission_contributors`, and others; the log lists them). **No `.dot`/`.svg` has been touched
  all session, deliberately**, so agents could not collide over them. Node _detail_ cannot be
  authored before its node exists — `nodes.coverage.test.ts` fails on orphan metadata.
- **End-to-end rehearsal of the real student path**: install → enrol → work → push → ingest →
  review. Every gate so far tests a slice; nobody has walked the whole thing. This is where I
  expect the remaining surprises.

---

## Cross-platform: the user raised this and it is only half-addressed

The recorder spawns `git` to derive the repository discriminator. Verified to degrade correctly —
missing git, no repository, empty repository, shallow clone, timeout, permission denied all reach
one `catch` that omits the field. **Every failure loses evidence rather than manufacturing it**,
which is what makes it safe on machines where it cannot work. `execFile` (no shell), `windowsHide`,
5 s timeout, 1 MiB cap, injectable seam.

Two gaps, one being fixed in flight:

1. **`git` is spawned bare, so it must be on `PATH`.** On Windows a GUI-launched app often inherits
   a `PATH` without git even when it is installed. The fix is to ask VS Code: the git extension's
   API object carries `git.path` (the binary VS Code itself resolved), and
   `workspace.getConfiguration('git').get('path')` is the raw setting — **which may be a string OR
   an array of candidates**. Our local `GitAPI` type in `git-wiring.ts` declares only three fields
   and would need `git?: { path?: string }` added. **provnvim already shells out to git and has the
   same question.**
2. **Nothing has ever run on Windows or Linux.** All testing is macOS. Whatever the in-flight agent
   covers, that remains true of the real platforms — treat its report's "unverified" section as the
   authoritative list.

---

## How to run this work

Orchestrate with subagents in **isolated worktrees**; merge one at a time and **re-verify
build → typecheck → lint → every suite in the MAIN tree after each merge**. Worktree agents
structurally cannot verify themselves: no `node_modules`, so `@provenance/*` resolves to the main
checkout and their green is meaningless.

Non-negotiable in every brief:

- Verify branch + ancestor and hard-reset first. **Worktrees are created from `main` 25 of 25 times.**
- `npm ci` in the worktree.
- **Mutation-test**: break your own implementation one line at a time and report which specific
  tests went red. This repeatedly caught tests that looked fine and proved nothing — an agent's own
  IRB test, decorative clock-skew fixtures, three unpinned id-space strings, and a
  `unverifiable`/`unattributed` counts collapse that passed every existing test.
- `npm run test --workspace=packages/X`, **never** `--root packages/X` (bypasses package config:
  the recorder loses its `vscode` alias, the analyzer denies `docs/heuristics.md` — both fake).
  **Never** the bare root `npm run test`.
- One agent on the server suite at a time. Two produced ~37 containers and MinIO 503s that read
  exactly like real regressions.
- **Check your own shell cwd before trusting a verification run** — a persisted `cd` into
  `packages/server` once made build/typecheck/lint report a false clean.
- **A `pgrep` wait-guard must exclude itself.** Several agents wrote
  `pgrep -f "agent-<id>.*vitest"` to sequence Docker use; that matches the waiter's own command
  line, so they wait for each other forever. Give any wait loop a timeout and a liveness check that
  is not the thing being waited on.
- Analyzer suite intermittently exits non-zero with all tests passing (a deliberate uncaught error
  in `BundleContext.test.tsx`). Re-run before believing it.

---

## What has actually caught bugs

Not the suites. **Cross-implementation gates and mandatory mutation testing.**

Four of the ~15 bugs were **maximum-severity false accusations against innocent students sitting
behind fully green suites**. Two shared one root cause — comparing a prefix against a whole — and
one recurred through a **second branch of the same conditional** after the first was fixed. The
lesson, recorded in the log: **fixing one branch of a conditional does not fix the conditional.**

The most recent finds are qualitatively different — seven gaps in a contract written the same day,
a counts collapse in an hour-old module. Finding bugs in code you just wrote is ordinary. Finding
latent maximum-severity defects in code that looks shipped is the worrying signal, and that has
stopped. That is a reason for cautious confidence, **not** a reason to skip the end-to-end
rehearsal.
