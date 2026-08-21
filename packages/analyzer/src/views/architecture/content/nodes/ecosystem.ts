import type { ArchNode } from '../types.js';
import { GH, GH_PROVGATE } from './links.js';

/**
 * Blob roots of the two sibling recorder repos. Their bundles are format-compatible
 * with the monorepo's, but the source lives elsewhere — so these bases are local to
 * this group file rather than in the shared links module.
 */
const GH_PROVJET = 'https://github.com/ProvenanceTools/provenance-jetbrains-recorder/blob/main';
const GH_PROVNVIM = 'https://github.com/ProvenanceTools/provenance-neovim-recorder/blob/main';

/** Nodes in the `ecosystem` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── REPO 1 · provenance — the monorepo ────────────────────────────────────
  logcore: {
    title: 'log-core · the format authority',
    body: 'log-core is not just a shared library; it is the single normative definition of the log format, and the other three implementations are measured against it rather than against each other. The event envelope, JCS canonicalization, the SHA-256 hash chain, ed25519 signing and the bundle/manifest shapes all live here in pure TypeScript, and the pinned vectors in hash-chain.test.ts are what “the format” means in practice.\n\nIts forbidden-imports list is the load-bearing part. An ESLint no-restricted-imports rule on packages/log-core/**/*.ts rejects vscode, node:fs, node:path, node:worker_threads, node:crypto and their bare aliases, so the package cannot reach for a Node buffer or a VS Code type even by accident. That is what lets the identical file run inside the browser analyzer, the Node server, and (reproduced, not imported) the two sibling recorders. A dependency on any host would quietly fork the format along runtime lines, which is the one thing the whole system cannot survive.',
    invariant:
      'log-core has zero dependencies on vscode, node:*, fs, path or the DOM, enforced by ESLint, not by convention. The format it defines is the contract every other repo reproduces.',
    links: [
      { label: 'hash-chain.ts', href: `${GH}/packages/log-core/src/hash-chain.ts` },
      { label: 'eslint.config.mjs', href: `${GH}/eslint.config.mjs` },
    ],
  },
  vsrec: {
    title: 'recorder · the reference host',
    body: 'Of the three recorders this is the only one that imports log-core rather than reimplementing it. It is the reference host: the format is authored one package over, in the same repo and language, so a bundle sealed by the VS Code extension is the definition of a correct bundle that the Kotlin and Lua ports are then required to match.\n\nThe asymmetry the diagram draws as “implements” is exactly that. The other two recorders sit behind a conformance gate because they carry a second copy of the format; this one carries none: it depends on log-core directly, so a format change reaches it for free and reaches the siblings only after their vectors are regenerated. Everything the extension adds on top is host wiring: activation, the document/paste/external-change signals, sealing.',
    links: [
      { label: 'extension.ts', href: `${GH}/packages/recorder/src/extension.ts` },
      { label: 'Recorder PRD §4', href: `${GH}/docs/prd.md` },
    ],
  },
  shared: {
    title: 'shared · the API contract',
    body: 'shared is the second of the system’s two cross-cutting contracts. The log format binds the recorders to the analyzer; shared binds the server to the browser SPA. It is a set of Zod schemas and nothing else (its only dependency is zod) and both ends import the same schemas, so the request and response shapes cannot drift apart the way two hand-written type declarations would.\n\nZod rather than plain TypeScript types is deliberate: the schema is a runtime validator at the HTTP boundary as well as a compile-time type, so the server narrows an untrusted request body through the exact object the analyzer serialized against. A change to the API shape is treated like a format change (versioned, both ends updated in one diff) because a server and an SPA that are deployed separately have nothing else keeping them honest.',
    invariant:
      'The HTTP API shape lives in one place and both ends import it. Schema changes are versioned and land in a single diff, never on one side alone.',
    links: [{ label: 'api-schemas.ts', href: `${GH}/packages/shared/src/api-schemas.ts` }],
  },
  acore: {
    title: 'analysis-core · the shared engine',
    body: 'analysis-core exists because of a mistake it was extracted to fix: the server used to import analysis code straight out of the analyzer’s source tree, which coupled a Node process to a React/Vite package. The bundle loader, the eight validation checks, the EventIndex and file reconstruction, and the per- and cross-submission heuristics now live here, in one isomorphic package that both consumers import by name.\n\nThe payoff is that a bundle analyzed offline in the browser’s /local route and the same bundle ingested by the server run identical code (same checks, same heuristics, same flags), so there is no “browser version” of the analysis to drift from the server’s. That only holds because the same ESLint no-restricted-imports rule that guards log-core guards analysis-core: no vscode, no Node-only APIs. DOM globals that exist in both runtimes (Blob, ArrayBuffer) are allowed; anything that exists in only one is not.',
    invariant:
      'analysis-core stays isomorphic (no vscode, no node:*) enforced by ESLint so the browser and the server run the same analysis. The server imports it; it never reaches back into the analyzer’s source.',
    links: [
      { label: 'index.ts', href: `${GH}/packages/analysis-core/src/index.ts` },
      { label: 'eslint.config.mjs', href: `${GH}/eslint.config.mjs` },
    ],
  },
  vectors: {
    title: 'Conformance vectors',
    body: 'The vectors are the machine-checkable form of “same format”. tools/export-conformance-vectors.ts derives them from log-core’s own primitives (hash chain, ed25519, session-key encryption, signed manifests and checkpoints, a golden sealed bundle, and the recorder’s paste and external-change payload builders) and writes them into the sibling repos’ conformance suites, which read the files and assert byte-for-byte agreement.\n\nByte-for-byte is not pedantry here. Because the manifest is ed25519-signed over its JCS-canonical bytes, a port that orders keys differently, formats a number differently, or drops a millisecond from a wall-clock string produces a manifest that will not verify against the course key: the recorder would run and the analyzer would reject every bundle it sealed. The vectors are generated from fixed seeds, so re-running the exporter reproduces the committed fixtures exactly; that reproducibility is itself the drift check that the export stays faithful.',
    invariant:
      'A port MUST reproduce the vectors byte-for-byte. A failing conformance run means the implementation is wrong; the vector is never edited to make it pass.',
    links: [
      {
        label: 'export-conformance-vectors.ts',
        href: `${GH}/tools/export-conformance-vectors.ts`,
      },
      { label: 'hash-chain.test.ts', href: `${GH}/packages/log-core/src/hash-chain.test.ts` },
    ],
  },
  allow: {
    title: 'known-good-extension-hashes.json',
    body: 'The allowlist is producer-agnostic by construction, and that is the point of it. extension_hash is not a hash of a .vsix or a plugin .zip as a file; it is a SHA-256 over the recorder’s installed distribution file tree, computed by walking sorted relative paths and hashing “<path>\\0<bytes>” per file. A VS Code dist/, a JetBrains plugin tree and a Neovim lua/ source tree all run the same algorithm, so their hashes are the same kind of value and share one flat list.\n\nnpm run update-hashes refreshes it after every recorder release, but only the VS Code build is automated from this repo: the JetBrains and Neovim hashes are computed in their own repos (there is no JVM or Lua toolchain here) and added with --hash. A bundle whose hash is absent is not failed: the extension_hash_mismatch heuristic raises a medium-severity flag, because a miss is as likely to mean “staff have not published the new build’s hash yet” as it is to mean a modified recorder.',
    invariant:
      'extension_hash is a tree-hash over the installed distribution, not a hash of a packaged archive, so a single allowlist covers every recorder, in any language.',
    links: [
      {
        label: 'known-good-extension-hashes.json',
        href: `${GH}/packages/analysis-core/src/heuristics/config/known-good-extension-hashes.json`,
      },
      {
        label: 'update-extension-hash-allowlist.mjs',
        href: `${GH}/scripts/update-extension-hash-allowlist.mjs`,
      },
    ],
  },
  server: {
    title: 'server',
    body: 'In this graph the server is one of the two consumers of analysis-core, and the ecosystem-level fact about it is what it is not allowed to depend on. It imports log-core, shared and analysis-core; it must never import recorder or analyzer source. That prohibition is the whole reason analysis-core was carved out: the server once reached into the analyzer’s tree, and this boundary is what now forbids the coupling.\n\nIts internals (Hono, Drizzle, pg-boss, S3 ingest) belong to the pipeline diagram. Here it is enough that it runs the shared engine in Node over an uploaded bundle and persists the results.',
    invariant:
      'The server depends only on log-core, shared and analysis-core, never on recorder or analyzer source.',
    links: [
      { label: 'index.ts', href: `${GH}/packages/server/src/index.ts` },
      { label: 'CLAUDE.md — architecture rules', href: `${GH}/CLAUDE.md` },
    ],
  },
  analyzer: {
    title: 'analyzer',
    body: 'The analyzer is the other consumer of analysis-core, and its /local route is the concrete proof that the isomorphism buys something: dropped a .zip, it loads and analyzes a bundle entirely in the browser tab, running the same analysis-core build the server runs in Node, with no server round-trip at all. Everything else goes through the API defined in shared.\n\nLike the server it depends on log-core, shared and analysis-core, and on nothing from the recorder or the server’s own source. What it adds is the React/Vite UI (cohort list, per-submission drill-in, replay, the tuning sliders) over an engine it shares rather than owns.',
    links: [
      { label: 'LocalShell.tsx', href: `${GH}/packages/analyzer/src/views/local/LocalShell.tsx` },
      { label: 'analysis-core', href: `${GH}/packages/analysis-core/src/index.ts` },
    ],
  },
  rule: {
    title: 'Format change = a signed cross-repo decision',
    body: 'This note is the governance rule that ties the four repos together: the log format is owned by the monorepo, and a change to it is never made unilaterally in a sibling to make an implementation easier. The reason it cannot be local is mechanical, not political. The format is pinned by test vectors and the manifest is ed25519-signed over canonical bytes, so a change touches signature validity and every port at once.\n\nPropagation has a fixed shape. A real change lands in log-core, tools/export-conformance-vectors.ts is re-run, and the regenerated vectors are re-committed into the Kotlin and Lua conformance suites, which then fail until those ports are updated to match. That is why “rename the session.start.vscode field” is an approval-gated monorepo decision rather than a five-minute edit in a recorder: the field is signed, and three implementations plus the analyzer would have to move together.',
    invariant:
      'A format change is a cross-repo, signature-affecting, vector-pinned decision owned by the monorepo, never made in a sibling repo to ease an implementation.',
    links: [
      {
        label: 'export-conformance-vectors.ts',
        href: `${GH}/tools/export-conformance-vectors.ts`,
      },
      { label: 'hash-chain.test.ts', href: `${GH}/packages/log-core/src/hash-chain.test.ts` },
    ],
  },

  // ── REPO 2 · provjet — Kotlin / Gradle ────────────────────────────────────
  jcore: {
    title: 'provjet · core/ · the Kotlin port',
    body: 'core/ is a second implementation of log-core’s format in pure Kotlin, with no IntelliJ Platform imports, so the conformance surface stays testable in isolation exactly as log-core’s does. Every primitive is re-derived (HashChain.kt, the envelope, SessionKeys.kt, Checkpoint.kt) including DirectoryHash.kt, which reproduces the extension-hash tree walk rather than hashing the packaged plugin as a file.\n\nJCS canonicalization is the subtle part and is not hand-rolled: it uses erdtman/java-json-canonicalization, the JVM twin of the canonicalize npm library log-core uses: same author, same algorithm. One deliberate non-change is the session.start.vscode object: the port fills it with editor-generic values (IDE version, empty commit, OS) rather than renaming it, because renaming a signed field would be a format change owned by the monorepo, not a local convenience.',
    links: [
      {
        label: 'HashChain.kt (provjet)',
        href: `${GH_PROVJET}/core/src/main/kotlin/dev/provenance/core/HashChain.kt`,
      },
      { label: 'provjet CLAUDE.md', href: `${GH_PROVJET}/CLAUDE.md` },
    ],
  },
  jrec: {
    title: 'provjet · recorder/ · IntelliJ wiring',
    body: 'recorder/ is the host half: activation, the document/VFS/terminal/git listeners, three-signal paste detection, the session writer and the seal command, all against the IntelliJ Platform SDK. It is roughly seventy percent of the work, and none of it touches the format: producer identity is carried in session.start.recorder.extension_id, so the analyzer tells hosts apart with no format change.\n\nThe reason a port is real work rather than a translation is that VS Code’s and IntelliJ’s APIs do not map one-to-one. External-change detection is the sharp edge: IntelliJ’s VFS is a cached layer that refreshes on window focus, so the expected-content model is the truth and the on-disk hash is what it is compared against, and getting that direction wrong is easy when the VFS itself decides late that a file changed.',
    links: [
      {
        label: 'ManifestActivation.kt (provjet)',
        href: `${GH_PROVJET}/recorder/src/main/kotlin/dev/provenance/recorder/activation/ManifestActivation.kt`,
      },
      { label: 'Recorder PRD §4.5', href: `${GH}/docs/prd.md` },
    ],
  },

  // ── REPO 3 · provnvim — Lua ────────────────────────────────────────────────
  ncore: {
    title: 'provnvim · core/ · the Lua port',
    body: 'core/ is the third implementation of the format, in pure Lua, gated by the same conformance vectors as the Kotlin port. It reuses one host primitive by design (SHA-256 is Neovim’s built-in vim.fn.sha256) while the rest (hash_chain.lua, session_keys.lua, checkpoint.lua, the JCS canonicalizer) is ported code held to byte parity.\n\nLua’s numbers help here: they are IEEE-754 doubles like JavaScript’s, so number formatting is a close match rather than a reimplementation hazard, but whitespace, key ordering and representation are still pinned by the vectors and not eyeballed. Like the Kotlin port it fills the session.start.vscode object with editor-generic values instead of renaming a signed field.',
    links: [
      {
        label: 'hash_chain.lua (provnvim)',
        href: `${GH_PROVNVIM}/lua/provenance/core/hash_chain.lua`,
      },
      { label: 'provnvim CLAUDE.md', href: `${GH_PROVNVIM}/CLAUDE.md` },
    ],
  },
  nrec: {
    title: 'provnvim · recorder/ · Neovim wiring',
    body: 'recorder/ wires the Lua core to Neovim: activation off a verified manifest, buffer/autocmd/paste/external-change/terminal/git listeners, the session registry and the seal command. As with the JetBrains port the format is untouched and the wiring is where the editor-specific ambiguity lives.\n\nExternal-change detection is again the hardest item, for the same structural reason in a different shape: Neovim learns about on-disk changes lazily, via FileChangedShell on focus-gain or an explicit :checktime, not the instant a file changes. One cross-port lesson is baked in here: provjet shipped a wall-clock formatter that dropped the milliseconds when they were zero, which broke the analyzer’s monotonic-wall check, so the Lua port formats wall times to fixed width. That is the kind of bug conformance parity exists to catch.',
    links: [
      {
        label: 'activation.lua (provnvim)',
        href: `${GH_PROVNVIM}/lua/provenance/recorder/activation.lua`,
      },
      { label: 'Recorder PRD §4.5', href: `${GH}/docs/prd.md` },
    ],
  },
  nvend: {
    title: 'provnvim · vendor/ · vendored crypto',
    body: 'The keystone decision of the Neovim port is pure-Lua, zero native dependencies: no FFI, no libsodium, no compiled sidecar. SHA-256 comes from Neovim’s builtin and file I/O from vim.uv, but ed25519 and XChaCha20-Poly1305 have no builtin, so readable pure-Lua implementations are vendored here rather than written from scratch. Correctness is proven against the conformance suite regardless of where the code came from.\n\nNative crypto is refused on purpose. An FFI-to-libsodium path would reintroduce the per-platform distribution fragility the design avoids and would undercut the auditability the recorder is required to keep: students are meant to be able to read the whole tool. Vendoring is gated on licensing: in the same commit that adds a component, THIRD-PARTY-NOTICES.txt gains its upstream, version and full license text, or the component does not land.',
    invariant:
      'No native crypto dependency: ed25519 and XChaCha20-Poly1305 are vendored pure Lua. Anything vendored carries a THIRD-PARTY-NOTICES entry in the same commit.',
    links: [
      {
        label: 'ed25519.lua (provnvim)',
        href: `${GH_PROVNVIM}/lua/provenance/vendor/ed25519.lua`,
      },
      {
        label: 'THIRD-PARTY-NOTICES.txt (provnvim)',
        href: `${GH_PROVNVIM}/THIRD-PARTY-NOTICES.txt`,
      },
    ],
  },

  // ── REPO 4 · provgate — Python / uv ────────────────────────────────────────
  gapi: {
    title: 'provgate · provenance/ · the API client',
    body: 'provgate is a separate Python service that holds no Provenance code, database or storage; provenance/ is the only module that knows the server’s HTTP shape, and it depends on exactly three public behaviours: POST an ingest:gradescope export, poll the returned job to a terminal state, and rely on the server’s content-hash dedup. No assignment id is ever sent: the server derives assignment identity and roster from the export’s metadata and each bundle’s signed manifest.\n\nBecause that surface is so narrow, adding the gateway required no change to the server at all: the diagram draws the edge back-to-front deliberately, since provgate calls the same public API any third-party tool would. If any of the three behaviours appears to have changed, the contract is the server’s to change, not the gateway’s to work around.',
    links: [
      { label: 'client.py (provgate)', href: `${GH_PROVGATE}/src/provgate/provenance/client.py` },
      { label: 'provgate CLAUDE.md', href: `${GH_PROVGATE}/CLAUDE.md` },
    ],
  },
  gsync: {
    title: 'provgate · sync / store / notify',
    body: 'This is the gateway’s core, and its dependencies point inward: a frontend depends on it, it depends on no frontend. sync/ orchestrates each class through per-assignment delta computation and ZIP pruning as pure functions over in-memory bytes; store/ is the only place SQLite and secret encryption live; notify/ is a best-effort webhook that can fail without touching sync correctness.\n\nThe load-bearing rule is that incrementality comes from pruning submission folders, never from rewriting Gradescope’s metadata. The pruned export carries submission_metadata.yml byte-for-byte unchanged, because a regenerated metadata file is a second source of truth that can disagree with the first. The per-assignment watermark is only an optimisation (if it is wrong the server’s dedup still prevents duplicate submissions), so correctness lives on the server side where it belongs.',
    links: [
      { label: 'prune.py (provgate)', href: `${GH_PROVGATE}/src/provgate/sync/prune.py` },
      { label: 'provgate CLAUDE.md', href: `${GH_PROVGATE}/CLAUDE.md` },
    ],
  },
  gweb: {
    title: 'provgate · web/ · reserved',
    body: 'web/ does not exist. It is drawn to show the seam it would attach to: the core is layered so that a frontend is a thin thing depending on sync and store, and today cli/ is the only such frontend. A future web GUI would reuse store and sync unchanged and add no sync logic of its own.\n\nThe value of naming the reserved slot is that it constrains the present. The rule “frontends depend on core, core never depends on a frontend” is what keeps the CLI from accreting orchestration a second frontend would then have to duplicate or fight: the boundary is maintained now precisely so the reserved frontend can stay a drop-in later.',
    links: [{ label: 'provgate CLAUDE.md', href: `${GH_PROVGATE}/CLAUDE.md` }],
  },
  e2e: {
    title: 'The per-repo end-to-end gates',
    body: 'The conformance vectors prove the PRIMITIVES agree — a hash, a signature, one canonical payload. They cannot prove that a whole archive a recorder produces is one the analyzer will accept, because that depends on filenames, on pairing, on entry order, on what the seal step chose to include, and on a dozen decisions the vectors never touch.\n\nSo each recorder repo runs its own gate: build a real bundle with the real recorder, then drive it through the real monorepo loadBundle and runValidation. All three exist now, and the argument for them is not theoretical. Every one has already caught a defect the producing repo\u2019s own suite asserted was impossible: provnvim\u2019s found an orphaned rolling seal, provjet\u2019s found that shipping code the log had never seen left the Gradle suite BUILD SUCCESSFUL while the gate went red, and the VS Code one found the seal path packing bundles the loader could not open.\n\nThat is the same argument as the tools/ composition gates, applied across repository boundaries instead of across package boundaries. Two green suites either side of a seam prove nothing about the seam \u2014 and a recorder repo\u2019s suite is, by construction, entirely on one side of it.',
    invariant:
      'A recorder is conformant when a bundle it really produced passes the real loader and the real checks. Green vectors are necessary and are not sufficient.',
    links: [
      { label: 'unzip.ts', href: `${GH}/packages/analysis-core/src/loader/unzip.ts` },
      {
        label: 'run-validation.ts',
        href: `${GH}/packages/analysis-core/src/validation/run-validation.ts`,
      },
    ],
  },
  tgates: {
    title: 'tools/ — the composition gates',
    body: 'tools/ has no package.json, and that is what makes it useful rather than what makes it untidy. Because it is not a workspace, importing from it creates no dependency edge, so it is the one place in the repo allowed to span both dependency graphs and drive a real producer through a real consumer. Unit tests on either side of a contract can both pass while the contract itself is broken; these gates are what catch that.\n\nThree of them run today. The recorder-seal gate drives a real recorder seal through the real analyzer loader. The enrollment-paste gate drives what the recorder prints through what the /enroll page accepts, which is the pairing that a marker prefix on one side and a parser on the other would otherwise let drift apart silently. And the manifest-composer gate spawns the real sign-manifest.ts CLI as a subprocess over a real temp file and compares octets against what the browser composer produces — byte for byte, at 2.0 and at 1.0, including the signature and the trailing newline. That last one exists because the composer is signed-format code living inside a UI package, which is exactly where a second implementation of a signing contract goes unnoticed.\n\nThe trap worth knowing: these run under npm run test:tools, NOT under npm run test. The root test script is --workspaces, and tools/ is not a workspace, so for a long time these suites ran under nothing at all — sixty-two tests executing in no CI job. A root vitest config now scopes a bare run to tools/** deliberately, so that an unqualified vitest cannot wander into the server’s testcontainers suites.',
    invariant:
      'A cross-repo or cross-package format contract is proven by driving a real producer through a real consumer. Two green unit suites either side of a seam prove nothing about the seam.',
    links: [
      {
        label: 'manifest-composer-conformance.test.ts',
        href: `${GH}/tools/manifest-composer-conformance.test.ts`,
      },
      {
        label: 'recorder-seal-conformance.test.ts',
        href: `${GH}/tools/recorder-seal-conformance.test.ts`,
      },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [];
