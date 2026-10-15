# Integrations

Module folder: `services/api/src/modules/integrations`. Tables: `integration_credentials_metadata` (model
`Integration`), `integration_logs`. Schemas: `packages/validation/src/integrations.ts`. All paths are under
`/api/v1`.

Settings > Integrations is the one place where a centre says which external services it uses and with which
credentials. This module **stores and checks** that configuration. It does not send messages, take payments
or contact anybody on behalf of a case: the modules that use an integration read the rows themselves (see
"Who uses a row" below).

Two things this module never does:

- **It never talks to a government website.** There is no scraping, no portal sign-in, no CAPTCHA or OTP
  handling anywhere in TypEase. A `GOVERNMENT` entry is a *record of an authorisation*, not a connection, and
  it cannot hold credentials (see section 4).
- **It ships no "official API" adapter.** If an authority offers a documented API and a centre is authorised to
  use it, a deployment adds an adapter behind the requests module's `OfficialSubmissionPort`
  (`services/api/src/modules/requests/official-submission.port.ts`, described in `requests.md`, "Adding an
  official integration"). Until then the `OFFICIAL_API` channel answers `OFFICIAL_INTEGRATION_NOT_AVAILABLE`.

## 1. Provider catalogue

The catalogue is code (`catalogue.ts`). Each provider has non-secret settings (`config`) and credentials
(`secrets`). The key names are a contract with the consuming modules; a unit test
(`catalogue.unit.spec.ts`) fails when the catalogue and a consumer drift apart.

| Category / provider | Kind | `config` (not secret) | `secrets` (write-only) | Connection test | Used by |
| --- | --- | --- | --- | --- | --- |
| `PAYMENT` / `sandbox` | connection | - | - | none (built in) | finance: online invoice payments. **Only offered when `PAYMENT_SANDBOX_ENABLED=true` and never in production.** Always `mode: TEST`. |
| `PAYMENT` / `stripe` | connection | - | `secretKey`*, `webhookSecret`* | `GET /v1/balance` | finance: online invoice payments. A real gateway wins over the sandbox. |
| `EMAIL` / `smtp` | connection | `host`*, `port`, `secure`, `requireTls`, `fromAddress`, `fromName` | `user`, `password` | SMTP connect + STARTTLS + sign-in (`verify`); nothing is sent | notifications: all customer email of the centre |
| `SMS` / `twilio` | connection | `accountSid`*, `from`* | `authToken`* | `GET /2010-04-01/Accounts/{sid}.json` | notifications |
| `SMS` / `http` | connection | `url`* (https, approved host) | `token`* | none | notifications |
| `WHATSAPP` / `meta` | connection | `phoneNumberId`*, `apiVersion`, `languageCodes { en, ar }` | `accessToken`* | none | notifications |
| `PUSH` / `fcm` | connection | `projectId`* | `serviceAccountJson`* (JSON or base64 of it; must contain `client_email` and `private_key`) | none | notifications |
| `OCR` / `external-http` | connection | `url`* (https, approved host) | `token`* | none | **recorded only** (see below) |
| `MALWARE_SCAN` / `clamav` | connection | `host`*, `port` | - | clamd `PING` -> `PONG`; no file is sent | **recorded only** |
| `AUTOMATION` / `n8n` | connection | `webhookBaseUrl`* (https, approved host) | `signingSecret`* | none | stored for the automation engine (see below) |
| `PARTNER` / `authorised-partner` | authorisation record | `partnerLegalName`*k, `serviceScope`*k, `agreementReference`*k, `agreementValidUntil`k, `contactName`, `contactEmail`, `contactPhone` | none possible | none | catalogue: allows the `PARTNER_COORDINATION` capability |
| `GOVERNMENT` / `official-portal-access` | authorisation record | `authorityName`*k, `authorisationReference`*k, `validFrom`k, `validUntil`k, `credentialHolder`*, `notes` | none possible | none | catalogue: allows the `DIRECT_AUTHORISED` capability |

`*` required. `k` = key field: changing it withdraws an earlier verification (section 4).

**Honest status of three categories.** The OCR module and the malware scanner currently read the scanner /
OCR service configured for the whole platform (`OCR_PROVIDER`, `MALWARE_SCANNER` in the environment). A
centre's own `OCR` or `MALWARE_SCAN` row is stored and validated but **not read by those modules**. The
`AUTOMATION / n8n` row is stored with the key names above for the automation engine; whether a centre's own
n8n instance is used depends on the automation module of the installation. The API says so itself: every
catalogue entry and every integration carries `usage: { effective, note }`.

**Connection tests - what was verified.** SMTP: against a real local `smtp-server` (wrong and right
password). Stripe, Twilio, ClamAV: against local fake servers that assert the exact request (path,
`Authorization` header, clamd bytes). **The live Stripe and Twilio APIs were not reachable from the build
environment**, so those two tests are implemented from the public API documentation and not verified
against the providers.

## 2. Endpoints for the centre

All need `integration.manage` (the owner by default). Managers, receptionists, customers, corporate users
and TypEase staff get `403`. Another centre's integration is `404`.

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/integrations/catalogue` | - | Categories with their providers (below) |
| GET | `/integrations` | `category?`, `status?` | Integration[] |
| GET | `/integrations/:id` | - | Integration |
| POST | `/integrations` | `{ category, provider, name?, mode = "TEST", config = {}, secrets?, authorisationNote?, evidenceDocumentId?, instanceKey? }` | `201` Integration, status `CONFIGURED` (records: `DISABLED`, state `PENDING`) |
| PATCH | `/integrations/:id` | `{ name?, mode?, config?, authorisationNote?, evidenceDocumentId? }` - `config` **replaces** the whole configuration | Integration |
| PUT | `/integrations/:id/secrets` | `{ secrets: { key: "value" \| null } }` - merges; `null` removes one | Integration |
| POST | `/integrations/:id/enable` | - | Integration + `switchedOff: [{ id, name }]` |
| POST | `/integrations/:id/disable` | - | Integration |
| POST | `/integrations/:id/test` | - | `{ supported, ok, message, testedAt }` |
| DELETE | `/integrations/:id` | - | `{ status: "DELETED" }` (the stored credentials go with it) |
| GET | `/integrations/logs` | `page, pageSize, sort (createdAt), integrationId?, category?, provider?, operation?, success?, from?, to?` | Paged log rows |

Catalogue entry:

```json
{ "category": "EMAIL", "label": "Email",
  "providers": [ {
    "category": "EMAIL", "provider": "smtp", "name": "Your own mail server (SMTP)", "description": "...",
    "kind": "CONNECTION", "multiple": false, "modes": ["TEST", "LIVE"],
    "configFields": [ { "key": "host", "label": "Server", "help": null, "type": "host", "required": true, "maxLength": 253, "example": "smtp.example.ae" } ],
    "secretFields": [ { "key": "user", "label": "User name", "help": null, "type": "string", "required": false, "maxLength": 320, "example": null } ],
    "requiresVerification": false, "testable": true, "testNote": "Connects, starts TLS when offered and signs in. No message is sent.",
    "usage": { "effective": true, "note": "Used for all customer emails of this centre while it is ACTIVE; otherwise the TypEase mail server is used." },
    "approved": true,
    "configured": [ { "id": "...", "instanceKey": null, "status": "ACTIVE" } ] } ] }
```

Field `type` is one of `string, text, number, boolean, email, phone, host, url, date, languageCodes, json`.
A provider that is not available on the installation (the sandbox when test payments are off) is not listed.
`approved: false` means TypEase has not approved the provider: it is shown but cannot be added or enabled.

Integration:

```json
{ "id": "...", "category": "EMAIL", "provider": "smtp", "instanceKey": null, "known": true, "kind": "CONNECTION",
  "name": "Your own mail server (SMTP)", "status": "CONFIGURED", "mode": "LIVE",
  "config": { "host": "smtp.example.ae", "port": 587, "fromAddress": "hello@example.ae" },
  "secretKeys": ["password", "user"], "secretsUpdatedAt": "2026-10-09T08:00:00.000Z",
  "missing": { "config": [], "secrets": [] }, "ready": true, "approved": true, "testable": true,
  "lastTestedAt": null, "lastTestOk": null, "lastTestMessage": null,
  "authorisation": null,
  "usage": { "effective": true, "note": "..." }, "webhookUrl": null,
  "createdAt": "...", "updatedAt": "..." }
```

- `secretKeys` names the stored credentials. **No endpoint ever returns a credential value**, not even
  masked, and `secretsEnc` never leaves the database. Credentials are stored as one AES-256-GCM envelope
  (`encryptJson`, key `DATA_ENCRYPTION_KEY`).
- `webhookUrl` is set for Stripe: the address to register as the webhook endpoint in the Stripe dashboard.
- `known: false` marks a row whose provider is not in the catalogue of this installation.

Log row (`integration_logs`): `{ id, tenantId, integrationId, category, provider, operation, direction,
success, statusCode, durationMs, request, response, error, relatedType, relatedId, createdAt }`. `request`
and `response` are redacted summaries, e.g. `{ "method": "GET", "url": "https://api.stripe.com/v1/balance",
"auth": "bearer secret key (redacted)", "keyKind": "test" }` and `{ "status": 200, "livemode": false }`.
This module writes one row per connection test (`operation: "TEST_CONNECTION"`).

## 3. Rules

**Status.** `CONFIGURED` = saved, not in use. `ACTIVE` = the consuming module uses it. `DISABLED` =
switched off. `ERROR` is not set by this module.

- Creating a connection needs every required **setting**; required **credentials** can be added later with
  `PUT .../secrets`. Enabling needs both (`422 INTEGRATION_INCOMPLETE`, `details.missing`).
- One row per provider and centre (`409 INTEGRATION_EXISTS`), except authorisation records (section 4).
- **One active provider per category.** Enabling a provider switches the other active provider of the same
  category off (`switchedOff` in the answer), because the notifications module uses one provider per channel.
  Exception: `PAYMENT`, where a real gateway and the sandbox may both be active (the real one wins).
- Removing a credential that an `ACTIVE` integration needs puts it back to `CONFIGURED`.
- Changing the configuration or the credentials clears the last test result.
- Credentials are trimmed (pasted keys usually end with a line break). Unknown setting or credential names
  are refused (`422 INVALID_INTEGRATION_CONFIG`, `details.field`), so a typo is never stored as a "secret"
  that nothing reads.
- `sandbox` is always `TEST`; `mode: LIVE` is refused (`422 MODE_NOT_SUPPORTED`).

**Addresses a centre types in (SSRF protection).**

- `url` settings (`SMS/http`, `OCR/external-http`, `AUTOMATION/n8n`) must be `https://`, without user name
  or password, and their host must be on the operator's allow-list `OUTBOUND_WEBHOOK_ALLOWED_HOSTS` - the
  same rule the sending code applies. Otherwise `422 ENDPOINT_NOT_ALLOWED`.
- `host` settings (`EMAIL/smtp`, `MALWARE_SCAN/clamav`): a literal private / loopback / link-local address is
  refused when it is saved. A host *name* is checked when a connection test resolves it: **every** address
  it resolves to must be public, and the test then connects to exactly the address that was checked (the
  name is not resolved a second time). Redirects are never followed.
- Development only: a host listed in `OUTBOUND_WEBHOOK_ALLOWED_HOSTS` may be private (and, for the fixed
  provider APIs in tests, plain http) when `NODE_ENV` is not `production`. In production this exception
  does not exist. To test against a local mail catcher in development, add its host name to that variable.
- Connection tests are limited to 12 per minute per centre (`429`).

**Connection test** (`POST /integrations/:id/test`):

- a provider without a harmless test answers `200 { "supported": false, "ok": null, "message": "This
  provider cannot be tested automatically. ..." }` and records nothing;
- otherwise the test runs (never inside a database transaction), and `lastTestedAt`, `lastTestOk`,
  `lastTestMessage`, an `integration_logs` row and an audit entry are written. A failed test does **not**
  change the status.

**Platform-approved providers.** TypEase can restrict which providers centres may use (section 5). A
provider that is not approved cannot be added or enabled: `422 PROVIDER_NOT_APPROVED`.

**Audit.** `integration.created`, `.updated`, `.credentials_changed` (which credential names were set or
removed, never values), `.enabled`, `.disabled`, `.deleted`, `.tested`, `.authorisation_submitted`,
`.verification_reset`, `.authorisation_expired`; written by TypEase on the centre's trail:
`.authorisation_verified`, `.authorisation_rejected`, `.authorisation_withdrawn`, `.disabled_by_platform`.

### Who uses a row

| Consumer | Reads |
| --- | --- |
| notifications (`providers/registry.ts`) | the centre's `ACTIVE` row of category `EMAIL` / `SMS` / `WHATSAPP` / `PUSH`; otherwise the platform default from the environment |
| finance (`gateways/payment-gateways.ts`) | `ACTIVE` rows of category `PAYMENT`; no row -> `503 INTEGRATION_NOT_CONFIGURED` |
| catalogue (`assertCapabilityAllowed`) | `GOVERNMENT`: `ACTIVE` and `authorisationVerifiedAt` set; `PARTNER`: `ACTIVE` or `CONFIGURED` |
| requests (`OFFICIAL_API` channel) | `GOVERNMENT`, `ACTIVE`, verified - and an installed adapter for the row's provider (none ships) |

Integration tests cover the two cross-module flows that matter most: a sandbox gateway created and enabled
through this API makes `POST /invoices/:id/pay` -> sandbox checkout -> signed webhook -> `PAID` work end
to end, and the catalogue accepts `DIRECT_AUTHORISED` / `PARTNER_COORDINATION` only after verification.

## 4. Government and partner authorisation records

A `GOVERNMENT / official-portal-access` entry states: *this centre is authorised by authority X (reference
Y, valid from - until) and person Z holds the portal account*. A `PARTNER / authorised-partner` entry states
which partner handles which cases under which agreement.

- They hold **no credentials**. `secrets` in a create call and `PUT .../secrets` are refused with
  `422`: "it never holds credentials. Portal user names and passwords must not be stored in TypEase." Text
  that looks like a credential in any field of a record (`password: ...`, `pwd=...`, `OTP: ...`,
  `PIN = ...`) is refused as well.
- A centre may keep several (one per authority / partner): pass `instanceKey` (2-40 lowercase characters) or
  let it be derived from the authority / partner name. In the database the provider is stored as
  `official-portal-access:<instanceKey>`; the API always returns `provider` and `instanceKey` separately.
- `authorisationNote` (at least 10 characters) is required; `evidenceDocumentId` may point at a document of
  the same centre in the vault.

Life cycle (`authorisation.state` in the Integration response):

| State | Status | How it gets there |
| --- | --- | --- |
| `PENDING` | `DISABLED` | submitted, or edited after a rejection, or a **key field of a verified record changed** |
| `VERIFIED` | `ACTIVE` | a TypEase administrator verified it (`authorisationVerifiedAt`, `authorisationVerifiedById`) |
| `REJECTED` | `DISABLED` | rejected, or an earlier verification withdrawn; `authorisation.reviewNote` tells the centre why |

- A pending record is deliberately `DISABLED`, not `CONFIGURED`: the catalogue module accepts a `CONFIGURED`
  partner, and an unverified record must not unlock anything.
- The centre can switch a verified record off and on again. Enabling an unverified record is
  `409 AUTHORISATION_NOT_VERIFIED`; one whose `validUntil` / `agreementValidUntil` has passed is
  `409 AUTHORISATION_EXPIRED`.
- Changing a non-key field (contact, notes, `credentialHolder`) keeps the verification.
- Job `integrations.authorisation_expiry` (daily, 01:20 UTC): an `ACTIVE` record whose validity date has
  passed is switched off. Entering new dates changes a key field, so the record is reviewed again.

```json
"authorisation": { "state": "VERIFIED", "note": "Tasheel service centre licence ...", "evidenceDocumentId": "...",
  "submittedAt": "...", "verifiedAt": "...", "reviewNote": "Checked against the register.", "reviewedAt": "...", "expired": false }
```

The review state is kept in a reserved key of the `config` column (`_authorisation`); it is never part of
`config` in a response and cannot be written through `config`.

## 5. Endpoints for TypEase administrators

All need `platform.integrations.manage` (Platform Super Admin). Service file:
`platform-integrations.service.ts`, the only file of the module on the system database connection. Every
query is pinned to the `GOVERNMENT` / `PARTNER` categories: connections and credentials of a centre are not
reachable here (`404`).

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/platform/integrations/authorisations` | `state = PENDING \| VERIFIED \| REJECTED`, `category?`, `centreId?`, `q?`, `page...` | Paged records (pending: oldest first) |
| GET | `/platform/integrations/authorisations/:id` | - | Record |
| POST | `/platform/integrations/authorisations/:id/verify` | `{ note? }` | Record, state `VERIFIED`, status `ACTIVE`. `409 ALREADY_VERIFIED` |
| POST | `/platform/integrations/authorisations/:id/reject` | `{ note }` (5+ characters) | Record, state `REJECTED`, status `DISABLED`. Also withdraws a verification. `409 ALREADY_REJECTED` |
| GET | `/platform/integrations/approved-providers` | - | `{ restricted, providers: [{ code, category, provider, name, kind, approved }] }` |
| PUT | `/platform/integrations/approved-providers` | `{ providers: ["EMAIL/smtp", ...] \| null }` | same + `switchedOff` |

Record as the reviewer sees it - the record itself and the centre's name, nothing else of the centre:

```json
{ "id": "...", "centre": { "id": "...", "name": "Alpha Typing", "slug": "alpha", "status": "ACTIVE" },
  "category": "GOVERNMENT", "provider": "official-portal-access", "instanceKey": "mohre", "name": "MOHRE",
  "status": "DISABLED", "state": "PENDING",
  "fields": [ { "key": "authorisationReference", "label": "Authorisation / licence reference", "value": "TAS-2026-00417", "keyField": true } ],
  "authorisationNote": "...", "evidenceDocumentId": "...", "submittedAt": "...",
  "verifiedAt": null, "verifiedByName": null, "reviewNote": null, "reviewedAt": null, "createdAt": "...", "updatedAt": "..." }
```

`evidenceDocumentId` is only an id. Opening the document needs a support access grant with the
`document.read` scope that the centre approves (see `platform.md`).

**Approved providers.** Platform setting `integrations.approvedProviders` (also editable through
`/platform/settings`): a list of `CATEGORY/provider` codes, or no row / `null` for "every provider of the
catalogue" (the default). When the list changes, **active integrations of providers that are no longer
approved are switched off in every centre at once** (`switchedOff` = how many), with an entry on each
centre's audit trail. Lifting the restriction switches nothing back on. This is the control behind "do not
send customer documents to unapproved AI services": remove `OCR/external-http` from the list.

## 6. Events and jobs

- Domain events: none emitted, none consumed (no integration event exists in the event catalogue).
- Job: `integrations.authorisation_expiry`, cron `20 1 * * *` (UTC), fans out per centre, idempotent.

## 7. Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNKNOWN_PROVIDER` | 422 / 409 | not in the catalogue (create) / no longer supported (existing row) |
| `PROVIDER_NOT_AVAILABLE` | 422 | not offered on this installation (sandbox off) |
| `PROVIDER_NOT_APPROVED` | 422 | TypEase has not approved the provider |
| `INVALID_INTEGRATION_CONFIG` | 422 | unknown or malformed setting / credential (`details.field`) |
| `ENDPOINT_NOT_ALLOWED` | 422 | address not https, not approved, or internal (`details.reason`) |
| `INTEGRATION_EXISTS` | 409 | already configured (`details.id`) |
| `INTEGRATION_INCOMPLETE` | 422 | required settings or credentials missing (`details.missing`) |
| `MODE_NOT_SUPPORTED` | 422 | e.g. `LIVE` for the sandbox |
| `INSTANCE_NOT_SUPPORTED` / `INSTANCE_KEY_REQUIRED` | 422 | `instanceKey` on a single-instance provider / missing for a record |
| `AUTHORISATION_NOTE_REQUIRED` | 422 | a record needs a note of 10+ characters |
| `NOT_AN_AUTHORISATION_RECORD` | 422 | note or evidence sent for a connection |
| `EVIDENCE_NOT_FOUND` | 422 | the evidence document is not in this centre's vault |
| `AUTHORISATION_NOT_VERIFIED` / `AUTHORISATION_EXPIRED` | 409 | a record cannot be enabled yet / any more |
| `CREDENTIALS_UNREADABLE` | 409 | stored credentials cannot be decrypted (key rotated away): enter them again |
