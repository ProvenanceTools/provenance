import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `state` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  dormant: {
    title: 'Dormant',
    body: 'The extension loads at all only because VS Code matched one of its two activation events: a workspace containing a file named .provenance-manifest or provenance-manifest, at any depth. In every other folder the extension host never wakes it, so dormant is less a running state than the absence of one.\n\nDormant is also where a workspace lands when a manifest is present but does not verify. The recorder keeps exactly one foothold there: a stub registration for the Prepare Submission Bundle command that does nothing but explain itself when invoked. Without it, a student who runs the command in the wrong folder gets VS Code’s opaque “command not found”. The stub writes no files and records nothing, so the “does nothing” guarantee still holds.',
    links: [
      { label: 'extension.ts', href: `${GH}/packages/recorder/src/extension.ts` },
      { label: 'Recorder PRD §4.1', href: `${GH}/docs/prd.md` },
    ],
  },
  verify: {
    title: 'Manifest verification',
    body: 'The recorder carries one ed25519 public key compiled into its own source — the root key — and a folder becomes an assignment only if its manifest chains back to it. Verification routes on format_version: a 2.0 manifest is walked root key → course_cert → course-signed payload, with the manifest’s course_id required to match the certificate’s; a 1.x manifest predates the chain entirely and is checked against a grandfathered legacy course key instead. Anyone can drop a file named .provenance-manifest into a directory; only course staff can make one the recorder will act on.\n\nOne key for every course is the change worth noticing. The course’s own public key now travels inside the certificate rather than being compiled in, so onboarding a course is minting a certificate rather than shipping a new build, and rotating a course key no longer requires every student to reinstall.\n\nThe failure branch is silent on purpose. A manifest that is missing, malformed, or badly signed produces one console line and nothing else: no dialog, no status bar, no log file, no .provenance/ directory. An error dialog would be a probe: it would tell whoever was editing the manifest exactly when they had the format right and only the signature wrong, and it would fire on every unrelated folder that happened to contain a file with that name. Silence gives the same protection and leaks nothing.',
    invariant:
      'If the signature does not verify, the extension does nothing: no session, no files, no UI.',
    links: [
      {
        label: 'manifest-loader.ts',
        href: `${GH}/packages/recorder/src/activation/manifest-loader.ts`,
      },
      {
        label: 'root-public-key.ts',
        href: `${GH}/packages/recorder/src/activation/root-public-key.ts`,
      },
      { label: 'Recorder PRD §4.1', href: `${GH}/docs/prd.md` },
    ],
  },
  recording: {
    title: 'Recording',
    body: 'A recording session is scoped to an assignment root, not to a window. Activation scans the open workspace folders for manifests at any depth and starts one independent session per directory whose manifest verifies, each with its own .provenance/ directory, its own log file, and its own freshly generated ed25519 keypair. Every state in this diagram therefore applies per session: one assignment can be degraded or dangling while another beside it keeps recording normally.\n\nThe session private key never sits on disk in the clear. It is encrypted under the course manifest’s signature and written to the .slog.meta sidecar, and every hundredth entry is signed with it as a checkpoint. Checkpoints are what make an unfinished log still provable: if the process dies mid-session, everything up to the last checkpoint carries a signature over its chain hash.',
    links: [
      {
        label: 'session-registry.ts',
        href: `${GH}/packages/recorder/src/session/session-registry.ts`,
      },
      {
        label: 'manifest-discovery.ts',
        href: `${GH}/packages/recorder/src/activation/manifest-discovery.ts`,
      },
    ],
  },
  degraded: {
    title: 'Degraded · disk full',
    body: 'When a write fails, the writer drops the lines it had buffered instead of holding them for a retry. That looks lossy and is deliberate: a failed write may have partially succeeded, so re-appending the same buffer risks duplicating entries in the middle of the hash chain. A short, honest log is usable evidence; a log with a duplicated run of entries fails chain validation and is worth nothing.\n\nFrom that point the session retains only six critical event kinds (session start and end, external changes, chain breaks, and the two recorder events) in a 256-entry in-memory ring, and drops everything else. The transition is one-way for the life of the session: nothing clears the degraded flag, which is why the notification asks the student to free space and restart the editor rather than promising to resume on its own.',
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
  suspended: {
    title: 'Suspended · machine sleep',
    body: 'When a laptop sleeps, the OS parks the extension host: no timer fires, so the 30-second heartbeat stops, but the extension is never deactivated, so no session end is written either. By wall clock alone that hole is indistinguishable from a recorder someone paused or a log someone trimmed, which is exactly why it has to be a modelled state rather than an unexplained gap.\n\nTwo mechanisms separate it from tampering. The recorder compares each heartbeat tick’s wall clock against the previous tick’s and emits a session.resumed marker when the gap reaches twice the interval; this must be wall clock, because macOS keeps its monotonic clock advancing through sleep while Linux does not, so a monotonic comparison would disagree across platforms. The analyzer then applies the decisive test: a gap with nothing recorded inside it means nothing was executing, so it is sleep. A gap with real activity inside it means the process was running and still failed to heartbeat, and that is flagged.',
    invariant:
      'A heartbeat gap containing no event recorded strictly inside it is machine suspend, not misconduct, and is never flagged. Wake-batch artefacts within a second of either boundary do not count as activity.',
    links: [
      { label: 'heartbeat.ts', href: `${GH}/packages/recorder/src/events/heartbeat.ts` },
      {
        label: 'gap-in-heartbeats.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/gap-in-heartbeats.ts`,
      },
    ],
  },
  crashed: {
    title: 'Terminated without a session end',
    body: 'The session end event is emitted from the extension’s teardown path, and the editor skips teardown whenever the window is killed, the machine shuts down, or the host process dies. A log with no session end is therefore the ordinary crash signature rather than a suspicious one, and both the recorder and the analyzer read it that way.\n\nWhat matters is where such a session is treated as ending. Analysis bounds it at the wall clock of its last recorded event, never at infinity. Leaving it open-ended meant a single crash on day one overlapped every session that started afterwards, for the rest of the assignment: a permanent false positive from one power cut. The last recorded event is the last moment the session demonstrably existed; extending the range beyond it invents evidence.',
    invariant:
      'A session with no session.end is bounded at its last recorded event, never left open-ended.',
    links: [
      {
        label: 'coverage/session-overlap.ts',
        href: `${GH}/packages/analysis-core/src/coverage/session-overlap.ts`,
      },
      {
        label: 'session-registry.ts',
        href: `${GH}/packages/recorder/src/session/session-registry.ts`,
      },
    ],
  },
  recover: {
    title: 'Recovering the previous session',
    body: 'On startup the recorder inspects the assignment’s .provenance/ directory, picks the most recent prior log by the wall clock recorded in its own session.start (log filenames are random UUIDs and carry no ordering information), and validates its chain. Recovery never reopens that log; the recorder always starts a fresh session and file. A prior log that ends in session.end needs nothing further: it closed cleanly, and linking to it would only clutter the session graph. Only a dangling log causes the new session’s session.start to carry prev_session_id, so that field means “the session before this one died”, not merely “the session before this one”.\n\nIf the prior chain fails to validate, the file is renamed with a .corrupt- suffix and a recorder.recovered_from_corruption event in the new session records where it went. Sealing then excludes .corrupt- files from the bundle: staff learn that corruption happened and when, without the unverifiable bytes travelling with the submission.\n\nNone of that is allowed to reach a file the recorder cannot prove is its own. Where partners share one git repository, .provenance/ is committed and both recorders write into it, so “the most recent log here” is routinely somebody else’s — a partner whose editor is open right now has no session.end at all. The recorder therefore reads only the first line of each log, compares the student_ref inside session.start.identity against its own, and considers only its own sessions. A partner’s log is never selected, never linked to, never read further, and above all never renamed: because .provenance/ is committed, quarantining it would delete their evidence from the submission and record the innocent student as having done it. student_ref is the only signal that can carry this — machine_id is salted per session and the session key is ephemeral, so neither can match across sessions.\n\nWhen the recorder holds no enrolment of its own it can prove nothing about anyone, so it keeps its hands off any log that names a contributor and confines itself to unattributed ones — which is exactly today’s behaviour in a directory where nothing is attributed. The case this cannot reach is two unenrolled partners: every file is unattributed and no evidence distinguishes them.',
    invariant:
      'The recorder only ever chains to, or quarantines, a session it can prove is its own. prev_session_id is set only when that previous own session dangled; a cleanly ended session is never linked.',
    links: [
      { label: 'chain-recovery.ts', href: `${GH}/packages/recorder/src/startup/chain-recovery.ts` },
      { label: 'seal.ts', href: `${GH}/packages/recorder/src/commands/seal.ts` },
    ],
  },
  sealed: {
    title: 'Sealed bundle',
    body: 'Sealing builds a bundle manifest over every log in the assignment’s .provenance/ directory, signs it with the session key, and zips those logs together with the current bytes of the files under review. It never refuses. A broken chain or an unparseable log becomes a warning in the manifest and a message to the student, and the bundle is written regardless. A student whose recording was interrupted must still be able to submit, and the integrity evidence is far more useful to staff inside a bundle than withheld from one.\n\nThe state is a snapshot, not a terminus. The session keeps recording after the zip is written, and sealing again simply produces another bundle. What becomes immutable is the sealed copy: manifest.json and manifest.sig are written atomically, over the canonical bytes that were actually signed, so an archived bundle stays verifiable long after the live log has grown past it.\n\nIt is also reachable only on the ZIP path, and that is the one thing this box can mislead about. A git-submitted assignment never enters this state at all — there is no command the student runs and no moment the recorder is told the work is finished — so a state machine drawn as ending here would describe half the product. Sealing there moves off the submission event and onto the recording: a per-session rolling manifest, rewritten at session start, at every checkpoint and at shutdown, so whatever is committed is always a valid seal of that moment. The transition is therefore not a transition; it is a thing that happens repeatedly inside RECORDING.',
    invariant:
      'Sealing never aborts on a broken chain. Tampering is surfaced by the analyzer’s checks, not by refusing to produce a bundle.',
    links: [
      { label: 'seal.ts', href: `${GH}/packages/recorder/src/commands/seal.ts` },
      { label: 'bundle-sign.ts', href: `${GH}/packages/log-core/src/bundle-sign.ts` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [
  // The unlabelled entry dot. It carries no semantics beyond "the editor started".
  'start',
];
