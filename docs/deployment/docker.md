# Container images and Compose stacks

> **Nothing in this document was built or run by its author.** The authoring workspace had a
> Docker CLI but no daemon and no network. What was validated statically is listed in
> section 6. The first `docker build` of each image is therefore a real test - read section 5
> first.

## 1. Images

All three Dockerfiles are built **from the repository root** (the workspace lockfile and the
shared packages are needed) and share their first stages, so BuildKit reuses the layers.

| File | Image | Notes |
| --- | --- | --- |
| `infrastructure/docker/api.Dockerfile` | API, **and the migration job** (`command: ["migrate"]`) | target `runtime` (default); target `tools` = full workspace with dev dependencies for the demo seed |
| `infrastructure/docker/worker.Dockerfile` | background worker | API build + worker entry point |
| `infrastructure/docker/web.Dockerfile` | the four Next.js apps | build args `APP`, `PORT`, `NEXT_PUBLIC_API_URL` |
| `infrastructure/docker/caddy/Dockerfile` | Caddy with a DNS module | only for the wildcard-certificate option |

```bash
docker build -f infrastructure/docker/api.Dockerfile    -t typease-api .
docker build -f infrastructure/docker/worker.Dockerfile -t typease-worker .
docker build -f infrastructure/docker/web.Dockerfile --build-arg APP=centre-web --build-arg PORT=3001 \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.ae -t typease-centre-web .
# APP / PORT: centre-web 3001, customer-web 3002, corporate-portal 3003, platform-admin 3004
```

### How they are built

1. `base` - `node:22.22.0-bookworm-slim` + pnpm 10.28.0 (the versions of `package.json`).
2. `manifests` - copies only the `package.json` files. Its output changes only when a
   manifest changes, so dependency layers stay cached across source edits.
3. `fetch` - `pnpm fetch` from the lockfile alone into the store (kept in the layer on
   purpose; a cache mount would be empty when layers are restored from a remote cache and
   the offline installs would fail).
4. `build` - `pnpm install --frozen-lockfile --offline --filter "<package>..."` (only what
   that image needs), then the build. For the API: the workspace packages (`prisma generate`
   included), the API, and the migration runner compiled to plain JavaScript
   (`database/scripts-dist/migrate.js`) so the runtime image needs neither `tsx` nor dev
   dependencies. That compile step was verified in the workspace (`migrate.js --status`
   listed the three applied migrations).
5. `prod-deps` - removes the virtual store that `pnpm fetch` pre-populated and reinstalls
   with `--prod --ignore-scripts` for the image's packages only.
6. `assemble` + `runtime` - production `node_modules` (pnpm's symlink layout is kept intact)
   plus the compiled output, copied into a clean `bookworm-slim` image. Runs as the
   unprivileged `node` user; application files are owned by root and not writable.

### Base image choice

Debian bookworm-slim (glibc) rather than Alpine (musl):

* runtime: `@node-rs/argon2` (password hashing) is a native N-API add-on shipped as prebuilt
  per-platform binaries; pnpm installs the variant matching the libc of the machine that
  runs `pnpm install`, so build and runtime must use the same libc. `tesseract.js` is
  WebAssembly, `pdfkit` / `exceljs` are pure JavaScript. `@napi-rs/canvas` and `@swc/core`
  are development / test dependencies and are not in the runtime image.
* build: `@swc/core`, `esbuild`, the Prisma CLI and `sharp` (Next.js image optimisation) all
  have glibc binaries; musl variants exist but are the less-travelled path.

The price is a larger base image than Alpine. Distroless would be smaller still, but the
entry point is a shell script and the health checks use `node -e`, which works there too -
an optimisation for later.

### Health checks

| Image | Check |
| --- | --- |
| API | `GET /health/ready` on `$PORT` (PostgreSQL with both roles + Redis must answer) |
| worker | `GET /health` on `$WORKER_HEALTH_PORT` (4100): readiness of the worker (`/health/live` is its liveness) |
| web | `GET /healthz` on `$PORT` (the apps' liveness route); falls back to `GET /` with any status below 500 for an app without that route |

### Web images: build-time configuration

Next.js inlines `NEXT_PUBLIC_*` into the JavaScript bundle and evaluates `next.config`
(rewrites, headers) during `next build`. Changing these on a running container has no effect.
Consequences: one set of web images per environment (see `ci-cd.md`), and never put a secret
in such a variable.

| Build arg | Meaning |
| --- | --- |
| `APP`, `PORT` | which application |
| `NEXT_PUBLIC_API_URL` | API origin as seen by the browser (required) |
| `NEXT_PUBLIC_STORAGE_ORIGINS` | object-store origin(s) for presigned uploads / downloads; added to the apps' Content-Security-Policy. Without it the browser blocks uploads to the bucket |
| `API_INTERNAL_URL` | target of the apps' optional same-origin API proxy (`apiProxy` in `packages/config/next.mjs`), e.g. `http://api:4000` |
| `NEXT_PUBLIC_ENV` | further `KEY=value` lines |

At run time the apps' server code reads `API_PUBLIC_URL` (falls back to
`NEXT_PUBLIC_API_URL`); the Compose files set it.

The web Dockerfile relies on the shared configuration in `packages/config/next.mjs`
(`output: 'standalone'`, file tracing rooted at the repository, `transpilePackages`) and
fails with a clear message when the standalone output is missing. It handles both layouts
Next can produce in a monorepo (server at `.next/standalone/apps/<app>/server.js` or at
`.next/standalone/server.js`). `HOSTNAME=0.0.0.0` is set because Docker puts the container
id into `$HOSTNAME` and the standalone server would bind to that name only. The Next cache
is redirected to `/tmp` so the root filesystem can be read-only.

### Entry point roles (API / worker images)

```
api | worker | migrate | migrate-status | check [args] | seed (explains: tools image only) | <any command>
```

```bash
dc="docker compose --env-file /etc/typease/compose.env -f docker-compose.prod.yml"
$dc run --rm migrate                                   # apply migrations, sync role passwords, exit
$dc run --rm migrate migrate-status                    # list applied / pending
$dc run --rm migrate check --skip-network              # production-readiness gate inside the network
```

Demo seed (development only, never production): `docker compose --profile seed run --rm seed`
- the `tools` target with dev dependencies, because the seed drives the real API through
the TypeScript loader.

### Air-gapped builds

`prisma generate` only writes the TypeScript client, but the Prisma CLI wants to download a
schema engine. Build with `--build-arg PRISMA_SCHEMA_ENGINE_BINARY=/bin/true` (any existing
file) and provide a registry mirror for the base images and npm packages. Not tested here.

### `.dockerignore`

Keeps out of the build context: every `.env*` file except examples, key material, `.git`,
`node_modules`, `dist`, `.next`, `database/generated`, `storage-data`, backups and dumps,
test reports, the Flutter app, `docs`, the Compose files and `infrastructure/` (which holds
the stacks' environment files) except the entry point script, and `scripts/` except the
readiness script that the image ships.

## 2. `docker-compose.yml` - development and demos

| Profile | Services |
| --- | --- |
| `deps` | postgres 16, redis 7, minio + `minio-init`, clamav, mailpit, n8n - ports on `127.0.0.1` |
| `full` | `deps` + `migrate`, `api`, `worker`, four web apps, `caddy` |
| `monitoring` | prometheus, alertmanager, grafana, loki, alloy, exporters |
| `seed` | one-shot demo data |

```bash
docker compose --profile full up -d --build        # everything
docker compose --profile deps up -d                # dependencies only; apps with pnpm on the host
scripts/dev-up.sh [--host] [--monitoring]          # the same with waiting, seeding and a URL list
scripts/dev-down.sh [--purge]
```

Development values are in `infrastructure/docker/env/dev/*.env` - committed, clearly marked,
rejected by the readiness check. Host ports can be moved with `POSTGRES_PORT`, `REDIS_PORT`,
`MINIO_PORT`, `HTTP_PORT` ... (see the file) when they collide with local services.

Single-process variant without the worker container (small demos): set
`QUEUE_DRIVER=inline` and `QUEUE_INLINE_AUTORUN=true` in `dev/api.env` and name the services
explicitly (`docker compose --profile full up -d --build postgres redis minio minio-init
clamav mailpit n8n migrate api centre-web customer-web corporate-portal platform-admin
caddy`).

First start notes: ClamAV downloads its signature database (minutes, needs internet, about
2-3 GB of memory at peak); the API starts without waiting for it and scan jobs retry.

## 3. `docker-compose.prod.yml` - single-host production reference

* Images by tag (`TYPEASE_IMAGE_PREFIX`, `TYPEASE_VERSION` are mandatory - the file refuses
  to render without them); no `build:`.
* `restart: unless-stopped`; CPU / memory / PID limits; `no-new-privileges`; all
  capabilities dropped where the image allows it; read-only root filesystem + tmpfs for API,
  worker, web apps, Caddy, Redis and the exporters (not for PostgreSQL, MinIO, ClamAV, n8n,
  Grafana, Loki - their images write outside their volumes).
* Only Caddy publishes ports (80, 443/tcp, 443/udp). `scripts/validate-infra.sh` asserts it.
* Networks: `edge` (Caddy), `app` (application tier, outbound internet), `data` (internal,
  no internet: PostgreSQL, Redis, MinIO), `monitoring`.
* Secrets: one env file per service from `TYPEASE_ENV_DIR` (default `/etc/typease`, `0600`).
  The API and worker do not receive the schema owner URL (asserted by the validation
  script). Better options: `secrets.md`.
* Log rotation: `json-file`, 20 MB x 5.
* `migrate` is a run-once service that the API waits for.
* Managed PostgreSQL / Redis / object storage are the recommendation; the bundled ones are
  opt-in profiles (`bundled-postgres`, `bundled-redis`, `bundled-minio`). To use managed
  services leave the profile out of `COMPOSE_PROFILES` and put the provider's URLs into
  `typease.env` / `migrate.env`.

## 4. Pinned third-party images

Listed once at the top of each Compose file (`x-images`). They were chosen from memory of
published tags; **none could be pulled or checked against a registry here**. On the first
`docker compose pull`, correct any tag that does not exist, then bump to the current patch
releases, read the release notes, and pin by digest for production.

| Image | Tag in the files |
| --- | --- |
| node (Dockerfiles) | `22.22.0-bookworm-slim` |
| postgres | `16.11-bookworm` |
| redis | `7.4.2-alpine` |
| minio/minio, minio/mc | `RELEASE.2025-04-22T22-12-13Z`, `RELEASE.2025-04-16T18-13-26Z` |
| clamav/clamav | `1.4.3` |
| axllent/mailpit (dev) | `v1.27.0` |
| n8nio/n8n | `1.97.1` |
| caddy | `2.10.0-alpine` |
| prom/prometheus, alertmanager, blackbox-exporter, node-exporter | `v3.4.1`, `v0.28.1`, `v0.26.0`, `v1.9.1` |
| grafana/grafana, loki, alloy | `11.6.0`, `3.4.2`, `v1.8.1` |
| postgres-exporter, redis_exporter | `v0.17.1`, `v1.69.0` |

These tags are well over a year old relative to the date of writing. They are a starting
point that is known to have existed, not a statement that they are current or free of known
vulnerabilities.

## 5. Known risks for the first build

In decreasing order of likelihood:

1. **Lockfile and workspace drift.** `services/worker/package.json` exists, but
   `pnpm-lock.yaml` had no importer for `services/worker` when this was last checked. Until
   the lockfile is regenerated (`pnpm install` on a connected machine, commit the result)
   every `--frozen-lockfile` install fails - in all three Dockerfiles and in CI.
2. **Web apps.** Only `centre-web` had source code when the Dockerfile was last revised; the
   other three had a `package.json` only. `web.Dockerfile` follows the shared
   `packages/config/next.mjs` (standalone output, tracing root, `/healthz`) but has never met
   a real build of any of them.
3. **Filtered installs.** `pnpm install --filter "<pkg>..."` after `pnpm fetch` is the
   documented pnpm pattern, but the exact combination with `--offline --frozen-lockfile` and
   the `rm -rf node_modules` before the production install has not been executed.
4. **`.dockerignore` negation** for `infrastructure/docker/entrypoint.sh` and
   `scripts/production-readiness.mjs` inside excluded directories.
5. **Third-party tags** (section 4) and image internals assumed by health checks
   (`mc ready local` in the MinIO image, `clamdcheck.sh`, `wget` in the Caddy / n8n images).
6. **Hardening flags** (`cap_drop: ALL`, `read_only`) on third-party images: if a container
   fails with a permission error, relax that service first and report it.

## 6. What was validated

| Check | Result |
| --- | --- |
| `docker compose config` on `docker-compose.yml` with all profiles | passes |
| `docker compose config` on `docker-compose.prod.yml` with the example env files - bundled profile set and managed-services profile set | passes (it caught a real mistake during writing: `pids_limit` together with `deploy.resources.limits`) |
| rendered production config: published ports are only Caddy's 80 / 443; the API does not receive `DATABASE_MIGRATION_URL` | asserted by `scripts/validate-infra.sh` |
| `sh -n` / `bash -n` on the entry point, the MinIO and PostgreSQL init scripts | pass |
| PostgreSQL init SQL generation (`format()` + psql variables) | run read-only against PostgreSQL 16 without `\gexec`: produces the expected statements, including quoting of a password containing `'` and `"` |
| Migration runner compiled with the Dockerfile's `tsc` command line | compiled and run with `--status` against the development database |
| Dockerfiles, Caddyfiles | **reviewed only**; `hadolint`, `docker build --check` and `caddy validate` are wired into CI |
