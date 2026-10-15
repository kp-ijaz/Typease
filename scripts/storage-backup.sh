#!/usr/bin/env bash
# TypEase object-storage backup.
#
# The database backup alone is NOT enough: documents live in the object store, the database
# only holds their keys and metadata. Back up both, and keep the keys that decrypt them
# (DATA_ENCRYPTION_KEY, and MINIO_KMS_SECRET_KEY for the bundled MinIO).
#
# Mode s3 (STORAGE_DRIVER=s3) - mirror the documents bucket to a second bucket / provider:
#   scripts/storage-backup.sh --env-file /etc/typease/backup.env
#     STORAGE_BACKUP_SOURCE            s3://typease-prod-documents            (aws) | alias/bucket (mc)
#     STORAGE_BACKUP_TARGET            s3://typease-prod-documents-replica    (aws) | alias/bucket (mc)
#     STORAGE_BACKUP_SOURCE_ENDPOINT   endpoint URL of the source (S3-compatible stores; aws only)
#     STORAGE_BACKUP_TARGET_ENDPOINT   endpoint URL of the target, when it is a DIFFERENT provider (aws only)
#     STORAGE_BACKUP_TOOL              aws (default) | mc
#     STORAGE_BACKUP_DELETE            true = also delete objects that disappeared from the source
#                                      (default false: a mirror that follows deletions is not a backup)
#   The staging prefix incoming/ is skipped (abandoned uploads, expired after one day).
#   With two different endpoints the aws CLI cannot copy server-side: the script then syncs
#   through a temporary local directory (needs free disk space for the whole bucket). Prefer
#   `mc mirror` or - better - the provider's own bucket replication for that case.
#
# Mode local (STORAGE_DRIVER=local) - encrypted tar archive of STORAGE_LOCAL_DIR:
#   scripts/storage-backup.sh --local /var/lib/typease/storage --env-file /etc/typease/backup.env
#     BACKUP_DIR, BACKUP_AGE_RECIPIENTS | BACKUP_PASSPHRASE, BACKUP_RETENTION_DAYS as for db-backup.sh
#   (The files are already AES-256-GCM encrypted by the API; the archive is encrypted again so
#    that file names, sizes and the public assets are protected too.)
#
# PREFERRED OVER THIS SCRIPT for real production: bucket VERSIONING (protects against
# overwrite / delete, also by a compromised application key) plus provider-side REPLICATION
# to another region or account. See docs/security/BACKUP_AND_RECOVERY.md.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/backup-common.sh
. "$SCRIPT_DIR/lib/backup-common.sh"

LOCAL_DIR=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) load_env_file "$2"; shift 2 ;;
    --local) LOCAL_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

STARTED="$(date -u +%s)"

# ------------------------------------------------------------------ local driver
if [ -n "$LOCAL_DIR" ]; then
  [ -d "$LOCAL_DIR" ] || fail "$LOCAL_DIR is not a directory"
  need tar
  BACKUP_DIR="${BACKUP_DIR:-./backups}"
  RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
  MODE="$(encryption_mode)"
  case "$MODE" in age) need age; EXT="age" ;; *) need openssl; EXT="enc" ;; esac
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  FILE="$BACKUP_DIR/typease-storage-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.$EXT"
  FILES="$(find "$LOCAL_DIR" -type f | wc -l | tr -d ' ')"
  if [ "$DRY_RUN" = 1 ]; then log "dry run: would archive $FILES file(s) from $LOCAL_DIR into $FILE"; exit 0; fi
  trap 'rm -f "$FILE.partial"' EXIT
  tar -C "$LOCAL_DIR" -czf - . | encrypt_stream "$MODE" > "$FILE.partial"
  mv "$FILE.partial" "$FILE"; trap - EXIT
  SHA="$(sha256_of "$FILE")"
  printf '%s  %s\n' "$SHA" "$(basename "$FILE")" > "$FILE.sha256"
  if [ -n "${BACKUP_S3_URI:-}" ]; then
    need aws "AWS CLI v2"
    AWS_ARGS=(); [ -n "${BACKUP_S3_ENDPOINT:-}" ] && AWS_ARGS+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
    aws ${AWS_ARGS[@]+"${AWS_ARGS[@]}"} s3 cp --only-show-errors "$FILE" "${BACKUP_S3_URI%/}/$(basename "$FILE")"
    aws ${AWS_ARGS[@]+"${AWS_ARGS[@]}"} s3 cp --only-show-errors "$FILE.sha256" "${BACKUP_S3_URI%/}/$(basename "$FILE").sha256"
    log "uploaded to ${BACKUP_S3_URI%/}"
  fi
  if [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -gt 0 ]; then
    find "$BACKUP_DIR" -maxdepth 1 -type f -name 'typease-storage-*.tar.gz.*' ! -name "$(basename "$FILE")*" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
  fi
  log "storage archive written: $FILE ($(file_size "$FILE") bytes, $FILES files, $(( $(date -u +%s) - STARTED ))s, encryption $MODE)"
  exit 0
fi

# ------------------------------------------------------------------ S3 mirror
SRC="${STORAGE_BACKUP_SOURCE:-}"; DST="${STORAGE_BACKUP_TARGET:-}"
[ -n "$SRC" ] && [ -n "$DST" ] || fail "set STORAGE_BACKUP_SOURCE and STORAGE_BACKUP_TARGET (or use --local <dir>)"
[ "${SRC%/}" != "${DST%/}" ] || fail "source and target are the same bucket"
TOOL="${STORAGE_BACKUP_TOOL:-aws}"
DELETE="${STORAGE_BACKUP_DELETE:-false}"

case "$TOOL" in
  aws)
    need aws "AWS CLI v2"
    SYNC_ARGS=(--only-show-errors --exclude 'incoming/*')
    [ "$DELETE" = true ] && SYNC_ARGS+=(--delete)
    [ "$DRY_RUN" = 1 ] && SYNC_ARGS+=(--dryrun)
    SRC_EP="${STORAGE_BACKUP_SOURCE_ENDPOINT:-}"; DST_EP="${STORAGE_BACKUP_TARGET_ENDPOINT:-$SRC_EP}"
    if [ "$SRC_EP" = "$DST_EP" ]; then
      EP=(); [ -n "$SRC_EP" ] && EP+=(--endpoint-url "$SRC_EP")
      aws ${EP[@]+"${EP[@]}"} s3 sync "${SYNC_ARGS[@]}" "$SRC" "$DST"
    else
      WORK="$(mktemp -d "${STORAGE_BACKUP_WORKDIR:-${TMPDIR:-/tmp}}/typease-storage.XXXXXX")"
      trap 'rm -rf "$WORK"' EXIT
      log "different endpoints: syncing through $WORK"
      SE=(); [ -n "$SRC_EP" ] && SE+=(--endpoint-url "$SRC_EP")
      DE=(); [ -n "$DST_EP" ] && DE+=(--endpoint-url "$DST_EP")
      aws ${SE[@]+"${SE[@]}"} s3 sync --only-show-errors --exclude 'incoming/*' "$SRC" "$WORK"
      aws ${DE[@]+"${DE[@]}"} s3 sync "${SYNC_ARGS[@]}" "$WORK" "$DST"
    fi
    ;;
  mc)
    need mc "MinIO client; configure the aliases first with: mc alias set <name> <url> <key> <secret>"
    MIRROR_ARGS=(--quiet --preserve --exclude 'incoming/*')
    [ "$DELETE" = true ] && MIRROR_ARGS+=(--remove)
    [ "$DRY_RUN" = 1 ] && MIRROR_ARGS+=(--dry-run)
    mc mirror "${MIRROR_ARGS[@]}" "$SRC" "$DST"
    ;;
  *) fail "STORAGE_BACKUP_TOOL must be aws or mc" ;;
esac
log "object storage mirrored: $SRC -> $DST in $(( $(date -u +%s) - STARTED ))s (deletions $([ "$DELETE" = true ] && echo propagated || echo 'NOT propagated'))"
