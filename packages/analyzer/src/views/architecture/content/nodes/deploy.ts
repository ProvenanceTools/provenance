import type { ArchNode } from '../types.js';
import { GH, GH_PROVGATE } from './links.js';

/** Nodes in the `deploy` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Ingress ───────────────────────────────────────────────────────────────
  browser: {
    title: 'Course staff browser',
    body: 'The browser loads one origin and one origin only. On the apphost the server serves the built analyzer SPA (index.html, its assets, and the client-side router’s deep links) from the same hostname that answers /api/v1, so there is no separate static host, no CORS surface between the app and its API, and nothing second to deploy. A GET that resolves to a real asset is served as-is; anything else that is not under /api, /healthz or /metrics falls back to index.html so the SPA router can take the URL.\n\nEverything the reviewer sees past login is a request to this single origin, which is why the access story reduces to one check at the API rather than to network placement: the SPA is public bytes, and the data behind it is gated by the session the OAuth callback established.',
    links: [{ label: 'static.ts', href: `${GH}/packages/server/src/api/static.ts` }],
  },
  gwclient: {
    title: 'provgate',
    body: 'provgate does not run on the apphost. It runs wherever staff choose to schedule it (a laptop, a lab box, a cron host) because it is a pure HTTP client of the public API and needs no share of this deployment at all. It authenticates as a machine principal with an API token, over the same TLS-terminated hostname a browser uses, and POSTs each course’s pruned Gradescope export on its own cadence.\n\nPlacing it outside the trust boundary is deliberate: nothing about ingest depends on where the bytes came from. A token scoped to one semester can push submissions and nothing else, and if the gateway double-sends, content-hash dedup on the server absorbs it. The apphost therefore carries no gateway process, no gateway state, and no gateway failure mode.',
    links: [
      { label: 'provgate README', href: `${GH_PROVGATE}/README.md` },
      { label: 'tokens.ts', href: `${GH}/packages/server/src/auth/tokens.ts` },
    ],
  },
  prox: {
    title: 'apphost reverse proxy',
    body: 'The reverse proxy is nginx, and EECS Instructional operates it, not us. It terminates TLS at the campus edge and forwards cleartext HTTP to the app over a Unix socket, so the application process never handles a certificate and never sees a TCP port of its own. The public certificate, its renewal, and the proxy config all live on the IT side of the boundary.\n\nThat split is the largest external dependency of this deploy, which is why it is the first item on the coordination checklist: nginx’s config for the hostname must point at exactly the socket path the app creates, and the nginx worker (a different Unix user) must be able to connect to it. The runbook verifies this concretely on first deploy rather than trusting it, with an ls of the socket and a curl of /healthz through the public URL.',
    links: [
      { label: 'deploy-apphost.md', href: `${GH}/docs/deploy-apphost.md` },
      { label: 'listen.ts', href: `${GH}/packages/server/src/api/listen.ts` },
    ],
  },

  // ── Host — app container ──────────────────────────────────────────────────
  sock: {
    title: 'The Unix socket',
    body: 'Serving is over a Unix domain socket, not a TCP port, because that is the contract the apphost offers: each service gets a directory under /srv/appsockets and nginx proxies to a socket inside it. A port would have to be allocated, kept from colliding with every other tenant on a shared box, and firewalled off from direct reach; a socket sidesteps all three: it is a filesystem path, reachable only by processes that can see that path, and the only thing in front of it is the proxy.\n\nThe app owns two small pieces of making it work. It unlinks any stale socket a prior process left behind so listen() cannot fail with EADDRINUSE, and it chmods the socket world-writable, because nginx connects as a different user than the container-root that created it. SOCKET_PATH being set is also the switch that selects a socket over a port at all: unset, the server falls back to a TCP port for local dev and tests.',
    invariant:
      'SOCKET_PATH set means bind the socket; unset falls back to PORT. The socket is made 0o777 so the proxy, running as another user, can connect.',
    links: [
      { label: 'listen.ts', href: `${GH}/packages/server/src/api/listen.ts` },
      { label: 'deploy-apphost.md', href: `${GH}/docs/deploy-apphost.md` },
    ],
  },
  apic: {
    title: 'app container · mode=api',
    body: 'One image runs in three roles, and this is the api one: mode=api, the only role that binds the nginx-fronted socket. It carries the Hono app (OAuth, the versioned REST API, the OpenAPI + Redoc docs, the Prometheus /metrics endpoint) and it also serves the analyzer SPA from the same origin. It registers no pg-boss handlers; running jobs is the worker’s half.\n\nThe api process serves reads and the on-demand reconstruction cache rather than the ingest firehose, so a single replica is enough. The one-shot migrate service must have completed before it starts (it waits on that via compose’s service_completed_successfully) so an api container never races a schema migration.',
    links: [
      { label: 'compose.apphost.yaml', href: `${GH}/deploy/compose.apphost.yaml` },
      { label: 'static.ts', href: `${GH}/packages/server/src/api/static.ts` },
    ],
  },
  wrkc: {
    title: 'app container · mode=worker',
    body: 'The worker role runs mode=worker: the pg-boss subscriber and every cron handler, and nothing that listens on the socket. It is the half of the split that does the expensive work: unpacking exports, rebuilding bundles, and the per-file parse → validate → heuristics pass.\n\nIts throughput scales with the number of worker processes, not with concurrency inside one. Analysis is CPU-bound on a single Node thread, so INGEST_CONCURRENCY only overlaps the I/O around it; real parallelism comes from --scale worker=N in the systemd unit, bounded by the box’s memory fair share. That is the knob that matters when an import is slow and every worker is pegged at 100% CPU.',
    links: [
      { label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` },
      { label: 'compose.apphost.yaml', href: `${GH}/deploy/compose.apphost.yaml` },
    ],
  },
  pgc: {
    title: 'postgres container',
    body: 'Postgres is self-hosted in a container here, even though the apphost offers a managed MariaDB. The system is built on Postgres specifically: Drizzle’s Postgres dialect, pg-boss (a Postgres queue), and the SQL this schema depends on. MariaDB was never a drop-in, and running our own is the lesser cost.\n\nThe self-hosting carries one real risk. Rootless Docker keeps its volumes, this container’s pgdata among them, under the NFS home directory, and Postgres on NFS is a known footgun for locking and fsync guarantees. Relocating the volume to local disk is an open item with IT; until it is resolved, the nightly pg_dump is the actual recovery guarantee, which is why the restore drill is treated as load-bearing rather than optional. The container also raises max_connections to 250, because each server process opens two pools and the default ceiling of 100 sits well under peak.',
    links: [
      { label: 'compose.apphost.yaml', href: `${GH}/deploy/compose.apphost.yaml` },
      { label: 'deploy-apphost.md', href: `${GH}/docs/deploy-apphost.md` },
    ],
  },
  dumpc: {
    title: 'pgdump sidecar',
    body: 'The sidecar is a stock postgres image running one shell loop: pg_dump in custom format (-Fc) into the backup directory, prune to the newest PGDUMP_KEEP dumps, then sleep a day and repeat. It shares the postgres container’s credentials and reaches the database over the compose network as PGHOST=postgres, so it needs nothing from the app.\n\nIt is deliberately a separate process from the database it dumps. Because the pgdata volume lives on NFS (the footgun noted on the Postgres node) the dump is this deployment’s real recovery guarantee, not a convenience, and the runbook’s restore drill exercises it against these files. After each dump it pings the healthchecks.io dead-man’s switch (and a /fail variant on error), which is the only thing that makes a silently-broken backup visible before it is needed.',
    links: [
      { label: 'pg-dump-sidecar.sh', href: `${GH}/deploy/pg-dump-sidecar.sh` },
      { label: 'deploy-apphost.md', href: `${GH}/docs/deploy-apphost.md` },
    ],
  },

  // ── NFS mount ─────────────────────────────────────────────────────────────
  blobs: {
    title: 'Blob store · filesystem backend',
    body: 'The blob store is one interface with two implementations. In development it is MinIO behind the S3 SDK; on the apphost it is a filesystem backend where every blob is an ordinary file under the storage root, written temp-then-rename. Nothing above the storage layer knows which is in play (the read paths, ingest, and retention all speak the same key-addressed API) so the apphost swap cost no application change.\n\nEvery key is resolved through a single gate that rejects anything escaping the storage root or reaching into the reserved .uploads staging tree, so a crafted object key cannot walk the filesystem. The mount underneath it is the constrained resource: a 1 TB quota with no headroom, which is the whole reason ingest strips student source before storing and the reason there is no events table. Both were storage this backend could not afford to keep.',
    links: [
      { label: 'fs-blobs.ts', href: `${GH}/packages/server/src/services/storage/fs-blobs.ts` },
      { label: 'deploy-apphost.md', href: `${GH}/docs/deploy-apphost.md` },
    ],
  },
  backs: {
    title: 'backups/',
    body: 'The backup directory lives on the same NFS mount as the blob store, bind-mounted into the sidecar as /data/backups and visible to the postgres container at the same host path. Two things follow from that placement: the nightly dumps count against the very 1 TB quota the storage-quota cron watches, and PGDUMP_KEEP bounds the series to the newest seven so the history cannot grow without limit.\n\nIt is also the input to the restore drill. The runbook restores from a dump picked out of this directory into a throwaway database, which is why the directory is created as an explicit one-time host-setup step rather than left to the sidecar to conjure.',
    links: [
      { label: 'compose.apphost.yaml', href: `${GH}/deploy/compose.apphost.yaml` },
      { label: 'deploy-apphost.md', href: `${GH}/docs/deploy-apphost.md` },
    ],
  },

  // ── Scheduled jobs ────────────────────────────────────────────────────────
  j1: {
    title: 'retention-sweep',
    body: 'The daily sweep, at 2am UTC, is the only job that reclaims submission storage, and it reclaims exactly one thing: blobs. It selects submissions whose semester was archived more than blob_retention_days ago and deletes their stored bundle from the blob store. It never touches a row.\n\nDeleting the blob but keeping the row is the deliberate shape. A submission’s cohort placement, its score, and its flags stay queryable for audit years later; what goes is the ability to re-open the underlying evidence once the retention window has passed. Deleting rows would make the system unable to answer questions about a case still open long after the semester closed, the exact situation the product exists to serve. The delete is idempotent, so a re-run over an already-purged submission is a no-op.',
    invariant:
      'Retention deletes blobs only. Submission rows are never deleted; they persist forever for audit.',
    links: [
      { label: 'retention-sweep.ts', href: `${GH}/packages/server/src/jobs/retention-sweep.ts` },
    ],
  },
  j2: {
    title: 'purge-expired-sessions',
    body: 'This hourly job does delete rows, but the rows are auth sessions, not submissions, and that distinction is the whole point. The “rows persist forever” rule protects submission and flag data for audit; a login session is ephemeral state with an expires_at, and once that has passed the row is dead weight. The delete removes exactly the rows whose expiry is in the past, never a future one, over an indexed column.\n\nIt is unrelated to retention despite both being cleanup: retention frees blob storage on a semester timeline, this frees an operational table on an hourly one.',
    links: [
      {
        label: 'purge-expired-sessions.ts',
        href: `${GH}/packages/server/src/jobs/purge-expired-sessions.ts`,
      },
    ],
  },
  j3: {
    title: 'reap-stale-uploads',
    body: 'A resumable upload stages its parts under a reserved .uploads tree on the storage mount, and the normal failure path aborts and cleans them. This daily 4am job reclaims the ones a crashed client abandoned, deleting only staging directories older than the configured TTL, never a stored bundle and never a row.\n\nIt is a genuine no-op under the S3 backend, where multipart part state is object storage’s problem rather than a directory on our mount; it does work only for the apphost’s filesystem backend.',
    links: [
      {
        label: 'reap-stale-uploads.ts',
        href: `${GH}/packages/server/src/jobs/reap-stale-uploads.ts`,
      },
    ],
  },
  j4: {
    title: 'purge-expired-exports',
    body: 'This slot is a no-op stub, and honestly so. Server-side export persistence was deferred with the rest of the PDF-export work, so there is no export_artifacts table for it to sweep; the handler logs a line and returns zero. It is nonetheless registered on the schedule so the cron exists and can be re-armed by shipping the handler alone, without also having to add a scheduled job in a later deploy.\n\nIt is the deployment counterpart of the dashed export box elsewhere in the architecture: the plumbing is in place ahead of the feature it will serve.',
    links: [
      {
        label: 'purge-expired-exports.ts',
        href: `${GH}/packages/server/src/jobs/purge-expired-exports.ts`,
      },
    ],
  },
  j5: {
    title: 'storage-quota-check',
    body: 'The mount has a hard 1 TB quota with no headroom (past it, writes fail) so the failure this job guards against is one nothing else can see coming. There is no error to alert on until the disk is already full, and by then ingest is broken. So this hourly job measures usage with statfs ahead of time and notifies at 80% and 90% of quota, turning a cliff into a slope with lead time to act.\n\nIt runs only on the filesystem backend, where a local mount exists to measure. The alert is a recurring reminder by design: its throttle window is shorter than the hourly cadence, so a still-breached threshold re-alerts every hour until the storage situation is actually fixed, rather than paging once and going quiet.',
    links: [
      {
        label: 'storage-quota-check.ts',
        href: `${GH}/packages/server/src/jobs/storage-quota-check.ts`,
      },
      { label: 'deploy-apphost.md', href: `${GH}/docs/deploy-apphost.md` },
    ],
  },
  j6: {
    title: 'recompute / recompute-cross-flags',
    body: 'Recompute is grouped with the cron jobs here, but it is not scheduled; it is demand-driven. Committing a change in the tuning UI enqueues a semester recompute that re-runs heuristics and rescores every non-superseded submission against the new weights; ingest finalization enqueues a cross-flags recompute for the affected semester. Neither runs on a clock.\n\nBoth collapse concurrent work by singleton key: a burst of ingest jobs finishing across a cohort produces one cross-flags recomputation, not one per file, and overlapping tuning commits fold into a single pending semester job. Like every background job in this stack it drains through pg-boss and stops on the same graceful shutdown path, which is the property the cluster label is really asserting.',
    links: [
      { label: 'recompute.ts', href: `${GH}/packages/server/src/jobs/recompute.ts` },
      {
        label: 'recompute-cross-flags.ts',
        href: `${GH}/packages/server/src/jobs/recompute-cross-flags.ts`,
      },
    ],
  },

  // ── Alerting ──────────────────────────────────────────────────────────────
  hchk: {
    title: 'healthchecks.io dead-man’s switch',
    body: 'healthchecks.io is a dead-man’s switch, and it exists to catch the one failure the alert sinks cannot: silence. The Discord and SMTP sinks fire when something throws, but a backup job that has quietly stopped running throws nothing, produces no error, and is invisible until the day someone needs a restore and finds no dump. An alert-on-error can never cover a job that has ceased to emit anything at all.\n\nThe switch inverts the logic. The pgdump sidecar pings this URL after every successful nightly dump, and a /fail variant when a dump errors; healthchecks.io expects a ping within the period plus grace and alerts if none arrives, so a sidecar that has died, hung, or been dropped from a redeploy trips the alarm by its absence. It is the backup’s proof-of-life, not the backup’s error channel.',
    links: [
      { label: 'pg-dump-sidecar.sh', href: `${GH}/deploy/pg-dump-sidecar.sh` },
      { label: 'deploy-apphost.md', href: `${GH}/docs/deploy-apphost.md` },
    ],
  },
  disc: {
    title: 'Discord webhook',
    body: 'The Discord webhook is the default alert sink because it costs nothing and needs no campus coordination: a webhook URL pasted into the deploy env and the operational notifier starts posting to a channel. It carries everything at or above ALERT_WEBHOOK_MIN_SEVERITY (default warn), which is more than the storage-quota alerts the diagram draws into it: job dead-letters, lifecycle events, and any other notification the server raises fan out through the same sink.\n\nIt exists as the sink that works on day one, before the email path has been arranged with IT.',
    links: [
      { label: 'webhook-sink.ts', href: `${GH}/packages/server/src/notify/sinks/webhook-sink.ts` },
      { label: 'deploy-apphost.md', href: `${GH}/docs/deploy-apphost.md` },
    ],
  },
  smtp: {
    title: 'SMTP alerts',
    body: 'The email sink is the other half of alerting, and it is dark unless two things are set: an SMTP URL and at least one recipient. It is left empty at first deploy on purpose: outbound mail wants a campus SMTP relay rather than a self-run MTA, and arranging that is an open item with IT, so the Discord webhook carries alerts until the relay is confirmed.\n\nWhen configured it forwards notifications at or above its own severity threshold, in parallel with the webhook: the notifier fans out to every sink whose threshold an event meets, so the two are additive, not either-or.',
    links: [
      { label: 'notifier.ts', href: `${GH}/packages/server/src/notify/notifier.ts` },
      { label: 'deploy-apphost.md', href: `${GH}/docs/deploy-apphost.md` },
    ],
  },

  // ── Identity ──────────────────────────────────────────────────────────────
  goog: {
    title: 'Google OAuth',
    body: 'Authentication is Google OAuth, but the load-bearing check is not “did Google authenticate this person”; it is the hd claim. The callback verifies the ID token’s RS256 signature against Google’s keys and then requires its hd (hosted-domain) claim to be in AUTH_ALLOWED_HOSTED_DOMAINS, which on this deploy is ["berkeley.edu"]. A valid Google account with any other hosted domain, or none, is rejected.\n\nThis is the primary access control for the whole analyzer, so two properties matter. The check is on the cryptographically verified token, never on the hd hint sent to Google’s account picker, so a caller cannot assert their own domain. And it is why the runbook has staff confirm the value explicitly on first deploy rather than trusting the default: loosening it is exactly what would let arbitrary Google users reach student source and flags.',
    invariant:
      'Authentication succeeds only when the verified Google ID token’s hd claim is in AUTH_ALLOWED_HOSTED_DOMAINS.',
    links: [
      { label: 'verify-id-token.ts', href: `${GH}/packages/server/src/auth/verify-id-token.ts` },
      { label: 'google.ts', href: `${GH}/packages/server/src/auth/google.ts` },
    ],
  },

  // ── Deploy ────────────────────────────────────────────────────────────────
  deploy: {
    title: 'Deploy is manual, over SSH',
    body: 'Deployment is manual, by hand, over SSH, and that is forced, not lazy. GitHub’s hosted runners cannot reach instapphost inside the campus network, so no hosted CI/CD can build or ship to this environment. A redeploy is a person: git pull, rebuild the image with the commit SHA baked in as a build arg, and systemctl --user restart the stack.\n\nThe one-shot migrate service is what makes that safe without orchestration. It runs the Drizzle migrator and exits, and both the api and every worker replica wait on its successful completion, so migrations run exactly once per deploy no matter how many workers there are, and a commit with no new migration is a no-op. The GIT_SHA baked at build time then surfaces in the startup notification and /healthz, so a redeploy is verifiable from the alert feed.',
    invariant:
      'There is no CI/CD for this environment: hosted runners cannot reach instapphost. Every deploy is manual over SSH; the one-shot migrate service runs migrations exactly once per deploy.',
    links: [
      { label: 'deploy-apphost.md', href: `${GH}/docs/deploy-apphost.md` },
      { label: 'entrypoint.sh', href: `${GH}/deploy/entrypoint.sh` },
    ],
  },
  rkey: {
    title: 'The root key configuration',
    body: 'The same public value in two deployment shapes. The server reads PROVENANCE_ROOT_PUBLIC_KEY_HEX from the environment and hands it to validation check 2 at ingest and on the recompute path; the browser bundle bakes VITE_ROOT_PUBLIC_KEY_HEX in at build time, which is what lets the /local route verify a trust chain with no server involved at all. Neither is a secret — it is the public half of a signature key, and there is nothing here to protect — so shipping it in a client bundle is exactly right rather than a compromise. The env schema accepts 64 lowercase hex or the empty string and nothing in between, so a truncated paste fails at startup rather than at the first bundle.\n\nBoth sides treat unset as a real state rather than an error. With no key configured, check 2 reports skipped for a 2.0 bundle and the roll-up degrades to warn; 1.0 and 1.1 bundles never consult it, because they carry no chain to walk. The alternative — defaulting to some key, or quietly passing the check — would mean an unconfigured deployment reporting bundles as verified that nothing had verified.',
    invariant:
      'An unset root key makes check 2 report skipped, never a pass. Absence of the means to verify is reported as absence.',
    links: [
      { label: 'root-key.ts (server)', href: `${GH}/packages/server/src/config/root-key.ts` },
      { label: 'root-key.ts (browser)', href: `${GH}/packages/analyzer/src/lib/root-key.ts` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [
  // The public hostname. It is the sole ingress and resolves to the apphost;
  // the label already says everything true about it.
  'dns',
];
