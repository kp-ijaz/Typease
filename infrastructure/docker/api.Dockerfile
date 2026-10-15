# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# TypEase API image (also the migration job: `command: ["migrate"]`).
#
#   docker build -f infrastructure/docker/api.Dockerfile -t typease-api .        # context = repository root
#   docker run --rm --env-file typease.env typease-api                            # API on :4000
#   docker run --rm --env-file migrate.env typease-api migrate                    # apply migrations, exit
#   docker run --rm --env-file migrate.env typease-api migrate-status
#   docker run --rm --env-file typease.env --env-file migrate.env typease-api check
#
# Targets:  runtime (default)  minimal production image, non-root
#           tools              full workspace with dev dependencies (pnpm db:seed, tests) - never deploy it
#
# Base image: Debian bookworm-slim (glibc). The API loads native add-ons at runtime
# (@node-rs/argon2 ships prebuilt N-API binaries; tesseract.js-core is WebAssembly),
# and the build needs @swc/core, esbuild and the Prisma CLI. glibc avoids the musl
# variants of all of them; the same libc is used to install and to run.
#
# NOT built or run in the authoring workspace (no Docker daemon there). See
# docs/deployment/docker.md for what was validated statically.
# -----------------------------------------------------------------------------
ARG NODE_VERSION=22.22.0
ARG PNPM_VERSION=10.28.0

# ---- base: Node + pnpm -------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    npm_config_update_notifier=false
RUN npm install -g "pnpm@${PNPM_VERSION}" && pnpm config set store-dir /pnpm/store
WORKDIR /app

# ---- manifests: every package.json, nothing else -----------------------------
# The stage itself is rebuilt on any source change, but its OUTPUT only changes when a
# manifest changes, so the dependency layers below stay cached (BuildKit keys COPY --from
# on content).
FROM base AS manifests
COPY . /src
RUN mkdir /manifests && cd /src \
 && find . -name package.json -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.next/*' \
      -exec cp --parents {} /manifests/ \;

# ---- fetch: fill the pnpm store from the lockfile only -----------------------
# The store is kept in the layer (not in a cache mount) on purpose: a restored layer
# cache with an empty cache mount would break the offline installs below.
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

# ---- build: dev dependencies, compile ----------------------------------------
FROM fetch AS build
# Air-gapped builds: `prisma generate` only produces the TypeScript client, but the Prisma
# CLI wants to download its schema engine. Point this at any existing file to skip that
# (e.g. --build-arg PRISMA_SCHEMA_ENGINE_BINARY=/bin/true). Leave empty when online.
ARG PRISMA_SCHEMA_ENGINE_BINARY=""
ENV PRISMA_SCHEMA_ENGINE_BINARY=${PRISMA_SCHEMA_ENGINE_BINARY}
COPY --from=manifests /manifests/ ./
RUN pnpm install --frozen-lockfile --offline --filter "@typease/api..."
COPY . .
# Workspace dependencies first (database runs `prisma generate`), then the API itself.
RUN pnpm --filter "@typease/api..." run build
# The migration runner is TypeScript executed with tsx in development. Compile it to plain
# JavaScript so the runtime image needs neither tsx nor dev dependencies. It resolves the
# SQL files relative to itself: database/scripts-dist/migrate.js -> database/migrations.
RUN cd database && pnpm exec tsc scripts/migrate.ts --outDir scripts-dist \
      --module commonjs --target es2022 --moduleResolution node --esModuleInterop --skipLibCheck --types node

# ---- tools: everything, for seeding and tests (never deployed) ----------------
FROM build AS tools
ENV NODE_ENV=development
CMD ["pnpm", "db:seed"]

# ---- prod-deps: production dependencies of the API and its workspace packages -
# `pnpm fetch` also pre-populates node_modules/.pnpm with EVERY package of the lockfile
# (development ones included). Drop that virtual store and rebuild it from the content
# store with production dependencies only, so nothing else can reach the runtime image.
FROM fetch AS prod-deps
COPY --from=manifests /manifests/ ./
RUN rm -rf node_modules \
 && pnpm install --frozen-lockfile --offline --prod --ignore-scripts --filter "@typease/api..."

# ---- assemble: node_modules (prod) + compiled output --------------------------
FROM prod-deps AS assemble
RUN --mount=type=bind,from=build,source=/app,target=/build \
    set -eu; \
    for d in database/dist database/migrations database/scripts-dist \
             packages/types/dist packages/permissions/dist packages/validation/dist \
             services/api/dist services/api/assets; do \
      test -d "/build/$d" || { echo "missing build output: $d" >&2; exit 1; }; \
      mkdir -p "/app/$(dirname "$d")"; \
      cp -a "/build/$d" "/app/$d"; \
    done; \
    mkdir -p /app/scripts; \
    cp /build/scripts/production-readiness.mjs /app/scripts/; \
    cp /build/infrastructure/docker/entrypoint.sh /app/entrypoint.sh; \
    chmod 0555 /app/entrypoint.sh; \
    rm -f /app/pnpm-lock.yaml /app/.npmrc

# ---- runtime ------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="typease-api" \
      org.opencontainers.image.description="TypEase REST API and migration job" \
      org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production \
    PORT=4000 \
    TZ=UTC \
    NO_COLOR=1 \
    STORAGE_LOCAL_DIR=/data/storage
WORKDIR /app
COPY --from=assemble --chown=root:root /app /app
# /data is only used by STORAGE_DRIVER=local (single-host installs); mount a volume there.
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 4000
# Readiness, not just liveness: "healthy" means PostgreSQL (both roles) and Redis answer.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["api"]
