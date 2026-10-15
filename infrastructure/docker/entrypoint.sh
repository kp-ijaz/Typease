#!/bin/sh
# Entry point of the TypEase API / worker images. One image, several roles:
#
#   api              start the HTTP API                      (default of api.Dockerfile)
#   worker           start the BullMQ worker                 (default of worker.Dockerfile)
#   migrate          apply pending migrations, sync the passwords of the two runtime roles, exit
#   migrate-status   list applied / pending migrations, exit
#   seed             explains how to load demonstration data (tools image; never in production)
#   check [args]     run the production-readiness gate (scripts/production-readiness.mjs)
#   anything else    is executed as a command (e.g. `node -v`, `sh`)
set -eu

role="${1:-${TYPEASE_ROLE:-api}}"
[ "$#" -gt 0 ] && shift

case "$role" in
  api)
    cd /app/services/api
    exec node dist/main.js "$@"
    ;;
  worker)
    if [ -f /app/services/worker/dist/main.js ]; then
      cd /app/services/worker
      exec node dist/main.js "$@"
    elif [ -f /app/services/api/dist/worker.js ]; then
      cd /app/services/api
      exec node dist/worker.js "$@"
    fi
    echo "This image does not contain a worker build (services/worker/dist/main.js or services/api/dist/worker.js)." >&2
    exit 64
    ;;
  migrate)
    : "${DATABASE_MIGRATION_URL:?DATABASE_MIGRATION_URL (schema owner) is required for migrations}"
    cd /app/database
    exec node scripts-dist/migrate.js "$@"
    ;;
  migrate-status)
    : "${DATABASE_MIGRATION_URL:?DATABASE_MIGRATION_URL (schema owner) is required}"
    cd /app/database
    exec node scripts-dist/migrate.js --status
    ;;
  seed)
    # The demonstration seed drives the real API and needs the TypeScript loader and the
    # development dependencies, which this production image deliberately does not contain.
    echo "The demo seed is not part of the runtime image. Use the 'tools' build target instead:" >&2
    echo "  docker compose --profile seed run --rm seed        (docker-compose.yml, development only)" >&2
    exit 64
    ;;
  check)
    cd /app
    exec node scripts/production-readiness.mjs "$@"
    ;;
  *)
    exec "$role" "$@"
    ;;
esac
