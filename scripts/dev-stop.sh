#!/usr/bin/env bash
# Stops the local development processes started by dev-api.sh / dev-web-supervised.sh /
# start-web-standalone.sh. Usage: scripts/dev-stop.sh [api] [web] (default: both).
set -uo pipefail
WHAT="${*:-api web}"
SELF=$$
stop_matching() {
  local needle="$1"
  for pid in $(pgrep -u "$(id -u)" . 2>/dev/null); do
    [ "$pid" = "$SELF" ] || [ "$pid" = "$PPID" ] && continue
    local cmd
    cmd=$( { tr "\0" " " < "/proc/$pid/cmdline"; } 2>/dev/null) || continue
    case "$cmd" in
      *dev-stop.sh*) ;;
      bash\ *"$needle"*|node\ *"$needle"*|next-server*) case "$cmd" in *"$needle"*|next-server*) kill -9 "$pid" 2>/dev/null ;; esac ;;
    esac
  done
}
case " $WHAT " in *" web "*)
  stop_matching "dev-web-supervised.sh"
  stop_matching "next dev"
  stop_matching "bin/next"
  stop_matching ".next-dev/"
  stop_matching "standalone"
  ;;
esac
case " $WHAT " in *" api "*)
  for pid in $(pgrep -x node 2>/dev/null); do
    cmd=$( { tr "\0" " " < "/proc/$pid/cmdline"; } 2>/dev/null) || continue
    case "$cmd" in "node dist/main.js "*|"node dist/worker.js "*) kill -9 "$pid" 2>/dev/null ;; esac
  done
  ;;
esac
exit 0
