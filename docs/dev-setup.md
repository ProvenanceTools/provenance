# Developer setup

This is the single source of truth for setting up Provenance for development. It starts from a
blank computer and ends with the whole system running locally: the API server and worker, the
analyzer web app, and the VS Code recorder, with a recording you made yourself loaded into the
analyzer. If another document disagrees with this one about setup, this one wins; please fix the
other document.

Budget about an hour the first time. Most of that is installs and the Google OAuth client.

Every step ends with a ✅ check. Do not move on until it passes: most setup pain comes from a
step that quietly failed three steps earlier. If something goes wrong, look in
[Troubleshooting](#troubleshooting) first.

The steps are written for **macOS** and **Debian/Ubuntu Linux**. Windows is not covered yet; if
you set up on Windows (WSL2 is the likely route), please add what you learned here.

## Contents

1. [What you are setting up](#1-what-you-are-setting-up)
2. [Install system tools](#2-install-system-tools)
3. [Get the code](#3-get-the-code)
4. [Install dependencies and build](#4-install-dependencies-and-build)
5. [Create your dev keys](#5-create-your-dev-keys)
6. [Start Postgres and RustFS](#6-start-postgres-and-rustfs)
7. [Create a Google OAuth client](#7-create-a-google-oauth-client)
8. [Configure and start the server](#8-configure-and-start-the-server)
9. [Start the analyzer and sign in](#9-start-the-analyzer-and-sign-in)
10. [Load example data](#10-load-example-data)
11. [Record a session with the recorder](#11-record-a-session-with-the-recorder)
12. [Sign your own test assignment (optional)](#12-sign-your-own-test-assignment-optional)
13. [Run the checks](#13-run-the-checks)
14. [Day-to-day](#14-day-to-day)
15. [Troubleshooting](#troubleshooting)
16. [Other repositories](#other-repositories)

---

## 1. What you are setting up

| Piece                             | Runs as                            | Address                                 |
| --------------------------------- | ---------------------------------- | --------------------------------------- |
| Postgres 16                       | Docker container                   | `localhost:5432`                        |
| RustFS (S3-compatible blob store) | Docker container                   | `localhost:9000` (API), `:9001` console |
| Server: API + pg-boss worker      | `npm run dev` (Node, one process)  | `http://localhost:3000`                 |
| Analyzer (React SPA)              | `npm run dev` (Vite)               | `http://localhost:5173`                 |
| Recorder (VS Code extension)      | VS Code Extension Development Host | —                                       |

**Always use the analyzer at `http://localhost:5173`, never `:3000`.** Vite proxies `/api` to the
server, which keeps the browser on one origin so the session cookie works. The OAuth redirect
goes through `:5173` for the same reason (see [step 7](#7-create-a-google-oauth-client)).

The `compose.yaml` stack is for local development only. The test suites never use it: server
integration tests start their own throwaway Postgres and RustFS containers through
testcontainers.

## 2. Install system tools

You need:

| Tool                       | Version                  | Why                                                         |
| -------------------------- | ------------------------ | ----------------------------------------------------------- |
| git                        | any recent               |                                                             |
| Node.js + npm              | **Node 22**, npm 10+     | Everything. The key tools need Node ≥ 22.6.                 |
| Docker                     | Docker Desktop or Engine | Postgres + RustFS for dev; testcontainers for tests         |
| VS Code                    | ≥ 1.100                  | Running and debugging the recorder                          |
| Graphviz + Python 3        | any recent               | Only for regenerating the `/architecture` diagrams          |
| A Google Workspace account | e.g. `@berkeley.edu`     | Signing in to the analyzer. A personal Gmail will not work. |

### macOS

```sh
# Command-line developer tools (git, python3, make)
xcode-select --install

# Homebrew — follow the instructions it prints to add brew to your PATH
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node via nvm, so the repo's .nvmrc picks the version for you
brew install nvm
mkdir -p ~/.nvm
# Add the two lines `brew info nvm` prints to ~/.zshrc, then open a new terminal.

brew install --cask docker visual-studio-code
brew install graphviz
```

Open **Docker Desktop** once from Applications and let it finish starting. It has to be running
whenever you use the dev stack or run the tests.

### Debian / Ubuntu

```sh
sudo apt update
sudo apt install -y git curl build-essential python3 graphviz

# nvm — see https://github.com/nvm-sh/nvm for the current install line
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# open a new terminal

# Docker Engine: follow https://docs.docker.com/engine/install/ubuntu/, then let your user run
# docker without sudo and log out and back in:
sudo usermod -aG docker "$USER"

# VS Code: https://code.visualstudio.com/docs/setup/linux
```

### ✅ Check

```sh
git --version
docker run --rm hello-world   # prints "Hello from Docker!"
code --version                # 1.100 or newer
dot -V                        # optional; only needed for the architecture page
```

Use `docker run --rm hello-world` to check Docker, not `docker info`. Against a half-started
daemon, `docker info` can hang for minutes.

## 3. Get the code

Contributions come in through a fork (see [CONTRIBUTING.md](../CONTRIBUTING.md)). Fork
[ProvenanceTools/provenance](https://github.com/ProvenanceTools/provenance) on GitHub, then:

```sh
git clone git@github.com:<your-github-user>/provenance.git
cd provenance
git remote add upstream https://github.com/ProvenanceTools/provenance.git
```

Install the Node version pinned in `.nvmrc`:

```sh
nvm install   # reads .nvmrc
nvm use
```

### ✅ Check

```sh
node --version          # v22.x
git remote -v           # origin = your fork, upstream = ProvenanceTools
```

## 4. Install dependencies and build

From the repo root:

```sh
npm ci
npm run build
```

Use `npm ci`, not `npm install`. It installs exactly what `package-lock.json` says and does not
rewrite the lockfile.

`npm run build` is **required before anything else**, not just before tests. The shared packages
(`log-core`, `shared`, `analysis-core`) are consumed from their built `dist/` folders, which are
git-ignored. Until you build, the analyzer fails with `imported but could not be resolved`, and
`npm run typecheck` reports errors that are not real. Re-run it whenever you pull changes to those
packages.

### ✅ Check

`npm run build` exits without errors, and `packages/log-core/dist/` exists.

## 5. Create your dev keys

Provenance signs everything with ed25519 keys arranged in a trust chain:

```
root key ──signs──▶ course_cert ──authorizes──▶ course key ──signs──▶ .provenance-manifest
    └─────signs──▶ institution_cert ──authorizes──▶ institution key ──signs──▶ student credentials
```

The recorder trusts exactly one **root public key**, compiled into it. A dev build of the recorder
embeds the **dev root key**, so everything you sign locally has to chain to that dev root. You
cannot use a root key you generated yourself, because the dev recorder would not trust it.

The dev root key and the dev course key are **deliberately public**: their private halves are
checked into `packages/recorder/src/activation/manifest-loader.test.ts`. They protect nothing and
must never be used for a real deployment. Real keys are covered in
[`key-management.md`](key-management.md).

You need:

| Key                                           | Where it goes                                            | Used for                                                                       |
| --------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Dev root keypair                              | `.notes/dev-root-keypair.json`                           | Minting certs below; the key tools look here by default                        |
| Dev course keypair + `course_cert`            | `.notes/dev-keypair.json`, `.notes/dev-course-cert.json` | Signing test manifests ([step 12](#12-sign-your-own-test-assignment-optional)) |
| Your institution keypair + `institution_cert` | `~/.provenance-dev/`                                     | Issuing enrollment credentials (the `/enroll` page)                            |

`.notes/` is git-ignored. The institution key goes outside the repo because the key generator
refuses to write a private key inside it.

### 5.1 Dev root and course keys

This copies the two published dev keypairs into `.notes/`, where the key tools expect them:

```sh
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const dir = 'packages/recorder/src/activation/';
const pick = (file, name) =>
  readFileSync(dir + file, 'utf8').match(new RegExp(`${name}\\s*=\\s*'([0-9a-f]{64})'`))[1];
const note = 'DEV key, deliberately public. NEVER use for a real deployment.';
const write = (path, value) =>
  writeFileSync(path, JSON.stringify({ ...value, note }, null, 2) + '\n', { mode: 0o600 });
mkdirSync('.notes', { recursive: true });
write('.notes/dev-root-keypair.json', {
  public_key_hex: pick('root-public-key.ts', 'ROOT_PUBLIC_KEY_HEX'),
  private_key_hex: pick('manifest-loader.test.ts', 'DEV_ROOT_PRIVATE_KEY_HEX'),
});
write('.notes/dev-keypair.json', {
  public_key_hex: pick('legacy-course-public-key.ts', 'LEGACY_COURSE_PUBLIC_KEY_HEX'),
  private_key_hex: pick('manifest-loader.test.ts', 'DEV_LEGACY_COURSE_PRIVATE_KEY_HEX'),
});
console.log('wrote .notes/dev-root-keypair.json and .notes/dev-keypair.json');
EOF
```

Then mint a `course_cert` for the dev course, signed by the dev root and valid for a year:

```sh
FROM=$(node -p 'new Date().toISOString().slice(0, 10)')
UNTIL=$(node -p 'new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10)')

npm run -s mint:course-cert -- \
  --course-id dev-course \
  --course-pubkey "$(node -p "require('./.notes/dev-keypair.json').public_key_hex")" \
  --valid-from "$FROM" --valid-until "$UNTIL" \
  --out .notes/dev-course-cert.json
```

### 5.2 Institution key (for enrollment)

Students enroll by pasting a public key into the analyzer's `/enroll` page. The server signs a
credential for them with the **institution key**. Without one, `/enroll` fails with
`503 no_institution_key`. In production the institution key is the only private key the server
holds. For dev, generate your own and certify it with the dev root:

```sh
mkdir -p ~/.provenance-dev
INST_PUB=$(npm run -s keygen:course -- ~/.provenance-dev/institution-keypair.json)

npm run -s mint:institution-cert -- \
  --institution-id dev --institution-pubkey "$INST_PUB" \
  --valid-from "$FROM" --valid-until "$UNTIL" \
  --out ~/.provenance-dev/institution-cert.json
```

`keygen:course` is the generic ed25519 keypair generator. Pass it only the output path: adding
`--course-id` would mint a _course_ cert instead. It refuses to overwrite an existing file, so to
start over, delete `~/.provenance-dev/institution-keypair.json` first. If you open a new terminal
between 5.1 and 5.2, re-run the `FROM=` / `UNTIL=` lines.

### ✅ Check

```sh
ls .notes/                 # dev-course-cert.json  dev-keypair.json  dev-root-keypair.json
ls ~/.provenance-dev/      # institution-cert.json  institution-keypair.json
```

Both mint commands print the certificate they wrote and finish without an error. The
institution key is written into the server config in [step 8](#8-configure-and-start-the-server).

## 6. Start Postgres and RustFS

```sh
docker compose up -d --wait
```

Then create the storage bucket. This is a one-time step: without the bucket, every upload fails.
You can do it in the RustFS console or with the `rc` CLI:

- **Console:** open **http://localhost:9001/rustfs/console/** (include the path: the bare `:9001`
  returns 403). Sign in as `rustfsadmin` / `rustfsadmin` and create a bucket named `provenance`.
- **CLI:** install `rc` (macOS: `brew install rustfs/tap/rc`; elsewhere see
  [the RustFS docs](https://docs.rustfs.com/en/operations/rc)), then:

  ```sh
  rc alias set local http://localhost:9000 rustfsadmin rustfsadmin --region us-east-1 --bucket-lookup path
  rc bucket create local/provenance
  ```

The data lives in Docker volumes and survives `docker compose down`. To wipe it, use
`docker compose down -v`, then re-create the bucket and re-run the migrations.

### ✅ Check

```sh
docker compose ps   # postgres and rustfs both "healthy"
```

The `provenance` bucket shows up in the RustFS console.

## 7. Create a Google OAuth client

The analyzer uses Google sign-in, and it only accepts accounts in an allowed Google Workspace
domain (`AUTH_ALLOWED_HOSTED_DOMAINS`, default `berkeley.edu`). That check runs on the `hd` claim,
which personal Gmail accounts do not have, so you need a Workspace account. Every staff page,
including the offline `/local` mode, requires sign-in, so you cannot skip this step.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project, e.g.
   `provenance-dev-<you>`.
2. **APIs & Services → OAuth consent screen.** Choose **Internal** if the project belongs to your
   Workspace organization. Otherwise choose **External**, leave it in **Testing**, and add your
   Workspace address under **Test users**. The only scopes needed are `openid`, `email` and
   `profile`.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type
   **Web application**.
4. **Authorized JavaScript origins:** `http://localhost:5173`
5. **Authorized redirect URIs:** exactly `http://localhost:5173/api/v1/auth/google/callback`
6. Create it and copy the **Client ID** and **Client secret**.

The redirect URI must use `:5173`, the analyzer, not `:3000`. The server builds it as
`${PUBLIC_BASE_URL}/api/v1/auth/google/callback`, and in dev `PUBLIC_BASE_URL` points at the
analyzer so you land back in the app after signing in.

## 8. Configure and start the server

```sh
cp packages/server/.env.example packages/server/.env
```

Open `packages/server/.env` and set:

| Variable                         | Value                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`                | `http://localhost:5173` (the template already has this)                                     |
| `GOOGLE_OAUTH_CLIENT_ID`         | from step 7                                                                                 |
| `GOOGLE_OAUTH_CLIENT_SECRET`     | from step 7                                                                                 |
| `AUTH_SUPERADMIN_EMAILS`         | `["you@berkeley.edu"]` (a JSON array) so you can see everything                             |
| `AUTH_ALLOWED_HOSTED_DOMAINS`    | leave `["berkeley.edu"]` unless your account is on another domain                           |
| `PROVENANCE_ROOT_PUBLIC_KEY_HEX` | the dev root public key: `80051f5bdb9064e0768bf2fca5cc9a4ee888502ab45472e0c6d0f4f704de4499` |

Everything else already matches the compose stack. Both auth lists are **JSON arrays**, not
comma-separated values.

Then add the institution key from step 5.2. It is one line of JSON:

```sh
node -e '
const fs = require("fs"), home = require("os").homedir() + "/.provenance-dev/";
const key = JSON.parse(fs.readFileSync(home + "institution-keypair.json", "utf8"));
const cert = JSON.parse(fs.readFileSync(home + "institution-cert.json", "utf8"));
console.log("PROVENANCE_INSTITUTION_KEY=" + JSON.stringify({ private_key_hex: key.private_key_hex, cert }));
' >> packages/server/.env
```

Do not leave an empty `PROVENANCE_INSTITUTION_KEY=` line: an empty value is a parse error and the
server will refuse to boot. The template keeps it commented out for that reason.

Apply the database migrations and start the server:

```sh
npm run db:migrate --workspace=packages/server
npm run dev --workspace=packages/server
```

`npm run dev` runs the API **and** the background worker in one process (`--mode=all`), so
uploads actually get ingested. Leave it running in its own terminal. It reloads on code changes,
but **not** on `.env` changes: restart it after editing `.env`.

### ✅ Check

```sh
curl localhost:3000/healthz   # {"status":"ok"}
```

The OpenAPI docs are at http://localhost:3000/api/v1/docs.

## 9. Start the analyzer and sign in

Give the analyzer the dev root public key too, so its in-browser validation can verify manifest
signatures:

```sh
echo 'VITE_ROOT_PUBLIC_KEY_HEX=80051f5bdb9064e0768bf2fca5cc9a4ee888502ab45472e0c6d0f4f704de4499' > packages/analyzer/.env
npm run dev --workspace=packages/analyzer
```

Leave it running in a second terminal and open **http://localhost:5173**. Sign in with the
account you put in `AUTH_SUPERADMIN_EMAILS`.

### ✅ Check

- After signing in you are back on `localhost:5173`, not `:3000`.
- You can open http://localhost:5173/admin (superadmin only).

## 10. Load example data

This step is optional, but it gives you a realistic cohort to click around in:

```sh
npm run seed --workspace=packages/server
```

The seed script generates a Gradescope export of about 700 students across three assignments,
with a deliberate spread of paste and cross-submission flags. It runs the export through the real
ingest pipeline into a `seed-demo` semester. This takes a few minutes. The script starts its own
worker, so the dev server does not have to be running. Re-running it does nothing once the
semester is populated. Details and the `--regenerate` flag are in
[`packages/server/README.md`](../packages/server/README.md#seeding-example-data).

### ✅ Check

The `seed-demo` semester appears on http://localhost:5173/home, and its cohort list fills in.

## 11. Record a session with the recorder

1. Open the repo root in VS Code and choose **Run and Debug → Run Recorder Extension**, or press
   F5 (Fn+F5 on most Mac laptops). The launch config builds the recorder first, then opens an
   **Extension Development Host** window on `test-workspace/`. That folder already contains a
   `.provenance-manifest` signed with the dev keys.
2. ✅ The status bar of the new window shows **Provenance: recording**, with a "not enrolled"
   marker until you finish the next step.
3. **Enroll.** In that window, run **Provenance: Show My Enrollment Key** from the command palette
   and copy the key. Open http://localhost:5173/enroll, paste it, and copy the credential the page
   returns. Back in VS Code, run **Provenance: Import Enrollment Token** and paste it in.
   ✅ The "not enrolled" marker goes away.
4. Edit `test-workspace/hw.py` for a minute: type, paste something, save.
5. Run **Provenance: Prepare Submission Bundle**. A sealed `.zip` is written next to the
   assignment folder, which here means the repo root. Do not commit it.
6. Open http://localhost:5173/local/load and drop the `.zip` in. ✅ The overview, timeline and
   replay show your session, and validation check 2 (the manifest chain) passes.

Your local recordings will raise an `extension_hash_mismatch` flag. That is expected: the
analyzer only trusts hashes of released recorder builds, and a dev build is not one. Do not add
your build's hash to `known-good-extension-hashes.json`.

To run the same bundle through the server pipeline instead of `/local`, create a course and
semester under http://localhost:5173/admin/courses and upload it on the semester's **Ingest**
page. Direct bundle uploads are matched against the semester roster, so upload a roster first or
expect the submission under **Unmatched**.

For what the recorder captures and why, see [`recorder.md`](recorder.md) and the recorder spec in
[`prd.md`](prd.md).

## 12. Sign your own test assignment (optional)

To test with a manifest other than `test-workspace/`'s, write an unsigned manifest into a folder
**outside** the repo, then sign it from the repo root:

```sh
mkdir -p ~/provenance-hw01
echo 'print("hello")' > ~/provenance-hw01/hw01.py
cat > ~/provenance-hw01/.provenance-manifest <<EOF
{
  "assignment_id": "hw01",
  "semester": "dev",
  "issued_at": "$(node -p 'new Date().toISOString()')",
  "course_id": "dev-course",
  "files_under_review": ["hw01.py"],
  "collaboration": "solo",
  "submission": "bundle",
  "scope": "directory",
  "policy": { "capture": {} },
  "ignore": [],
  "attachments": []
}
EOF

npm run sign:manifest -- ~/provenance-hw01/.provenance-manifest
```

All of those fields are required for a 2.0 manifest. `policy.capture: {}` means "capture
defaults". `issued_at` has to fall inside the course cert's validity window, which is why it is
stamped with the current time: otherwise the tool warns and validation check 2 flags the
manifest. `course_id` has to match the cert's. The full field rules are in the README's
[manifest signing section](../README.md#4-manifest-signing-per-assignment).

With no flags, the tool signs with `.notes/dev-keypair.json` and staples on
`.notes/dev-course-cert.json`. Before writing anything, it checks the whole chain back to the dev
root. Open the folder in the Extension Development Host (**File → Open Folder…** in that window)
to record against it.

The analyzer's `/compose/manifest` page builds the same manifest in the browser if you would
rather not write JSON by hand.

## 13. Run the checks

Run these before you open a PR. [CONTRIBUTING.md](../CONTRIBUTING.md) has the full list.

```sh
npm run build          # always first: typecheck and tests read the built dist/
npm run typecheck
npm run lint           # ESLint + Prettier check
npm run test           # every workspace; needs Docker running
npm run test:tools     # tools/ suites; not covered by `npm run test`
```

The full `npm run test` starts Postgres and RustFS containers for the server suite and takes a
while. While you iterate, run only the workspace you are changing:

```sh
npm run test --workspace=packages/analysis-core
```

More specialised checks:

| Command                                                  | When                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `npm run test:integration --workspace=packages/recorder` | Recorder changes. Downloads VS Code and runs a real extension host.  |
| `npm run bench --workspace=packages/recorder`            | Changes to the recorder's write path. p99 must stay well under 1 ms. |
| `python3 tools/architecture/build_diagrams.py`           | After editing `tools/architecture/dot/*.dot` (needs Graphviz).       |

## 14. Day-to-day

After pulling from `upstream`:

```sh
npm ci                                            # if package-lock.json changed
npm run build                                     # if any package changed, but just always do it
npm run db:migrate --workspace=packages/server    # if packages/server/db/migrations changed
```

Then start two terminals:

```sh
docker compose up -d --wait
npm run dev --workspace=packages/server      # terminal 1
npm run dev --workspace=packages/analyzer    # terminal 2
```

To reset all local data: `docker compose down -v`, then redo the bucket from
[step 6](#6-start-postgres-and-rustfs), the migrations, and (optionally) the seed.

## Troubleshooting

| Symptom                                                                                             | Cause and fix                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `imported but could not be resolved` in the analyzer, or typecheck errors in code you did not touch | The shared packages are not built, or are stale. Run `npm run build`.                                                                                                                            |
| `node: bad option: --experimental-strip-types`                                                      | Node is older than 22.6. Run `nvm use` in the repo root.                                                                                                                                         |
| `docker compose up` fails with "port is already allocated"                                          | Another stack holds 5432 or 9000. If it is an older checkout's compose project (one still running MinIO), run `docker compose down --remove-orphans` in this repo, or stop the other stack.      |
| RustFS console at `http://localhost:9001` returns 403                                               | Use the full path: http://localhost:9001/rustfs/console/                                                                                                                                         |
| Uploads or ingest fail with `NoSuchBucket` or a 404 from storage                                    | The `provenance` bucket was never created, or was wiped by `docker compose down -v`. Redo [step 6](#6-start-postgres-and-rustfs).                                                                |
| Server will not boot and the error mentions `PROVENANCE_INSTITUTION_KEY`                            | The line is present but empty or not valid JSON. Delete it or regenerate it as in [step 8](#8-configure-and-start-the-server).                                                                   |
| Google says `redirect_uri_mismatch`                                                                 | The OAuth client must list exactly `http://localhost:5173/api/v1/auth/google/callback`, and `PUBLIC_BASE_URL` must be `http://localhost:5173`. Restart the server after editing `.env`.          |
| After signing in you land on `localhost:3000` with a blank page or "Not Found"                      | `PUBLIC_BASE_URL` is set to `:3000`. Set it to `http://localhost:5173` and restart the server.                                                                                                   |
| `HOSTED_DOMAIN_MISMATCH`                                                                            | The account is a personal Gmail, or its domain is not in `AUTH_ALLOWED_HOSTED_DOMAINS`. Use a Workspace account, or add your domain to the JSON array.                                           |
| Signed in, but you see nothing and `/admin` or `/local` bounces you                                 | You are not a superadmin. Add your email to `AUTH_SUPERADMIN_EMAILS`, restart the server, then sign out and back in. Superadmin status is re-read at each login.                                 |
| `/enroll` fails with `503` and `no_institution_key`                                                 | No institution key is configured. Do [step 5.2](#52-institution-key-for-enrollment) and the institution-key part of [step 8](#8-configure-and-start-the-server).                                 |
| Validation check 2 shows **skipped**, so overall validation is `warn`                               | No root public key is configured: set `PROVENANCE_ROOT_PUBLIC_KEY_HEX` for the server, or `packages/analyzer/.env` for `/local`, then restart that process.                                      |
| The recorder does not start in the Extension Development Host                                       | Run `npm run build` from the repo root (the launch task builds only the recorder), and make sure the window opened `test-workspace/`. **Help → Toggle Developer Tools** shows activation errors. |
| `npm run test` shows server failures with `(HTTP code 500) server error` or 120 s timeouts          | Docker is wedged; these are testcontainers failing to reach the daemon, not real test failures. Restart Docker and confirm with `docker run --rm hello-world`.                                   |
| `sign:manifest` says `Manifest is missing required 2.0 field ...`                                   | Add that field. `policy`, `ignore` and `attachments` are all required. See [step 12](#12-sign-your-own-test-assignment-optional).                                                                |

If you hit something that is not in this table, add a row in the same PR as your fix.

## Other repositories

Provenance has three more repositories. Each one has its own setup:

- [provenance-jetbrains-recorder](https://github.com/ProvenanceTools/provenance-jetbrains-recorder)
  — the JetBrains IDE recorder (Kotlin/Gradle).
- [provenance-neovim-recorder](https://github.com/ProvenanceTools/provenance-neovim-recorder) —
  the Neovim recorder (Lua).
- [provenance-gradescope-gateway](https://github.com/ProvenanceTools/provenance-gradescope-gateway)
  — syncs Gradescope submissions into a Provenance server (Python).

Their recordings load into the analyzer from this repo exactly like the VS Code recorder's.
