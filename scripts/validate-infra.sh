#!/usr/bin/env bash
# Static validation of everything under infrastructure/, the Compose files, the workflows
# and the operational scripts. Runs anywhere; checks that need a tool which is not installed
# are reported as SKIP (never as PASS). With a Docker daemon the missing tools are run from
# their official images, so CI executes every check (job "infra" in .github/workflows/ci.yml).
#
#   scripts/validate-infra.sh            # what can be checked on this machine
#   scripts/validate-infra.sh --strict   # SKIP counts as failure (used in CI)
#
# No container of the application is built or started by this script.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 2
STRICT=0; [ "${1:-}" = "--strict" ] && STRICT=1

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/        /' | head -n 25; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIP  %s  (%s)\n' "$1" "$2"; }
# check NAME CMD... - PASS when the command exits 0, otherwise FAIL with its output.
check() { local name="$1" out; shift; if out="$("$@" 2>&1)"; then ok "$name"; else bad "$name" "$out"; fi; }

HAVE_DAEMON=0; command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && HAVE_DAEMON=1
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Third-party tool images used when the tool is not installed locally (pinned).
IMG_CADDY="caddy:2.10.0-alpine"
IMG_PROM="prom/prometheus:v3.4.1"
IMG_AM="prom/alertmanager:v0.28.1"
IMG_SHELLCHECK="koalaman/shellcheck:v0.10.0"
IMG_HADOLINT="hadolint/hadolint:v2.12.0"
IMG_ACTIONLINT="rhysd/actionlint:1.7.7"
IMG_ALLOY="grafana/alloy:v1.8.1"

echo "== shell syntax =="
while IFS= read -r f; do
  case "$(head -n 1 "$f")" in
    *bash*) check "bash -n $f" bash -n "$f" ;;
    *) check "sh -n $f" sh -n "$f" ;;
  esac
done < <(find scripts infrastructure -type f -name '*.sh' | sort)

if command -v shellcheck >/dev/null 2>&1; then
  check "shellcheck (scripts, infrastructure)" bash -c "find scripts infrastructure -type f -name '*.sh' -print0 | xargs -0 shellcheck -x -S warning"
elif [ "$HAVE_DAEMON" = 1 ]; then
  check "shellcheck (container)" bash -c "find scripts infrastructure -type f -name '*.sh' -print0 | xargs -0 docker run --rm -v '$ROOT:/mnt' -w /mnt $IMG_SHELLCHECK -x -S warning"
else skip "shellcheck" "not installed, no Docker daemon"; fi

echo "== node scripts =="
for f in scripts/production-readiness.mjs; do check "node --check $f" node --check "$f"; done

echo "== environment templates =="
check "every variable of env.ts is documented in .env.example and typease.env.example" node -e '
  const fs = require("fs");
  const src = fs.readFileSync("services/api/src/config/env.ts", "utf8");
  const body = src.slice(src.indexOf("const schema = z.object({"), src.indexOf("export type Env"));
  const keys = [...body.matchAll(/^  ([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
  if (keys.length < 50) { console.error("could not parse env.ts"); process.exit(1); }
  let failed = false;
  for (const file of [".env.example", "infrastructure/deployment/env/typease.env.example"]) {
    const text = fs.readFileSync(file, "utf8");
    const missing = keys.filter((k) => !new RegExp("^#? ?" + k + "=", "m").test(text));
    if (missing.length) { console.error(file + " is missing: " + missing.join(", ")); failed = true; }
  }
  // Typos: every assignment in the API env files must be a variable the API knows.
  const extra = new Set(["WORKER_HEALTH_PORT", "WORKER_CONCURRENCY", "WORKER_OUTBOX_INTERVAL_MS", "WORKER_SHUTDOWN_TIMEOUT_MS", "DATABASE_MIGRATION_URL"]);
  for (const file of [".env.example", "infrastructure/docker/env/dev/api.env", "infrastructure/deployment/env/typease.env.example"]) {
    const unknown = [...fs.readFileSync(file, "utf8").matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]).filter((k) => !keys.includes(k) && !extra.has(k));
    if (unknown.length) { console.error(file + " sets unknown variables: " + unknown.join(", ")); failed = true; }
  }
  process.exit(failed ? 1 : 0);'
check ".env.example passes the API's own validation (dist build)" bash -c '
  [ -f services/api/dist/config/env.js ] || { echo "services/api/dist is not built: run pnpm build:packages && pnpm --filter @typease/api build"; exit 1; }
  set -a; . ./.env.example; set +a
  cd services/api && node -e "require(\"./dist/config/env.js\").loadEnv()"'
check "no real secret file is tracked or present in infrastructure/deployment/env" bash -c '
  found="$(find infrastructure/deployment/env -type f ! -name "*.example" ! -name "README.md")"; [ -z "$found" ] || { echo "$found"; exit 1; }'

echo "== docker compose =="
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  check "docker compose config: docker-compose.yml (profiles full, deps, monitoring, seed)" \
    docker compose -f docker-compose.yml --profile full --profile deps --profile monitoring --profile seed config --quiet
  mkdir -p "$TMP/etc"
  for f in infrastructure/deployment/env/*.env.example; do cp "$f" "$TMP/etc/$(basename "${f%.example}")"; done
  check "docker compose config: docker-compose.prod.yml (bundled services + monitoring)" \
    env TYPEASE_ENV_DIR="$TMP/etc" COMPOSE_PROFILES=bundled-postgres,bundled-redis,bundled-minio,clamav,n8n,monitoring \
    docker compose --env-file "$TMP/etc/compose.env" -f docker-compose.prod.yml config --quiet
  check "docker compose config: docker-compose.prod.yml (managed data services)" \
    env TYPEASE_ENV_DIR="$TMP/etc" COMPOSE_PROFILES=clamav \
    docker compose --env-file "$TMP/etc/compose.env" -f docker-compose.prod.yml config --quiet
  check "production stack publishes only ports 80 and 443 (Caddy)" bash -c "
    TYPEASE_ENV_DIR='$TMP/etc' COMPOSE_PROFILES=bundled-postgres,bundled-redis,bundled-minio,clamav,n8n,monitoring \
      docker compose --env-file '$TMP/etc/compose.env' -f docker-compose.prod.yml config --format json > '$TMP/prod.json' &&
    node -e '
      const c = require(process.argv[1]);
      const pub = Object.entries(c.services).flatMap(([n, s]) => (s.ports || []).map((p) => n + \":\" + p.published));
      const bad = pub.filter((p) => !/^caddy:(80|443)\$/.test(p));
      if (bad.length) { console.error(\"unexpected published ports: \" + bad.join(\", \")); process.exit(1); }
      const api = c.services.api.environment || {};
      if (\"DATABASE_MIGRATION_URL\" in api) { console.error(\"the API container receives DATABASE_MIGRATION_URL\"); process.exit(1); }
    ' '$TMP/prod.json'"
else skip "docker compose config" "docker compose is not installed"; fi

echo "== YAML / JSON =="
if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' 2>/dev/null; then
  check "YAML parses: monitoring configuration and GitHub workflows" python3 -c '
import glob, sys, yaml
files = glob.glob("infrastructure/monitoring/**/*.yml", recursive=True) + glob.glob("infrastructure/monitoring/**/*.yml.example", recursive=True) + glob.glob(".github/workflows/*.yml")
if not files: sys.exit("no files found")
for f in files:
    with open(f) as h: yaml.safe_load(h)
print(len(files), "files")'
else skip "YAML parse" "python3 with PyYAML is not installed"; fi
check "JSON parses: Grafana dashboard, bucket lifecycle" node -e '
  for (const f of ["infrastructure/monitoring/grafana/dashboards/typease-overview.json", "infrastructure/docker/minio/lifecycle-documents.json"]) JSON.parse(require("fs").readFileSync(f, "utf8"));'

echo "== Caddy =="
caddy_validate() { # file, extra env...
  local file="$1"
  if command -v caddy >/dev/null 2>&1; then
    ( cd "$(dirname "$file")" && env TYPEASE_BASE_DOMAIN=example.ae ACME_EMAIL=ops@example.ae caddy validate --adapter caddyfile --config "$(basename "$file")" )
  else
    docker run --rm -e TYPEASE_BASE_DOMAIN=example.ae -e ACME_EMAIL=ops@example.ae \
      -v "$ROOT/$(dirname "$file"):/etc/caddy:ro" "$IMG_CADDY" caddy validate --adapter caddyfile --config "/etc/caddy/$(basename "$file")"
  fi
}
if command -v caddy >/dev/null 2>&1 || [ "$HAVE_DAEMON" = 1 ]; then
  check "caddy validate: Caddyfile (development)" caddy_validate infrastructure/docker/caddy/Caddyfile
  check "caddy validate: Caddyfile.prod" caddy_validate infrastructure/docker/caddy/Caddyfile.prod
else skip "caddy validate (Caddyfile, Caddyfile.prod)" "caddy is not installed, no Docker daemon"; fi

echo "== Prometheus / Alertmanager / Alloy =="
if command -v promtool >/dev/null 2>&1; then
  check "promtool check rules" promtool check rules infrastructure/monitoring/prometheus/rules/*.yml
elif [ "$HAVE_DAEMON" = 1 ]; then
  check "promtool check rules (container)" docker run --rm --entrypoint promtool -v "$ROOT/infrastructure/monitoring/prometheus:/etc/prometheus:ro" "$IMG_PROM" \
    check rules /etc/prometheus/rules/typease-alerts.yml /etc/prometheus/rules/typease-recording.yml
  touch "$TMP/internal_api_token"
  check "promtool check config (container)" docker run --rm --entrypoint promtool -v "$ROOT/infrastructure/monitoring/prometheus:/etc/prometheus:ro" \
    -v "$TMP/internal_api_token:/tmp/internal_api_token:ro" "$IMG_PROM" check config /etc/prometheus/prometheus.yml
  check "amtool check-config (container)" docker run --rm --entrypoint amtool -v "$ROOT/infrastructure/monitoring/alertmanager:/etc/alertmanager:ro" "$IMG_AM" \
    check-config /etc/alertmanager/alertmanager.yml
  check "alloy fmt (container)" docker run --rm -v "$ROOT/infrastructure/monitoring/alloy:/etc/alloy:ro" "$IMG_ALLOY" fmt /etc/alloy/config.alloy
else skip "promtool / amtool / alloy fmt" "not installed, no Docker daemon"; fi

echo "== Dockerfiles / workflows =="
DOCKERFILES=(infrastructure/docker/api.Dockerfile infrastructure/docker/worker.Dockerfile infrastructure/docker/web.Dockerfile infrastructure/docker/caddy/Dockerfile)
if command -v hadolint >/dev/null 2>&1; then
  check "hadolint" hadolint --failure-threshold error "${DOCKERFILES[@]}"
elif [ "$HAVE_DAEMON" = 1 ]; then
  for f in "${DOCKERFILES[@]}"; do check "hadolint $f (container)" bash -c "docker run --rm -i $IMG_HADOLINT hadolint --failure-threshold error - < '$f'"; done
  check "docker build --check (BuildKit lint, no image is built)" bash -c "for f in ${DOCKERFILES[*]}; do docker build --check -f \$f . >/dev/null || exit 1; done"
else skip "hadolint / docker build --check" "not installed, no Docker daemon"; fi
if command -v actionlint >/dev/null 2>&1; then
  check "actionlint" actionlint
elif [ "$HAVE_DAEMON" = 1 ]; then
  check "actionlint (container)" docker run --rm -v "$ROOT:/repo:ro" -w /repo "$IMG_ACTIONLINT" -color=false
else skip "actionlint (.github/workflows)" "not installed, no Docker daemon"; fi

echo
echo "Summary: $PASS PASS, $FAIL FAIL, $SKIP SKIP"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$STRICT" = 1 ] && [ "$SKIP" -gt 0 ]; then echo "--strict: skipped checks count as failures"; exit 1; fi
exit 0
