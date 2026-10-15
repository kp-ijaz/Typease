#!/usr/bin/env bash
# Waits until something answers, then exits 0 (or 1 after the timeout).
#
#   scripts/wait-for.sh tcp 127.0.0.1:5432                      # a TCP port accepts connections
#   scripts/wait-for.sh http http://localhost:4000/health/ready # an URL answers 200
#   scripts/wait-for.sh --timeout 300 --status 200,301,302 http https://app.example.ae/
#   scripts/wait-for.sh --quiet tcp redis:6379 && echo up
#   scripts/wait-for.sh --header "Host: api.typease.localhost" http http://127.0.0.1/health   # through a proxy by address
#
# Options: --timeout <seconds> (default 120)  --interval <seconds> (default 2)
#          --status <codes>  accepted HTTP status codes, comma separated (default 200)
#          --header "<Name: value>"  extra request header for http (repeatable)
#          --quiet
set -euo pipefail

TIMEOUT=120; INTERVAL=2; STATUSES="200"; QUIET=0; HEADERS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --status) STATUSES="$2"; shift 2 ;;
    --header) HEADERS+=(-H "$2"); shift 2 ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) break ;;
  esac
done
KIND="${1:-}"; TARGET="${2:-}"
[ -n "$KIND" ] && [ -n "$TARGET" ] || { echo "usage: wait-for.sh [options] tcp host:port | http URL" >&2; exit 2; }
say() { [ "$QUIET" = 1 ] || echo "$@"; }

probe() {
  case "$KIND" in
    tcp)
      local host="${TARGET%:*}" port="${TARGET##*:}"
      # bash's /dev/tcp: no dependency on nc. The subshell closes the socket again.
      (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1
      ;;
    http)
      local code
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${HEADERS[@]+"${HEADERS[@]}"} "$TARGET" 2>/dev/null || true)"
      case ",$STATUSES," in *",$code,"*) return 0 ;; *) return 1 ;; esac
      ;;
    *) echo "unknown kind: $KIND (use tcp or http)" >&2; exit 2 ;;
  esac
}

START=$SECONDS
say "waiting for $KIND $TARGET (timeout ${TIMEOUT}s)"
until probe; do
  if [ $((SECONDS - START)) -ge "$TIMEOUT" ]; then
    echo "timed out after ${TIMEOUT}s waiting for $KIND $TARGET" >&2
    exit 1
  fi
  sleep "$INTERVAL"
done
say "$KIND $TARGET is up after $((SECONDS - START))s"
