#!/usr/bin/env bash
# Runs the whole API test suite against a dedicated test database and writes the summary to a file,
# so that it can be started detached on a slow machine:  scripts/ci-api-tests.sh [log-file]
set -uo pipefail
cd "$(dirname "$0")/.."
LOG="${1:-/tmp/api-tests.log}"
export PRISMA_SCHEMA_ENGINE_BINARY="${PRISMA_SCHEMA_ENGINE_BINARY:-/bin/true}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=3072}"
export TEST_PG_DATABASE="${TEST_PG_DATABASE:-typease_test_main}"
export TEST_REDIS_URL="${TEST_REDIS_URL:-redis://127.0.0.1:6379/5}"
export TEST_STORAGE_DIR="${TEST_STORAGE_DIR:-/tmp/typease-test-main}"
S=$(date +%s)
pnpm test:api > "$LOG" 2>&1
echo "exit=$? seconds=$(( $(date +%s) - S ))" > "$LOG.done"
