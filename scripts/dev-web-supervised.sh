#!/usr/bin/env bash
# Keeps a Next.js dev server alive on a small machine: restarts it when it exits or when its
# memory use passes a limit. Usage: scripts/dev-web-supervised.sh <app> <port> [max-rss-mb] [node-heap-mb]
set -uo pipefail
APP="${1:?app}"; PORT="${2:?port}"; LIMIT_MB="${3:-2600}"; HEAP_MB="${4:-2304}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/$APP"
while true; do
  NEXT_DIST_DIR=.next-dev NODE_OPTIONS=--max-old-space-size="$HEAP_MB" pnpm exec next dev --turbopack -p "$PORT" &
  PID=$!
  while kill -0 "$PID" 2>/dev/null; do
    sleep 5
    # Sum the resident memory of the whole process group of the dev server.
    RSS_KB=$(ps -o rss= --ppid "$PID" -p "$PID" 2>/dev/null | awk '{s+=$1} END {print s+0}')
    CHILD=$(pgrep -P "$PID" | head -1)
    [ -n "$CHILD" ] && RSS_KB=$((RSS_KB + $(ps -o rss= --ppid "$CHILD" 2>/dev/null | awk '{s+=$1} END {print s+0}')))
    if [ "$RSS_KB" -gt $((LIMIT_MB * 1024)) ]; then
      echo "[supervisor] $APP uses $((RSS_KB / 1024)) MB > ${LIMIT_MB} MB: restarting"
      pkill -TERM -P "$PID" 2>/dev/null; kill -TERM "$PID" 2>/dev/null; sleep 2; pkill -KILL -P "$PID" 2>/dev/null; kill -KILL "$PID" 2>/dev/null
      for p in $(pgrep -f "next-server" 2>/dev/null); do grep -qa "$PORT" /proc/$p/cmdline 2>/dev/null && kill -KILL "$p" 2>/dev/null; done
    fi
  done
  echo "[supervisor] $APP dev server stopped; starting again in 2s"
  sleep 2
done
