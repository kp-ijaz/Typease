#!/usr/bin/env bash
# Runs the production (standalone) build of one web app: scripts/start-web-standalone.sh centre-web 3001
# Build first: pnpm --filter @typease/<app> build
set -euo pipefail
APP="${1:?app folder name, e.g. centre-web}"; PORT="${2:?port}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${NEXT_DIST_DIR:-.next}"
SRC="$ROOT/apps/$APP"
OUT="$SRC/$DIST/standalone/apps/$APP"
[ -f "$OUT/server.js" ] || { echo "No standalone build in $SRC/$DIST. Run: pnpm --filter @typease/$APP build" >&2; exit 1; }
# The standalone server expects static assets and public files next to it.
mkdir -p "$OUT/$DIST"
rm -rf "$OUT/$DIST/static" "$OUT/public"
cp -r "$SRC/$DIST/static" "$OUT/$DIST/static"
[ -d "$SRC/public" ] && cp -r "$SRC/public" "$OUT/public"
cd "$OUT"
exec env PORT="$PORT" HOSTNAME="0.0.0.0" node server.js
