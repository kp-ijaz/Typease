# Security checklist

A statement of what TypEase does and does not do for security, item by item, with the place in the code and
the automated test that exercises it.

> **No independent security review and no penetration test have been performed on this code base.** Every
> "Implemented" below means "the code contains the control and, where a test file is named, an automated
> test written by the same team exercises it". It does not mean the control has been assessed by anyone
> else, and it is not a certification of any kind. Commission an independent review before handling real
> customers' identity documents.

## Contents

1. [How to read this document](#1-how-to-read-this-document)
2. [Specification section 30 at a glance](#2-specification-section-30-at-a-glance)
3. [Authentication](#3-authentication)
4. [Password policy](#4-password-policy)
5. [Multi-factor authentication](#5-multi-factor-authentication)
6. [Lockout and rate limiting](#6-lockout-and-rate-limiting)
7. [Sessions](#7-sessions)
8. [Access control and tenant isolation](#8-access-control-and-tenant-isolation)
9. [Input validation](#9-input-validation)
10. [Output encoding and injection](#10-output-encoding-and-injection)
11. [CSRF and CORS](#11-csrf-and-cors)
12. [Security headers and Content Security Policy](#12-security-headers-and-content-security-policy)
13. [File upload and document access](#13-file-upload-and-document-access)
14. [Encryption at rest](#14-encryption-at-rest)
15. [Encryption in transit](#15-encryption-in-transit)
16. [Secrets and configuration](#16-secrets-and-configuration)
17. [Audit logging and security events](#17-audit-logging-and-security-events)
18. [Sensitive data in logs](#18-sensitive-data-in-logs)
19. [Webhooks, outbound requests and idempotency](#19-webhooks-outbound-requests-and-idempotency)
20. [Dependencies and supply chain](#20-dependencies-and-supply-chain)
21. [Backups and restore](#21-backups-and-restore)
22. [Monitoring and incident response](#22-monitoring-and-incident-response)
23. [Mobile application](#23-mobile-application)
24. [Known gaps](#24-known-gaps)
25. [Pre-go-live checklist for the operator](#25-pre-go-live-checklist-for-the-operator)

## 1. How to read this document

**Status**

| Status | Meaning |
| --- | --- |
| Implemented | The control exists in the code as described |
| Partly | Part of the control exists; the row says which part is missing |
| Not implemented | The control does not exist |
| Operator responsibility | The software cannot provide this by itself; whoever hosts it has to |

**Verified by**

- A file name means an automated test in the repository exercises the control. Paths are relative to
  `services/api/` unless they start with `packages/`, `database/` or `tests/` (the acceptance suite,
  [TESTING.md](TESTING.md)). Whether the tests passed in a given run is recorded in
  [TEST_REPORT.md](TEST_REPORT.md), not here. No browser end-to-end suite exists.
- "Not verified" means there is no automated test, or the control was only checked by reading the code or the
  configuration.
- The API tests run against a real PostgreSQL with row-level security and a real Redis. They do not run
  against any external provider.

The headings follow the topic areas of the OWASP Application Security Verification Standard loosely, as a
familiar order. **This is not an ASVS assessment** and no ASVS level is claimed.

Things never executed in the environment this was built in, and therefore unverified wherever they appear
below: the Docker images and Compose stacks (validated statically only), the reverse proxy, the CI
workflows, the Flutter application, and every external provider (Stripe, Twilio, Meta WhatsApp, FCM, S3,
ClamAV, a real SMTP relay, external OCR, n8n).

## 2. Specification section 30 at a glance

| Requirement | Status | Section |
| --- | --- | --- |
| Tenant isolation | Implemented | [8](#8-access-control-and-tenant-isolation), [TENANT_ISOLATION.md](TENANT_ISOLATION.md) |
| Strong authentication | Implemented (password and phone OTP; no SSO) | [3](#3-authentication) |
| MFA for privileged roles | Partly (TOTP only; custom roles are never forced) | [5](#5-multi-factor-authentication) |
| RBAC | Implemented | [8](#8-access-control-and-tenant-isolation) |
| Resource-level authorisation | Implemented | [8](#8-access-control-and-tenant-isolation) |
| Secure session handling | Implemented | [7](#7-sessions) |
| Encryption in transit | Operator responsibility (configuration provided, not exercised) | [15](#15-encryption-in-transit) |
| Encryption at rest | Partly (selected fields and local files; key rotation with a re-encryption tool) | [14](#14-encryption-at-rest) |
| Secrets management | Partly (validated environment variables; no secret manager integration) | [16](#16-secrets-and-configuration) |
| Secure document access | Implemented | [13](#13-file-upload-and-document-access) |
| Audit logging | Implemented | [17](#17-audit-logging-and-security-events) |
| Rate limiting | Implemented (per IP address) | [6](#6-lockout-and-rate-limiting) |
| Input validation | Implemented | [9](#9-input-validation) |
| File scanning | Partly (adapter exists; off by default; ClamAV never contacted) | [13](#13-file-upload-and-document-access) |
| CSRF protection where applicable | Implemented | [11](#11-csrf-and-cors) |
| XSS protection | Implemented | [10](#10-output-encoding-and-injection), [12](#12-security-headers-and-content-security-policy) |
| SQL injection protection | Implemented | [10](#10-output-encoding-and-injection) |
| SSRF protection | Implemented | [19](#19-webhooks-outbound-requests-and-idempotency) |
| Webhook signature validation | Implemented (verified against locally computed signatures only) | [19](#19-webhooks-outbound-requests-and-idempotency) |
| Idempotency | Implemented for payments, refunds, webhooks, jobs | [19](#19-webhooks-outbound-requests-and-idempotency) |
| Backup encryption | Implemented in the backup scripts (scripts not run against a production system) | [21](#21-backups-and-restore) |
| Restore testing | Operator responsibility (script provided) | [21](#21-backups-and-restore) |
| Security monitoring | Partly (events are recorded and viewable; no alerting on them) | [22](#22-monitoring-and-incident-response) |

The privacy items of section 30 (notices, consent, retention, data-subject requests, incidents, processors,
cross-border review) are covered in [UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md).

## 3. Authentication

Code: `src/modules/auth/`, `src/common/auth/`.

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Email and password sign-in | Implemented | `auth.service.ts` (`login`) | `test/foundation.spec.ts` |
| Passwords hashed with Argon2id (memory 19 456 KiB, 2 iterations, parallelism 1); never stored or logged in clear | Implemented | `auth.service.ts` (`ARGON`, `@node-rs/argon2`) | `test/foundation.spec.ts` (sign-in works; the hash column is unreadable for the tenant role) |
| Phone OTP sign-in: 6-digit code, 5-minute lifetime, stored only as SHA-256, 5 wrong attempts per code | Implemented | `auth.service.ts` (`createToken`, OTP functions), `OTP_TTL_SECONDS` | Module tests using the log driver. No SMS provider was contacted |
| Email verification before the first sign-in (`EMAIL_NOT_VERIFIED`) | Implemented | `auth.service.ts` | `tests/security/04-authentication-and-sessions.spec.ts` (no sign-in before verification; the link works once) |
| Password reset by single-use emailed link; all sessions of the user are ended | Implemented | `auth.service.ts` (`PASSWORD_RESET`) | `platform/platform.admin.spec.ts` (reset flow), `notifications/notifications.spec.ts` (the message) |
| One-time tokens (verification, reset, invitation, MFA challenge, support hand-off): 256-bit random, stored as SHA-256, single use, expiring | Implemented | `common/crypto.ts`, `auth_tokens` | Single use of verification, reset and invitation links: `tests/security/04-authentication-and-sessions.spec.ts`, `tests/integration/01-onboarding.spec.ts`; hand-off codes: `tests/security/05-platform-support-access.spec.ts`; expiry by time not tested |
| Answers do not reveal whether an email address has an account (sign-in, forgot password, resend verification) | Implemented | `auth.service.ts` | `test/foundation.spec.ts` ("never reveals whether an email exists") |
| Staff invitation: emailed single-use link, the invited person sets their own password | Implemented | `auth.service.ts`, `organisation.service.ts` | `platform/platform.tenants.spec.ts`, `corporate/corporate.spec.ts` (acceptance flow) |
| Sign-in is per application and per centre: a customer of one centre cannot sign in to another centre or to the staff application | Implemented | `auth.service.ts`, `principal.service.ts` | `test/foundation.spec.ts` ("customers and centres are separate login spaces") |
| Access token: JWT, HS256, 15 minutes, carries session, tenant and membership ids. The principal, role and permissions are re-read from the database on every request | Implemented | `common/auth/tokens.ts`, `principal.service.ts` | `test/foundation.spec.ts` |
| Development helper that returns OTPs and email tokens in responses (`EXPOSE_DEV_TOKENS`) is refused in production | Implemented | `config/env.ts` | Not verified by a test |
| Single sign-on (SAML, OIDC) | Not implemented | - | - |
| CAPTCHA or other bot challenge on public forms | Not implemented (rate limits only) | - | - |
| Check of new passwords against breached-password lists | Not implemented | - | - |

## 4. Password policy

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Minimum 10 characters (raised by `PASSWORD_MIN_LENGTH`, 10 to 128), maximum 128, at least one upper-case letter, one lower-case letter and one digit; one policy applied wherever a password is set (registration, sign-up, reset, change, invitation acceptance, the CLI); the effective policy is published in `GET /public/tenant-config` and the invitation preview | Implemented | `src/common/password-policy.ts`, `packages/validation/src/common.ts` (the offline floor of 10) | `tests/security/04-authentication-and-sessions.spec.ts`, `tests/integration/01-onboarding.spec.ts` (S05) |
| Platform staff created with the command-line tool need at least 14 characters; the password is read from an environment variable, never from an argument | Implemented | `src/cli/platform-admin.ts` | Not verified |
| Changing the password needs the current one and ends all other sessions of the user; a reset ends all of them | Implemented | `auth.service.ts` (`PASSWORD_CHANGED`) | `tests/security/04-authentication-and-sessions.spec.ts` |
| Password history, forced periodic change, expiry | Not implemented | - | - |
| `PASSWORD_MIN_LENGTH` cannot be set below 10 (start-up refuses it); sign-in never re-checks an existing password against a stricter policy | Implemented, by design | `config/env.ts`, `src/common/password-policy.ts` | Read in code |

## 5. Multi-factor authentication

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| TOTP (authenticator app) with 10 single-use recovery codes, stored as SHA-256 | Implemented | `auth.service.ts` (`otplib`) | `test/foundation.spec.ts` ("supports TOTP MFA with recovery codes") |
| The TOTP secret is encrypted at rest | Implemented | `users.mfaSecretEnc` | Read in code; the column is one of the stores of `test/encryption.spec.ts` |
| The issuer shown in the authenticator app is the centre's brand name only when white label applies (plan and mode), otherwise `TypEase`; platform staff always see `TypEase` | Implemented | `auth.service.ts` (`mfaIssuer`) | `test/mfa-issuer.spec.ts` |
| A session of a user with MFA enabled is unusable until the second step is passed (`MFA_REQUIRED`) | Implemented | `principal.service.ts` | `test/foundation.spec.ts` |
| Enabling MFA ends the user's other sessions; disabling it writes a security event | Implemented | `auth.service.ts` | Not verified by a dedicated test |
| Enforcement for privileged roles when `MFA_ENFORCEMENT=required`: owner, manager, accountant and all platform staff must set up MFA before they can use anything but their own security settings (`MFA_SETUP_REQUIRED`) | Implemented | `packages/permissions` (`requiresMfa`), `auth.guard.ts` | Not verified by a test (the test environment runs with enforcement off) |
| `MFA_ENFORCEMENT=required` is mandatory in production: the API refuses to start otherwise | Implemented | `config/env.ts` | Not verified by a test |
| Custom roles created by a centre are never forced to use MFA, whatever permissions they hold | Not implemented | - | - |
| SMS or email as a second factor; WebAuthn / passkeys | Not implemented | - | - |
| MFA enrolment in the mobile app (the app can pass a challenge; enrolment is done on the web) | Not implemented | - | - |

## 6. Lockout and rate limiting

Code: `src/common/rate-limit.ts`; limits are declared on routes with `@RateLimit`.

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Account lockout after 5 failed sign-ins for 15 minutes (`LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES`); writes `ACCOUNT_LOCKED` | Implemented | `auth.service.ts` | `test/foundation.spec.ts`, `tests/security/04-authentication-and-sessions.spec.ts` |
| Global limit of 600 requests per minute per IP address | Implemented | `RateLimitGuard` | Not verified by a test |
| Stricter limits on credential routes: sign-in 10 per 5 minutes per IP and email; OTP request 5 per 10 minutes per IP and phone; forgot password 5 per 15 minutes; registration 10 per hour; centre sign-up 5 per hour | Implemented | `auth.controller.ts`, `tenancy/public.controller.ts` | Not verified by a dedicated test |
| Every public route is rate limited or explicitly marked harmless | Implemented | `@RateLimit` | `test/architecture.spec.ts` |
| Limits are counted in Redis, so they hold across several API instances | Implemented | `rate-limit.ts` | Not verified with more than one instance |
| When Redis is unreachable the limiter fails closed in production (requests are refused) and open elsewhere | Implemented | `rate-limit.ts` | Not verified |
| Limits per account or per centre, independent of the IP address | Not implemented | - | - |
| The client address is taken from one trusted proxy hop (`trust proxy 1`). Behind more than one proxy, or with none, the address used for limits is wrong | Operator responsibility | `bootstrap.ts` | - |

The full table of limits is in [API_DOCUMENTATION.md](API_DOCUMENTATION.md).

## 7. Sessions

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Refresh token: random, stored only as SHA-256, rotated on every use, 30-day lifetime | Implemented | `auth.service.ts` (`refresh`) | `test/foundation.spec.ts` ("rotates refresh tokens and revokes the family on reuse"), `tests/security/04-authentication-and-sessions.spec.ts` |
| Reuse of a rotated refresh token ends the whole session family and writes `REFRESH_TOKEN_REUSE` (HIGH) | Implemented | `auth.service.ts` | same |
| Web: refresh token in an `HttpOnly`, `SameSite=Lax` cookie scoped to `/api/v1/auth`, one cookie per application; `Secure` when `COOKIE_SECURE=true`, which production requires | Implemented | `auth.controller.ts`, `config/env.ts` | Cookie attributes read in code |
| Web: the access token is kept in memory only, never in `localStorage` or `sessionStorage` | Implemented | `packages/api-client/src/session.ts` | `packages/api-client/src/session.test.ts` |
| Sessions are rows in PostgreSQL, not in the token: suspending a member, a password reset, sign-out or an administrator's action ends them at the next request | Implemented | `principal.service.ts`, `sessions` | `test/foundation.spec.ts` ("ends sessions when a member is suspended") |
| A user can list their sessions, end one, end all others (`POST /auth/sessions/revoke-others`), and see their sign-in history; nobody can end another person's session | Implemented | `auth.controller.ts` (`sessions`, `login-activity`) | `tests/security/04-authentication-and-sessions.spec.ts` |
| At most 20 live sessions per user and application: a further sign-in ends the oldest (`SESSION_LIMIT`, security event `SESSION_LIMIT_REACHED`) | Implemented | `auth.service.ts` (`MAX_LIVE_SESSIONS_PER_APP`) | `tests/security/04-authentication-and-sessions.spec.ts` |
| Idle timeout shorter than the refresh lifetime | Not implemented | - | - |
| Binding of a session to a device or IP address | Not implemented (IP and user agent are recorded for display only) | - | - |

## 8. Access control and tenant isolation

The detail, including the manual verification steps, is in [TENANT_ISOLATION.md](TENANT_ISOLATION.md) and
[ROLE_PERMISSION_MATRIX.md](ROLE_PERMISSION_MATRIX.md).

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Every HTTP route declares an access rule; a route without one is refused (fail closed) | Implemented | `common/auth/access.ts`, `auth.guard.ts` | `test/architecture.spec.ts` |
| Role-based permissions checked on the server for every route; the user interface hiding a button is never the control | Implemented | `auth.guard.ts`, `packages/permissions` | `test/foundation.spec.ts` ("enforces permissions per role"), module tests; `tests/security/03-roles-and-refund-approval.spec.ts` (eight roles against every non-public route) |
| A member cannot grant permissions they do not hold or edit their own role upwards; a centre always keeps one owner | Implemented | `tenancy/organisation.service.ts` | `test/foundation.spec.ts` |
| Resource-level rules: branch scope, assigned-only scope, own-record scope for customers, own-company scope for corporate users. Out-of-scope rows answer 404, not 403 | Implemented | `common/scope.ts`, module access files | `src/modules/requests/requests.access.spec.ts`, documents, finance and corporate tests |
| The tenant is taken from the verified session, never from the request body, query or path | Implemented | `common/context.ts` | `test/architecture.spec.ts` |
| PostgreSQL row-level security on all 107 tables; the application role is not a superuser, does not own the tables and cannot bypass the policies | Implemented | `database/migrations/0002_tenant_isolation.sql` | `test/foundation.spec.ts`, `test/architecture.spec.ts` |
| Cross-tenant foreign keys are refused by a database trigger | Implemented | `same_tenant_guard` | Module tests |
| Use of the non-RLS system connection is limited to an allow-list of files | Implemented | `common/db/prisma.service.ts` | `test/architecture.spec.ts` |
| The tenant role cannot read password hashes, sessions or one-time tokens | Implemented | Column and table grants | `test/foundation.spec.ts` |
| Platform staff have no access to a centre's data except through a time-limited, scoped grant that the centre approves. Inside the grant the session is confined to routes whose permission is a granted scope (`403 SUPPORT_ACCESS_SCOPE`), is read-only (`403 SUPPORT_ACCESS_READ_ONLY`; the only write scope is `request.comment.internal`), reaches only five permission-less routes marked `@SupportSessionSafe`, and every call that reaches centre data is written to the centre's audit trail before it is served | Implemented | `src/modules/platform/`, `common/auth/support-session.ts` | `platform.access.spec.ts`, `platform.access-notifications.spec.ts`, `test/support-session.spec.ts` (every route), `tests/security/05-platform-support-access.spec.ts` |
| The console-to-staff-app hand-off of a support session uses a one-time code in the URL fragment (60 seconds, single use, stored hashed); no token travels in a URL | Implemented | `platform/access-grants.service.ts`, `auth.controller.ts` (`support-session/exchange`), `apps/platform-admin/components/access-table.tsx` | `tests/security/05-platform-support-access.spec.ts` |
| Segregation of duties: a refund cannot be approved by its requester; a discount cannot be approved by its requester (except a sole approver, recorded); a case cannot be reviewed by its operator | Implemented | `finance/refunds.service.ts`, `quotations.service.ts`, `requests/request-guards.service.ts` | `finance.refunds.spec.ts`, `requests.lifecycle.spec.ts`, `tests/security/03-roles-and-refund-approval.spec.ts` |
| `FORCE ROW LEVEL SECURITY` on the tables (protection against the owner role) | Not implemented: the owner role is used for migrations only and is not available to the application | - | - |
| A dedicated database or schema per centre | Not implemented (shared database, shared schema) | - | - |

## 9. Input validation

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Every request body and query is validated on the server against a Zod schema shared with the web apps; unknown properties are dropped or, for strict schemas, rejected | Implemented | `packages/validation`, global `ZodValidationPipe` in `app.module.ts` | Module tests (400 `VALIDATION_FAILED`) |
| Path identifiers must be UUIDs | Implemented | `ParseUUIDPipe` | Module tests |
| JSON bodies are limited to 1 MB; uploads to `UPLOAD_MAX_BYTES` (15 MB by default) | Implemented | `bootstrap.ts`, documents module | `documents.spec.ts` |
| Dynamic form values are validated on the server against the form version pinned to the request | Implemented | `requests/form-validator.ts` | `requests/form-validator.unit.spec.ts`, `catalogue/form-validator.unit.spec.ts` |
| Regular expressions supplied by a centre in a form field are compiled and checked when the form is saved | Implemented | `packages/validation` (`compileFormPattern`) | Catalogue tests. Resistance to deliberately slow patterns was not tested |
| Database check constraints as a second line (41 constraints: amounts, formats, ranges) | Implemented | `database/migrations/0003_integrity.sql` | Finance and other module tests |
| Database statuses and numbers that must not change are protected by triggers (issued invoices, completed payments, append-only tables) | Implemented | `0003_integrity.sql` | `finance.documents.spec.ts`, `audit.spec.ts` |
| Return addresses after online payment must be one of the centre's own portal origins | Implemented | finance module (`INVALID_RETURN_URL`) | `finance.payments.spec.ts` |

## 10. Output encoding and injection

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| SQL injection: all data access goes through Prisma or tagged-template raw queries, which are parameterised | Implemented | throughout | Not verified by a dedicated test |
| The 15 uses of unparameterised raw SQL are savepoint statements with generated names, one `SET LOCAL`, and the offboarding purge, which builds table names from a fixed list through an identifier check | Implemented | `workflow-engine.service.ts`, `automation/actions.service.ts`, `platform/offboarding.service.ts` | Read in code |
| XSS in the web apps: React escapes rendered values. `dangerouslySetInnerHTML` is used in two shared components only, for the theme script and the generated brand stylesheet, neither of which contains user text | Implemented | `packages/ui/src/providers/` | `packages/branding/src/theme.test.ts` ("produces a style block that cannot be broken out of") |
| HTML emails: template variables and centre-supplied text are escaped; links are created only from the template text, never from values | Implemented | `notifications/render.ts` | `notifications/render.unit.spec.ts` |
| Spreadsheet (CSV / Excel) formula injection in report exports | Implemented | `reports/export/` | `reports/export/sanitise.unit.spec.ts` |
| File names from clients are stripped of path components and control characters; storage keys are never derived from them | Implemented | `common/files.ts` (`safeFilename`), storage module | Key format: `storage/storage.spec.ts`. File-name cleaning: read in code |
| PDFs are generated from structured data with a PDF library (no HTML rendering) | Implemented | `finance/pdf.renderer.ts` | `finance/pdf.renderer.unit.spec.ts` |
| Error responses never contain stack traces or SQL; every response carries a `requestId` | Implemented | `common/errors.ts` (`AllExceptionsFilter`) | Module tests |
| The interactive API documentation (`/api/docs`) is not served in production | Implemented | `bootstrap.ts` | Not verified |

## 11. CSRF and CORS

The API does not use cookie authentication for normal requests: every data request needs the access token
in the `Authorization` header, which a browser does not attach on its own. The only cookie is the refresh
token.

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Data routes authenticate by bearer token, so a cross-site request carries no credentials | Implemented | `auth.guard.ts` | `test/foundation.spec.ts` |
| The refresh cookie is `SameSite=Lax`, limited to `/api/v1/auth`, and the refresh route additionally requires the header `X-Requested-With: typease`, which a cross-site form cannot send | Implemented | `auth.controller.ts` | `test/foundation.spec.ts` |
| CORS: only the four configured application origins, `CORS_ORIGINS`, centre sub-domains and verified custom domains. No wildcard | Implemented | `bootstrap.ts`, `tenant-resolver.service.ts` (`isAllowedOrigin`) | Not verified by a test (host resolution itself is tested in `test/foundation.spec.ts`) |
| Requests without an `Origin` header are accepted (mobile app, server-to-server, webhooks); they are authenticated like any other request | Implemented, by design | `bootstrap.ts` | - |
| Tenant portals call the API on their own origin through the reverse proxy, so no cross-site cookie is needed | Implemented in the proxy configuration | `infrastructure/docker/caddy/Caddyfile.prod` | Not verified (proxy never run) |

## 12. Security headers and Content Security Policy

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| API responses: `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, no `X-Powered-By`; HSTS (one year, sub-domains) in production | Implemented | `bootstrap.ts` (helmet) | Not verified by a test |
| Web apps: per-request CSP with a fresh nonce: `script-src 'self' 'nonce-...' 'strict-dynamic'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`; `connect-src` and `img-src` limited to self, the API and the file store | Implemented | `packages/config/security.mjs`, each app's `middleware.ts` | `packages/config/security.test.mjs` |
| `style-src` allows `'unsafe-inline'` (component libraries position elements with style attributes) | Partly: inline styles are allowed; inline scripts are not | `security.mjs` | same |
| `'unsafe-eval'` for scripts only in development builds | Implemented | `security.mjs` | same |
| `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, a restrictive `Permissions-Policy` (camera only in the customer portal, for document capture) | Implemented | `security.mjs` (`staticSecurityHeaders`) | same |
| The same headers again at the reverse proxy | Implemented in configuration | `Caddyfile.prod` (`security_headers`) | Not verified |
| The staff application and the platform console are marked `noindex` | Implemented | app `layout.tsx` | Not verified |
| The policy was read in a browser's console for violations on every page | Not verified | - | - |

## 13. File upload and document access

Code: `src/modules/documents/`, `src/modules/storage/`. Reference:
[api/modules/documents.md](api/modules/documents.md).

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Allowed types are an allow-list (`UPLOAD_ALLOWED_MIME`: PDF, JPEG, PNG, WebP by default) | Implemented | documents service | `documents.spec.ts` |
| The declared type is not trusted: the stored bytes are sniffed by magic bytes and must equal the declared, allowed type; otherwise the file is deleted and a security event written | Implemented | `common/files.ts` (`detectMime`), documents service | `documents.spec.ts`, `storage.spec.ts` |
| Size limit enforced on the declared size and on the bytes received | Implemented | storage and documents | `storage.spec.ts` |
| Storage keys are `<tenantId>/<192-bit random>`; uploads land in a staging area and are moved before inspection, so a leaked upload URL cannot change a checked file | Implemented | storage module | `storage.spec.ts`, `documents-lifecycle.spec.ts` |
| Files are private. Bytes are served only through signed URLs that expire (120 seconds by default for downloads, 600 for uploads) and force a content disposition | Implemented | storage module | `storage.spec.ts` |
| Every view, link, download, share, change and deletion of a document is written to an append-only access log | Implemented | `document_access_logs` | `documents.spec.ts` |
| Share links: random token stored as SHA-256, at most 7 days and 20 downloads, revocable | Implemented | documents service | `documents.spec.ts` |
| Who may see which document (customer's own, company's, request scope, branch scope) | Implemented | `documents/access.ts` | `documents.spec.ts` |
| Malware scanning through ClamAV (INSTREAM); infected files are deleted and the document quarantined | Partly: the adapter and the quarantine path exist. `MALWARE_SCANNER` defaults to `none`, in which case files are marked `SKIPPED` and are downloadable. ClamAV itself was never contacted | `documents/` scan job | `documents/malware.unit.spec.ts` and `documents-lifecycle.spec.ts`, with a local fake clamd and the built-in EICAR detection |
| Option to allow downloads only after a clean scan (`REQUIRE_CLEAN_SCAN`) | Implemented, off by default | documents service | `documents-lifecycle.spec.ts` |
| Removal of active content from PDFs or images, re-encoding of images, stripping of metadata | Not implemented | - | - |
| With the S3 driver, a record of each individual fetch of a signed URL | Operator responsibility (bucket access logging) | - | - |
| Brand logos are public by design, limited to PNG, JPEG, WebP up to 1 MB, sniffed; SVG is refused | Implemented | `tenancy/branding.service.ts` | Not verified by a dedicated test |

## 14. Encryption at rest

Code: `src/common/crypto.ts`.

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Emirates ID and passport numbers on the customer record: AES-256-GCM with a random 96-bit IV per value. Stored next to a keyed blind index (HMAC-SHA-256 scoped by tenant) for exact-match search and the last four characters for display | Implemented | `customers.emiratesIdEnc`, `passportNoEnc`, `...Hash`, `...Last4` | `customers.spec.ts`, `customers/customer-view.unit.spec.ts` |
| Full identity numbers are returned only by one endpoint, to holders of `customer.sensitive.read`, and every call is audited | Implemented | customers module | `customers.spec.ts` |
| Identity numbers found by OCR are encrypted inside the stored extraction result | Implemented | `ocr/ocr.service.ts` | `ocr.spec.ts` |
| TOTP secrets and integration credentials (one encrypted envelope per integration; never returned by the API) | Implemented | `users.mfaSecretEnc`, `integration_credentials_metadata.secretsEnc` | `integrations.spec.ts` |
| Files in the local storage driver are encrypted with AES-256-GCM before they are written | Implemented | storage module | `storage.spec.ts` |
| Files in S3: server-side encryption requested on every upload (`AES256`) | Implemented in the request; not exercised against a bucket | storage module | `storage.unit.spec.ts` (offline) |
| Key rotation: every ciphertext is stamped with the id of the key that wrote it (`DATA_ENCRYPTION_KEY_ID`, default `k1`); `DATA_ENCRYPTION_OLD_KEYS` (`id:base64key,...`) may still decrypt; the keyring is validated at start in every environment (wrong length, duplicate id, same id for a different key); `pnpm --filter @typease/api reencrypt` (`--dry-run`, `--list`, `--only`, `--batch`, `--skip-files`) moves every store, including local-driver files, to the current key, safe to repeat and interrupt; a ciphertext under an unknown key fails closed with a message that names no key material. Procedure: [deployment/secrets.md](deployment/secrets.md), section 5 | Implemented | `crypto.ts` (`keyring`, `currentKeyId`, `needsReencryption`), `config/env.ts` (`parseKeyring`), `cli/reencrypt.ts`, `cli/reencrypt-stores.ts` | `test/encryption.spec.ts` (keyring rules; end-to-end rotation with dry run, real run, idempotence, retiring the old key; every encrypted column and helper is registered with a store), `test/env-drift.spec.ts` (the readiness script applies the same rules) |
| Rotation of `HMAC_KEY` (blind indexes, signed URLs) | Not implemented | - | - |
| Everything else in the database is stored in clear: names, phone numbers, email addresses, dates of birth, addresses, form answers (including any identity number a centre asks for in a form field), notes, message bodies | Not implemented at field level | - | - |
| Encryption of the database volume, of Redis and of the object store | Operator responsibility | - | - |
| Key storage: keys are environment variables of the API and worker processes. No hardware security module or key management service | Operator responsibility | - | - |

## 15. Encryption in transit

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| HTTPS for all public hosts, HTTP redirected, certificates obtained and renewed by the reverse proxy | Operator responsibility; configuration provided | `infrastructure/docker/caddy/Caddyfile.prod` | Not verified (never run) |
| HSTS | Implemented in API, web apps and proxy configuration | sections 12 | `packages/config/security.test.mjs` for the web apps |
| TLS between the application and PostgreSQL, Redis, S3, SMTP | Operator responsibility. The readiness script warns when a non-local database or Redis URL has no TLS and fails when the S3 endpoint is not HTTPS | `scripts/production-readiness.mjs` | - |
| Outbound calls to providers and webhooks use HTTPS; certificate verification is never switched off in the code | Implemented | - | `test/architecture.spec.ts` ("never disables TLS verification") |
| Inside the Compose network the services talk plain HTTP to each other | By design; isolate the network | `docker-compose.prod.yml` | - |

## 16. Secrets and configuration

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| All configuration is validated at start; the process refuses to start with a missing or malformed value; `.env.example` and the production template document exactly the variables of `env.ts` (94 at the time of writing) | Implemented | `config/env.ts` (`ENV_VARIABLES`) | `test/env-drift.spec.ts` |
| Production start is refused with: the payment sandbox on, development tokens exposed, insecure cookies, MFA enforcement off, the default internal token, missing S3 credentials, and any of `JWT_ACCESS_SECRET`, `HMAC_KEY`, `DATA_ENCRYPTION_KEY`, every old data key or `INTERNAL_API_TOKEN` that is a published development value, too short, typed text rather than random bytes, of low entropy, or reused for a second purpose | Implemented | `config/env.ts` (`weakSecretReasons`, `weakKeyReasons`, `KNOWN_PLACEHOLDER_SECRETS`) | `test/encryption.spec.ts` ("production start-up check for secrets": every value published in `.env.example`, the Docker development files, CI and the test set-up is rejected), `test/env-drift.spec.ts` |
| The readiness script (`scripts/production-readiness.mjs`) judges secrets and the keyring with the same rules as the API | Implemented | `scripts/production-readiness.mjs` | `test/env-drift.spec.ts` |
| A script generates random secrets for a new environment | Implemented | `scripts/generate-secrets.sh` | Not verified |
| `.env` files are ignored by git; only `.env.example` with development values is tracked | Implemented | `.gitignore` | Checked with `git ls-files` |
| Secret scanning of the whole history in CI (gitleaks) | Implemented in the workflow; the workflow was never run | `.github/workflows/ci.yml`, `infrastructure/security/gitleaks.toml` | Not verified |
| Centres' provider credentials are write-only: the API returns only the names of the stored keys | Implemented | integrations module | `integrations.spec.ts` |
| Government-portal user names, passwords, PINs and OTPs cannot be stored: authorisation records hold no secrets and refuse text that looks like a credential | Implemented | integrations module | `integrations.spec.ts` |
| Integration with a secret manager (Vault, cloud secret stores), automatic rotation | Not implemented | - | - |
| Separate database roles with separate passwords for migrations, application and system connection | Implemented | `infrastructure/docker/postgres/bootstrap.sql` | `test/architecture.spec.ts` (application role is not a superuser) |

## 17. Audit logging and security events

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Audit entry for every create, update, decision and deletion in every module, written in the same transaction as the change: actor, actor type, action, resource, before / after, IP, user agent, request id | Implemented | `common/audit.service.ts` | `audit/audit.spec.ts` and module tests |
| `audit_logs`, `security_events`, `document_access_logs`, `request_status_history`, `consent_records`, `payment_allocations`, `liability_entries` are append-only: a database trigger refuses `UPDATE` and `DELETE`, and for most of them the application role has no such grant | Implemented | `database/migrations/0003_integrity.sql` | `audit/audit.spec.ts`, `finance.documents.spec.ts` |
| Security events: failed sign-in, lockout, MFA failure, recovery code used, refresh-token reuse, password reset and change, MFA enabled and disabled, upload content mismatch, malware detected, webhook signature invalid, webhook amount mismatch, support access | Implemented | `audit.security(...)` calls | Module tests |
| The two exceptions to append-only, both on the system connection behind a transaction-local switch that the application role cannot use: the permanent purge of an offboarded centre, and the erasure of one person, which keeps the entries but removes that person's values (names, contact details, identity numbers, free-text reasons, IP addresses of their own actions) | Implemented | `typease_purge_allowed()` in `0003_integrity.sql`, `platform/offboarding.service.ts`, `privacy/erasure-system.service.ts` | Purge: `platform/platform.offboarding.spec.ts`. Erasure: `privacy/privacy.spec.ts` covers the outcome of an erasure; check that file for a case on the redaction of trails before relying on it |
| Sensitive values are not written to the audit trail: identity numbers appear as "ends in 1234", form saves record field names only, integration changes record key names only | Implemented | customers, requests, integrations modules | `audit/audit-view.unit.spec.ts`, `customers.spec.ts` |
| Centres can read their own audit trail (`audit.read`: owner, manager); platform entries are invisible to centres | Implemented | audit module | `audit/audit.spec.ts` |
| Actions by platform support inside a centre appear in that centre's audit trail with the grant id | Implemented | platform module | `platform.access.spec.ts` |
| Protection of the audit trail against a database administrator (hash chaining, external write-once storage) | Not implemented | - | - |
| Retention period and archiving of audit data | Not implemented: entries are kept until the centre is purged | - | - |

## 18. Sensitive data in logs

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Request and response bodies are never logged; the access log has method, path without query string, status, duration | Implemented | `common/logger.ts` (`logRequest`) | Read in code |
| Defensive redaction of fields named password, token, secret, authorization, cookie, emiratesId, passportNo, at the top level and one level down | Implemented | `common/logger.ts` (`REDACT`) | `test/architecture.spec.ts` ("never ... logs secrets" is a static scan) |
| Notification bodies that contain a one-time code or link are stored and logged with the value hidden | Implemented | `notifications/render.ts` (`maskSecrets`) | `notifications/render.unit.spec.ts` |
| Reverse-proxy access log redacts `Authorization` and `Cookie` headers and one-time tokens in URLs | Implemented in configuration | `Caddyfile.prod` (`access_log`) | Not verified |
| Deeply nested objects logged by a future change would not be covered by the redaction paths | Partly | `logger.ts` | - |
| With the `log` drivers (development default) the full text of emails and SMS, including OTPs, is written to the log | By design for development; do not use the `log` drivers in production | notifications providers | - |

## 19. Webhooks, outbound requests and idempotency

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Inbound payment webhooks: signature verified over the raw body with the secret of the centre the payment belongs to; timestamp tolerance; nothing is recorded or changed before verification | Implemented | `finance/payment-webhook.service.ts`, `finance/gateways/` | `finance.payments.spec.ts`, `finance/gateways/gateways.unit.spec.ts` (signatures computed locally; Stripe never contacted) |
| Each verified webhook event is stored once (unique gateway and event id); a duplicate does nothing; a payment completes exactly once | Implemented | `payment_webhook_events` | `finance.payments.spec.ts` |
| Amount or currency mismatch between gateway and pending payment completes nothing and writes a security event | Implemented | finance | `finance.payments.spec.ts` |
| Subscription billing webhooks: same pattern on a separate route and table | Implemented | subscriptions module | `subscriptions.spec.ts` |
| `Idempotency-Key` required on recording a payment and requesting a refund; the stored response is replayed; a different body with the same key is refused | Implemented | `finance/idempotency.service.ts` | `finance.payments.spec.ts`, `finance.refunds.spec.ts` |
| Outbound automation webhooks are signed (`X-TypEase-Signature`, timestamp, stable delivery id) | Implemented | `automation/webhook.ts` | `automation/webhook.unit.spec.ts` |
| SSRF, automation webhooks: destination limited to the n8n base address or an operator allow-list; HTTPS; no credentials in the URL; no redirects; the host is resolved once, refused if any address is private, loopback or link-local, and the connection is made to the checked address | Implemented | `automation/webhook.ts` | `automation/webhook.unit.spec.ts`, `automation.actions.spec.ts` |
| SSRF, centre-supplied integration URLs (SMS gateway, OCR, n8n base address): HTTPS and an approved host required; private addresses refused | Implemented | `integrations/` (net guard) | `integrations/net-guard.unit.spec.ts` |
| Webhook payloads carry identifiers, codes, amounts and dates from an allow-list; no names, contact details, identity numbers or document contents | Implemented | `automation/webhook.ts` | `automation/webhook.unit.spec.ts` |
| Custom-domain verification resolves only a TXT record; the application makes no HTTP request to a centre-supplied host | Implemented | `tenancy/branding.service.ts` | `test/foundation.spec.ts` |
| Background jobs and event handlers are idempotent and delivered at least once (transactional outbox) | Implemented | `common/events.service.ts`, module jobs | Module tests, `platform/worker.bullmq.spec.ts`, `notifications/bullmq.spec.ts` |
| The on-demand TLS "ask" route is declared public in the API and relies on the reverse proxy to keep it off public hosts. It reveals only whether a host name belongs to a centre | Partly | `tenancy/public.controller.ts`, `Caddyfile.prod` (`block_internal`) | Proxy rule not verified |
| The metrics route requires the internal token | Implemented | `auth.guard.ts` (`@Internal`), `platform/metrics.service.ts` | `platform/platform.dashboard.spec.ts`, `platform/worker.bullmq.spec.ts` |

## 20. Dependencies and supply chain

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| One lockfile for the whole workspace; CI installs with `--frozen-lockfile` | Implemented | `pnpm-lock.yaml`, `.github/workflows/ci.yml` | Workflow never run |
| Install scripts of dependencies are blocked except for a named allow-list | Implemented | `pnpm-workspace.yaml` (`onlyBuiltDependencies`) | - |
| `pnpm audit --prod --audit-level high` in CI | Implemented in the workflow | `ci.yml` | **Not run.** No dependency audit result exists for this code base |
| Third-party GitHub Actions pinned to version tags (not to commit hashes) | Partly | `ci.yml` | - |
| Container images: multi-stage builds, production dependencies only, run as the unprivileged `node` user | Implemented in the Dockerfiles | `infrastructure/docker/*.Dockerfile` | Images never built |
| Base images pinned by tag (`node:<version>-bookworm-slim`), not by digest | Partly | Dockerfiles | - |
| Image vulnerability scanning, software bill of materials, image signing | Not implemented | - | - |
| Automated dependency update tooling (Dependabot, Renovate) | Not implemented | - | - |
| Licence review of dependencies | Not implemented | - | - |
| ESLint 9 (flat configuration, `eslint.config.mjs`) for every workspace package with per-package warning budgets; not type-aware; no `@next/eslint-plugin-next`, `eslint-plugin-react`, `eslint-plugin-jsx-a11y` or `eslint-plugin-import` ([architecture/LINTING.md](architecture/LINTING.md)) | Implemented | `eslint.config.mjs`, `lint` scripts | Results per package in [TEST_REPORT.md](TEST_REPORT.md), section 2.1 |

## 21. Backups and restore

Reference: [security/BACKUP_AND_RECOVERY.md](security/BACKUP_AND_RECOVERY.md).

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Database backup script: `pg_dump` piped straight into encryption (age recipients or an OpenSSL passphrase); an unencrypted backup is refused | Implemented | `scripts/db-backup.sh` | Not verified against a production system |
| File-store backup script (local driver: encrypted archive; S3: copy between buckets) | Implemented | `scripts/storage-backup.sh` | Not verified |
| Restore script with an integrity check of the encrypted file | Implemented | `scripts/db-restore.sh` | Not verified |
| Running backups on a schedule, copying them off the host, keeping the decryption key separately | Operator responsibility | - | - |
| Restore drills | Operator responsibility. The readiness script looks for evidence of a recent backup and of a drill | `scripts/production-readiness.mjs` | - |
| Backup or restore of a single centre | Not implemented (whole database only) | - | - |
| The database backup is useless for identity numbers and local files without `DATA_ENCRYPTION_KEY`; back the key up separately | Operator responsibility | - | - |

## 22. Monitoring and incident response

| Item | Status | Where | Verified by |
| --- | --- | --- | --- |
| Liveness and readiness endpoints; Prometheus metrics for outbox, queues, notifications and dependencies | Implemented | `src/modules/health/`, `platform/metrics.service.ts` | `platform/platform.dashboard.spec.ts`, `platform/worker.bullmq.spec.ts` |
| Alert rules for availability, certificates, queues, outbox, database, Redis, disk and backups | Implemented in configuration | `infrastructure/monitoring/prometheus/rules/` | Monitoring stack never run |
| Security events are stored and can be listed and summarised in the platform console | Implemented | `platform/platform-audit.service.ts` | `platform/platform.admin.spec.ts` |
| A centre can list the security events of its own centre (it can read its audit trail, which is a different table) | Not implemented | - | - |
| Alerting on security events (bursts of failed sign-ins, token reuse, malware, invalid webhook signatures) | Not implemented: nobody is notified; somebody has to look | - | - |
| HTTP request metrics, per-centre metrics, tracing | Not implemented | - | - |
| Incident register for a centre (privacy module) | Implemented as a record-keeping tool; see [UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md) | privacy module | `privacy/privacy.spec.ts` |
| Incident response plan, on-call arrangements, notification of authorities and individuals | Operator responsibility | - | - |
| Intrusion detection, web application firewall, DDoS protection | Operator responsibility | - | - |
| A published process for reporting vulnerabilities (`SECURITY.md`, `security.txt`) | Not implemented | - | - |

## 23. Mobile application

The Flutter customer app (`apps/customer-mobile`) has never been compiled or run. Nothing about its security
behaviour has been observed. What the source is written to do:

| Item | Status | Verified by |
| --- | --- | --- |
| Refresh token kept in the platform's secure storage (Keychain / Keystore); access token in memory | Written in the source | Not verified |
| The API base URL must be supplied at build time for release builds | Written in the source | Not verified |
| Certificate pinning, jailbreak or root detection, screenshot protection, code obfuscation | Not implemented | - |
| Biometric unlock | Not implemented | - |

## 24. Known gaps

The items a reviewer should look at first.

1. No independent security review, penetration test, dependency audit run or accessibility audit.
2. There is no rotation of `HMAC_KEY` (blind indexes and signed links); data-key rotation exists (section 14) but was exercised only by its tests, never on a production-sized data set.
3. Field-level encryption covers identity numbers on the customer record, OCR results, MFA secrets and
   integration credentials only. Other personal data, including answers in dynamic forms, is stored in clear.
4. Malware scanning is off by default and has never been exercised against ClamAV.
5. MFA is TOTP only; custom roles are never forced to use it.
6. Rate limits are per IP address only and depend on the proxy passing the right client address.
7. No alerting on security events.
8. No SSO, no bot challenge, no breached-password check, no idle timeout (a cap of 20 live sessions per
   user and app exists).
9. Shared database and shared file bucket for all centres; isolation rests on row-level security and
   application checks (both tested), not on physical separation.
10. Nothing in the deployment layer (containers, proxy, TLS, CI, monitoring, backups) has been run.
11. No external provider has been contacted; webhook signature verification is tested against locally
    computed signatures.
12. The audit trail is append-only for the application but not tamper-evident against a database
    administrator.

See also [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## 25. Pre-go-live checklist for the operator

The script [`scripts/production-readiness.mjs`](../scripts/production-readiness.mjs) automates part of this
list. It only reads: it validates the environment with the same rules as the API plus stricter go-live
rules, inspects the real database (migrations, roles, table ownership, row-level security, triggers, demo
data, platform administrators), probes Redis and ClamAV, and looks for evidence of a recent encrypted backup.
It prints PASS / WARN / FAIL and never prints secret values.

```bash
pnpm check:production -- --env-file ./prod.env --backup-marker /var/backups/typease/last-success.json
```

A passing run is necessary, not sufficient. Work through the list as well.

**Review**

- [ ] An independent security review or penetration test has been carried out and its findings handled.
- [ ] `pnpm audit --prod` has been run and the result reviewed.
- [ ] Legal review of the privacy and compliance position ([UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md)).

**Secrets and configuration**

- [ ] All secrets generated freshly (`pnpm secrets:generate`), none shared with any other environment.
- [ ] `DATA_ENCRYPTION_KEY` and `HMAC_KEY` backed up separately from the database backups. Losing them loses
      the identity numbers and, with the local driver, every file.
- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true`, `MFA_ENFORCEMENT=required`, `EXPOSE_DEV_TOKENS=false`,
      `PAYMENT_SANDBOX_ENABLED=false`, `RATE_LIMIT_ENABLED=true`, `INTERNAL_API_TOKEN` changed.
- [ ] `MAIL_DRIVER`, `SMS_DRIVER`, `WHATSAPP_DRIVER`, `PUSH_DRIVER` are not `log` for any channel in use.
- [ ] `CORS_ORIGINS` contains nothing that is not yours.
- [ ] `OUTBOUND_WEBHOOK_ALLOWED_HOSTS` lists only hosts you operate or trust.

**Database**

- [ ] Three roles with three different strong passwords; the API uses `typease_app` and `typease_system`,
      never the owner.
- [ ] All migrations applied by `pnpm db:migrate` with the owner role; the demo seed was **not** run.
- [ ] No demo accounts (`*.test` addresses, the demo password) exist.
- [ ] At least one platform administrator exists, created with the `platform-admin` command, with MFA set up.
- [ ] TLS to the database when it is not on a private network; volume encryption on.

**Network and TLS**

- [ ] Only the reverse proxy is reachable from the internet. PostgreSQL, Redis, the API port, the worker and
      the object store's console are not.
- [ ] `/api/v1/internal/*` answers 404 on every public host.
- [ ] HTTPS on every host; HTTP redirects; certificates renew.
- [ ] The proxy passes exactly one `X-Forwarded-For` hop to the API.
- [ ] A first custom domain has been connected and tested end to end.

**Files**

- [ ] `STORAGE_DRIVER=s3` with a private bucket: public access blocked, CORS limited to your portal origins,
      a lifecycle rule on the `incoming/` prefix, access logging on.
- [ ] `MALWARE_SCANNER=clamav` with a reachable, updating ClamAV; decide on `REQUIRE_CLEAN_SCAN`.
- [ ] One upload and one download tested end to end against the real bucket.

**Providers**

- [ ] Each provider in use (payment gateway, SMTP, SMS, WhatsApp, push) tested end to end with real
      credentials in the provider's test mode, including a webhook delivery and a refund.
- [ ] Payment webhook endpoints registered with the gateway; webhook secrets set.

**Operations**

- [ ] Backups scheduled, encrypted, copied off the host; one restore drill completed and timed.
- [ ] Monitoring and alerting running; somebody receives the alerts.
- [ ] Somebody reviews security events regularly (there is no alert for them).
- [ ] Log retention decided; logs are stored where only operators can read them.
- [ ] An incident response contact and procedure exist.
- [ ] A process for applying dependency and base-image updates exists.

Related: [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md), [deployment/secrets.md](deployment/secrets.md),
[TENANT_ISOLATION.md](TENANT_ISOLATION.md).
