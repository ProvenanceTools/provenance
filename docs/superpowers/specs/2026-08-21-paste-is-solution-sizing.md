# `paste_is_solution` measures the wrong ratio — analysis, and why the fix is not yet landed

**Status: RESOLVED 2026-08-21.** Landed as `fix(analysis-core): paste_is_solution gates on
final-file coverage, not paste survival`. The blocking hypothesis below was **REFUTED** — see
"Resolution" at the end of this file before reading the rest of it. `no_intermediate_errors`
(the "Also noticed" section) was assessed in the same pass and also fixed.
Found 2026-08-21 while fixing the git-merge false-accusation family.

## The defect

`paste_is_solution` raises **high / 0.85** — the most damning flag in the catalogue. Its gate is

```
shared_lines / paste_lines >= pasteIsSolution.lineOverlap   // default 0.8
```

`candidate-pastes.ts` applies **no size gate**, so the ratio is trivially `1.0` for _any_ paste
whose lines survive into the final file, regardless of size. A student who hand-types a 60-line
file and pastes a 3-line import block on top scores 1.0 and gets `high`. Every honest paste of a
boilerplate header, licence comment, or provided function signature reaches it.

This is **solo-reachable** — it needs no partner, no git, no collaboration — and is therefore
outside the "honest pair work" wording of the definition-of-done row, which is likely why it
survived the false-accusation audits.

## Why the ratio is wrong

The claim the flag makes is _"the submitted file is pasted code, not written code."_ The evidence
for that claim is how much of the **final file** the paste accounts for, not how much of the
**paste** survived:

|                                             | survival = shared/paste | coverage = shared/final | should fire?                        |
| ------------------------------------------- | ----------------------- | ----------------------- | ----------------------------------- |
| paste 1000 lines, trim to the 100 submitted | 0.1                     | 1.0                     | **yes** — submitted code is pasted  |
| paste 3 lines into a 60-line typed file     | 1.0                     | 0.05                    | **no** — the student wrote the file |

Survival is not evidence for the claim. Coverage is.

## The proposed fix (implemented, verified partially, then reverted)

1. `config.ts`: `pasteIsSolution.lineOverlap` -> **`finalFileCoverage`** (0.8), plus a new
   **`minSharedLines`** (10).
2. `paste-is-solution.ts`: gate on `shared / finalFileLines >= finalFileCoverage`, with
   `shared >= minSharedLines` checked FIRST. Keep the survival ratio in `detail.survivalRatio`
   for the grader reading the finding — informative, never load-bearing.
3. `minSharedLines = 10` is deliberately `largePaste.minLines`. `large_paste` declines to raise
   even `medium` below 10 lines; `paste_is_solution` raises `high`, a strictly stronger claim,
   so it must not be reachable below the same floor.

Coverage is **per candidate** and deliberately does not sum: four pastes each covering 25% clear
neither gate. "How much of this file arrived without being typed" is `low_typing_high_output`'s
question, measured on characters.

## Why it was reverted rather than landed

The change is ~90% done but **two tests in the internal-move downgrade path still fail**, and the
reason is a genuine product question, not a fixture defect:

- `cutAndPasteBack` types the solution, cuts it, and pastes it back. Under the OLD ratio it fired
  (survival = 1.0). Under coverage it does not.
- Working hypothesis, NOT yet confirmed: the reconstructed final file contains the solution
  **twice** (typed + pasted back), so coverage is ~0.5 and the flag correctly declines.

If that hypothesis is right, the two tests are asserting a behaviour the new semantics
deliberately change, and the correct resolution is a decision about what the internal-move
DOWNGRADE path should assert when the moved block is only half the final file — not a fixture
edit. Resolving it by resizing fixtures until green would be exactly the failure mode this branch
has hit four times (a test pinning a defect AS the requirement).

**Confirm the hypothesis first** (log `finalFileLines` / `sharedLines` for `cutAndPasteBack`),
then decide.

## Fixture sizing note for whoever finishes this

Several existing fixtures are below the new 10-line floor and legitimately need scaling, because
they are test-sized rather than realistic. Scaling preserves what they assert. Known:
`SOLUTION` (6 lines, used by the three move tests), the "100% of the final file" paste (5 lines),
and the lowercase `solution` in the move-downgrade describe (9 lines). Scaling those three fixes
three of the five initial failures; do NOT touch the "final file content is empty" negative test,
whose small paste is incidental to what it asserts.

## Also noticed, not investigated

`no_intermediate_errors` fires on "file has content at end + no non-zero exit codes", which an
honest student who writes correct code first time satisfies. It is `medium`, so outside the
definition-of-done row's letter, but it is the same family and deserves the same scrutiny.

---

## Resolution (2026-08-21)

### The `cutAndPasteBack` hypothesis was REFUTED

The fixture was instrumented before anything was resized. `establishedReplayState` returns the
solution **once**, not twice:

```
finalFileLines = 6
candidate { origin: 'paste', pasteLines: 6, sharedLines: 5,
            survival: 0.833, coverage: 0.833 }
```

Coverage (0.833) clears the 0.8 gate. The `cut` delta — replace `(0,0)-(5,0)` with `''` — removes
the typed copy correctly, and reconstruction is not wrong. The **only** thing failing those three
tests was the new `minSharedLines` floor: 5 shared lines < 10.

(`sharedLines` is 5 while `lineCount` is 6 because the fixture ends in a newline: `lineCount`
splits on `'\n'` and counts the trailing empty segment, `diffLines` does not. Pre-existing, makes
the gate _stricter_ rather than looser, left alone.)

So the tests were not asserting a behaviour the new semantics change, and no product decision was
needed. Scaling those fixtures preserves exactly what they assert (internal-move classification,
which is not about size) and was the correct and sufficient fix.

### What landed

- `config.ts`: `pasteIsSolution.lineOverlap` → `finalFileCoverage` (0.8) + `minSharedLines` (10).
- `paste-is-solution.ts`: floor checked first, then `shared / finalFileLines`. `detail` now carries
  `coverageRatio`, `survivalRatio`, `finalFileLines`, `sharedLines`, `pasteLines`.
- Fixtures scaled past the floor: `paste-is-solution.test.ts` (`SOLUTION`, the 100%-of-file paste,
  the 80%-boundary paste, the `paste_likely` solution), `reconstruction-gate.test.ts` (`SOLUTION`),
  `run-heuristics.test.ts` (the snapshot paste was `'x'.repeat(600)` on ONE line; a one-line blob
  is not a fixture for a pasted `solution.py`, so it is now 20 lines).
- Every "does not fire" test is paired with a "still fires on the real thing" test.
- `docs/heuristics.md` updated.

### Other consumers of `iterateCandidatePastes` — do they inherit the unsized-candidate problem?

- `large_paste` — **no**. Gates on `minChars` 200 / `minLines` 10 explicitly.
- `paste_matches_known_source` — **no**. The hash path needs an exact sha256 match against a
  course-curated corpus; the fuzzy path normalises by `max(pasteLines, referenceLines)`, so a
  3-line paste against a 40-line reference block scores 0.075. Small pastes cannot reach either.
  (A trivially small _corpus entry_ could be matched exactly, but that is corpus curation.)
- `internal_move` — n/a, a classifier that emits no flags of its own.

`paste_is_solution` was the only one.

### `no_intermediate_errors` — assessed, three defects, fixed

Not working as designed. Confirmed by instrumentation, not by reading:

1. Evaluated **per session**, so failures in session 1 + a clean run in session 2 raised `medium`
   "No terminal errors detected" against a log containing three failures. Now submission-wide.
2. `exit_code: undefined` counted as a **success**, so a bundle where nothing reported an exit code
   fired while claiming those commands "exited with code 0". Now counted as neither.
3. No volume floor — one `ls` and one keystroke sufficed. Now
   `noIntermediateErrors.minCommandsWithExitCode` = 5.

Plus: any session with shell integration off now suppresses the positive flag entirely, and the
title/description no longer assert more than was observed.
