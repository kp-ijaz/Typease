#!/usr/bin/env bash
# Shared helpers of db-backup.sh, db-restore.sh and storage-backup.sh. Sourced, not executed.

log()  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { printf '%s ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed${2:+ ($2)}"; }

# load_env_file FILE - exports KEY=VALUE lines without executing the file as a script.
load_env_file() {
  local file="$1" line key value
  [ -r "$file" ] || fail "cannot read env file $file"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}"; value="${BASH_REMATCH[3]}"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    elif [[ "$value" =~ ^(.*[^[:space:]])?[[:space:]]+#.*$ ]]; then
      value="${BASH_REMATCH[1]}"          # unquoted value followed by an inline comment
    fi
    export "$key=$value"
  done < "$file"
}

urldecode() { local s="${1//+/ }"; printf '%b' "${s//%/\\x}"; }

# parse_pg_url URL - sets PGU_USER PGU_PASSWORD PGU_HOST PGU_PORT PGU_DB PGU_SSLMODE.
# The password is never echoed. Passing it to the PostgreSQL tools through PGPASSWORD keeps
# it out of the process list (a connection URL on the command line would be visible in `ps`).
parse_pg_url() {
  local url="$1" rest auth hostport query
  [[ "$url" =~ ^postgres(ql)?:// ]] || fail "not a postgresql:// URL"
  rest="${url#*://}"
  query=""
  if [[ "$rest" == *\?* ]]; then query="${rest#*\?}"; rest="${rest%%\?*}"; fi
  PGU_DB="$(urldecode "${rest#*/}")"; rest="${rest%%/*}"
  auth=""; hostport="$rest"
  if [[ "$rest" == *@* ]]; then auth="${rest%@*}"; hostport="${rest##*@}"; fi
  PGU_USER="$(urldecode "${auth%%:*}")"
  PGU_PASSWORD=""
  if [[ "$auth" == *:* ]]; then PGU_PASSWORD="$(urldecode "${auth#*:}")"; fi
  PGU_HOST="${hostport%%:*}"
  PGU_PORT="5432"
  if [[ "$hostport" == *:* ]]; then PGU_PORT="${hostport##*:}"; fi
  PGU_SSLMODE=""
  if [[ "$query" =~ (^|&)sslmode=([^&]+) ]]; then PGU_SSLMODE="${BASH_REMATCH[2]}"; fi
  [ -n "$PGU_USER" ] && [ -n "$PGU_DB" ] && [ -n "$PGU_HOST" ] || fail "the database URL must contain user, host and database"
}

# pg_env_from_url URL - exports PG* variables for psql / pg_dump / pg_restore.
pg_env_from_url() {
  parse_pg_url "$1"
  export PGUSER="$PGU_USER" PGPASSWORD="$PGU_PASSWORD" PGHOST="$PGU_HOST" PGPORT="$PGU_PORT" PGDATABASE="$PGU_DB"
  if [ -n "$PGU_SSLMODE" ]; then export PGSSLMODE="$PGU_SSLMODE"; else unset PGSSLMODE; fi
  export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}" PGAPPNAME="typease-backup"
}

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
file_size() { wc -c < "$1" | tr -d ' '; }
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# encryption_mode - prints "age" or "openssl-aes-256-cbc"; fails when nothing is configured.
encryption_mode() {
  if [ -n "${BACKUP_AGE_RECIPIENTS:-}" ] && [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    fail "set either BACKUP_AGE_RECIPIENTS or BACKUP_PASSPHRASE, not both"
  elif [ -n "${BACKUP_AGE_RECIPIENTS:-}" ]; then echo age
  elif [ -n "${BACKUP_PASSPHRASE:-}" ]; then echo openssl-aes-256-cbc
  else fail "no encryption configured: set BACKUP_AGE_RECIPIENTS (preferred) or BACKUP_PASSPHRASE. Unencrypted backups are refused."
  fi
}

# encrypt_stream MODE - stdin (plaintext) -> stdout (ciphertext)
encrypt_stream() {
  case "$1" in
    age)
      local args=() r
      IFS=',' read -ra recipients <<< "$BACKUP_AGE_RECIPIENTS"
      for r in "${recipients[@]}"; do r="${r// /}"; [ -n "$r" ] && args+=(-r "$r"); done
      age "${args[@]}"
      ;;
    openssl-aes-256-cbc)
      # PBKDF2 with a high iteration count; the passphrase is read from the environment,
      # never from the command line. CBC is not authenticated: integrity is checked with
      # the .sha256 file written next to the backup.
      openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:BACKUP_PASSPHRASE
      ;;
    *) fail "unknown encryption mode $1" ;;
  esac
}

# decrypt_stream FILE - ciphertext file -> stdout (plaintext). Mode from the file extension.
decrypt_stream() {
  case "$1" in
    *.age)
      [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ] || fail "BACKUP_AGE_IDENTITY_FILE (the age private key) is required to decrypt $1"
      [ -r "$BACKUP_AGE_IDENTITY_FILE" ] || fail "cannot read the age identity file"
      age -d -i "$BACKUP_AGE_IDENTITY_FILE" "$1"
      ;;
    *.enc)
      [ -n "${BACKUP_PASSPHRASE:-}" ] || fail "BACKUP_PASSPHRASE is required to decrypt $1"
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE -in "$1"
      ;;
    *) fail "cannot tell how $1 is encrypted (expected *.age or *.enc)" ;;
  esac
}
