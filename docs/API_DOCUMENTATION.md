# API documentation

The TypEase REST API: the conventions every endpoint follows, how a route declares who may call it, and
where the reference for each module is. The examples in section 9 are real requests and responses, taken
from the API running on the development machine with the demo data
([DEMO_ENVIRONMENT.md](DEMO_ENVIRONMENT.md)); long payloads are shortened and tokens are removed.

Reference material:

| What | Where |
| --- | --- |
| Every route with its access rule | [api/ENDPOINTS.md](api/ENDPOINTS.md) (generated) |
| Request and response schemas | [api/openapi.json](api/openapi.json) (generated, OpenAPI 3.0) |
| Behaviour, business rules, error codes per module | [api/modules/](api/modules/) (22 documents, written by the module authors) |
| Permissions and roles | [ROLE_PERMISSION_MATRIX.md](ROLE_PERMISSION_MATRIX.md) |
| Request state machine | [workflows/REQUEST_LIFECYCLE.md](workflows/REQUEST_LIFECYCLE.md) |

## Contents

1. [Base URL and versioning](#1-base-url-and-versioning)
2. [Conventions](#2-conventions)
3. [Authentication and sessions](#3-authentication-and-sessions)
4. [Access rules](#4-access-rules)
5. [Tenant resolution](#5-tenant-resolution)
6. [Errors](#6-errors)
7. [Lists, idempotency, rate limits](#7-lists-idempotency-rate-limits)
8. [Files and webhooks](#8-files-and-webhooks)
9. [Worked examples](#9-worked-examples)
10. [Module index](#10-module-index)
11. [OpenAPI and Swagger UI](#11-openapi-and-swagger-ui)

## 1. Base URL and versioning

| | |
| --- | --- |
| Base path | `/api/v1` on the API host (development: `http://localhost:4000/api/v1`) |
| Without the prefix | `GET /health`, `GET /health/ready` |
| Versioning | one version, `v1`, in the path. There is no header or query versioning and no second version |
| Transport | JSON over HTTPS. In production the reverse proxy terminates TLS; the API sets HSTS itself in production |
| Same-origin access | every web host also serves `/api/v1/*` (reverse proxy rule, or the Next.js rewrite of the two portals in development), so a portal on a centre's own domain calls the API on its own origin |
| Internal routes | `/api/v1/internal/*` is for the reverse proxy and monitoring and must not be reachable from the internet ([deployment/reverse-proxy-and-tls.md](deployment/reverse-proxy-and-tls.md)) |

The generated endpoint index, [api/ENDPOINTS.md](api/ENDPOINTS.md), is the authoritative count and list of
routes; at the time of writing it lists 590 endpoints, and the committed `openapi.json` describes all of
them except the local storage driver's download route, which is excluded from the OpenAPI document on
purpose (section 11). Regenerate both with `pnpm openapi` after any route change.

## 2. Conventions

| Topic | Rule |
| --- | --- |
| Content type | requests and responses are `application/json`, except file uploads (`multipart/form-data` or a raw `PUT`), PDF / CSV / XLSX downloads, the queue display stream (`text/event-stream`) and the metrics endpoint (Prometheus text) |
| Body size | JSON bodies up to 1 MB (`413 PAYLOAD_TOO_LARGE` above) |
| Ids | UUIDs. A malformed id in a path is `400 BAD_REQUEST` ("Validation failed (uuid is expected)") |
| Money | decimal strings with two decimals in responses (`"355.00"`); requests accept a string or number with at most two decimals. Never floats; clients should not add amounts themselves, totals come from the API |
| Currency | ISO 4217 code next to each amount (`AED` unless the centre's default differs) |
| Date-times | ISO 8601 in UTC with milliseconds (`2026-10-09T06:11:02.220Z`) |
| Calendar dates | `YYYY-MM-DD`. Report periods, "today" and appointment calendars follow the centre's or branch's time zone, and responses say which (`timeZone`, `localDate`, `localTime`) |
| Phone numbers | E.164 (`+9715...`); spaces, dashes and brackets are stripped on input |
| Emails | stored and compared in lower case |
| Languages | API messages are **English only**. Labels that the API itself supplies in two languages are objects: `"statusLabel": { "en": "...", "ar": "..." }`. The web apps translate error codes they know |
| Validation | every body and query is validated with the Zod schemas of `packages/validation` (the same ones the web forms use). Unknown properties are dropped unless a module document says the body is strict; unknown query parameters are rejected by some modules (reports, dashboard) |
| Identity numbers | Emirates ID and passport numbers are returned masked (`"•••• 9015"`); the full value needs `customer.sensitive.read` on a dedicated, audited endpoint |
| Request id | every response carries `X-Request-Id`; a well-formed incoming `X-Request-Id` (8-64 letters, digits, hyphens) is kept. Error bodies repeat it as `requestId` |

Headers a client sends:

| Header | When | Meaning |
| --- | --- | --- |
| `Authorization: Bearer <access token>` | every authenticated call | see section 3 |
| `X-Client-App` | sign-in follow-ups and refresh | `centre`, `customer`, `corporate`, `platform` or `mobile`. Decides which refresh cookie is used; when missing or unknown the caller is treated as `mobile` |
| `X-Requested-With: typease` | `POST /auth/refresh` with the cookie | anti-CSRF check for the one endpoint that authenticates by cookie |
| `X-Tenant-Host` | optional | the portal host the user is on, when the request does not come from a browser on that host (server-side rendering, mobile white-label build) |
| `Idempotency-Key` | `POST /payments`, `POST /refunds` | see section 7 |
| `X-Request-Id` | optional | correlation id |
| `Accept-Language` | optional | allowed by CORS; the API does not localise by it |

CORS: credentials are allowed for the four app URLs, `CORS_ORIGINS`, every `<slug>.<PLATFORM_BASE_DOMAIN>`
of an existing centre and every verified custom domain. Requests without an `Origin` header (mobile app,
servers, webhooks) are not subject to CORS.

## 3. Authentication and sessions

### Tokens

| Token | Lifetime | Where it lives | Notes |
| --- | --- | --- | --- |
| Access token | `JWT_ACCESS_TTL_SECONDS` (default 900 s) | browser memory / mobile memory | JWT, HS256. Carries the user id, the session id, the app and, for a centre session, the tenant id and membership id. The API re-reads session, user and membership on every request, so a revoked session or suspended member is refused at once |
| Refresh token | `REFRESH_TTL_DAYS` (default 30) | browsers: HttpOnly cookie `te_rt_<app>`, `SameSite=Lax`, `Path=/api/v1/auth`, `Secure` when `COOKIE_SECURE=true`; mobile: returned in the body and kept in the platform keystore | random value, stored as SHA-256. **Rotated on every use.** Presenting a rotated token again ends every session of that sign-in (`REFRESH_TOKEN_REUSE` security event) |

### Sign-in

`POST /auth/login` with `{ email, password, app, tenantSlug?, deviceName? }` answers `200` with one of:

| `status` | Meaning | Next call |
| --- | --- | --- |
| `OK` | signed in: `accessToken`, `expiresIn`, `session`, `landing` (and `refreshToken` in the body for `app: "mobile"`; a cookie for the web apps) | - |
| `MFA_REQUIRED` | the account has two-step verification: `challengeToken` (5 minutes, 5 attempts) | `POST /auth/mfa/verify { challengeToken, code }` with an authenticator code or a recovery code |
| `SELECT_TENANT` | the person belongs to several centres in this app: `selectionToken`, `memberships[]` | `POST /auth/select-tenant { selectionToken, membershipId }` |

Which memberships count depends on `app`: `centre` signs in staff, `customer` and `mobile` customers and
company users, `corporate` company users, `platform` TypEase staff (no centre). For `customer`, `corporate`
and `mobile` the centre is `tenantSlug` or the centre of the host.

Failures: `401 INVALID_CREDENTIALS` (same answer for an unknown email and a wrong password),
`429 RATE_LIMITED` while the account is locked (`LOGIN_MAX_FAILURES` wrong passwords, default 5, lock for
`LOGIN_LOCK_MINUTES`, default 15), `403 EMAIL_NOT_VERIFIED`, `403 ACCOUNT_DISABLED`, `403 NO_ACCESS` (no
membership for this app or centre).

Other ways in: phone one-time code (`POST /auth/otp/request`, `/auth/otp/verify`; only for a verified phone
number, and only useful when an SMS provider is configured), accepting an invitation
(`GET /auth/invitations/preview`, `POST /auth/invitations/accept`), and for TypEase support a support session
(`POST /platform/access-grants/:id/enter`). There is no single sign-on (SAML / OIDC) integration.

### Keeping a session

| Call | Purpose |
| --- | --- |
| `POST /auth/refresh` | new access token and rotated refresh token. Web: send the cookie, `X-Client-App` and `X-Requested-With: typease` (without the header: `403 CSRF_CHECK_FAILED`). Mobile: `{ "refreshToken": "...", "app": "mobile" }` |
| `POST /auth/logout` | ends the session family and clears the cookie |
| `GET /auth/me` | user, centre, membership, permissions, support grant, whether MFA set-up is required |
| `GET /auth/memberships`, `POST /auth/switch-tenant` | a person with several centres moves the session to another one |
| `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-others` | the user's own devices. At most 20 live sessions per app and user: a further sign-in ends the oldest (`SESSION_LIMIT`) |
| `GET /auth/login-activity` | the user's last 50 sign-in attempts |
| `POST /auth/mfa/setup`, `/auth/mfa/enable`, `/auth/mfa/disable` | TOTP enrolment; enabling returns ten recovery codes once and ends the user's other sessions |
| `POST /auth/password/change`, `/auth/password/forgot`, `/auth/password/reset` | changing a password ends the other sessions; a reset ends all of them |

Password rule: at least 10 characters with an upper-case letter, a lower-case letter and a digit; at most
128 characters. The shared schema checks the floor of 10; the API's own policy
(`services/api/src/common/password-policy.ts`) applies `PASSWORD_MIN_LENGTH` (10 to 128, default 10) wherever a
password is set, and publishes the effective policy as `passwordPolicy` in `GET /public/tenant-config` and in
the invitation preview. Endpoints that could reveal whether an account exists (`forgot`,
`resend-verification`, `otp/request`) always answer `SENT_IF_REGISTERED`.

When `MFA_ENFORCEMENT=required` (forced in production), owners, managers, accountants and all TypEase staff
must enrol: until they do, every route except profile, security and sign-out answers
`403 MFA_SETUP_REQUIRED`, and `landing` points at the security page.

Development only: with `EXPOSE_DEV_TOKENS=true` (refused in production) responses of sign-up, registration,
invitation and OTP calls contain a `dev` object with the one-time token or code, because no mailbox exists.

## 4. Access rules

Every route carries exactly one access declaration (`services/api/src/common/auth/access.ts`). A route
without one answers `403 ACCESS_NOT_DECLARED`, and a test fails the build. The "Access" column of
[api/ENDPOINTS.md](api/ENDPOINTS.md) is printed from these declarations.

| Decorator | In the endpoint index | Meaning |
| --- | --- | --- |
| `@Public()` | `Public` | no sign-in. A valid bearer token, if sent, is still read so that public pages can personalise. Public routes are rate limited (a test checks it, with a short list of harmless exceptions such as health checks) |
| `@Internal()` | `Internal token` | header `x-internal-token` must equal `INTERNAL_API_TOKEN`. Only `GET /internal/metrics` |
| `@Authenticated({ allowWithoutMfa? })` | `Signed in` | any signed-in user; no centre needed. Profile, sessions, MFA |
| `@Permissions('a', 'b')` | `a or b` | a session bound to a centre whose role holds **any** of the listed permissions (or a support session whose grant includes one; a support session is otherwise read-only and reaches no route without a permission unless it is marked `@SupportSessionSafe` - `services/api/src/common/auth/support-session.ts`) |
| `@AllPermissions('a', 'b')` | `a and b` | **all** of the listed permissions |
| `@TenantMember({ kinds?, any?, allowSuspended? })` | `Any tenant member`, `member kind STAFF`, `member kind CUSTOMER; self.profile` ... | any active member of the centre, optionally limited to membership kinds and permissions. `allowSuspended` keeps the route usable when the centre is suspended (reading the reason, paying the subscription) |
| `@Platform('p')` | `Platform: p` | TypEase staff holding the platform permission, in a session that is **not** bound to a centre |

What the declaration does not decide: which rows. A permission says what a role may do; the services then
narrow by centre (row-level security), branch, assignment, own customer record or own company. A record
outside that scope answers `404 NOT_FOUND`, never `403`, so that its existence is not revealed.

Order of checks in `AuthGuard`: declared rule, bearer token, session / user / membership from the database,
centre status (`403 TENANT_UNAVAILABLE` when the centre is suspended, cancelled or archived), MFA policy,
membership kind, permissions (`403 FORBIDDEN`, with a `PERMISSION_DENIED` security event).

## 5. Tenant resolution

There is no tenant parameter on any authenticated endpoint. The centre is the one the session is bound to;
see [TENANT_ISOLATION.md](TENANT_ISOLATION.md), section 2. For unauthenticated calls:

| Input | Used by |
| --- | --- |
| `slug` / `tenantSlug` / `tenant` in the query or body | `GET /public/tenant-config?slug=`, `GET /public/services?slug=`, `POST /public/track`, `POST /auth/login`, `POST /auth/register`, guest booking |
| the host: `X-Tenant-Host`, else the host of the `Origin` header; `<slug>.<PLATFORM_BASE_DOMAIN>` or a verified custom domain | the same endpoints when no slug is given |
| `host` query parameter | `GET /public/tenant-config?host=` (server-side rendering of the portals) |

These inputs select public presentation and the centre a person signs in to. They never grant access.

## 6. Errors

Every error has the same envelope:

```json
{ "statusCode": 409, "code": "INVALID_TRANSITION", "message": "A request cannot go from Completed to New.",
  "details": { "from": "COMPLETED", "to": "SUBMITTED" }, "requestId": "bb1adf65-d487-4363-ac7f-6d09b08162a2" }
```

`code` is stable and machine-readable; `message` is a plain-language English sentence meant to be shown;
`details` is optional and code-specific.

Codes used across modules (module documents list their own):

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | body or query failed validation; `details: [{ path, message }]` |
| 400 | `BAD_REQUEST` | a malformed path parameter (for example an id that is not a UUID) or a body that is not valid JSON |
| 400 | `TOKEN_INVALID`, `CODE_INVALID` | one-time link or code invalid, expired or used |
| 400 | `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_INVALID` | section 7 |
| 401 | `UNAUTHENTICATED`, `TOKEN_INVALID`, `SESSION_EXPIRED`, `ACCOUNT_DISABLED`, `MFA_REQUIRED`, `MEMBERSHIP_INACTIVE`, `SUPPORT_ACCESS_ENDED`, `INVALID_CREDENTIALS` | not signed in, or the session is no longer valid. A client should try one refresh on `TOKEN_INVALID` and otherwise sign in again |
| 402 | `PLAN_LIMIT_REACHED` | a plan limit or a missing plan feature; `details.limit` names it |
| 403 | `FORBIDDEN` | the role lacks the permission |
| 403 | `PLATFORM_ONLY`, `TENANT_REQUIRED`, `TENANT_UNAVAILABLE`, `MFA_SETUP_REQUIRED`, `BRANCH_FORBIDDEN`, `NO_CUSTOMER_PROFILE`, `NO_CORPORATE_ACCOUNT`, `CSRF_CHECK_FAILED`, `ACCESS_NOT_DECLARED`, `SUPPORT_ACCESS_SCOPE`, `SUPPORT_ACCESS_READ_ONLY` | wrong kind of session or scope (the last two: a support session asked for something outside the scopes the centre approved, or for a change) |
| 403 | `TENANT_FORBIDDEN` | the database refused a cross-tenant reference or write |
| 403 | `SELF_APPROVAL_FORBIDDEN`, `SEGREGATION_OF_DUTIES` | the requester may not approve their own refund / discount; operator and reviewer must differ |
| 404 | `NOT_FOUND` | the record does not exist **or is outside the caller's scope** |
| 409 | `DUPLICATE`, `REFERENCE_CONFLICT`, `VERSION_CONFLICT` / `STALE_VERSION`, `INVALID_TRANSITION`, `IMMUTABLE_RECORD`, `IDEMPOTENCY_KEY_REUSED` | conflict with the current state |
| 413 | `PAYLOAD_TOO_LARGE`, `FILE_TOO_LARGE` | body or file too large |
| 422 | module-specific codes, `CONSTRAINT_VIOLATION` | well-formed request that breaks a business rule |
| 429 | `RATE_LIMITED` | too many requests or attempts; `details.retryAfterSeconds` for route limits |
| 500 | `INTERNAL_ERROR` | unexpected; the stack trace is logged with the request id, never returned |
| 502 | `GATEWAY_ERROR` | the payment gateway could not open a checkout |
| 503 | `INTEGRATION_NOT_CONFIGURED` | an external service has no credentials (payment gateway, OCR ...). The message says what to configure |

## 7. Lists, idempotency, rate limits

### Lists

List endpoints answer `{ "data": [...], "meta": { "page", "pageSize", "total", "totalPages" } }`.

| Parameter | Rule |
| --- | --- |
| `page` | from 1; default 1 |
| `pageSize` | 1 to 100; default 20 (report drill-downs allow 200) |
| `sort` | `field:asc` or `field:desc`. Each endpoint has an allow-list of sortable fields (in its module document); a field outside it falls back to the default sort. Ties are broken by id, so paging is stable |
| `q` | free-text search, at most 120 characters; what it searches is defined per endpoint |
| filters | per endpoint. A filter can narrow the caller's scope and never widen it |

A few endpoints return a plain array because the set is small and bounded: branches, roles, staff, workflow
definitions, document types, public plans.

### Idempotency

`POST /payments` and `POST /refunds` require the header `Idempotency-Key` (8-128 characters, for example a
UUID created once per user intent):

- the first request runs and its response is stored with the key in the same transaction;
- the same key with the same body returns the stored response with the header `Idempotent-Replayed: true`;
- the same key with a different body is `409 IDEMPOTENCY_KEY_REUSED`;
- a failed request stores nothing and can be retried with the same key;
- keys are per centre and operation and expire after 24 hours.

Other writes are protected differently: gateway webhooks by a unique event id, notification and automation
effects by dedupe keys, one-time tokens by an atomic "consume", status changes by a row lock and an optional
`version` (optimistic concurrency on customers, services, requests, quotations and invoices).

### Rate limits

Counted in Redis per client address in fixed windows; exceeding one answers `429 RATE_LIMITED`.
`RATE_LIMIT_ENABLED=false` switches all of them off (development and tests only; the production readiness
check fails on it). When Redis is unreachable, limits fail open outside production and closed in production.

| Bucket | Limit |
| --- | --- |
| every request (`RATE_LIMIT_GLOBAL_PER_MINUTE`) | 600 per minute per address |
| `POST /auth/login` | 10 per 5 minutes per address and email |
| `POST /auth/mfa/verify` | 10 per 5 minutes |
| `POST /auth/otp/request` / `otp/verify` | 5 / 10 per 10 minutes per address and phone; additionally one code per phone per minute |
| `POST /auth/password/forgot`, `/auth/resend-verification` | 5 per 15 minutes per address and email |
| `POST /auth/password/reset` | 10 per 15 minutes |
| `POST /auth/verify-email` | 20 per 10 minutes |
| `POST /auth/register` | 10 per hour |
| `POST /auth/refresh` | 60 per minute |
| invitation preview / accept | 30 per 10 minutes |
| `POST /auth/phone/request-verification` | 5 per 15 minutes |
| `POST /public/signup` | 5 per hour |
| `GET /public/slug-available` | 60 per minute |
| `POST /public/track` | 10 per 15 minutes per address and request number |
| public catalogue, `GET /public/plans`, queue display | 120 per minute |
| queue display stream | 30 per minute |
| guest booking: options and availability / book / cancel | 60 per minute / 20 per hour / 10 per hour |
| `GET /public/shared-documents/:token` | 30 per minute |
| payment and subscription webhooks | 300 per minute |
| `GET /customers/:id/identity` | 60 per minute |
| local storage upload / download tickets | 120 / 240 per minute |
| connection tests of integrations | 12 per minute per centre |

Separate from these: account lockout after failed passwords, attempt counters on one-time codes, and the
per-recipient hourly limit and monthly plan limit of outgoing notifications.

## 8. Files and webhooks

### Uploading a document in three steps

1. `POST /documents/upload-intents` with the owner (`customerId`, `corporateAccountId` or `requestId`), the
   `documentTypeKey`, `filename`, `mime` and exact `sizeBytes`. The answer contains `documentId`, `versionId`
   and `upload: { url, method: "PUT", headers, expiresAt }`.
2. `PUT` the raw bytes to `upload.url` with exactly the headers given. With S3 storage this goes to the
   object store; with the local driver to the API. The URL is valid for `UPLOAD_URL_TTL_SECONDS`.
3. `POST /documents/:id/versions/:versionId/complete`. The server moves the file out of the staging area,
   checks size and content type against the declaration, records the SHA-256 and queues the malware scan.

`POST /documents/upload` does the same in one `multipart/form-data` request (one file) for simple clients.
Files are fetched with `POST /documents/:id/download-link` or `/preview-link`, which return a URL valid for
`DOWNLOAD_URL_TTL_SECONDS`. Allowed types by default: PDF, JPEG, PNG, WebP; maximum 15 MB.
Full rules and error codes: [api/modules/documents.md](api/modules/documents.md).

### Incoming webhooks

| Route | Sender | Verification |
| --- | --- | --- |
| `POST /public/webhooks/payments/:gateway` | the centre's payment gateway (customer payments) | signature over the **raw body**, with that centre's own secret; timestamp within `PAYMENT_WEBHOOK_TOLERANCE_SECONDS` (default 300); each event id is processed once |
| `POST /public/webhooks/subscriptions/:gateway` | the platform's payment gateway (subscription invoices) | the same, with the platform's secret |

Signature formats: Stripe's `Stripe-Signature: t=<unix>,v1=<hex>` (HMAC-SHA256 over `<t>.<raw body>`); the
sandbox gateway uses the same format in `x-typease-sandbox-signature`. An invalid signature answers
`400 WEBHOOK_SIGNATURE_INVALID`, records a security event and changes nothing. A duplicate delivery answers
`200 { "duplicate": true }`. Nothing is marked paid before a verified webhook arrives. The Stripe adapter was
written from Stripe's public documentation and has **not** been verified against Stripe.

### Outgoing webhooks

The automation action `call_webhook` sends a signed `POST` to the configured n8n base address or to a URL on
the operator's allow-list (`OUTBOUND_WEBHOOK_ALLOWED_HOSTS`). Headers:

```
X-TypEase-Event:     request.submitted
X-TypEase-Delivery:  <executionId>:<actionIndex>      (identical on every retry: deduplicate on it)
X-TypEase-Timestamp: <unix seconds>
X-TypEase-Signature: sha256=<hex of HMAC-SHA256("<timestamp>.<raw body>", signing secret)>
```

Verification on the receiving side (Node):

```js
const crypto = require('node:crypto');
function verify(rawBody, headers, secret, toleranceSeconds = 300) {
  const ts = headers['x-typease-timestamp'];
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const given = headers['x-typease-signature'] ?? '';
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= toleranceSeconds;
  return fresh && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

The body is `{ "event", "tenantSlug", "occurredAt", "data" }` with identifiers, codes, amounts and dates only
(no names, contact details, identity numbers or document contents). Destination rules and retry behaviour:
[api/modules/automation.md](api/modules/automation.md). There is no general "subscribe to events" API for
third parties and no API-key authentication. The plan feature `apiAccess` that earlier builds advertised was
retired: the validation schema strips it from plan bodies (`RETIRED_PLAN_FEATURE_KEYS` in
`packages/validation`), it is never stored or returned, and `PLAN_FEATURE_KEYS` in `packages/types` still
lists it only so that older clients keep type-checking.

## 9. Worked examples

Captured against `http://localhost:4000` with the demo accounts (password `TypEase-Demo-2026`) and a
throw-away centre created for the write examples. Ids and timestamps are from that run.

### 9.1 Sign in and call the API

```bash
curl -s -D - http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' -H 'x-client-app: centre' \
  -d '{"email":"owner@al-noor.test","password":"TypEase-Demo-2026","app":"centre"}'
```

```
HTTP/1.1 200 OK
Set-Cookie: te_rt_centre=<redacted>; Max-Age=2592000; Path=/api/v1/auth; Expires=Sun, 08 Nov 2026 06:10:02 GMT; HttpOnly; SameSite=Lax
```

```json
{
  "status": "OK",
  "accessToken": "<redacted>",
  "expiresIn": 900,
  "session": {
    "user": { "id": "bfa45387-ae08-4cf3-af7d-54ee9d908b49", "email": "owner@al-noor.test", "phone": "+971590000001",
              "fullName": "Salem Al Marri", "preferredLanguage": "en", "platformRole": null,
              "mfaEnabled": false, "emailVerified": true, "phoneVerified": true },
    "tenant": { "id": "b3001dbc-3c31-4959-8c81-cca80a2ec840", "slug": "al-noor", "name": "Al Noor Typing Centre",
                "status": "ACTIVE", "timezone": "Asia/Dubai", "currency": "AED" },
    "membership": { "id": "26849344-3da7-4d86-9d17-e6804edc9784", "kind": "STAFF", "roleKey": "owner",
                    "roleName": "Centre Owner", "allBranches": true, "branchIds": [], "customerId": null, "corporateAccountId": null },
    "permissions": ["customer.read", "customer.create", "... 68 more ..."],
    "supportGrant": null,
    "mfaRequiredSetup": false
  },
  "landing": "/dashboard"
}
```

(The cookie has no `Secure` attribute here because the development environment runs with
`COOKIE_SECURE=false`; production requires `true`.)

A customer of the same centre signs in with `"app": "customer", "tenantSlug": "al-noor"`. Their
`GET /auth/me` shows what a customer session is:

```json
{ "tenant": { "slug": "al-noor", "status": "ACTIVE", "...": "..." },
  "membership": { "kind": "CUSTOMER", "roleKey": "customer", "roleName": "Customer", "allBranches": true, "branchIds": [],
                  "customerId": "b8a89dd1-6c26-4d4c-a434-1058e5605df4", "corporateAccountId": null },
  "permissions": ["self.profile", "self.requests", "self.documents", "self.payments", "self.appointments", "self.tickets", "self.privacy"],
  "supportGrant": null, "mfaRequiredSetup": false }
```

### 9.2 A list with paging, sorting and a filter

```bash
curl -s 'http://localhost:4000/api/v1/requests?pageSize=2&sort=createdAt:desc&status=AWAITING_PAYMENT' \
  -H "authorization: Bearer $TOKEN"
```

```json
{
  "data": [
    {
      "id": "9b60bbfc-c0f5-413c-9795-6bf198532596",
      "requestNo": "AN-000059",
      "status": "AWAITING_PAYMENT",
      "priority": "NORMAL",
      "source": "ONLINE",
      "paymentStatus": "UNPAID",
      "branchId": "27f2ec83-d694-45ea-97ce-f0e94903ac01",
      "serviceId": "4dcdc291-2818-4b6d-adf3-f94661e7cec5",
      "corporateAccountId": null,
      "submittedAt": "2026-10-08T07:54:05.551Z",
      "targetDate": "2026-10-16T09:15:50.818Z",
      "completedAt": null,
      "createdAt": "2026-10-08T06:54:05.550Z",
      "updatedAt": "2026-10-08T10:24:05.574Z",
      "externalStatus": null,
      "statusLabel": { "en": "Awaiting payment", "ar": "بانتظار الدفع" },
      "customer": { "id": "1226b1b3-ad7e-4a88-a854-12cf628551e8", "customerNo": "CUS-000024", "fullName": "Hassan El Sayed" },
      "customerName": "Hassan El Sayed",
      "service": { "id": "4dcdc291-2818-4b6d-adf3-f94661e7cec5", "name": "Emirates ID application typing (document preparation)",
                   "nameAr": "طباعة طلب الهوية الإماراتية (تجهيز المستندات)", "code": "ST-EID-TYPING" },
      "serviceName": "Emirates ID application typing (document preparation)",
      "assignee": null,
      "assigneeName": null,
      "overdue": false
    },
    { "id": "5c85db4a-359b-4e85-bbc5-18acd7d30943", "requestNo": "AN-000052", "status": "AWAITING_PAYMENT", "...": "..." }
  ],
  "meta": { "page": 1, "pageSize": 2, "total": 3, "totalPages": 2 }
}
```

The same endpoint called by the customer Aisha Rahman returns only her own requests, with the customer
wording of the status and without the assignee fields:

```json
{ "data": [ { "requestNo": "AN-000052", "status": "AWAITING_PAYMENT",
              "statusLabel": { "en": "Payment required", "ar": "الدفع مطلوب" }, "overdue": false, "...": "..." } ],
  "meta": { "page": 1, "pageSize": 1, "total": 3, "totalPages": 3 } }
```

### 9.3 Errors as they come back

| Situation | Response |
| --- | --- |
| No token: `GET /requests` | `401` `{"statusCode":401,"code":"UNAUTHENTICATED","message":"Please sign in to continue.","requestId":"c1a834e1-..."}` |
| A request id of Al Noor opened with a Gulf Star owner token | `404` `{"statusCode":404,"code":"NOT_FOUND","message":"Request was not found.","requestId":"f3e44e28-..."}` |
| Receptionist creates a branch (`POST /branches`) | `403` `{"statusCode":403,"code":"FORBIDDEN","message":"You do not have permission to do this.","requestId":"189753fb-..."}` |
| Centre token on `GET /platform/tenants` | `403` `{"statusCode":403,"code":"PLATFORM_ONLY","message":"This area is for TypEase platform staff.", ...}` |
| Platform token on `GET /customers` | `403` `{"statusCode":403,"code":"TENANT_REQUIRED","message":"Select a centre to continue.", ...}` |
| `POST /requests/:id/transition {"to":"SUBMITTED"}` on a completed request | `409` `{"statusCode":409,"code":"INVALID_TRANSITION","message":"A request cannot go from Completed to New.","details":{"from":"COMPLETED","to":"SUBMITTED"}, ...}` |
| Cookie refresh without `X-Requested-With` | `403` `{"statusCode":403,"code":"CSRF_CHECK_FAILED","message":"Request blocked.", ...}` |
| `POST /public/track` with a wrong tracking code | `404` `{"statusCode":404,"code":"NOT_FOUND","message":"Request was not found.", ...}` |

Validation (`POST /customers` with `{"fullName":"","email":"not-an-email","phone":"12"}`):

```json
{ "statusCode": 400, "code": "VALIDATION_FAILED", "message": "Please check the highlighted fields.",
  "details": [ { "path": "fullName", "message": "String must contain at least 2 character(s)" },
               { "path": "email", "message": "Invalid email" },
               { "path": "phone", "message": "Use international format, e.g. +971501234567" } ],
  "requestId": "be5a617e-649a-40d6-afb8-d360befa2747" }
```

### 9.4 Public tenant configuration

```bash
curl -s 'http://localhost:4000/api/v1/public/tenant-config?slug=al-noor'
```

```json
{
  "tenantId": "b3001dbc-3c31-4959-8c81-cca80a2ec840",
  "slug": "al-noor",
  "name": "Al Noor Typing Centre",
  "nameAr": "مركز النور للطباعة",
  "mode": "WHITE_LABEL",
  "logoUrl": "http://localhost:4000/api/v1/public/assets/X5ycQGA5NODJFdozVRsSyhnMx8qVf1tp.png",
  "faviconUrl": null,
  "colors": { "primary": "#0E7C61", "secondary": "#0B3D2E", "accent": "#F2A900" },
  "websiteTitle": "Al Noor Typing Centre - Customer Portal",
  "tagline": "Your documents, done right.",
  "supportEmail": "support@al-noor.test",
  "supportPhone": "+971590000001",
  "defaultLanguage": "en",
  "currency": "AED",
  "timezone": "Asia/Dubai",
  "publicCatalogueEnabled": true,
  "features": { "selfRegistration": true, "corporatePortal": true, "open": true }
}
```

### 9.5 A new centre: sign-up, customer, document upload

A centre signs up (development answer with `EXPOSE_DEV_TOKENS=true`; in production the token only travels by
email):

```bash
curl -s -X POST http://localhost:4000/api/v1/public/signup -H 'content-type: application/json' -d '{
  "businessName":"Docs Example Typing (fictional)","slug":"docs-example","ownerName":"Dana Example",
  "email":"owner@docs-example.test","phone":"+971590008877","password":"<password>",
  "preferredLanguage":"en","acceptTerms":true}'
```

```json
{ "tenantId": "dad0633f-c61f-4298-87c5-5500ff2642a7", "slug": "docs-example", "status": "VERIFICATION_SENT",
  "email": "owner@docs-example.test", "dev": { "emailVerificationToken": "<redacted>" } }
```

`POST /auth/verify-email { "token": "..." }` answers `{"status":"VERIFIED"}`; the owner then signs in and
`landing` is `/onboarding`. Registering a customer (`POST /customers`, `201`):

```json
{ "id": "71eb4993-63e8-4ec4-b274-2b75e322d330", "tenantId": "dad0633f-c61f-4298-87c5-5500ff2642a7",
  "customerNo": "CUS-000001", "type": "INDIVIDUAL", "status": "ACTIVE", "fullName": "Sample Customer One",
  "preferredLanguage": "en", "email": "sample.one@example.test", "phone": "+971590008878", "nationality": "IN",
  "communicationPrefs": { "email": true, "sms": true, "whatsapp": false, "push": true },
  "emiratesIdMasked": "•••• 9015", "hasEmiratesId": true, "passportNoMasked": null, "hasPassport": false,
  "version": 1, "createdAt": "2026-10-09T06:10:41.658Z", "...": "..." }
```

The Emirates ID that was sent in the request is not in the response; only the masked tail is.

Upload, step 1 (`POST /documents/upload-intents`, `201`):

```json
{ "customerId": "71eb4993-63e8-4ec4-b274-2b75e322d330", "documentTypeKey": "passport",
  "filename": "sample-fictional.pdf", "mime": "application/pdf", "sizeBytes": 193 }
```

```json
{ "documentId": "eba20e4c-de37-4869-8db7-b523b9bc4258", "versionId": "24c08e6f-71a4-4c80-90e2-44b2d7123722",
  "upload": { "url": "http://localhost:4000/api/v1/storage/local/upload/<signed single-use ticket>",
              "method": "PUT", "headers": { "Content-Type": "application/pdf" }, "expiresAt": "2026-10-09T06:20:41.789Z" } }
```

Step 2, `PUT <upload.url>` with the bytes and `Content-Type: application/pdf`: `200 {"status":"UPLOADED"}`.
Step 3, `POST /documents/eba20e4c-.../versions/24c08e6f-.../complete`:

```json
{ "documentId": "eba20e4c-de37-4869-8db7-b523b9bc4258", "versionId": "24c08e6f-71a4-4c80-90e2-44b2d7123722",
  "versionNo": 1, "status": "PENDING_SCAN", "isCurrentVersion": true, "filename": "sample-fictional.pdf",
  "mime": "application/pdf", "sizeBytes": 193, "scanStatus": "PENDING" }
```

A moment later `GET /documents/:id` shows the outcome of the scan job. No scanner is configured on the
development machine, which the API states instead of calling the file clean:

```json
{ "id": "eba20e4c-de37-4869-8db7-b523b9bc4258", "documentTypeKey": "passport", "title": "Passport",
  "status": "AVAILABLE", "verificationStatus": "UNVERIFIED", "uploadedByType": "STAFF", "downloadable": true,
  "currentVersion": { "versionNo": 1, "filename": "sample-fictional.pdf", "mime": "application/pdf", "sizeBytes": 193,
                      "uploadStatus": "COMPLETED", "scanStatus": "SKIPPED", "scanEngine": "none",
                      "scanDetail": "No malware scanner is configured.",
                      "sha256": "794abaa4f6f06fc519895c22944a0ab43ad02b4fb32bdefa1952ce81613cb47b" },
  "customerVisible": true, "legalHold": false, "...": "..." }
```

`POST /documents/:id/download-link`:

```json
{ "url": "http://localhost:4000/api/v1/storage/local/download/<signed ticket>", "expiresAt": "2026-10-09T06:12:44.078Z",
  "filename": "sample-fictional.pdf", "mime": "application/pdf", "sizeBytes": 193, "disposition": "attachment" }
```

### 9.6 An invoice, a payment with an idempotency key, and the pass-through liability

Draft invoice (`POST /invoices`) with one service-fee line taxed at 5% and one government-fee line:

```json
{ "customerId": "71eb4993-63e8-4ec4-b274-2b75e322d330", "branchId": "fdcf907a-e44e-48ad-842b-dbedea2979da",
  "items": [ { "description": "Sample typing service fee", "component": "SERVICE_FEE", "quantity": 1, "unitAmount": "100.00", "taxRatePercent": 5 },
             { "description": "Sample government fee (collected on behalf of the authority)", "component": "GOVERNMENT_FEE", "quantity": 1, "unitAmount": "250.00" } ] }
```

```json
{ "id": "a3f97a1b-31dc-41c2-b179-af99cbdcb34c", "invoiceNo": "DRAFT-CA9C75943D69", "status": "DRAFT", "currency": "AED",
  "subtotalServiceFee": "100.00", "subtotalGovernmentFee": "250.00", "subtotalThirdParty": "0.00",
  "discountTotal": "0.00", "taxTotal": "5.00", "total": "355.00",
  "amountPaid": "0.00", "amountCredited": "0.00", "amountRefunded": "0.00", "balanceDue": "355.00",
  "invoiceItems": [
    { "description": "Sample typing service fee", "component": "SERVICE_FEE", "quantity": "1.00", "unitAmount": "100.00",
      "discountAmount": "0.00", "taxRatePercent": "5.00", "taxAmount": "5.00", "lineTotal": "105.00", "sortOrder": 0 },
    { "description": "Sample government fee (collected on behalf of the authority)", "component": "GOVERNMENT_FEE",
      "quantity": "1.00", "unitAmount": "250.00", "discountAmount": "0.00", "taxRatePercent": "0.00", "taxAmount": "0.00",
      "lineTotal": "250.00", "sortOrder": 1 } ], "...": "..." }
```

`POST /invoices/:id/issue` gives it its number: `"invoiceNo": "INV-000001", "status": "ISSUED"`. From then on
`PATCH /invoices/:id` answers
`409 {"code":"INVOICE_ISSUED","message":"An issued invoice cannot be edited. Issue a credit note to correct it, or void it if nothing has been paid."}`.

Recording a part payment without the header:

```json
{ "statusCode": 400, "code": "IDEMPOTENCY_KEY_REQUIRED",
  "message": "Send an Idempotency-Key header (a unique value per attempt, e.g. a UUID) so a retry can never record this twice.",
  "requestId": "404117fa-b233-4a83-8bed-e6f736a40223" }
```

With the header (`POST /payments`, `Idempotency-Key: <uuid>`, `201 Created`):

```json
{ "method": "CASH", "amount": "100.00", "branchId": "fdcf907a-e44e-48ad-842b-dbedea2979da",
  "allocations": [ { "invoiceId": "a3f97a1b-31dc-41c2-b179-af99cbdcb34c", "amount": "100.00" } ] }
```

```json
{ "id": "1ff55a7a-5719-4bc0-9212-ff4f8cda02b2", "paymentNo": "PAY-000001", "receiptNo": "RCT-000001",
  "method": "CASH", "status": "COMPLETED", "amount": "100.00", "refundedAmount": "0.00", "currency": "AED",
  "receivedAt": "2026-10-09T06:11:02.220Z",
  "paymentAllocations": [ { "invoiceId": "a3f97a1b-31dc-41c2-b179-af99cbdcb34c", "amount": "100.00",
                            "invoice": { "invoiceNo": "INV-000001", "status": "PARTIALLY_PAID", "balanceDue": "255.00" } } ],
  "unallocatedAmount": "0.00", "...": "..." }
```

Sending exactly the same request again returned `201` with the header `Idempotent-Replayed: true` and the
same payment (`PAY-000001`); nothing was recorded twice. The same key with a different amount:

```json
{ "statusCode": 409, "code": "IDEMPOTENCY_KEY_REUSED",
  "message": "This Idempotency-Key was already used for a different request. Use a new key for a new operation." }
```

`GET /finance/liabilities` afterwards shows the share of the 100.00 that belongs to the authority
(`100.00 x 250.00 / 355.00 = 70.42`); it is not the centre's revenue:

```json
{ "currency": "AED",
  "components": [
    { "component": "GOVERNMENT_FEE", "name": "Government fee (collected on behalf of the authority)",
      "treatment": "PASS_THROUGH_LIABILITY", "accrued": "70.42", "reversed": "0.00", "remitted": "0.00", "outstanding": "70.42" },
    { "component": "THIRD_PARTY_FEE", "name": "Third-party processing charge",
      "treatment": "PASS_THROUGH_LIABILITY", "accrued": "0.00", "reversed": "0.00", "remitted": "0.00", "outstanding": "0.00" } ],
  "totalOutstanding": "70.42" }
```

### 9.7 The platform console's view of centres

`GET /platform/tenants?pageSize=2&sort=createdAt:asc` as a platform super admin: centre-level data only.

```json
{ "data": [
    { "id": "b3001dbc-3c31-4959-8c81-cca80a2ec840", "slug": "al-noor", "name": "Al Noor Typing Centre",
      "legalName": "Al Noor Typing Centre LLC (demo)", "status": "ACTIVE", "emirate": "Dubai",
      "contactEmail": "info@al-noor.test", "contactPhone": "+971590000001",
      "suspendedAt": null, "suspensionReason": null, "archivedAt": null, "offboardingAt": null,
      "createdAt": "2026-06-15T00:02:23.438Z", "plan": { "key": "business", "name": "Business" },
      "subscription": { "status": "ACTIVE", "billingCycle": "MONTHLY",
                        "currentPeriodEnd": "2026-10-29T10:00:00.000Z", "trialEndsAt": "2026-06-29T10:00:00.000Z" } },
    { "slug": "gulf-star", "name": "Gulf Star Document Services", "status": "ACTIVE", "plan": { "key": "professional", "name": "Professional" }, "...": "..." } ],
  "meta": { "page": 1, "pageSize": 2, "total": 8, "totalPages": 4 } }
```

## 10. Module index

| API group (tags in the endpoint index) | Paths | Reference |
| --- | --- | --- |
| Authentication | `/auth/*` | section 3; `services/api/src/modules/auth` |
| Tenants, Branches, Users, Roles, Branding | `/tenant`, `/onboarding`, `/branches`, `/staff`, `/roles`, `/branding`, `/domains` | [WHITE_LABEL_GUIDE.md](WHITE_LABEL_GUIDE.md), [ROLE_PERMISSION_MATRIX.md](ROLE_PERMISSION_MATRIX.md); `services/api/src/modules/tenancy` |
| Public | `/public/*` | the owning module's document (catalogue, appointments, queue, requests, finance, subscriptions, documents) |
| Customers, Customer tags, My profile | `/customers`, `/customer-tags`, `/me/customer`, `/me/consents` | [api/modules/customers.md](api/modules/customers.md) |
| Corporate accounts, Corporate portal | `/corporate-accounts`, `/corporate/*` | [api/modules/corporate.md](api/modules/corporate.md) |
| Service categories, Document types, Services, Catalogue (portal) | `/service-categories`, `/document-types`, `/services`, `/catalogue` | [api/modules/catalogue.md](api/modules/catalogue.md) |
| Workflows | `/workflows` | [api/modules/workflows.md](api/modules/workflows.md) |
| Requests | `/requests`, `/public/track` | [api/modules/requests.md](api/modules/requests.md), [workflows/REQUEST_LIFECYCLE.md](workflows/REQUEST_LIFECYCLE.md) |
| Documents, Storage | `/documents`, `/storage/local/*`, `/public/shared-documents` | [api/modules/documents.md](api/modules/documents.md) |
| AI document assistant | `/documents/:id/extract`, `/ocr/*` | [api/modules/ocr.md](api/modules/ocr.md) |
| Quotations, Invoices, Payments, Refunds, Finance, Reconciliation | `/quotations`, `/invoices`, `/payments`, `/refunds`, `/credit-notes`, `/expenses`, `/finance/*`, `/reconciliations`, `/public/webhooks/payments` | [api/modules/finance.md](api/modules/finance.md) |
| Subscription, Platform billing | `/subscription`, `/onboarding/plan`, `/public/plans`, `/platform/plans`, `/platform/coupons`, `/platform/billing/*` | [api/modules/subscriptions.md](api/modules/subscriptions.md) |
| Appointments | `/appointments`, `/me/appointments`, `/public/appointments` | [api/modules/appointments.md](api/modules/appointments.md) |
| Queue | `/queue`, `/public/queue/display` | [api/modules/queue.md](api/modules/queue.md) |
| Tasks | `/tasks` | [api/modules/tasks.md](api/modules/tasks.md) |
| Notifications | `/notifications`, `/me/notifications`, `/me/notification-preferences`, `/me/devices` | [api/modules/notifications.md](api/modules/notifications.md) |
| Reminders | `/reminders`, `/me/reminders` | [api/modules/reminders.md](api/modules/reminders.md) |
| Automations | `/automations` | [api/modules/automation.md](api/modules/automation.md) |
| Reports | `/reports` | [api/modules/reports.md](api/modules/reports.md) |
| Dashboard | `/dashboard` | [api/modules/dashboard.md](api/modules/dashboard.md) |
| Support | `/support/*`, `/me/tickets`, `/me/feedback`, `/platform/support/*` | [api/modules/support.md](api/modules/support.md) |
| Audit logs | `/audit-logs` | [api/modules/audit.md](api/modules/audit.md) |
| Privacy | `/privacy/*`, `/platform/privacy/*` | [api/modules/privacy.md](api/modules/privacy.md) |
| Integrations | `/integrations`, `/platform/integrations/*` | [api/modules/integrations.md](api/modules/integrations.md) |
| Platform, Support access, Feature flags, Internal | `/platform/*`, `/support-access`, `/feature-flags`, `/internal/metrics` | [api/modules/platform.md](api/modules/platform.md) |
| Health | `/health`, `/health/ready` | liveness returns `{"status":"ok","service":"typease-api","time":"..."}`; readiness returns `{"status":"ready","checks":{"database":true,"systemDatabase":true,"redis":true}}`, or `503` with `"status":"degraded"` |

There are no module documents for `auth`, `tenancy`, `storage` and `health`; this file, the two guides linked
above and the source are their reference.

## 11. OpenAPI and Swagger UI

| | |
| --- | --- |
| Swagger UI | `GET /api/docs` on the API host. Served only when `NODE_ENV` is not `production` |
| Live OpenAPI JSON | `GET /api/docs-json` (same condition) |
| Committed copies | [api/openapi.json](api/openapi.json) and [api/ENDPOINTS.md](api/ENDPOINTS.md) |
| Regenerate | `pnpm openapi` (root) or `pnpm --filter @typease/api openapi`. It boots the application without listening (the database must be reachable; use the same environment as the API), writes both files and exits non-zero if any route has no access rule |

The OpenAPI document describes paths, parameters, the bearer security scheme and the request bodies
(generated from the Zod schemas; the committed copy has 254 operations with a body out of 589). **Response
bodies are not described** in it; the module documents show them. One route of the endpoint index is
missing from the OpenAPI document by design: `GET /api/v1/storage/local/download/:token` carries
`@ApiExcludeEndpoint()`, so `ENDPOINTS.md` has one row more than `openapi.json` has operations.

The committed copies must be regenerated after a route is added (`pnpm openapi`). Treat a fresh run as
authoritative over the figures quoted here.

A typed client for the web apps is `packages/api-client` (hand-written endpoint groups on a fetch wrapper
that handles refresh, idempotency keys and the three upload steps). The Flutter app has its own hand-written
models. Neither is generated from the OpenAPI file.
