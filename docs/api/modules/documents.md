# Documents (secure vault) and private storage

Source: `services/api/src/modules/documents`, `services/api/src/modules/storage`.
Request shapes: `packages/validation/src/documents.ts`. All paths are below `/api/v1`.

The vault stores passports, Emirates IDs, trade licences and the files the centre produces. Bytes are never
returned by the JSON API: clients get **short-lived signed URLs**. Storage keys and paths are never part of
any response.

> What was verified here: everything in this document is covered by the automated tests in the two module
> folders, using the **local** storage driver. The **S3 driver was not exercised against a live bucket** in the
> development environment: its presigned URLs and request building are tested offline (the SDK signs locally),
> but no object was ever written to or read from a real S3 / MinIO service. Run an end-to-end upload and
> download against your bucket before go-live.

## 1. Endpoints

### Upload

| Method | Path | Access | Body | Returns |
| --- | --- | --- | --- | --- |
| POST | `/documents/upload-intents` | `document.upload` (staff), `self.documents` (customer / corporate employee), `corp.employees.manage` or `corp.requests.create` (corporate admin) | see below | `201 { documentId, versionId, upload }` |
| PUT | *(the URL in `upload.url`)* | none: the signed URL is the capability | raw file bytes | `200` |
| POST | `/documents/:id/versions/:versionId/complete` | same as upload-intents | - | `200` upload summary |
| POST | `/documents/upload` | same as upload-intents | `multipart/form-data`: part `file` + the owner fields as text | `201` upload summary |

Upload intent body:

```json
{
  "customerId": "uuid (optional)",
  "corporateAccountId": "uuid (optional)",
  "requestId": "uuid (optional)",
  "checklistItemId": "uuid (optional, request_documents.id)",
  "documentTypeKey": "passport",
  "title": "optional, defaults to the checklist label or the type name",
  "category": "optional free text",
  "filename": "Passport.pdf",
  "mime": "application/pdf",
  "sizeBytes": 482113,
  "replacesDocumentId": "uuid (optional: adds a new version)",
  "expiryDate": "2031-05-01 (optional, unverified)",
  "issuedDate": "2021-05-02 (optional)",
  "customerVisible": true
}
```

Response:

```json
{
  "documentId": "9d0c...",
  "versionId": "41aa...",
  "upload": {
    "url": "https://.../one-time-signed-url",
    "method": "PUT",
    "headers": { "Content-Type": "application/pdf" },
    "expiresAt": "2026-10-09T10:10:00.000Z"
  }
}
```

The client then sends `PUT upload.url` with **exactly** the headers in `upload.headers` and the raw bytes as
the body, and finally calls `complete`. Upload summary (returned by `complete` and by `/documents/upload`):

```json
{ "documentId": "9d0c...", "versionId": "41aa...", "versionNo": 1, "status": "PENDING_SCAN",
  "isCurrentVersion": true, "filename": "Passport.pdf", "mime": "application/pdf", "sizeBytes": 482113, "scanStatus": "PENDING" }
```

Uploading several files = several intents (they can run in parallel). The multipart endpoint is the same
flow in one request for simple clients such as mobile camera capture; it accepts one file per request.

### Reading

| Method | Path | Access | Query / body | Returns |
| --- | --- | --- | --- | --- |
| GET | `/documents` | `document.read`, `self.documents`, `corp.employees.read`, `corp.requests.read` or `corp.account.read` | `page, pageSize, sort (createdAt, updatedAt, expiryDate, title), q, customerId, requestId, corporateAccountId, type, category, status, verificationStatus, expiringBefore (YYYY-MM-DD), includeDeleted (staff)` | page of documents |
| GET | `/documents/:id` | as above | - | document + `versions[]` + `checklist[]` (+ `verifications[]` for staff). Logged as `VIEW` |
| POST | `/documents/:id/download-link` | as above | `{ disposition?: "attachment" \| "inline", versionId? }` (`versionId` of an older version: staff only) | `{ url, expiresAt, filename, mime, sizeBytes, disposition }` |
| POST | `/documents/:id/preview-link` | as above | - | same, with `inline` disposition for PDF / JPEG / PNG / WebP (other types stay `attachment`) |
| GET | `/documents/checklist-assist?requestId=` | as above | `requestId` | per checklist line: state, hint, expiry, reusable candidates (read-only, see `ocr.md` section 6) |
| GET | `/documents/:id/access-logs` | `audit.read` or `privacy.manage` | `page, pageSize` | page of access-log rows |

Document shape (staff see the extra fields marked *staff*):

```json
{
  "id": "9d0c...", "customerId": "...", "corporateAccountId": null, "requestId": "...",
  "documentTypeKey": "passport", "category": null, "title": "Copy of passport",
  "status": "AVAILABLE", "verificationStatus": "UNVERIFIED", "verifiedAt": null,
  "issuedDate": null, "expiryDate": "2031-05-01", "expiryVerified": false,
  "isCompletionDocument": false, "uploadedByType": "STAFF", "createdAt": "...", "updatedAt": "...",
  "downloadable": true,
  "currentVersion": { "id": "41aa...", "versionNo": 1, "filename": "Passport.pdf", "mime": "application/pdf",
                      "sizeBytes": 482113, "uploadStatus": "COMPLETED", "scanStatus": "CLEAN", "scannedAt": "...",
                      "createdAt": "...", "downloadable": true },
  "customerVisible": true, "legalHold": false, "retentionUntil": null, "verifiedById": null,
  "uploadedById": "...", "deletedAt": null, "deletedById": null, "purgeAfter": null
}
```

*Staff-only fields:* `customerVisible, legalHold, retentionUntil, verifiedById, uploadedById, deletedAt, deletedById, purgeAfter`,
and on versions `sha256, scanEngine, scanDetail, uploadedById`.

`isCompletionDocument` marks the completed (output) documents of a request: files the platform generates,
and files **staff** upload with the `checklistItemId` of a `COMPLETION` checklist line. A customer upload is
never a completed document: customers, corporate employees and corporate administrators cannot upload against
a `COMPLETION` line at all. Every upload path (`upload-intents`, `upload`, a new version with
`replacesDocumentId`) answers `403 COMPLETION_DOCUMENT_STAFF_ONLY` and creates nothing; a `COMPLETION` line of
a request the caller may not see stays a 404. Staff uploads against such lines work as before. The requests
module applies the same rule twice more: linking an existing document to a `COMPLETION` line is staff-only,
and the workflow engine ignores a `document.uploaded` event that names a `COMPLETION` line with
`uploadedByType` `CUSTOMER` or `CORPORATE`.

### Staff actions

| Method | Path | Permission | Body | Notes |
| --- | --- | --- | --- | --- |
| PATCH | `/documents/:id` | `document.upload` or `document.verify` | any of `title, category, documentTypeKey, expiryDate, issuedDate, customerVisible` | changing `expiryDate` resets `expiryVerified` to false and emits `document.expiry_changed` |
| POST | `/documents/:id/verify` | `document.verify` | `{ decision: "APPROVED" \| "REJECTED" \| "CORRECTION_REQUESTED", reason?, expiryDate?, issuedDate? }` | `reason` (3+ chars) is mandatory unless APPROVED |
| POST | `/documents/:id/rescan` | `document.verify` | - | re-queues the malware scan for versions in `ERROR` / `PENDING` |
| DELETE | `/documents/:id` | `document.delete` | - | soft delete, `{ id, status: "DELETED", purgeAfter }` |
| POST | `/documents/:id/restore` | `document.delete` | - | only while the files still exist |
| PUT | `/documents/:id/legal-hold` | `privacy.manage` | `{ legalHold: boolean, reason }` | blocks deletion and purging |
| GET | `/documents/:id/shares` | `document.share` | - | share links (never the token) |
| POST | `/documents/:id/shares` | `document.share` | `{ expiresInHours?: 1..168 (default 24), maxDownloads?: 1..20 (default 3), recipient? }` | returns the share **with `token` and `url` once** |
| DELETE | `/documents/:id/shares/:shareId` | `document.share` | - | revokes the link |

### Public

| Method | Path | Access | Returns |
| --- | --- | --- | --- |
| GET | `/public/shared-documents/:token` | public, rate limited (30 / minute / IP) | `{ title, filename, mime, sizeBytes, download: { url, expiresAt }, remainingDownloads, shareExpiresAt }`. Each successful call counts as one download |
| PUT | `/storage/local/upload/:token` | public (signed, single-use ticket); **local driver only** | `{ "status": "UPLOADED" }` |
| GET | `/storage/local/download/:token` | public (signed ticket); **local driver only** | the file bytes |

Endpoint count: 19 document endpoints + 2 local-storage endpoints.

## 2. Error codes a client should handle

| HTTP | Code | When |
| --- | --- | --- |
| 422 | `FILE_TYPE_NOT_ALLOWED` | declared type, or the real content, is not in `UPLOAD_ALLOWED_MIME` |
| 422 | `FILE_TYPE_MISMATCH` | the content is an allowed type but not the declared one. The file is deleted |
| 413 | `FILE_TOO_LARGE` / `PAYLOAD_TOO_LARGE` | larger than `UPLOAD_MAX_BYTES` (default 15 MB) / larger than the declared size |
| 400 | `UPLOAD_SIZE_MISMATCH` | fewer bytes than declared (local driver) |
| 415 | `UPLOAD_TYPE_MISMATCH` | `Content-Type` of the PUT differs from the declared type (local driver) |
| 403 | `LINK_EXPIRED` | upload / download / share link expired, tampered with, already used, revoked or used up |
| 409 | `UPLOAD_NOT_FOUND` | `complete` called before the bytes arrived |
| 409 | `UPLOAD_REJECTED` | the upload was refused or expired; start a new intent |
| 409 | `DOCUMENT_NOT_READY` | upload unfinished or malware scan still running |
| 409 | `DOCUMENT_QUARANTINED` | the file was blocked by the scanner |
| 409 | `DOCUMENT_NOT_AVAILABLE` | `REQUIRE_CLEAN_SCAN=true` and the file has no CLEAN result |
| 409 | `DOCUMENT_IN_USE`, `LEGAL_HOLD`, `RETENTION_ACTIVE` | deletion blocked |
| 409 | `DOCUMENT_PURGED`, `NOT_DELETED` | restore not possible |
| 409 | `REQUEST_CLOSED`, `CUSTOMER_INACTIVE`, `DOCUMENT_DELETED` | upload target no longer accepts files |
| 403 | `COMPLETION_DOCUMENT_STAFF_ONLY` | a customer or corporate user named a `COMPLETION` checklist line (output documents are provided by the centre) |
| 422 | `DOCUMENT_OWNER_REQUIRED`, `UNKNOWN_DOCUMENT_TYPE`, `CHECKLIST_MISMATCH`, `CATEGORY_RESERVED` | invalid intent |
| 402 | `PLAN_LIMIT_REACHED` | the plan's `storageMb` limit would be exceeded |
| 404 | `NOT_FOUND` | the document does not exist **or the caller may not see it** (never 403, so existence is not revealed) |

## 3. Who can see which document

Permissions say what a role may do; these rules say on which documents.

- **Staff** (`document.read`): all documents of the centre, except that a document filed under a request
  follows that request: staff limited to branches only see documents of requests in their branches, and
  operators with `request.read.assigned` (without `request.read.all`) only documents of requests assigned to
  them (as operator or reviewer). Documents not filed under a request (the customer's vault) are visible to
  every member with `document.read`.
- **Customers / corporate employees** (`self.documents`): documents of their own customer record, and
  documents without a customer that are filed under their own request, when `customerVisible` is true.
  They can upload for themselves and to their own **open** requests only.
- **Corporate administrators**: documents of their company (`corporateAccountId`) and of its **active**
  employees, when `customerVisible` is true. Uploads are pinned to their company.
- **TypEase platform support**: only inside a tenant under an approved access grant whose scopes include
  `document.read`. Read-only. Each access row carries `supportGrantId`, and view / link actions additionally
  appear in the centre's audit trail as `document.accessed_by_support`.
- Quarantined, deleted and not-yet-scanned documents are never downloadable by anyone.
- Older versions can be downloaded by staff only.

## 4. Lifecycle and business rules

```
intent ──PUT bytes──> complete ──> PENDING_SCAN ──scan──> AVAILABLE
   │                     │                         └─────> QUARANTINED (file deleted)
   └ never completed     └ content check failed: file deleted, version FAILED
```

- **Declared type is never trusted.** `complete` reads the stored bytes and sniffs the type by magic bytes
  (`detectMime`). The content must be an allowed type *and* equal the declared type, otherwise the file is
  deleted, the version is marked `FAILED`, a `UPLOAD_CONTENT_MISMATCH` security event is written and the call
  fails. Size and SHA-256 are recorded from the stored bytes.
- **Upload URLs write to a staging area.** `complete` first moves the object to its final key and only then
  inspects it, so a leaked or replayed upload URL can never change a file after it was checked and scanned.
  With the local driver an upload URL is single-use.
- **Storage keys** are `<tenantId>/<192-bit random>` (staging: `incoming/<tenantId>/<random>`), never derived
  from the file name or any user input.
- **Malware scan** (`documents.scan` job): `MALWARE_SCANNER=clamav` streams the file to clamd (INSTREAM over
  TCP, `CLAMAV_HOST` / `CLAMAV_PORT`); `none` marks the version `SKIPPED` (never `CLEAN`). The EICAR test
  string is always detected in-process so the quarantine path can be tested; that is not malware protection.
  - `INFECTED`: the file is deleted from storage, the version is `INFECTED` forever, the document becomes
    `QUARANTINED`, its share links are revoked, a `MALWARE_DETECTED` (HIGH) security event and an audit entry
    are written.
  - Scanner unreachable: retried 5 times with backoff, then the version is `ERROR` and the document stays
    `PENDING_SCAN` (not downloadable) until `POST /documents/:id/rescan` succeeds.
  - `REQUIRE_CLEAN_SCAN=true`: only `CLEAN` versions are downloadable. Do not combine it with
    `MALWARE_SCANNER=none`: uploads would never become downloadable.
  - Files produced by the platform itself (through `DocumentStorePort`) are not scanned
    (`scanEngine = "system-generated"`) and are always downloadable.
- **Versions.** A new version (`replacesDocumentId`) keeps the old ones. If the document is in use
  (`AVAILABLE`), the new version becomes current only after it passed the scan; until then the previous
  version stays current and downloadable. When it takes over, verification starts again
  (`UNVERIFIED`, `expiryVerified = false`). An infected replacement never displaces the good version.
- **Verification.** `APPROVED` sets `VERIFIED`; `REJECTED` and `CORRECTION_REQUESTED` both set `REJECTED`
  (the decision is kept in `document_verification_results`). `expiryVerified` becomes true only when the
  reviewer sends `expiryDate` with an approval, i.e. confirmed the date against the document.
- **Sharing.** Links live at most 7 days and allow at most 20 downloads. Only the SHA-256 of the token is
  stored; the token is shown once. Redeeming returns a new URL that expires within
  `DOWNLOAD_URL_TTL_SECONDS`. There are no permanent or public links. Note that every GET of the public
  endpoint counts as a download, including automatic link previews by chat apps: a portal page should call it
  on an explicit click.
- **Deletion.** Soft delete sets `status = DELETED` and `purgeAfter = now + 30 days`; the document
  disappears from normal use, share links are revoked, and it can be restored until the purge job removed the
  files. Deletion is refused under legal hold, before `retentionUntil`, and while the document belongs to (or
  is linked from the checklist of) an open request.
- **Access log.** Every upload intent, upload, detail view, download / preview link, metadata change,
  verification, share creation / revocation / download, deletion, restore, legal-hold change, OCR read and
  purge writes an append-only `document_access_logs` row with actor, actor type, IP and user agent.
  List views are not logged per document. For the S3 driver the actual byte transfer happens at the object
  store: enable the bucket's own access logging if you need a record of each fetch.
- **Plan limit.** `storageMb` is checked when the intent is created; usage (`storageBytes`) is increased when
  an upload completes and decreased when files are purged or quarantined.

### Whose document it is, in words

Every document row (`GET /documents`, `GET /documents/:id`) carries three more fields, for any caller who may
already read the document:

```json
{ "customerName": "Ravi Kumar", "customerErased": false, "requestNo": "TE-000123" }
```

`customerName` / `requestNo` are `null` for a document that belongs to no person / no request (a company
document). `customerErased: true` means the person's data was erased: the name is the placeholder
"Erased customer". A company's portal uses the fields to show "passport of <employee>, request TE-000123";
`GET /documents?customerId=<employee's customerId>` narrows the list to one employee (an id outside the caller's
scope gives an empty page, never an error).

### Documents of an erased customer

An erasure deletes the person's documents at once, without a restore window, and blanks their titles and file
names. A document it had to keep (legal hold, a retention date that has not passed, use by somebody else's open
request) stays, readable by staff, with `customerErased: true`. When the reason ends, the purge job erases it -
and so does a member of staff who deletes it by hand first: `DELETE /documents/:id` on such a document answers
`{ "id": "…", "status": "DELETED", "purgeAfter": "<now>" }`, and in the same transaction the title becomes
"Erased document", the file names become `erased`, share links end and review notes are cleared (audit action
`document.erased`, not `document.deleted`). `POST /documents/:id/restore` answers `409 DOCUMENT_ERASED` until
the files are physically removed and `409 DOCUMENT_PURGED` afterwards. Uploading for an erased customer answers
`409 CUSTOMER_ERASED`.

## 5. Events

Emitted (inside the business transaction):

| Event | Payload |
| --- | --- |
| `document.uploaded` | `{ documentId, versionId, customerId, corporateAccountId, requestId, checklistItemId, documentTypeKey, uploadedByType }` (+ `generated: true, isCompletionDocument` for platform-generated files). Emitted when an upload completes, before the scan |
| `document.verified` | `{ documentId, customerId, requestId, documentTypeKey, expiryDate, expiryVerified }` |
| `document.rejected` | `{ documentId, customerId, requestId, documentTypeKey, reason, decision }` |
| `document.expiry_changed` | `{ documentId, customerId, corporateAccountId, requestId, documentTypeKey, expiryDate, previousExpiryDate, expiryVerified, source: "MANUAL" \| "OCR" }`. Emitted when `PATCH /documents/:id` changes the expiry date (`MANUAL`, `expiryVerified: false`) and when a reviewed extraction is applied (`OCR`, `expiryVerified: true`). Not emitted by the verify action, which announces its date in `document.verified` |

Consumed: none. The request checklist (`request_documents`) is owned by the requests module, which reacts to
these events; this module only reads it.

## 6. Background jobs

| Job | Trigger | What it does |
| --- | --- | --- |
| `documents.scan` | queued when an upload completes or a rescan is requested | malware scan of one version (idempotent) |
| `documents.purge` | daily, cron `30 22 * * *` UTC (02:30 Gulf time), all operational tenants | 1. discards upload intents not completed within an hour after their URL expired; 2. applies active `data_retention_policies` with entity `DOCUMENT` and action `DELETE` (a policy for a specific `documentTypeKey` takes precedence over the general one): documents are soft-deleted `retainDays` after their request was completed / cancelled, or after their upload date when they have no request; 2b. deletes documents of erased (anonymised) customers that had to be kept at the time of the erasure, once their legal hold was released or their retention date passed (no restore window, title and file name blanked; audit `document.erased`); 3. physically removes the files of soft-deleted documents past `purgeAfter`, deletes their OCR results and reduces storage usage. Skips documents under legal hold, with a later `retentionUntil`, or tied to an open request. Safe to run repeatedly |

## 7. For other modules: `DocumentStorePort`

Inject `DocumentStorePort` (`common/ports.ts`, optional injection) and call `storeGenerated(input)` inside your
tenant transaction to file a generated PDF. The document is `AVAILABLE` immediately, counts towards storage
usage, emits `document.uploaded` and follows the same access rules as any other document. If the caller's
transaction rolls back the row disappears; the already written (unreferenced, unreachable) object may remain
in storage.

**Restricted files.** A module that generates staff-only files with an access rule of its own (scheduled
reports: the permission of the report, not `document.read`) passes `restrictedTo: "<module-key>"`. The document
is stored with `category = "restricted:<module-key>"` and `customerVisible = false`, cannot belong to a
customer, company or request, and is outside every general rule of the vault: `DocumentAccess.readFilter`
excludes restricted files for all actors, so list, get, download / preview link, share, edit, verify, delete,
restore and "new version" answer 404 whoever asks. The owning module authorises the actor itself and calls
`restrictedDownloadLink(documentId, owner)` (404 unless the document is a restricted file of that owner in the
current tenant; logged as `DOWNLOAD_LINK` in the access log). `restrictGenerated(documentIds, owner)` turns
unowned, platform-generated files stored before the flag existed into restricted ones (revokes their share
links, audited as `document.restricted`). Retention and purge treat restricted files like any other document.
Categories starting with `restricted:` are reserved: an upload intent or `PATCH /documents/:id` that names one
is refused with `422 CATEGORY_RESERVED`.

## 8. Storage drivers and operations

| Setting | Meaning |
| --- | --- |
| `STORAGE_DRIVER=local` | files under `STORAGE_LOCAL_DIR/private`, AES-256-GCM encrypted with `DATA_ENCRYPTION_KEY` before they touch the disk; signed URLs are served by the API itself. Back up that directory together with the database, and keep the encryption key: without it the files cannot be read |
| `STORAGE_DRIVER=s3` | private bucket `S3_BUCKET` on any S3-compatible store. Uploads are presigned PUTs with `x-amz-server-side-encryption: AES256`, `content-type` and `content-length` as signed headers; downloads are presigned GETs with a forced `Content-Disposition` |
| `UPLOAD_URL_TTL_SECONDS` (600) / `DOWNLOAD_URL_TTL_SECONDS` (120) | lifetime of upload / download links |
| `UPLOAD_MAX_BYTES`, `UPLOAD_ALLOWED_MIME` | size and type limits |

S3 checklist for operators (not automated by the application):

- block all public access on the bucket; the application never sets ACLs and never produces unsigned URLs;
- allow CORS `PUT` / `GET` from your portal origins, exposing no extra headers;
- add a lifecycle rule that expires objects under the `incoming/` prefix after one day (abandoned or
  replayed uploads);
- the IAM identity needs `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on the bucket (copy uses Get + Put).

Previews with the local driver: the API sends `frame-ancestors 'none'`, so embed previews with a new tab or
by fetching the link as a blob, not with an iframe pointing at the link.

Known limitations (stated so nobody assumes otherwise): files are buffered in memory while they are checked,
which is fine for the 15 MB default limit but not for very large limits; HEIC images are detected but only
accepted if you add `image/heic` to `UPLOAD_ALLOWED_MIME`; the local driver records link creation, not each
individual fetch of a link.
