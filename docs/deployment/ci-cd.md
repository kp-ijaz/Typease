# CI/CD

Workflows in `.github/workflows/`. **None of them has run yet**: they were written without
network access, reviewed by hand and parsed as YAML. `actionlint` runs on them inside CI
itself (`scripts/validate-infra.sh`). Expect the first runs to need small corrections.

## 1. `ci.yml` - pull requests and `main`

| Job | What it does | Notes |
| --- | --- | --- |
| `quality` | install (frozen lockfile), build packages (`prisma generate`), type-check, lint, package unit tests, build API, **`scripts/validate-infra.sh --strict`** | the infra validation runs `docker compose config`, `caddy validate`, `promtool`, `amtool`, `hadolint`, `shellcheck`, `actionlint` - everything that could not run where the files were written |
| `api-tests` | PostgreSQL 16 + Redis service containers; creates the owner role and `typease_test`; `pnpm --filter @typease/api test`; then `tests/integration` and `tests/security` when `tests/jest.config.js` exists | the tests run the real migrations as a non-superuser owner, so RLS is enforced exactly as in production |
| `build` | `pnpm build:packages`, `pnpm build:api`, `pnpm build:web` | compile check for API, worker and the four web apps |
| `e2e` | builds, migrates, seeds, starts the API (single-process mode) and the four web apps, `pnpm test:e2e`, uploads the report | skipped with a notice until `tests/e2e/playwright.config.ts` exists |
| `mobile` | `subosito/flutter-action`, bootstrap, `flutter pub get`, `flutter analyze`, `flutter test` in `apps/customer-mobile` | **`continue-on-error: true`**: the mobile app has never been compiled anywhere; this job is where that first happens. Remove the flag after the first green run |
| `audit` | `pnpm audit --prod --audit-level high` | |
| `secrets` | gitleaks over the full history, config `infrastructure/security/gitleaks.toml` | binary from the official image (no licence key needed) |
| `images` | builds the six images without pushing, checks they run as non-root, Trivy scan (fails on fixable CRITICAL / HIGH) | |

Permissions: `contents: read` for the whole workflow. Pull-request runs cancel superseded
runs.

Things that will fail until other work lands, by design:

* The `e2e` job skips itself with a notice while `tests/e2e/playwright.config.ts` does not
  exist. **No browser suite has been written** (`tests/e2e` is empty); the job's assumptions
  (which environment variables the Playwright suite reads, where it writes its report) were
  made before any suite existed and must be adjusted when one lands.

Resolved since this was first written: `pnpm-lock.yaml` has an importer for
`services/worker`, so `pnpm install --frozen-lockfile` no longer refuses the workspace. Still
true: nothing in these workflows has ever run.
* The API test job runs the **whole** API suite; it has only ever been run module by module
  on the development machine.

## 2. `release.yml` - version tags

Pushing `v1.4.2` builds and pushes

```
ghcr.io/<owner>/typease-{api,worker,centre-web,customer-web,corporate-portal,platform-admin}:v1.4.2
                                                                                             :sha-<12 hex>
```

with BuildKit provenance (`mode=max`) and an SBOM attestation, then scans the pushed digest
with Trivy. No `latest` tag. `packages: write` only for this job.

`NEXT_PUBLIC_API_URL` is compiled into the web bundles, so it comes from the GitHub
**environment** (`production` by default; variables, not secrets). For another environment
run the workflow manually: its web images get the suffix `-<environment>`
(`TYPEASE_WEB_IMAGE_SUFFIX` in `compose.env`).

## 3. `deploy.yml` - manual, protected

`workflow_dispatch` with `environment`, `version`, `skip_migrate`, `skip_backup`. The job
uses the GitHub environment, so required reviewers and branch restrictions apply before any
secret is released. One deployment per environment at a time.

Steps: validate inputs -> SSH with pinned host key -> on the host: check out the same tag,
`scripts/deploy.sh <version>` (backup, pull, migrate, rolling restart, readiness) -> wait
for public readiness -> `scripts/smoke-test.sh` against the public URL -> on failure, a job
summary with rollback instructions.

Rollback is deliberately manual: the same workflow with the previous version and
`skip_migrate`. See `upgrades-and-rollbacks.md`.

Host prerequisites: Docker Engine with the Compose plugin, a checkout of this repository at
`DEPLOY_PATH`, `/etc/typease/*.env`, `docker login ghcr.io` with a read-only package token
(private images), and the deploy user set up as described at the top of `deploy.yml`.

## 4. Supply chain

* Actions are pinned to **exact release tags**. Tags are mutable; the commit SHAs could not
  be resolved offline. Before production use pin every `uses:` to a SHA
  (`pinact run`, or `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`), and enable Dependabot
  or Renovate for the `github-actions` ecosystem to keep them current.
* Scanners (gitleaks, Trivy) are run from pinned official container images rather than
  through third-party actions; pin those by digest as well.
* The exact tags used were chosen from memory of published releases and could not be checked
  against the registries: a "manifest unknown" or "unable to resolve action" error on the
  first run means that tag needs correcting, nothing more.
* Base images in the Dockerfiles are pinned by version (`node:22.22.0-bookworm-slim`);
  record and pin the digest when you cut the first release.
* Lockfile: `pnpm install --frozen-lockfile` everywhere; `onlyBuiltDependencies` in
  `pnpm-workspace.yaml` limits which packages may run install scripts.

## 5. Required repository configuration

| Where | Name | Purpose |
| --- | --- | --- |
| environment `production` / `staging` -> variables | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_STORAGE_ORIGINS`, optional `API_INTERNAL_URL` | compiled into web images |
| | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, `DEPLOY_USE_SUDO`, `PUBLIC_API_URL` | deployment target |
| | `SMOKE_TENANT_SLUG`, `SMOKE_ALLOWED_ORIGIN` | optional smoke-test inputs |
| environment -> secrets | `DEPLOY_SSH_KEY`, `DEPLOY_SSH_KNOWN_HOSTS` | SSH |
| | `SMOKE_EMAIL`, `SMOKE_PASSWORD` | optional: a low-privilege account for the smoke test |
| environment -> protection rules | required reviewers, allowed branches / tags | approval before deploy |
| repository | branch protection on `main` requiring the CI jobs | |
