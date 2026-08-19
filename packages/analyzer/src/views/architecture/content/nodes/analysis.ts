import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `analysis` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Loader ────────────────────────────────────────────────────────────────
  unzip: {
    title: 'Unzip and parse',
    body: 'The archive layout is flat and closed: manifest.json, manifest.sig, one session-<uuid>.slog and one .slog.meta per session, and, for 1.1 bundles, exactly the paths the manifest’s submission_files names. Anything else aborts the load. That forces a two-pass read, because the whitelist cannot be known until manifest.json has been parsed, so unrecognised entries are deferred and resolved only once the manifest is in hand. A malformed manifest yields an empty whitelist, which turns every deferred entry into a rejection rather than quietly admitting it.\n\nThe structural failures are hard failures rather than warnings: a .slog with no .meta sidecar, a .meta with no .slog, zero sessions at all. Sessions are then parsed in parallel (each log is self-contained, so nothing about the order matters) and sorted oldest-first by the wall clock inside their own session.start. Filenames are random UUIDs and carry no ordering information, which is why the sort key has to come from the payload.\n\nThere are two seal shapes, not one. A git-submitted assignment never runs seal, so it carries no manifest.json at all — instead the recorder rewrites a ROLLING seal on every checkpoint: manifest-<session_id>.json plus manifest-<session_id>.sig, one pair per session, each covering only its own session. Per-session filenames are what make a shared repo’s .provenance/ add-only and therefore mergeable, exactly as session-<uuid>.slog already is. The loader recognises them through log-core’s parseRollingManifestFilename (which deliberately does not match manifest.json) and synthesizes an in-memory union manifest at format_version 1.2 spanning every per-session manifest found; that is why the shape validator accepts N sessions at 1.2 while each on-disk FILE must cover exactly one. A bundle with no rolling manifests never enters that path and is byte-for-byte what it was. A bundle carrying both keeps the classic manifest as its manifest and still verifies the rolling seals alongside it. Only a bundle with neither is the no_seal case.\n\nProblems with the rolling seals — an unsigned manifest, a stray .sig, a manifest copied sideways under another session’s filename, a seal naming a session with no .slog, a .slog no seal covers — do not abort the load. They are recorded as defects and reported by check 1, because rejecting the archive over one half-written seal would discard every other session’s findings, which is the wrong direction for an integrity tool.',
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
    body: 'Replay walks one file’s events and carries two parallel structures: the content, and a per-character array recording which event’s globalIdx last wrote each character. Content is held as one cell per line, each cell keeping its own trailing newline, so an intra-line edit rewrites a single cell instead of rebuilding the whole string. Under a flat string, interior-edit replay was quadratic in file length. The flat provenance array is materialised only at the return boundary.\n\nThe interesting decisions are all about what to do when the recorder could not hand us the bytes. An external change that arrives with new_content is diffed line-wise against the prior replay state, so unchanged regions keep their original attribution and the gutter paints only the lines the external tool actually touched. An external change or a paste that exceeded the recorder’s inline cap keeps the last known content rather than clearing it (the empty string is never the true content), while a recorded delete does clear it, because the file genuinely is gone. Over-cap pastes are sometimes still recoverable: the sha256 in the payload may identify text a doc.open or doc.save already gave us.',
    links: [
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
    body: 'For each file the manifest names, the manifest’s sha256 is compared against the last on-disk hash the recorder observed for it: the most recent doc.save, doc.open, or fs.external_change new_hash anywhere in the bundle, with workspace-root path aliases resolved first so the comparison is not made against a stale save recorded under a different spelling of the same file. No reconstruction is involved; this is hash against hash.\n\nIt survives source stripping because of one narrow gate. The tamper sub-check (submitted bytes that disagree with their own manifest entry) fires only when bytes are actually present. A stored provenance-only bundle has none, so it falls through to the hash comparison, which needs only the signed manifest and the recorded event hashes, both of which are kept. Before that gate existed, "bytes absent" and "bytes wrong" were the same condition, and re-running this check reported every stored bundle as tampered.',
    invariant:
      'Assert tampering only when bytes are present and disagree with the manifest. Absent bytes are not evidence of anything.',
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
    body: 'Six of the eight checks have an entry in this table: manifest signature, session binding, chain integrity, monotonic t, monotonic wall, submitted code. A failure becomes a Flag with confidence 1.0, because the underlying verdict is cryptographic rather than statistical: there is no sense in which a hash chain is eighty percent intact. Severity splits on what the failure proves: signature, binding, chain and submitted-code mismatches are high, the two timestamp regressions medium.\n\nThe adapter re-analyses nothing. It reads the report and reshapes it, so that the cohort ranking, the scoring formula and the export handle cryptographic and behavioural findings through exactly one path rather than two. The two checks with no entry here (seq gaps and doc.save hashes) still move the bundle’s overall verdict but never reach the ranked queue, which is a deliberate narrowing rather than an oversight.',
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
    body: 'These ten ask what the shape of the work was: how large the insertions were, whether an insertion is the answer, whether files changed outside the editor, whether the volume of output is proportionate to the typing, whether a file appeared too fast or only after a long absence, whether the student ever saw a command fail. Each is a pure synchronous function of the index, the bundle and the config, which is what lets ingest claim that a retry produces identical flags.\n\nThe group’s recurring difficulty is that its evidence is often reconstructed rather than recorded, and the confidences admit it. mass_external_replacement has no post-change content in the payload at all and uses the next save as a proxy, so it caps at 0.75. low_typing_high_output counts the net delta from the file’s opening content rather than its final size, because a student who opens a 500-character skeleton and adds 50 has produced 50 characters, not 550. inter_session_external_change exists because the recorder emits nothing while it is not running: the only witness to a file edited between two sessions is the next session’s doc.open content, compared against the reconstruction at the end of the previous one.\n\nOne of the ten answers to the capture policy. no_intermediate_errors reasons about terminal commands, so with terminal capture switched off it stands down entirely: "the student never saw a command fail" would be an artefact of the course’s configuration rather than a statement about how they worked. The rest read floor-only signals and are unaffected by design — low_typing_high_output leans on doc.open, and doc.open is on the floor precisely because so much depends on it.',
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
    body: 'These four are behavioural inferences about the log’s structure, which is what separates them from the validation checks upstream: a broken chain is proof, an overlapping session pair is an argument. They sit beside the cryptographic findings in the UI because a reviewer wants one list, but their confidences are 0.8, 0.75, 0.95 and 0.9 rather than 1.0.\n\nTwo of them encode a hard-won negative result. gap_in_heartbeats fires only when at least one other event was recorded strictly inside the gap: an empty gap is a suspended machine, not a paused recorder, and before that rule the flag fired hundreds of times per bundle on ordinary laptop sleep. multiple_sessions_overlap bounds a session that has no session.end at its last recorded event instead of leaving it open, because treating the ordinary crash signature as "still running" made one power cut overlap every session for the rest of the assignment. extension_hash_mismatch stays medium for a similar reason: an unrecognised build hash is as likely to mean staff have not published the new release yet as it is to mean a modified recorder.\n\ngap_in_heartbeats also has to answer to the capture policy, and it is the one case where the answer is a scaled threshold rather than a stand-down. Heartbeats are on the floor, but their cadence is tunable, so a course that lengthens the interval would otherwise trip a threshold calibrated for the default. The applied threshold is therefore whichever is larger of the configured floor and ten times the recorded cadence — max rather than replace, so a course that shortens the interval does not get a proportionally tiny threshold and a flood of flags. At the default cadence the arithmetic reproduces the shipped value exactly, so a 1.x bundle is unchanged to the byte.',
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
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [
  // The input artefact. How a bundle is built and what travels inside it belongs
  // to the recorder's seal step (master:bundle); how it is read belongs to
  // `unzip`, immediately downstream. A panel here would only sit between them.
  'zip',
];
