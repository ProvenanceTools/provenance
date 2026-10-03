# Provenance Analyzer

The Analyzer v3 SPA — the course-staff web app for reviewing Provenance Recorder logs at
cohort scale. It validates tamper-evident bundles, scores them with tunable heuristics, and
lets staff drill into any submission's timeline, replay, and validation. The full app is
backed by the [`@provenance/server`](../server) API; it also ships a standalone in-browser
mode for inspecting one-off bundles with no server.

## What it does

**Server-backed (the main flow).** Staff sign in with Google (OAuth, hosted-domain
restricted), pick a semester, and work a cohort:

- **Ingest** — upload a Gradescope export; the server parses, matches students, scores
  heuristics, and runs cross-submission detection. An unmatched tray catches non-matching
  files; a roster view manages students.
- **Cohort list** — virtualized, filterable, sortable table of every submission with its
  flags and stats; export to CSV.
- **Per-submission drill-in** — overview, a searchable **timeline** of editing events, a
  Monaco-based **replay** with transport controls and paste/external-change gutter
  decorations, and the bundle **validation** report.
- **Heuristics tuning** — a 25-flag UI to adjust each flag's **weight** (0.0–2.0) and
  toggle it on/off, dry-run the diff, and recompute. (These are scoring weights, not
  the heuristics' own detection thresholds, which live in
  `analysis-core/heuristics/config.ts`.)
- **Cross-flags** — a semester-wide view of shared-paste and editing-pattern-clone findings
  across students.

Per-submission heuristics include large pastes, external edits, suspicious typing patterns,
and chain breaks; the cross-submission pass detects shared paste content and editing-pattern
clones.

**Standalone `/local` mode.** Drop one or more `.zip` bundles and inspect them entirely
in-browser — no auth, no server, no data leaves the machine. This is the preserved v2
"drop a zip" UX (load / overview / timeline / replay / compare), useful for a quick one-off
look without standing up the backend.

## Development

```sh
npm run dev --workspace=packages/analyzer
```

Opens the Vite dev server at `http://localhost:5173`.

This is the v3 SPA: Google sign-in and the cohort / per-submission views talk to the
API server, so run the backend too. [`docs/dev-setup.md`](../../docs/dev-setup.md) covers the
full setup (server, OAuth client, dev keys, seed data).

For a flow that keeps bundle data in the browser, open `http://localhost:5173/local/load` and
drop a `.zip` bundle. The offline mode (`/local`) runs entirely in-browser, but you still have to
be signed in as staff, so the server must be running.

## Build

```sh
npm run build --workspace=packages/analyzer
```

Produces static assets in `packages/analyzer/dist/`. Type-checks and bundles in one step (`tsc --noEmit && vite build`). Run `npm run lint --workspace=packages/analyzer` separately for lint.

## Hosting

The analyzer is a static single-page app (SPA) that works at any URL prefix. Deploy `packages/analyzer/dist/` to any static host:

```sh
# Local preview
npx serve packages/analyzer/dist

# AWS S3
aws s3 sync packages/analyzer/dist/ s3://your-bucket/analyzer/

# Vercel / Netlify
vercel deploy packages/analyzer/dist
```

The build is configured with `base: './'`, so relative asset paths work regardless of where you mount it.

Because the analyzer uses HTML5 history-API routing, your static host must rewrite all non-asset paths to `index.html` (single-page-app fallback). Direct navigation to `https://host/sub/overview` returns 404 on a vanilla static host without this rewrite. Examples: GitHub Pages — add a `404.html` redirect; Netlify — add `/* /index.html 200` to `_redirects`; Vercel — automatic; nginx — `try_files $uri /index.html;`.

## Test fixture

To test against a real-recorder session, see `packages/analyzer/test/integration/regenerate-fixture.md`. The integration tests expect `packages/analyzer/test/fixtures/sample-bundle.zip` to exist and skip gracefully if it doesn't.

## Architecture

- **React 18 + TypeScript** — UI runtime with strict mode.
- **Vite** — bundler and dev server.
- **Tailwind + shadcn/ui** — styling and accessible component primitives.
- **react-router-dom** — semester-scoped routes (`/home`, `/s/:semester`, per-submission
  drill-in, `/s/:semester/ingest` · `/roster` · `/members` · `/assignments`) plus a
  standalone `/local/*` subtree (load / overview / timeline / replay / compare, no auth).
  Legacy `/load`, `/overview`, … redirect into `/local/*`.
- **TanStack Query** — server state / API caching for the v3 flow.
- `@provenance/shared` — Zod API schemas shared with the server.
- `@provenance/log-core` — shared event types, validation, and hash chain. Runs unmodified in the browser.

## Learn more

- **Product spec** → [`docs/analyzer-v3-prd.md`](../../docs/analyzer-v3-prd.md) (the analyzer + server v3 spec)
- **Design doc** → [`docs/analyzer-v3-design.md`](../../docs/analyzer-v3-design.md)
- **Repo conventions** → [`CLAUDE.md`](../../CLAUDE.md)
- **Build plan** → [`docs/analyzer-v3-implementation-plan.md`](../../docs/analyzer-v3-implementation-plan.md)
