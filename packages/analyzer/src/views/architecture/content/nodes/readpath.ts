import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `readpath` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── What the staff member clicked ─────────────────────────────────────────
  r_cohort: {
    title: 'Cohort list',
    body: 'The one screen that must never touch a bundle. It is a semester’s submissions ranked by score, and it is answered entirely from denormalized columns on the submissions row (flag_counts and top_flags as jsonb, severity_rank as a generated integer, total_active_ms and total_idle_ms as nullable bigints), so a page needs no join to flags and no parse of any blob.\n\nThat denormalization exists because it once did the opposite. At fifty thousand rows the per-page flag aggregation and the top-flags window function were the p95; folding their results onto the submission row at write time turned the list back into a single indexed query with keyset pagination, so deep pages stay as cheap as the first. Active/Idle follow the same rule: computeStats already had the numbers at ingest, and writing them onto the row is what lets the list show them without opening a bundle. NULL means not yet written; the UI shows an em dash until the next ingest or recompute.\n\nThe pagination behind that claim was two things wrong at once, and fixing the first is what made the second reachable. The cursor carried a millisecond-precision timestamp and was compared through an OR-of-AND bucket predicate, so rows sharing a millisecond with the page boundary could be skipped or repeated — silently, since a paginated list has no way to notice a row it never saw. Timestamps are now projected to exactly six fractional digits and compared as a Postgres ROW VALUE, (ts, id) < (ts, id), which is one predicate rather than a disjunction and, crucially, is the only form an index can serve. Old cursors are rejected with a 400 rather than reinterpreted: treating a millisecond value as a bucket floor would silently drop the remainder of its millisecond, which is the exact defect being fixed, so the payload carries an explicit version, the timestamp is shape-checked to six digits, and the cohort variant’s kind was renamed from wall to wall_us so a legacy value cannot be mistaken for a new one. The unmatched tray had no invalid-cursor 400 at all and restarted from page one while the client believed it was paging forward; it has one now. Only the timestamp-keyed cursors were affected — score, student and assignment keys survive the ORM read intact and were left alone.\n\nNone of the three timestamp paginations had an index to sit on, which was invisible while the bucket predicate could not have used one. submissions_cohort_idx is keyed for sort=score_desc, not sort=ingested_desc, so the most-hit query in the product was a sort over a scan. Migration 0030 adds three keyset indexes — one on cross_flags, one partial on submissions for the default not-superseded path, one partial on ingest_files for the unmatched tray — mirroring each query’s own column order and direction. On a fresh hundred-thousand-row database all three drop from a sequential scan plus sort to an index-only scan, and the row-value comparison shows up as the index condition. They are additive, index-only, and each is a single DROP INDEX to roll back.',
    links: [
      { label: 'cohort/list.ts', href: `${GH}/packages/server/src/services/cohort/list.ts` },
      { label: 'keyset.ts', href: `${GH}/packages/server/src/services/keyset.ts` },
      {
        label: '0030_keyset_pagination_indexes.sql',
        href: `${GH}/packages/server/db/migrations/0030_keyset_pagination_indexes.sql`,
      },
      {
        label: '0014_submissions_denormalized_flags.sql',
        href: `${GH}/packages/server/db/migrations/0014_submissions_denormalized_flags.sql`,
      },
      {
        label: '0021_submissions_active_idle_ms.sql',
        href: `${GH}/packages/server/db/migrations/0021_submissions_active_idle_ms.sql`,
      },
    ],
  },
  r_over: {
    title: 'Overview tab',
    body: 'Mostly cheap, not entirely. The summary, score, flag counts, validation verdict and file list all come from stored rows. But the per-session list (how many sessions, when each started, how many events each holds) has no table behind it any more, so assembling the overview does parse the bundle once through loadSubmissionIndex.\n\nThat same parse now also yields the assignment manifest — course, the capability fields, certificate validity, the offline trust-chain verdict, and which capture signals the course had switched off. It costs no extra query and no second parse because the bundle is already open, and it is the one place a reviewer can learn that a signal is missing by policy rather than by omission. A 1.0 or 1.1 bundle produces the "nothing recorded" shape rather than an absent field: every value null, no disabled signals, and a trust chain reported as legacy.\n\nThe tab keeps the expensive part off the first paint. The full event index is the priciest fetch in the app, so Overview loads it lazily and only when a panel that needs supporting-event labels is actually opened; until then it shows bare global indices. This is why the diagram draws it toward the cheap path even though one bundle parse is unavoidable.',
    links: [
      { label: 'summary.ts', href: `${GH}/packages/server/src/services/submissions/summary.ts` },
      { label: 'Overview.tsx', href: `${GH}/packages/analyzer/src/views/submission/Overview.tsx` },
    ],
  },
  r_time: {
    title: 'Timeline tab',
    body: 'The events endpoint reproduces, row for row, what the deleted events table used to return (seq is the global chronological index, prev_hash and hash come straight off the raw envelope), except it builds those rows in memory from the parsed bundle instead of reading them from Postgres. The shape, ordering, cursor semantics and the opt-in total_count were all preserved byte-for-byte so the API contract did not move when the table did.\n\nFiltering and keyset pagination then happen over that in-memory list. total_count is returned only when a kind, file or session filter is present, the same cheap-count rule the SQL had, kept so an unfiltered full-stream page never pays to count.',
    links: [
      { label: 'events/query.ts', href: `${GH}/packages/server/src/services/events/query.ts` },
    ],
  },
  r_replay: {
    title: 'Replay tab',
    body: 'Replay reconstructs a file as it stood at a chosen moment by applying the recorded deltas forward to a target global index. When the caller names no point, the server resolves a sensible default (the last doc.save for that file, or failing that the last event in the stream) from the same index it just parsed, so "show me the final state" costs no extra query.\n\nEvery reconstruction is served with a short private cache header, which is the client-side staleness bound: the server-side reconstruction cache is process-local and never explicitly invalidated, so a brief TTL is what stops a superseded view lingering.',
    links: [
      { label: 'files.ts', href: `${GH}/packages/server/src/api/v1/routes/files.ts` },
      { label: 'reconstruction.ts', href: `${GH}/packages/server/src/services/reconstruction.ts` },
    ],
  },
  r_src: {
    title: 'Source tab',
    body: 'The tab that has to work without the thing it displays. Submitted source bytes are stripped at ingest, so nothing here is read from stored file content. The file list and per-file verdicts are derived from the signed manifest compared against the on-disk hashes recorded in the event stream; because the manifest is signature-verified, the code trusts its sha for present files rather than re-hashing bytes that are gone.\n\nThe content shown is reconstructed by replaying the log to the end, and the tab now refuses to overclaim what that reconstruction is. Its lede says in as many words that this pane is not the file that was submitted; for a file whose verdict is match it says only that the submitted code is EXPECTED to be identical to what is shown, because the hash agreeing is a statement about the last state the recorder observed on disk, not a byte-for-byte proof that the replay reproduced it. Reconstruction fidelity is not itself verified anywhere, so asserting equality would have been the tab quoting a guarantee no code makes. For a mismatch the pane is the recorded final state, which by definition differs from what was handed in.\n\nThe chain-integrity gate that decides whether any of those verdicts may be trusted is now READ rather than re-derived. getStoredChainIntact selects validation_results.check_3_status and passes a { chainIntact } gate down into submittedFileVerdicts; the tab used to run its own live runValidation(bundle) over the re-parsed blob, which is a second implementation of a question the ingest pipeline had already answered and stored. Two implementations of "did the chain verify" are two answers waiting to disagree, and the one a grader reads must be the one the validation tab shows.',
    invariant:
      'The Source tab never reads stored source bytes; there are none. Verdicts come from the signed manifest, the chain gate from the stored validation row, and content is replayed from the log — which is expected to match, never asserted to.',
    links: [
      {
        label: 'submitted-files.ts',
        href: `${GH}/packages/server/src/services/submissions/submitted-files.ts`,
      },
      { label: 'Source.tsx', href: `${GH}/packages/analyzer/src/views/submission/Source.tsx` },
      {
        label: 'validation.ts (getStoredChainIntact)',
        href: `${GH}/packages/server/src/services/submissions/validation.ts`,
      },
    ],
  },
  r_recomp: {
    title: 'Recompute after tuning',
    body: 'Committing a new heuristic configuration does not re-read stored scores; it re-derives them. Each submission in the semester is parsed again through the same index the original ingest used, the heuristics run over it under the new weights, and its flags and denormalized columns are rewritten. Validation is not touched: integrity verdicts are read back from validation_results, never re-decided by a weight change.\n\nThis is also where source stripping and retention meet the read path honestly. A submission whose blob has been swept can no longer be re-analysed, so the recompute job counts it as failed and finishes rather than aborting, which is why recompute_jobs carries a separate failed counter and a partial terminal status.',
    links: [
      {
        label: 'run-per-submission.ts',
        href: `${GH}/packages/server/src/services/heuristics/run-per-submission.ts`,
      },
      { label: 'recompute.ts', href: `${GH}/packages/server/src/jobs/recompute.ts` },
    ],
  },

  // ── Served from Postgres ──────────────────────────────────────────────────
  pgq: {
    title: 'The stored-results SELECT',
    body: 'Everything a submission was found to be (its score, its flags, its per-file statistics, its eight validation verdicts, the cross-flags it participates in) was computed once at ingest and written here. A read serves the row; it never re-runs the analysis to answer a question about it.\n\nThat is a deliberate trade against the events reparse below. Findings are small, queried constantly, and must be filterable and rankable across a whole cohort, so they earn permanent rows. The raw event stream is large, queried for the few submissions someone actually opens, and needs no cross-submission index, so it is not stored at all.',
    links: [
      { label: 'summary.ts', href: `${GH}/packages/server/src/services/submissions/summary.ts` },
      {
        label: 'validation.ts',
        href: `${GH}/packages/server/src/services/submissions/validation.ts`,
      },
    ],
  },

  // ── Needs the event stream ────────────────────────────────────────────────
  lsi: {
    title: 'loadSubmissionIndex',
    body: 'The single door every event-stream read goes through: timeline, replay, reconstruction, per-submission recompute, cross-flag feature extraction, the summary’s session list. It resolves the blob key and sha from the submission row, fetches and parses the stored bundle, builds the EventIndex, and returns { bundle, index }. It is the direct replacement for reading the removed events table.\n\nIt works against the stripped, provenance-only bundle precisely because it needs none of the removed source: reconstruction and heuristics derive entirely from the .slog logs. Nothing about the events is precomputed; the cost is paid per open, not per submission, and only for the submissions someone opens.\n\nOne piece of cryptography happens here rather than at the callers: the Manifest 2.0 trust chain is walked and the verdict stamped on the parsed bundle before it is handed out or cached. The course-signed capture policy gates heuristics, so it may only be honoured after its signature has been checked, and the read paths that do not re-run validation — the cross-flag job above all — would otherwise be reading a policy nobody verified. Doing it at the single door means a read path added later cannot forget, and the cost lands once per parse rather than once per read.\n\nA second verdict is stamped in the same place and for the same reason: contributor resolution. establishBundleContributors answers “which contributor produced this session?” from session.start.identity alone — never machine_id, which is session-salted; never a git author, which this system does not record; never the upload filename, which names the submitter and in a shared repo is at most one of the contributors. Downstream code then reads the one verdict through the synchronous contributorOf(bundle, sessionId) instead of re-deriving identity. Both stamps take the deployment’s root public key as a parameter, because analysis-core is isomorphic and holds no key of its own.\n\nA deployment with no root key still works, and that is a requirement rather than a tolerance. Bundles load and analyse; every identified session reads unverifiable / no_root_key, which isIdentityCheckFailure() reports as false — “we could not check”, never “we checked and it failed”. Reporting the second would turn an unset environment variable into a class-wide integrity finding. A session with no identity block at all is a third thing again: unattributed, the ordinary state of a student who never enrolled, blameless and never rendered as suspicious. Forgetting the stamp entirely leaves every session unattributed, which fails toward MORE findings rather than toward a false accusation — still a bug, and load-index.contributors.test.ts catches it.',
    links: [
      {
        label: 'load-index.ts',
        href: `${GH}/packages/server/src/services/bundle/load-index.ts`,
      },
      {
        label: 'resolve-contributors.ts',
        href: `${GH}/packages/analysis-core/src/identity/resolve-contributors.ts`,
      },
    ],
  },
  cache: {
    title: 'In the LRU cache?',
    body: 'A small process-local LRU (sixteen fully-parsed bundles) sits in front of the parse, because opening one submission fires several reads that each want the same index and re-parsing per read would be wasteful.\n\nThe key is what makes it safe without any coordination: it is submissionId plus the bundle’s sha256, not the submission id alone. A re-ingested or superseded blob gets a new sha and therefore a new key, so a stale parse can never be served and no cross-process invalidation message is needed. Eviction is plain least-recently-used; the cache is never explicitly cleared in production, and it does not need to be.\n\nBoth crypto verdicts — the Manifest 2.0 trust chain and the contributor resolution — are stamped on the Bundle before it enters the cache, so a hit returns them with it rather than recomputing or, worse, losing them. They are stamped per bundle and never shared: one submission handed another’s contributor stamp would attribute one student’s sessions to a different person, so that case has its own test.',
    links: [
      { label: 'lru-cache.ts', href: `${GH}/packages/server/src/services/bundle/lru-cache.ts` },
      {
        label: 'load-index.ts',
        href: `${GH}/packages/server/src/services/bundle/load-index.ts`,
      },
    ],
  },
  blob: {
    title: 'Blob store (read side)',
    body: 'On a cache miss the whole object is read and buffered before parsing. It is provenance-only (signed manifest plus .slog logs, no student source) which is exactly why re-parsing it is enough to answer every read: the event stream, and the file content reconstructed from it, live in the logs.\n\nThe object is also the one thing retention removes. Once it is swept the derived rows still answer the cohort list and the overview, but this door returns nothing and the deep tabs (timeline, replay, source, recompute) degrade to "no longer available" rather than erroring.',
    links: [
      { label: 'blobs.ts', href: `${GH}/packages/server/src/services/storage/blobs.ts` },
      { label: 'retention-sweep.ts', href: `${GH}/packages/server/src/jobs/retention-sweep.ts` },
    ],
  },
  stamp: {
    title: 'Contributor stamp',
    body: 'Between parsing the bundle and building the index, two passes run that answer questions about the bundle as a whole rather than about any one event: establishBundleTrust walks the Manifest 2.0 chain, and then establishBundleContributors resolves who produced each session. The order is load-bearing — contributors runs second because an archived 2.0 identity anchors to the Manifest 2.0 course_cert that the trust pass has just established.\n\nBoth stamp the Bundle IN PLACE rather than returning a copy. That looks like a smell and is deliberate: every holder of the reference — this cached { bundle, index }, the browser’s bundle context, the heuristics handed the same object — must see the same verdict, and returning a copy would silently leave the originals unattributed. Since unattributed is the state under which contributor-gated behaviour keeps firing, a copy would degrade quietly rather than loudly.\n\nThe placement on this plate is the point. The call sits INSIDE the cached region, past the early return, so it happens once per parse and not once per read. A cache hit returns the identical SubmissionIndex object, hence the identical Bundle, hence the identical contributors object — asserted by identity, not by equality, in load-index.contributors.test.ts. Chain walking is signature verification, so paying it on every timeline scrub or replay seek would be a real cost on a hot path.\n\nTwo submissions can never share one stamp. The cache key is the submission id joined to the stored blob’s sha256, so entries are submission-scoped by construction and each was produced by its own resolution pass over its own parsed bundle; a regression test reads Alice, then Bob, then Alice again and asserts the two stamps are not the same object. The sha half of the key is also the only invalidation there is: nothing evicts explicitly on re-ingest or recompute, but a superseded blob has a different sha and therefore a different key, so a stale parse is simply unreachable rather than actively freed.\n\nThe root public key reaches this point from the server’s own configuration, not from the bundle. When it is unset the stamp still happens and still succeeds — every identified session simply resolves unverifiable / no_root_key, which reads as "cannot check" rather than as a finding.\n\nOne consequence worth knowing: the cache is a sixteen-entry LRU held per PROCESS, so the API and the worker each keep their own. The cross-flags job walks every submission in a semester and will churn straight through sixteen entries, so it gets no benefit from this cache at all.',
    invariant:
      'The stamp is computed inside the cached region and mutates the bundle in place, so one submission has exactly one contributor verdict that every consumer shares.',
    links: [
      {
        label: 'load-index.ts',
        href: `${GH}/packages/server/src/services/bundle/load-index.ts`,
      },
      {
        label: 'resolve-contributors.ts',
        href: `${GH}/packages/analysis-core/src/identity/resolve-contributors.ts`,
      },
    ],
  },
  idx: {
    title: 'EventIndex',
    body: 'Building the index is where a bundle of independent per-session logs becomes one stream. Every event is placed in a single chronological order across all sessions and assigned a globalIdx (its position in that order) alongside per-session and per-file views for the readers that want them.\n\nThat globalIdx is the reason dropping the events table cost the stored findings nothing. flags.supporting_seqs and cross_flag_participants.supporting_seqs are arrays of these indices, and buildIndex recomputes them identically from the re-parsed bundle (same chronological ordering, same integers), so evidence written months ago still resolves to the right events today.',
    links: [
      {
        label: 'build-index.ts',
        href: `${GH}/packages/analysis-core/src/index/build-index.ts`,
      },
    ],
  },
  recon: {
    title: 'reconstructFileSegmentedWithProvenance',
    body: 'Replays the edits for one file up to a global index and returns not just the resulting text but a provenance tag per position (typed, pasted, or arrived by external change) which is what lets the UI colour a line by how it came to exist.\n\nIt is honest about its own limits. When a file was reshaped by a large paste or an external edit its reconstruction is marked tainted at ingest, and the content route then returns an empty body with a warning rather than text it cannot fully account for. Reconstruction reads only the log; it never consulted stored source even before stripping made that impossible.\n\nTainted is not the only way there can be no answer. Where two contributors edited one file on branches the recorded evidence does not order, there is no single content at all, and the segment-based path reports that as its own state rather than replaying the wall-ordered interleaving of two machines\u2019 clocks \u2014 which would produce text that existed on neither. Both routes now distinguish the three answers. The server read path builds a real ReconstructionScope through reconstructionScopeFor(bundle, index) and calls the SEGMENTED entry point, so an unorderable file comes back as an empty body carrying FILE_RECONSTRUCTION_CONCURRENT or FILE_RECONSTRUCTION_UNKNOWN rather than as text. That was the last gap on this route, and closing it mattered because the alternative was not a missing feature: serving one branch, or the linearization of all of them with per-character attribution, puts a file that existed on nobody\u2019s disk in front of a grader as fact.\n\nThe unscoped reconstructFileWithProvenance still exists and is still reached \u2014 the segmented path delegates to it for any file no second contributor touched, and stats.ts, internal-move.ts and the Source tab\u2019s content extractor call it directly. None of those is an ambiguity-sensitive read: the first two are ingest-time analysis, and the third is explicitly labelled event_replay to the reader.',
    links: [
      {
        label: 'reconstruct-segments.ts',
        href: `${GH}/packages/analysis-core/src/index/reconstruct-segments.ts`,
      },
      {
        label: 'reconstruct-file-provenance.ts',
        href: `${GH}/packages/analysis-core/src/index/reconstruct-file-provenance.ts`,
      },
      {
        label: 'reconstruction.ts (server)',
        href: `${GH}/packages/server/src/services/reconstruction.ts`,
      },
    ],
  },
  note: {
    title: 'Why there is no events table',
    body: 'Materialized events were once one Postgres row per recorded event, never purged: the dominant storage and write-amplification cost in the system. The insight that removed them is that the .slog logs inside the stored bundle already are the event stream, losslessly, and every read that needs events can re-derive them.\n\nThe trade is CPU for storage, weighted by how often each is paid. Stored events cost space forever and are read for the small fraction of submissions anyone opens; re-parsing costs a parse only when a submission is actually opened, and the LRU cache absorbs the repeat reads within one viewing. What made this safe rather than merely cheaper is that nothing derived was lost: the integer evidence on flags recomputes identically from the re-parsed stream.',
    invariant:
      'The stored bundle is the sole source of the event stream. Reintroducing an events table needs explicit approval.',
    links: [
      {
        label: '0019_drop_events.sql',
        href: `${GH}/packages/server/db/migrations/0019_drop_events.sql`,
      },
      {
        label: 'load-index.ts',
        href: `${GH}/packages/server/src/services/bundle/load-index.ts`,
      },
    ],
  },
};

/**
 * Self-explanatory labels that deliberately carry no detail panel.
 *
 * These are plumbing steps in the deep-read flow whose diagram label already
 * says everything true about them — the miss-path fetch, the parse call, the
 * returned tuple, and the Postgres cylinder itself (covered richly by the ER
 * and master diagrams).
 */
export const noDetail: string[] = ['fetch', 'parse', 'ret', 'pg'];
