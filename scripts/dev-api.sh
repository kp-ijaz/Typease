#!/usr/bin/env bash
# Starts the API from the production build with local development settings (single-process mode).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.dev-local; set +a
cd services/api
exec node dist/main.js
