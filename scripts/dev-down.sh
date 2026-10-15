#!/usr/bin/env bash
# Stops what scripts/dev-up.sh started: host processes (API, worker, web apps) and the
# Compose stack (all profiles).
#
#   scripts/dev-down.sh            stop; keep the data volumes
#   scripts/dev-down.sh --purge    stop and DELETE the development volumes (database, object storage ...)
#   scripts/dev-down.sh --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

PURGE=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }

STATE="$ROOT/node_modules/.cache/typease-dev"
if [ -d "$STATE" ]; then
  for pidfile in "$STATE"/*.pid; do
    [ -e "$pidfile" ] || continue
    name="$(basename "$pidfile" .pid)"; pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "stopping $name (pid $pid)"
      # The pid is `pnpm`; its children (node, next) are in the same process group only when
      # started by this script's nohup: signal the children first, then the parent.
      run pkill -TERM -P "$pid" || true
      run kill -TERM "$pid" || true
    fi
    [ "$DRY" = 1 ] || rm -f "$pidfile"
  done
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ARGS=(--profile full --profile deps --profile monitoring --profile seed down --remove-orphans)
  if [ "$PURGE" = 1 ]; then
    echo "Deleting the development volumes."
    ARGS+=(--volumes)
  fi
  run docker compose "${ARGS[@]}"
elif [ "$DRY" = 1 ]; then
  printf '   [dry-run] docker compose --profile full --profile deps --profile monitoring --profile seed down --remove-orphans%s\n' "$([ "$PURGE" = 1 ] && echo ' --volumes')"
else
  echo "Docker daemon not reachable: no containers to stop."
fi
