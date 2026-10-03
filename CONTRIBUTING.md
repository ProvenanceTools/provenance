# Contributing to Provenance

Provenance is under active development. `ProvenanceTools/provenance` is the central repository
and the source of truth. All work happens on branches in your own fork and comes back through
pull requests.

## Prerequisites

You need Node 22, Docker, VS Code, and (only for the `/architecture` page) Graphviz. The full
setup, from a blank machine to the whole system running locally, is in
**[`docs/dev-setup.md`](docs/dev-setup.md)**. Do that first.

## Workflow

1. Fork `ProvenanceTools/provenance` to your own GitHub account.
2. Clone your fork and set it up by following [`docs/dev-setup.md`](docs/dev-setup.md).
3. Sync with upstream, then create a branch for one feature or fix, named as described in
   [Branch names](#branch-names).
4. Make your change, and add or update tests for it.
5. Sync your branch with upstream `main` again, then run the [checks](#checks-before-you-open-a-pr)
   and fix anything that fails.
6. Push the branch to your fork and open a pull request against `ProvenanceTools/provenance:main`.
7. Respond to review: push follow-up commits until a maintainer approves and merges the PR. Expect
   some back and forth.
8. Sync your fork's `main` with upstream and delete the merged branch before starting the next
   change.

To sync with upstream:

```sh
git fetch upstream
git switch main && git merge --ff-only upstream/main && git push origin main
git switch <your-branch> && git rebase main
```

## Checks before you open a PR

There is no CI yet, so these checks are the gate. Run all of them, in this order, from the repo
root, and make sure each one passes:

```sh
npm run build        # first: typecheck and tests read the built output
npm run typecheck
npm run lint
npm run test         # needs Docker running
npm run test:tools
```

`npm run test` does not cover `tools/`, so `npm run test:tools` is a separate step. If you changed
the recorder, also run `npm run test:integration --workspace=packages/recorder`.

Every change ships with tests: new behaviour gets new tests, and a bug fix gets a regression test
that fails without the fix. If a test fails, do not weaken its assertion to make it pass. Tests
encode requirements, so raise it in the PR instead.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, with a
lowercase, imperative summary and no trailing full stop.

| Type       | For                                             |
| ---------- | ----------------------------------------------- |
| `feat`     | A new feature or user-visible behaviour         |
| `fix`      | A bug fix                                       |
| `docs`     | Documentation only                              |
| `test`     | Adding or fixing tests only                     |
| `refactor` | A code change that neither fixes nor adds       |
| `perf`     | A performance improvement                       |
| `style`    | Formatting only, no code change                 |
| `chore`    | Tooling, dependencies, deployment, housekeeping |
| `revert`   | Reverting an earlier commit                     |

The scope is optional and names the area touched, usually a package: `recorder`, `server`,
`analyzer`, `analysis-core`, `log-core`, `shared`, `deploy`, `tools`. For example:

```
fix(recorder): seed the idle window at arm time, not session start
docs: describe check 7's late-save window
```

Keep commits small and focused. They are easier to review and easier to revert.

## Branch names

Use the same types as commit messages, followed by a short kebab-case description:
`<type>/<description>`. For example, `feat/log-size-rotation` or
`fix/check7-late-observed-autosave`.

One branch covers one feature or fix. Do not combine several major changes in one branch.

## Rules that are easy to miss

- **Keep the `/architecture` page current.** If your change adds, removes, or renames an event
  type, validation check, or heuristic, or changes the ingest pipeline, the recorder, the log
  format, the database tables, or an analyzer route, update the architecture page in the **same
  PR**. [`CLAUDE.md`](CLAUDE.md) has the full list of triggers and the steps. A stale page is a
  failing test.
- **Never commit real student data.** That means no real submissions, bundles, `.slog` logs,
  rosters, Gradescope exports, or anything derived from them, including in test fixtures. Use
  generated data (`npm run seed`, `gen:fixture`) or your own recordings.
- **Do not bump version numbers, and do not edit
  `packages/analysis-core/src/heuristics/config/known-good-extension-hashes.json`.** Maintainers
  change both as part of a release.
- **Do not add dependencies without asking.** Open an issue or ask in the PR first.
- **Do not change the log format or the API schema casually.** The log format is the contract
  between recorder and analyzer, and `packages/shared` is the contract between server and analyzer.
  Changes to either need explicit approval.

## Reporting security issues

**Do not open a public issue** for a security vulnerability or for a way around the recorder,
such as forging, editing, or hiding a recording without detection. Report it privately through
GitHub's [private vulnerability reporting](https://github.com/ProvenanceTools/provenance/security/advisories/new)
(the **Security** tab, then **Report a vulnerability**). Students can read this repository, so a
public report of a bypass is a working exploit.

## AI coding agents

[`CLAUDE.md`](CLAUDE.md) is the source of truth for how AI agents work in this repository: its
conventions, architecture rules, and the things that are easy to get wrong. It is also the best
single summary of the codebase for human contributors, so read it before your first PR.
