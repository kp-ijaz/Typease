#!/bin/bash
# First-time PostgreSQL setup for TypEase. Runs once, as the bootstrap superuser, when the
# official postgres image initialises an EMPTY data directory (/docker-entrypoint-initdb.d).
# For a managed database run the same statements by hand: see
# infrastructure/docker/postgres/bootstrap.sql and docs/DEPLOYMENT_GUIDE.md.
#
# It creates:
#   * the schema OWNER role (LOGIN, CREATEROLE - never SUPERUSER) and the database it owns;
#   * optionally a read-only BACKUP role and a MONITORING role.
#
# It deliberately does NOT create typease_app / typease_system. The migration runner creates
# them AS THE OWNER (migration 0002), which is what gives the owner the right to set their
# passwords later (PostgreSQL 16: a CREATEROLE role may only alter roles it has ADMIN on).
#
# Required environment (see infrastructure/docker/env/dev/postgres.env):
#   TYPEASE_DB_NAME, TYPEASE_DB_OWNER, TYPEASE_DB_OWNER_PASSWORD
# Optional: TYPEASE_DB_BACKUP_PASSWORD, TYPEASE_DB_MONITOR_PASSWORD
set -euo pipefail

: "${TYPEASE_DB_NAME:?TYPEASE_DB_NAME is required}"
: "${TYPEASE_DB_OWNER:?TYPEASE_DB_OWNER is required}"
: "${TYPEASE_DB_OWNER_PASSWORD:?TYPEASE_DB_OWNER_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v db="$TYPEASE_DB_NAME" -v owner="$TYPEASE_DB_OWNER" -v owner_password="$TYPEASE_DB_OWNER_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD %L', :'owner', :'owner_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner') \gexec
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8''', :'db', :'owner')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('ALTER DATABASE %I SET timezone = ''UTC''', :'db') \gexec
SQL

if [ -n "${TYPEASE_DB_BACKUP_PASSWORD:-}" ]; then
  # Read-only role for pg_dump. BYPASSRLS because a dump must contain every tenant's rows;
  # it cannot write and cannot log in to anything but this database's data.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v db="$TYPEASE_DB_NAME" -v pw="$TYPEASE_DB_BACKUP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE typease_backup LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'typease_backup') \gexec
GRANT pg_read_all_data TO typease_backup;
SELECT format('GRANT CONNECT ON DATABASE %I TO typease_backup', :'db') \gexec
SQL
fi

if [ -n "${TYPEASE_DB_MONITOR_PASSWORD:-}" ]; then
  # For postgres-exporter: statistics views only, no table data.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v pw="$TYPEASE_DB_MONITOR_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE typease_monitor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'typease_monitor') \gexec
GRANT pg_monitor TO typease_monitor;
SQL
fi

echo "TypEase: role \"$TYPEASE_DB_OWNER\" and database \"$TYPEASE_DB_NAME\" are ready. Run the migration job next."
