import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `analysis` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Loader ────────────────────────────────────────────────────────────────
  unzip: {
    title: 'Unzip and parse',
    body: 'The archive layout is flat and closed: manifest.json, manifest.sig, one session-<uuid>.slog and one .slog.meta per session, and, for 1.1 bundles, exactly the paths the manifest’s submission_files names. Anything else aborts the load. That forces a two-pass read, because the whitelist cannot be known until manifest.json has been parsed, so unrecognised entries are deferred and resolved only once the manifest is in hand. A malformed manifest yields an empty whitelist, which turns every deferred entry into a rejection rather than quietly admitting it.\n\nThe structural failures are hard failures rather than warnings: a .slog with no .meta sidecar, a .meta with no .slog, zero sessions at all. Sessions are then parsed in parallel (each log is self-contained, so nothing about the order matters) and sorted oldest-first by the wall clock inside their own session.start. Filenames are random UUIDs and carry no ordering information, which is why the sort key has to come from the payload.\n\nThere are two seal shapes, not one. A git-submitted assignment never runs seal, so it carries no manifest.json at all — instead the recorder rewrites a ROLLING seal on every checkpoint: manifest-<session_id>.json plus manifest-<session_id>.sig, one pair per session, each covering only its own session. Per-session filenames are what make a shared repo’s .provenance/ add-only and therefore mergeable, exactly as session-<uuid>.slog already is. The loader recognises them through log-core’s parseRollingManifestFilename (which deliberately does not match manifest.json) and synthesizes an in-memory union manifest at format_version 1.2 spanning every per-session manifest found; that is why the shape validator accepts N sessions at 1.2 while each on-disk FILE must cover exactly one. A bundle with no rolling manifests never enters that path and is byte-for-byte what it was. A bundle carrying both keeps the classic manifest as its manifest and still verifies the rolling seals alongside it. Only a bundle with neither is the no_seal case.\n\nProblems with the rolling seals — an unsigned manifest, a stray .sig, a manifest copied sideways under another session’s filename, a seal naming a session with no .slog, a .slog no seal covers — do not abort the load. They are recorded as defects and reported by check 1, because rejecting the archive over one half-written seal would discard every other session’s findings, which is the wrong direction for an integrity tool. One thing that is deliberately NOT a defect is two seals naming different extension_hash values: a student who updates their recorder mid-assignment produces exactly that, and a single manifest.json simply carries whichever build was current at seal time. The union keeps the newest session’s hash as its scalar and every observed hash alongside it, so the known-good allowlist can check all of them rather than only the one the scalar kept.\n\nThe loader also resolves, for a purely rolling-sealed bundle, how much of each log its seal actually covers. A rolling seal is rewritten at session start, at every checkpoint and at shutdown, hashing the log as it stands at that moment, so its digests commit to a PREFIX rather than to a finished file — and a git submission has no seal step, so the archived .slog routinely runs past its own last seal. Because the .slog is append-only NDJSON, the sealed prefix is recovered by scanning entry boundaries with an incremental sha256; the .slog.meta is rewritten whole on every checkpoint, so its earlier states are re-derived instead by truncating the checkpoint list. The result rides on bundle.rollingSeal.coverage and is computed only when there is no classic manifest.json, because a classic seal is terminal and its digest does commit to the whole file.\n\nResolving a seal to the log it covers is where a bundle’s TWO session-identifier spaces meet, and they are different values in every real bundle. The uuid in session-<uuid>.slog is minted by the writer when it opens the file; the logical session id is session.start.data.session_id, and that is what manifest-<session_id>.json is named after, what the manifest’s sessions[].session_id carries, and what every downstream consumer holds. A seal is therefore matched against the ids read out of the packed logs’ session.start, never against the filenames — the pairing between a parsed session and its bytes is fixed at parse time, before the wall-clock sort discards it. Keying that lookup on the filename uuid instead missed on every session of every git submission, which did not surface as an error: coverage simply came out empty, and an empty coverage map is read as “this is a classic seal”, so whole-file equality was applied to a digest that only ever committed to a prefix. Every honest git submission whose last seal was non-final was accused at high severity. The filename uuid is now a distinct branded type, so that lookup no longer compiles, and every fixture in the repo now gives a session two DIFFERENT uuids by default — with equal ids the broken code passes, which is why the defect survived both the analysis suite and the recorder-to-analyzer conformance gate.\n\nOne rolling seal escapes the prefix reading. The recorder takes a last roll at shutdown, after session.end has been recorded and both log files are flushed and closed, and marks that one final — a boolean inside the signed payload, so it cannot be added, flipped or stripped without the session’s own key. A final seal has no future left that it could fail to attest to, so the loader reads its digests whole-file, skips the prefix search entirely, and an entry appended after the session ended fails. That is what closes the one hole the prefix reading otherwise leaves open, in which a post-session append is indistinguishable from honest mid-session growth. Its absence is never a finding: a crash, a power cut, a full disk, a read-only checkout or a git checkout that removed .provenance/ all leave the last non-final seal standing, and those sessions keep prefix semantics with their unattested tail reported. That is also why finality is an explicit claim by the writer rather than something the reader infers from a trailing session.end entry — session.end lives in the log, and the log’s completeness is the very thing in question.',
    invariant:
      'Only the manifest (classic or rolling), its signature, matched .slog/.slog.meta pairs, and manifest-named submission files may appear in a bundle. Any other entry aborts the load.',
    links: [
      { label: 'unzip.ts', href: `${GH}/packages/analysis-core/src/loader/unzip.ts` },
      { label: 'parse-bundle.ts', href: `${GH}/packages/analysis-core/src/loader/parse-bundle.ts` },
    ],
  },
  index: {
    title: 'EventIndex',
    body: 'Every session’s events are flattened into one array and sorted by wall clock, then by session id, then by seq, two deterministic tie-breaks under a primary key that routinely ties, because a burst of editor events can share a millisecond. Each event’s position in that array becomes its globalIdx, so ordered[i].globalIdx === i, and everything downstream addresses events by that integer. The tie-breaks are therefore load-bearing: identical bytes must produce identical indices, or no replay link, snapshot test or exported flag is reproducible.\n\nTwo normalisations happen here rather than in each consumer. Paths recorded from a parent workspace root are folded onto the manifest’s spelling, but only when the alias and the canonical name appear in disjoint session sets: one workspace root yields one relative path per file, so any overlap means two genuinely different files that merely share a basename, and the merge is refused. And every fs.external_change that is really the recorder reporting the editor’s own save is identified once, into a single set, so reconstruction and all eighteen heuristics agree on which external changes actually happened. Those events stay in ordered and byKind rather than being deleted, so the timeline can still show them as reclassified.',
    invariant:
      'The self-inflicted external-change set is computed once, here. Anything that reports on external changes must skip it: those events describe something that never happened.',
    links: [
      { label: 'build-index.ts', href: `${GH}/packages/analysis-core/src/index/build-index.ts` },
      { label: 'event-index.ts', href: `${GH}/packages/analysis-core/src/index/event-index.ts` },
    ],
  },
  recon: {
    title: 'File reconstruction',
    body: 'Replay walks one file’s events and carries two parallel structures: the content, and a per-character array recording which event’s globalIdx last wrote each character. Content is held as one cell per line, each cell keeping its own trailing newline, so an intra-line edit rewrites a single cell instead of rebuilding the whole string. Under a flat string, interior-edit replay was quadratic in file length. The flat provenance array is materialised only at the return boundary.\n\nThe interesting decisions are all about what to do when the recorder could not hand us the bytes. An external change that arrives with new_content is diffed line-wise against the prior replay state, so unchanged regions keep their original attribution and the gutter paints only the lines the external tool actually touched. An external change or a paste that exceeded the recorder’s inline cap keeps the last known content rather than clearing it (the empty string is never the true content), while a recorded delete does clear it, because the file genuinely is gone. Over-cap pastes are sometimes still recoverable: the sha256 in the payload may identify text a doc.open or doc.save already gave us.\n\nAll of that assumes there is one stream to replay. With two contributors editing one file on divergent branches there is not, and replaying the wall-ordered interleaving of two machines\u2019 clocks produces content that existed on neither. So reconstruction answers with three states rather than always returning a string: determinate (the happens-before relation orders the history into a chain \u2014 one possible content), concurrent (two contributors\u2019 lineages are live and unordered \u2014 every branch is returned, none is chosen, and they are never merged), and unknown (the relation does not cover these events at all). Concurrent and unknown are different facts and are never collapsed: two recorded branches that raced and no record at all lead a reader to opposite conclusions.\n\nThe unit is a segment \u2014 a run of one session\u2019s events on one path between two commit observations. That boundary is exactly the granularity at which the relation stops distinguishing events, so comparing one representative event per segment is sound rather than a sample, and the segment count tracks sessions and commits rather than keystrokes. A segment that re-seeds from disk (a doc.open with inline content, an fs.external_change with new_content) makes its own history irrelevant to its output bytes, which is what lets the first disk observation after a merge close a divergence and return the file to determinate. Concurrency therefore lasts from the branch point to that observation, not forever.\n\nA file whose events do not span two provably different contributors never takes this path: it short-circuits to the same reconstructFile call it always made, so every existing course is byte-for-byte unaffected by construction rather than by a second implementation kept in step. Provably different requires both enrolment chains to verify against the course-signed root, so a forged identity block cannot talk a file into refusing to answer.',
    invariant:
      'Never return a content string that no contributor ever had. Where the evidence does not establish one, say so \u2014 and say which kind of not-established it is.',
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
        label: 'reconstruct-file.ts',
        href: `${GH}/packages/analysis-core/src/index/reconstruct-file.ts`,
      },
    ],
  },

  // ── Collaboration spine ───────────────────────────────────────────────────
  contrib: {
    title: 'Contributor resolution',
    body: 'The question is "which contributor produced this session?", and nothing else. The answer is a three-armed union discriminated on kind — attributed, unattributed, unverifiable — and the entire value of this module is that those are three different facts rather than a boolean with a spare state.\n\nattributed means an identity block was present, the root-anchored trust material was available, the chain was walked, and it verified. unattributed means there is NO identity block on session.start at all: the student never enrolled, or their recorder had no keyring. That is an ordinary, blameless state, and no consumer may render it as suspicious — buildSessionIdentity returns skipped for every failure and the recorder records anyway, which is correct, because never blocking recording matters more than always knowing who. unverifiable means a block IS present and we could not stand behind it; that is an artifact making a claim it cannot back, and it is never merged into the contributor it names.\n\nCollapsing either pair is a wrongful-accusation bug in one direction or the other. Folding unverifiable into unattributed hides a forged claim. Folding unattributed into unverifiable manufactures a finding against a student whose only act was not enrolling.\n\n"We cannot check" and "we checked and it failed" are both unverifiable, because an unverified claim must not be honoured either way — but they must not read the same to a human. That split is isIdentityCheckFailure, a FUNCTION over the reason rather than a field on the verdict. It is true only for anchor_not_root_signed and chain_failed. It is false for no_root_key and no_trust_anchor. A UI that wants to say "this identity does not verify" must read that function and not kind === "unverifiable", because a deployment with no root public key produces no_root_key for every identified session, and rendering that as failure would present a deployment misconfiguration as a class-wide integrity finding.\n\nGrouping is on contributorKey, and for the attributed arm that key is built from student_ref — the only field here that is stable across machines, where a session pubkey is ephemeral and a derived student pubkey differs between the 2.0 and 2.1 schemes for the same human. The key is namespaced by identity version, scope and scope id and every component is percent-encoded, because a 2.0 ref is per-COURSE while a 2.1 ref is global, and a separator sitting inside an id must not be able to merge two people.\n\nUnattributed sessions are singleton pseudo-contributors, one per session. They are never pooled together — two unenrolled people are indistinguishable from one person recording twice, and asserting either way invents a relationship — and they are not asserted distinct either: compareContributors answers unknown for any pair involving one, which is the only honest answer. unverifiable is a singleton too, keyed on the session id and deliberately NOT on the claimed student_ref, because merging an unverified claim into the contributor it names is precisely how a forged identity block would launder work onto an innocent student.\n\nA bundle that was never stamped reads as fully unattributed, and that is the safe direction: unattributed is the state under which the contributor-gated behaviour keeps firing, because "these are two different people" is exactly what is unproven. Identity comes only from session.start.identity — never machine_id (which is session-salted anyway), never a git author, never the filename the submission was uploaded under.',
    invariant:
      'Three states, never two. And “cannot check” is not “checked and failed” — read isIdentityCheckFailure, never the bare kind.',
    links: [
      {
        label: 'resolve-contributors.ts',
        href: `${GH}/packages/analysis-core/src/identity/resolve-contributors.ts`,
      },
      { label: 'identity/types.ts', href: `${GH}/packages/analysis-core/src/identity/types.ts` },
    ],
  },
  dag: {
    title: 'The observed commit DAG',
    body: 'Commits the recorder actually witnessed, assembled from git.event observations into a graph that later ordering questions are answered against. A node is identified by (repository, sha) and never by sha alone, keyed as the two joined by a space — a character that cannot occur in a sha. Shas are opaque: no case folding, no abbreviation expansion, no length check.\n\nAbsent parents are null. They are never the empty array. Absent means "the recorder could not read this field"; empty means "this commit genuinely has no parents". Collapsing them turns every read failure into a false repository root, and the git-event conformance vector already pins the two as canonicalizing — and therefore hashing — differently. A garbled parents field becomes an unreadable_parents defect rather than silently becoming "no parents". The derived recordedRoot flag is honest about its own limits too: read it as root-or-truncated-lineage, because a shallow clone’s grafted boundary commit is indistinguishable from a real root.\n\nTwo signed chains claiming different parents for one sha is cryptographically impossible in real git — the sha is a hash over the commit object, parents included — so it is evidence of a rewrite or a forgery rather than a bug to paper over. Every claim is kept, no winner is picked, a conflicting_parents defect is raised, and NO edge is asserted in either direction. An in-edge we cannot stand behind becomes an ordering we cannot stand behind, and a wrong ordering is a wrong accusation. Claim comparison is order-sensitive on purpose: parents are never sorted, because the first parent is the branch a merge was made INTO, so the same shas in a different order are a genuinely different claim.\n\ncompareCommits is five-valued and only three of those values are orderings. before, after and unordered are statements about two commits the graph knows. same is the same commit. unknown means at least one sha is not in this DAG at all — nobody recorded it and nobody witnessed it, so there is no basis for any statement, and that is emphatically NOT unordered. A caller must handle all five; code shaped as an if/else on before silently lumps the other four together. Even a forged cycle producing mutual reachability answers unordered, because a contradiction is not a licence to pick a side.\n\nThe single-repository assumption is explicit rather than implied. Every node, edge and traversal is already keyed on (repository, sha), but every repository key today is the sentinel ASSUMED_SINGLE_REPOSITORY — deliberately not a plausible sha, so a value that leaks into a log reads as an assumption rather than as data. readRepositoryDiscriminator returns null unconditionally, because the field does not exist in the signed format yet, and it deliberately does not guess: deriving a discriminator from a branch name or from the shape of the graph would invent the very correlation the format decision exists to make trustworthy. The chosen value is the repository’s root-commit sha, which both partners derive identically and offline, and which differs for a submodule. Until it lands, a scope that really observed two repositories merges two unrelated sha spaces, and observed-dag.test.ts keeps a test named KNOWN LIMITATION that asserts the unsound answer out loud so it will fail the day the discriminator arrives.\n\nThere is no git author field here and there must never be one. Attribution runs observation → sessionId → contributorOf → student_ref. The wall clock is carried for display and skew measurement only; nothing in this module orders, sorts or compares by it, which is what makes the build deterministic enough for the ingest-retry contract.',
    invariant:
      'Unrecorded is not empty, and disagreement is not a majority vote. Where two claims conflict, assert no edge at all.',
    links: [
      { label: 'observed-dag.ts', href: `${GH}/packages/analysis-core/src/git/observed-dag.ts` },
      {
        label: 'observed-dag.test.ts',
        href: `${GH}/packages/analysis-core/src/git/observed-dag.test.ts`,
      },
    ],
  },
  order: {
    title: 'The happens-before relation (≺)',
    body: 'A partial order over events, assembled as the transitive closure of three generators. L0 is the intra-session hash chain: seq order inside one session, total, and forging it needs the session’s private key. L1 is the intra-contributor session chain through prev_session_id, ownership-gated — a back-pointer into a session belonging to a PROVABLY DIFFERENT contributor is refused and recorded as a defect, because honouring it would let one contributor’s chain hang off another’s, which is exactly how work gets laundered onto a student who did not do it. Sessions whose contributors are merely unknown still link, since refusing there would discard real ordering for every pre-identity bundle. L2 is the observed commit DAG, the only trustworthy cross-contributor relation.\n\nThere is no L3. The wall clock generates nothing: it is not read, not compared and not sorted on anywhere in this module. Two machines’ clocks are worth nothing relative to each other, so a skew of any size cannot change a single answer, and the tests put one machine a year behind the other to prove it — with a wall field deliberately present on the fixtures, because mutation testing found that a fixture of bare refs could not have caught a regression that started keying on it.\n\ncompareEvents is five-valued: before, after, concurrent, same, unknown. concurrent means the evidence orders neither way — genuinely divergent branches, or history nobody recorded, and the evidence cannot tell those two apart, so neither may the caller. unknown means an event is not in this scope at all, which is a different statement and must not be collapsed into concurrent. It returns a STRING rather than a number, and that is a structural defence rather than a style choice: it is physically unusable as an Array.prototype.sort comparator, so misuse is a type error instead of a subtly wrong ordering.\n\nglobalIdx is deliberately NOT re-keyed, and this is the single most dangerous change anyone could make to the codebase. flags.supporting_seqs and cross_flag_participants.supporting_seqs are stored in Postgres as int[] of globalIdx values. Re-keying would silently repoint every stored finding’s evidence at different events, so a grader opening a months-old integrity finding against a named student would be shown the wrong events with no error raised anywhere — fabricated evidence against a real person, produced at rest, by a change that looked like a refactor. For the same reason there is no parallel integer field either: an orderIdx sitting beside globalIdx would be two interchangeable-looking numbers on one object, one of which is persisted, and the way not to fire that foot-gun is not to build it. buildIndex is untouched and nothing stored changes meaning.\n\nThe one function that does produce a list says so in its name. presentationSort returns events rather than indices, ranks by position in the graph, tiebreaks on (sessionId, seq) and never on the clock, and documents that its output is a total order and therefore says strictly more than the evidence does. Reading adjacency in that list as causality is precisely the mistake the five-valued API exists to prevent.\n\nBuilding the relation does not walk every pair. Events are bucketed against a small position graph — one node per commit observation, plus a virtual in-node and out-node per session, which is what lets a session with no git.event at all still take part in L1 — and a cross-session question becomes one bitset reachability lookup between an event’s entry door and another’s exit door. Note that buildEventOrdering is NOT called by buildIndex: nothing in the current pipeline consumes ≺ yet, and making every index build pay for a graph nobody reads would be a regression on an ingest path that is already CPU-bound.',
    invariant:
      'Partial means partial. Never linearize concurrent away, never collapse it into unknown, and never re-key globalIdx — it is persisted evidence.',
    links: [
      {
        label: 'happens-before.ts',
        href: `${GH}/packages/analysis-core/src/order/happens-before.ts`,
      },
      { label: 'schema.ts (supporting_seqs)', href: `${GH}/packages/server/src/db/schema.ts` },
    ],
  },

  // ── Validation ────────────────────────────────────────────────────────────
  v1: {
    title: 'verify-chain · check 3',
    body: 'Each entry is rehashed as sha256 over its own recorded prev_hash concatenated with the JCS-canonical form of itself minus its hash fields, and compared against the hash it carries. Verifying against the entry’s own prev_hash rather than a running chain value is what stops one altered entry from cascade-reporting every entry after it: the report names the exact seq that was tampered with, not the whole tail of the session.\n\nThat choice has a consequence worth knowing. Deleting an entry outright leaves every surviving entry self-consistent (none of their hash fields changed), so this check passes on a log with a hole in it. What catches a deletion is check 4’s seq walk. The two are complementary rather than redundant: this one detects modified entries, that one detects missing ones.',
    invariant:
      'An entry is broken iff it fails to verify against its OWN prev_hash. Chain failures are never cascaded forward.',
    links: [
      {
        label: 'verify-chain.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-chain.ts`,
      },
    ],
  },
  v2: {
    title: 'verify-manifest-sig · check 1',
    body: 'The bundle manifest is canonicalized and checked as an ed25519 signature against the session_pubkey carried in each session.start, most-recently-started session first with a fallback to the rest. The fallback exists because the seal is signed by whichever session was live when the student ran it, and a bundle can hold several. Trying only the newest would fail a perfectly legitimate bundle sealed from an earlier window.\n\nA rolling-sealed bundle inverts that. There is no single bundle-wide signature: each manifest-<session_id>.json is signed by THAT session’s own ephemeral key, so each one is verified against exactly one public key — the one in its own session.start — with no fallback to any other session. The absence of the fallback is the point. A shared repo holds a partner’s sessions carrying a partner’s keys, so no key can vouch for another session; and falling back would let a manifest copied sideways under another session’s filename verify and pass, defeating the filename-to-session_id binding the loader enforces. A bundle carrying both shapes must satisfy the classic signature AND every per-session one; neither excuses the other.\n\nThis is check 1 for a reason: the rest of the report leans on it. Check 8 compares submitted bytes against the sha256 recorded in this manifest, and the Source tab’s per-file verdicts read the same field. Both are only meaningful because this signature verified first, which is also why source stripping must never touch manifest.json or manifest.sig: a stored bundle that cannot re-verify here loses the ground under everything else.',
    links: [
      {
        label: 'verify-manifest-sig.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-manifest-sig.ts`,
      },
    ],
  },
  v3: {
    title: 'verify-session-binding · check 2',
    body: 'Each session.start copies the signature of the assignment manifest the session was started against. This check asserts only that every session in the bundle carries the same one; it cannot check the value against anything, because the bundle manifest does not carry the assignment manifest’s signature. So this is session-to-session equality, not verification against the course key.\n\nWhat it catches is a bundle assembled from sessions recorded against different assignments. A single-session bundle passes trivially, and that is honest rather than lax: there is nothing to disagree with. Verification that the manifest was course-signed at all happened on the student’s machine at activation; by the time a bundle reaches the analyzer, that decision survives only as this shared field.',
    links: [
      {
        label: 'verify-session-binding.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-session-binding.ts`,
      },
    ],
  },
  v4: {
    title: 'verify-seq · check 4',
    body: 'Each entry’s seq must equal its zero-based position in the file. A contiguous run of misaligned entries is reported once, at its first entry (a jump from 5 to 10 is one gap, not four), and the walk then continues against array position rather than staying anchored on the gap point, so one deletion does not make the remainder of the session look corrupt.\n\nThis is the check that catches a deleted log entry, because check 3 by construction cannot. It is also the one failing check that produces no flag: the integrity adapter has no entry for it, so a seq gap fails the bundle’s overall verdict while contributing nothing to the ranked queue. It surfaces in the validation tab and in the overall status, and a reviewer looking only at flags will not see it.',
    links: [
      { label: 'verify-seq.ts', href: `${GH}/packages/analysis-core/src/validation/verify-seq.ts` },
      {
        label: 'integrity-flags.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/integrity-flags.ts`,
      },
    ],
  },
  v5: {
    title: 'verify-monotonic-t · check 5',
    body: 't is milliseconds since session start, taken from a monotonic clock, so within one session it can only move forward. A regression means the field was written by something other than the recorder’s own monotonic source.\n\nThat is why t and wall are two checks rather than one timestamp check. A monotonic clock is immune to the system clock being adjusted, so a t regression has no benign explanation and gets no excuse mechanism, unlike check 6, which forgives a wall-clock regression the recorder itself noticed and recorded. Both produce medium-severity flags rather than high: the finding is that timestamps disagree, which is a strong hint about the log, not proof about the content.',
    links: [
      {
        label: 'verify-monotonic-t.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-monotonic-t.ts`,
      },
    ],
  },
  v6: {
    title: 'verify-monotonic-wall · check 6',
    body: 'wall is the system clock, which a student may legitimately change and which NTP may legitimately step backwards. A regression is reported only when no clock.skew event appears in the inclusive seq window spanning the two entries: the recorder noticing and recording its own clock jump is a different thing from a log with rewritten timestamps.\n\nThe excuse is scoped to that window rather than to the whole session on purpose. One recorded skew must not license every regression that follows it for the rest of the day. The skew seqs are collected once per session up front, so the whole check stays linear in event count even though it asks a range question per comparison.',
    links: [
      {
        label: 'verify-monotonic-wall.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-monotonic-wall.ts`,
      },
    ],
  },
  v7: {
    title: 'verify-doc-save-hashes · check 7',
    body: 'This check replays each file from its doc.open content, applies doc.change deltas and inline pastes, and compares the sha256 it computes at each doc.save against the sha256 the recorder recorded there. Its real output is a three-way distinction: matched, mismatched, or not reconstructable at all.\n\nThe third category is why it feeds no flag. A paste over the inline cap, a file opened without content, or any preceding external change makes the running reconstruction indeterminate, and an indeterminate save is indistinguishable from an honest one, so those are reported as a pass carrying an explanatory note. But "no flag" does not mean the failure is ignored: a genuine hash mismatch still fails the check, and a failed check still fails the bundle overall. It has no entry in the integrity adapter, so it never becomes a ranked finding.',
    links: [
      {
        label: 'verify-doc-save-hashes.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-doc-save-hashes.ts`,
      },
    ],
  },
  v8: {
    title: 'verify-submitted-code · check 8',
    body: 'For each file the manifest names, the manifest’s sha256 is compared against the last on-disk hash the recorder observed for it: the most recent doc.save, doc.open, or fs.external_change new_hash anywhere in the bundle, with workspace-root path aliases resolved first so the comparison is not made against a stale save recorded under a different spelling of the same file. No reconstruction is involved; this is hash against hash.\n\nIt survives source stripping because of one narrow gate. The tamper sub-check (submitted bytes that disagree with their own manifest entry) fires only when bytes are actually present. A stored provenance-only bundle has none, so it falls through to the hash comparison, which needs only the signed manifest and the recorded event hashes, both of which are kept. Before that gate existed, "bytes absent" and "bytes wrong" were the same condition, and re-running this check reported every stored bundle as tampered.\n\n"Last observed" is an ordering claim, and it used to be a wall-clock one: sessions are sorted by their first event\u2019s wall time and the scan is last-write-wins over that order. With two partners on divergent branches, whose hash lands last is decided by whose laptop clock ran ahead, and the loser\u2019s perfectly ordinary submission is reported at high severity as having been changed outside the recording. So when a path\u2019s observations span two provably different contributors, the candidates become the happens-before-maximal recorded states: matching any one of them passes, and matching none of them is unknown rather than mismatch. That second half is the conservative half \u2014 with concurrent branches there is no established final state to have departed from, and the submitted bytes are plausibly a merge result no session ever saw on disk, which is normal group work. A path that does not span two different contributors, and any bundle whose contributors were never resolved, take the unchanged wall-ordered comparison, so a real mismatch is still reported for every solo submission; so does a contributor pair the DAG genuinely orders.',
    invariant:
      'Assert tampering only when bytes are present and disagree with the manifest. Absent bytes are not evidence of anything \u2014 and neither is a clock.',
    links: [
      {
        label: 'verify-submitted-code.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-submitted-code.ts`,
      },
    ],
  },
  report: {
    title: 'Validation report',
    body: 'The roll-up is deliberately asymmetric. Any failing check fails the bundle; with no failures, a single skipped check downgrades the result to warn rather than pass. A check that could not run is not evidence of correctness: a 1.0 bundle carries no submission_files, so check 8 skips, and such a bundle must not be able to present itself as fully verified.\n\nThe report is computed once, at ingest, and stored; read paths serve the stored row. The one exception is a per-submission recompute, which re-runs validation rather than reading it back. The report feeds the integrity adapter, so reusing a stored row meant a recompute could never correct a wrong verdict: a stale check-8 failure would keep re-emitting a high-severity flag on every recompute, forever.',
    links: [
      {
        label: 'run-validation.ts',
        href: `${GH}/packages/analysis-core/src/validation/run-validation.ts`,
      },
      {
        label: 'recompute-submission.ts',
        href: `${GH}/packages/server/src/services/scoring/recompute-submission.ts`,
      },
    ],
  },
  integ: {
    title: 'Integrity-flags adapter',
    body: 'Nine entries in this table. Six are checks from the eight: manifest signature, session binding, chain integrity, monotonic t, monotonic wall, submitted code. The other three — log_bytes_match, checkpoint_chain_valid and manifest_downgrade — are bundle-level detections that are deliberately not among the eight, because the eight are a frozen persisted contract with one check_N_status column each; they arrive on the report’s bundleDetections array rather than in checks, and the adapter reads both arrays through the same mapping. A failure becomes a Flag with confidence 1.0, because the underlying verdict is cryptographic rather than statistical: there is no sense in which a hash chain is eighty percent intact. Severity splits on what the failure proves: signature, binding, chain and submitted-code mismatches are high, the two timestamp regressions medium, and all three bundle-level detections high.\n\nThe adapter re-analyses nothing. It reads the report and reshapes it, so that the cohort ranking, the scoring formula and the export handle cryptographic and behavioural findings through exactly one path rather than two. The two checks with no entry here (seq gaps and doc.save hashes) still move the bundle’s overall verdict but never reach the ranked queue, which is a deliberate narrowing rather than an oversight.\n\nA confidence of 1.0 puts a hard obligation on log_bytes_match in particular, because it is the one detection whose subject can legitimately move after it was signed. Against a classic manifest.json it is whole-file equality and a post-seal append fails, which is correct: that seal is taken once over a finished log. Against a rolling seal it is read as the prefix commitment the recorder actually made, using the coverage the loader resolved — otherwise every honest git submission, every crash before shutdown and every partner’s repo cloned mid-session would be reported as tampering at high severity and full confidence. Inside the sealed region nothing is relaxed: an edit, a re-chained rewrite, a truncation below the sealed point or a deleted checkpoint all still fail. Outside it nothing can be claimed, so the passing verdict states how many bytes and checkpoints were written after the last seal rather than letting a pass read as end-to-end signed.\n\nThe exception is a seal the recorder marked final at shutdown, over a log that is flushed, closed and provably finished. That claim is inside the signature, so it is unforgeable, and it buys back whole-file semantics: an append after the session ended fails here at high severity and full confidence, with wording that says the finished log was modified rather than that a prefix was contradicted. The residual is a downgrade — a student restoring an earlier, genuinely-signed non-final seal of their own in place of the final one — and it is deliberately not a finding, because both seals are true statements by the same key and the result is byte-for-byte identical to an honest mid-session archive. It is made visible instead: the passing verdict names the unattested tail and says outright that no final seal is present, so sealed is never read as sealed in full.',
    links: [
      {
        label: 'integrity-flags.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/integrity-flags.ts`,
      },
    ],
  },

  // ── Heuristic registry ────────────────────────────────────────────────────
  cand: {
    title: 'candidate-pastes',
    body: 'Recorder v1.2 stopped routing every bulk insertion through the paste event. Multi-delta WorkspaceEdits and large replacement edits (the shape an AI assistant’s "Apply" produces) are recorded as doc.change carrying source: paste_likely, because the doc.change replay path can reproduce a multi-delta, non-empty-range edit faithfully and the paste path cannot. Reconstruction fidelity won that trade; the cost was that every heuristic iterating kind === "paste" stopped seeing those edits at all.\n\nThis iterator is the repair. It yields one candidate per paste event and one per delta of a paste-shaped doc.change, so large_paste, paste_is_solution and paste_matches_known_source see both shapes through one code path. Each candidate carries an ordinal (its position in iteration order) because the seq key cannot serve as identity: a multi-delta doc.change produces several candidates that all share one seq key. The ordinal is what joins a candidate to its internal-move verdict.',
    links: [
      {
        label: 'candidate-pastes.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/candidate-pastes.ts`,
      },
    ],
  },
  hp: {
    title: 'Process-shape heuristics',
    body: 'These ten ask what the shape of the work was: how large the insertions were, whether an insertion is the answer, whether files changed outside the editor, whether the volume of output is proportionate to the typing, whether a file appeared too fast or only after a long absence, whether the student ever saw a command fail. Each is a pure synchronous function of the index, the bundle and the config, which is what lets ingest claim that a retry produces identical flags.\n\nThe group’s recurring difficulty is that its evidence is often reconstructed rather than recorded, and the confidences admit it. mass_external_replacement has no post-change content in the payload at all and uses the next save as a proxy, so it caps at 0.75. low_typing_high_output counts the net delta from the file’s opening content rather than its final size, because a student who opens a 500-character skeleton and adds 50 has produced 50 characters, not 550. inter_session_external_change exists because the recorder emits nothing while it is not running: the only witness to a file edited between two sessions is the next session’s doc.open content, compared against the reconstruction at the end of the previous one. That comparison is now gated on who recorded the two sessions. Across a shared repository the next session is a different person on a different machine with a different working tree, so a difference is guaranteed by construction and says nothing at all about misconduct — every partner commit landing between two sessions produced a finding. A pair is skipped only when both sides resolve to verified and distinct contributors; where the identity is unproven the comparison runs exactly as it did before, because two different people is precisely what an unattributed session leaves unestablished.\n\nOne of the ten answers to the capture policy. no_intermediate_errors reasons about terminal commands, so with terminal capture switched off it stands down entirely: "the student never saw a command fail" would be an artefact of the course’s configuration rather than a statement about how they worked. The rest read floor-only signals and are unaffected by design — low_typing_high_output leans on doc.open, and doc.open is on the floor precisely because so much depends on it.',
    links: [
      {
        label: 'run-heuristics.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/run-heuristics.ts`,
      },
      {
        label: 'inter-session-external-change.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/inter-session-external-change.ts`,
      },
    ],
  },
  he: {
    title: 'Environment heuristics',
    body: 'Three of these four are info severity, and that is a claim about meaning rather than about certainty. An AI extension being installed is not misconduct. Shell integration being off is not misconduct either: it is a note that the recorder could not observe terminal exit codes, which is precisely what no_intermediate_errors depends on, so the flag exists to tell a reviewer why another signal is weak. The one that escalates to medium is extension_set_changed_mid_assignment: an AI tool absent from the session-start snapshot and then activated mid-session is a deliberate act in a way a pre-installed one is not.\n\nai_extension_active moves confidence rather than severity (0.9 for an id on the course list or in the built-in curated set, 0.6 for an id that merely matches an AI naming token), so a guess contributes proportionally less to the score without being hidden. terminal_active_during_external_change is the group’s known noise source: the recorder emits no terminal.close, so once a terminal has been opened, every subsequent external change in that session trips it.\n\nTwo of the four are gated on the capture policy, and both for the same reason. shell_integration_disabled and terminal_active_during_external_change are only observable through terminal events, so under a course that switched terminal capture off their silence would read as "shell integration was fine" and "no terminal was open when the file changed" — statements the bundle carries no evidence for either way. Both return not-applicable rather than a reassuring absence.',
    links: [
      {
        label: 'ai-extension-active.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/ai-extension-active.ts`,
      },
      {
        label: 'terminal-active-during-external-change.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/terminal-active-during-external-change.ts`,
      },
    ],
  },
  hi: {
    title: 'Integrity heuristics',
    body: 'These four are behavioural inferences about the log’s structure, which is what separates them from the validation checks upstream: a broken chain is proof, an overlapping session pair is an argument. They sit beside the cryptographic findings in the UI because a reviewer wants one list, but their confidences are 0.8, 0.75, 0.95 and 0.9 rather than 1.0.\n\nTwo of them encode a hard-won negative result. gap_in_heartbeats fires only when at least one other event was recorded strictly inside the gap: an empty gap is a suspended machine, not a paused recorder, and before that rule the flag fired hundreds of times per bundle on ordinary laptop sleep. multiple_sessions_overlap bounds a session that has no session.end at its last recorded event instead of leaving it open, because treating the ordinary crash signature as "still running" made one power cut overlap every session for the rest of the assignment.\n\nThat flag carries the sharpest correction in the group. Its text told the reader an overlap was impossible on a single machine without clock manipulation or log forging, which stopped being true the moment two partners shared a repository: each runs their own recorder, they work at the same time, and the overlap is the assignment being done as assigned. It is now keyed on contributor. Two verified, distinct people overlapping produces nothing; one verified person’s own two sessions overlapping is the original signal and keeps high severity at 0.95; an overlap where either side is unattributed or unverifiable still fires, because two people is exactly what is unproven there. The comparison is three-valued for that reason and never a string compare on the contributor key — every unattributed session carries its own singleton key, so comparing keys would read unproven as different people and delete the finding through the back door. A bundle nobody has stamped with contributor verdicts reads as unattributed throughout and behaves exactly as it did before, so no cohort loses findings by not being enrolled. extension_hash_mismatch stays medium for a similar reason: an unrecognised build hash is as likely to mean staff have not published the new release yet as it is to mean a modified recorder.\n\ngap_in_heartbeats also has to answer to the capture policy, and it is the one case where the answer is a scaled threshold rather than a stand-down. Heartbeats are on the floor, but their cadence is tunable, so a course that lengthens the interval would otherwise trip a threshold calibrated for the default. The applied threshold is therefore whichever is larger of the configured floor and ten times the recorded cadence — max rather than replace, so a course that shortens the interval does not get a proportionally tiny threshold and a flood of flags. At the default cadence the arithmetic reproduces the shipped value exactly, so a 1.x bundle is unchanged to the byte.',
    links: [
      {
        label: 'gap-in-heartbeats.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/gap-in-heartbeats.ts`,
      },
      {
        label: 'multiple-sessions-overlap.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/multiple-sessions-overlap.ts`,
      },
    ],
  },

  // ── Internal-move classification ──────────────────────────────────────────
  imove: {
    title: 'Internal-move check',
    body: 'The question is asked only of large_paste and paste_is_solution candidates, and it has two halves. The first is a near-exact line match: at least 95% of the paste’s non-blank lines, indentation stripped, against a contiguous run in some file’s content at the instant just before the paste, or against a deletion ledger built during the same replay pass, so a cut here and a paste there resolves without a second replay. Stripping indentation lets a block survive being moved into a nested scope; the matching itself is deliberately not fuzzy, because "vaguely similar to something I once wrote" is satisfiable by a great deal of code, and this predicate decides whether a flag survives.\n\nThe second half is the provenance requirement, and it is what stops this being a laundering path. At least 90% of the matched source region’s characters must be attributable to typing, or to starter code the file already carried. Without it, a student could paste an external solution into scratch.py, cut it, paste it into hw3.py, and have the second paste look internal. Everything else is fail-closed. A paste with no inline content, a candidate under the size gate, or a match whose source region is not predominantly the student’s own all leave the candidate unclassified.',
    invariant:
      'A move qualifies only when the matched source region’s own provenance is typed or preexisting. Code that arrived by paste or external change can never be laundered by relocating it.',
    links: [
      {
        label: 'internal-move.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/internal-move.ts`,
      },
      {
        label: 'reconstruct-file-provenance.ts',
        href: `${GH}/packages/analysis-core/src/index/reconstruct-file-provenance.ts`,
      },
    ],
  },
  down: {
    title: 'Downgraded to info',
    body: 'What moves is severity, not confidence, and the two axes answer different questions. Confidence is how sure we are the signal is real, and nothing about the classification makes the paste detection less reliable, so the flag keeps the 0.8 or 0.85 it would otherwise have had. Severity is how serious the finding is, and that is what the verdict revises: relocating your own typed code is not a serious finding, so it drops to info, which is worth zero under the default severity weights and therefore leaves the ranked queue altogether.\n\nThe heuristic id deliberately stays large_paste or paste_is_solution rather than becoming an internal_move type of its own. Per-flag weights, severity roll-ups and every count that keys on heuristic id keep working unchanged, and a course that disagrees with the classification re-weights the same slider it always used. The flag also carries a detail block naming the source path and the globalIdx of the match, so a reviewer can jump to where the code came from and judge it themselves.',
    invariant:
      'Findings are de-weighted, never suppressed. The record, its supporting event and its jump-to-source link all survive the downgrade.',
    links: [
      {
        label: 'large-paste.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/large-paste.ts`,
      },
      {
        label: 'paste-is-solution.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/paste-is-solution.ts`,
      },
    ],
  },
  keep: {
    title: 'Full severity',
    body: 'Full severity is the default rather than a decision. The classifier returns a sparse map keyed by candidate ordinal, and a candidate absent from that map is treated as an external paste, so every way the classification can fail, including the cases it never considered, lands here rather than in a downgrade. Setting internalMove.enabled to false skips the classifier entirely and restores, byte for byte, the behaviour that predated it.',
    invariant:
      'Absence from the classification map means full severity. Every uncertainty resolves toward keeping the flag.',
    links: [
      {
        label: 'internal-move.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/internal-move.ts`,
      },
    ],
  },

  // ── Ranking ───────────────────────────────────────────────────────────────
  sort: {
    title: 'Sort',
    body: 'Severity and then confidence are the two keys that carry judgement. The keys after them carry none: the first supporting seq key, then the flag id. They exist so that two runs over the same bundle emit flags in the same order, which is what makes a snapshot test meaningful, and what lets the ingest pipeline assert that a retry produces identical output rather than merely equivalent output.\n\nThe third key is the string "sessionId:seq" compared lexicographically, so it is a tie-break and not a chronology: seq 10 sorts before seq 9. Nothing depends on it being time-ordered; it only has to be total and stable. Cross-submission flags use the same four-key shape, with the first bundle id standing in for the first seq.',
    links: [
      {
        label: 'run-heuristics.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/run-heuristics.ts`,
      },
      {
        label: 'run-cross-heuristics.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/cross/run-cross-heuristics.ts`,
      },
    ],
  },
  out: {
    title: 'Ranked flag list',
    body: 'This is the per-submission product: every heuristic’s flags plus the integrity adapter’s, in one order. It is a sort order for staff attention and nothing more: no threshold anywhere in the system turns a score into a verdict, and the queue decides what a human looks at first, not what the answer is.\n\nDespite the arrow leaving it, this list is not the input to cross-submission analysis. Those heuristics read a separate, compact extraction per submission (paste records plus a bounded n-gram fingerprint) and never see a flag. Holding whole bundles for a semester at once exhausts the worker’s memory, so the cross path is built to fingerprint each submission and discard its event stream immediately.',
    links: [
      {
        label: 'run-heuristics.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/run-heuristics.ts`,
      },
      {
        label: 'cross/features.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/cross/features.ts`,
      },
    ],
  },

  // ── Cross-submission ──────────────────────────────────────────────────────
  c1: {
    title: 'paste_shared_across_students',
    body: 'Pastes of at least 100 characters from every loaded submission are grouped by content identity. A paste joins a group on either an exact sha256 match against the group, or a line-overlap ratio of at least 0.9 against a group member that has inline content. One group covers both mechanisms on purpose: splitting exact and fuzzy into separate flag types fragments what is really one finding and forces the UI to de-duplicate it again. Every group spanning two or more bundles emits one high-severity flag; the match mechanism moves confidence (0.95 for a group joined only by hashes, 0.8 once any fuzzy match contributed) not severity.\n\nGrouping is a linear scan in which a paste joins the first group it matches, not a true transitive closure. Order therefore matters at the margins, though the input order is deterministic. The alternative is a full similarity graph over every paste in a semester, which is quadratic in the one place that already dominates the cost of a cross run.',
    links: [
      {
        label: 'paste-shared-across-students.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/cross/paste-shared-across-students.ts`,
      },
      {
        label: 'cross/types.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/cross/types.ts`,
      },
    ],
  },
  c2: {
    title: 'editing_pattern_clone',
    body: 'Each submission is reduced to the set of 3-grams of its event-kind stream, and every pair is scored by Jaccard similarity; at or above 0.3 the pair emits a medium flag at confidence 0.7. A set rather than a multiset is the load-bearing choice: counting occurrences would let a submission with ten thousand doc.change events dominate every comparison, whereas the set of distinct 3-grams a session produces is bounded by the event-kind alphabet no matter how long the session ran.\n\nThat dependence on the alphabet is exactly what the capture policy disturbs. Every gated signal removes a kind from the stream, so a submission recorded with terminal or selection capture off produces a fingerprint drawn from a smaller alphabet than one recorded with everything on, and the two similarity scores are not comparable. Renormalising the threshold per alphabet would be a tuning decision rather than a coding one, so the heuristic takes the conservative reading the absence-versus-disabled rule prescribes and skips any pair where either side had a kind-stream signal disabled. The list of which signals count is written out explicitly rather than collapsed to "anything disabled", because what matters is the reason — a future knob that only thinned a payload would not belong in it.\n\nThe fingerprint holds no content, no file names and no timings, only the sequence of event kinds. It can therefore say that two students worked in a similar rhythm and can say nothing whatever about what either of them wrote, which is both its privacy property and the reason it caps at medium. Structurally similar workflows are ordinary; the signal is suggestive and never conclusive.',
    links: [
      {
        label: 'editing-pattern-clone.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/cross/editing-pattern-clone.ts`,
      },
      {
        label: 'cross/features.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/cross/features.ts`,
      },
    ],
  },
  cx: {
    title: 'Cross flags and participants',
    body: 'A cross flag names bundles rather than events inside one submission, which is why it is a separate type with its own storage: one row for the finding, one participant row per submission involved. A per-submission flag can hang off a submission id; a finding about a group cannot, and flattening it into per-submission copies would show a reviewer the same finding several times with no way to tell they were one thing.\n\nOn the server the whole semester’s set is deleted and re-inserted on every run, inside one transaction under an advisory lock. Merging is not available: a cross flag’s identity is not stable across runs (adding one submission changes the bundle ids in a group and therefore the flag id) and a fresh run can legitimately produce fewer flags than the last one, which a merge would leave behind as stale rows describing a group that no longer exists.',
    links: [
      {
        label: 'run-cross-heuristics.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/cross/run-cross-heuristics.ts`,
      },
      {
        label: 'run-cross.ts (server)',
        href: `${GH}/packages/server/src/services/heuristics/run-cross.ts`,
      },
    ],
  },

  pol: {
    title: 'The recorded capture policy',
    body: 'Read back out of the manifest embedded in each session’s session.start, never out of a server-side setting, because the question a heuristic is asking is what the recorder was told at the time — not what the course has configured since. Sessions are resolved individually and folded into one effective policy for the bundle, with a signal counted as disabled if any session had it off; a 1.x bundle, or a 2.0 one whose course specified nothing, resolves to everything on.\n\nThe rule it enforces is the absence-versus-disabled rule, and it is the reason this exists at all. Without it the engine cannot tell "this student produced no terminal events" from "this course does not record terminal events", and a heuristic reading the second as the first manufactures accusations against every student in that course — in a system whose output is used in academic-integrity proceedings. So any heuristic consuming a gated signal returns not-applicable rather than a flag or a zero. The audit that pins this is a paired test: the same event stream is built twice, once under a 1.x manifest and once under a 2.0 manifest with the signal switched off, and the first must flag while the second must return nothing. The 1.x half is as load-bearing as the 2.0 half — it is the regression test that archived submissions still behave exactly as they did.\n\nA policy is only honoured once its signature has actually been checked. The block sits inside the course-signed payload so that a professor can turn capture down and a student cannot turn it off, but session.start arrives from a file the student can edit, so reading the policy without first walking the trust chain would hand them the off-switch anyway. The verdict is therefore established once — by validation check 2 on the ingest and /local paths, and by loadSubmissionIndex for the server reads that never re-validate — and stamped on the bundle, so this resolution consults a boolean instead of doing async crypto inside a synchronous heuristic. Anything short of verified, including a deployment that never configured a root key, resolves to everything captured; what the unverified manifest asked for is still reported, as a refusal, rather than dropped. The direction is deliberate: when in doubt, heuristics fire and staff review, never silently fewer flags. The sharpest case is not the self-inflicted one — editing_pattern_clone declines a comparison when either side had a kind-stream signal disabled, so an honoured-without-checking policy would let one student absorb a session_binding_invalid flag and in exchange shield their collusion partner, against whom nothing at all would be recorded.',
    invariant:
      'A heuristic that consumes a disabled signal returns not-applicable. Never a flag, and never a zero. And a signal counts as disabled only on a bundle whose trust chain verified.',
    links: [
      {
        label: 'bundle-manifest.ts',
        href: `${GH}/packages/analysis-core/src/manifest/bundle-manifest.ts`,
      },
      {
        label: 'policy-gating.test.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/policy-gating.test.ts`,
      },
    ],
  },

  // ── Config ────────────────────────────────────────────────────────────────
  cfg: {
    title: 'HeuristicConfig',
    body: 'The config is fourteen named sections, one per heuristic that has anything to tune, and the merge is shallow per section: overriding largePaste.minChars keeps the other three largePaste defaults, and nothing outside that section is touched. The shipped numbers live here: 200 characters or 10 lines for a paste to register and 500 or 30 for it to escalate, 0.8 line overlap for a paste to count as the solution, 30 seconds and 500 characters for the first-save anomaly, a 10-minute idle gap, and 5 minutes for both the clock jump and the heartbeat gap.\n\nThis is not the same object as the per-semester config course staff edit. That one carries an enabled flag, a weight and an opaque thresholds blob per finding id, and only the thresholds blob reaches here, translated through a fixed id-to-section map that covers twelve of the fourteen sections. The internal-move classifier’s thresholds and the inter-session external-change threshold are not in that map, so they always run at their shipped values; changing them is a code change, which for the classifier that decides whether a flag survives is arguably where it belongs.',
    invariant:
      'The same index and the same config produce the same flags. No heuristic reads a clock, a random source, or anything outside (index, bundle, config).',
    links: [
      { label: 'config.ts', href: `${GH}/packages/analysis-core/src/heuristics/config.ts` },
      {
        label: 'recompute-submission.ts',
        href: `${GH}/packages/server/src/services/scoring/recompute-submission.ts`,
      },
    ],
  },
  rkpub: {
    title: 'Root public key',
    body: 'The one value every recorder compiles in, and the anchor the whole identity chain hangs from. It appears on this plate because analysis-core needs it to attribute a session, and it arrives as a PARAMETER rather than as a constant: this package is isomorphic, so it cannot read an environment variable or a build define of its own. The server passes it from PROVENANCE_ROOT_PUBLIC_KEY_HEX; the browser build passes VITE_ROOT_PUBLIC_KEY_HEX. An empty string counts as unset, which is pinned by test, because a half-configured deployment must not read as a configured one.\n\nUnset is a supported configuration, not an error. The bundle still loads, every heuristic still runs, and every check that does not need the key still reports. What changes is that no identity chain can be checked at all, so every session carrying an identity block resolves unverifiable with reason no_root_key — and that reason is explicitly "we could not check", never "we checked and it failed". BundleContributors carries rootKeyConfigured precisely so a reader is told which world they are in rather than being shown a page of apparent identity failures that are really one missing environment variable.\n\nSessions with no identity block are untouched by any of this: they stay unattributed, which is the blameless state. So an entirely unenrolled cohort on an unconfigured deployment produces zero attributed, zero unverifiable, and no findings of any kind — which is the correct answer, and is what the tests assert.',
    invariant:
      'A missing root key degrades attribution and never fabricates it. Unset means unknown, and unknown is never rendered as failure.',
    links: [
      { label: 'root-key.ts (server)', href: `${GH}/packages/server/src/config/root-key.ts` },
      {
        label: 'resolve-contributors.ts',
        href: `${GH}/packages/analysis-core/src/identity/resolve-contributors.ts`,
      },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [
  // The input artefact. How a bundle is built and what travels inside it belongs
  // to the recorder's seal step (master:bundle); how it is read belongs to
  // `unzip`, immediately downstream. A panel here would only sit between them.
  'zip',
];
