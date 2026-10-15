#!/usr/bin/env bash
# Prints a fresh set of secrets for a TypEase environment.
#
#   scripts/generate-secrets.sh                 # all secrets, grouped by the env file they belong to
#   scripts/generate-secrets.sh --only typease  # one group: typease | database | redis | minio | n8n | monitoring
#
# The values go to STANDARD OUTPUT ONLY. Nothing is written to disk by this script, and it
# refuses to run when its output is redirected to a file inside this repository: paste the
# values into your secret manager or into /etc/typease/*.env (chmod 600), never into git.
#
# Every run prints different values. Running it again for an existing environment and
# replacing DATA_ENCRYPTION_KEY, HMAC_KEY or MINIO_KMS_SECRET_KEY makes existing data
# unreadable: rotate those with the documented procedures only (docs/deployment/secrets.md).
set -euo pipefail

ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 2; }

# Refuse to write secrets into the repository.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ ! -t 1 ] && [ -e "/proc/$$/fd/1" ]; then
  target="$(readlink -f "/proc/$$/fd/1" 2>/dev/null || true)"
  case "$target" in
    "$REPO_ROOT"/*)
      echo "Refusing to write secrets to $target (inside the repository)." >&2
      exit 1
      ;;
  esac
fi

# base64 from openssl uses A-Z a-z 0-9 + / = : no '-' or '_', so a value can never contain
# "dev-", "dev_" or "change-me". The loop also rejects the remaining pattern the API treats
# as a placeholder ("example"), so a generated value always passes services/api/src/config/env.ts.
b64() {
  local v
  while :; do
    v="$(openssl rand -base64 "$1" | tr -d '\n')"
    if ! printf '%s' "$v" | grep -qiE 'change-me|dev[-_]|example'; then printf '%s' "$v"; return; fi
  done
}
# Hex is safe inside connection URLs (no characters that need URL-encoding).
hex() { openssl rand -hex "$1" | tr -d '\n'; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

echo "# TypEase secrets generated $(date -u +%Y-%m-%dT%H:%M:%SZ) - store them in a secret manager, not in git."

if want typease; then
  cat <<OUT

# --- typease.env (API + worker) ---------------------------------------------------------
JWT_ACCESS_SECRET=$(b64 48)
HMAC_KEY=$(b64 48)
# 32 random bytes, base64. ESCROW IT: encrypted fields cannot be recovered without it.
DATA_ENCRYPTION_KEY=$(b64 32)
INTERNAL_API_TOKEN=$(b64 32)
PAYMENT_SANDBOX_WEBHOOK_SECRET=$(b64 32)
N8N_WEBHOOK_SECRET=$(b64 32)
OUT
fi

if want database; then
  owner="$(hex 24)"; app="$(hex 24)"; system="$(hex 24)"
  cat <<OUT

# --- PostgreSQL --------------------------------------------------------------------------
# postgres.env
POSTGRES_PASSWORD=$(hex 24)
TYPEASE_DB_OWNER_PASSWORD=$owner
TYPEASE_DB_BACKUP_PASSWORD=$(hex 24)
TYPEASE_DB_MONITOR_PASSWORD=$(hex 24)
# migrate.env  (replace <host> / <db>)
DATABASE_MIGRATION_URL=postgresql://typease_owner:$owner@<host>:5432/<db>
# typease.env
DATABASE_URL=postgresql://typease_app:$app@<host>:5432/<db>
DATABASE_SYSTEM_URL=postgresql://typease_system:$system@<host>:5432/<db>
OUT
fi

if want redis; then
  redis="$(hex 24)"
  cat <<OUT

# --- Redis ---------------------------------------------------------------------------------
# redis.env (and REDIS_PASSWORD in monitoring.env)
REDIS_PASSWORD=$redis
# typease.env
REDIS_URL=redis://:$redis@<host>:6379/0
OUT
fi

if want minio; then
  cat <<OUT

# --- MinIO (bundled object storage) ------------------------------------------------------
# minio.env
MINIO_ROOT_USER=typease-root-$(hex 4)
MINIO_ROOT_PASSWORD=$(hex 24)
# ESCROW IT: no stored object can be decrypted without this key.
MINIO_KMS_SECRET_KEY=typease-kms:$(b64 32)
# typease.env (application user created by the minio-init job)
S3_ACCESS_KEY_ID=typease-app-$(hex 6)
S3_SECRET_ACCESS_KEY=$(hex 32)
OUT
fi

if want n8n; then
  cat <<OUT

# --- n8n.env ---------------------------------------------------------------------------------
# ESCROW IT: credentials stored in n8n cannot be decrypted without it.
N8N_ENCRYPTION_KEY=$(b64 32)
OUT
fi

if want monitoring; then
  cat <<OUT

# --- monitoring.env ----------------------------------------------------------------------
GF_SECURITY_ADMIN_PASSWORD=$(hex 16)
OUT
fi

cat <<'OUT'

# Backups: create the age key pair on a machine that is NOT the server:
#   age-keygen -o typease-backup.agekey     (keep the file offline; put the printed public key
#                                            into BACKUP_AGE_RECIPIENTS in backup.env)
OUT
