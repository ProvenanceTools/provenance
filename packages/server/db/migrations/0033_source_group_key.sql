-- Migration 0033: persist the Gradescope group, so partnership stops depending
-- on byte identity.
--
-- ---------------------------------------------------------------------------
-- The defect
-- ---------------------------------------------------------------------------
--
-- A Gradescope GROUP submission is one artifact belonging to N people, and the
-- export represents it by repeating the folder once per submitter.
-- `parse-metadata.ts` reads that list into `submitters: GradescopeSubmitter[]`
-- — the only first-class group object anywhere in this system — and
-- `local-path.ts` then FANS IT OUT into one `ingest_files` row per submitter,
-- each carrying a single scalar `match_sid`. After that loop the group is gone.
-- Nothing persists it. No column, no side table.
--
-- What puts the group back together today is a COINCIDENCE. `local-path.ts`
-- awaits ONE shared `rebuild(entries)` promise for all of a folder's
-- submitters, so every row gets identical bytes, so `dedupFile` — which is
-- blob-scoped since D9 — collapses them onto one submission and
-- `attachCoSubmitter` records the co-submitter. That works, and it is not an
-- invariant: it is one shared promise in one function. Anything that makes two
-- co-submitters' rebuilt archives differ by a byte — a change to scope
-- resolution, to entry ordering, to the zip writer, a folder partially skipped
-- for `no_seal` — silently produces TWO submissions with one contributor each.
--
-- And two submissions of one repository, in one assignment, are then handed to
-- the cross-submission heuristics, which do the obvious wrong thing: this is
-- S20 exactly, and `paste_shared_across_students` fires at high / 0.95 on two
-- people the course assigned to work together. The failure is silent in both
-- directions — nothing detects the split, and nothing reports it.
--
-- ---------------------------------------------------------------------------
-- The key, and why it is (folder, scope) and not the folder
-- ---------------------------------------------------------------------------
--
-- `source_group_key` is `<folderKey>/<scopePath>` — the Gradescope submission
-- folder plus the scope within it.
--
-- The folder alone is WRONG and would merge unrelated work. Nested manifest
-- discovery lets ONE folder yield several scopes (`parse-export.ts` emits one
-- item per `(folderKey, scopePath)`), and those are genuinely different
-- artifacts from different directories of one repository. Keying on the folder
-- would collapse them into a single submission and lose all but one. The pair
-- is the identity of "one archive, submitted by these people".
--
-- ---------------------------------------------------------------------------
-- Why a SEPARATE column from `submissions.group_key`
-- ---------------------------------------------------------------------------
--
-- `group_key` (migration 0029) is the VERSION LINEAGE key — "whose repeated
-- submissions supersede each other" — and it is an input to the GENERATED
-- `version_owner_key`, which reads it only when `student_id IS NULL`. These
-- submissions all have a submitter of record, so they are `student:` lineages
-- and always will be.
--
-- Overloading `group_key` to also mean "which upstream submission this came
-- from" would put a value into a generated column's input that is inert today
-- and load-bearing the moment a `group:` lineage is ever created — which is
-- precisely the kind of latent, silent coupling 0029's own header is about.
-- Two columns, two meanings, neither able to change the other.
--
-- ---------------------------------------------------------------------------
-- The unique index is the invariant
-- ---------------------------------------------------------------------------
--
-- `submissions_source_group_key` makes "one (folder, scope) is one submission"
-- a property of the schema rather than a claim about two code paths. Both
-- paths that could violate it now check first — phase 2 dedup and
-- `create-submission`'s re-check under the advisory lock — so in ordinary
-- operation this index never fires. That is the point: if it ever does, a
-- partner pair was about to be split into two cross-compared submissions, and
-- failing one ingest file loudly is strictly better than accusing two students
-- quietly.
--
-- Partial (`WHERE source_group_key IS NOT NULL`) so every non-Gradescope
-- submission — which is all of them on the filename path — is untouched and
-- unconstrained.
--
-- ---------------------------------------------------------------------------
-- Blast radius
-- ---------------------------------------------------------------------------
--
-- Purely additive. Two nullable columns and one partial unique index. Every
-- existing row has NULL in both, so the index covers nothing that exists today
-- and no row is rewritten. Rollback is dropping the index and the two columns.

ALTER TABLE ingest_files ADD COLUMN source_group_key text;

-- An empty key would put every group with a blank key into ONE group, which is
-- the same failure `submissions_group_key_check` guards in 0029.
ALTER TABLE ingest_files ADD CONSTRAINT ingest_files_source_group_key_check
  CHECK (source_group_key IS NULL OR source_group_key <> '');

COMMENT ON COLUMN ingest_files.source_group_key IS
  'The Gradescope (folderKey, scopePath) this file was fanned out from, as <folderKey>/<scopePath>. NULL on every non-Gradescope path. The DECLARED group: every ingest_files row sharing it names one artifact and one set of co-submitters. See migration 0033.';

ALTER TABLE submissions ADD COLUMN source_group_key text;

ALTER TABLE submissions ADD CONSTRAINT submissions_source_group_key_check
  CHECK (source_group_key IS NULL OR source_group_key <> '');

COMMENT ON COLUMN submissions.source_group_key IS
  'The upstream (folderKey, scopePath) this submission was ingested from. NOT the version lineage key — that is group_key, an input to the GENERATED version_owner_key, and the two must not be confused. See migration 0033.';

-- One (folder, scope) is ONE submission. See the header: this is the invariant,
-- not an optimisation.
CREATE UNIQUE INDEX submissions_source_group_key
  ON submissions (semester_id, source_group_key)
  WHERE source_group_key IS NOT NULL;

COMMENT ON INDEX submissions_source_group_key IS
  'Makes "one Gradescope (folder, scope) is one submission" unrepresentable rather than merely tested, and serves the group dedup lookup in worker phase 2 and create-submission. See migration 0033.';
