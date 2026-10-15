#!/usr/bin/env bash
# Deploys one TypEase release on a single Docker host (docker-compose.prod.yml).
# Called by .github/workflows/deploy.yml over SSH; can also be run by hand on the host.
#
#   scripts/deploy.sh v1.4.2
#   scripts/deploy.sh v1.4.1 --skip-migrate         # roll the CODE back (see "Rollback" below)
#   scripts/deploy.sh v1.4.2 --dry-run              # print the plan, change nothing
#
# Order (zero-downtime-ish):
#   0. record the running version, back up the database (unless --skip-backup)
#   1. pull the images of the new version
#   2. migrate   - run-once job; forward-only, written to be compatible with the PREVIOUS code
#   3. api       - rolling: new replicas are started NEXT TO the old ones, must report healthy
#                  (/health/ready), then the old ones are stopped. Caddy discovers replicas by DNS.
#   4. worker    - recreated (in-flight jobs get stop_grace_period to finish; BullMQ retries the rest)
#   5. web apps  - rolling, same as the API
#   6. caddy     - only (re)created when its configuration or image changed
#   7. readiness check + optional smoke test; the deployed version is written to compose.env
#
# If a step fails the script stops and prints how to roll back. It never rolls back by itself:
# after a migration ran, going back needs a human decision (docs/deployment/upgrades-and-rollbacks.md).
#
# Rollback: scripts/deploy.sh <previous version> --skip-migrate
#   Migrations are forward-only and are NOT undone. This is safe as long as every migration
#   is backward compatible with the previous release (expand / contract). If it is not,
#   restore the pre-deploy backup instead (scripts/db-restore.sh).
#
# Environment
#   TYPEASE_COMPOSE_ENV   default /etc/typease/compose.env
#   TYPEASE_COMPOSE_FILE  default <repo>/docker-compose.prod.yml
#   TYPEASE_BACKUP_ENV    default /etc/typease/backup.env (pre-deploy backup; skipped when missing)
#   SMOKE_*               passed to scripts/smoke-test.sh when --smoke is given
#
# Written and syntax-checked, NOT executed against a Docker daemon in the authoring workspace.
set -Eeuo pipefail      # -E: the ERR trap also fires inside functions

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
COMPOSE_ENV="${TYPEASE_COMPOSE_ENV:-/etc/typease/compose.env}"
COMPOSE_FILE="${TYPEASE_COMPOSE_FILE:-$ROOT/docker-compose.prod.yml}"
BACKUP_ENV="${TYPEASE_BACKUP_ENV:-/etc/typease/backup.env}"

VERSION=""; MIGRATE=1; BACKUP=1; SMOKE=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-migrate) MIGRATE=0; shift ;;
    --skip-backup) BACKUP=0; shift ;;
    --smoke) SMOKE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) VERSION="$1"; shift ;;
  esac
done
[ -n "$VERSION" ] || { echo "usage: deploy.sh <version> [--skip-migrate] [--skip-backup] [--smoke] [--dry-run]" >&2; exit 2; }
[[ "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid version: $VERSION" >&2; exit 2; }
[ "$VERSION" != latest ] || { echo "Deploy an immutable version tag, not \"latest\"." >&2; exit 2; }
[ -r "$COMPOSE_ENV" ] || { echo "cannot read $COMPOSE_ENV" >&2; exit 1; }
[ -r "$COMPOSE_FILE" ] || { echo "cannot read $COMPOSE_FILE" >&2; exit 1; }

log()  { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
run()  { if [ "$DRY" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }
# TYPEASE_VERSION from the environment wins over the value in compose.env.
dc()   { TYPEASE_VERSION="$VERSION" docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" "$@"; }
dcrun(){ if [ "$DRY" = 1 ]; then printf '   [dry-run] TYPEASE_VERSION=%s docker compose %s\n' "$VERSION" "$*"; else dc "$@"; fi; }

PREVIOUS="$(sed -n 's/^TYPEASE_VERSION=//p' "$COMPOSE_ENV" | tail -n 1)"
on_error() {
  cat >&2 <<OUT

DEPLOY OF $VERSION FAILED at: ${STEP:-start}
  The previous version was: ${PREVIOUS:-unknown}
  Containers that were already replaced run $VERSION; the others still run ${PREVIOUS:-the old version}.
  To go back:   scripts/deploy.sh ${PREVIOUS:-<previous version>} --skip-migrate
  Read first:   docs/deployment/upgrades-and-rollbacks.md  (migrations are forward-only)
  Diagnose:     docker compose --env-file $COMPOSE_ENV -f $COMPOSE_FILE ps
                docker compose --env-file $COMPOSE_ENV -f $COMPOSE_FILE logs --tail 200 api migrate
OUT
}
trap on_error ERR

# wait_healthy SERVICE EXPECTED_COUNT TIMEOUT - all containers of the service report "healthy".
wait_healthy() {
  local service="$1" expected="$2" timeout="${3:-180}" start=$SECONDS healthy
  [ "$DRY" = 1 ] && { printf '   [dry-run] wait until %s container(s) of %s are healthy\n' "$expected" "$service"; return 0; }
  while :; do
    healthy=0
    for id in $(dc ps -q "$service"); do
      [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null)" = healthy ] && healthy=$((healthy + 1))
    done
    [ "$healthy" -ge "$expected" ] && return 0
    if [ $((SECONDS - start)) -ge "$timeout" ]; then
      echo "timeout: only $healthy of $expected $service container(s) are healthy" >&2
      return 1
    fi
    sleep 3
  done
}

# rolling SERVICE - start new containers next to the old ones, wait, remove the old ones.
rolling() {
  local service="$1" old="" count
  if [ "$DRY" = 1 ]; then
    printf '   [dry-run] rolling restart of %s: scale up with the new image (--no-recreate), wait until healthy, stop + remove the old containers\n' "$service"
    return 0
  fi
  old="$(dc ps -q "$service" | tr '\n' ' ')"
  count="$(printf '%s' "$old" | wc -w | tr -d ' ')"
  if [ "$count" = 0 ]; then
    dcrun up -d --no-deps "$service"
    wait_healthy "$service" 1 240
    return 0
  fi
  # --no-recreate keeps the old containers; --scale doubles the service with the new image.
  dcrun up -d --no-deps --no-recreate --scale "$service=$((count * 2))" "$service"
  wait_healthy "$service" "$((count * 2))" 240
  for id in $old; do
    run docker stop "$id" >/dev/null
    run docker rm "$id" >/dev/null
  done
  # Back to the configured replica count (no-op: the survivors already match it).
  dcrun up -d --no-deps --no-recreate "$service"
}

STEP="pre-flight"
log "Deploying $VERSION (currently: ${PREVIOUS:-unknown})"
command -v docker >/dev/null 2>&1 || { echo "docker is not installed" >&2; exit 1; }
[ "$DRY" = 1 ] || docker info >/dev/null 2>&1 || { echo "the Docker daemon is not reachable" >&2; exit 1; }

if [ "$BACKUP" = 1 ] && [ "$MIGRATE" = 1 ]; then
  STEP="pre-deploy backup"
  if [ -r "$BACKUP_ENV" ]; then
    log "0. Pre-deploy database backup"
    run "$ROOT/scripts/db-backup.sh" --env-file "$BACKUP_ENV"
  else
    log "0. No $BACKUP_ENV: SKIPPING the pre-deploy backup (managed database? make sure PITR is on)"
  fi
fi

STEP="pull"
log "1. Pulling images"
dcrun pull --quiet migrate api worker centre-web customer-web corporate-portal platform-admin

if [ "$MIGRATE" = 1 ]; then
  STEP="migrate"
  log "2. Running database migrations"
  dcrun run --rm migrate
else
  log "2. Migrations skipped (--skip-migrate)"
fi

STEP="api"
log "3. API (rolling)"
rolling api

STEP="worker"
log "4. Worker"
dcrun up -d --no-deps worker
wait_healthy worker 1 240

STEP="web"
log "5. Web applications (rolling)"
for app in centre-web customer-web corporate-portal platform-admin; do rolling "$app"; done

STEP="proxy and optional services"
log "6. Proxy and optional services (recreated only when their definition changed)"
dcrun up -d --no-deps caddy
dcrun up -d --remove-orphans --no-recreate

STEP="post-deploy checks"
log "7. Post-deploy checks"
if [ "$DRY" = 1 ]; then
  printf '   [dry-run] docker compose exec -T api  -> GET http://127.0.0.1:4000/health/ready\n'
else
  dc exec -T api node -e "fetch('http://127.0.0.1:4000/health/ready').then(async r=>{console.log(r.status, await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})"
fi
if [ "$SMOKE" = 1 ]; then
  [ -n "${SMOKE_API_URL:-}" ] || { echo "--smoke needs SMOKE_API_URL (public API URL)" >&2; false; }
  run "$ROOT/scripts/smoke-test.sh" --api "$SMOKE_API_URL"
fi

STEP="record version"
if [ "$DRY" != 1 ]; then
  if grep -q '^TYPEASE_VERSION=' "$COMPOSE_ENV"; then
    sed -i.bak "s/^TYPEASE_VERSION=.*/TYPEASE_VERSION=$VERSION/" "$COMPOSE_ENV" && rm -f "$COMPOSE_ENV.bak"
  else
    printf 'TYPEASE_VERSION=%s\n' "$VERSION" >> "$COMPOSE_ENV"
  fi
  printf '%s %s (previous: %s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$VERSION" "${PREVIOUS:-unknown}" >> "$(dirname "$COMPOSE_ENV")/deploy-history.log"
fi
trap - ERR
log "Deployed $VERSION. Roll back with: scripts/deploy.sh ${PREVIOUS:-<previous version>} --skip-migrate"
