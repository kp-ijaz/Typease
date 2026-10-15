#!/usr/bin/env bash
# TypEase database backup: pg_dump (custom format, compressed) -> encrypted -> local file
# -> optional off-site copy -> retention pruning -> marker + metric for monitoring.
#
#   scripts/db-backup.sh --env-file /etc/typease/backup.env
#   BACKUP_DATABASE_URL=... BACKUP_AGE_RECIPIENTS=age1... BACKUP_DIR=/var/backups/typease scripts/db-backup.sh
#   scripts/db-backup.sh --env-file backup.env --verify      # also decrypt and list the archive (needs the key)
#
# WHICH ROLE?  A backup must contain every tenant's rows. The runtime roles typease_app and
# typease_system CANNOT be used: row-level security hides other tenants' rows from
# typease_app, neither role may read every table (observed: "permission denied for table
# schema_migrations"), and pg_dump runs with row_security = off, which makes PostgreSQL
# raise an error rather than write a silently filtered dump. Use
#   * the read-only role typease_backup (BYPASSRLS + pg_read_all_data) - recommended, or
#   * the schema owner (DATABASE_MIGRATION_URL): the owner of a table is not subject to RLS.
# This script refuses typease_app and typease_system.
#
# Configuration (environment or --env-file; template: infrastructure/deployment/env/backup.env.example)
#   BACKUP_DATABASE_URL       connection used for the dump (falls back to DATABASE_MIGRATION_URL)
#   BACKUP_DIR                target directory (default ./backups - choose a path outside the repository)
#   BACKUP_AGE_RECIPIENTS     age public key(s), comma separated   } exactly one of the two;
#   BACKUP_PASSPHRASE         passphrase for openssl AES-256-CBC   } unencrypted backups are refused
#   BACKUP_RETENTION_DAYS     local retention (default 14)
#   BACKUP_S3_URI             optional off-site target, s3://bucket/prefix (aws CLI) or an mc alias path
#   BACKUP_S3_ENDPOINT        optional endpoint URL for S3-compatible stores (aws CLI)
#   BACKUP_UPLOAD_TOOL        aws (default) | mc
#   BACKUP_EXEC_PREFIX        run pg_dump / psql through this command, e.g. for the bundled database
#                             (not reachable from the host):
#                             "docker compose --env-file /etc/typease/compose.env -f /opt/typease/docker-compose.prod.yml exec -T postgres"
#                             The tools then connect over the container's local socket as the URL's user.
#   BACKUP_MARKER_FILE        default $BACKUP_DIR/last-success.json   (read by scripts/production-readiness.mjs)
#   BACKUP_METRICS_DIR        default $BACKUP_DIR/metrics             (node-exporter textfile collector)
#
# The dump never touches the disk unencrypted: pg_dump is piped straight into the cipher.
# Secrets are never printed. Exit code 0 only when the encrypted file was written (and
# uploaded, when an off-site target is configured).
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/backup-common.sh
. "$SCRIPT_DIR/lib/backup-common.sh"

VERIFY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) load_env_file "$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

DB_URL="${BACKUP_DATABASE_URL:-${DATABASE_MIGRATION_URL:-}}"
[ -n "$DB_URL" ] || fail "BACKUP_DATABASE_URL (or DATABASE_MIGRATION_URL) is not set"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
MARKER_FILE="${BACKUP_MARKER_FILE:-$BACKUP_DIR/last-success.json}"
METRICS_DIR="${BACKUP_METRICS_DIR:-$BACKUP_DIR/metrics}"
UPLOAD_TOOL="${BACKUP_UPLOAD_TOOL:-aws}"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail "BACKUP_RETENTION_DAYS must be a number"

MODE="$(encryption_mode)"
case "$MODE" in
  age) need age "https://github.com/FiloSottile/age"; EXT="age" ;;
  *) need openssl; EXT="enc" ;;
esac

parse_pg_url "$DB_URL"
case "$PGU_USER" in
  typease_app|typease_system)
    fail "the role \"$PGU_USER\" is subject to row-level security and cannot produce a complete dump. Use typease_backup or the schema owner." ;;
esac

# pg_dump / psql either run here (credentials through PG* environment variables) or
# inside the database container through BACKUP_EXEC_PREFIX (local socket, no password).
if [ -n "${BACKUP_EXEC_PREFIX:-}" ]; then
  read -ra EXEC <<< "$BACKUP_EXEC_PREFIX"
  CONN=(-U "$PGU_USER" -d "$PGU_DB")
else
  need pg_dump "PostgreSQL client tools, same major version as the server or newer"
  need psql
  EXEC=()
  CONN=()
  pg_env_from_url "$DB_URL"
fi
run_psql()    { ${EXEC[@]+"${EXEC[@]}"} psql -X -At -v ON_ERROR_STOP=1 ${CONN[@]+"${CONN[@]}"} "$@"; }
run_pg_dump() { ${EXEC[@]+"${EXEC[@]}"} pg_dump ${CONN[@]+"${CONN[@]}"} "$@"; }

mkdir -p "$BACKUP_DIR" "$METRICS_DIR"
chmod 700 "$BACKUP_DIR"
chmod 755 "$METRICS_DIR"

# One backup at a time.
if command -v flock >/dev/null 2>&1; then
  exec 9> "$BACKUP_DIR/.db-backup.lock"
  flock -n 9 || fail "another backup is running (lock: $BACKUP_DIR/.db-backup.lock)"
fi

STARTED="$(date -u +%s)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="typease-${PGU_DB}-${STAMP}"
FILE="$BACKUP_DIR/$BASE.dump.$EXT"
TMP="$FILE.partial"
trap 'rm -f "$TMP"' EXIT

log "backup of database \"$PGU_DB\" as \"$PGU_USER\" (encryption: $MODE)"

# --- pre-flight: reachable, and able to see every row ------------------------------------
SERVER_VERSION="$(run_psql -c "SHOW server_version")" || fail "cannot connect to the database"
CAN_READ_ALL="$(run_psql -c "SELECT (r.rolsuper OR r.rolbypassrls OR NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relowner <> r.oid))::text
    FROM pg_roles r WHERE r.rolname = current_user")"
[ "$CAN_READ_ALL" = "true" ] || fail "\"$PGU_USER\" neither owns the tables nor has BYPASSRLS: the dump would be refused or incomplete"

# --- manifest (not secret: names and counts only; used to sanity-check a restore) -----------
MIGRATIONS="$(run_psql -c "SELECT coalesce(string_agg(name, ',' ORDER BY name), '') FROM schema_migrations" 2>/dev/null || echo "")"
COUNTS="$(run_psql -F ' ' -c "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'),
                                     (SELECT count(*) FROM tenants), (SELECT count(*) FROM users)" 2>/dev/null || echo "0 0 0")"
read -r N_TABLES N_TENANTS N_USERS <<< "$COUNTS"

# --- dump | encrypt ------------------------------------------------------------------------
# Custom format: compressed, restorable selectively and in parallel with pg_restore.
# --no-owner is NOT used here: ownership and GRANTs are part of the archive (the restore
# script decides what to apply).
run_pg_dump --format=custom --compress=6 --no-password --lock-wait-timeout=60000 \
  | encrypt_stream "$MODE" > "$TMP"

BYTES="$(file_size "$TMP")"
[ "$BYTES" -gt 1024 ] || fail "the backup is only $BYTES bytes: something went wrong"
mv "$TMP" "$FILE"
trap - EXIT
SHA="$(sha256_of "$FILE")"
printf '%s  %s\n' "$SHA" "$(basename "$FILE")" > "$FILE.sha256"

cat > "$BACKUP_DIR/$BASE.manifest.json" <<JSON
{
  "file": "$(basename "$FILE")",
  "database": "$(json_escape "$PGU_DB")",
  "dumpedAs": "$(json_escape "$PGU_USER")",
  "serverVersion": "$(json_escape "$SERVER_VERSION")",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "encryption": "$MODE",
  "bytes": $BYTES,
  "sha256": "$SHA",
  "migrations": "$(json_escape "$MIGRATIONS")",
  "tables": ${N_TABLES:-0},
  "tenants": ${N_TENANTS:-0},
  "users": ${N_USERS:-0}
}
JSON
log "written $(basename "$FILE") ($BYTES bytes, sha256 ${SHA:0:16}...)"

# --- optional verification: decrypt and read the archive's table of contents ----------------
if [ "$VERIFY" = 1 ]; then
  need pg_restore
  # The whole stream is consumed (cat) so that the decryption runs to the end: with age every
  # chunk is authenticated, a truncated or modified file fails here.
  TOC="$(mktemp)"
  if ! decrypt_stream "$FILE" | { pg_restore --list > "$TOC"; cat > /dev/null; }; then
    rm -f "$TOC"; fail "verification failed: the backup could not be decrypted completely"
  fi
  ENTRIES="$(grep -c -v '^;' "$TOC" || true)"; rm -f "$TOC"
  [ "${ENTRIES:-0}" -gt 0 ] || fail "verification failed: the archive has no table of contents"
  log "verified: the archive decrypts completely and lists $ENTRIES objects"
fi

# --- off-site copy -------------------------------------------------------------------------
OFFSITE=false
OFFSITE_TARGET=""
if [ -n "${BACKUP_S3_URI:-}" ]; then
  OFFSITE_TARGET="${BACKUP_S3_URI%/}"
  case "$UPLOAD_TOOL" in
    aws)
      need aws "AWS CLI v2"
      AWS_ARGS=()
      [ -n "${BACKUP_S3_ENDPOINT:-}" ] && AWS_ARGS+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
      for f in "$FILE" "$FILE.sha256" "$BACKUP_DIR/$BASE.manifest.json"; do
        aws ${AWS_ARGS[@]+"${AWS_ARGS[@]}"} s3 cp --only-show-errors "$f" "$OFFSITE_TARGET/$(basename "$f")"
      done
      ;;
    mc)
      need mc "MinIO client"
      mc cp --quiet "$FILE" "$FILE.sha256" "$BACKUP_DIR/$BASE.manifest.json" "$OFFSITE_TARGET/"
      ;;
    *) fail "BACKUP_UPLOAD_TOOL must be aws or mc" ;;
  esac
  OFFSITE=true
  log "uploaded to $OFFSITE_TARGET"
else
  log "WARNING: BACKUP_S3_URI is not set - the backup exists only on this host"
fi

# --- retention (only after a successful backup; never removes the file just written) -------
if [ "$RETENTION_DAYS" -gt 0 ]; then
  PRUNED=0
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    [ "$old" = "$FILE" ] && continue
    rm -f "$old" "$old.sha256" "${old%.dump.*}.manifest.json"
    PRUNED=$((PRUNED + 1))
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'typease-*.dump.*' ! -name '*.sha256' ! -name '*.partial' -mtime +"$RETENTION_DAYS" 2>/dev/null)
  log "retention: removed $PRUNED local backup(s) older than $RETENTION_DAYS days"
fi

# --- marker + metrics ------------------------------------------------------------------------
FINISHED="$(date -u +%s)"
DURATION=$((FINISHED - STARTED))
cat > "$MARKER_FILE.tmp" <<JSON
{
  "completedAt": "$(date -u -d "@$FINISHED" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)",
  "file": "$(basename "$FILE")",
  "bytes": $BYTES,
  "sha256": "$SHA",
  "encryption": "$MODE",
  "database": "$(json_escape "$PGU_DB")",
  "durationSeconds": $DURATION,
  "offsite": $OFFSITE,
  "offsiteTarget": "$(json_escape "$OFFSITE_TARGET")"
}
JSON
mv "$MARKER_FILE.tmp" "$MARKER_FILE"
chmod 644 "$MARKER_FILE" 2>/dev/null || true

cat > "$METRICS_DIR/typease_backup.prom.tmp" <<PROM
# HELP typease_backup_last_success_timestamp_seconds Unix time of the last successful encrypted database backup.
# TYPE typease_backup_last_success_timestamp_seconds gauge
typease_backup_last_success_timestamp_seconds $FINISHED
# HELP typease_backup_last_size_bytes Size of the last encrypted database backup.
# TYPE typease_backup_last_size_bytes gauge
typease_backup_last_size_bytes $BYTES
# HELP typease_backup_last_duration_seconds Duration of the last database backup.
# TYPE typease_backup_last_duration_seconds gauge
typease_backup_last_duration_seconds $DURATION
# HELP typease_backup_last_offsite 1 when the last backup was copied to off-site storage.
# TYPE typease_backup_last_offsite gauge
typease_backup_last_offsite $([ "$OFFSITE" = true ] && echo 1 || echo 0)
PROM
chmod 644 "$METRICS_DIR/typease_backup.prom.tmp"
mv "$METRICS_DIR/typease_backup.prom.tmp" "$METRICS_DIR/typease_backup.prom"

log "backup finished in ${DURATION}s: $FILE"
