#!/usr/bin/env bash
# Brings up a TypEase development environment.
#
#   scripts/dev-up.sh                  everything in containers (docker-compose.yml, profile "full"),
#                                      waits for the API, loads demonstration data, prints the URLs
#   scripts/dev-up.sh --host           dependencies in containers (profile "deps"); API, worker and the
#                                      four web apps run on the host with pnpm (hot reload)
#
# Options
#   --monitoring       also start Prometheus / Grafana / Loki (docker mode)
#   --no-seed          do not load demonstration data
#   --no-docker-deps   --host only: PostgreSQL and Redis already run on this machine, start no containers
#   --no-web           --host only: start the API (and worker) but not the web apps
#   --dry-run          print the commands instead of running them
#
# Stop everything with scripts/dev-down.sh (add --purge to delete the data volumes too).
#
# Host mode keeps its logs and PID files in node_modules/.cache/typease-dev (git-ignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

MODE=docker; SEED=1; MONITORING=0; DOCKER_DEPS=1; WEB=1; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --docker) MODE=docker; shift ;;
    --host) MODE=host; shift ;;
    --monitoring) MONITORING=1; shift ;;
    --no-seed) SEED=0; shift ;;
    --no-docker-deps) DOCKER_DEPS=0; shift ;;
    --no-web) WEB=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }
have_daemon() { docker info >/dev/null 2>&1; }
need_daemon() {
  [ "$DRY" = 1 ] && return 0
  command -v docker >/dev/null 2>&1 || { echo "Docker is not installed." >&2; exit 1; }
  have_daemon || { echo "The Docker daemon is not reachable. Start Docker, or use: scripts/dev-up.sh --host --no-docker-deps" >&2; exit 1; }
}

BASE_DOMAIN="${TYPEASE_BASE_DOMAIN:-typease.localhost}"
HTTP_PORT="${HTTP_PORT:-80}"
PORT_SUFFIX=""; [ "$HTTP_PORT" = 80 ] || PORT_SUFFIX=":$HTTP_PORT"

# ---------------------------------------------------------------------------------------------
if [ "$MODE" = docker ]; then
  need_daemon
  PROFILES=(--profile full)
  [ "$MONITORING" = 1 ] && PROFILES+=(--profile monitoring)

  say "Building and starting the stack (first run: several minutes; ClamAV downloads its signatures)"
  run docker compose "${PROFILES[@]}" up -d --build

  say "Waiting for the API (through the proxy on port $HTTP_PORT)"
  # By address + Host header: works even where the system resolver does not know *.localhost.
  run scripts/wait-for.sh --timeout 300 --header "Host: api.$BASE_DOMAIN" http "http://127.0.0.1:$HTTP_PORT/health/ready"

  if [ "$SEED" = 1 ]; then
    if [ -f database/seed/seed.ts ]; then
      say "Loading demonstration data (database seed)"
      run docker compose --profile seed run --rm seed
    elif [ -f scripts/dev-quickstart.mjs ]; then
      say "Loading demonstration data (scripts/dev-quickstart.mjs against the running API)"
      run docker compose --profile full run --rm --no-deps -v "$ROOT/scripts:/work:ro" --entrypoint node api /work/dev-quickstart.mjs --api http://api:4000
    else
      echo "No seed found (database/seed/seed.ts or scripts/dev-quickstart.mjs): skipping."
    fi
  fi

  cat <<OUT

TypEase is running.
  Staff console      http://app.$BASE_DOMAIN$PORT_SUFFIX
  Customer portal    http://portal.$BASE_DOMAIN$PORT_SUFFIX        (a centre: http://<slug>.$BASE_DOMAIN$PORT_SUFFIX)
  Corporate portal   http://corporate.$BASE_DOMAIN$PORT_SUFFIX
  Platform console   http://admin.$BASE_DOMAIN$PORT_SUFFIX
  API                http://api.$BASE_DOMAIN$PORT_SUFFIX/health/ready    Swagger: /api/docs
  Caught email       http://localhost:${MAILPIT_UI_PORT:-8025}
  MinIO console      http://localhost:${MINIO_CONSOLE_PORT:-9001}
  n8n                http://localhost:${N8N_PORT:-5678}
$([ "$MONITORING" = 1 ] && printf '  Grafana            http://localhost:%s\n  Prometheus         http://localhost:%s\n' "${GRAFANA_PORT:-3030}" "${PROMETHEUS_PORT:-9090}")
Logs:  docker compose --profile full logs -f api worker        Stop:  scripts/dev-down.sh
OUT
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# Host mode
STATE="$ROOT/node_modules/.cache/typease-dev"
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required (corepack enable, or npm i -g pnpm@10)." >&2; exit 1; }

if [ ! -f .env ]; then
  say "Creating .env from .env.example (development values)"
  run cp .env.example .env
fi

if [ "$DOCKER_DEPS" = 1 ]; then
  need_daemon
  say "Starting the dependency containers (PostgreSQL, Redis, MinIO, ClamAV, Mailpit, n8n)"
  run docker compose --profile deps up -d
fi

ENV_FILE=.env; [ -f "$ENV_FILE" ] || ENV_FILE=.env.example      # dry run before .env exists
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

pg_hostport="$(printf '%s' "${DATABASE_MIGRATION_URL:-postgresql://x@127.0.0.1:5432/x}" | sed -E 's#^[a-z]+://([^@]*@)?([^/?]+).*#\2#')"
case "$pg_hostport" in *:*) ;; *) pg_hostport="$pg_hostport:5432" ;; esac
redis_hostport="$(printf '%s' "${REDIS_URL:-redis://127.0.0.1:6379}" | sed -E 's#^[a-z]+://([^@]*@)?([^/?]+).*#\2#')"
case "$redis_hostport" in *:*) ;; *) redis_hostport="$redis_hostport:6379" ;; esac
say "Waiting for PostgreSQL ($pg_hostport) and Redis ($redis_hostport)"
run scripts/wait-for.sh --timeout 120 tcp "$pg_hostport"
run scripts/wait-for.sh --timeout 60 tcp "$redis_hostport"

if [ ! -d node_modules/.pnpm ]; then
  say "Installing dependencies"
  run pnpm install --frozen-lockfile
fi
say "Generating the database client and building the shared packages"
run pnpm build:packages
say "Applying database migrations (also sets the passwords of typease_app / typease_system)"
run pnpm db:migrate

run mkdir -p "$STATE"
start() { # name, pnpm script
  local name="$1" script="$2"
  if [ -f "$STATE/$name.pid" ] && kill -0 "$(cat "$STATE/$name.pid")" 2>/dev/null; then
    echo "   $name is already running (pid $(cat "$STATE/$name.pid"))"; return 0
  fi
  if [ "$DRY" = 1 ]; then printf '   [dry-run] pnpm %s  > %s/%s.log &\n' "$script" "$STATE" "$name"; return 0; fi
  nohup pnpm "$script" > "$STATE/$name.log" 2>&1 &
  echo $! > "$STATE/$name.pid"
  echo "   started $name (pid $!, log $STATE/$name.log)"
}

say "Starting the API on :${PORT:-4000}"
start api dev:api
run scripts/wait-for.sh --timeout 180 http "http://127.0.0.1:${PORT:-4000}/health/ready"

if [ -f services/worker/package.json ] && [ "${QUEUE_DRIVER:-bullmq}" = bullmq ]; then
  say "Starting the worker"
  start worker dev:worker
else
  echo "   worker not started ($([ -f services/worker/package.json ] && echo "QUEUE_DRIVER=${QUEUE_DRIVER:-}: jobs run inside the API" || echo "services/worker has no package.json yet"))"
fi

if [ "$WEB" = 1 ]; then
  say "Starting the web apps"
  for pair in centre-web:dev:centre customer-web:dev:customer corporate-portal:dev:corporate platform-admin:dev:admin; do
    app="${pair%%:*}"; script="${pair#*:}"
    if ls "apps/$app"/next.config.* >/dev/null 2>&1; then start "$app" "$script"; else echo "   $app has no next.config yet: skipped"; fi
  done
fi

if [ "$SEED" = 1 ]; then
  if [ -f database/seed/seed.ts ]; then
    say "Loading demonstration data (pnpm db:seed)"
    run pnpm db:seed
  elif [ -f scripts/dev-quickstart.mjs ]; then
    say "Loading demonstration data (scripts/dev-quickstart.mjs)"
    run node scripts/dev-quickstart.mjs --api "http://127.0.0.1:${PORT:-4000}"
  fi
fi

cat <<OUT

TypEase is running on the host.
  API                http://localhost:${PORT:-4000}/health/ready      Swagger: http://localhost:${PORT:-4000}/api/docs
  Staff console      http://localhost:3001      Customer portal   http://localhost:3002
  Corporate portal   http://localhost:3003      Platform console  http://localhost:3004
Logs: $STATE/*.log        Stop: scripts/dev-down.sh
OUT
