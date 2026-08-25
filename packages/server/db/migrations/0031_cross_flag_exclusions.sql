-- Migration 0031: the cross-scope exclusion register.
--
-- ---------------------------------------------------------------------------
-- Why now
-- ---------------------------------------------------------------------------
--
-- S20 excludes pairs of submissions that are two views of ONE repository from
-- cross-submission comparison — a git-native group submission commits an
-- add-only `.provenance/`, so each partner's archive physically contains the
-- other's signed logs, and without the exclusion the flagship collusion
-- detector fires at high severity on the two people the course assigned to
-- collaborate.
--
-- S20 also requires those suppressions be VISIBLE. A grader reading "no
-- findings" must be able to tell a comparison that was searched from one that
-- was withheld; otherwise the fix has only made the system quieter.
--
-- `partitionCrossScopes` has always produced both halves — the lineage classes
-- the heuristics consume, and the exclusion register a person reads. The browser
-- `/local/compare` route renders the register. The server never persisted it, so
-- the server-backed cross-flags view — the one course staff actually use — got
-- the suppression with no explanation for it. This table closes that.
--
-- ---------------------------------------------------------------------------
-- Why its OWN table and not a row in cross_flags
-- ---------------------------------------------------------------------------
--
-- Because an exclusion is not a finding. `analysis-core/coverage/cross-scope.ts`
-- states the rule in its header: "Nothing in this module is a Flag, contributes
-- to a score, or fails a check. An exclusion is a statement about the recording
-- ('these two archives are the same repository'), never a finding about a
-- person — §6 Rule 3."
--
-- A sentinel `heuristic_id` row in `cross_flags` would have inherited a
-- severity, a confidence and a heuristic config version, and would have been
-- counted by every query that counts findings — including the ones that feed a
-- submission's score and the ones a grader reads as an accusation list. On a
-- system whose failure mode is false accusation, that is not a shortcut worth
-- taking.
--
-- ---------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------
--
-- One row per LINEAGE GROUP, mirroring `SameScopeExclusion` as the partition
-- produces it — not one row per suppressed pair. `excluded_pair_count` carries
-- n*(n-1)/2 so the register can state how much of the comparison space was
-- withheld without materialising it.
--
-- `submission_ids` is a uuid[] rather than a child table: the row IS the group,
-- and there is nothing per-member to carry (contrast `cross_flag_participants`,
-- which exists to hold each participant's `supporting_seqs`). The trade-off,
-- stated rather than discovered later: array elements cannot be foreign keys, so
-- a deleted submission leaves a dangling id until the next cross run rewrites
-- the register. Retention deletes blobs only and never submission rows
-- (docs/admin-guide.md §6), and the read path LEFT joins each id, so a missing
-- member degrades to an unnamed id rather than silently vanishing from the
-- group. The array is written SORTED by the writer — the in-memory partition
-- orders members by a synthetic per-run bundle id, and persisting that order
-- would make two identical recompute runs produce different rows.
--
-- `shared_commits` holds `(repository, sha)` node keys. For a mixed-scope proof
-- — one partner on a recorder build that emits the D12 root-commit
-- discriminator and one on an older build — the same sha appears under two keys
-- and both are listed, because neither key was observed by both sides.
--
-- Deliberately NO `heuristic_config_version` column: the partition is derived
-- from signed `git.event` payloads alone and no heuristic weight, threshold or
-- enable flag can change it.
--
-- ---------------------------------------------------------------------------
-- Blast radius and rollback
-- ---------------------------------------------------------------------------
--
-- Purely additive. One new table, two new indexes, no existing table touched,
-- no column added or dropped anywhere else, no data rewritten. Nothing reads
-- this table until the code that writes it ships, and an empty register renders
-- as no panel at all — identical to today's page.
--
-- Rollback is `DROP TABLE cross_flag_exclusions;`. It is regenerated in full by
-- the next `recompute_cross_flags` run for the semester, so dropping it loses
-- no information that cannot be recomputed from the stored bundles.

CREATE TABLE cross_flag_exclusions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id         uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  reason              text NOT NULL,
  submission_ids      uuid[] NOT NULL,
  shared_commits      text[] NOT NULL DEFAULT '{}',
  excluded_pair_count integer NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Single-valued today. A CHECK rather than a free text column so a second
  -- reason has to be added on purpose, in a migration, at both ends.
  CONSTRAINT cross_flag_exclusions_reason_check
    CHECK (reason IN ('same_repository_lineage')),

  -- A lineage is two or more submissions. A one-member row would render as a
  -- suppression that never happened, and `excluded_pair_count` would be 0.
  CONSTRAINT cross_flag_exclusions_members_check
    CHECK (array_length(submission_ids, 1) >= 2)
);

COMMENT ON TABLE cross_flag_exclusions IS
  'S20 cross-scope exclusion register: one row per repository lineage NOT compared against itself. A fact about the recording, never a finding about a person (§6 Rule 3) — which is why it is not a row in cross_flags. Replaced wholesale by each recompute_cross_flags run. See migration 0031.';

COMMENT ON COLUMN cross_flag_exclusions.submission_ids IS
  'Members of the lineage, SORTED. Not foreign keys (arrays cannot be); the read path LEFT joins so a deleted submission degrades to an unnamed id. Sorted because the in-memory partition orders by a synthetic per-run bundle id and persisting that would break retry idempotency.';

COMMENT ON COLUMN cross_flag_exclusions.shared_commits IS
  'The (repository, sha) node keys that proved the lineage. A mixed-scope proof lists BOTH keys for one sha, because neither was observed by both sides.';

COMMENT ON COLUMN cross_flag_exclusions.excluded_pair_count IS
  'n*(n-1)/2 for n members — how many pairwise comparisons this exclusion withheld, so "no findings" can be read honestly.';

-- ---------------------------------------------------------------------------
-- Indexes
--
-- 1. The register is fetched by semester on every first page of
--    GET /semesters/:id/cross-flags (services/cross-flags/list.ts), and DELETEd
--    by semester at the top of every recompute (services/heuristics/run-cross.ts).
--    Both are the same equality predicate.
--
-- 2. GIN on submission_ids serves the list endpoint's `submission_id=` filter,
--    which becomes `submission_ids @> ARRAY[$1]::uuid[]`. Without it that filter
--    is a sequential scan of the register. The register is small — one row per
--    partnered group per semester — so this index is small too.
-- ---------------------------------------------------------------------------

CREATE INDEX cross_flag_exclusions_sem_idx
  ON cross_flag_exclusions (semester_id);

COMMENT ON INDEX cross_flag_exclusions_sem_idx IS
  'Semester fetch for the cross-flags list, and the semester DELETE in the recompute replace. See migration 0031.';

CREATE INDEX cross_flag_exclusions_submissions_idx
  ON cross_flag_exclusions USING gin (submission_ids);

COMMENT ON INDEX cross_flag_exclusions_submissions_idx IS
  'Containment index for the cross-flags list submission_id filter (submission_ids @> ARRAY[$1]::uuid[]). See migration 0031.';
