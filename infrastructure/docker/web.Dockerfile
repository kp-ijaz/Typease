# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# One Dockerfile for the four Next.js applications.
#
#   docker build -f infrastructure/docker/web.Dockerfile \
#     --build-arg APP=centre-web --build-arg PORT=3001 \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.ae \
#     -t typease-centre-web .                                   # context = repository root
#
#   APP                  PORT   package
#   centre-web           3001   @typease/centre-web        (staff console)
#   customer-web         3002   @typease/customer-web      (customer portal, tenant sub-domains, custom domains)
#   corporate-portal     3003   @typease/corporate-portal
#   platform-admin       3004   @typease/platform-admin
#
# IMPORTANT - BUILD-TIME CONFIGURATION. Next.js inlines NEXT_PUBLIC_* values into the
# JavaScript and evaluates next.config (rewrites, headers) during `next build`. These values
# are not secrets and cannot be changed with runtime environment variables: an image built
# for staging talks to the staging API forever. Build one image set per environment (the
# release workflow does this with GitHub environment variables).
#
#   NEXT_PUBLIC_API_URL           origin of the API as seen BY THE BROWSER, e.g. https://api.example.ae
#   NEXT_PUBLIC_STORAGE_ORIGINS   origins of the object store that browsers upload to / download
#                                 from (presigned URLs), space or comma separated; they are added
#                                 to the Content-Security-Policy. e.g. https://s3.example.ae
#   API_INTERNAL_URL              where the app's own server reaches the API for the optional
#                                 same-origin proxy (`apiProxy` in packages/config/next.mjs),
#                                 e.g. http://api:4000 inside the Compose network
#   NEXT_PUBLIC_ENV               optional, further build-time variables, one KEY=VALUE per line
#
# Read at RUN time by the apps' server code (set them on the container as well):
#   API_PUBLIC_URL (falls back to NEXT_PUBLIC_API_URL), PORT
#
# Requirements on the applications (packages/config/next.mjs provides them): output:
# 'standalone' with file tracing rooted at the repository, transpilePackages for the
# @typease/* workspace packages, and a GET /healthz route for the container health check.
# The build fails with a clear message if the standalone output is missing.
#
# NOT built or run in the authoring workspace (no Docker daemon; only one of the four apps
# had source code when this file was last revised).
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
ARG APP
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_STORAGE_ORIGINS=""
ARG API_INTERNAL_URL=""
ARG NEXT_PUBLIC_ENV=""
ENV NEXT_TELEMETRY_DISABLED=1
RUN test -n "${APP}" || { echo "build arg APP is required (centre-web | customer-web | corporate-portal | platform-admin)" >&2; exit 1; }
COPY --from=manifests /manifests/ ./
RUN test -f "apps/${APP}/package.json" || { echo "unknown APP '${APP}'" >&2; exit 1; }
# Only this application and the workspace packages it depends on (no API, no Prisma).
# NODE_ENV is deliberately NOT set to production here: pnpm would skip the devDependencies
# (typescript, tailwind) that the build needs. `next build` sets it for itself.
RUN pnpm install --frozen-lockfile --offline --filter "@typease/${APP}..."
COPY . .
# Workspace packages that have a build step (api-client, types, validation ...), then the app.
RUN pnpm --filter "@typease/${APP}^..." run build
RUN test -n "${NEXT_PUBLIC_API_URL}" || { echo "build arg NEXT_PUBLIC_API_URL is required (it is inlined at build time)" >&2; exit 1; }; \
    { printf 'NEXT_PUBLIC_API_URL=%s\n' "${NEXT_PUBLIC_API_URL}"; \
      printf 'NEXT_PUBLIC_STORAGE_ORIGINS=%s\n' "${NEXT_PUBLIC_STORAGE_ORIGINS}"; \
      if [ -n "${API_INTERNAL_URL}" ]; then printf 'API_INTERNAL_URL=%s\n' "${API_INTERNAL_URL}"; fi; \
      printf '%s\n' "${NEXT_PUBLIC_ENV}"; } > "apps/${APP}/.env.production.local" \
 && pnpm --filter "@typease/${APP}" run build
# Normalise the standalone output. With file tracing rooted at the monorepo (what Next
# does in a pnpm workspace) the server is at .next/standalone/apps/<APP>/server.js;
# with tracing rooted at the app it is at .next/standalone/server.js. Static assets and
# public/ are not part of the standalone folder and are copied next to the server.
RUN set -eu; \
    S="apps/${APP}/.next/standalone"; \
    if [ -f "$S/apps/${APP}/server.js" ]; then REL="apps/${APP}"; \
    elif [ -f "$S/server.js" ]; then REL="."; \
    else echo "No standalone server found in $S - set output: 'standalone' in apps/${APP}/next.config" >&2; exit 1; fi; \
    mkdir -p /out; cp -a "$S/." /out/; \
    mkdir -p "/out/$REL/.next"; cp -a "apps/${APP}/.next/static" "/out/$REL/.next/static"; \
    if [ -d "apps/${APP}/public" ]; then cp -a "apps/${APP}/public" "/out/$REL/public"; fi; \
    rm -rf "/out/$REL/.next/cache"; ln -s /tmp/next-cache "/out/$REL/.next/cache"; \
    rm -f "/out/$REL/.env.production.local"; \
    printf '#!/bin/sh\n# Generated by web.Dockerfile. The Next.js cache lives in /tmp so the root filesystem can be read-only.\nmkdir -p /tmp/next-cache\ncd "/app/%s"\nexec node server.js\n' "$REL" > /out/start-web.sh; \
    chmod 0555 /out/start-web.sh

# ---- runtime -----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP
ARG PORT=3000
LABEL org.opencontainers.image.title="typease-${APP}" \
      org.opencontainers.image.description="TypEase web application: ${APP}" \
      org.opencontainers.image.licenses="UNLICENSED"
# HOSTNAME must be set: Docker puts the container id in $HOSTNAME and the Next.js
# standalone server would bind to that name only.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=UTC \
    PORT=${PORT} \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=root:root /out /app
USER node
EXPOSE ${PORT}
# GET /healthz (liveness route of the apps, does not touch the API). If an app has no such
# route yet, any answer below 500 on "/" counts (the first page may redirect to sign-in).
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=4 \
  CMD ["node", "-e", "const b='http://127.0.0.1:'+process.env.PORT;fetch(b+'/healthz').then(r=>r.ok?0:fetch(b+'/',{redirect:'manual'}).then(x=>x.status<500?0:1)).then(c=>process.exit(c)).catch(()=>process.exit(1))"]
CMD ["/app/start-web.sh"]
