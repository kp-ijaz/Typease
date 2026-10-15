#!/bin/sh
# One-shot object-storage setup for the bundled MinIO (runs in the minio/mc image).
# Idempotent: safe to run on every `docker compose up`.
#
#   * private documents bucket  - NO anonymous policy; verified below, the job fails if it is public
#   * lifecycle on that bucket  - objects under incoming/ (abandoned or replayed uploads) expire after 1 day
#   * public assets bucket      - anonymous read-only (logos, favicons); nothing private is ever stored there
#   * an application user with access to exactly these two buckets (the API never uses the root user)
#
# For AWS S3 / other providers the equivalent commands are in docs/deployment/object-storage.md.
set -eu

: "${MINIO_ROOT_USER:?}" "${MINIO_ROOT_PASSWORD:?}"
: "${S3_BUCKET:?}" "${S3_PUBLIC_ASSETS_BUCKET:?}"
: "${S3_ACCESS_KEY_ID:?}" "${S3_SECRET_ACCESS_KEY:?}"
MINIO_URL="${MINIO_URL:-http://minio:9000}"
CONFIG_DIR="${CONFIG_DIR:-/config}"

if [ "$S3_BUCKET" = "$S3_PUBLIC_ASSETS_BUCKET" ]; then
  echo "S3_BUCKET and S3_PUBLIC_ASSETS_BUCKET must be different buckets." >&2
  exit 1
fi

echo "Waiting for MinIO at $MINIO_URL ..."
i=0
until mc alias set typease "$MINIO_URL" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && { echo "MinIO did not become reachable." >&2; exit 1; }
  sleep 2
done

mc mb --ignore-existing "typease/$S3_BUCKET"
mc mb --ignore-existing "typease/$S3_PUBLIC_ASSETS_BUCKET"

# Lifecycle (replaces the bucket's lifecycle configuration with the file's content).
mc ilm rule import "typease/$S3_BUCKET" < "$CONFIG_DIR/lifecycle-documents.json"

# Optional versioning: protects against accidental deletes / overwrites and is required
# for bucket replication. Old versions then need their own expiry rule (see the docs).
if [ "${S3_VERSIONING:-false}" = "true" ]; then
  mc version enable "typease/$S3_BUCKET"
fi

# Public read for the assets bucket only.
mc anonymous set download "typease/$S3_PUBLIC_ASSETS_BUCKET"

# The documents bucket must have no anonymous access at all.
access="$(mc anonymous get "typease/$S3_BUCKET" 2>&1 || true)"
echo "$access"
case "$access" in
  *download*|*upload*|*public*|*custom*)
    echo "The documents bucket \"$S3_BUCKET\" has an anonymous access policy. Refusing to continue." >&2
    exit 1
    ;;
esac

# Least-privilege application user: objects of exactly these two buckets.
# ListBucket is included so that a missing key answers 404 instead of 403.
cat > /tmp/policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET}/*", "arn:aws:s3:::${S3_PUBLIC_ASSETS_BUCKET}/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": ["arn:aws:s3:::${S3_BUCKET}", "arn:aws:s3:::${S3_PUBLIC_ASSETS_BUCKET}"]
    }
  ]
}
POLICY
mc admin user add typease "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"
mc admin policy create typease typease-app /tmp/policy.json
mc admin policy attach typease typease-app --user "$S3_ACCESS_KEY_ID" 2>/dev/null \
  || echo "policy typease-app is already attached to the application user"

echo "Object storage is ready: private bucket \"$S3_BUCKET\" (incoming/ expires after 1 day), public bucket \"$S3_PUBLIC_ASSETS_BUCKET\"."
