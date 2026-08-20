import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `recorder` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Host event sources ────────────────────────────────────────────────────
  h_doc: {
    title: 'Document change',
    body: 'This is the firehose: one event per keystroke, and the handler has a budget of under a millisecond at p99. Everything expensive is therefore pushed elsewhere: the entry is hashed and enqueued synchronously, and the actual write happens on a buffered flush.\n\nTwo filters run before anything else. Changes carrying no content deltas (dirty-flag toggles, encoding and line-ending changes) are dropped early, because they are noise to the analyzer, though their timestamp is still recorded to keep the file watcher’s tolerance window honest. And a change on a still-clean buffer is checked against what is actually on disk before being treated as an edit at all: the editor delivers the content change before it flips the dirty flag, so a genuine reload from disk and a student’s first keystroke after a save arrive with identical signatures. Only the disk comparison separates them: if the buffer now matches disk it was a reload, if it diverged it was a real edit.',
    links: [
      { label: 'doc-wiring.ts', href: `${GH}/packages/recorder/src/wiring/doc-wiring.ts` },
      { label: 'Recorder PRD §4.7', href: `${GH}/docs/prd.md` },
    ],
  },
  h_cmd: {
    title: 'Paste command intercept',
    body: 'The three hosts have very different degrees of access here, and this is the signal where they diverge most. IntelliJ lets the plugin wrap the EditorPaste action, and Neovim lets it wrap vim.paste, so both see the paste in the same call stack as the edit it causes. VS Code does not: registering a handler for a built-in command id such as editor.action.clipboardPasteAction throws in the extension host, and there is no supported way around it.\n\nThe VS Code port therefore registers a separate command of its own that calls the built-in paste underneath, and course staff may bind it to Cmd+V through a workspace keybinding. Where that binding is not installed this signal contributes nothing, and the recorder does not pretend otherwise. The intercept count still feeds the reconciler, so an absent signal 2 shows up as a recorded discrepancy rather than as silently misclassified pastes.',
    links: [
      {
        label: 'paste-command-intercept.ts',
        href: `${GH}/packages/recorder/src/wiring/paste-command-intercept.ts`,
      },
      { label: 'Recorder PRD §4.3', href: `${GH}/docs/prd.md` },
    ],
  },
  h_clip: {
    title: 'Clipboard read',
    body: 'Reading the clipboard is only useful if it can be read at the moment of the paste, before any reformatting, and in the same call stack as the edit. The JetBrains plugin gets that from wrapping the paste handler and asking CopyPasteManager; the Neovim plugin gets it from preferring the + register (falling back to *) over the lines Neovim hands it, because those lines have already been through Neovim’s own processing.\n\nIn VS Code this source does not exist. Without a hook inside the built-in paste command there is no moment at which reading the clipboard would be attributable to a specific edit, and a clipboard read at any other time is just surveillance of whatever the student last copied. So the VS Code recorder never reads the clipboard at all, and its third signal is the count reconciliation instead. The PRD’s name for that signal, "external clipboard read", describes the intent rather than the mechanism, and is worth not reading literally.',
    links: [{ label: 'Recorder PRD §4.3', href: `${GH}/docs/prd.md` }],
  },
  h_fs: {
    title: 'Filesystem watcher',
    body: 'One watcher per file in files_under_review, not a watcher on the workspace. That scope is the point: an external write to a file nobody is grading is not evidence, and watching everything would mean recording build output, virtualenvs and editor scratch files as external changes.\n\nThe watcher covers the half of external-change detection the document listeners cannot see: a write that happens while the file is not open in a buffer at all. Its guard is a tolerance window: a change within 250 ms of that file’s last document change or last save is assumed to be the editor’s own write and skipped. Anchoring on the save as well as the change is load-bearing, because the editor’s autosave delay defaults to a full second, so a window anchored only on the last keystroke would never cover the editor saving the file it just autosaved.',
    links: [{ label: 'fs-watcher.ts', href: `${GH}/packages/recorder/src/wiring/fs-watcher.ts` }],
  },
  h_term: {
    title: 'Terminal',
    body: 'Terminal opens are always recorded; the commands run inside them are recorded only when the shell has integration enabled, which depends on the shell, its configuration and the editor version. The recorder does not treat that as a failure: it records terminal.open with shell_integration set to false, so the gap is a documented fact about the session rather than an unexplained absence of terminal events.\n\nThat flag is load-bearing downstream. The heuristic that looks for the absence of intermediate errors (a file that goes from empty to finished with no failing command in between) cannot distinguish "never ran anything that failed" from "we could not see the commands", so when shell integration is off it emits an info-severity skip with the reason attached instead of a finding. A separate heuristic notes the disabled integration itself, since turning it off is one of the cheaper ways to make a session look cleaner than it was.',
    links: [
      {
        label: 'terminal-wiring.ts',
        href: `${GH}/packages/recorder/src/wiring/terminal-wiring.ts`,
      },
      {
        label: 'no-intermediate-errors.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/no-intermediate-errors.ts`,
      },
    ],
  },
  h_git: {
    title: 'Git',
    body: 'Git is observed through the editor’s built-in git extension rather than by shelling out, and every access is defensive: the extension may be absent, its API request may fail, a repository may not expose HEAD. Any of those degrades to a warning on the console and no git events, never to a failed session.\n\nWhat is recorded is the commit graph, not a reconstruction of what the student did: the HEAD sha, its parent shas, and the current branch. Parents are what make it a graph rather than a list — zero parents is a root commit, one an ordinary commit, two or more a merge — and their order is meaningful, because the first parent is the branch that was merged into, so nothing sorts them. An empty parent array and an absent one say different things: the first is “this commit genuinely has no parents”, the second is “the read failed”, and collapsing them would let a failure pass as a root commit. Branch is omitted rather than invented when HEAD is detached.\n\nCapturing the graph here rather than shipping .git is the point. Gradescope delivers no .git, and one that did travel would prove less than it appears to: amend, rebase and filter-branch all rewrite history after the fact, so a repository handed in is evidence of what a student ended up with. The recorder sits on the live repository while the work happens, so the graph goes into the signed hash chain at the instant it existed, where it can no longer be rewritten.\n\nNo git author name and no author email are captured, here or anywhere else. That is a protocol constraint rather than a preference: the approved CPHS protocol treats a new category of identifier as requiring a filed modification before implementation, and a real name and address on every commit is exactly that. Sha, parents and branch describe the shape of the history, not who produced it, and attribution already has a designed, opaque home in session.start’s student_ref. The local type the recorder reads a commit through declares only hash and parents, so the author fields are unreachable rather than merely unused.\n\nReading parents needs an asynchronous call, so emission is queued through a single chain per wiring to keep log entries ordered — a fast read must not overtake a slow one. The explanation tagger is still marked synchronously, before anything is awaited: a checkout’s file writes land immediately, and deferring the mark would reintroduce exactly the unexplained-external-edit flags the tagger exists to prevent. Git rewrites files as its normal behaviour, and a detector that flags that is a detector nobody reads.\n\nWhich repositories a session records is a routing decision, made before the graph is read: fetching the history of a repository this session does not own is work it should never do. The predicate is not the one used for files. A file belongs to the nearest assignment root that contains it, but a repository root is normally the other way round — one repository at the top, one assignment directory and its own .provenance/ beneath it — so a containment test can never match it. Asking the file question about a repository returned “owned by nobody” for exactly the layout the courses use, and every git event was dropped with no error anywhere. A repository is owned when its root contains, equals, or sits beneath this session’s assignment root; anything unrelated, including a sibling assignment that is its own repository, is still refused. Where several assignments record concurrently under one repository, each session records the graph into its own chain, because evidence cannot be shared between two signed logs.\n\nEach observation also carries which repository it came from, as that repository’s root-commit sha. The value is derived once per repository when the wiring is set up, never per event, by walking HEAD’s first-parent lineage to its root — first-parent because that lineage stays on the mainline when an imported history is merged in, which is what keeps two partners on one repository agreeing. Several roots is ordinary, from an orphan branch or a squashed import, and the smallest is taken so the choice is deterministic rather than a matter of which partner ran the command. The root-commit sha was chosen precisely because both partners derive the same value offline; a session-salted hash of the repository path would have given them different answers and correlated nothing.\n\nThe field is omitted rather than guessed. A shallow clone has no reachable root — the boundary commit it reports has no parents but is not one — so emitting it would publish a value a full clone of the same repository disagrees with, and the same omission covers a missing binary, a timeout, and anything that comes back unusable. Omitted, never null: an absent key and a null value canonicalize differently and therefore chain to different hashes, exactly as an empty parents array and an absent one do. Absence is a legal, permanent, blameless answer that costs only correlation.\n\nA repository observed by a session is labelled with its own root, so a submodule is a different repository from the one that contains it — which is the whole point, since their sha spaces are unrelated and labelling the inner one with the outer root re-creates the merge the field exists to prevent. The value is checked against the reader’s own narrowing before it is written, so a repository path or a remote URL can never be recorded here; that is the same constraint that keeps author identity out, and it holds on the write side rather than being left to the reader to catch.',
    links: [
      { label: 'git-wiring.ts', href: `${GH}/packages/recorder/src/wiring/git-wiring.ts` },
      { label: 'session-router.ts', href: `${GH}/packages/recorder/src/session/session-router.ts` },
      {
        label: 'explanation-tags.ts',
        href: `${GH}/packages/recorder/src/events/explanation-tags.ts`,
      },
    ],
  },
  h_win: {
    title: 'Window',
    body: 'Focus is recorded as transitions only: the handler compares the new focused state against the previous one and emits nothing when they agree, because the editor fires window-state events for reasons other than focus and an event per fire would bury the signal. Selection changes are recorded as they come, and are among the noisiest kinds in a log.\n\nExtension observation rides here too, and it is two mechanisms rather than one. A snapshot of every installed extension with its version is taken at session start and every five minutes after; separately, a poller diffs the active set once a second and emits an activation event for anything newly active. The pair is what makes "an assistant appeared partway through" detectable at all: the heuristic fires on an activation whose extension was absent from the session-start snapshot, which a five-minute snapshot cadence alone could not pin down. "Enabled" in the snapshot is an approximation: the public API exposes whether an extension has activated, not whether it is enabled, and the recorder records the honest field rather than inventing the one it wants.',
    links: [
      {
        label: 'extension-snapshot.ts',
        href: `${GH}/packages/recorder/src/wiring/extension-snapshot.ts`,
      },
      {
        label: 'extension-set-changed-mid-assignment.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/extension-set-changed-mid-assignment.ts`,
      },
    ],
  },

  // ── Detection & classification ────────────────────────────────────────────
  reconcile: {
    title: 'The per-event join',
    body: 'Each signal fails differently, which is why none of them is trusted alone. The size-and-shape classifier sees every bulk insertion but cannot tell a clipboard paste from a tool applying an edit; the command intercept is certain when it fires but fires only if a keybinding is installed; the clipboard read is exact but unavailable in VS Code. Collapsing to any one of them buys simplicity by giving up the case the others cover.\n\nThis node is only half of the combination, and the split is worth being exact about. In VS Code, signals 1 and 2 are joined here, synchronously inside the document handler: a change classified as a bulk insertion consumes any paste intercept recorded just before it, and one paste event comes out. When the change cannot be replayed as a paste, a document change with a paste_likely source comes out instead. Signal 3 is not part of that decision at all; it is the periodic count comparison drawn next to it. The JetBrains and Neovim ports do join a real clipboard read here, which is the one place the three implementations genuinely differ in structure rather than in API.',
    invariant:
      'Three signals, combined. No single signal is authoritative, and disagreement between them is itself recorded rather than resolved silently.',
    links: [
      {
        label: 'paste-reconciler.ts',
        href: `${GH}/packages/recorder/src/events/paste-reconciler.ts`,
      },
      {
        label: 'paste-classifier.ts',
        href: `${GH}/packages/recorder/src/events/paste-classifier.ts`,
      },
      { label: 'Recorder PRD §4.3', href: `${GH}/docs/prd.md` },
    ],
  },
  anomaly: {
    title: 'The paste reconciler',
    body: 'Signal 3 is a periodic count comparison, not a per-event decision. Every five seconds it takes the delta in intercepted-paste count and the delta in bulk-insertion count over that window, and emits a paste.anomaly when they differ by more than a tolerance of one. It never names an event, and it never decides what any individual change was: a per-event join can only report on the events it already saw, whereas comparing counts is what catches a paste that produced no classified insertion, or an insertion that went through no paste at all.\n\nA paste.anomaly is not an accusation. A divergence most often means a keybinding was never installed, and sometimes means something wrote into the buffer without going through a paste.\n\nThe consequence downstream is a confidence adjustment rather than a flag: a large paste falling inside an anomaly window is reported with lower confidence than one outside it, because the recorder is less sure of what it saw. Recording the uncertainty is the alternative to two worse options: dropping the paste, which loses the evidence, or reporting it at full confidence, which overstates it.',
    links: [
      {
        label: 'paste-reconciler.ts',
        href: `${GH}/packages/recorder/src/events/paste-reconciler.ts`,
      },
      {
        label: 'large-paste.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/large-paste.ts`,
      },
    ],
  },
  expected: {
    title: 'Expected-content registry',
    body: 'The recorder maintains a model of what it believes every tracked file contains, updated after each edit it observes. External-change detection compares the on-disk hash against that model.\n\nThe direction matters and is easy to reverse: the model is the source of truth, the disk is what you check against it. Reversing it produces a recorder that flags every ordinary save and misses every real evasion.',
    invariant:
      'The expected-content model is the source of truth; the on-disk hash is compared to it.',
    links: [
      {
        label: 'expected-content.ts',
        href: `${GH}/packages/recorder/src/state/expected-content.ts`,
      },
      { label: 'Recorder PRD §4.5', href: `${GH}/docs/prd.md` },
    ],
  },
  cmp: {
    title: 'Does the disk match the model?',
    body: 'A straight hash comparison is not enough, because reading the file is asynchronous. A keystroke landing between the physical write and the read moves the model past the snapshot that was read, and a naive compare then reports the student’s own save as an external write. Worse, the reconciliation that follows used to reset the model backwards onto the stale snapshot, guaranteeing the next save mismatched too.\n\nThe fix is a bounded ring of the last thirty-two content hashes the buffer has actually held. If the disk holds a state this buffer genuinely passed through, the write was ours, observed late: emit nothing, and specifically do not reset, because the live buffer is ahead and authoritative. Content the buffer never held still falls through and is reported, so a real external write is unaffected. The ring is a count of states rather than a time window on purpose: it needs no clock, so the model stays pure and deterministic under test, and it behaves the same for a fast typist and a slow one.',
    invariant:
      'A disk state the buffer genuinely passed through is the editor’s own write observed late. It is never reported, and never resets the model backwards.',
    links: [
      {
        label: 'expected-content.ts',
        href: `${GH}/packages/recorder/src/state/expected-content.ts`,
      },
      {
        label: 'external-change-detector.ts',
        href: `${GH}/packages/recorder/src/events/external-change-detector.ts`,
      },
    ],
  },
  explain: {
    title: 'Is there an innocent explanation?',
    body: 'Formatters and git rewrite files constantly, and both do it from outside the edit path, so both look exactly like an external write. The recorder marks the most recent such operation with its timestamp; a detected external change asks that mark whether it explains the change to its path, and if the mark is less than two seconds old the resulting event carries an explanation field instead of standing alone.\n\nThe mark is a set of paths with a budget, not a single slot, and that is a correction rather than an original design. It held one entry consumed by the first taker, on the reasoning that one explanation should explain one external change. Git broke that reasoning: a pull that rewrites twelve files raises twelve external changes from one operation, so eleven of them were unexplained and became external-edit findings against a student who did nothing but collect their partner’s work. One mark now explains every distinct path that asks inside the window, up to sixty-four of them, and repeating a path is free because a single write can surface through both the watcher and the save-time compare.\n\nBoth of its failure modes are still real and both are named in the source. Timing cannot tell a hand edit landing inside the window from a file the pull rewrote, and a watcher event arriving late, or past the budget, is unexplained even though git caused it. The budget fails in the safe direction — exceeding it produces findings rather than hiding them — but the honest fix is content, not timing: an external change whose resulting bytes match a state some contributor’s session demonstrably produced was delivered by git, provably and without a clock. That reclassification has since landed in the analyzer, and the tagger was kept rather than retired, because it still covers what content cannot: a solo student, a 1.x bundle, a partner who never enrolled, and formatters, which have no content-side equivalent at all. It is also inside the signed chain at the instant the operation happened, where the classification — derived later, by a reader — is not.\n\nWhere the two disagree, content wins. An external change the tagger called git-explained, but whose bytes match nothing anyone in the submission recorded, is now flagged anyway; only bytes that provably match a different verified contributor’s recorded state are set aside. Leaving the tag in charge there would have left a two-second window that silences a finding the content test says is real, and a window like that is something a student can learn to time a paste into. What the flag then says is bounded by what is actually known: the content has no recorded authorship in this scope, which an honest pair whose partner was not recording produces exactly as readily as code from elsewhere, and the flag says so rather than picking one.\n\nThe event is still recorded either way: an explained change is annotated, not suppressed. The judgement about whether the explanation is adequate belongs to the analyzer and to the person reading it, not to the recorder deciding what to keep.',
    invariant:
      'An explanation annotates an external change; it never suppresses the event. Anything unexplained stays flagged.',
    links: [
      {
        label: 'explanation-tags.ts',
        href: `${GH}/packages/recorder/src/events/explanation-tags.ts`,
      },
      { label: 'Recorder PRD §4.5', href: `${GH}/docs/prd.md` },
    ],
  },

  // ── Pure transforms ───────────────────────────────────────────────────────
  tx: {
    title: 'Event to log entry',
    body: 'These transforms are pure functions of an editor event, which is what lets them be unit-tested with no editor present at all. The seam is here rather than deeper, because everything below this line is host-independent and everything above it is not. Paths are made relative to the owning assignment root rather than to the opened workspace folder, which matters as soon as one window contains several assignments.\n\nThe inline-content cap is the interesting constant. Three payloads carry content (document opens, pastes, and external changes), and all three read one shared limit, currently 64 KB of UTF-8, measured in bytes rather than characters, so a string of multi-byte codepoints is over the cap well before it is 65 536 characters long. It was raised from 4 KB because at 4 KB the evidence was discarded at record time and no analyzer-side fix could recover it: a paste event is not duplicated by a document change, so a pasted solution above the cap was invisible to both reconstruction and every paste heuristic, the single case the product exists to catch. That is also why a paste too large to inline is emitted as a document change with a paste_likely source rather than as a truncated paste: a paste event the analyzer cannot replay is strictly worse than a document change that replays faithfully.',
    invariant:
      'Never emit a paste event the analyzer cannot replay. Wrong shape or over the cap routes to doc.change with source paste_likely instead.',
    links: [
      {
        label: 'inline-content-limits.ts',
        href: `${GH}/packages/recorder/src/events/inline-content-limits.ts`,
      },
      { label: 'doc-events.ts', href: `${GH}/packages/recorder/src/events/doc-events.ts` },
    ],
  },

  // ── Core — the format contract ────────────────────────────────────────────
  polic: {
    title: 'The capture policy',
    body: 'Resolved once, at session start, from the manifest the recorder has already verified — and only from a 2.0 one. The resolver gates on the format version itself rather than trusting its caller, because below 2.0 the policy block is not inside the signed payload, and honouring one there would hand students exactly the off switch the version gate exists to deny them. A 1.x manifest resolves to everything on at a thirty-second cadence, which is v1.x behaviour unchanged.\n\nResolution is total by construction and returns no Result. A missing block, a malformed value, a number that is not finite, an interval outside the five-second-to-two-minute clamp: each has a defined answer, so there is no failure mode in which the recorder has to decide what to do about a policy it could not read. A course that writes garbage into the interval gets the safe default cadence rather than the floor.',
    links: [
      { label: 'policy.ts', href: `${GH}/packages/log-core/src/policy.ts` },
      {
        label: 'manifest-loader.ts',
        href: `${GH}/packages/recorder/src/activation/manifest-loader.ts`,
      },
    ],
  },
  gate: {
    title: 'The policy choke point',
    body: 'One check, inside emit, and that singularity is the design. Gating here rather than at each wiring call site means no code path — present or future — can emit a policy-disabled kind by forgetting a check, which is the failure mode a per-handler gate invites the first time someone adds a listener. The cost on the hot path is a property lookup in a frozen constant map plus a boolean read; floor kinds, doc.change among them, miss the map and return immediately, so the firehose pays essentially nothing.\n\nWhat it can reach is deliberately small. Only selection.change, focus.change, terminal.open and terminal.command have a key at all; every other kind is absent from the map and therefore returns captured unconditionally. There is no "disable everything" state to enter, because the schema cannot express one.\n\npeer.observed \u2014 the record of a partner\u2019s log seen in the working tree \u2014 joins the floor, and it is the one entry the usual test does not obviously reach. It is the most privacy-sensitive signal in the protocol, being the only one that describes a DIFFERENT student\u2019s artefact, and sensitivity normally argues FOR a knob. It has none because the design puts the disambiguation elsewhere: whether witnessing was AVAILABLE is a session.start capability report, in the manner of git capture, not a capture key \u2014 a capability report says \u201cI could not do this\u201d where a knob says \u201cI was told not to\u201d. Treat the placement as provisional: the human-subjects question it turns on is open, and it is now live rather than hypothetical \u2014 this recorder emits the kind. If that question comes back requiring a per-course off switch, the entry moves to the policy-gated set with its own capture key, in the same change that gives the two sibling recorders their watchers.',
    invariant: 'One gate, in emit. A floor kind has no entry in the map and is always captured.',
    links: [
      { label: 'session-host.ts', href: `${GH}/packages/recorder/src/session/session-host.ts` },
      { label: 'policy.ts', href: `${GH}/packages/log-core/src/policy.ts` },
    ],
  },
  drop: {
    title: 'A suppressed event',
    body: 'The ordering is the whole point of this box. Suppression happens before the entry is chained, so a dropped event never takes a sequence number and emit returns null instead of an envelope. Dropping after chaining would advance the counter and leave a gap in the sequence — and a gap is precisely what validation check 4 reads as a deleted entry. A course exercising a legitimate configuration option would have manufactured a tampering finding against every student it applied to.\n\nNothing records the drop, and nothing needs to. The effective policy travels into the bundle inside session.start, so the analyzer can already tell that a signal was switched off; a per-event marker would add bytes to the chain to restate a fact the manifest states once.',
    invariant:
      'Suppress before chaining. A dropped event consumes no seq, so the log has no hole for check 4 to read as a deletion.',
    links: [
      { label: 'session-host.ts', href: `${GH}/packages/recorder/src/session/session-host.ts` },
      {
        label: 'verify-seq.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-seq.ts`,
      },
    ],
  },
  env: {
    title: 'The envelope',
    body: 'Five fields, and the two time fields are not interchangeable. t is milliseconds since session start taken from a monotonic clock, so it survives the system clock being changed; wall is an ISO 8601 UTC string from the wall clock, so it can be compared against everything outside the session. Conflating them is one of the easiest mistakes to make here and produces a log that is either unorderable or uncorrelatable.\n\nKeeping both is what makes clock manipulation visible rather than merely possible. A separate watcher compares the two clocks once a second and emits clock.skew when they disagree by half a second or more, and validation then checks t and wall for monotonicity independently, with a wall-clock regression forgiven only when a clock.skew event was recorded in the window spanning it. A student who sets the system clock back leaves a log where the two disagree; a student who edits timestamps afterwards breaks the chain instead.',
    invariant: 'Monotonic clock for t, wall clock for wall. Never conflate them.',
    links: [
      { label: 'envelope.ts', href: `${GH}/packages/log-core/src/envelope.ts` },
      { label: 'clock-watcher.ts', href: `${GH}/packages/recorder/src/events/clock-watcher.ts` },
    ],
  },
  jcs: {
    title: 'JCS canonicalization',
    body: 'A hash is over bytes, and the same JSON object can be serialized to many different byte sequences: key order, whitespace, how 1.0 versus 1 versus 1e0 is written. RFC 8785 fixes all of it, so a hash computed by the TypeScript recorder, the Kotlin one and the Lua one over the same entry is the same hash. Without it the format contract could not span three languages.\n\nIt is used for two things, and both are unforgiving: the hash chain, and the signatures over the checkpoint pairs and the bundle manifest. This is not hand-rolled anywhere: the reference library is used, and the manifest is written to disk as the exact canonical bytes that were signed rather than re-serialized from the object, so a verifier never has to reproduce the serialization decision to check the signature.',
    invariant: 'Never hand-roll canonicalization. Sign and store the same bytes.',
    links: [
      { label: 'canonical.ts', href: `${GH}/packages/log-core/src/canonical.ts` },
      { label: 'Recorder PRD §5.2', href: `${GH}/docs/prd.md` },
    ],
  },
  hash: {
    title: 'The chaining step',
    body: 'The hash covers the previous entry’s hash concatenated with the canonical JSON of this entry, and the entry at this point has no hash field of its own, which is what makes the computation well-defined rather than self-referential. The first entry chains from sixty-four hex zeros. There is exactly one function that does this, in each language, and every path that produces an entry goes through it, because two chaining paths mean two behaviours and therefore a seam.\n\nIt runs on the emit path, synchronously, before anything is buffered. That ordering is why a dropped buffer degrades gracefully: the chain state lives in memory and advances as entries are produced, so losing buffered lines truncates the log rather than renumbering it. It is also why this step only hashes: signing is an asynchronous ed25519 operation and belongs on the checkpoint path, well away from a handler with a sub-millisecond budget.',
    invariant: 'Exactly one chaining function per implementation. Hash here, never sign here.',
    links: [
      { label: 'hash-chain.ts', href: `${GH}/packages/log-core/src/hash-chain.ts` },
      { label: 'session-host.ts', href: `${GH}/packages/recorder/src/session/session-host.ts` },
    ],
  },
  buf: {
    title: 'Buffer policy',
    body: 'Appending an entry is synchronous and does nothing but serialize the line, add it to an in-memory buffer, and ask a pure decision function whether it is time to flush, at 256 KiB or one second, whichever comes first. The write itself is fired and forgotten, so an editor event handler never waits on the disk. A periodic timer covers the case where the student stops typing, and it is unref’d so it cannot hold the process open at shutdown.\n\nConcurrent flushes are chained onto a single promise rather than issued in parallel. Log writes are ordered by definition (an entry’s meaning depends on its position in the chain), so a Promise.all over them would be a correctness bug, not an optimisation. The policy itself is a pure function of buffered bytes and elapsed time with no state and no I/O, which is what makes the thresholds testable without a filesystem.',
    links: [
      { label: 'buffer-policy.ts', href: `${GH}/packages/log-core/src/buffer-policy.ts` },
      { label: 'session-writer.ts', href: `${GH}/packages/recorder/src/io/session-writer.ts` },
    ],
  },

  // ── Durability ────────────────────────────────────────────────────────────
  atomic: {
    title: 'Atomic replace',
    body: 'Write to a uniquely named temp file, fsync it, rename it into place, rename being atomic on POSIX, so a reader sees either the old file or the new one and never a half-written one. On any failure the temp file is unlinked best-effort and the original error is re-thrown rather than masked by whatever the cleanup did.\n\nThis is one of the two durability strategies in this lane, and it covers whole-file writes only: the .slog.meta sidecar, rewritten in full after every hundred-entry signed checkpoint; manifest.json and manifest.sig at seal; and the rolling seal’s manifest-<session_id>.json and .sig, rewritten on every checkpoint into a directory that is under git and gets committed.\n\nThat last pair needs more than one atomic write, because a signature and the payload it covers only mean anything together. They go through a pair-commit: both temp files are written and fsynced first, and only then are both renamed back to back, so the window in which a reader can catch a new .json beside the previous .sig shrinks from a whole file write to a single syscall. POSIX cannot make it zero — there is no multi-file rename — so the window is reported rather than pretended away: a commit landing inside it produces a manifest_sig failure naming that session, which is the right answer for evidence nothing vouches for. The .slog itself is on the other path entirely: append-only through a file handle held open for the session. Rewriting the whole log on every entry would be absurd; appending to a signed manifest would be meaningless. Two problems, two mechanisms, and drawing them as one is what hides the fact that a torn write means something different on each.\n\nThe rolling seal is written only where git submission is actually in use, gated on the course manifest’s submission field. That field is part of the 2.0 signed payload, which is what makes it usable as a gate: a 1.x manifest is parsed by a path that returns no submission at all, so the value bundle can only ever come from something the course signed, and nothing unsigned can switch the seal off. The gate fails OPEN — suppressed only on an explicit signed bundle. Rolling where it is not needed costs two files the classic manifest overrides anyway; not rolling where it is needed leaves every session unsealed, which fails check 1 against a student whose course simply has not migrated its manifest yet.\n\nThe rolls are not all alike. Every roll but one is taken while the log is still growing, so what it signs is a commitment to a prefix and a reader must not treat later bytes as tampering. Shutdown is the exception: dispose emits session.end, flushes and closes the writer, drains the pending checkpoint into the .meta, and only then rolls one last time — with final set inside the signed payload. Nothing can append to either file after that point, so the digests are whole-file commitments and the analyzer will fail an append against them. The ordering is the whole justification, which is why exactly one call site sets the flag: passing it from a checkpoint would assert that a live log is finished and turn the student’s next keystroke into an integrity finding. Every path that never reaches a clean dispose — a crash, a power cut, a full disk, a read-only checkout, .provenance/ deleted by a git checkout — simply leaves the last non-final seal in place, which reads as a coverage gap rather than as tampering.',
    invariant:
      'Whole-file writes go temp-then-rename. The live log is append-only and never rewritten.',
    links: [
      { label: 'atomic-write.ts', href: `${GH}/packages/recorder/src/io/atomic-write.ts` },
      { label: 'meta-writer.ts', href: `${GH}/packages/recorder/src/io/meta-writer.ts` },
    ],
  },
  full: {
    title: 'Did the write fail?',
    body: 'Any write error trips this branch, not only ENOSPC. That is a v1 simplification and a defensible one: the recorder cannot reliably distinguish a full disk from a revoked permission or a vanished network mount, and every one of those means the same thing operationally: the log can no longer be trusted to reach the disk, so stop pretending otherwise.\n\nThe transition is one-way for the life of the session. Nothing clears the flag, which is why the notification asks the student to free space and restart the editor rather than promising to recover; a handler that retried would have to guess whether the failed write had partially landed.',
    links: [
      {
        label: 'disk-full-handler.ts',
        href: `${GH}/packages/recorder/src/failure/disk-full-handler.ts`,
      },
      { label: 'Recorder PRD §4.8', href: `${GH}/docs/prd.md` },
    ],
  },
  disk: {
    title: 'The .slog on disk',
    body: 'One file per session, named with a random UUID, opened in append mode and held for the life of the session: every flush is a write on that one handle, and the file is never rewritten. Log filenames therefore carry no ordering information at all: when the recorder needs to find the previous session on startup it reads the wall clock out of each log’s own session.start rather than sorting names.\n\nNothing flows back from here to the chain, which is why no edge does. prev_hash for the next entry comes from the session host’s in-memory state, which advanced the moment the previous entry was chained; the file is never re-read to continue a chain. That is what keeps entry production synchronous and independent of whether the last flush has actually landed, and it is also why a session that ends badly leaves a shorter log rather than a corrupted one.',
    links: [
      { label: 'session-host.ts', href: `${GH}/packages/recorder/src/session/session-host.ts` },
      {
        label: 'chain-recovery.ts',
        href: `${GH}/packages/recorder/src/startup/chain-recovery.ts`,
      },
    ],
  },
  degr: {
    title: 'recorder.degraded',
    body: 'On a write failure the buffered lines are dropped rather than held for a retry. That looks lossy and is deliberate: a failed write may have partially succeeded, so re-appending the same buffer risks duplicating entries in the middle of the chain, and a log with a duplicated run fails validation outright, whereas a short log is still usable evidence.\n\nFrom that point the session keeps only six event kinds (session start and end, external changes, chain breaks, and the two recorder events) in a 256-entry in-memory ring, and drops everything else. The choice of which six is the whole design: they are the events that describe the shape of the session and any tampering within it, which is exactly what a reviewer needs to know about a recording that stopped being complete. The degraded event itself is one of them, so the record of when the recording became partial survives in the same ring as the rest.',
    invariant:
      'Never partial-write the live log. On a write error the buffer is dropped, never re-appended: a duplicated entry damages the chain worse than a missing one.',
    links: [
      {
        label: 'disk-full-handler.ts',
        href: `${GH}/packages/recorder/src/failure/disk-full-handler.ts`,
      },
      { label: 'session-writer.ts', href: `${GH}/packages/recorder/src/io/session-writer.ts` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [];
