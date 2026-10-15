# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# TypEase background worker image (BullMQ consumer, outbox dispatcher, schedulers).
#
#   docker build -f infrastructure/docker/worker.Dockerfile -t typease-worker .   # context = repository root
#   docker run --rm --env-file typease.env typease-worker
#
# The worker executes the job handlers that the API modules register, so the image is the
# API build plus the worker entry point. The first four stages are textually identical to
# api.Dockerfile, which lets BuildKit share their layers between the two builds.
#
# Entry point (see entrypoint.sh, role "worker"): services/worker/dist/main.js, a thin
# launcher that loads the worker from the built API (services/api/dist/worker.js).
# Configuration: the API's environment (QUEUE_DRIVER=bullmq) plus WORKER_CONCURRENCY,
# WORKER_HEALTH_PORT, WORKER_OUTBOX_INTERVAL_MS, WORKER_SHUTDOWN_TIMEOUT_MS.
#
# NOT built or run in the authoring workspace (no Docker daemon there).
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
FROM base AS manifests
COPY . /src
RUN mkdir /manifests && cd /src \
 && find . -name package.json -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.next/*' \
      -exec cp --parents {} /manifests/ \;

# ---- fetch: fill the pnpm store from the lockfile only -----------------------
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

# ---- build -------------------------------------------------------------------
FROM fetch AS build
ARG PRISMA_SCHEMA_ENGINE_BINARY=""
ENV PRISMA_SCHEMA_ENGINE_BINARY=${PRISMA_SCHEMA_ENGINE_BINARY}
COPY --from=manifests /manifests/ ./
RUN pnpm install --frozen-lockfile --offline --filter "@typease/api..." --filter "@typease/worker..."
COPY . .
RUN pnpm --filter "@typease/api..." run build \
 && if [ -f services/worker/package.json ]; then pnpm --filter "@typease/worker" run build; fi \
 && if [ ! -f services/worker/dist/main.js ] && [ ! -f services/api/dist/worker.js ]; then \
      echo "No worker entry point was built (services/worker/dist/main.js or services/api/dist/worker.js)." >&2; exit 1; \
    fi

# ---- prod-deps ---------------------------------------------------------------
FROM fetch AS prod-deps
COPY --from=manifests /manifests/ ./
RUN rm -rf node_modules \
 && pnpm install --frozen-lockfile --offline --prod --ignore-scripts --filter "@typease/api..." --filter "@typease/worker..."

# ---- assemble ----------------------------------------------------------------
FROM prod-deps AS assemble
RUN --mount=type=bind,from=build,source=/app,target=/build \
    set -eu; \
    for d in database/dist packages/types/dist packages/permissions/dist packages/validation/dist \
             services/api/dist services/api/assets services/worker/dist; do \
      if [ -d "/build/$d" ]; then \
        mkdir -p "/app/$(dirname "$d")"; \
        cp -a "/build/$d" "/app/$d"; \
      elif [ "$d" != "services/worker/dist" ]; then \
        echo "missing build output: $d" >&2; exit 1; \
      fi; \
    done; \
    cp /build/infrastructure/docker/entrypoint.sh /app/entrypoint.sh; \
    chmod 0555 /app/entrypoint.sh; \
    rm -f /app/pnpm-lock.yaml /app/.npmrc

# ---- runtime -----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="typease-worker" \
      org.opencontainers.image.description="TypEase background worker" \
      org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production \
    TZ=UTC \
    NO_COLOR=1 \
    WORKER_HEALTH_PORT=4100 \
    STORAGE_LOCAL_DIR=/data/storage
WORKDIR /app
COPY --from=assemble --chown=root:root /app /app
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 4100
# GET /health on WORKER_HEALTH_PORT: 200 only when the worker can do its work (readiness).
HEALTHCHECK --interval=20s --timeout=5s --start-period=60s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||4100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["worker"]
