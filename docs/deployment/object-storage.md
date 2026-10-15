# Object storage

The API stores documents in a **private** bucket and logos in a **public-read** bucket of
any S3-compatible store (`STORAGE_DRIVER=s3`). Browsers upload and download documents
directly through short-lived presigned URLs; the application never makes an object public
and never sets ACLs. Details of the application side: `docs/api/modules/documents.md`,
section "Storage drivers and operations".

> The S3 driver was not exercised against a live bucket by its authors, and the bundled
> MinIO setup below has not been started either (no Docker daemon in the authoring
> workspace). **Do one real upload and one real download through the UI before go-live.**

## 1. Two buckets

| Bucket | Variable | Access | Content |
| --- | --- | --- | --- |
| documents | `S3_BUCKET` | private; "block all public access" on | customer documents, generated PDFs; staging prefix `incoming/` |
| public assets | `S3_PUBLIC_ASSETS_BUCKET` | anonymous `GetObject` only | logos, favicons (random keys, immutable) |

They must be different buckets (`scripts/production-readiness.mjs` fails otherwise).

### Required settings for the documents bucket

* **No public access** at all. On AWS enable all four "Block Public Access" settings.
* **Encryption at rest.** The API sends `x-amz-server-side-encryption: AES256` (SSE-S3) on
  every upload and signs that header into presigned uploads. The store must accept it:
  AWS S3 does; MinIO only does when a KMS is configured (`MINIO_KMS_SECRET_KEY`, see below).
* **Lifecycle:** expire objects under `incoming/` after 1 day. Uploads land in that staging
  prefix first; the API moves them on completion. Abandoned or replayed uploads stay there.
* **CORS** for browser uploads / downloads: allow `PUT` and `GET` (and `HEAD`) from your
  portal origins, allowed headers `content-type`, `x-amz-server-side-encryption` and
  `content-length`; expose nothing. With custom domains the list of origins is open-ended:
  either allow `*` for these two methods (the URLs are presigned and short-lived, there are
  no cookies involved) or maintain the list.
* **Versioning** (recommended, see `docs/security/BACKUP_AND_RECOVERY.md`), with an expiry
  rule for non-current versions.
* Access logging at the store if you need a record of every fetch (the application logs the
  creation of a download link, not the fetch).

### Application identity (least privilege)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::<documents>/*", "arn:aws:s3:::<public-assets>/*"] },
    { "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": ["arn:aws:s3:::<documents>", "arn:aws:s3:::<public-assets>"] }
  ]
}
```

`ListBucket` is included so that a missing key answers 404 instead of 403. Do **not** grant
`s3:DeleteObjectVersion`, bucket-policy or lifecycle permissions to the application.

## 2. AWS S3 (or a compatible managed store)

```bash
REGION=me-central-1; DOCS=typease-prod-documents; PUB=typease-prod-public-assets

aws s3api create-bucket --bucket "$DOCS" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION"
aws s3api put-public-access-block --bucket "$DOCS" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$DOCS" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-versioning --bucket "$DOCS" --versioning-configuration Status=Enabled
aws s3api put-bucket-lifecycle-configuration --bucket "$DOCS" --lifecycle-configuration '{
  "Rules": [
    {"ID":"expire-abandoned-uploads","Status":"Enabled","Filter":{"Prefix":"incoming/"},"Expiration":{"Days":1},
     "NoncurrentVersionExpiration":{"NoncurrentDays":1}},
    {"ID":"expire-old-versions","Status":"Enabled","Filter":{"Prefix":""},"NoncurrentVersionExpiration":{"NoncurrentDays":30},
     "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}
  ]}'
aws s3api put-bucket-cors --bucket "$DOCS" --cors-configuration '{
  "CORSRules":[{"AllowedMethods":["PUT","GET","HEAD"],"AllowedOrigins":["https://app.example.ae","https://portal.example.ae","https://corporate.example.ae"],
                "AllowedHeaders":["content-type","content-length","x-amz-server-side-encryption"],"MaxAgeSeconds":600}]}'
```

Environment: leave `S3_ENDPOINT` unset, `S3_FORCE_PATH_STYLE=false`, `S3_REGION`, the two
bucket names, and either an access key pair or an instance / task role (`AWS_ROLE_ARN`).

The public assets bucket needs anonymous read for `GetObject` (bucket policy) **or** a CDN
in front of it; see section 4 for how its objects are reached.

These commands were written from the S3 API reference and were not run.

## 3. Bundled MinIO (single host)

Profile `bundled-minio` (`deps` / `full` in development). The one-shot job
`minio-init` (`infrastructure/docker/minio/init-buckets.sh`) is idempotent and

* creates both buckets;
* imports `lifecycle-documents.json` (expire `incoming/` after 1 day) on the documents bucket;
* enables versioning when `S3_VERSIONING=true` (default in production);
* allows anonymous download on the public assets bucket **only**, and fails if the documents
  bucket has any anonymous policy;
* creates the application user `S3_ACCESS_KEY_ID` with the policy above (the API never uses
  the MinIO root user).

Things to know:

* `MINIO_KMS_SECRET_KEY` (in `minio.env`) is mandatory: without a KMS MinIO rejects the
  SSE-S3 header the API sends. **Escrow this key** - without it nothing in the bucket can be
  read, backups of the volume included.
* Presigned URLs carry the host name of `S3_ENDPOINT`, and the signature covers it. The
  browser and the API must reach MinIO under the **same** URL. Production:
  `S3_ENDPOINT=https://s3.BASE`, DNS record for `s3.BASE`, and the Caddy site
  `sites/minio.caddy.example` copied to `sites/minio.caddy`; inside the Docker network the
  name is an alias of the Caddy container. Development: `http://s3.typease.localhost`.
* MinIO answers CORS for all origins by default; restrict with
  `MINIO_API_CORS_ALLOW_ORIGIN` in `minio.env` if you can enumerate your origins.
* The MinIO console (port 9001) is not published in production: use an SSH tunnel.
* A single-node MinIO on one disk has no redundancy. It is acceptable for a small install
  **with** off-host replication or `scripts/storage-backup.sh`; a managed object store is the
  recommended choice.
* The image tags pinned in the Compose files are community releases from 2025. Check the
  vendor's current distribution terms and security advisories before production use, and
  pin by digest.

## 4. Public assets and their URLs

The API always returns `<API_PUBLIC_URL>/api/v1/public/assets/<key>` for a logo, and that
route serves only the local directory. With `STORAGE_DRIVER=s3` the reverse proxy therefore
serves this path from the public assets bucket (`S3_PUBLIC_ASSETS_PROXY=true`,
`S3_PUBLIC_ASSETS_UPSTREAM`, `S3_PUBLIC_ASSETS_BUCKET` in `caddy.env`); see
`reverse-proxy-and-tls.md`, "Logos with S3 storage". For AWS use the path-style regional
endpoint as upstream (`https://s3.<region>.amazonaws.com`).

## 5. Local driver (`STORAGE_DRIVER=local`)

Files are AES-256-GCM encrypted with `DATA_ENCRYPTION_KEY` and written under
`STORAGE_LOCAL_DIR` (`/data/storage` in the images, volume `storage-data`, shared by API and
worker). Signed links are served by the API itself. It works on one host only, is not
suitable for more than one API host, and `pnpm check:production` reports it as a FAIL.
Back it up with `scripts/storage-backup.sh --local`.

## 6. Go-live checks

- [ ] `aws s3api get-public-access-block` (or the MinIO job log) confirms the documents bucket is private.
- [ ] An anonymous `curl` of an object URL in the documents bucket returns 403.
- [ ] Upload a PDF in the staff console, download it again, open the preview.
- [ ] Upload a logo and see it on the portal (public assets path through the proxy).
- [ ] An object left in `incoming/` disappears after a day (lifecycle works).
- [ ] The malware scanner marks an upload `CLEAN` (and the EICAR test file `INFECTED`).
