# syntax=docker/dockerfile:1
# Build stage - install workspace deps once, build analyzer + server.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
# Build the pure-TS workspace deps first: analyzer and server both consume
# @provenance/log-core, @provenance/shared and @provenance/analysis-core via
# their package.json "exports" map, which points at dist/ -- these packages
# do not build automatically as part of `npm ci`, so they must be built here
# before anything that imports them.
RUN npm run build --workspace=packages/log-core
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/analysis-core
# The Manifest 2.0 ROOT public key, baked into the browser bundle at build time
# (packages/analyzer/src/lib/root-key.ts reads it from import.meta.env). This is
# the PUBLIC half of a signature key -- shipping it in a client bundle is
# intended, not a leak. It is what lets the standalone /local route walk a trust
# chain (root -> course_cert -> manifest -> session) with no server involved.
#
# It must be an ARG, not an env_file entry: Vite inlines VITE_* at BUILD time, so
# setting it at runtime in compose does nothing. The server's own runtime copy is
# the separate PROVENANCE_ROOT_PUBLIC_KEY_HEX, read from .env.
#
# Empty is a supported state: /local then reports validation check 2 as `skipped`
# for a 2.0 bundle rather than guessing, and 1.0/1.1 bundles never consult it.
ARG VITE_ROOT_PUBLIC_KEY_HEX=
ENV VITE_ROOT_PUBLIC_KEY_HEX=$VITE_ROOT_PUBLIC_KEY_HEX
# Build analyzer SPA (produces packages/analyzer/dist)
RUN npm run build --workspace=packages/analyzer
# Build server bundle (produces packages/server/dist/index.js)
RUN npm run build --workspace=packages/server
# The server build script only bundles src/index.ts. The migrate CLI
# (src/db/migrate.ts) is a separate entrypoint invoked by entrypoint.sh, so
# bundle it explicitly. It MUST land at dist/db/migrate.js (two levels below
# packages/server) because migrate.ts resolves its migrations directory as
# path.resolve(__dirname, '../../db/migrations') -- with __dirname pointing
# at .../packages/server/dist/db, that resolves to
# .../packages/server/db/migrations, which is where the .sql files actually
# live. Bundling to dist/migrate.js (one level) would break that resolution.
RUN npx esbuild packages/server/src/db/migrate.ts --bundle --platform=node --format=esm \
    --outfile=packages/server/dist/db/migrate.js --packages=external

# Runtime stage
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
# Runs as root: required to write to the NFS bind mount on the apphost
# (rootless Docker maps container-root to the host account that owns the
# mount; running as a non-root user here would lose write access to it).
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/log-core/package.json ./packages/log-core/package.json
COPY --from=build /app/packages/log-core/dist ./packages/log-core/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/analysis-core/package.json ./packages/analysis-core/package.json
COPY --from=build /app/packages/analysis-core/dist ./packages/analysis-core/dist
# npm nested this dep instead of hoisting it to the root node_modules (dedup
# conflict with another package's version range). Node's ESM resolution walks
# up from the importing file, so it must exist at this nested path too.
COPY --from=build /app/packages/analysis-core/node_modules/diff ./packages/analysis-core/node_modules/diff
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/db ./packages/server/db
# Same nested-dependency situation as analysis-core/node_modules/diff above,
# for drizzle-orm.
COPY --from=build /app/packages/server/node_modules/drizzle-orm ./packages/server/node_modules/drizzle-orm
# Analyzer static build served from PUBLIC_DIR
COPY --from=build /app/packages/analyzer/dist ./packages/server/public
# Defense in depth: never serve the bundle-analysis report pre-auth, even if an
# image is built with ANALYZE=1 (the analyzer's vite config gates it off by default).
RUN rm -f ./packages/server/public/.report.html
ENV PUBLIC_DIR=/app/packages/server/public
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
WORKDIR /app/packages/server
ENTRYPOINT ["/app/entrypoint.sh"]
