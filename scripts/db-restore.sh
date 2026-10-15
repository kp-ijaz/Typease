#!/usr/bin/env bash
# TypEase database restore: verify checksum -> decrypt -> restore into a FRESH database ->
# (re)create the runtime roles and their passwords -> sanity checks.
#
#   # Restore drill (never touches the live database; removes the drill database afterwards):
#   scripts/db-restore.sh --env-file /etc/typease/backup.env --file /var/backups/typease/<file>.dump.age \
#       --target-db typease_drill --drill
#
#   # Disaster recovery into a new, empty database:
#   scripts/db-restore.sh --env-file /etc/typease/backup.env --file <file>.dump.age --target-db typease \
#       --sync-roles --migrate-cmd "docker compose --env-file /etc/typease/compose.env -f docker-compose.prod.yml run --rm migrate"
#
# Options
#   --file <path>          encrypted backup (*.dump.age or *.dump.enc) written by scripts/db-backup.sh
#   --target-db <name>     database to restore into. It must NOT exist (it is created), or -
#   --existing-empty-db    - it exists and is EMPTY (managed services where databases are created in a console)
#   --drill                restore test: drops the target database at the end (unless --keep) and writes
#                          last-restore-drill.json next to the backup marker. Implies no role sync.
#   --keep                 with --drill: keep the restored database for inspection
#   --sync-roles           after the restore run the migration runner, which applies pending migrations
#                          and sets the passwords of typease_app / typease_system from DATABASE_URL /
#                          DATABASE_SYSTEM_URL. ROLE PASSWORDS ARE CLUSTER-WIDE: only use this on the
#                          cluster that will serve production, never for a drill on a shared cluster.
#   --migrate-cmd "<cmd>"  how to run the migration runner (default: pnpm --filter @typease/database migrate,
#                          with DATABASE_MIGRATION_URL pointing at the target database)
#   --jobs <n>             parallel restore jobs (default 1 = one transaction, all-or-nothing)
#   --yes                  do not ask for confirmation
#
# Configuration (environment or --env-file)
#   RESTORE_OWNER_URL       connection of the schema OWNER role on the target cluster (any database name;
#                           the script substitutes --target-db). Falls back to DATABASE_MIGRATION_URL.
#   RESTORE_ADMIN_URL       connection allowed to CREATE DATABASE (not needed with --existing-empty-db).
#                           Falls back to RESTORE_OWNER_URL when the owner has CREATEDB.
#   BACKUP_AGE_IDENTITY_FILE  age private key (for *.age)      BACKUP_PASSPHRASE  (for *.enc)
#   BACKUP_MARKER_FILE / BACKUP_DIR   where last-restore-drill.json is written
#
# Why the roles are created by the OWNER: PostgreSQL 16 lets a CREATEROLE role alter only
# roles it has ADMIN on. The migration runner (as the owner) must be able to set the runtime
# roles' passwords, so the owner has to be the role that creates them - exactly as migration
# 0002 does on a new installation.
#
# The decrypted dump never touches the disk: it is piped into pg_restore.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=scripts/lib/backup-common.sh
. "$SCRIPT_DIR/lib/backup-common.sh"

FILE=""; TARGET_DB=""; DRILL=0; KEEP=0; SYNC_ROLES=0; EXISTING=0; YES=0; JOBS=1; MIGRATE_CMD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) load_env_file "$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --existing-empty-db) EXISTING=1; shift ;;
    --drill) DRILL=1; shift ;;
    --keep) KEEP=1; shift ;;
    --sync-roles) SYNC_ROLES=1; shift ;;
    --migrate-cmd) MIGRATE_CMD="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,41p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ -n "$FILE" ] || fail "--file is required"
[ -r "$FILE" ] || fail "cannot read $FILE"
[ -n "$TARGET_DB" ] || fail "--target-db is required"
[[ "$TARGET_DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "--target-db must be a simple lower-case identifier"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || fail "--jobs must be a positive number"
[ "$DRILL" = 1 ] && [ "$SYNC_ROLES" = 1 ] && fail "--drill and --sync-roles cannot be combined (role passwords are cluster-wide)"
need psql; need pg_restore
case "$FILE" in *.age) need age ;; *.enc) need openssl ;; *) fail "expected a *.dump.age or *.dump.enc file" ;; esac

OWNER_URL="${RESTORE_OWNER_URL:-${DATABASE_MIGRATION_URL:-}}"
[ -n "$OWNER_URL" ] || fail "RESTORE_OWNER_URL (or DATABASE_MIGRATION_URL) is not set"
parse_pg_url "$OWNER_URL"
OWNER_ROLE="$PGU_USER"
case "$OWNER_ROLE" in typease_app|typease_system) fail "restore as the schema owner, not as a runtime role" ;; esac

owner_psql() { ( pg_env_from_url "$OWNER_URL"; PGDATABASE="$1"; shift; psql -X -At -v ON_ERROR_STOP=1 "$@" ); }
admin_psql() { ( pg_env_from_url "${RESTORE_ADMIN_URL:-$OWNER_URL}"; psql -X -At -v ON_ERROR_STOP=1 "$@" ); }

STARTED="$(date -u +%s)"
log "restore of $(basename "$FILE") into database \"$TARGET_DB\" as \"$OWNER_ROLE\" on $PGU_HOST:$PGU_PORT$([ "$DRILL" = 1 ] && echo ' (DRILL)')"

# --- 1. integrity of the encrypted file ------------------------------------------------------
if [ -r "$FILE.sha256" ]; then
  EXPECTED="$(cut -d' ' -f1 < "$FILE.sha256")"
  ACTUAL="$(sha256_of "$FILE")"
  [ "$EXPECTED" = "$ACTUAL" ] || fail "checksum mismatch: the backup file is corrupt or was modified"
  log "checksum ok (${ACTUAL:0:16}...)"
else
  log "WARNING: no .sha256 file next to the backup - integrity of the ciphertext is not checked"
fi

# --- 2. the target must be a fresh database --------------------------------------------------
EXISTS="$(admin_psql -c "SELECT count(*) FROM pg_database WHERE datname = '$TARGET_DB'")" || fail "cannot connect to the target cluster"
if [ "$EXISTING" = 1 ]; then
  [ "$EXISTS" = 1 ] || fail "--existing-empty-db was given but database \"$TARGET_DB\" does not exist"
  OBJECTS="$(owner_psql "$TARGET_DB" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'")"
  [ "$OBJECTS" = 0 ] || fail "database \"$TARGET_DB\" is not empty ($OBJECTS objects). Restore only into a fresh database."
else
  [ "$EXISTS" = 0 ] || fail "database \"$TARGET_DB\" already exists. Choose another name, or drop / rename it yourself first; this script never overwrites a database."
fi

if [ "$YES" != 1 ]; then
  printf 'Restore %s into NEW database "%s" on %s:%s ? Type the database name to continue: ' "$(basename "$FILE")" "$TARGET_DB" "$PGU_HOST" "$PGU_PORT"
  read -r answer
  [ "$answer" = "$TARGET_DB" ] || fail "aborted"
fi

CREATED=0
cleanup() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$CREATED" = 1 ] && [ "$KEEP" != 1 ]; then
    log "restore failed - dropping the incomplete database \"$TARGET_DB\""
    admin_psql -c "DROP DATABASE IF EXISTS \"$TARGET_DB\"" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

if [ "$EXISTING" != 1 ]; then
  admin_psql -c "CREATE DATABASE \"$TARGET_DB\" OWNER \"$OWNER_ROLE\" ENCODING 'UTF8'" >/dev/null \
    || fail "CREATE DATABASE failed: set RESTORE_ADMIN_URL to a role that may create databases, or create an empty database yourself and use --existing-empty-db"
  CREATED=1
  log "created database \"$TARGET_DB\""
fi

# --- 3. runtime roles must exist before the archive's GRANTs and policies are replayed -------
owner_psql "$TARGET_DB" >/dev/null <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'typease_app') THEN CREATE ROLE typease_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'typease_system') THEN CREATE ROLE typease_system NOLOGIN; END IF;
END $$;
SQL
ROLE_CHECK="$(owner_psql "$TARGET_DB" -c "SELECT string_agg(rolname || ':' || (rolsuper OR rolbypassrls)::text, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('typease_app','typease_system')")"
case "$ROLE_CHECK" in *typease_app:true*) fail "typease_app is SUPERUSER or BYPASSRLS on this cluster: tenant isolation would not be enforced" ;; esac
log "runtime roles present"

# --- 4. decrypt | pg_restore -------------------------------------------------------------------
# --no-owner: every object is created by (and owned by) the role that restores = the schema
# owner, whatever the owner was called on the source cluster. GRANTs and policies are kept.
RESTORE_ARGS=(--no-owner --exit-on-error --dbname "$TARGET_DB")
if [ "$JOBS" = 1 ]; then RESTORE_ARGS+=(--single-transaction); fi
if [ "$JOBS" = 1 ]; then
  ( pg_env_from_url "$OWNER_URL"; decrypt_stream "$FILE" | pg_restore "${RESTORE_ARGS[@]}" )
else
  # Parallel restore needs a seekable file: decrypt into a private temporary directory in RAM-backed
  # /dev/shm when available, and remove it immediately afterwards.
  WORK="$(mktemp -d "${TMPDIR:-/dev/shm}/typease-restore.XXXXXX" 2>/dev/null || mktemp -d)"
  ( trap 'rm -rf "$WORK"' EXIT; decrypt_stream "$FILE" > "$WORK/dump"; pg_env_from_url "$OWNER_URL"; pg_restore "${RESTORE_ARGS[@]}" --jobs "$JOBS" "$WORK/dump" )
fi
log "archive restored"

# --- 5. migrations + role passwords (not for drills) -------------------------------------------
if [ "$SYNC_ROLES" = 1 ]; then
  [ -n "${DATABASE_URL:-}" ] && [ -n "${DATABASE_SYSTEM_URL:-}" ] || fail "--sync-roles needs DATABASE_URL and DATABASE_SYSTEM_URL (their passwords are applied to the roles)"
  # Same owner connection, but pointing at the restored database (replace the path segment only).
  URL_BASE="${OWNER_URL%%\?*}"; URL_QUERY=""
  if [[ "$OWNER_URL" == *\?* ]]; then URL_QUERY="?${OWNER_URL#*\?}"; fi
  TARGET_OWNER_URL="${URL_BASE%/*}/$TARGET_DB$URL_QUERY"
  log "running the migration runner (pending migrations + role passwords)"
  if [ -n "$MIGRATE_CMD" ]; then
    DATABASE_MIGRATION_URL="$TARGET_OWNER_URL" bash -c "$MIGRATE_CMD"
  else
    need pnpm
    ( cd "$REPO_ROOT" && DATABASE_MIGRATION_URL="$TARGET_OWNER_URL" pnpm --filter @typease/database migrate )
  fi
else
  log "role passwords were NOT changed (use --sync-roles for a real recovery)"
fi

# --- 6. sanity checks ---------------------------------------------------------------------------
CHECKS_OK=1
check() { # name, actual, expectation description, ok(0/1)
  if [ "$4" = 1 ]; then log "  ok    $1: $2"; else log "  FAIL  $1: $2 (expected $3)"; CHECKS_OK=0; fi
}
MANIFEST="${FILE%.dump.*}.manifest.json"
# manifest_value KEY - value of a string ("key": "a,b") or number ("key": 12) field.
manifest_value() {
  [ -r "$MANIFEST" ] || return 0
  sed -n -e "s/^ *\"$1\": *\"\(.*\)\",\{0,1\} *$/\1/p" -e "s/^ *\"$1\": *\([0-9][0-9]*\),\{0,1\} *$/\1/p" "$MANIFEST" | head -n 1
}

read -r R_TABLES R_RLS R_POLICIES R_TRIGGERS R_TENANTS R_USERS R_OWNED_BY_OTHERS <<< "$(owner_psql "$TARGET_DB" -F ' ' -c "
  SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'),
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity),
         (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
         (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal),
         (SELECT count(*) FROM tenants), (SELECT count(*) FROM users),
         (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner <> current_user)")"
R_MIGRATIONS="$(owner_psql "$TARGET_DB" -c "SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM schema_migrations")"
R_NO_RLS="$(owner_psql "$TARGET_DB" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)")"
R_APP_GRANTS="$(owner_psql "$TARGET_DB" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND has_table_privilege('typease_app', c.oid, 'SELECT')")"
R_APPEND_ONLY="$(owner_psql "$TARGET_DB" -c "SELECT count(*) FROM pg_trigger WHERE tgname = 'append_only' AND tgenabled <> 'D'")"

log "sanity checks on \"$TARGET_DB\":"
check "tables" "$R_TABLES" "> 0" "$([ "$R_TABLES" -gt 0 ] && echo 1 || echo 0)"
check "tables with row-level security" "$R_RLS" "> 0" "$([ "$R_RLS" -gt 0 ] && echo 1 || echo 0)"
check "tenant tables WITHOUT row-level security" "$R_NO_RLS" "0" "$([ "$R_NO_RLS" = 0 ] && echo 1 || echo 0)"
check "policies" "$R_POLICIES" "> 0" "$([ "$R_POLICIES" -gt 0 ] && echo 1 || echo 0)"
check "triggers" "$R_TRIGGERS" "> 0" "$([ "$R_TRIGGERS" -gt 0 ] && echo 1 || echo 0)"
check "append-only triggers enabled" "$R_APPEND_ONLY" ">= 7" "$([ "$R_APPEND_ONLY" -ge 7 ] && echo 1 || echo 0)"
check "tables readable by typease_app (GRANTs restored)" "$R_APP_GRANTS" "> 0" "$([ "$R_APP_GRANTS" -gt 0 ] && echo 1 || echo 0)"
check "tables not owned by $OWNER_ROLE" "$R_OWNED_BY_OTHERS" "0" "$([ "$R_OWNED_BY_OTHERS" = 0 ] && echo 1 || echo 0)"
if [ -r "$MANIFEST" ]; then
  M_TABLES="$(manifest_value tables)"; M_TENANTS="$(manifest_value tenants)"; M_USERS="$(manifest_value users)"; M_MIGRATIONS="$(manifest_value migrations)"
  check "table count equals the manifest" "$R_TABLES" "$M_TABLES" "$([ "$R_TABLES" = "$M_TABLES" ] && echo 1 || echo 0)"
  check "tenant count equals the manifest" "$R_TENANTS" "$M_TENANTS" "$([ "$R_TENANTS" = "$M_TENANTS" ] && echo 1 || echo 0)"
  check "user count equals the manifest" "$R_USERS" "$M_USERS" "$([ "$R_USERS" = "$M_USERS" ] && echo 1 || echo 0)"
  if [ "$SYNC_ROLES" = 1 ]; then
    log "  info  migrations after the runner: $R_MIGRATIONS (backup had: $M_MIGRATIONS)"
  else
    check "applied migrations equal the manifest" "$R_MIGRATIONS" "$M_MIGRATIONS" "$([ "$R_MIGRATIONS" = "$M_MIGRATIONS" ] && echo 1 || echo 0)"
  fi
else
  log "  info  no manifest next to the backup: counts are $R_TENANTS tenants, $R_USERS users, migrations $R_MIGRATIONS"
fi

FINISHED="$(date -u +%s)"
DURATION=$((FINISHED - STARTED))

# --- 7. drill bookkeeping ----------------------------------------------------------------------
if [ "$DRILL" = 1 ]; then
  DRILL_DIR="$(dirname "${BACKUP_MARKER_FILE:-${BACKUP_DIR:-$(dirname "$FILE")}/last-success.json}")"
  if [ "$CHECKS_OK" = 1 ]; then
    mkdir -p "$DRILL_DIR"
    cat > "$DRILL_DIR/last-restore-drill.json" <<JSON
{
  "completedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "backupFile": "$(basename "$FILE")",
  "restoredInto": "$(json_escape "$TARGET_DB")",
  "durationSeconds": $DURATION,
  "tables": $R_TABLES,
  "tenants": $R_TENANTS,
  "users": $R_USERS,
  "result": "ok"
}
JSON
    log "drill record written: $DRILL_DIR/last-restore-drill.json"
  fi
  if [ "$KEEP" != 1 ] && [ "$EXISTING" != 1 ]; then
    admin_psql -c "DROP DATABASE \"$TARGET_DB\"" >/dev/null && log "drill database \"$TARGET_DB\" dropped"
  elif [ "$KEEP" != 1 ]; then
    log "the drill database \"$TARGET_DB\" was created outside this script: drop it yourself"
  fi
fi

trap - EXIT
if [ "$CHECKS_OK" = 1 ]; then
  log "restore finished in ${DURATION}s - all sanity checks passed (this duration is your measured restore time for the RTO)"
else
  fail "restore finished in ${DURATION}s but at least one sanity check FAILED"
fi
